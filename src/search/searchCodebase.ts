import type { EmbeddingProvider } from '../embeddings/EmbeddingProvider.js';
import { normalizeVector } from '../embeddings/vectorMath.js';
import type { SearchConfig } from '../config/types.js';
import type { LanceVectorStore } from '../vector-store/LanceVectorStore.js';
import type { ChunkSearchResult } from '../vector-store/schema.js';

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  maxTokens?: number;
}

export interface SearchResultItem {
  file: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  score: number;
  content: string;
}

const CHARS_PER_TOKEN = 4;

/** Hybrid ranking: LanceDB vector search + LanceDB full-text search, blended with the configured weights (spec section 16). */
export async function searchCodebase(
  query: string,
  vectorStore: LanceVectorStore,
  embeddingProvider: EmbeddingProvider,
  weights: SearchConfig,
  options: SearchOptions = {}
): Promise<SearchResultItem[]> {
  const limit = options.limit ?? weights.defaultLimit;
  const fetchLimit = Math.max(limit * 4, 20);

  const queryVector = normalizeVector(await embeddingProvider.embed(query));
  const [vectorResults, keywordResults] = await Promise.all([
    vectorStore.vectorSearch(queryVector, fetchLimit),
    vectorStore.fullTextSearch(query, fetchLimit).catch(() => [] as ChunkSearchResult[])
  ]);

  const combined = new Map<string, { record: ChunkSearchResult; vectorScore: number; keywordScore: number }>();

  for (const record of vectorResults) {
    const distance = record._distance ?? 2;
    const similarity = clamp01(1 - distance / 2); // unit vectors -> squared L2 distance in [0, 4]; keep clamp defensive
    combined.set(record.id, { record, vectorScore: similarity, keywordScore: 0 });
  }

  const maxFtsScore = Math.max(...keywordResults.map((r) => r._score ?? 0), 1e-9);
  for (const record of keywordResults) {
    const normalized = clamp01((record._score ?? 0) / maxFtsScore);
    const existing = combined.get(record.id);
    if (existing) existing.keywordScore = normalized;
    else combined.set(record.id, { record, vectorScore: 0, keywordScore: normalized });
  }

  const queryLower = query.toLowerCase();
  const scored = [...combined.values()].map(({ record, vectorScore, keywordScore }) => {
    const symbolScore = symbolMatchScore(record, queryLower);
    const score = weights.vectorWeight * vectorScore + weights.keywordWeight * keywordScore + weights.symbolWeight * symbolScore;
    return { record, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const minScore = options.minScore ?? 0;
  const results: SearchResultItem[] = [];
  let tokenBudget = 0;
  for (const { record, score } of scored) {
    if (results.length >= limit) break;
    if (score < minScore) continue;
    const estimatedTokens = Math.ceil(record.content.length / CHARS_PER_TOKEN);
    if (options.maxTokens && results.length > 0 && tokenBudget + estimatedTokens > options.maxTokens) break;
    tokenBudget += estimatedTokens;
    results.push({
      file: record.file_path,
      symbol: record.symbol_name ? qualifiedSymbolName(record) : null,
      startLine: record.start_line,
      endLine: record.end_line,
      score: Math.round(score * 1000) / 1000,
      content: record.content
    });
  }
  return results;
}

function symbolMatchScore(record: ChunkSearchResult, queryLower: string): number {
  const name = record.symbol_name?.toLowerCase();
  if (name && queryLower.includes(name)) return 1;
  const parent = record.parent_symbol?.toLowerCase();
  if (parent && queryLower.includes(parent)) return 0.5;
  return 0;
}

function qualifiedSymbolName(record: ChunkSearchResult): string {
  return record.parent_symbol ? `${record.parent_symbol}.${record.symbol_name}` : (record.symbol_name ?? '');
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
