import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { resolveRepoPaths } from '../../src/config/paths.js';
import type { AppContext } from '../../src/context.js';
import type { EmbeddingProvider } from '../../src/embeddings/EmbeddingProvider.js';
import type { RegistryEntry } from '../../src/indexer/registry.js';
import { writeState } from '../../src/indexer/state.js';
import { createMcpRuntime, type McpRuntime } from '../../src/mcp/runtime.js';
import { startWorkspaceWatchers } from '../../src/mcp/watchOnStart.js';
import { computeRepoId } from '../../src/utils/repo-id.js';
import { LanceVectorStore } from '../../src/vector-store/LanceVectorStore.js';

const DIMENSIONS = 8;
const CLI_SOURCE = resolve('src/cli/index.ts');

const embeddings: EmbeddingProvider = {
  embed: async () => Array.from({ length: DIMENSIONS }, () => 1),
  embedBatch: async (texts) => texts.map(() => Array.from({ length: DIMENSIONS }, () => 1)),
  dimensions: async () => DIMENSIONS,
  modelName: () => 'nomic-embed-text'
};

async function waitFor(check: () => Promise<boolean> | boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe('MCP workspace resolution and watcher refresh', () => {
  let root: string;

  function markIndexed(repoRoot: string): void {
    const config = loadConfig({ repoRoot });
    const paths = resolveRepoPaths(config, repoRoot, computeRepoId(repoRoot));
    writeState(paths.stateFile, {
      lastIndexedAt: new Date().toISOString(),
      lastDurationMs: 1,
      filesIndexed: 1,
      chunksIndexed: 1,
      embeddingModel: config.embedding.model,
      embeddingDimensions: DIMENSIONS,
      repoRoot,
      repoName: 'repo'
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'code-intel-mcp-ws-'));
    process.env.CODE_INTEL_DB_PATH = join(root, 'db');
  });

  afterEach(async () => {
    delete process.env.CODE_INTEL_DB_PATH;
    await rm(root, { recursive: true, force: true });
  });

  it('serves the owning indexed repo when an editor opens one of its subfolders', async () => {
    const repo = join(root, 'monorepo');
    const subfolder = join(repo, 'packages', 'ui');
    await mkdir(subfolder, { recursive: true });
    markIndexed(repo);

    const runtime = await createMcpRuntime(subfolder);
    const resolved = await runtime.resolve();
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.context.repoRoot).toBe(repo);
  });

  it('keeps asking for a child repo when the workspace is a parent folder', async () => {
    const child = join(root, 'parent', 'child');
    await mkdir(child, { recursive: true });
    markIndexed(child);

    const runtime = await createMcpRuntime(join(root, 'parent'));
    const resolved = await runtime.resolve();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.indexedChildren?.map((entry) => entry.path)).toEqual([child]);
  });

  for (const disconnect of ['stdin closed', 'SIGTERM'] as const) {
    it(`exits while watching when the client goes away (${disconnect})`, async () => {
      const repo = join(root, 'watched');
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
      markIndexed(repo);

      const child = spawn(process.execPath, ['--import', 'tsx', CLI_SOURCE, 'mcp', '--repo', repo], {
        env: { ...process.env, CODE_INTEL_EMBEDDING_HOST: 'http://127.0.0.1:9' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      try {
        await waitFor(() => stderr.includes('[WATCH] on for'), 'watcher started', 20_000);
        if (disconnect === 'stdin closed') child.stdin.end();
        else child.kill('SIGTERM');
        const code = await Promise.race([
          exited,
          new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 10_000))
        ]);
        expect(code).toBe(0);
      } finally {
        child.kill('SIGKILL');
      }
    });
  }

  it('starts watching a repo indexed after startup and stops once it is removed', async () => {
    const repoRoot = join(root, 'late');
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, 'first.ts'), 'export const first = 1;\n');

    const config = loadConfig({ repoRoot });
    const repoId = computeRepoId(repoRoot);
    const paths = resolveRepoPaths(config, repoRoot, repoId);
    const context: AppContext = {
      repoRoot,
      repoId,
      config: { ...config, indexing: { ...config.indexing, debounceMs: 100 } },
      paths,
      embeddingProvider: embeddings,
      vectorStore: await LanceVectorStore.open(paths.dbDir, DIMENSIONS)
    };

    let repos: RegistryEntry[] = [];
    const evicted: string[] = [];
    const runtime = {
      defaultRepoRoot: repoRoot,
      config,
      listRepos: async () => repos.map((repo) => ({ ...repo, stale: false })),
      resolve: async () => ({ ok: true as const, context }),
      status: async () => ({}),
      evict: (path: string) => evicted.push(path)
    } satisfies McpRuntime;

    const stop = await startWorkspaceWatchers(runtime, { refreshMs: 150 });
    try {
      const indexed = async () => [...(await context.vectorStore.getAllFileHashes()).keys()];
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await indexed()).toEqual([]);

      repos = [
        {
          id: repoId,
          path: repoRoot,
          name: 'late',
          lastIndexedAt: null,
          filesIndexed: 0,
          chunksIndexed: 0,
          embeddingModel: null
        }
      ];
      await waitFor(async () => (await indexed()).includes('first.ts'), 'late repo caught up');

      await writeFile(join(repoRoot, 'second.ts'), 'export const second = 2;\n');
      await waitFor(async () => (await indexed()).includes('second.ts'), 'late repo watched');

      repos = [];
      await waitFor(() => evicted.includes(repoRoot), 'removed repo evicted');
      await writeFile(join(repoRoot, 'third.ts'), 'export const third = 3;\n');
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(await indexed()).not.toContain('third.ts');
    } finally {
      await stop();
    }
  });
});
