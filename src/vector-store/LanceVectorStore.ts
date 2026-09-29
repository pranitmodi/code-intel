import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { createLogger } from '../utils/logger.js';
import { buildChunkSchema, CHUNKS_TABLE, type ChunkRecord, type ChunkSearchResult } from './schema.js';

const logger = createLogger('vector-store');

/**
 * Seconds between checks for versions written by other processes. Without it a
 * handle stays on the version it opened, so an MCP server keeps serving stale
 * results after another editor's watcher or `code-intel index` updates the table.
 */
const READ_CONSISTENCY_INTERVAL_SECONDS = 1;

/**
 * Below this many rows an exact scan takes a few milliseconds, while IVF-PQ
 * trades that for quantised distances that compress relevant and unrelated
 * scores together. Only larger tables get an ANN index.
 */
export const ANN_MIN_ROWS = 10_000;
/** Retrain the ANN index once the table has grown this much past the rows it was trained on. */
const ANN_RETRAIN_GROWTH = 2;
/** Partitions probed per query and candidates re-ranked with exact distances. */
const ANN_NPROBES = 32;
const ANN_REFINE_FACTOR = 10;
/** How long a handle trusts its view of whether an ANN index should be used. */
const ANN_MODE_TTL_MS = 5 * 60 * 1000;
const ANN_STATE_FILE = 'ann-index.json';

type AnnMode = 'exact' | 'ann';

/** `CODE_INTEL_ANN_INDEX=off` keeps vector search exact regardless of table size (deterministic benchmarks). */
function annIndexDisabled(): boolean {
  return process.env.CODE_INTEL_ANN_INDEX?.trim().toLowerCase() === 'off';
}

export interface FileChunkSummary {
  id: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  embedding: number[];
  extraMetadata: string | null;
}

/**
 * Thin wrapper around one repo's LanceDB `chunks` table — schema setup,
 * upsert/delete/rename, and the two low-level search primitives (vector + FTS)
 * that the search layer combines. Never the sole source of truth for file
 * content (spec section 18) — callers read the working tree for that.
 */
export class LanceVectorStore {
  private annMode: AnnMode = 'exact';
  private annModeCheckedAt = 0;
  private filePathCache: { version: number; paths: string[] } | undefined;

  private constructor(
    private readonly connection: lancedb.Connection,
    private readonly table: lancedb.Table,
    private readonly dbDir: string
  ) {}

  static async open(dbDir: string, embeddingDimensions: number): Promise<LanceVectorStore> {
    const connection = await lancedb.connect(dbDir, {
      readConsistencyInterval: READ_CONSISTENCY_INTERVAL_SECONDS
    });
    const table = await LanceVectorStore.openOrCreateTable(connection, embeddingDimensions);
    const store = new LanceVectorStore(connection, table, dbDir);
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

  /**
   * Create only the indexes that are missing. `createIndex` replaces an
   * existing index by default, so calling it unconditionally rebuilt every
   * index (and retrained IVF-PQ) each time a process opened the table.
   * New rows reach existing indexes through `optimize()`.
   */
  private async ensureIndices(): Promise<void> {
    const existing = await this.indexedColumns();
    if (!existing.has('file_path')) {
      await this.tryCreateIndex('file_path BTree index', () =>
        this.table.createIndex('file_path', { config: lancedb.Index.btree(), replace: false })
      );
    }
    if (!existing.has('symbol_name')) {
      await this.tryCreateIndex('symbol_name BTree index', () =>
        this.table.createIndex('symbol_name', { config: lancedb.Index.btree(), replace: false })
      );
    }
    if (!existing.has('content')) {
      await this.tryCreateIndex('content FTS index', () =>
        this.table.createIndex('content', { config: lancedb.Index.fts(), replace: false })
      );
    }
    await this.refreshAnnMode(existing);
  }

  /** Column name -> index, for the indexes that already exist. */
  private async indexedColumns(): Promise<Map<string, lancedb.IndexConfig>> {
    try {
      const indices = await this.table.listIndices();
      return new Map(indices.flatMap((index) => index.columns.map((column) => [column, index] as const)));
    } catch (error) {
      logger.debug('Could not list indexes', { error: error instanceof Error ? error.message : String(error) });
      return new Map();
    }
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

  /**
   * Move to the newest table version. Call under the index lock before a write
   * pass: a merge planned from an older version can insert rows another process
   * already wrote, duplicating chunk ids.
   */
  async syncLatest(): Promise<void> {
    await this.table.checkoutLatest();
  }

  /** Upsert by `id` — matched rows are fully replaced (new embedding/content/lines), unmatched rows are inserted. */
  async upsertChunks(records: ChunkRecord[]): Promise<void> {
    if (records.length === 0) return;
    const batch = dedupeById(records);
    // `ChunkRecord` is an exact interface (no index signature) but LanceDB's `Data` param requires one;
    // the object shapes are otherwise identical, so this cast is safe.
    await this.table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(batch as unknown as Record<string, unknown>[]);
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
      .select(['id', 'content_hash', 'start_line', 'end_line', 'embedding', 'extra_metadata'])
      .toArray();
    return rows.map((row) => ({
      id: String(row.id),
      contentHash: String(row.content_hash),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      embedding: Array.from(row.embedding as ArrayLike<number>),
      extraMetadata: row.extra_metadata == null ? null : String(row.extra_metadata)
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
    let query = this.table.vectorSearch(queryVector).limit(limit);
    query = (await this.currentAnnMode()) === 'ann'
      ? query.nprobes(ANN_NPROBES).refineFactor(ANN_REFINE_FACTOR)
      : query.bypassVectorIndex();
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

  /** Current table version; changes whenever any process commits a write. */
  async tableVersion(): Promise<number> {
    return this.table.version();
  }

  /**
   * Every indexed file path, sorted. Cached until the table version changes,
   * so per-term path matching runs in memory instead of as SQL LIKE scans.
   */
  async filePaths(): Promise<string[]> {
    const version = await this.table.version();
    if (this.filePathCache?.version === version) return this.filePathCache.paths;
    const rows = await this.table.query().select(['file_path']).toArray();
    const paths = [...new Set(rows.map((row) => String(row.file_path)))].sort();
    this.filePathCache = { version, paths };
    return paths;
  }

  /**
   * Compact files and fold new rows into existing indexes, then maintain the
   * ANN index. Callers hold the index lock, so this is the only place that
   * drops, creates, or retrains IVF-PQ.
   */
  async optimize(): Promise<void> {
    await this.table.optimize();
    await this.maintainVectorAnnIndex();
  }

  /**
   * Exact search for small tables and when ANN is disabled; IVF-PQ (probed
   * widely and refined with exact distances) once the table is large.
   * Earlier versions trained IVF-PQ at 256 rows, so small tables may still
   * carry one — it is bypassed here and dropped by the next `optimize()`.
   */
  private async refreshAnnMode(existing?: Map<string, lancedb.IndexConfig>): Promise<AnnMode> {
    const indexed = (existing ?? (await this.indexedColumns())).has('embedding');
    const rows = indexed ? await this.table.countRows() : 0;
    this.annMode = indexed && !annIndexDisabled() && rows >= ANN_MIN_ROWS ? 'ann' : 'exact';
    this.annModeCheckedAt = Date.now();
    return this.annMode;
  }

  private async currentAnnMode(): Promise<AnnMode> {
    if (Date.now() - this.annModeCheckedAt < ANN_MODE_TTL_MS) return this.annMode;
    return this.refreshAnnMode().catch(() => this.annMode);
  }

  private async maintainVectorAnnIndex(): Promise<void> {
    const existing = await this.indexedColumns();
    const index = existing.get('embedding');
    const rows = await this.table.countRows();
    const disabled = annIndexDisabled();

    if (index && (disabled || rows < ANN_MIN_ROWS)) {
      await this.tryDropIndex(index.name);
      this.writeAnnState(null);
    } else if (!disabled && rows >= ANN_MIN_ROWS) {
      const trainedRows = this.readAnnState()?.trainedRows ?? (index ? rows : 0);
      const retrain = Boolean(index) && rows >= trainedRows * ANN_RETRAIN_GROWTH;
      if (!index || retrain) {
        await this.tryCreateIndex(retrain ? 'embedding IVF-PQ retrain' : 'embedding IVF-PQ index', () =>
          this.table.createIndex('embedding', {
            config: lancedb.Index.ivfPq({ distanceType: 'l2' }),
            replace: retrain
          })
        );
        this.writeAnnState({ trainedRows: rows });
      } else if (!this.readAnnState()) {
        this.writeAnnState({ trainedRows });
      }
    }
    await this.refreshAnnMode();
  }

  private async tryDropIndex(name: string): Promise<void> {
    try {
      await this.table.dropIndex(name);
    } catch (error) {
      logger.debug(`Could not drop index ${name}`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private readAnnState(): { trainedRows: number } | null {
    const file = join(this.dbDir, ANN_STATE_FILE);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { trainedRows?: unknown };
      return typeof parsed.trainedRows === 'number' ? { trainedRows: parsed.trainedRows } : null;
    } catch {
      return null;
    }
  }

  private writeAnnState(state: { trainedRows: number } | null): void {
    try {
      writeFileSync(join(this.dbDir, ANN_STATE_FILE), JSON.stringify(state ?? {}), 'utf8');
    } catch (error) {
      logger.debug('Could not record ANN index state', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * LanceDB aborts a merge holding two source rows with the same key, which would fail the whole
 * indexing pass over one file. Callers are expected to emit unique ids; last write wins otherwise.
 */
function dedupeById(records: ChunkRecord[]): ChunkRecord[] {
  const byId = new Map<string, ChunkRecord>();
  for (const record of records) byId.set(record.id, record);
  if (byId.size === records.length) return records;
  logger.warn(`Collapsed ${records.length - byId.size} duplicate chunk id(s) before merge`, {
    file: records[0]?.file_path
  });
  return [...byId.values()];
}
