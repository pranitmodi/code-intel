import type { ContextMode } from './types.js';

export type RetrievalOperation =
  | 'find_implementation'
  | 'find_tests'
  | 'find_config'
  | 'find_references'
  | 'find_dependencies';

export interface RetrievalIntent {
  rawQuery: string;
  concepts: string[];
  symbols: string[];
  files: string[];
  likelyLanguages: string[];
  operations: RetrievalOperation[];
  requestedContext: ContextMode;
}

const FILE_RE = /(?:[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs|c|h|cpp|swift|md|json|ya?ml|toml))/gi;
const QUOTED = /['"`]([A-Za-z_][\w./-]*)['"`]/g;
const IDENT = /\b([A-Z][A-Za-z0-9]+|[a-z][a-zA-Z0-9]{2,}|[a-z]+(?:_[a-z0-9]+)+)\b/g;
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  md: 'markdown',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml'
};

const STOP = new Set([
  'the',
  'and',
  'for',
  'that',
  'with',
  'this',
  'from',
  'into',
  'when',
  'where',
  'what',
  'how',
  'does',
  'add',
  'fix',
  'update',
  'remove',
  'refactor',
  'find',
  'tests',
  'test',
  'config',
  'please',
  'should',
  'could',
  'would'
]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function analyzeQuery(rawQuery: string, mode?: ContextMode): RetrievalIntent {
  const files = unique([...rawQuery.matchAll(FILE_RE)].map((m) => m[0]));
  const quoted = unique([...rawQuery.matchAll(QUOTED)].map((m) => m[1] ?? ''));
  const identifiers = unique(
    [...rawQuery.matchAll(IDENT)]
      .map((m) => m[1] ?? '')
      .filter((token) => !STOP.has(token.toLowerCase()))
  );

  const symbols = unique([
    ...quoted.filter((t) => /^[A-Za-z_][\w]*$/.test(t)),
    ...identifiers.filter((t) => t.includes('_') || /[a-z0-9][A-Z]/.test(t))
  ]);

  const lower = rawQuery.toLowerCase();
  const operations: RetrievalOperation[] = ['find_implementation'];
  if (/\b(test|tests|spec|coverage)\b/.test(lower)) operations.push('find_tests');
  if (/\b(config|configured|configuration|env|dockerfile|yaml|toml)\b/.test(lower)) {
    operations.push('find_config');
  }
  if (/\b(reference|references|callers?|usages?|used by)\b/.test(lower)) operations.push('find_references');
  if (/\b(dependenc|import|caller|callee)\b/.test(lower)) operations.push('find_dependencies');

  let requestedContext: ContextMode = mode ?? 'normal';
  if (!mode) {
    if (/\b(architect|cross-cutting|unfamiliar|deep)\b/.test(lower)) requestedContext = 'deep';
  }

  const likelyLanguages = unique(
    files.map((file) => EXT_TO_LANG[file.split('.').pop()?.toLowerCase() ?? ''] ?? '').filter(Boolean)
  );

  const concepts = unique(
    identifiers
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 4 && !symbols.map((s) => s.toLowerCase()).includes(t))
  );

  return {
    rawQuery,
    concepts,
    symbols,
    files,
    likelyLanguages,
    operations,
    requestedContext
  };
}
