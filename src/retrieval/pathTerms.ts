import { isDocPath } from './docs.js';

/** Path words that name a role rather than a feature, so a query word matching them says nothing. */
const GENERIC_PATH_WORDS = new Set([
  'src', 'lib', 'dist', 'build', 'test', 'tests', 'unit', 'integration', 'spec', 'fixtures', 'index',
  'type', 'types', 'util', 'utils', 'main', 'app', 'common', 'shared', 'core', 'base', 'helper', 'helpers',
  'internal', 'pkg', 'cmd', 'mod', 'docs', 'doc', 'example', 'examples'
]);

const DATA_FILE = /\.(?:json|jsonc|ya?ml|toml|ini|xml|csv|lock|env|txt)$/i;
/** A query word naming more code files than this by file name (or directory) is too generic to follow. */
const MAX_STEM_MATCHES = 3;
const MAX_DIR_MATCHES = 2;

function singular(word: string): string {
  return word.length > 3 ? word.replace(/s$/, '') : word;
}

function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Directory names and the words of the file stem, lowercased. */
export function pathWords(filePath: string): { dirs: string[]; stem: string[] } {
  const parts = filePath.replaceAll('\\', '/').split('/').filter(Boolean);
  const fileName = parts.pop() ?? '';
  const stem = fileName.replace(/\.[^.]+$/, '');
  return { dirs: parts.flatMap(splitWords), stem: splitWords(stem) };
}

/** Source files only: docs, data files, and dot-directories (`.github`, `.cursor`) never point at code. */
export function isCodePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  if (isDocPath(normalized) || DATA_FILE.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment.startsWith('.'));
}

/** Whether `term` is a word of the file stem, a directory name, or neither. */
export function termPathMatch(filePath: string, term: string): 'stem' | 'dir' | null {
  const wanted = singular(term.toLowerCase());
  if (wanted.length < 3 || GENERIC_PATH_WORDS.has(wanted)) return null;
  const { dirs, stem } = pathWords(filePath);
  if (stem.some((word) => singular(word) === wanted)) return 'stem';
  if (dirs.some((word) => singular(word) === wanted)) return 'dir';
  return null;
}

export interface PathTermHit {
  term: string;
  /** 1 when the term names this file alone, falling with the number of files it names. */
  specificity: number;
}

/**
 * Code files named by the query's words. Each word is matched on its own, so a
 * long prompt cannot dilute a word that names a file ("jsonc") or a directory
 * ("vscode"). A word naming several files (by stem) or directories is too
 * generic to follow and is skipped; "editor" should not pull in every editor file.
 */
export function matchPathTerms(paths: string[], terms: string[]): Map<string, PathTermHit> {
  const code = paths.filter(isCodePath);
  const hits = new Map<string, PathTermHit>();
  for (const term of new Set(terms.map((t) => t.toLowerCase()))) {
    const stems: string[] = [];
    const dirs: string[] = [];
    for (const path of code) {
      const match = termPathMatch(path, term);
      if (match === 'stem') stems.push(path);
      else if (match === 'dir') dirs.push(path);
    }
    const matched =
      stems.length > 0 && stems.length <= MAX_STEM_MATCHES
        ? stems
        : stems.length === 0 && dirs.length > 0 && dirs.length <= MAX_DIR_MATCHES
          ? dirs
          : [];
    const specificity = matched.length > 0 ? 1 / matched.length : 0;
    for (const path of matched) {
      const previous = hits.get(path);
      if (!previous || previous.specificity < specificity) hits.set(path, { term, specificity });
    }
  }
  return hits;
}

/**
 * Stem words that name exactly one code file ("jsonc" -> src/editors/jsonc.ts).
 * A query using such a word points at that file; a word shared by several
 * file names ("install", "server") does not.
 */
export function specificStemWords(paths: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    if (!isCodePath(path)) continue;
    for (const word of new Set(pathWords(path).stem.map(singular))) {
      if (word.length < 4 || GENERIC_PATH_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([word]) => word));
}
