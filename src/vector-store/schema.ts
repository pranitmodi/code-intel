// apache-arrow is pinned to an exact version @lancedb/lancedb's native addon is tested against
// (see its NODEJS_THIRD_PARTY_LICENSES.md) — a newer major serializes a schema the native side
// can't parse ("Unable to get root as footer"), since Arrow's JS classes rely on `instanceof`.
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';

export const CHUNKS_TABLE = 'chunks';

/**
 * One row per code chunk (spec section 10), plus `extra_metadata` (JSON string)
 * so the schema can evolve (imports/exports/etc.) without a full rewrite.
 */
export interface ChunkRecord {
  id: string;
  repo_id: string;
  file_path: string;
  absolute_path: string;
  language: string;
  symbol_name: string | null;
  symbol_type: string | null;
  parent_symbol: string | null;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  file_hash: string;
  embedding: number[];
  last_indexed_at: string;
  git_commit: string | null;
  extra_metadata: string | null;
}

/** A row returned from a vector or full-text search, with LanceDB's added scoring columns. */
export type ChunkSearchResult = ChunkRecord & {
  _distance?: number;
  _score?: number;
};

export function buildChunkSchema(embeddingDimensions: number): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('repo_id', new Utf8(), false),
    new Field('file_path', new Utf8(), false),
    new Field('absolute_path', new Utf8(), false),
    new Field('language', new Utf8(), false),
    new Field('symbol_name', new Utf8(), true),
    new Field('symbol_type', new Utf8(), true),
    new Field('parent_symbol', new Utf8(), true),
    new Field('start_line', new Int32(), false),
    new Field('end_line', new Int32(), false),
    new Field('content', new Utf8(), false),
    new Field('content_hash', new Utf8(), false),
    new Field('file_hash', new Utf8(), false),
    new Field('embedding', new FixedSizeList(embeddingDimensions, new Field('item', new Float32(), true)), false),
    new Field('last_indexed_at', new Utf8(), false),
    new Field('git_commit', new Utf8(), true),
    new Field('extra_metadata', new Utf8(), true)
  ]);
}
