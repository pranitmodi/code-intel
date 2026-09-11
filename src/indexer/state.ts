import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface IndexState {
  lastIndexedAt: string;
  lastDurationMs: number;
  filesIndexed: number;
  chunksIndexed: number;
  embeddingModel: string;
  embeddingDimensions: number;
  /** Absolute path of the repository this index was built from. Absent on indexes created before the registry existed. */
  repoRoot?: string;
  /** Basename of `repoRoot`, for human-readable listings. */
  repoName?: string;
  /** Discoverable file count at last index (used for stale detection, including skipped files). */
  filesDiscovered?: number;
}

export interface IndexProgress {
  startedAt: string;
  updatedAt: string;
  filesDiscovered: number;
  filesProcessed: number;
  filesIndexed: number;
  filesSkipped: number;
  chunksEmbedded: number;
  embeddingModel: string;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function readState(stateFile: string): IndexState | null {
  return readJson<IndexState>(stateFile);
}

export function writeState(stateFile: string, state: IndexState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

export function readProgress(progressFile: string): IndexProgress | null {
  return readJson<IndexProgress>(progressFile);
}

export function writeProgress(progressFile: string, progress: IndexProgress): void {
  mkdirSync(dirname(progressFile), { recursive: true });
  writeFileSync(progressFile, JSON.stringify(progress, null, 2));
}

export function removeProgress(progressFile: string): void {
  rmSync(progressFile, { force: true });
}
