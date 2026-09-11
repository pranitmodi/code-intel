import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { load as parseYaml } from 'js-yaml';
import {
  resolveCorporateCredentials,
  resolveCorporateSettings,
  resolveEmbeddingRoute,
  resolveOllamaSettings,
  writeCorporateConfig,
  writeOllamaConfig
} from '../../src/corporate/setup.js';
import {
  cursorSystemCaEnv,
  systemCaAlreadyEnabled,
  systemCaChildEnv
} from '../../src/corporate/systemCa.js';

describe('corporate setup', () => {
  let repoRoot: string;

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  });

  it('uses supplied values and prompts only for missing required settings', async () => {
    const questions: string[] = [];
    const settings = await resolveCorporateSettings(
      { model: 'company-model', batchSize: 12, timeoutMs: 5_000 },
      async (question, fallback) => {
        questions.push(question);
        return question === 'Embedding API base URL' ? 'https://proxy.example/v1' : (fallback ?? '');
      }
    );

    expect(questions).toEqual(['Embedding API base URL', 'Embeddings path']);
    expect(settings).toEqual({
      model: 'company-model',
      baseUrl: 'https://proxy.example/v1',
      embeddingsPath: '/embeddings',
      batchSize: 12,
      timeoutMs: 5_000
    });
  });

  it('keeps prompt defaults when the answer is empty or a bare confirmation', async () => {
    const settings = await resolveCorporateSettings(
      { baseUrl: 'https://proxy.example' },
      async (question) => (question === 'Embedding model' ? 'y' : '')
    );

    expect(settings.model).toBe('Qwen3-Embedding-8B');
    expect(settings.embeddingsPath).toBe('/embeddings');
  });

  it('offers saved values as editable defaults and ignores unusable ones', async () => {
    const asked: string[] = [];
    const settings = await resolveCorporateSettings(
      { defaults: { model: 'y', baseUrl: 'https://saved.example', embeddingsPath: '/' } },
      async (question, fallback) => {
        asked.push(`${question}|${fallback ?? ''}`);
        return '';
      }
    );

    expect(asked).toEqual([
      'Embedding model|Qwen3-Embedding-8B',
      'Embedding API base URL|https://saved.example',
      'Embeddings path|/embeddings'
    ]);
    expect(settings).toMatchObject({
      model: 'Qwen3-Embedding-8B',
      baseUrl: 'https://saved.example',
      embeddingsPath: '/embeddings'
    });
  });

  it('rejects an embeddings path that is pasted prose or YAML', async () => {
    await expect(
      resolveCorporateSettings(
        { baseUrl: 'https://proxy.example', embeddingsPath: 'embeddings_path: /embeddings' },
        undefined
      )
    ).rejects.toThrow(/URL path/);
  });

  it('asks Ollama vs company proxy, then collects credentials only for the proxy route', async () => {
    expect(await resolveEmbeddingRoute('ollama', undefined)).toBe('ollama');
    expect(await resolveEmbeddingRoute(undefined, async () => 'n')).toBe('openai-compatible');

    const questions: string[] = [];
    const credentials = await resolveCorporateCredentials({}, async (question) => {
      questions.push(question);
      return question.startsWith('API key') ? 'secret-from-prompt' : 'pranitm';
    });
    expect(questions[0]).toMatch(/API key/);
    expect(credentials).toEqual({ apiKey: 'secret-from-prompt', user: 'pranitm' });
  });

  it('writes an Ollama config without credentials', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-ollama-'));
    const configPath = writeOllamaConfig(repoRoot, {
      model: 'nomic-embed-text',
      host: 'http://127.0.0.1:11434'
    });
    const parsed = parseYaml(await readFile(configPath, 'utf8')) as { embedding: Record<string, unknown> };
    expect(parsed.embedding.provider).toBe('ollama');
    expect(parsed.embedding).not.toHaveProperty('api_key');
    expect(parsed.embedding).not.toHaveProperty('user');
  });

  it('merges repo YAML while never persisting credentials or user identity', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-corporate-'));
    await mkdir(join(repoRoot, '.code-intel'));
    await writeFile(
      join(repoRoot, '.code-intel', 'config.yaml'),
      [
        'embedding:',
        '  api_key: must-be-removed',
        '  user: must-be-removed',
        'search:',
        '  default_limit: 7'
      ].join('\n')
    );

    const configPath = writeCorporateConfig(repoRoot, {
      model: 'Qwen3-Embedding-8B',
      baseUrl: 'https://proxy.example',
      embeddingsPath: '/embeddings',
      batchSize: 32,
      timeoutMs: 60_000
    });
    const raw = await readFile(configPath, 'utf8');
    const parsed = parseYaml(raw) as {
      embedding: Record<string, unknown>;
      search: { default_limit: number };
    };

    expect(raw).not.toContain('must-be-removed');
    expect(parsed.embedding).toEqual({
      provider: 'openai-compatible',
      model: 'Qwen3-Embedding-8B',
      base_url: 'https://proxy.example',
      embeddings_path: '/embeddings',
      batch_size: 32,
      timeout_ms: 60_000,
      use_system_ca: true
    });
    expect(parsed.search.default_limit).toBe(7);
  });

  it('uses Ollama defaults without prompting and requires a key for the proxy route', async () => {
    await expect(resolveOllamaSettings({}, undefined)).resolves.toEqual({
      model: 'nomic-embed-text',
      host: 'http://127.0.0.1:11434'
    });
    await expect(resolveCorporateCredentials({}, undefined)).rejects.toThrow(
      'API key (not saved to disk) is required'
    );
  });
});

describe('corporate system CA', () => {
  it('builds a secure child environment and removes the insecure bypass', () => {
    const env = systemCaChildEnv({
      PATH: '/bin',
      NODE_OPTIONS: '--max-old-space-size=2048',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    });

    expect(env.NODE_USE_SYSTEM_CA).toBe('1');
    expect(env.NODE_OPTIONS).toContain('--use-system-ca');
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=2048');
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(systemCaAlreadyEnabled(env)).toBe(true);
  });

  it('generates the MCP environment without dropping existing Node options', () => {
    expect(cursorSystemCaEnv('--enable-source-maps')).toEqual({
      NODE_USE_SYSTEM_CA: '1',
      NODE_OPTIONS: '--enable-source-maps --use-system-ca'
    });
  });
});
