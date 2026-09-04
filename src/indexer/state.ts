import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export function readState(stateFile: string): IndexState | null {
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8')) as IndexState;
  } catch {
    return null;
  }
}

export function writeState(stateFile: string, state: IndexState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
