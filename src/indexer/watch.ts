import watcher from '@parcel/watcher';
import { createLogger } from '../utils/logger.js';
import { DEFAULT_IGNORE_PATTERNS } from '../discovery/default-ignore.js';
import type { AppContext } from '../context.js';
import { Indexer, type IndexSummary } from './Indexer.js';
import { IndexerLockedError } from './lock.js';

const logger = createLogger('watch');

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
  let pending = false;
  const debounceMs = context.config.indexing.debounceMs;

  const run = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const summary = await indexer.runFullIndex();
      options.onIndex?.(summary);
      logger.info('[WATCH] incremental index complete', {
        filesIndexed: summary.filesIndexed,
        chunksEmbedded: summary.chunksEmbedded,
        durationMs: summary.durationMs
      });
    } catch (error) {
      if (error instanceof IndexerLockedError) {
        logger.warn('[WATCH] skipped — another indexer holds the lock');
      } else {
        logger.warn('[WATCH] incremental index failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      running = false;
      if (pending) {
        pending = false;
        await run();
      }
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
        return;
      }
      if (events.length === 0) return;
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
