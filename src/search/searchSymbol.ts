import type { LanceVectorStore } from '../vector-store/LanceVectorStore.js';

export interface SymbolMatch {
  symbol: string | null;
  symbolType: string | null;
  parentSymbol: string | null;
  file: string;
  startLine: number;
  endLine: number;
  exact: boolean;
}

/** AST-derived symbol lookup (spec section 17) — independent of embeddings, exact match first then substring. */
export async function searchSymbol(name: string, vectorStore: LanceVectorStore, limit = 20): Promise<SymbolMatch[]> {
  const escaped = escapeSqlString(name);
  const select = ['symbol_name', 'symbol_type', 'parent_symbol', 'file_path', 'start_line', 'end_line'];

  const exact = await vectorStore.queryAll(select, `symbol_name = '${escaped}'`, limit);
  if (exact.length > 0) return exact.map((r) => toMatch(r, true));

  const fuzzy = await vectorStore.queryAll(select, `symbol_name LIKE '%${escaped}%'`, limit);
  return fuzzy.map((r) => toMatch(r, false));
}

function toMatch(record: Awaited<ReturnType<LanceVectorStore['queryAll']>>[number], exact: boolean): SymbolMatch {
  return {
    symbol: record.symbol_name,
    symbolType: record.symbol_type,
    parentSymbol: record.parent_symbol,
    file: record.file_path,
    startLine: record.start_line,
    endLine: record.end_line,
    exact
  };
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}
