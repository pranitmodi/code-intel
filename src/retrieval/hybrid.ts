import type { EmbeddingProvider } from '../embeddings/EmbeddingProvider.js';
import { normalizeVector } from '../embeddings/vectorMath.js';
import type { SearchConfig } from '../config/types.js';
import type { LanceVectorStore } from '../vector-store/LanceVectorStore.js';
import type { ChunkSearchResult } from '../vector-store/schema.js';
import { candidateFromRecord } from './score.js';
import { mergeCandidates, selectCandidates, type SelectResult } from './select.js';
import type { RetrievalCandidate, RetrievalTrace } from './types.js';

const embedCache = new Map<string, number[]>();
const EMBED_CACHE_LIMIT = 64;

export interface HybridSearchOptions {
  limit?: number;
  minScore?: number;
  maxTokens?: number;
  maxChunksPerFile?: number;
  maxChunksPerSymbol?: number;
}

export interface HybridSearchResult {
  selected: RetrievalCandidate[];
  allCandidates: RetrievalCandidate[];
  discarded: SelectResult['discarded'];
  estimatedTokens: number;
  latencyMs: number;
}

async function embedQuery(query: string, embeddingProvider: EmbeddingProvider): Promise<number[]> {
  const key = `${embeddingProvider.modelName()}:${query}`;
  const cached = embedCache.get(key);
  if (cached) return cached;
  const vector = normalizeVector(await embeddingProvider.embed(query));
  embedCache.set(key, vector);
  if (embedCache.size > EMBED_CACHE_LIMIT) {
    const first = embedCache.keys().next().value;
    if (first !== undefined) embedCache.delete(first);
  }
  return vector;
}

export async function hybridSearch(
  query: string,
  vectorStore: LanceVectorStore,
  embeddingProvider: EmbeddingProvider,
  weights: SearchConfig,
  options: HybridSearchOptions = {}
): Promise<HybridSearchResult> {
  const started = Date.now();
  const limit = options.limit ?? weights.defaultLimit;
  const fetchLimit = Math.max(limit * 4, 20);
  const queryLower = query.toLowerCase();

  const queryVector = await embedQuery(query, embeddingProvider);
  const [vectorResults, keywordResults] = await Promise.all([
    vectorStore.vectorSearch(queryVector, fetchLimit),
    vectorStore.fullTextSearch(query, fetchLimit).catch(() => [] as ChunkSearchResult[])
  ]);

  const combined = new Map<string, RetrievalCandidate>();

  for (const record of vectorResults) {
    const distance = record._distance ?? 2;
    const similarity = Math.min(1, Math.max(0, 1 - distance / 2));
    combined.set(
      record.id,
      candidateFromRecord(
        record,
        { semantic: similarity, keyword: 0, sources: ['semantic'], reason: 'semantic similarity' },
        weights,
        queryLower
      )
    );
  }

  const maxFtsScore = Math.max(...keywordResults.map((r) => r._score ?? 0), 1e-9);
  for (const record of keywordResults) {
    const normalized = Math.min(1, Math.max(0, (record._score ?? 0) / maxFtsScore));
    const incoming = candidateFromRecord(
      record,
      { semantic: 0, keyword: normalized, sources: ['keyword'], reason: 'keyword match' },
      weights,
      queryLower
    );
    const existing = combined.get(record.id);
    combined.set(record.id, existing ? mergeCandidates(existing, incoming) : incoming);
  }

  const allCandidates = [...combined.values()].sort((a, b) => b.score.total - a.score.total);
  const packed = selectCandidates(allCandidates, {
    limit,
    maxTokens: options.maxTokens,
    minScore: options.minScore,
    maxChunksPerFile: options.maxChunksPerFile ?? weights.maxChunksPerFile,
    maxChunksPerSymbol: options.maxChunksPerSymbol ?? weights.maxChunksPerSymbol
  });

  return {
    selected: packed.selected,
    allCandidates,
    discarded: packed.discarded,
    estimatedTokens: packed.estimatedTokens,
    latencyMs: Date.now() - started
  };
}

export function hybridTrace(query: string, result: HybridSearchResult): RetrievalTrace {
  return {
    query,
    candidateCount: result.allCandidates.length,
    selectedCount: result.selected.length,
    discarded: result.discarded,
    estimatedTokens: result.estimatedTokens,
    latencyMs: result.latencyMs,
    expansionHops: 0
  };
}
