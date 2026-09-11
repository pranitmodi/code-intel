import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { DEFAULT_CONFIG } from './defaults.js';
import type { CodeIntelConfig, EmbeddingProviderName, RawConfigFile } from './types.js';

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function readConfigFile(path: string): RawConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object') return undefined;
  return parsed as RawConfigFile;
}

function parseEmbeddingProvider(value: string | undefined, fallback: EmbeddingProviderName): EmbeddingProviderName {
  if (value === undefined) return fallback;
  if (value === 'ollama' || value === 'openai-compatible') return value;
  throw new Error(
    `Unsupported embedding provider "${value}". Expected "ollama" or "openai-compatible".`
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${value}".`);
  }
  return parsed;
}

export interface EmbeddingConfigOverrides {
  provider?: string;
  model?: string;
  host?: string;
  baseUrl?: string;
  embeddingsPath?: string;
  batchSize?: number;
  timeoutMs?: number;
}

function applyRawConfig(base: CodeIntelConfig, raw: RawConfigFile | undefined): CodeIntelConfig {
  if (!raw) return base;
  return {
    embedding: {
      provider: parseEmbeddingProvider(raw.embedding?.provider, base.embedding.provider),
      model: raw.embedding?.model ?? base.embedding.model,
      host: raw.embedding?.host ?? base.embedding.host,
      baseUrl: raw.embedding?.base_url ?? base.embedding.baseUrl,
      embeddingsPath: raw.embedding?.embeddings_path ?? base.embedding.embeddingsPath,
      batchSize: raw.embedding?.batch_size ?? base.embedding.batchSize,
      timeoutMs: raw.embedding?.timeout_ms ?? base.embedding.timeoutMs,
      useSystemCa: raw.embedding?.use_system_ca ?? base.embedding.useSystemCa,
      apiKey: base.embedding.apiKey,
      user: base.embedding.user
    },
    database: {
      path: raw.database?.path ?? base.database.path
    },
    indexing: {
      maxChunkTokens: raw.indexing?.max_chunk_tokens ?? base.indexing.maxChunkTokens,
      chunkOverlap: raw.indexing?.chunk_overlap ?? base.indexing.chunkOverlap,
      debounceMs: raw.indexing?.debounce_ms ?? base.indexing.debounceMs,
      watch: raw.indexing?.watch ?? base.indexing.watch
    },
    search: {
      defaultLimit: raw.search?.default_limit ?? base.search.defaultLimit,
      vectorWeight: raw.search?.vector_weight ?? base.search.vectorWeight,
      keywordWeight: raw.search?.keyword_weight ?? base.search.keywordWeight,
      symbolWeight: raw.search?.symbol_weight ?? base.search.symbolWeight
    },
    security: {
      allowSensitiveFiles: raw.security?.allow_sensitive_files ?? base.security.allowSensitiveFiles
    },
    ignore: [...base.ignore, ...(raw.ignore ?? [])]
  };
}

function parseWatchEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  return undefined;
}

function applyEnvOverrides(config: CodeIntelConfig): CodeIntelConfig {
  const env = process.env;
  const watch = parseWatchEnv(env.CODE_INTEL_WATCH);
  const useSystemCa = parseWatchEnv(env.CODE_INTEL_USE_SYSTEM_CA);
  return {
    ...config,
    embedding: {
      ...config.embedding,
      provider: parseEmbeddingProvider(env.CODE_INTEL_EMBEDDING_PROVIDER, config.embedding.provider),
      model: env.CODE_INTEL_EMBEDDING_MODEL ?? config.embedding.model,
      host: env.CODE_INTEL_EMBEDDING_HOST ?? config.embedding.host,
      baseUrl: env.CODE_INTEL_EMBEDDING_BASE_URL ?? config.embedding.baseUrl,
      embeddingsPath: env.CODE_INTEL_EMBEDDING_PATH ?? config.embedding.embeddingsPath,
      batchSize: env.CODE_INTEL_EMBEDDING_BATCH_SIZE
        ? parsePositiveInt(env.CODE_INTEL_EMBEDDING_BATCH_SIZE, config.embedding.batchSize)
        : config.embedding.batchSize,
      timeoutMs: env.CODE_INTEL_EMBEDDING_TIMEOUT_MS
        ? parsePositiveInt(env.CODE_INTEL_EMBEDDING_TIMEOUT_MS, config.embedding.timeoutMs)
        : config.embedding.timeoutMs,
      useSystemCa: useSystemCa ?? config.embedding.useSystemCa,
      apiKey: env.CODE_INTEL_EMBEDDING_API_KEY,
      user: env.CODE_INTEL_EMBEDDING_USER
    },
    database: {
      ...config.database,
      path: env.CODE_INTEL_DB_PATH ?? config.database.path
    },
    indexing: {
      ...config.indexing,
      ...(watch !== undefined ? { watch } : {})
    }
  };
}

export interface LoadConfigOptions {
  /** Absolute path to the repository root whose `.code-intel/config.yaml` should be applied. */
  repoRoot?: string;
  /** CLI flags; applied last so they win over files and environment variables. */
  overrides?: EmbeddingConfigOverrides;
}

function applyOverrides(config: CodeIntelConfig, overrides: EmbeddingConfigOverrides | undefined): CodeIntelConfig {
  if (!overrides) return config;
  return {
    ...config,
    embedding: {
      ...config.embedding,
      provider: parseEmbeddingProvider(overrides.provider, config.embedding.provider),
      model: overrides.model ?? config.embedding.model,
      host: overrides.host ?? config.embedding.host,
      baseUrl: overrides.baseUrl ?? config.embedding.baseUrl,
      embeddingsPath: overrides.embeddingsPath ?? config.embedding.embeddingsPath,
      batchSize: overrides.batchSize ?? config.embedding.batchSize,
      timeoutMs: overrides.timeoutMs ?? config.embedding.timeoutMs
    }
  };
}

/**
 * Merge order (later wins): built-in defaults -> global `~/.local-code-intelligence/config.yaml`
 * -> repo-level `<repoRoot>/.code-intel/config.yaml` -> environment variables -> CLI overrides.
 */
export function loadConfig(options: LoadConfigOptions = {}): CodeIntelConfig {
  let config = DEFAULT_CONFIG;

  const globalConfigPath = join(expandHome(DEFAULT_CONFIG.database.path), 'config.yaml');
  config = applyRawConfig(config, readConfigFile(globalConfigPath));

  if (options.repoRoot) {
    const repoConfigPath = join(options.repoRoot, '.code-intel', 'config.yaml');
    config = applyRawConfig(config, readConfigFile(repoConfigPath));
  }

  config = applyEnvOverrides(config);
  config = applyOverrides(config, options.overrides);
  config = {
    ...config,
    database: { ...config.database, path: expandHome(config.database.path) }
  };

  return config;
}
