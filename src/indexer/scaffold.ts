import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from '../config/load.js';
import { isIndexInsideRepo, resolveRepoPaths, type RepoPaths } from '../config/paths.js';
import type { CodeIntelConfig } from '../config/types.js';
import { computeRepoId } from '../utils/repo-id.js';
import { registryEntryFrom, upsertRegistryEntry } from './registry.js';

export interface ScaffoldResult {
  repoRoot: string;
  repoId: string;
  config: CodeIntelConfig;
  paths: RepoPaths;
}

/** Create the on-disk index directories and register the repo (does not embed anything). */
export function scaffoldRepo(repoRoot: string): ScaffoldResult {
  const config = loadConfig({ repoRoot });
  const repoId = computeRepoId(repoRoot);
  const paths = resolveRepoPaths(config, repoRoot, repoId);

  mkdirSync(paths.dbDir, { recursive: true });
  mkdirSync(paths.metadataDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  upsertRegistryEntry(
    config.database.path,
    registryEntryFrom(repoRoot, repoId, { lastIndexedAt: null, filesIndexed: 0, chunksIndexed: 0 })
  );

  return { repoRoot, repoId, config, paths };
}

export function repoDisplayName(repoRoot: string): string {
  return basename(repoRoot);
}

export { isIndexInsideRepo };
