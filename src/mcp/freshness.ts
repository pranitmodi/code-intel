import { getIndexFreshness } from '../indexer/status.js';
import type { WatchSnapshot } from '../indexer/watch.js';

/** How long a measured freshness result is served before it is re-measured in the background. */
const DEFAULT_TTL_MS = 60_000;
/** The longest a first check for a repo may delay a reply; slower walks finish in the background. */
const DEFAULT_MAX_WAIT_MS = 150;
/** Changes younger than this are inside the watcher's debounce window, not staleness. */
export const PENDING_GRACE_MS = 5_000;

export type FreshnessCheck = (repoRoot: string) => Promise<boolean | null>;

export interface FreshnessOptions {
  ttlMs?: number;
  maxWaitMs?: number;
}

/**
 * Staleness according to a live watcher, or undefined when the watcher has not
 * finished its startup catch-up and so cannot vouch for edits made while it was off.
 */
export function staleFromSnapshot(snapshot: WatchSnapshot, now = Date.now()): boolean | undefined {
  if (!snapshot.caughtUp) return undefined;
  if (snapshot.failing) return true;
  return snapshot.pendingSince !== null && now - snapshot.pendingSince > PENDING_GRACE_MS;
}

interface Entry {
  stale: boolean | null;
  checkedAt: number;
  pending?: Promise<boolean | null>;
}

/**
 * Index freshness for request paths. A repo with a live watcher answers from
 * the watcher's own state; otherwise a tree walk is cached for `ttlMs` and
 * refreshed in the background (stale-while-revalidate). A reply never waits
 * longer than `maxWaitMs` for a first measurement, reporting null (unknown).
 */
export class FreshnessCache {
  private readonly entries = new Map<string, Entry>();
  private readonly watchers = new Map<string, () => WatchSnapshot>();

  constructor(
    private readonly check: FreshnessCheck = getIndexFreshness,
    private readonly options: FreshnessOptions = {}
  ) {}

  registerWatcher(repoRoot: string, snapshot: () => WatchSnapshot): void {
    this.watchers.set(repoRoot, snapshot);
  }

  unregisterWatcher(repoRoot: string): void {
    this.watchers.delete(repoRoot);
  }

  async peek(repoRoot: string, now = Date.now()): Promise<boolean | null> {
    const snapshot = this.watchers.get(repoRoot)?.();
    const fromWatcher = snapshot ? staleFromSnapshot(snapshot, now) : undefined;
    if (fromWatcher !== undefined) return fromWatcher;

    const entry = this.entries.get(repoRoot);
    if (entry && now - entry.checkedAt < (this.options.ttlMs ?? DEFAULT_TTL_MS)) return entry.stale;
    const pending = this.revalidate(repoRoot);
    if (entry && entry.checkedAt > 0) return entry.stale;
    return waitAtMost(pending, this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  }

  /** Forget a measured result, e.g. after this process re-indexed the repo. */
  invalidate(repoRoot: string): void {
    const entry = this.entries.get(repoRoot);
    if (entry) entry.checkedAt = 0;
  }

  private revalidate(repoRoot: string): Promise<boolean | null> {
    const entry = this.entries.get(repoRoot);
    if (entry?.pending) return entry.pending;
    const pending = this.check(repoRoot)
      .catch(() => null)
      .then((stale) => {
        this.entries.set(repoRoot, { stale, checkedAt: Date.now() });
        return stale;
      });
    this.entries.set(repoRoot, { stale: entry?.stale ?? null, checkedAt: entry?.checkedAt ?? 0, pending });
    return pending;
  }
}

function waitAtMost(pending: Promise<boolean | null>, ms: number): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

/** One cache per MCP process, shared by every connection and the workspace watchers. */
export const sharedFreshness = new FreshnessCache();
