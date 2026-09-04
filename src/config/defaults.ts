import type { CodeIntelConfig } from './types.js';

export const DEFAULT_CONFIG: CodeIntelConfig = {
  embedding: {
    provider: 'ollama',
    model: 'nomic-embed-text',
    host: 'http://127.0.0.1:11434',
    batchSize: 32
  },
  database: {
    path: '~/.local-code-intelligence'
  },
  indexing: {
    maxChunkTokens: 800,
    chunkOverlap: 100,
    debounceMs: 1000
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
