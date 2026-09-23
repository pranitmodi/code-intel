import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { resolveRepoPaths } from '../../src/config/paths.js';
import type { EmbeddingProvider } from '../../src/embeddings/EmbeddingProvider.js';
import { Indexer } from '../../src/indexer/Indexer.js';
import { computeRepoId } from '../../src/utils/repo-id.js';
import type { LanceVectorStore } from '../../src/vector-store/LanceVectorStore.js';
import type { ChunkRecord } from '../../src/vector-store/schema.js';

const TWO_SAME_NAMED_FUNCTIONS = `export function handle(a: number) {
  return a + 1;
}

export function handle(a: string) {
  return a + '!';
}
`;

describe('chunk id collisions within one file', () => {
  let repoRoot: string;
  let dbHome: string;
  const originalDbPath = process.env.CODE_INTEL_DB_PATH;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-collision-repo-'));
    dbHome = await mkdtemp(join(tmpdir(), 'code-intel-collision-db-'));
    process.env.CODE_INTEL_DB_PATH = dbHome;
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(dbHome, { recursive: true, force: true });
    if (originalDbPath === undefined) delete process.env.CODE_INTEL_DB_PATH;
    else process.env.CODE_INTEL_DB_PATH = originalDbPath;
  });

  it('gives same-named siblings distinct ids so the merge batch stays unambiguous', async () => {
    await writeFile(join(repoRoot, 'dup.ts'), TWO_SAME_NAMED_FUNCTIONS);
    const config = loadConfig({ repoRoot });
    const paths = resolveRepoPaths(config, repoRoot, computeRepoId(repoRoot));
    const stored: ChunkRecord[] = [];
    const vectorStore = {
      syncLatest: async () => undefined,
      getAllFileHashes: async () => new Map<string, string>(),
      getChunksForFile: async () => [],
      upsertChunks: async (records: ChunkRecord[]) => {
        stored.push(...records);
      },
      deleteByIds: async () => undefined,
      deleteByFile: async () => undefined,
      renameFile: async () => undefined,
      optimize: async () => undefined,
      countRows: async () => stored.length
    } as unknown as LanceVectorStore;
    const embeddingProvider: EmbeddingProvider = {
      embed: async () => [1, 0],
      embedBatch: async (texts) => texts.map(() => [1, 0]),
      dimensions: async () => 2,
      modelName: () => 'test-model'
    };

    const summary = await new Indexer({
      repoRoot,
      repoId: computeRepoId(repoRoot),
      config,
      vectorStore,
      embeddingProvider,
      paths
    }).runFullIndex();

    const duplicates = stored.filter((record) => record.symbol_name === 'handle');
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((record) => record.id)).size).toBe(2);
    expect(summary.chunksEmbedded).toBe(2);
  });
});
