import { realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import watcher from '@parcel/watcher';
import { createLogger } from '../utils/logger.js';
import { DEFAULT_IGNORE_PATTERNS } from '../discovery/default-ignore.js';
import { discoverFiles, isIndexableRelativePath, type DiscoveryOptions } from '../discovery/discover.js';
import type { AppContext } from '../context.js';
import { Indexer, type IndexSummary } from './Indexer.js';
import { IndexerLockedError } from './lock.js';
import { recordWatchError, recordWatchSuccess } from './watchStatus.js';

const logger = createLogger('watch');

/** More changed files than this in one burst (e.g. git checkout) fall back to a full incremental scan. */
export const WATCH_FULL_INDEX_THRESHOLD = 40;

/** Queued events beyond this collapse into one full incremental scan instead of growing without bound. */
const MAX_QUEUED_EVENTS = WATCH_FULL_INDEX_THRESHOLD * 25;

const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;

/** Root-level files whose edits change which paths are indexable. */
const RESCAN_TRIGGERS = new Set(['.gitignore']);

export function watchIgnorePatterns(): string[] {
  return DEFAULT_IGNORE_PATTERNS.map((pattern) => {
    if (pattern.endsWith('/')) {
      const trimmed = pattern.slice(0, -1);
      return `**/${trimmed}/**`;
    }
    if (pattern.startsWith('*.')) return `**/${pattern}`;
    return pattern;
  });
}

export interface WatchFsEvent {
  type: string;
  path: string;
}

export interface WatchPlan {
  mode: 'full' | 'partial';
  upserts: string[];
  deletes: string[];
  /** Created or moved-in directories whose files still need to be discovered. */
  directories: string[];
}

export interface WatchRepoOptions {
  onIndex?: (summary: IndexSummary) => void;
  /** Run one incremental catch-up as soon as the watcher starts. */
  immediate?: boolean;
  /** First retry delay after a failed or lock-blocked run; doubles up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export function relativeWatchPath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).split(sep).join('/');
}

function isDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

export function planWatchIndex(
  repoRoot: string,
  events: WatchFsEvent[],
  options: DiscoveryOptions
): WatchPlan {
  const upserts = new Set<string>();
  const deletes = new Set<string>();
  const directories = new Set<string>();
  let rescan = false;
  for (const event of events) {
    const relativePath = relativeWatchPath(repoRoot, event.path);
    if (!relativePath || relativePath.startsWith('..')) continue;
    if (RESCAN_TRIGGERS.has(relativePath)) rescan = true;
    if (event.type === 'delete') {
      deletes.add(relativePath);
      upserts.delete(relativePath);
      directories.delete(relativePath);
      continue;
    }
    if (isDirectory(event.path)) {
      deletes.delete(relativePath);
      directories.add(relativePath);
      continue;
    }
    if (!isIndexableRelativePath(repoRoot, relativePath, options)) continue;
    deletes.delete(relativePath);
    upserts.add(relativePath);
  }
  const plan = { upserts: [...upserts], deletes: [...deletes], directories: [...directories] };
  const total = upserts.size + deletes.size;
  if (rescan || total > WATCH_FULL_INDEX_THRESHOLD) return { mode: 'full', ...plan };
  return { mode: 'partial', ...plan };
}

/**
 * Filesystem watchers report resolved paths, so an event under a repo reached
 * through a symlink (macOS `/var` -> `/private/var`, a linked `~/code`, a
 * Windows junction) would otherwise look like it came from outside the repo.
 */
function repoPathMapper(repoRoot: string): (path: string) => string {
  let realRoot: string;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    return (path) => path;
  }
  if (realRoot === repoRoot) return (path) => path;
  return (path) => {
    if (path === realRoot) return repoRoot;
    if (path.startsWith(realRoot + sep)) return join(repoRoot, path.slice(realRoot.length + 1));
    return path;
  };
}

/**
 * Watch the working tree and re-run an incremental index after a quiet period.
 * The PID lock is held only during a reindex so MCP readers stay unblocked.
 * A run that fails (embedding provider down) or finds the lock held (another
 * editor or `code-intel index`) keeps its changes queued and retries with backoff.
 */
export async function watchRepo(
  context: AppContext,
  options: WatchRepoOptions = {}
): Promise<() => Promise<void>> {
  const indexer = new Indexer({
    repoRoot: context.repoRoot,
    repoId: context.repoId,
    config: context.config,
    vectorStore: context.vectorStore,
    embeddingProvider: context.embeddingProvider,
    paths: context.paths
  });

  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const debounceMs = context.config.indexing.debounceMs;
  const discoveryOptions: DiscoveryOptions = {
    allowSensitiveFiles: context.config.security.allowSensitiveFiles,
    extraIgnorePatterns: context.config.ignore
  };
  const toRepoPath = repoPathMapper(context.repoRoot);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelayMs = 0;
  let running = false;
  let stopped = false;
  let current: Promise<void> | undefined;
  let pendingFull = Boolean(options.immediate);
  const queued: WatchFsEvent[] = [];

  const indexBatch = async (batch: WatchFsEvent[], forceFull: boolean): Promise<IndexSummary | undefined> => {
    const plan = planWatchIndex(context.repoRoot, batch, discoveryOptions);
    if (forceFull || plan.mode === 'full') return indexer.runFullIndex();

    const upserts = new Set(plan.upserts);
    for (const directory of plan.directories) {
      for (const file of await discoverFiles(context.repoRoot, discoveryOptions, directory)) {
        upserts.add(file.relativePath);
      }
    }
    if (upserts.size + plan.deletes.length > WATCH_FULL_INDEX_THRESHOLD) return indexer.runFullIndex();
    if (upserts.size === 0 && plan.deletes.length === 0) return undefined;
    return indexer.runChangedPaths([...upserts], plan.deletes);
  };

  const scheduleRetry = (): void => {
    retryDelayMs = retryDelayMs === 0 ? retryBaseMs : Math.min(retryDelayMs * 2, retryMaxMs);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      kick();
    }, retryDelayMs);
  };

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    let failed = false;
    const batch = queued.splice(0, queued.length);
    const forceFull = pendingFull;
    pendingFull = false;
    try {
      const summary = await indexBatch(batch, forceFull);
      retryDelayMs = 0;
      if (summary) {
        recordWatchSuccess(context.paths.watchStatusFile);
        options.onIndex?.(summary);
        logger.info('[WATCH] incremental index complete', {
          filesIndexed: summary.filesIndexed,
          filesDeleted: summary.filesDeleted,
          chunksEmbedded: summary.chunksEmbedded,
          durationMs: summary.durationMs
        });
      }
    } catch (error) {
      failed = true;
      queued.unshift(...batch);
      if (forceFull || queued.length > MAX_QUEUED_EVENTS) {
        pendingFull = true;
        if (queued.length > MAX_QUEUED_EVENTS) queued.length = 0;
      }
      if (!stopped) scheduleRetry();
      const message = error instanceof Error ? error.message : String(error);
      const retry = `retrying in ${Math.round(retryDelayMs / 1000)}s`;
      if (error instanceof IndexerLockedError) {
        logger.warn(`[WATCH] another indexer holds the lock — ${retry}`);
        recordWatchError(context.paths.watchStatusFile, `waiting — ${message}`);
      } else {
        logger.warn(`[WATCH] incremental index failed — ${retry}`, { error: message });
        recordWatchError(context.paths.watchStatusFile, message);
      }
    } finally {
      running = false;
    }
    if (!failed && !stopped && (pendingFull || queued.length > 0)) await run();
  };

  function kick(): void {
    if (running || stopped) return;
    current = run();
  }

  const schedule = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      // A pending retry owns the next attempt so an outage is not hammered on every save.
      if (!retryTimer) kick();
    }, debounceMs);
  };

  const subscription = await watcher.subscribe(
    context.repoRoot,
    (error, events) => {
      if (stopped) return;
      if (error) {
        logger.warn('[WATCH] filesystem error', { error: error.message });
        recordWatchError(context.paths.watchStatusFile, error.message);
        return;
      }
      if (events.length === 0) return;
      for (const event of events) queued.push({ type: event.type, path: toRepoPath(event.path) });
      if (events.length > WATCH_FULL_INDEX_THRESHOLD) pendingFull = true;
      logger.info(`[WATCH] ${events.length} change(s) — indexing in ${debounceMs}ms`);
      schedule();
    },
    { ignore: watchIgnorePatterns() }
  );

  logger.info(`[WATCH] watching ${context.repoRoot} (debounce ${debounceMs}ms)`);
  if (options.immediate) kick();

  return async () => {
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    await subscription.unsubscribe();
    await current;
  };
}
