import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump as dumpYaml, load as parseYaml } from 'js-yaml';

export interface CorporateEmbeddingSettings {
  model: string;
  baseUrl: string;
  embeddingsPath: string;
  batchSize: number;
  timeoutMs: number;
}

export interface CorporateSetupInput {
  model?: string;
  baseUrl?: string;
  embeddingsPath?: string;
  batchSize?: number;
  timeoutMs?: number;
  /** Previously saved values, offered as editable prompt defaults rather than final answers. */
  defaults?: Pick<CorporateSetupInput, 'model' | 'baseUrl' | 'embeddingsPath'>;
}

export interface OllamaSetupInput {
  model?: string;
  host?: string;
  defaults?: { model?: string; host?: string };
}

export interface CredentialInput {
  apiKey?: string;
  user?: string;
}

export interface SetupCredentials {
  apiKey: string;
  user?: string;
}

export type EmbeddingRoute = 'ollama' | 'openai-compatible';

export type CorporatePrompt = (question: string, fallback?: string) => Promise<string>;

export async function resolveCorporateSettings(
  input: CorporateSetupInput,
  prompt: CorporatePrompt | undefined
): Promise<CorporateEmbeddingSettings> {
  const model = await requiredValue(
    input.model,
    'Embedding model',
    usableDefault(input.defaults?.model) ?? 'Qwen3-Embedding-8B',
    prompt
  );
  const baseUrl = await requiredValue(
    input.baseUrl,
    'Embedding API base URL',
    usableDefault(input.defaults?.baseUrl),
    prompt
  );
  const embeddingsPath = await requiredValue(
    assertEmbeddingsPath(normalizeEmbeddingsPath(input.embeddingsPath)),
    'Embeddings path',
    usablePathDefault(input.defaults?.embeddingsPath) ?? '/embeddings',
    prompt
  );

  return {
    model,
    baseUrl,
    embeddingsPath: assertEmbeddingsPath(normalizeEmbeddingsPath(embeddingsPath)) ?? '/embeddings',
    batchSize: positiveInteger(input.batchSize ?? 32, 'batch size'),
    timeoutMs: positiveInteger(input.timeoutMs ?? 60_000, 'timeout')
  };
}

/**
 * Drops saved values that can only have come from mis-answering a prompt, so a
 * bad answer is not silently reused on the next run.
 */
function usableDefault(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return ['y', 'yes', 'n', 'no'].includes(trimmed.toLowerCase()) ? undefined : trimmed;
}

/** Returns undefined for values that cannot address an embeddings endpoint, such as "" or "/". */
function normalizeEmbeddingsPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

const EMBEDDINGS_PATH_PATTERN = /^\/[A-Za-z0-9\-._~%/]*$/;

/** Rejects answers that are prose or pasted YAML rather than a URL path. */
function assertEmbeddingsPath(path: string | undefined): string | undefined {
  if (path === undefined || EMBEDDINGS_PATH_PATTERN.test(path)) return path;
  throw new Error(`Embeddings path must be a URL path such as /embeddings, got "${path}".`);
}

function usablePathDefault(value: string | undefined): string | undefined {
  const normalized = normalizeEmbeddingsPath(value);
  return normalized && EMBEDDINGS_PATH_PATTERN.test(normalized) ? normalized : undefined;
}

async function requiredValue(
  value: string | undefined,
  label: string,
  fallback: string | undefined,
  prompt: CorporatePrompt | undefined
): Promise<string> {
  const supplied = value?.trim();
  if (supplied) return supplied;
  if (!prompt) {
    if (fallback) return fallback;
    throw new Error(
      `${label} is required in non-interactive mode. Set the matching CODE_INTEL_EMBEDDING_* variable or command option.`
    );
  }
  const answer = (await prompt(label, fallback)).trim();
  // A bare yes/no here means the user is confirming the shown default, not naming a value.
  const confirmedDefault = fallback && ['y', 'yes', 'n', 'no'].includes(answer.toLowerCase());
  const resolved = !answer || confirmedDefault ? fallback : answer;
  if (!resolved) throw new Error(`${label} is required.`);
  return resolved;
}

export function parseYesNo(value: string | undefined, defaultYes: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultYes;
  if (['y', 'yes', 'true', '1'].includes(normalized)) return true;
  if (['n', 'no', 'false', '0'].includes(normalized)) return false;
  throw new Error(`Expected yes or no, got "${value}".`);
}

export function parseEmbeddingRoute(value: string | undefined): EmbeddingRoute | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'ollama' || normalized === 'local') return 'ollama';
  if (
    normalized === 'openai-compatible' ||
    normalized === 'openai' ||
    normalized === 'corporate' ||
    normalized === 'proxy'
  ) {
    return 'openai-compatible';
  }
  throw new Error('Embedding route must be "ollama" or "openai-compatible".');
}

export async function resolveEmbeddingRoute(
  input: string | undefined,
  prompt: CorporatePrompt | undefined,
  defaultRoute: EmbeddingRoute = 'ollama'
): Promise<EmbeddingRoute> {
  const fromInput = parseEmbeddingRoute(input);
  if (fromInput) return fromInput;
  if (!prompt) return defaultRoute;
  const answer = await prompt(
    'Use local Ollama embeddings? (yes = Ollama, no = company OpenAI-compatible proxy)',
    defaultRoute === 'ollama' ? 'yes' : 'no'
  );
  return parseYesNo(answer, defaultRoute === 'ollama') ? 'ollama' : 'openai-compatible';
}

export async function resolveOllamaSettings(
  input: OllamaSetupInput,
  prompt: CorporatePrompt | undefined
): Promise<{ model: string; host: string }> {
  const model = await requiredValue(
    input.model,
    'Ollama embedding model',
    usableDefault(input.defaults?.model) ?? 'nomic-embed-text',
    prompt
  );
  const host = await requiredValue(
    input.host,
    'Ollama host',
    usableDefault(input.defaults?.host) ?? 'http://127.0.0.1:11434',
    prompt
  );
  return { model, host };
}

export async function resolveCorporateCredentials(
  input: CredentialInput,
  prompt: CorporatePrompt | undefined,
  secretPrompt: CorporatePrompt | undefined = prompt
): Promise<SetupCredentials> {
  const apiKey = await requiredValue(
    input.apiKey,
    'API key (not saved to disk)',
    undefined,
    secretPrompt ?? prompt
  );
  const user =
    input.user?.trim() ||
    (prompt ? (await prompt('Proxy username (optional; some companies require this)')).trim() : '');
  return user ? { apiKey, user } : { apiKey };
}

export function applyCredentialsToEnv(credentials: SetupCredentials, env: NodeJS.ProcessEnv = process.env): void {
  env.CODE_INTEL_EMBEDDING_API_KEY = credentials.apiKey;
  if (credentials.user) env.CODE_INTEL_EMBEDDING_USER = credentials.user;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Corporate embedding ${label} must be a positive integer.`);
  }
  return value;
}

function writeRepoEmbeddingConfig(repoRoot: string, embeddingPatch: Record<string, unknown>): string {
  const configDir = join(repoRoot, '.code-intel');
  const configPath = join(configDir, 'config.yaml');
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed = parseYaml(readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  }

  const previousEmbedding =
    existing.embedding && typeof existing.embedding === 'object' && !Array.isArray(existing.embedding)
      ? (existing.embedding as Record<string, unknown>)
      : {};
  const embedding: Record<string, unknown> = {
    ...previousEmbedding,
    ...embeddingPatch
  };
  delete embedding.api_key;
  delete embedding.apiKey;
  delete embedding.user;

  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    dumpYaml({ ...existing, embedding }, { noRefs: true, lineWidth: 120, sortKeys: false }),
    { mode: 0o644 }
  );
  return configPath;
}

export function writeOllamaConfig(repoRoot: string, settings: { model: string; host: string }): string {
  return writeRepoEmbeddingConfig(repoRoot, {
    provider: 'ollama',
    model: settings.model,
    host: settings.host,
    use_system_ca: false
  });
}

/**
 * Merge corporate embedding settings into the repo config. Credentials and
 * user identity deliberately remain environment-only.
 */
export function writeCorporateConfig(repoRoot: string, settings: CorporateEmbeddingSettings): string {
  return writeRepoEmbeddingConfig(repoRoot, {
    provider: 'openai-compatible',
    model: settings.model,
    base_url: settings.baseUrl,
    embeddings_path: settings.embeddingsPath,
    batch_size: settings.batchSize,
    timeout_ms: settings.timeoutMs,
    use_system_ca: true
  });
}
