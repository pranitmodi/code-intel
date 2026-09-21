import { posix } from 'node:path';

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/**
 * Turn a relative import specifier into candidate repo-relative file paths.
 * Package imports (not starting with `.`) are ignored.
 */
export function candidateImportPaths(fromFile: string, spec: string): string[] {
  const trimmed = spec.trim();
  if (!trimmed.startsWith('.')) return [];

  const from = fromFile.replaceAll('\\', '/');
  const dir = posix.dirname(from);
  const joined = posix.normalize(posix.join(dir, trimmed));
  if (joined.startsWith('../') || joined === '..' || joined.startsWith('/')) return [];

  const stripped = joined.replace(/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i, '');
  const paths = new Set<string>([joined, stripped]);
  for (const ext of SOURCE_EXTS) {
    paths.add(stripped + ext);
  }
  paths.add(posix.join(stripped, 'index.ts'));
  paths.add(posix.join(stripped, 'index.tsx'));
  paths.add(posix.join(stripped, 'index.js'));
  return [...paths];
}

export function importPathSqlList(fromFile: string, spec: string): string {
  return candidateImportPaths(fromFile, spec)
    .map((path) => `'${path.replace(/'/g, "''")}'`)
    .join(', ');
}
