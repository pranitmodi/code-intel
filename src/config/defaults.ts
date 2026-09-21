import type { CodeIntelConfig } from './types.js';

export const DEFAULT_CONFIG: CodeIntelConfig = {
  embedding: {
    provider: 'ollama',
    model: 'nomic-embed-text',
    host: 'http://127.0.0.1:11434',
    baseUrl: '',
    embeddingsPath: '/embeddings',
    batchSize: 32,
    timeoutMs: 60_000,
    useSystemCa: false
  },
  database: {
    path: '~/.local-code-intelligence'
  },
  indexing: {
    maxChunkTokens: 800,
    chunkOverlap: 100,
    debounceMs: 1000,
    watch: true,
    concurrency: 4
  },
  search: {
    defaultLimit: 10,
    vectorWeight: 0.7,
    keywordWeight: 0.2,
    symbolWeight: 0.1,
    pathWeight: 0.05,
    structuralWeight: 0.05,
    dependencyWeight: 0.08,
    referenceWeight: 0.08,
    testWeight: 0.03,
    recencyWeight: 0.02,
    maxChunksPerFile: 4,
    maxChunksPerSymbol: 2
  },
  retrieval: {
    seedResults: 8,
    maxExpansionHops: 2,
    maxContextChunks: 20,
    maxContextTokens: 12_000,
    confidenceThreshold: 0.15,
    retrievalRequired: true,
    allowFallbackAfterFailedRetrieval: true
  },
  benchmark: {
    maxTokenRegressionPercent: 10,
    minPrecisionAt5: 0.75,
    minRecallAt10: 0.8,
    maxP95LatencyMs: 1000
  },
  security: {
    allowSensitiveFiles: false
  },
  ignore: []
};
