import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export class IndexerLockedError extends Error {}

/** A lock file this young without a readable pid is assumed to be mid-write by its owner. */
const FRESH_LOCK_MS = 10_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryCreate(lockFile: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockFile, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

function readLock(lockFile: string): { raw: string; ageMs: number } | undefined {
  try {
    return {
      raw: readFileSync(lockFile, 'utf-8').trim(),
      ageMs: Date.now() - statSync(lockFile).mtimeMs
    };
  } catch {
    return undefined;
  }
}

/** Pid (or `unknown`) of a live holder, or undefined when the lock is stale or gone. */
function liveHolder(lock: { raw: string; ageMs: number }): string | undefined {
  const pid = Number(lock.raw);
  if (lock.raw && Number.isInteger(pid) && pid > 0) {
    return isProcessAlive(pid) ? String(pid) : undefined;
  }
  return lock.ageMs < FRESH_LOCK_MS ? 'unknown' : undefined;
}

/**
 * Single-writer guard: one indexing run per repo at a time, across processes
 * and within one process. Creation is atomic, so two MCP servers starting at
 * once (e.g. Cursor and VS Code on the same repo) cannot both win. A lock left
 * by a process that no longer exists is reclaimed.
 */
export function acquireLock(lockFile: string): () => void {
  mkdirSync(dirname(lockFile), { recursive: true });
  const ownPid = String(process.pid);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(lockFile)) {
      return () => {
        if (readLock(lockFile)?.raw !== ownPid) return;
        try {
          unlinkSync(lockFile);
        } catch {
          // already removed — fine
        }
      };
    }
    const lock = readLock(lockFile);
    if (!lock) continue;
    const holder = liveHolder(lock);
    if (holder !== undefined) {
      throw new IndexerLockedError(
        `Another code-intel process (pid ${holder}) is already indexing this repository.`
      );
    }
    if (readLock(lockFile)?.raw !== lock.raw) continue;
    try {
      unlinkSync(lockFile);
    } catch {
      // another process reclaimed it first
    }
  }
  throw new IndexerLockedError('Another code-intel process is already indexing this repository.');
}
