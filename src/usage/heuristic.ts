import { basename, resolve } from 'node:path';
import { listIndexedRepos } from '../indexer/registry.js';
import { readBenchmark, usageHome } from './store.js';

/**
 * Typical glob + `rg -C 2` + 12 file reads, fit from the 2026-09-07 A/B on
 * LocalCodeDB + Savor repos. Prefer a stored benchmark average when present.
 */
export function estimateNaiveDiscoveryTokens(filesIndexed: number): number {
  const grepDump = Math.min(15_000, 400 + filesIndexed * 12);
  const fileReads = Math.min(70_000, 2_000 + filesIndexed * 80);
  const globList = Math.min(8_000, 200 + filesIndexed * 8);
  return globList + grepDump + fileReads;
}

export function baselineTokensForRepo(repoPath: string | undefined, filesIndexed?: number): number {
  const home = usageHome();
  const benchmark = readBenchmark(home);
  if (repoPath && benchmark) {
    const resolved = resolve(repoPath);
    const match = benchmark.repos.find(
      (repo) => resolve(repo.path) === resolved || repo.name === basename(repoPath)
    );
    if (match?.queries.length) {
      const sum = match.queries.reduce((acc, q) => acc + q.naiveAgentTokens, 0);
      return Math.round(sum / match.queries.length);
    }
    if (benchmark.repos.length) {
      const queries = benchmark.repos.flatMap((repo) => repo.queries);
      if (queries.length) {
        return Math.round(queries.reduce((acc, q) => acc + q.naiveAgentTokens, 0) / queries.length);
      }
    }
  }

  if (filesIndexed != null) return estimateNaiveDiscoveryTokens(filesIndexed);

  if (repoPath) {
    const entry = listIndexedRepos(home).find((repo) => {
      if (!repo.path) return false;
      const root = resolve(repo.path);
      const candidate = resolve(repoPath);
      return candidate === root || candidate.startsWith(`${root}/`);
    });
    if (entry) return estimateNaiveDiscoveryTokens(entry.filesIndexed);
  }

  return estimateNaiveDiscoveryTokens(120);
}

export function filesIndexedForPath(repoPath: string | undefined): number | undefined {
  if (!repoPath) return undefined;
  const candidate = resolve(repoPath);
  const entry = listIndexedRepos(usageHome()).find((repo) => {
    if (!repo.path) return false;
    const root = resolve(repo.path);
    return candidate === root || candidate.startsWith(`${root}/`);
  });
  return entry?.filesIndexed;
}
