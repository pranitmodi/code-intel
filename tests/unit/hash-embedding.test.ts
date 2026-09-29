import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { createEmbeddingProvider } from '../../src/embeddings/createEmbeddingProvider.js';
import { HASH_EMBEDDING_MODEL, HashEmbeddingProvider } from '../../src/embeddings/HashEmbeddingProvider.js';

function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
}

describe('HashEmbeddingProvider', () => {
  const originalProvider = process.env.CODE_INTEL_EMBEDDING_PROVIDER;

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.CODE_INTEL_EMBEDDING_PROVIDER;
    else process.env.CODE_INTEL_EMBEDDING_PROVIDER = originalProvider;
  });

  it('is deterministic and unit length', async () => {
    const provider = new HashEmbeddingProvider();
    const [a, b] = await provider.embedBatch(['getTaskContext packs chunks', 'getTaskContext packs chunks']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(384);
    expect(Math.abs(cosine(a!, a!) - 1)).toBeLessThan(1e-9);
  });

  it('places texts sharing identifier parts closer than unrelated text', async () => {
    const provider = new HashEmbeddingProvider();
    const [query, related, unrelated] = await provider.embedBatch([
      'where is the task context assembled',
      'export async function getTaskContext(task) { return assembleTaskContext(task); }',
      'const payments = chargeCard(invoice.total);'
    ]);
    expect(cosine(query!, related!)).toBeGreaterThan(cosine(query!, unrelated!));
  });

  it('is selected by CODE_INTEL_EMBEDDING_PROVIDER=hash with a matching model name', async () => {
    process.env.CODE_INTEL_EMBEDDING_PROVIDER = 'hash';
    const config = loadConfig();
    expect(config.embedding.model).toBe(HASH_EMBEDDING_MODEL);
    const provider = createEmbeddingProvider(config.embedding);
    expect(provider.modelName()).toBe(HASH_EMBEDDING_MODEL);
    expect(await provider.dimensions()).toBe(384);
  });
});
