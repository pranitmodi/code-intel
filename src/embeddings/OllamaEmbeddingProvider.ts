import { Ollama } from 'ollama';
import { createLogger } from '../utils/logger.js';
import type { EmbeddingProvider } from './EmbeddingProvider.js';

const logger = createLogger('embeddings:ollama');

export class OllamaNotReachableError extends Error {}
export class OllamaModelNotFoundError extends Error {}

export interface OllamaEmbeddingProviderOptions {
  host: string;
  model: string;
  batchSize?: number;
  maxRetries?: number;
  /** Skip the Ollama probe when the index already recorded the vector width. */
  dimensions?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function translateOllamaError(error: unknown, model: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|Unable to connect/i.test(message)) {
    return new OllamaNotReachableError(`Cannot reach Ollama. Is it running? Try \`ollama serve\`. (${message})`);
  }
  if (/not found|404/i.test(message)) {
    return new OllamaModelNotFoundError(
      `Model "${model}" is not available locally. Run \`ollama pull ${model}\`. (${message})`
    );
  }
  return error instanceof Error ? error : new Error(message);
}

/**
 * Ollama-backed embedding provider. Batches requests (one HTTP call per
 * batch, not per chunk) and retries a failing batch with backoff instead of
 * aborting the whole indexing run.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly client: Ollama;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private cachedDimensions: number | undefined;

  constructor(options: OllamaEmbeddingProviderOptions) {
    this.client = new Ollama({ host: options.host });
    this.model = options.model;
    this.batchSize = options.batchSize ?? 32;
    this.maxRetries = options.maxRetries ?? 2;
    this.cachedDimensions = options.dimensions;
  }

  modelName(): string {
    return this.model;
  }

  async dimensions(): Promise<number> {
    if (this.cachedDimensions !== undefined) return this.cachedDimensions;
    const [vector] = await this.embedBatchOnce(['dimension probe']);
    if (!vector) throw new Error(`Ollama returned no embedding vector for model "${this.model}"`);
    this.cachedDimensions = vector.length;
    return this.cachedDimensions;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    if (!vector) throw new Error(`Ollama returned no embedding vector for model "${this.model}"`);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      results.push(...(await this.embedBatchWithRetry(batch)));
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
        const translated = translateOllamaError(error, this.model);
        if (translated instanceof OllamaModelNotFoundError) throw translated; // retrying won't help
        logger.warn(`Embedding batch failed (attempt ${attempt + 1}/${this.maxRetries + 1})`, {
          error: translated.message
        });
        if (attempt < this.maxRetries) await sleep(250 * 2 ** attempt);
      }
    }
    throw translateOllamaError(lastError, this.model);
  }

  private async embedBatchOnce(batch: string[]): Promise<number[][]> {
    try {
      const response = await this.client.embed({ model: this.model, input: batch });
      return response.embeddings;
    } catch (error) {
      throw translateOllamaError(error, this.model);
    }
  }
}
