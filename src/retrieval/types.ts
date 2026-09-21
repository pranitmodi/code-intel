import type { ChunkExtraMetadata } from '../chunker/chunkMetadata.js';

export interface RetrievalScore {
  total: number;
  semantic: number;
  keyword: number;
  symbol: number;
  path: number;
  structural: number;
  dependency: number;
  reference: number;
  test: number;
  recency: number;
}

export type CandidateSource = 'semantic' | 'keyword' | 'symbol' | 'expansion';

export interface RetrievalCandidate {
  id: string;
  file: string;
  symbol: string | null;
  symbolType: string | null;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  lastIndexedAt: string | null;
  extra: ChunkExtraMetadata;
  sources: CandidateSource[];
  score: RetrievalScore;
  estimatedTokens: number;
  reason: string;
}

export interface RetrievalTrace {
  query: string;
  candidateCount: number;
  selectedCount: number;
  discarded: Array<{ id: string; file: string; reason: string }>;
  estimatedTokens: number;
  latencyMs: number;
  expansionHops: number;
}

export interface RetrievalConfidence {
  score: number;
  reason: string;
}

export interface ContextPackage {
  query: string;
  summary: string;
  files: Array<{
    path: string;
    reason: string;
    score: RetrievalScore;
    chunks: Array<{
      symbol?: string;
      startLine: number;
      endLine: number;
      content: string;
    }>;
  }>;
  relationships?: Array<{
    from: string;
    to: string;
    type: 'imports' | 'calls' | 'references' | 'tests';
  }>;
  estimatedTokens: number;
  retrievalStats: {
    candidatesConsidered: number;
    candidatesSelected: number;
    expansionHops: number;
  };
  confidence: RetrievalConfidence;
  trace?: RetrievalTrace;
}

export type ContextMode = 'minimal' | 'normal' | 'deep';
