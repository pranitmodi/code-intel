import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { createEmbeddingProvider } from '../../src/embeddings/createEmbeddingProvider.js';
import { OllamaEmbeddingProvider } from '../../src/embeddings/OllamaEmbeddingProvider.js';
import { OpenAICompatibleEmbeddingProvider } from '../../src/embeddings/OpenAICompatibleEmbeddingProvider.js';

const ENV_KEYS = [
  'CODE_INTEL_EMBEDDING_PROVIDER',
  'CODE_INTEL_EMBEDDING_MODEL',
  'CODE_INTEL_EMBEDDING_HOST',
  'CODE_INTEL_EMBEDDING_BASE_URL',
  'CODE_INTEL_EMBEDDING_API_KEY',
  'CODE_INTEL_EMBEDDING_USER',
  'CODE_INTEL_DB_PATH'
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe('embedding configuration', () => {
  let repoRoot: string;

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('loads an OpenAI-compatible provider while keeping credentials environment-only', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-config-'));
    await mkdir(join(repoRoot, '.code-intel'));
    await writeFile(
      join(repoRoot, '.code-intel', 'config.yaml'),
      [
        'embedding:',
        '  provider: openai-compatible',
        '  model: Qwen3-Embedding-8B',
        '  base_url: https://proxy.example',
        '  batch_size: 8',
        '  api_key: must-not-load'
      ].join('\n')
    );
    process.env.CODE_INTEL_EMBEDDING_API_KEY = 'key-from-env';
    process.env.CODE_INTEL_EMBEDDING_USER = 'user-from-env';

    expect(loadConfig({ repoRoot }).embedding).toEqual({
      provider: 'openai-compatible',
      model: 'Qwen3-Embedding-8B',
      host: 'http://127.0.0.1:11434',
      baseUrl: 'https://proxy.example',
      embeddingsPath: '/embeddings',
      batchSize: 8,
      timeoutMs: 60_000,
      useSystemCa: false,
      apiKey: 'key-from-env',
      user: 'user-from-env'
    });
  });

  it('allows environment overrides and rejects unknown providers', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-config-'));
    process.env.CODE_INTEL_EMBEDDING_PROVIDER = 'openai-compatible';
    process.env.CODE_INTEL_EMBEDDING_MODEL = 'Qwen3-Embedding-8B';
    process.env.CODE_INTEL_EMBEDDING_BASE_URL = 'https://proxy.example';

    const config = loadConfig({ repoRoot });
    expect(config.embedding.provider).toBe('openai-compatible');
    expect(config.embedding.model).toBe('Qwen3-Embedding-8B');
    expect(config.embedding.baseUrl).toBe('https://proxy.example');
    process.env.CODE_INTEL_EMBEDDING_API_KEY = 'key';
    process.env.CODE_INTEL_EMBEDDING_USER = 'user';
    expect(createEmbeddingProvider(loadConfig({ repoRoot }).embedding)).toBeInstanceOf(
      OpenAICompatibleEmbeddingProvider
    );

    process.env.CODE_INTEL_EMBEDDING_PROVIDER = 'unknown';
    expect(() => loadConfig({ repoRoot })).toThrow('Unsupported embedding provider');
  });

  it('lets YAML, env, and CLI overrides customize the endpoint and model', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-config-'));
    await mkdir(join(repoRoot, '.code-intel'));
    await writeFile(
      join(repoRoot, '.code-intel', 'config.yaml'),
      [
        'embedding:',
        '  provider: openai-compatible',
        '  model: text-embedding-3-small',
        '  base_url: https://api.example.com/v1',
        '  embeddings_path: /embeddings',
        '  timeout_ms: 15000'
      ].join('\n')
    );
    process.env.CODE_INTEL_EMBEDDING_MODEL = 'env-model';

    const fromEnv = loadConfig({ repoRoot });
    expect(fromEnv.embedding.model).toBe('env-model');
    expect(fromEnv.embedding.baseUrl).toBe('https://api.example.com/v1');
    expect(fromEnv.embedding.embeddingsPath).toBe('/embeddings');
    expect(fromEnv.embedding.timeoutMs).toBe(15_000);

    const fromCli = loadConfig({
      repoRoot,
      overrides: { model: 'cli-model', baseUrl: 'https://other.example/v1', embeddingsPath: '/v1/embeddings' }
    });
    expect(fromCli.embedding.model).toBe('cli-model');
    expect(fromCli.embedding.baseUrl).toBe('https://other.example/v1');
    expect(fromCli.embedding.embeddingsPath).toBe('/v1/embeddings');
  });

  it('keeps Ollama as the default provider', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-config-'));
    expect(createEmbeddingProvider(loadConfig({ repoRoot }).embedding)).toBeInstanceOf(
      OllamaEmbeddingProvider
    );
  });
});
