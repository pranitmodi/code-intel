export type EmbeddingProviderName = 'ollama' | 'openai-compatible';

export interface EmbeddingConfig {
  provider: EmbeddingProviderName;
  model: string;
  /** Ollama host, used when provider is `ollama`. */
  host: string;
  /** OpenAI-compatible API origin or full embeddings URL. */
  baseUrl: string;
  /** Path appended to `baseUrl` unless `baseUrl` already ends with `/embeddings`. */
  embeddingsPath: string;
  batchSize: number;
  timeoutMs: number;
  /** Use trusted certificates from the operating system store for corporate TLS. */
  useSystemCa: boolean;
  /** Loaded from the environment only; never read from YAML. */
  apiKey?: string;
  /** Optional identity field some proxies require; environment only. */
  user?: string;
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
  /** Max files to parse/embed at once. LanceDB writes stay serialized. */
  concurrency: number;
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
    base_url: string;
    embeddings_path: string;
    batch_size: number;
    timeout_ms: number;
    use_system_ca: boolean;
  }>;
  database?: Partial<{
    path: string;
  }>;
  indexing?: Partial<{
    max_chunk_tokens: number;
    chunk_overlap: number;
    debounce_ms: number;
    watch: boolean;
    concurrency: number;
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
