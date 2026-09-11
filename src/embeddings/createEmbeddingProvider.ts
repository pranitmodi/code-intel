import type { EmbeddingConfig } from '../config/types.js';
import type { EmbeddingProvider } from './EmbeddingProvider.js';
import { OllamaEmbeddingProvider } from './OllamaEmbeddingProvider.js';
import { OpenAICompatibleEmbeddingProvider } from './OpenAICompatibleEmbeddingProvider.js';

export interface CreateEmbeddingProviderOptions {
  dimensions?: number;
}

export function createEmbeddingProvider(
  config: EmbeddingConfig,
  options: CreateEmbeddingProviderOptions = {}
): EmbeddingProvider {
  if (config.provider === 'ollama') {
    return new OllamaEmbeddingProvider({
      host: config.host,
      model: config.model,
      batchSize: config.batchSize,
      dimensions: options.dimensions
    });
  }

  return new OpenAICompatibleEmbeddingProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey ?? '',
    user: config.user,
    model: config.model,
    embeddingsPath: config.embeddingsPath,
    timeoutMs: config.timeoutMs,
    batchSize: config.batchSize,
    dimensions: options.dimensions
  });
}
