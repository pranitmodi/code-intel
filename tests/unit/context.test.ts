import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { resolveRepoPaths } from '../../src/config/paths.js';
import { createContext } from '../../src/context.js';
import { writeState } from '../../src/indexer/state.js';
import { computeRepoId } from '../../src/utils/repo-id.js';

describe('embedding model compatibility', () => {
  let repoRoot: string;
  let dbHome: string;
  const originalDbPath = process.env.CODE_INTEL_DB_PATH;
  const originalModel = process.env.CODE_INTEL_EMBEDDING_MODEL;

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    if (dbHome) await rm(dbHome, { recursive: true, force: true });
    if (originalDbPath === undefined) delete process.env.CODE_INTEL_DB_PATH;
    else process.env.CODE_INTEL_DB_PATH = originalDbPath;
    if (originalModel === undefined) delete process.env.CODE_INTEL_EMBEDDING_MODEL;
    else process.env.CODE_INTEL_EMBEDDING_MODEL = originalModel;
  });

  it('requires rebuilding before querying an index made with another model', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-context-repo-'));
    dbHome = await mkdtemp(join(tmpdir(), 'code-intel-context-db-'));
    process.env.CODE_INTEL_DB_PATH = dbHome;
    process.env.CODE_INTEL_EMBEDDING_MODEL = 'Qwen3-Embedding-8B';

    const config = loadConfig({ repoRoot });
    const paths = resolveRepoPaths(config, repoRoot, computeRepoId(repoRoot));
    writeState(paths.stateFile, {
      lastIndexedAt: new Date().toISOString(),
      lastDurationMs: 1,
      filesIndexed: 1,
      chunksIndexed: 1,
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 768
    });

    await expect(createContext(repoRoot)).rejects.toThrow('code-intel rebuild');
  });
});
