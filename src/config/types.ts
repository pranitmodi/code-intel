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
  pathWeight: number;
  structuralWeight: number;
  dependencyWeight: number;
  referenceWeight: number;
  testWeight: number;
  recencyWeight: number;
  maxChunksPerFile: number;
  maxChunksPerSymbol: number;
}

export interface RetrievalConfig {
  seedResults: number;
  maxExpansionHops: number;
  maxContextChunks: number;
  maxContextTokens: number;
  confidenceThreshold: number;
  retrievalRequired: boolean;
  allowFallbackAfterFailedRetrieval: boolean;
}

export interface BenchmarkConfig {
  maxTokenRegressionPercent: number;
  minPrecisionAt5: number;
  minRecallAt10: number;
  maxP95LatencyMs: number;
}

export interface SecurityConfig {
  allowSensitiveFiles: boolean;
}

export interface CodeIntelConfig {
  embedding: EmbeddingConfig;
  database: DatabaseConfig;
  indexing: IndexingConfig;
  search: SearchConfig;
  retrieval: RetrievalConfig;
  benchmark: BenchmarkConfig;
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
    path_weight: number;
    structural_weight: number;
    dependency_weight: number;
    reference_weight: number;
    test_weight: number;
    recency_weight: number;
    max_chunks_per_file: number;
    max_chunks_per_symbol: number;
  }>;
  retrieval?: Partial<{
    seed_results: number;
    max_expansion_hops: number;
    max_context_chunks: number;
    max_context_tokens: number;
    confidence_threshold: number;
    retrieval_required: boolean;
    allow_fallback_after_failed_retrieval: boolean;
  }>;
  benchmark?: Partial<{
    max_token_regression_percent: number;
    min_precision_at_5: number;
    min_recall_at_10: number;
    max_p95_latency_ms: number;
  }>;
  security?: Partial<{
    allow_sensitive_files: boolean;
  }>;
  ignore?: string[];
}
