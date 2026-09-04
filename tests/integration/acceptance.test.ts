import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Ollama } from 'ollama';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { resolveRepoPaths } from '../../src/config/paths.js';
import { computeRepoId } from '../../src/utils/repo-id.js';
import { OllamaEmbeddingProvider } from '../../src/embeddings/OllamaEmbeddingProvider.js';
import { LanceVectorStore } from '../../src/vector-store/LanceVectorStore.js';
import { Indexer } from '../../src/indexer/Indexer.js';
import { searchCodebase } from '../../src/search/searchCodebase.js';

const EMBEDDING_MODEL = 'nomic-embed-text';
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'test-repo');

async function isOllamaReady(): Promise<boolean> {
  try {
    const client = new Ollama({ host: 'http://127.0.0.1:11434' });
    const { models } = await client.list();
    return models.some((m) => m.name === EMBEDDING_MODEL || m.name.startsWith(`${EMBEDDING_MODEL}:`));
  } catch {
    return false;
  }
}

const ollamaReady = await isOllamaReady();

// Full spec section 44 acceptance scenario, run against a disposable copy of the fixture repo
// and a disposable index location — real Ollama + real LanceDB, skipped only if Ollama/model is missing.
describe.skipIf(!ollamaReady)('acceptance scenario (spec section 44)', () => {
  let repoRoot: string;
  let dbHome: string;
  let repoId: string;
  let indexer: Indexer;
  let vectorStore: LanceVectorStore;
  let embeddingProvider: OllamaEmbeddingProvider;

  beforeAll(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-acceptance-repo-'));
    dbHome = await mkdtemp(join(tmpdir(), 'code-intel-acceptance-db-'));
    await cp(FIXTURE_DIR, repoRoot, { recursive: true });

    const config = loadConfig({ repoRoot });
    config.database.path = dbHome;
    repoId = computeRepoId(repoRoot);
    const paths = resolveRepoPaths(config, repoRoot, repoId);

    embeddingProvider = new OllamaEmbeddingProvider({ host: config.embedding.host, model: config.embedding.model });
    const dimensions = await embeddingProvider.dimensions();
    vectorStore = await LanceVectorStore.open(paths.dbDir, dimensions);
    indexer = new Indexer({ repoRoot, repoId, config, vectorStore, embeddingProvider, paths });
  }, 60000);

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(dbHome, { recursive: true, force: true });
  });

  it('indexes the fixture repo and finds auth.ts for an authentication query', async () => {
    const summary = await indexer.runFullIndex();
    expect(summary.filesIndexed).toBe(4);
    expect(summary.chunksEmbedded).toBeGreaterThan(0);

    const results = await searchCodebase(
      'how does authentication work?',
      vectorStore,
      embeddingProvider,
      loadConfig({ repoRoot }).search
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.file).toBe('auth.ts');
  }, 60000);

  it('re-embeds only the changed chunk(s) when one function is edited, and reflects the change immediately', async () => {
    const authPath = join(repoRoot, 'auth.ts');
    const original = await readFile(authPath, 'utf-8');
    const modified = original.replace(
      "if (!userId) throw new Error('session expired, please log in again');",
      "if (!userId) throw new Error('session expired — please sign in again');"
    );
    expect(modified).not.toBe(original);
    await writeFile(authPath, modified);

    const summary = await indexer.runFullIndex();
    expect(summary.filesIndexed).toBe(1); // only auth.ts changed
    // The edited method chunk + its enclosing class chunk (whose text also changed) — never the whole file.
    expect(summary.chunksEmbedded).toBeLessThanOrEqual(2);
    expect(summary.chunksReused).toBeGreaterThan(0); // sibling methods + users/payments/database chunks

    const results = await searchCodebase('sign in again', vectorStore, embeddingProvider, loadConfig({ repoRoot }).search);
    expect(results.some((r) => r.content.includes('sign in again'))).toBe(true);
  }, 60000);

  it('removes vectors for a deleted file and leaves unrelated files untouched', async () => {
    await rm(join(repoRoot, 'payments.ts'));
    const summary = await indexer.runFullIndex();
    expect(summary.filesDeleted).toBe(1);

    expect(await vectorStore.getChunksForFile('payments.ts')).toHaveLength(0);
    expect((await vectorStore.getChunksForFile('auth.ts')).length).toBeGreaterThan(0);
  }, 60000);

  it('persists across a simulated restart (fresh store instance, same db directory)', async () => {
    const countBefore = await vectorStore.countRows();
    const config = loadConfig({ repoRoot });
    config.database.path = dbHome;
    const paths = resolveRepoPaths(config, repoRoot, repoId);
    const reopened = await LanceVectorStore.open(paths.dbDir, await embeddingProvider.dimensions());
    expect(await reopened.countRows()).toBe(countBefore);
  });
});
