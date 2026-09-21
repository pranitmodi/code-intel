import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashFileContent, sha256Hex } from '../hashing/hash.js';
import type { IndexState } from './state.js';

export const FRESHNESS_SAMPLE_SIZE = 32;

/** Evenly spaced, sorted paths so status can re-hash a stable subset without reading the whole tree. */
export function pickSamplePaths(relativePaths: string[], size = FRESHNESS_SAMPLE_SIZE): string[] {
  const unique = [...new Set(relativePaths)].sort();
  if (unique.length <= size) return unique;
  const sampled: string[] = [];
  for (let i = 0; i < size; i++) {
    const index = Math.floor((i * unique.length) / size);
    const path = unique[index];
    if (path) sampled.push(path);
  }
  return [...new Set(sampled)];
}

export function computeSampleFingerprint(repoRoot: string, samplePaths: string[]): string | null {
  const lines: string[] = [];
  for (const relativePath of samplePaths) {
    const absolutePath = join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) return null;
    try {
      lines.push(`${relativePath}=${hashFileContent(readFileSync(absolutePath))}`);
    } catch {
      return null;
    }
  }
  return sha256Hex(lines.join('\n'));
}

/** True when the stored sample no longer matches disk. Missing sample data is not treated as stale. */
export function isContentSampleStale(repoRoot: string, state: Pick<IndexState, 'samplePaths' | 'sampleFingerprint'>): boolean {
  if (!state.samplePaths?.length || !state.sampleFingerprint) return false;
  const next = computeSampleFingerprint(repoRoot, state.samplePaths);
  return next !== state.sampleFingerprint;
}
