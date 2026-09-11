import { resolve } from 'node:path';
import { loadConfig, type LoadConfigOptions } from './config/load.js';
import type { CodeIntelConfig } from './config/types.js';
import { resolveRepoPaths, type RepoPaths } from './config/paths.js';
import { computeRepoId } from './utils/repo-id.js';
import { createEmbeddingProvider } from './embeddings/createEmbeddingProvider.js';
import type { EmbeddingProvider } from './embeddings/EmbeddingProvider.js';
import { LanceVectorStore } from './vector-store/LanceVectorStore.js';
import { readState } from './indexer/state.js';

export interface AppContext {
  repoRoot: string;
  repoId: string;
  config: CodeIntelConfig;
  paths: RepoPaths;
  embeddingProvider: EmbeddingProvider;
  vectorStore: LanceVectorStore;
}

/** Shared bootstrap for every CLI command and the MCP server: config -> repo id -> paths -> provider -> store. */
export async function createContext(
  repoRootInput?: string,
  loadOptions: Omit<LoadConfigOptions, 'repoRoot'> = {}
): Promise<AppContext> {
  const repoRoot = resolve(repoRootInput ?? process.cwd());
  const config = loadConfig({ ...loadOptions, repoRoot });
  const repoId = computeRepoId(repoRoot);
  const paths = resolveRepoPaths(config, repoRoot, repoId);

  const state = readState(paths.stateFile);
  if (state && state.embeddingModel !== config.embedding.model) {
    throw new Error(
      `This index was built with embedding model "${state.embeddingModel}", but "${config.embedding.model}" is configured. Run \`code-intel rebuild --repo ${repoRoot}\`.`
    );
  }

  const embeddingProvider = createEmbeddingProvider(config.embedding);
  const dimensions = await embeddingProvider.dimensions();
  const vectorStore = await LanceVectorStore.open(paths.dbDir, dimensions);

  return { repoRoot, repoId, config, paths, embeddingProvider, vectorStore };
}
