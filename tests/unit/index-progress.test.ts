import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { resolveRepoPaths } from '../../src/config/paths.js';
import type { EmbeddingProvider } from '../../src/embeddings/EmbeddingProvider.js';
import { OpenAICompatibleEmbeddingError } from '../../src/embeddings/OpenAICompatibleEmbeddingProvider.js';
import { Indexer } from '../../src/indexer/Indexer.js';
import { getIndexStatus } from '../../src/indexer/status.js';
import { writeProgress } from '../../src/indexer/state.js';
import { computeRepoId } from '../../src/utils/repo-id.js';
import type { LanceVectorStore } from '../../src/vector-store/LanceVectorStore.js';
import type { ChunkRecord } from '../../src/vector-store/schema.js';

describe('index progress and bad-file isolation', () => {
  let repoRoot: string;
  let dbHome: string;
  const originalDbPath = process.env.CODE_INTEL_DB_PATH;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-progress-repo-'));
    dbHome = await mkdtemp(join(tmpdir(), 'code-intel-progress-db-'));
    process.env.CODE_INTEL_DB_PATH = dbHome;
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(dbHome, { recursive: true, force: true });
    if (originalDbPath === undefined) delete process.env.CODE_INTEL_DB_PATH;
    else process.env.CODE_INTEL_DB_PATH = originalDbPath;
  });

  it('reports a partial checkpoint before a final state exists', async () => {
    const config = loadConfig({ repoRoot });
    const paths = resolveRepoPaths(config, repoRoot, computeRepoId(repoRoot));
    writeProgress(paths.progressFile, {
      startedAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:01:00.000Z',
      filesDiscovered: 100,
      filesProcessed: 25,
      filesIndexed: 24,
      filesSkipped: 1,
      chunksEmbedded: 80,
      embeddingModel: 'Qwen3-Embedding-8B'
    });

    const status = await getIndexStatus(repoRoot);
    expect(status.indexed).toBe(false);
    expect(status.progress).toMatchObject({
      active: false,
      filesProcessed: 25,
      filesDiscovered: 100,
      chunksEmbedded: 80
    });
  });

  it('skips a confirmed oversized input but continues indexing other files', async () => {
    await writeFile(join(repoRoot, 'bad.txt'), 'BAD INPUT');
    await writeFile(join(repoRoot, 'good.txt'), 'useful source');
    const config = loadConfig({ repoRoot });
    const paths = resolveRepoPaths(config, repoRoot, computeRepoId(repoRoot));
    const stored: ChunkRecord[] = [];
    const vectorStore = {
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
      embedBatch: async (texts) => {
        if (texts.some((text) => text.includes('BAD INPUT'))) {
          throw new OpenAICompatibleEmbeddingError(
            'context too large',
            400,
            false,
            'input-too-large'
          );
        }
        return texts.map(() => [1, 0]);
      },
      dimensions: async () => 2,
      modelName: () => 'Qwen3-Embedding-8B'
    };

    const summary = await new Indexer({
      repoRoot,
      repoId: computeRepoId(repoRoot),
      config,
      vectorStore,
      embeddingProvider,
      paths
    }).runFullIndex();

    expect(summary.filesIndexed).toBe(1);
    expect(summary.filesSkipped).toBe(1);
    expect(stored).toHaveLength(1);
    expect(existsSync(paths.progressFile)).toBe(false);
  });
});
