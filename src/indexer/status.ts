import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from '../config/load.js';
import { resolveRepoPaths } from '../config/paths.js';
import { discoverFiles } from '../discovery/discover.js';
import { getDirectorySizeBytes } from '../utils/dirSize.js';
import { computeRepoId } from '../utils/repo-id.js';
import { indexedChildrenOf, listIndexedRepos, type RegistryEntry } from './registry.js';
import { readProgress, readState, type IndexProgress } from './state.js';

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

  let filesDiscoverable: number | null = null;
  let stale: boolean | null = null;
  if (existsSync(repoRoot)) {
    const discovered = await discoverFiles(repoRoot, {
      allowSensitiveFiles: config.security.allowSensitiveFiles,
      extraIgnorePatterns: config.ignore
    });
    filesDiscoverable = discovered.length;
    stale = discovered.length !== (state.filesDiscovered ?? state.filesIndexed);
  }

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
    progress
  };
}

export async function listIndexedReposWithStale(
  databasePath: string
): Promise<Array<RegistryEntry & { stale: boolean | null; progress?: IndexStatus['progress'] }>> {
  const repos = listIndexedRepos(databasePath);
  return Promise.all(
    repos.map(async (repo) => {
      if (!repo.path || !existsSync(repo.path)) {
        return { ...repo, stale: null };
      }
      const status = await getIndexStatus(repo.path);
      return { ...repo, stale: status.stale, progress: status.progress };
    })
  );
}
