import { describe, expect, it } from 'vitest';
import { formatCliFailure } from '../../src/cli/formatCliFailure.js';
import { IndexerLockedError } from '../../src/indexer/lock.js';
import { OllamaNotReachableError } from '../../src/embeddings/OllamaEmbeddingProvider.js';
import { EmbeddingConfigurationError, OpenAICompatibleEmbeddingError } from '../../src/embeddings/OpenAICompatibleEmbeddingProvider.js';

describe('formatCliFailure', () => {
  it('lists how to supply a missing company-proxy API key', () => {
    const text = formatCliFailure(
      new EmbeddingConfigurationError(
        'CODE_INTEL_EMBEDDING_API_KEY is required for provider "openai-compatible".'
      )
    );
    expect(text).toContain('[FAIL] CODE_INTEL_EMBEDDING_API_KEY is required');
    expect(text).toContain('What you can do:');
    expect(text).toContain('export CODE_INTEL_EMBEDDING_API_KEY');
    expect(text).toContain('code-intel wizard');
    expect(text).toContain('--embedding-provider ollama');
    expect(text).toContain('code-intel doctor');
  });

  it('lists how to start Ollama when the daemon is down', () => {
    const text = formatCliFailure(new OllamaNotReachableError('Cannot reach Ollama. Try `ollama serve`.'));
    expect(text).toContain('What you can do:');
    expect(text).toContain('ollama serve');
  });

  it('lists how to recover from a live indexer lock', () => {
    const text = formatCliFailure(
      new IndexerLockedError('Another code-intel process (pid 12) is already indexing this repository.')
    );
    expect(text).toContain('Wait for the other');
    expect(text).toContain('.lock');
  });

  it('lists how to fix a missing index', () => {
    const text = formatCliFailure(new Error('Run `code-intel setup --repo <path>` to index this workspace.'));
    expect(text).toContain('code-intel setup --repo');
    expect(text).toContain('CODE_INTEL_EMBEDDING_API_KEY');
  });

  it('lists how to recover from a proxy timeout', () => {
    const text = formatCliFailure(
      new OpenAICompatibleEmbeddingError('Embedding request failed (408 Request Timeout)', 408, true)
    );
    expect(text).toContain('Retry in a minute');
    expect(text).toContain('timeout_ms');
  });
});
