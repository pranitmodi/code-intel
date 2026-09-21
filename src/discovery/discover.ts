import { readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ignoreFactory from 'ignore';
import { DEFAULT_IGNORE_PATTERNS, SECRET_FILE_PATTERNS } from './default-ignore.js';
import { isGitRoot } from './gitRoots.js';

export interface DiscoveredFile {
  absolutePath: string;
  /** POSIX-style (forward slash) path relative to the repo root. */
  relativePath: string;
}

export interface DiscoveryOptions {
  allowSensitiveFiles: boolean;
  extraIgnorePatterns: string[];
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function loadGitignore(repoRoot: string): string[] {
  const gitignorePath = join(repoRoot, '.gitignore');
  if (!existsSync(gitignorePath)) return [];
  return readFileSync(gitignorePath, 'utf-8').split('\n');
}

export function isIndexableRelativePath(repoRoot: string, relativePath: string, options: DiscoveryOptions): boolean {
  const posixPath = toPosix(relativePath);
  if (!posixPath || posixPath.startsWith('../') || posixPath === '..') return false;
  const ig = ignoreFactory()
    .add(DEFAULT_IGNORE_PATTERNS)
    .add(loadGitignore(repoRoot))
    .add(options.extraIgnorePatterns);
  if (ig.ignores(posixPath)) return false;
  if (!options.allowSensitiveFiles && ignoreFactory().add(SECRET_FILE_PATTERNS).ignores(posixPath)) return false;
  return true;
}

/**
 * Recursively discovers candidate files under `repoRoot`, respecting
 * `.gitignore`, built-in default exclusions, user-configured extra patterns,
 * and (unless `allowSensitiveFiles`) secret-file patterns. Symlinks are
 * skipped to avoid escaping the repo root or following cycles.
 */
export async function discoverFiles(repoRoot: string, options: DiscoveryOptions): Promise<DiscoveredFile[]> {
  const ig = ignoreFactory()
    .add(DEFAULT_IGNORE_PATTERNS)
    .add(loadGitignore(repoRoot))
    .add(options.extraIgnorePatterns);
  const secretIg = ignoreFactory().add(SECRET_FILE_PATTERNS);

  const results: DiscoveredFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission errors etc. — skip unreadable directories rather than aborting the whole walk
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const absolutePath = join(dir, entry.name);
      const relativePath = toPosix(relative(repoRoot, absolutePath));

      if (entry.isDirectory()) {
        if (ig.ignores(`${relativePath}/`)) continue;
        // A nested Git repository owns its own vector collection. Indexing it
        // here as well would duplicate data and blur repository boundaries.
        if (isGitRoot(absolutePath)) continue;
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (ig.ignores(relativePath)) continue;
      if (!options.allowSensitiveFiles && secretIg.ignores(relativePath)) continue;

      results.push({ absolutePath, relativePath });
    }
  }

  await walk(repoRoot);
  return results;
}
