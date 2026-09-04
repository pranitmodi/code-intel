import type { LanceVectorStore } from '../vector-store/LanceVectorStore.js';

export interface ReferenceMatch {
  file: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  isDefinition: boolean;
}

/**
 * Lightweight textual occurrence scan across already-indexed chunk content — NOT full semantic
 * reference resolution (spec section 17 scope: "should not depend entirely on embeddings").
 */
export async function findReferences(symbolName: string, vectorStore: LanceVectorStore, limit = 50): Promise<ReferenceMatch[]> {
  const escaped = escapeSqlString(symbolName);
  const rows = await vectorStore.queryAll(
    ['file_path', 'start_line', 'end_line', 'symbol_name'],
    `content LIKE '%${escaped}%'`,
    limit
  );
  return rows.map((row) => ({
    file: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    symbol: row.symbol_name,
    isDefinition: row.symbol_name === symbolName
  }));
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}
