import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkerVersionOf } from '../../src/chunker/chunkMetadata.js';
import { CHUNKER_VERSION } from '../../src/chunker/version.js';
import { loadConfig } from '../../src/config/load.js';
import { resolveRepoPaths } from '../../src/config/paths.js';
import type { EmbeddingProvider } from '../../src/embeddings/EmbeddingProvider.js';
import { Indexer } from '../../src/indexer/Indexer.js';
import { computeRepoId } from '../../src/utils/repo-id.js';
import { LanceVectorStore } from '../../src/vector-store/LanceVectorStore.js';

const DIMENSIONS = 4;

class CountingEmbeddings implements EmbeddingProvider {
  embedded = 0;
  async embed(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0]!;
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    this.embedded += texts.length;
    return texts.map((text) => [text.length % 7, 1, 2, 3]);
  }
  async dimensions(): Promise<number> {
    return DIMENSIONS;
  }
  modelName(): string {
    return 'counting-embedding';
  }
}

const SOURCE = `/** Adds numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

export const LIMITS = {
  low: 1,
  high: 2
};
`;

describe('chunker upgrades', () => {
  let root: string;
  const originalDbPath = process.env.CODE_INTEL_DB_PATH;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'code-intel-migrate-'));
    process.env.CODE_INTEL_DB_PATH = join(root, 'db');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (originalDbPath === undefined) delete process.env.CODE_INTEL_DB_PATH;
    else process.env.CODE_INTEL_DB_PATH = originalDbPath;
  });

  it('re-chunks files written by an older chunker and reuses embeddings whose text is unchanged', async () => {
    const repoRoot = join(root, 'repo');
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, 'math.ts'), SOURCE);
    const config = loadConfig({ repoRoot });
    const repoId = computeRepoId(repoRoot);
    const paths = resolveRepoPaths(config, repoRoot, repoId);
    const vectorStore = await LanceVectorStore.open(paths.dbDir, DIMENSIONS);
    const embeddings = new CountingEmbeddings();
    const indexer = new Indexer({ repoRoot, repoId, config, vectorStore, embeddingProvider: embeddings, paths });

    await indexer.runFullIndex();
    const first = await vectorStore.getChunksForFile('math.ts');
    expect(first.every((chunk) => chunkerVersionOf(chunk.extraMetadata) === CHUNKER_VERSION)).toBe(true);
    const embeddedOnce = embeddings.embedded;
    expect(embeddedOnce).toBe(first.length);

    // Unchanged file, current chunker: nothing to do.
    await indexer.runFullIndex();
    expect(embeddings.embedded).toBe(embeddedOnce);

    // Pretend an older chunker wrote these rows.
    const rows = await vectorStore.queryAll(['id'], `file_path = 'math.ts'`);
    for (const row of rows) {
      await vectorStore.upsertChunks([
        {
          ...(await vectorStore.queryAll(
            ['id', 'repo_id', 'file_path', 'absolute_path', 'language', 'symbol_name', 'symbol_type', 'parent_symbol', 'start_line', 'end_line', 'content', 'content_hash', 'file_hash', 'embedding', 'last_indexed_at', 'git_commit'],
            `id = '${row.id}'`
          ))[0]!,
          embedding: first.find((chunk) => chunk.id === row.id)!.embedding,
          extra_metadata: '{"imports":[],"exports":[],"referencedSymbols":[],"isTest":false,"isConfig":false}'
        } as never
      ]);
    }
    expect((await vectorStore.getChunksForFile('math.ts')).every((chunk) => chunkerVersionOf(chunk.extraMetadata) === 0)).toBe(true);

    await indexer.runFullIndex();
    const upgraded = await vectorStore.getChunksForFile('math.ts');
    expect(upgraded.every((chunk) => chunkerVersionOf(chunk.extraMetadata) === CHUNKER_VERSION)).toBe(true);
    expect(embeddings.embedded).toBe(embeddedOnce);
  });
});
