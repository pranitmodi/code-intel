export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Vector width produced by this provider/model. May require a network round-trip on first call. */
  dimensions(): Promise<number>;
  modelName(): string;
}
