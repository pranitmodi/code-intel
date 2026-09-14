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
    symbolWeight: 0.1
  },
  security: {
    allowSensitiveFiles: false
  },
  ignore: []
};
