import { relative, sep } from 'node:path';
import watcher from '@parcel/watcher';
import { createLogger } from '../utils/logger.js';
import { DEFAULT_IGNORE_PATTERNS } from '../discovery/default-ignore.js';
import { isIndexableRelativePath } from '../discovery/discover.js';
import type { AppContext } from '../context.js';
import { Indexer, type IndexSummary } from './Indexer.js';
import { IndexerLockedError } from './lock.js';
import { recordWatchError, recordWatchSuccess } from './watchStatus.js';

const logger = createLogger('watch');

/** More changed files than this in one burst (e.g. git checkout) fall back to a full incremental scan. */
export const WATCH_FULL_INDEX_THRESHOLD = 40;

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

export function relativeWatchPath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).split(sep).join('/');
}

export function planWatchIndex(
  repoRoot: string,
  events: WatchFsEvent[],
  options: { allowSensitiveFiles: boolean; extraIgnorePatterns: string[] }
): { mode: 'full' | 'partial'; upserts: string[]; deletes: string[] } {
  const upserts = new Set<string>();
  const deletes = new Set<string>();
  for (const event of events) {
    const relativePath = relativeWatchPath(repoRoot, event.path);
    if (!relativePath || relativePath.startsWith('..')) continue;
    if (event.type === 'delete') {
      deletes.add(relativePath);
      upserts.delete(relativePath);
      continue;
    }
    if (!isIndexableRelativePath(repoRoot, relativePath, options)) continue;
    deletes.delete(relativePath);
    upserts.add(relativePath);
  }
  const total = upserts.size + deletes.size;
  if (total > WATCH_FULL_INDEX_THRESHOLD) {
    return { mode: 'full', upserts: [...upserts], deletes: [...deletes] };
  }
  return { mode: 'partial', upserts: [...upserts], deletes: [...deletes] };
}

/**
 * Watch the working tree and re-run an incremental index after a quiet period.
 * The PID lock is held only during a reindex so MCP readers stay unblocked.
 */
export async function watchRepo(
  context: AppContext,
  options: { onIndex?: (summary: IndexSummary) => void; immediate?: boolean } = {}
): Promise<() => Promise<void>> {
  const indexer = new Indexer({
    repoRoot: context.repoRoot,
    repoId: context.repoId,
    config: context.config,
    vectorStore: context.vectorStore,
    embeddingProvider: context.embeddingProvider,
    paths: context.paths
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pendingFull = Boolean(options.immediate);
  const queued: WatchFsEvent[] = [];
  const debounceMs = context.config.indexing.debounceMs;
  const discoveryOptions = {
    allowSensitiveFiles: context.config.security.allowSensitiveFiles,
    extraIgnorePatterns: context.config.ignore
  };

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const batch = queued.splice(0, queued.length);
      const forceFull = pendingFull;
      pendingFull = false;
      const plan = forceFull
        ? { mode: 'full' as const, upserts: [] as string[], deletes: [] as string[] }
        : planWatchIndex(context.repoRoot, batch, discoveryOptions);
      if (!forceFull && plan.mode === 'partial' && plan.upserts.length === 0 && plan.deletes.length === 0) {
        return;
      }
      const summary =
        plan.mode === 'full' || forceFull
          ? await indexer.runFullIndex()
          : await indexer.runChangedPaths(plan.upserts, plan.deletes);
      recordWatchSuccess(context.paths.watchStatusFile);
      options.onIndex?.(summary);
      logger.info('[WATCH] incremental index complete', {
        mode: forceFull || plan.mode === 'full' ? 'full' : 'partial',
        filesIndexed: summary.filesIndexed,
        chunksEmbedded: summary.chunksEmbedded,
        durationMs: summary.durationMs
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof IndexerLockedError) {
        logger.warn('[WATCH] skipped — another indexer holds the lock');
        recordWatchError(context.paths.watchStatusFile, `skipped — ${message}`);
      } else {
        logger.warn('[WATCH] incremental index failed', { error: message });
        recordWatchError(context.paths.watchStatusFile, message);
      }
    } finally {
      running = false;
      if (pendingFull || queued.length > 0) await run();
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void run();
    }, debounceMs);
  };

  const subscription = await watcher.subscribe(
    context.repoRoot,
    (error, events) => {
      if (error) {
        logger.warn('[WATCH] filesystem error', { error: error.message });
        recordWatchError(context.paths.watchStatusFile, error.message);
        return;
      }
      if (events.length === 0) return;
      queued.push(...events);
      if (events.length > WATCH_FULL_INDEX_THRESHOLD) pendingFull = true;
      logger.info(`[WATCH] ${events.length} change(s) — indexing in ${debounceMs}ms`);
      schedule();
    },
    { ignore: watchIgnorePatterns() }
  );

  logger.info(`[WATCH] watching ${context.repoRoot} (debounce ${debounceMs}ms)`);
  if (options.immediate) void run();

  return async () => {
    if (timer) clearTimeout(timer);
    await subscription.unsubscribe();
  };
}
