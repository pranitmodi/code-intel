import * as lancedb from '@lancedb/lancedb';
import { createLogger } from '../utils/logger.js';
import { buildChunkSchema, CHUNKS_TABLE, type ChunkRecord, type ChunkSearchResult } from './schema.js';

const logger = createLogger('vector-store');

export interface FileChunkSummary {
  id: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  embedding: number[];
}

/**
 * Thin wrapper around one repo's LanceDB `chunks` table — schema setup,
 * upsert/delete/rename, and the two low-level search primitives (vector + FTS)
 * that the search layer combines. Never the sole source of truth for file
 * content (spec section 18) — callers read the working tree for that.
 */
export class LanceVectorStore {
  private constructor(
    private readonly connection: lancedb.Connection,
    private readonly table: lancedb.Table
  ) {}

  static async open(dbDir: string, embeddingDimensions: number): Promise<LanceVectorStore> {
    const connection = await lancedb.connect(dbDir);
    const table = await LanceVectorStore.openOrCreateTable(connection, embeddingDimensions);
    const store = new LanceVectorStore(connection, table);
    await store.ensureIndices();
    return store;
  }

  private static async openOrCreateTable(
    connection: lancedb.Connection,
    embeddingDimensions: number
  ): Promise<lancedb.Table> {
    try {
      return await connection.openTable(CHUNKS_TABLE);
    } catch {
      const schema = buildChunkSchema(embeddingDimensions);
      return await connection.createEmptyTable(CHUNKS_TABLE, schema);
    }
  }

  /** Best-effort — LanceDB throws if an index with the same name already exists, which is fine to ignore. */
  private async ensureIndices(): Promise<void> {
    await this.tryCreateIndex('file_path BTree index', () =>
      this.table.createIndex('file_path', { config: lancedb.Index.btree() })
    );
    await this.tryCreateIndex('symbol_name BTree index', () =>
      this.table.createIndex('symbol_name', { config: lancedb.Index.btree() })
    );
    await this.tryCreateIndex('content FTS index', () =>
      this.table.createIndex('content', { config: lancedb.Index.fts() })
    );
    await this.ensureVectorAnnIndex();
  }

  private async tryCreateIndex(label: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      logger.debug(`Skipping ${label} (likely already exists)`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** Upsert by `id` — matched rows are fully replaced (new embedding/content/lines), unmatched rows are inserted. */
  async upsertChunks(records: ChunkRecord[]): Promise<void> {
    if (records.length === 0) return;
    // `ChunkRecord` is an exact interface (no index signature) but LanceDB's `Data` param requires one;
    // the object shapes are otherwise identical, so this cast is safe.
    await this.table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(records as unknown as Record<string, unknown>[]);
  }

  async deleteByFile(filePath: string): Promise<void> {
    await this.table.delete(`file_path = '${escapeSqlString(filePath)}'`);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const list = ids.map((id) => `'${escapeSqlString(id)}'`).join(', ');
    await this.table.delete(`id IN (${list})`);
  }

  /** Bulk-reassigns a file's chunks to a new path without touching embeddings (content-hash-matched rename). */
  async renameFile(oldFilePath: string, newFilePath: string, newAbsolutePath: string): Promise<void> {
    await this.table.update({
      where: `file_path = '${escapeSqlString(oldFilePath)}'`,
      values: { file_path: newFilePath, absolute_path: newAbsolutePath }
    });
  }

  /** Corrects line-range drift for a chunk whose content didn't change but shifted position in the file. */
  async updateChunkLineRange(id: string, startLine: number, endLine: number): Promise<void> {
    await this.table.update({
      where: `id = '${escapeSqlString(id)}'`,
      values: { start_line: startLine, end_line: endLine }
    });
  }

  async getChunksForFile(filePath: string): Promise<FileChunkSummary[]> {
    const rows = await this.table
      .query()
      .where(`file_path = '${escapeSqlString(filePath)}'`)
      .select(['id', 'content_hash', 'start_line', 'end_line', 'embedding'])
      .toArray();
    return rows.map((row) => ({
      id: String(row.id),
      contentHash: String(row.content_hash),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      embedding: Array.from(row.embedding as ArrayLike<number>)
    }));
  }

  /** Hydrates the incremental-diff manifest: every indexed file's current content hash. */
  async getAllFileHashes(): Promise<Map<string, string>> {
    const rows = await this.table.query().select(['file_path', 'file_hash']).toArray();
    const result = new Map<string, string>();
    for (const row of rows) {
      result.set(String(row.file_path), String(row.file_hash));
    }
    return result;
  }

  async vectorSearch(queryVector: number[], limit: number, where?: string): Promise<ChunkSearchResult[]> {
    let query = this.table.search(queryVector).limit(limit);
    if (where) query = query.where(where);
    const rows = await query.toArray();
    return rows as ChunkSearchResult[];
  }

  async fullTextSearch(queryText: string, limit: number, where?: string): Promise<ChunkSearchResult[]> {
    let query = this.table.search(queryText, 'fts').limit(limit);
    if (where) query = query.where(where);
    const rows = await query.toArray();
    return rows as ChunkSearchResult[];
  }

  /** General-purpose filtered read (symbol search, reference scans, repo-context aggregation) — no vector/FTS scoring. */
  async queryAll(select: string[], where?: string, limit?: number): Promise<ChunkSearchResult[]> {
    let query = this.table.query().select(select);
    if (where) query = query.where(where);
    query = query.limit(limit ?? 1_000_000);
    const rows = await query.toArray();
    return rows as ChunkSearchResult[];
  }

  async countRows(): Promise<number> {
    return this.table.countRows();
  }

  /** Compact Lance files, then add IVF-PQ once the table is large enough. */
  async optimize(): Promise<void> {
    await this.table.optimize();
    await this.ensureVectorAnnIndex();
  }

  /** IVF-PQ ANN once there are enough rows; small indexes keep brute-force kNN. */
  private async ensureVectorAnnIndex(): Promise<void> {
    const rows = await this.table.countRows();
    if (rows < 256) return;
    await this.tryCreateIndex('embedding IVF-PQ index', () =>
      this.table.createIndex('embedding', {
        config: lancedb.Index.ivfPq({ distanceType: 'l2' })
      })
    );
  }
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}
