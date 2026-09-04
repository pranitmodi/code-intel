import { resolve } from 'node:path';
import { loadConfig } from './config/load.js';
import type { CodeIntelConfig } from './config/types.js';
import { resolveRepoPaths, type RepoPaths } from './config/paths.js';
import { computeRepoId } from './utils/repo-id.js';
import { OllamaEmbeddingProvider } from './embeddings/OllamaEmbeddingProvider.js';
import type { EmbeddingProvider } from './embeddings/EmbeddingProvider.js';
import { LanceVectorStore } from './vector-store/LanceVectorStore.js';

export interface AppContext {
  repoRoot: string;
  repoId: string;
  config: CodeIntelConfig;
  paths: RepoPaths;
  embeddingProvider: EmbeddingProvider;
  vectorStore: LanceVectorStore;
}

/** Shared bootstrap for every CLI command and the MCP server: config -> repo id -> paths -> provider -> store. */
export async function createContext(repoRootInput?: string): Promise<AppContext> {
  const repoRoot = resolve(repoRootInput ?? process.cwd());
  const config = loadConfig({ repoRoot });
  const repoId = computeRepoId(repoRoot);
  const paths = resolveRepoPaths(config, repoRoot, repoId);

  const embeddingProvider = new OllamaEmbeddingProvider({
    host: config.embedding.host,
    model: config.embedding.model,
    batchSize: config.embedding.batchSize
  });
  const dimensions = await embeddingProvider.dimensions();
  const vectorStore = await LanceVectorStore.open(paths.dbDir, dimensions);

  return { repoRoot, repoId, config, paths, embeddingProvider, vectorStore };
}
