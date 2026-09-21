import { join, resolve, sep } from 'node:path';
import type { CodeIntelConfig } from './types.js';

export interface RepoPaths {
  root: string;
  indexDir: string;
  dbDir: string;
  metadataDir: string;
  stateFile: string;
  progressFile: string;
  watchStatusFile: string;
  logsDir: string;
  lockFile: string;
}

export function resolveRepoPaths(config: CodeIntelConfig, repoRoot: string, repoId: string): RepoPaths {
  const indexDir = join(config.database.path, 'repos', repoId);
  return {
    root: repoRoot,
    indexDir,
    dbDir: join(indexDir, 'db'),
    metadataDir: join(indexDir, 'metadata'),
    stateFile: join(indexDir, 'state.json'),
    progressFile: join(indexDir, 'progress.json'),
    watchStatusFile: join(indexDir, 'watch-status.json'),
    logsDir: join(indexDir, 'logs'),
    lockFile: join(indexDir, '.lock')
  };
}

/** True if the resolved index directory lives inside the repo itself (opt-in, not the default). */
export function isIndexInsideRepo(paths: RepoPaths): boolean {
  const repo = resolve(paths.root) + sep;
  const index = resolve(paths.indexDir) + sep;
  return index.startsWith(repo);
}
