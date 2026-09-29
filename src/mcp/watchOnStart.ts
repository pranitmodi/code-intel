import { resolve } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { watchRepo, type WatchHandle, type WatchRepoOptions } from '../indexer/watch.js';
import { containingRepoPath, isSameOrInside } from '../indexer/registry.js';
import { sharedFreshness, type FreshnessCache } from './freshness.js';
import type { McpRuntime } from './runtime.js';

const logger = createLogger('watch');

/** How often the registry is re-read for repos indexed (or removed) after the server started. */
const DEFAULT_REFRESH_MS = 30_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Indexed repo roots that should be watched for the MCP workspace: the repo
 * itself, indexed child projects when the workspace is a parent folder, or the
 * indexed repo that owns the workspace when a subfolder was opened.
 */
export function watchTargetsForWorkspace(
  workspaceRoot: string | undefined,
  indexedPaths: string[]
): string[] {
  if (!workspaceRoot) return [];
  const root = resolve(workspaceRoot);
  const under = indexedPaths.filter((path) => Boolean(path) && isSameOrInside(path, root));
  if (under.length > 0) return under;
  const owner = containingRepoPath(root, indexedPaths);
  return owner ? [owner] : [];
}

export interface WorkspaceWatcherOptions {
  refreshMs?: number;
  watch?: WatchRepoOptions;
  /** Receives each watcher's state so freshness checks need not walk the tree. */
  freshness?: FreshnessCache;
}

/**
 * Watch every indexed repo for the MCP workspace, running one incremental
 * catch-up per repo so edits made while the editor was closed are not left
 * stale. Repos indexed later (for example by `code-intel setup` in a terminal)
 * are picked up on the next refresh; repos removed with `code-intel clean` stop
 * being watched.
 */
export async function startWorkspaceWatchers(
  runtime: McpRuntime,
  options: WorkspaceWatcherOptions = {}
): Promise<() => Promise<void>> {
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const freshness = options.freshness ?? sharedFreshness;
  /** Watched target path -> its watcher and the repo root it reports freshness for. */
  const active = new Map<string, { stop: WatchHandle; repoRoot: string }>();
  const unopenable = new Set<string>();
  let stopped = false;

  const refresh = async (): Promise<void> => {
    // Registry only: a freshness check here would walk every indexed tree each refresh.
    const repos = runtime.listRegistered();
    const targets = new Set(
      watchTargetsForWorkspace(
        runtime.defaultRepoRoot,
        repos.map((repo) => repo.path).filter((path): path is string => Boolean(path))
      )
    );

    for (const [path, watched] of active) {
      if (targets.has(path)) continue;
      active.delete(path);
      freshness.unregisterWatcher(watched.repoRoot);
      await watched.stop();
      runtime.evict(path);
      logger.info(`[WATCH] off for ${path} — no longer indexed`);
    }

    for (const path of targets) {
      if (stopped || active.has(path)) continue;
      const resolved = await runtime.resolve(path);
      if (!resolved.ok) {
        if (!unopenable.has(path)) logger.warn(`[WATCH] skip ${path} — not openable yet`);
        unopenable.add(path);
        continue;
      }
      unopenable.delete(path);
      try {
        const handle = await watchRepo(resolved.context, { immediate: true, ...options.watch });
        active.set(path, { stop: handle, repoRoot: resolved.context.repoRoot });
        freshness.registerWatcher(resolved.context.repoRoot, handle.snapshot);
        logger.info(`[WATCH] on for ${path}`);
      } catch (error) {
        logger.warn(`[WATCH] could not watch ${path}`, { error: describe(error) });
      }
    }
  };

  let pending: Promise<void> | undefined;
  const refreshSafely = (): Promise<void> => {
    pending ??= refresh()
      .catch((error: unknown) => {
        logger.warn('[WATCH] refresh failed', { error: describe(error) });
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };

  await refreshSafely();
  if (active.size === 0) {
    logger.info(`[WATCH] no indexed repos for this workspace yet — rechecking every ${Math.round(refreshMs / 1000)}s`);
  }

  const interval = setInterval(() => {
    if (!stopped) void refreshSafely();
  }, refreshMs);
  interval.unref();

  return async () => {
    stopped = true;
    clearInterval(interval);
    await pending;
    for (const watched of active.values()) freshness.unregisterWatcher(watched.repoRoot);
    await Promise.all([...active.values()].map((watched) => watched.stop()));
    active.clear();
  };
}
