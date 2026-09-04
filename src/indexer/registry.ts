import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { computeRepoId } from '../utils/repo-id.js';
import { readState } from './state.js';

export interface RegistryEntry {
  id: string;
  path: string;
  name: string;
  lastIndexedAt: string | null;
  filesIndexed: number;
  chunksIndexed: number;
  embeddingModel: string | null;
}

export interface RegistryFile {
  repos: RegistryEntry[];
}

export function registryPath(databasePath: string): string {
  return join(databasePath, 'registry.json');
}

export function readRegistry(databasePath: string): RegistryFile {
  const path = registryPath(databasePath);
  if (!existsSync(path)) return { repos: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as RegistryFile;
    if (!parsed || !Array.isArray(parsed.repos)) return { repos: [] };
    return parsed;
  } catch {
    return { repos: [] };
  }
}

export function writeRegistry(databasePath: string, registry: RegistryFile): void {
  mkdirSync(databasePath, { recursive: true });
  writeFileSync(registryPath(databasePath), JSON.stringify(registry, null, 2));
}

export function upsertRegistryEntry(databasePath: string, entry: RegistryEntry): void {
  const registry = readRegistry(databasePath);
  const index = registry.repos.findIndex((repo) => repo.id === entry.id);
  if (index >= 0) registry.repos[index] = entry;
  else registry.repos.push(entry);
  writeRegistry(databasePath, registry);
}

export function removeRegistryEntry(databasePath: string, repoId: string): void {
  const registry = readRegistry(databasePath);
  const next = registry.repos.filter((repo) => repo.id !== repoId);
  if (next.length === registry.repos.length) return;
  writeRegistry(databasePath, { repos: next });
}

export function registryEntryFrom(repoRoot: string, repoId: string, extras: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: repoId,
    path: repoRoot,
    name: basename(repoRoot),
    lastIndexedAt: extras.lastIndexedAt ?? null,
    filesIndexed: extras.filesIndexed ?? 0,
    chunksIndexed: extras.chunksIndexed ?? 0,
    embeddingModel: extras.embeddingModel ?? null
  };
}

/**
 * Merge `registry.json` with per-repo `state.json` files so listings stay accurate
 * even if one of the two is missing (legacy indexes, or init-before-index).
 */
export function listIndexedRepos(databasePath: string): RegistryEntry[] {
  const byId = new Map<string, RegistryEntry>();

  for (const entry of readRegistry(databasePath).repos) {
    byId.set(entry.id, entry);
  }

  const reposDir = join(databasePath, 'repos');
  if (existsSync(reposDir)) {
    for (const id of readdirSync(reposDir)) {
      const state = readState(join(reposDir, id, 'state.json'));
      if (!state) continue;
      const existing = byId.get(id);
      byId.set(id, {
        id,
        path: state.repoRoot ?? existing?.path ?? '',
        name: state.repoName ?? existing?.name ?? id,
        lastIndexedAt: state.lastIndexedAt,
        filesIndexed: state.filesIndexed,
        chunksIndexed: state.chunksIndexed,
        embeddingModel: state.embeddingModel
      });
    }
  }

  return [...byId.values()]
    .filter((entry) => entry.path.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a user-supplied repo id, basename, or filesystem path against the registry. */
export function resolveRepoRef(databasePath: string, ref: string, defaultRepoRoot?: string): RegistryEntry | undefined {
  const repos = listIndexedRepos(databasePath);
  const trimmed = ref.trim();
  if (!trimmed) return undefined;

  const byId = repos.find((repo) => repo.id === trimmed);
  if (byId) return byId;

  const lower = trimmed.toLowerCase();
  const nameMatches = repos.filter((repo) => repo.name.toLowerCase() === lower);
  if (nameMatches.length === 1) return nameMatches[0];

  const asPath = safeResolvePath(trimmed, defaultRepoRoot);
  if (asPath) {
    const exact = repos.find((repo) => repo.path === asPath);
    if (exact) return exact;
    try {
      const id = computeRepoId(asPath);
      const byComputedId = repos.find((repo) => repo.id === id);
      if (byComputedId) return byComputedId;
    } catch {
      // path does not exist on disk
    }
  }

  return repos.find((repo) => repo.path.endsWith(`${sep}${trimmed}`) || repo.path.endsWith(`/${trimmed}`));
}

export function indexedChildrenOf(databasePath: string, parentRoot: string): RegistryEntry[] {
  const parent = resolve(parentRoot);
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return listIndexedRepos(databasePath).filter((repo) => {
    if (!repo.path) return false;
    return repo.path === parent || repo.path.startsWith(prefix);
  });
}

function safeResolvePath(ref: string, defaultRepoRoot?: string): string | undefined {
  try {
    if (ref.startsWith('/') || /^[A-Za-z]:[\\/]/.test(ref)) return resolve(ref);
    if (defaultRepoRoot) return resolve(defaultRepoRoot, ref);
    return resolve(ref);
  } catch {
    return undefined;
  }
}
