import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

/**
 * Deterministic repository identifier derived from the real (symlink-resolved),
 * normalized absolute path of the repo root, so the same repo always maps to
 * the same index directory and different repos never collide.
 */
export function computeRepoId(repoRoot: string): string {
  const resolved = realpathSync(repoRoot);
  const normalized = resolved.replace(/\/+$/, '');
  const hash = createHash('sha256').update(normalized).digest('hex');
  return hash.slice(0, 16);
}
