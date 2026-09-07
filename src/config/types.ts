export interface EmbeddingConfig {
  provider: 'ollama';
  model: string;
  host: string;
  batchSize: number;
}

export interface DatabaseConfig {
  /** Directory that holds `repos/<repo-id>/{db,metadata,state.json,logs}`. Supports a leading `~`. */
  path: string;
}

export interface IndexingConfig {
  maxChunkTokens: number;
  chunkOverlap: number;
  debounceMs: number;
  /** When true, `code-intel mcp` starts incremental file watchers for indexed repos under the workspace. */
  watch: boolean;
}

export interface SearchConfig {
  defaultLimit: number;
  vectorWeight: number;
  keywordWeight: number;
  symbolWeight: number;
}

export interface SecurityConfig {
  allowSensitiveFiles: boolean;
}

export interface CodeIntelConfig {
  embedding: EmbeddingConfig;
  database: DatabaseConfig;
  indexing: IndexingConfig;
  search: SearchConfig;
  security: SecurityConfig;
  /** Additional user-provided ignore patterns, on top of the built-in defaults. */
  ignore: string[];
}

/** Shape accepted from YAML config files — snake_case, all fields optional (deep partial). */
export interface RawConfigFile {
  embedding?: Partial<{
    provider: string;
    model: string;
    host: string;
    batch_size: number;
  }>;
  database?: Partial<{
    path: string;
  }>;
  indexing?: Partial<{
    max_chunk_tokens: number;
    chunk_overlap: number;
    debounce_ms: number;
    watch: boolean;
  }>;
  search?: Partial<{
    default_limit: number;
    vector_weight: number;
    keyword_weight: number;
    symbol_weight: number;
  }>;
  security?: Partial<{
    allow_sensitive_files: boolean;
  }>;
  ignore?: string[];
}
