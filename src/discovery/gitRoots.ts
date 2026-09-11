import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import ignoreFactory from 'ignore';
import { DEFAULT_IGNORE_PATTERNS } from './default-ignore.js';

export function isGitRoot(path: string): boolean {
  return existsSync(join(path, '.git'));
}

/** Resolve a selected subdirectory (for example one service) to its owning Git repository. */
export function findContainingGitRoot(path: string): string | undefined {
  let current = resolve(path);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (isGitRoot(current)) return current;
    if (current === filesystemRoot) return undefined;
    current = dirname(current);
  }
}

/**
 * Find independent repositories below a non-Git workspace. Once a Git root is
 * found its children are not traversed, so nested source is never registered
 * as a duplicate collection.
 */
export async function findNestedGitRoots(workspaceRoot: string): Promise<string[]> {
  const root = resolve(workspaceRoot);
  const ignored = ignoreFactory().add(DEFAULT_IGNORE_PATTERNS);
  const results: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = absolutePath.slice(root.length + 1).split('\\').join('/');
      if (ignored.ignores(`${relativePath}/`)) continue;
      if (isGitRoot(absolutePath)) {
        results.push(absolutePath);
        continue;
      }
      await walk(absolutePath);
    }
  }

  await walk(root);
  return results.sort();
}

/** Git repository roots are index boundaries; a plain project remains a valid single target. */
export async function resolveIndexRoots(requestedRoot: string): Promise<string[]> {
  const owningRoot = findContainingGitRoot(requestedRoot);
  if (owningRoot) return [owningRoot];
  const nested = await findNestedGitRoots(requestedRoot);
  return nested.length > 0 ? nested : [resolve(requestedRoot)];
}
