import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { resolveRepoPaths } from '../../src/config/paths.js';
import type { AppContext } from '../../src/context.js';
import type { EmbeddingProvider } from '../../src/embeddings/EmbeddingProvider.js';
import { acquireLock } from '../../src/indexer/lock.js';
import { watchRepo } from '../../src/indexer/watch.js';
import { computeRepoId } from '../../src/utils/repo-id.js';
import { LanceVectorStore } from '../../src/vector-store/LanceVectorStore.js';

const DIMENSIONS = 8;

class FakeEmbeddings implements EmbeddingProvider {
  failing = false;
  calls = 0;

  async embed(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.failing) throw new Error('embedding provider unreachable');
    return texts.map((text) =>
      Array.from({ length: DIMENSIONS }, (_, i) => ((text.charCodeAt(i % text.length) || 1) % 17) + 1)
    );
  }

  async dimensions(): Promise<number> {
    return DIMENSIONS;
  }

  modelName(): string {
    return 'fake-embedding';
  }
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe('watchRepo against a real filesystem and LanceDB', () => {
  let root: string;
  let repoRoot: string;
  let dbHome: string;
  let embeddings: FakeEmbeddings;
  let context: AppContext;
  let stops: Array<() => Promise<void>>;
  const originalDbPath = process.env.CODE_INTEL_DB_PATH;

  async function openContext(): Promise<AppContext> {
    const loaded = loadConfig({ repoRoot });
    const config = { ...loaded, indexing: { ...loaded.indexing, debounceMs: 150 } };
    const repoId = computeRepoId(repoRoot);
    const paths = resolveRepoPaths(config, repoRoot, repoId);
    const vectorStore = await LanceVectorStore.open(paths.dbDir, DIMENSIONS);
    return { repoRoot, repoId, config, paths, embeddingProvider: embeddings, vectorStore };
  }

  async function indexedFiles(): Promise<string[]> {
    return [...(await context.vectorStore.getAllFileHashes()).keys()].sort();
  }

  async function startWatching(target = context): Promise<void> {
    stops.push(await watchRepo(target, { immediate: true, retryBaseMs: 100, retryMaxMs: 400 }));
  }

  beforeEach(async () => {
    // Deliberately not realpath'd: on macOS tmpdir() is behind the /var -> /private/var symlink.
    root = await mkdtemp(join(tmpdir(), 'code-intel-watch-live-'));
    repoRoot = join(root, 'repo');
    dbHome = join(root, 'db');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    await writeFile(join(repoRoot, 'src', 'existing.ts'), 'export const existing = 1;\n');
    process.env.CODE_INTEL_DB_PATH = dbHome;
    embeddings = new FakeEmbeddings();
    stops = [];
    context = await openContext();
  });

  afterEach(async () => {
    for (const stop of stops) await stop();
    await rm(root, { recursive: true, force: true });
    if (originalDbPath === undefined) delete process.env.CODE_INTEL_DB_PATH;
    else process.env.CODE_INTEL_DB_PATH = originalDbPath;
  });

  it('catches up on files that existed before the watcher started', async () => {
    await startWatching();
    await waitFor(async () => (await indexedFiles()).includes('src/existing.ts'), 'initial catch-up');
  });

  it('indexes new files, re-indexes edits, and removes deleted files', async () => {
    await startWatching();
    await waitFor(async () => (await indexedFiles()).includes('src/existing.ts'), 'initial catch-up');

    await writeFile(join(repoRoot, 'src', 'added.ts'), 'export function added() { return 2; }\n');
    await waitFor(async () => (await indexedFiles()).includes('src/added.ts'), 'new file indexed');

    const before = (await context.vectorStore.getAllFileHashes()).get('src/added.ts');
    await writeFile(join(repoRoot, 'src', 'added.ts'), 'export function added() { return 3; }\n');
    await waitFor(
      async () => (await context.vectorStore.getAllFileHashes()).get('src/added.ts') !== before,
      'edit re-indexed'
    );

    await rm(join(repoRoot, 'src', 'added.ts'));
    await waitFor(async () => !(await indexedFiles()).includes('src/added.ts'), 'deleted file removed');
  });

  it('follows renames and never indexes ignored or secret files', async () => {
    await startWatching();
    await waitFor(async () => (await indexedFiles()).includes('src/existing.ts'), 'initial catch-up');

    await mkdir(join(repoRoot, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(repoRoot, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    await writeFile(join(repoRoot, '.env'), 'TOKEN=abc\n');
    await rename(join(repoRoot, 'src', 'existing.ts'), join(repoRoot, 'src', 'renamed.ts'));

    await waitFor(async () => {
      const files = await indexedFiles();
      return files.includes('src/renamed.ts') && !files.includes('src/existing.ts');
    }, 'rename reflected');
    const files = await indexedFiles();
    expect(files.some((file) => file.startsWith('node_modules/'))).toBe(false);
    expect(files).not.toContain('.env');
  });

  it('indexes every file in a directory moved into the repo and forgets a directory moved out', async () => {
    await startWatching();
    await waitFor(async () => (await indexedFiles()).includes('src/existing.ts'), 'initial catch-up');

    const outside = join(root, 'feature');
    await mkdir(join(outside, 'nested'), { recursive: true });
    await writeFile(join(outside, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(outside, 'nested', 'b.ts'), 'export const b = 2;\n');
    await rename(outside, join(repoRoot, 'src', 'feature'));
    await waitFor(async () => {
      const files = await indexedFiles();
      return files.includes('src/feature/a.ts') && files.includes('src/feature/nested/b.ts');
    }, 'moved-in directory indexed');

    await rename(join(repoRoot, 'src', 'feature'), join(root, 'feature-gone'));
    await waitFor(
      async () => !(await indexedFiles()).some((file) => file.startsWith('src/feature/')),
      'moved-out directory removed'
    );
  });

  it('drops files that a .gitignore edit newly excludes', async () => {
    await mkdir(join(repoRoot, 'generated'), { recursive: true });
    await writeFile(join(repoRoot, 'generated', 'out.ts'), 'export const generated = true;\n');
    await startWatching();
    await waitFor(async () => (await indexedFiles()).includes('generated/out.ts'), 'generated indexed');

    await writeFile(join(repoRoot, '.gitignore'), 'generated/\n');
    await waitFor(
      async () => !(await indexedFiles()).includes('generated/out.ts'),
      'ignored directory dropped'
    );
  });

  it('retries after an embedding outage instead of dropping the change', async () => {
    await startWatching();
    await waitFor(async () => (await indexedFiles()).includes('src/existing.ts'), 'initial catch-up');

    embeddings.failing = true;
    await writeFile(join(repoRoot, 'src', 'during-outage.ts'), 'export const outage = true;\n');
    await waitFor(async () => embeddings.calls > 1, 'indexing attempted during outage');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await indexedFiles()).not.toContain('src/during-outage.ts');

    embeddings.failing = false;
    await waitFor(
      async () => (await indexedFiles()).includes('src/during-outage.ts'),
      'change indexed after recovery'
    );
  });

  it('waits for another indexer to release the lock, then indexes the pending change', async () => {
    await startWatching();
    await waitFor(async () => (await indexedFiles()).includes('src/existing.ts'), 'initial catch-up');

    const release = acquireLock(context.paths.lockFile);
    await writeFile(join(repoRoot, 'src', 'while-locked.ts'), 'export const locked = true;\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await indexedFiles()).not.toContain('src/while-locked.ts');

    release();
    await waitFor(
      async () => (await indexedFiles()).includes('src/while-locked.ts'),
      'change indexed after lock release'
    );
  });

  it('reclaims a lock left behind by a crashed process', async () => {
    await mkdir(context.paths.indexDir, { recursive: true });
    await writeFile(context.paths.lockFile, '2147483646');
    await startWatching();
    await waitFor(async () => (await indexedFiles()).includes('src/existing.ts'), 'indexed despite stale lock');
  });

  it('keeps one consistent index when two editors watch the same repository', async () => {
    const second = await openContext();
    await startWatching(context);
    await startWatching(second);
    await waitFor(async () => (await indexedFiles()).includes('src/existing.ts'), 'initial catch-up');

    for (let i = 0; i < 5; i++) {
      await writeFile(join(repoRoot, 'src', `shared${i}.ts`), `export const shared${i} = ${i};\n`);
    }
    await waitFor(async () => {
      const files = await indexedFiles();
      return [0, 1, 2, 3, 4].every((i) => files.includes(`src/shared${i}.ts`));
    }, 'all edits indexed');

    const rows = await context.vectorStore.queryAll(['id'], undefined, 1000);
    const ids = rows.map((row) => (row as unknown as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stops cleanly with a change still pending', async () => {
    await startWatching();
    await waitFor(async () => (await indexedFiles()).includes('src/existing.ts'), 'initial catch-up');
    const callsBefore = embeddings.calls;

    await writeFile(join(repoRoot, 'src', 'late.ts'), 'export const late = 1;\n');
    const stop = stops.pop();
    await stop?.();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(embeddings.calls).toBe(callsBefore);
  });
});
