import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LanceVectorStore } from '../../src/vector-store/LanceVectorStore.js';
import type { ChunkRecord } from '../../src/vector-store/schema.js';

const DIMENSIONS = 4;

function makeChunk(overrides: Partial<ChunkRecord>): ChunkRecord {
  return {
    id: 'chunk-1',
    repo_id: 'repo-abc',
    file_path: 'src/auth.ts',
    absolute_path: '/repo/src/auth.ts',
    language: 'typescript',
    symbol_name: 'refreshToken',
    symbol_type: 'method',
    parent_symbol: 'AuthService',
    start_line: 10,
    end_line: 20,
    content: 'function refreshToken() { return renewSession(); }',
    content_hash: 'hash-1',
    file_hash: 'filehash-1',
    embedding: [0.1, 0.2, 0.3, 0.4],
    last_indexed_at: new Date().toISOString(),
    git_commit: null,
    extra_metadata: null,
    ...overrides
  };
}

describe('LanceVectorStore', () => {
  let dbDir: string;
  let store: LanceVectorStore;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'code-intel-vs-'));
    store = await LanceVectorStore.open(dbDir, DIMENSIONS);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('upserts and retrieves chunks for a file', async () => {
    await store.upsertChunks([makeChunk({})]);
    const chunks = await store.getChunksForFile('src/auth.ts');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ id: 'chunk-1', contentHash: 'hash-1', startLine: 10, endLine: 20 });
  });

  it('merge-insert replaces an existing row with the same id', async () => {
    await store.upsertChunks([makeChunk({})]);
    await store.upsertChunks([makeChunk({ content: 'changed', content_hash: 'hash-2' })]);
    const chunks = await store.getChunksForFile('src/auth.ts');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.contentHash).toBe('hash-2');
  });

  it('tracks file hashes for incremental diffing', async () => {
    await store.upsertChunks([makeChunk({})]);
    const hashes = await store.getAllFileHashes();
    expect(hashes.get('src/auth.ts')).toBe('filehash-1');
  });

  it('deletes all chunks for a file', async () => {
    await store.upsertChunks([makeChunk({})]);
    await store.deleteByFile('src/auth.ts');
    expect(await store.getChunksForFile('src/auth.ts')).toHaveLength(0);
    expect(await store.countRows()).toBe(0);
  });

  it('deletes specific chunk ids', async () => {
    await store.upsertChunks([
      makeChunk({ id: 'chunk-1' }),
      makeChunk({ id: 'chunk-2', start_line: 30, end_line: 40 })
    ]);
    await store.deleteByIds(['chunk-1']);
    const chunks = await store.getChunksForFile('src/auth.ts');
    expect(chunks.map((c) => c.id)).toEqual(['chunk-2']);
  });

  it("renames a file across all its chunks without touching content", async () => {
    await store.upsertChunks([makeChunk({})]);
    await store.renameFile('src/auth.ts', 'src/auth/index.ts', '/repo/src/auth/index.ts');
    expect(await store.getChunksForFile('src/auth.ts')).toHaveLength(0);
    expect(await store.getChunksForFile('src/auth/index.ts')).toHaveLength(1);
  });

  it('updates a chunk line range without re-embedding', async () => {
    await store.upsertChunks([makeChunk({})]);
    await store.updateChunkLineRange('chunk-1', 15, 25);
    const chunks = await store.getChunksForFile('src/auth.ts');
    expect(chunks[0]).toMatchObject({ startLine: 15, endLine: 25 });
  });

  it('finds the nearest chunk by vector similarity', async () => {
    await store.upsertChunks([
      makeChunk({ id: 'close', embedding: [1, 0, 0, 0], file_path: 'a.ts' }),
      makeChunk({ id: 'far', embedding: [0, 0, 0, 1], file_path: 'b.ts' })
    ]);
    const results = await store.vectorSearch([1, 0, 0, 0], 1);
    expect(results[0]?.id).toBe('close');
  });

  it('optimizes a small table without requiring an ANN index', async () => {
    await store.upsertChunks([makeChunk({})]);
    await expect(store.optimize()).resolves.toBeUndefined();
    expect(await store.countRows()).toBe(1);
  });

  it('finds a chunk by keyword via full-text search', async () => {
    await store.upsertChunks([
      makeChunk({ id: 'auth-chunk', content: 'refreshToken renews the session', file_path: 'a.ts' }),
      makeChunk({ id: 'payments-chunk', content: 'processPayment charges the card', file_path: 'b.ts' })
    ]);
    const results = await store.fullTextSearch('refreshToken', 5);
    expect(results.some((r) => r.id === 'auth-chunk')).toBe(true);
  });
});
