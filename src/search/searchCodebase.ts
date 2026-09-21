import type { EmbeddingProvider } from '../embeddings/EmbeddingProvider.js';
import type { SearchConfig } from '../config/types.js';
import type { LanceVectorStore } from '../vector-store/LanceVectorStore.js';
import { hybridSearch, hybridTrace, type HybridSearchOptions } from '../retrieval/hybrid.js';
import type { RetrievalCandidate, RetrievalTrace } from '../retrieval/types.js';

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

export interface SearchDetailedResult {
  results: SearchResultItem[];
  selected: RetrievalCandidate[];
  trace: RetrievalTrace;
}

function toItem(candidate: RetrievalCandidate): SearchResultItem {
  return {
    file: candidate.file,
    symbol: candidate.symbol,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    score: candidate.score.total,
    content: candidate.content
  };
}

/** Hybrid ranking: LanceDB vector search + FTS + inspectable scores, diversity, and token budget. */
export async function searchCodebaseDetailed(
  query: string,
  vectorStore: LanceVectorStore,
  embeddingProvider: EmbeddingProvider,
  weights: SearchConfig,
  options: SearchOptions = {}
): Promise<SearchDetailedResult> {
  const hybridOptions: HybridSearchOptions = {
    limit: options.limit,
    minScore: options.minScore,
    maxTokens: options.maxTokens
  };
  const result = await hybridSearch(query, vectorStore, embeddingProvider, weights, hybridOptions);
  return {
    results: result.selected.map(toItem),
    selected: result.selected,
    trace: hybridTrace(query, result)
  };
}

export async function searchCodebase(
  query: string,
  vectorStore: LanceVectorStore,
  embeddingProvider: EmbeddingProvider,
  weights: SearchConfig,
  options: SearchOptions = {}
): Promise<SearchResultItem[]> {
  const detailed = await searchCodebaseDetailed(query, vectorStore, embeddingProvider, weights, options);
  return detailed.results;
}
