import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class IndexerLockedError extends Error {}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-writer guard: one `index`/`watch` process per repo at a time (spec section 22).
 * A lock file left behind by a process that no longer exists is treated as stale and reclaimed.
 */
export function acquireLock(lockFile: string): () => void {
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf-8').trim());
    if (Number.isFinite(pid) && isProcessAlive(pid)) {
      throw new IndexerLockedError(
        `Another code-intel process (pid ${pid}) is already indexing this repository.`
      );
    }
  }
  mkdirSync(dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, String(process.pid));
  return () => {
    try {
      unlinkSync(lockFile);
    } catch {
      // already removed — fine
    }
  };
}
