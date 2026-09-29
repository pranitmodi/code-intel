import type { EmbeddingProvider } from './EmbeddingProvider.js';
import { normalizeVector } from './vectorMath.js';

export const HASH_EMBEDDING_MODEL = 'hash-384-v1';
const DEFAULT_DIMENSIONS = 384;

/** Lowercased words plus the parts of camelCase, snake_case and kebab-case identifiers. */
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9_$-]+/g) ?? []) {
    const lower = raw.toLowerCase();
    out.push(lower);
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length >= 2);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

/** FNV-1a, 32-bit. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic, offline embeddings: signed feature hashing of word and
 * identifier-part unigrams and bigrams. Retrieval quality is far below a real
 * model; it exists so benchmarks and CI produce identical results without
 * Ollama or network access (`CODE_INTEL_EMBEDDING_PROVIDER=hash`).
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  private readonly model: string;
  private readonly width: number;

  constructor(options: { model?: string; dimensions?: number } = {}) {
    this.model = options.model?.startsWith('hash') ? options.model : HASH_EMBEDDING_MODEL;
    this.width = options.dimensions ?? DEFAULT_DIMENSIONS;
  }

  async embed(text: string): Promise<number[]> {
    return this.vector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vector(text));
  }

  async dimensions(): Promise<number> {
    return this.width;
  }

  modelName(): string {
    return this.model;
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(this.width).fill(0);
    const words = tokens(text);
    const features = [...words, ...words.slice(1).map((word, i) => `${words[i]} ${word}`)];
    for (const feature of features) {
      const h = hash(feature);
      const index = h % this.width;
      vector[index] = (vector[index] ?? 0) + ((h >>> 31) === 0 ? 1 : -1);
    }
    if (features.length === 0) vector[0] = 1;
    return normalizeVector(vector);
  }
}
