import { resolve, sep } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { watchRepo } from '../indexer/watch.js';
import type { McpRuntime } from './runtime.js';

const logger = createLogger('watch');

/** Indexed repo roots that should be watched for the MCP workspace. */
export function watchTargetsForWorkspace(
  workspaceRoot: string | undefined,
  indexedPaths: string[]
): string[] {
  if (!workspaceRoot) return [];
  const parent = resolve(workspaceRoot);
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return indexedPaths.filter((path) => Boolean(path) && (path === parent || path.startsWith(prefix)));
}

/**
 * Watch every indexed repo under the MCP workspace (the repo itself, or child
 * projects when the workspace is a parent folder). Runs one incremental catch-up
 * immediately so edits made while Cursor was closed are not left stale.
 */
export async function startWorkspaceWatchers(runtime: McpRuntime): Promise<() => Promise<void>> {
  const repos = await runtime.listRepos();
  const targets = watchTargetsForWorkspace(
    runtime.defaultRepoRoot,
    repos.map((repo) => repo.path).filter((path): path is string => Boolean(path))
  );
  const stops: Array<() => Promise<void>> = [];

  for (const path of targets) {
    const resolved = await runtime.resolve(path);
    if (!resolved.ok) {
      logger.warn(`[WATCH] skip ${path} — not openable`);
      continue;
    }
    const stop = await watchRepo(resolved.context, { immediate: true });
    stops.push(stop);
    logger.info(`[WATCH] on for ${path}`);
  }

  if (targets.length === 0) {
    logger.info('[WATCH] no indexed repos under workspace — nothing to watch');
  }

  return async () => {
    await Promise.all(stops.map((stop) => stop()));
  };
}
