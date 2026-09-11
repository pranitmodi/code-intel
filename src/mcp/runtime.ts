import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/load.js';
import type { CodeIntelConfig } from '../config/types.js';
import type { AppContext } from '../context.js';
import { createEmbeddingProvider } from '../embeddings/createEmbeddingProvider.js';
import { LanceVectorStore } from '../vector-store/LanceVectorStore.js';
import { computeRepoId } from '../utils/repo-id.js';
import { resolveRepoPaths } from '../config/paths.js';
import {
  indexedChildrenOf,
  listIndexedRepos,
  resolveRepoRef,
  type RegistryEntry
} from '../indexer/registry.js';
import { INDEX_HINT, getIndexStatus, listIndexedReposWithStale } from '../indexer/status.js';
import { readState } from '../indexer/state.js';

export interface McpRuntime {
  defaultRepoRoot?: string;
  config: CodeIntelConfig;
  resolve(repo?: string): Promise<ResolveOk | ResolveErr>;
  listRepos(): Promise<Array<RegistryEntry & { stale: boolean | null }>>;
  status(repo?: string): Promise<unknown>;
}

export interface ResolveOk {
  ok: true;
  context: AppContext;
}

export interface ResolveErr {
  ok: false;
  indexed: false;
  message: string;
  repo?: string;
  indexedChildren?: RegistryEntry[];
  repos?: RegistryEntry[];
}

export async function createMcpRuntime(defaultRepoRoot?: string): Promise<McpRuntime> {
  const resolvedDefault = defaultRepoRoot && existsSync(defaultRepoRoot) ? resolve(defaultRepoRoot) : undefined;
  const config = loadConfig({ repoRoot: resolvedDefault });
  const cache = new Map<string, Promise<AppContext>>();

  async function openRepo(repoRoot: string): Promise<AppContext> {
    const repoConfig = loadConfig({ repoRoot });
    const repoId = computeRepoId(repoRoot);
    const paths = resolveRepoPaths(repoConfig, repoRoot, repoId);
    const state = readState(paths.stateFile);
    if (!state?.embeddingDimensions) {
      throw new Error('not indexed');
    }
    if (state.embeddingModel !== repoConfig.embedding.model) {
      throw new Error(
        `This index was built with embedding model "${state.embeddingModel}", but "${repoConfig.embedding.model}" is configured. Run \`code-intel rebuild --repo ${repoRoot}\`.`
      );
    }

    const embeddingProvider = createEmbeddingProvider(repoConfig.embedding, {
      dimensions: state.embeddingDimensions
    });
    const vectorStore = await LanceVectorStore.open(paths.dbDir, state.embeddingDimensions);
    return { repoRoot, repoId, config: repoConfig, paths, embeddingProvider, vectorStore };
  }

  async function cachedOpen(repoRoot: string): Promise<AppContext> {
    const repoId = computeRepoId(repoRoot);
    let pending = cache.get(repoId);
    if (!pending) {
      pending = openRepo(repoRoot);
      cache.set(repoId, pending);
      pending.catch(() => cache.delete(repoId));
    }
    return pending;
  }

  function notIndexed(repoRoot: string | undefined, extra?: Partial<ResolveErr>): ResolveErr {
    const children = repoRoot ? indexedChildrenOf(config.database.path, repoRoot) : [];
    const relevantChildren = repoRoot ? children.filter((child) => child.path !== repoRoot) : children;
    return {
      ok: false,
      indexed: false,
      repo: repoRoot,
      message:
        relevantChildren.length > 0
          ? `This folder is not indexed, but ${relevantChildren.length} indexed child repo(s) were found. Re-call with repo set to a child's path, id, or name.`
          : INDEX_HINT,
      indexedChildren: relevantChildren.length > 0 ? relevantChildren : undefined,
      ...extra
    };
  }

  function resolveFailure(repoRoot: string, error: unknown): ResolveErr {
    if (error instanceof Error && error.message !== 'not indexed') {
      return notIndexed(repoRoot, { message: error.message });
    }
    return notIndexed(repoRoot);
  }

  return {
    defaultRepoRoot: resolvedDefault,
    config,
    async resolve(repo) {
      const ref = repo?.trim();
      if (ref) {
        const match = resolveRepoRef(config.database.path, ref, resolvedDefault);
        const repoRoot = match?.path || (existsSync(ref) ? resolve(ref) : undefined);
        if (!repoRoot || !existsSync(repoRoot)) {
          return {
            ok: false,
            indexed: false,
            message: `No indexed repository matches "${ref}". Use list_indexed_repos to see what is available, or run code-intel setup --repo <path>.`,
            repos: listIndexedRepos(config.database.path)
          };
        }
        try {
          const context = await cachedOpen(repoRoot);
          return { ok: true, context };
        } catch (error) {
          return resolveFailure(repoRoot, error);
        }
      }

      if (!resolvedDefault) {
        const repos = listIndexedRepos(config.database.path);
        return {
          ok: false,
          indexed: false,
          message:
            repos.length > 0
              ? 'No default repository was given. Pass repo as a path, id, or name from list_indexed_repos.'
              : INDEX_HINT,
          repos
        };
      }

      try {
        const context = await cachedOpen(resolvedDefault);
        return { ok: true, context };
      } catch (error) {
        return resolveFailure(resolvedDefault, error);
      }
    },
    listRepos() {
      return listIndexedReposWithStale(config.database.path);
    },
    async status(repo) {
      if (repo?.trim()) {
        const match = resolveRepoRef(config.database.path, repo, resolvedDefault);
        const repoRoot = match?.path || (existsSync(repo) ? resolve(repo) : undefined);
        if (!repoRoot) {
          return {
            indexed: false,
            message: `No indexed repository matches "${repo}".`,
            repos: listIndexedRepos(config.database.path)
          };
        }
        return getIndexStatus(repoRoot);
      }
      if (!resolvedDefault) {
        return {
          indexed: false,
          message: 'No default repository was given. Pass repo or call list_indexed_repos.',
          repos: listIndexedRepos(config.database.path)
        };
      }
      return getIndexStatus(resolvedDefault);
    }
  };
}
