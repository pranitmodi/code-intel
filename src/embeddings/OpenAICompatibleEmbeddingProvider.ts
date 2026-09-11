import { createLogger } from '../utils/logger.js';
import type { EmbeddingProvider } from './EmbeddingProvider.js';

const logger = createLogger('embeddings:openai-compatible');

export class EmbeddingConfigurationError extends Error {}

export type EmbeddingFailureKind = 'input-too-large';

export class OpenAICompatibleEmbeddingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Transport failures and transient proxy statuses are worth another attempt. */
    readonly retriable = false,
    readonly kind?: EmbeddingFailureKind
  ) {
    super(message);
  }
}

export function isEmbeddingInputTooLargeError(error: unknown): boolean {
  return error instanceof OpenAICompatibleEmbeddingError && error.kind === 'input-too-large';
}

/** 408/425/429 and 5xx are transient on a shared LLM proxy; 4xx otherwise means a bad request. */
function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export interface OpenAICompatibleEmbeddingProviderOptions {
  baseUrl: string;
  apiKey: string;
  user?: string;
  model: string;
  embeddingsPath?: string;
  timeoutMs?: number;
  batchSize?: number;
  maxRetries?: number;
  dimensions?: number;
  fetch?: typeof fetch;
  retryBaseDelayMs?: number;
}

export function resolveEmbeddingsEndpoint(baseUrl: string, embeddingsPath = '/embeddings'): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new EmbeddingConfigurationError(
      'embedding.base_url is required for provider "openai-compatible". Set it in config.yaml, CODE_INTEL_EMBEDDING_BASE_URL, or --embedding-base-url.'
    );
  }
  if (/\/embeddings$/i.test(trimmed)) return trimmed;
  const path = embeddingsPath.startsWith('/') ? embeddingsPath : `/${embeddingsPath}`;
  return `${trimmed}${path}`;
}

interface EmbeddingDatum {
  embedding: number[];
  index: number;
}

function formatFetchFailure(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current instanceof Error) {
      const code = 'code' in current && typeof current.code === 'string' ? current.code : undefined;
      parts.push(code ? `${current.message} (${code})` : current.message);
      current = current.cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return parts.filter((part, index, all) => all.indexOf(part) === index).join(' — ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseMessage(status: number, statusText: string, body: string, apiKey: string): string {
  const detail = body.replaceAll(apiKey, '[REDACTED]').trim().slice(0, 500);
  if (status === 401 || status === 403) {
    return `Embedding proxy rejected the credentials (${status} ${statusText}). Check CODE_INTEL_EMBEDDING_API_KEY (and CODE_INTEL_EMBEDDING_USER if your endpoint requires it).`;
  }
  if (status === 404) {
    return `Embedding endpoint or model was not found (404). Check embedding.base_url and embedding.model.`;
  }
  return `Embedding request failed (${status} ${statusText})${detail ? `: ${detail}` : ''}`;
}

function responseFailureKind(status: number, body: string): EmbeddingFailureKind | undefined {
  if (
    status === 400 &&
    /ContextWindowExceeded|maximum context length|input[_ ]tokens/i.test(body)
  ) {
    return 'input-too-large';
  }
  return undefined;
}

function parseEmbeddingResponse(value: unknown, expectedCount: number): number[][] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) {
    throw new OpenAICompatibleEmbeddingError('Embedding proxy returned an invalid response: expected a data array.');
  }

  const data = (value as { data: unknown[] }).data;
  if (data.length !== expectedCount) {
    throw new OpenAICompatibleEmbeddingError(
      `Embedding proxy returned ${data.length} vectors for ${expectedCount} inputs.`
    );
  }

  const parsed = data.map((item, fallbackIndex): EmbeddingDatum => {
    if (!item || typeof item !== 'object') {
      throw new OpenAICompatibleEmbeddingError('Embedding proxy returned an invalid data item.');
    }
    const { embedding, index } = item as { embedding?: unknown; index?: unknown };
    const resolvedIndex = typeof index === 'number' && Number.isInteger(index) ? index : fallbackIndex;
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      !embedding.every((number) => typeof number === 'number' && Number.isFinite(number))
    ) {
      throw new OpenAICompatibleEmbeddingError('Embedding proxy returned an invalid embedding vector.');
    }
    return { embedding, index: resolvedIndex };
  });

  parsed.sort((left, right) => left.index - right.index);
  if (parsed.some((item, index) => item.index !== index)) {
    throw new OpenAICompatibleEmbeddingError('Embedding proxy returned duplicate or out-of-range indices.');
  }

  const dimensions = parsed[0]?.embedding.length;
  if (!dimensions || parsed.some((item) => item.embedding.length !== dimensions)) {
    throw new OpenAICompatibleEmbeddingError('Embedding proxy returned vectors with inconsistent dimensions.');
  }
  return parsed.map((item) => item.embedding);
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly user: string | undefined;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBaseDelayMs: number;
  private cachedDimensions: number | undefined;

  constructor(options: OpenAICompatibleEmbeddingProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new EmbeddingConfigurationError(
        'CODE_INTEL_EMBEDDING_API_KEY is required for provider "openai-compatible".'
      );
    }

    this.endpoint = resolveEmbeddingsEndpoint(options.baseUrl, options.embeddingsPath);
    this.apiKey = options.apiKey;
    this.user = options.user?.trim() || undefined;
    this.model = options.model;
    this.batchSize = options.batchSize ?? 32;
    this.maxRetries = options.maxRetries ?? 4;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.cachedDimensions = options.dimensions;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
  }

  modelName(): string {
    return this.model;
  }

  async dimensions(): Promise<number> {
    if (this.cachedDimensions !== undefined) return this.cachedDimensions;
    const [vector] = await this.embedBatchWithRetry(['dimension probe']);
    if (!vector) throw new OpenAICompatibleEmbeddingError('Embedding proxy returned no dimension probe vector.');
    this.cachedDimensions = vector.length;
    return this.cachedDimensions;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    if (!vector) throw new OpenAICompatibleEmbeddingError('Embedding proxy returned no vector.');
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const results: number[][] = [];
    for (let index = 0; index < texts.length; index += this.batchSize) {
      results.push(...(await this.embedBatchWithRetry(texts.slice(index, index + this.batchSize))));
    }
    return results;
  }

  private async embedBatchWithRetry(batch: string[]): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.embedBatchOnce(batch);
      } catch (error) {
        lastError = error;
        const retriable =
          !(error instanceof OpenAICompatibleEmbeddingError) ||
          error.retriable ||
          (error.status !== undefined && isRetriableStatus(error.status));
        if (!retriable || attempt === this.maxRetries) break;
        logger.warn(`Embedding batch failed (attempt ${attempt + 1}/${this.maxRetries + 1})`, {
          error: error instanceof Error ? error.message : String(error)
        });
        await sleep(this.retryBaseDelayMs * 2 ** attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new OpenAICompatibleEmbeddingError(String(lastError));
  }

  private async embedBatchOnce(batch: string[]): Promise<number[][]> {
    let response: Response;
    try {
      const payload: { model: string; input: string[]; user?: string } = {
        model: this.model,
        input: batch
      };
      if (this.user) payload.user = this.user;
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new OpenAICompatibleEmbeddingError(
        `Cannot reach embedding proxy: ${formatFetchFailure(error)}`,
        undefined,
        true
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new OpenAICompatibleEmbeddingError(
        responseMessage(response.status, response.statusText, body, this.apiKey),
        response.status,
        isRetriableStatus(response.status),
        responseFailureKind(response.status, body)
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new OpenAICompatibleEmbeddingError('Embedding proxy returned invalid JSON.');
    }
    return parseEmbeddingResponse(body, batch.length);
  }
}
