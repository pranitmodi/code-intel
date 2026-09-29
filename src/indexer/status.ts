import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from '../config/load.js';
import { resolveRepoPaths } from '../config/paths.js';
import { discoverFiles } from '../discovery/discover.js';
import { getDirectorySizeBytes } from '../utils/dirSize.js';
import { computeRepoId } from '../utils/repo-id.js';
import { isContentSampleStale } from './freshness.js';
import { indexedChildrenOf, listIndexedRepos, type RegistryEntry } from './registry.js';
import type { CodeIntelConfig } from '../config/types.js';
import { readProgress, readState, type IndexProgress, type IndexState } from './state.js';
import { readWatchStatus, type WatchStatus } from './watchStatus.js';

export const INDEX_HINT = 'Not indexed yet — run `code-intel setup --repo <path>` (or `code-intel index --repo <path>`).';

export interface IndexStatus {
  repoRoot: string;
  repoId: string | null;
  repoName: string;
  indexed: boolean;
  stale: boolean | null;
  filesIndexed: number;
  chunksIndexed: number;
  filesDiscoverable: number | null;
  lastIndexedAt: string | null;
  embeddingModel: string | null;
  indexLocation: string | null;
  databaseBytes: number | null;
  progress?: IndexProgress & { active: boolean };
  watch?: WatchStatus & { skipped?: boolean };
  message?: string;
  indexedChildren?: RegistryEntry[];
}

export async function getIndexStatus(repoRoot: string): Promise<IndexStatus> {
  const config = loadConfig({ repoRoot });
  let repoId: string | null = null;
  try {
    repoId = computeRepoId(repoRoot);
  } catch {
    return {
      repoRoot,
      repoId: null,
      repoName: basename(repoRoot),
      indexed: false,
      stale: null,
      filesIndexed: 0,
      chunksIndexed: 0,
      filesDiscoverable: null,
      lastIndexedAt: null,
      embeddingModel: null,
      indexLocation: null,
      databaseBytes: null,
      message: INDEX_HINT
    };
  }

  const paths = resolveRepoPaths(config, repoRoot, repoId);
  const state = readState(paths.stateFile);
  const savedProgress = readProgress(paths.progressFile);
  const progress = savedProgress
    ? { ...savedProgress, active: existsSync(paths.lockFile) }
    : undefined;
  const children = indexedChildrenOf(config.database.path, repoRoot).filter((child) => child.path !== repoRoot);

  if (!state) {
    return {
      repoRoot,
      repoId,
      repoName: basename(repoRoot),
      indexed: false,
      stale: null,
      filesIndexed: 0,
      chunksIndexed: 0,
      filesDiscoverable: null,
      lastIndexedAt: null,
      embeddingModel: null,
      indexLocation: paths.indexDir,
      databaseBytes: existsSync(paths.dbDir) ? getDirectorySizeBytes(paths.dbDir) : null,
      progress,
      message: progress?.active
        ? 'Initial indexing is in progress.'
        : progress
          ? 'A partial index is available — run `code-intel index --repo <path>` to resume.'
          : children.length > 0
            ? `This folder is not indexed, but ${children.length} indexed child repo(s) were found. Pass repo as a child's path, id, or name.`
            : INDEX_HINT,
      indexedChildren: children.length > 0 ? children : undefined
    };
  }

  const { filesDiscoverable, stale } = await measureFreshness(repoRoot, config, state);

  const watch = readWatchStatus(paths.watchStatusFile);
  return {
    repoRoot,
    repoId,
    repoName: state.repoName ?? basename(repoRoot),
    indexed: true,
    stale,
    filesIndexed: state.filesIndexed,
    chunksIndexed: state.chunksIndexed,
    filesDiscoverable,
    lastIndexedAt: state.lastIndexedAt,
    embeddingModel: state.embeddingModel,
    indexLocation: paths.indexDir,
    databaseBytes: getDirectorySizeBytes(paths.dbDir),
    progress,
    watch: watch ? { ...watch, skipped: Boolean(watch.lastError) } : undefined
  };
}

/**
 * Walk the working tree and compare it with the index: the file count, then a
 * re-hash of a fixed sample. This is the expensive part of a status check, so
 * request paths should go through a cache (see `src/mcp/freshness.ts`).
 */
async function measureFreshness(
  repoRoot: string,
  config: CodeIntelConfig,
  state: IndexState
): Promise<{ filesDiscoverable: number | null; stale: boolean | null }> {
  if (!existsSync(repoRoot)) return { filesDiscoverable: null, stale: null };
  const discovered = await discoverFiles(repoRoot, {
    allowSensitiveFiles: config.security.allowSensitiveFiles,
    extraIgnorePatterns: config.ignore
  });
  const countStale = discovered.length !== (state.filesDiscovered ?? state.filesIndexed);
  return {
    filesDiscoverable: discovered.length,
    stale: countStale || isContentSampleStale(repoRoot, state)
  };
}

/** Whether the index lags the working tree; null when the repo is not indexed. Skips the database size walk. */
export async function getIndexFreshness(repoRoot: string): Promise<boolean | null> {
  const config = loadConfig({ repoRoot });
  let repoId: string;
  try {
    repoId = computeRepoId(repoRoot);
  } catch {
    return null;
  }
  const state = readState(resolveRepoPaths(config, repoRoot, repoId).stateFile);
  if (!state) return null;
  return (await measureFreshness(repoRoot, config, state)).stale;
}

function progressFor(repoRoot: string): IndexStatus['progress'] {
  try {
    const paths = resolveRepoPaths(loadConfig({ repoRoot }), repoRoot, computeRepoId(repoRoot));
    const saved = readProgress(paths.progressFile);
    return saved ? { ...saved, active: existsSync(paths.lockFile) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registry entries with a stale flag. `staleFor` defaults to a full freshness
 * check; the MCP server passes its cache so listing repos never walks trees.
 */
export async function listIndexedReposWithStale(
  databasePath: string,
  staleFor: (repoRoot: string) => Promise<boolean | null> = getIndexFreshness
): Promise<Array<RegistryEntry & { stale: boolean | null; progress?: IndexStatus['progress'] }>> {
  const repos = listIndexedRepos(databasePath);
  return Promise.all(
    repos.map(async (repo) => {
      if (!repo.path || !existsSync(repo.path)) {
        return { ...repo, stale: null };
      }
      const progress = progressFor(repo.path);
      return { ...repo, stale: await staleFor(repo.path), ...(progress ? { progress } : {}) };
    })
  );
}
