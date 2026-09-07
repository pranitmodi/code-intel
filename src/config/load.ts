import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { DEFAULT_CONFIG } from './defaults.js';
import type { CodeIntelConfig, RawConfigFile } from './types.js';

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

function applyRawConfig(base: CodeIntelConfig, raw: RawConfigFile | undefined): CodeIntelConfig {
  if (!raw) return base;
  return {
    embedding: {
      provider: 'ollama',
      model: raw.embedding?.model ?? base.embedding.model,
      host: raw.embedding?.host ?? base.embedding.host,
      batchSize: raw.embedding?.batch_size ?? base.embedding.batchSize
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
  return {
    ...config,
    embedding: {
      ...config.embedding,
      model: env.CODE_INTEL_EMBEDDING_MODEL ?? config.embedding.model,
      host: env.CODE_INTEL_EMBEDDING_HOST ?? config.embedding.host
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
}

/**
 * Merge order (later wins): built-in defaults -> global `~/.local-code-intelligence/config.yaml`
 * -> repo-level `<repoRoot>/.code-intel/config.yaml` -> environment variables.
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
  config = {
    ...config,
    database: { ...config.database, path: expandHome(config.database.path) }
  };

  return config;
}
