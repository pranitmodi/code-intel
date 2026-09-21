import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

export interface PathAlias {
  prefix: string;
  targets: string[];
}

function withSourceExtensions(base: string): string[] {
  const stripped = base.replace(/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i, '');
  const paths = new Set<string>([base, stripped]);
  for (const ext of SOURCE_EXTS) paths.add(stripped + ext);
  paths.add(posix.join(stripped, 'index.ts'));
  paths.add(posix.join(stripped, 'index.tsx'));
  paths.add(posix.join(stripped, 'index.js'));
  return [...paths].filter((path) => !path.startsWith('../') && path !== '..' && !path.startsWith('/'));
}

function pythonModuleFiles(modulePath: string): string[] {
  const normalized = modulePath.replace(/^\//, '');
  if (!normalized || normalized.startsWith('..')) return [];
  return [`${normalized}.py`, posix.join(normalized, '__init__.py')];
}

/** Load `compilerOptions.paths` from tsconfig/jsconfig at the repo root. */
export function loadTsPathAliases(repoRoot: string): PathAlias[] {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = join(repoRoot, name);
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const parsed = JSON.parse(raw) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const paths = parsed.compilerOptions?.paths;
      if (!paths) continue;
      const baseUrl = (parsed.compilerOptions?.baseUrl ?? '.').replace(/\\/g, '/').replace(/\/$/, '');
      const aliases: PathAlias[] = [];
      for (const [pattern, targets] of Object.entries(paths)) {
        const prefix = pattern.replace(/\*$/, '').replace(/\\/g, '/');
        aliases.push({
          prefix,
          targets: targets.map((target) => {
            const mapped = target.replace(/\*$/, '').replace(/\\/g, '/');
            return posix.normalize(baseUrl === '.' ? mapped : posix.join(baseUrl, mapped));
          })
        });
      }
      return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * Turn an import specifier into candidate repo-relative file paths.
 * Handles relative JS/TS, tsconfig path aliases, and Python dotted modules.
 */
export function candidateImportPaths(
  fromFile: string,
  spec: string,
  aliases: PathAlias[] = []
): string[] {
  const trimmed = spec.trim().replace(/['"]/g, '');
  if (!trimmed) return [];
  const from = fromFile.replaceAll('\\', '/');
  const python = from.endsWith('.py');

  if (trimmed.startsWith('.')) {
    const dir = posix.dirname(from);
    if (python) {
      const dots = trimmed.match(/^(\.+)/)?.[1]?.length ?? 1;
      const rest = trimmed.slice(dots).replaceAll('.', '/');
      let base = dir;
      for (let i = 0; i < dots - 1; i++) base = posix.dirname(base);
      const joined = rest ? posix.normalize(posix.join(base, rest)) : base;
      if (joined.startsWith('../') || joined === '..' || joined.startsWith('/')) return [];
      return pythonModuleFiles(joined);
    }
    const joined = posix.normalize(posix.join(dir, trimmed));
    if (joined.startsWith('../') || joined === '..' || joined.startsWith('/')) return [];
    return withSourceExtensions(joined);
  }

  for (const alias of aliases) {
    if (trimmed === alias.prefix || trimmed.startsWith(alias.prefix)) {
      const rest = trimmed.slice(alias.prefix.length);
      const mapped: string[] = [];
      for (const target of alias.targets) {
        mapped.push(...withSourceExtensions(posix.normalize(posix.join(target, rest))));
      }
      if (mapped.length > 0) return mapped;
    }
  }

  if (python && trimmed.includes('.')) {
    return pythonModuleFiles(trimmed.replaceAll('.', '/'));
  }

  return [];
}

export function importPathSqlList(fromFile: string, spec: string, aliases: PathAlias[] = []): string {
  return candidateImportPaths(fromFile, spec, aliases)
    .map((path) => `'${path.replace(/'/g, "''")}'`)
    .join(', ');
}
