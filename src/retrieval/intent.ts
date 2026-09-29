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
  /**
   * Tokens shaped like code rather than prose — backticked spans, CLI command
   * names, `--flags`, ENV_KEYS, snake_case and lowerCamel identifiers. Only
   * these may be treated as exact identifiers when no symbol defines them.
   */
  exactTerms: string[];
  files: string[];
  likelyLanguages: string[];
  operations: RetrievalOperation[];
  requestedContext: ContextMode;
  /** Separate parts of the request (clauses and list items); broad tasks get more room. */
  clauses: number;
}

const FILE_RE = /(?:[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs|c|h|cpp|swift|md|json|ya?ml|toml))(?![\w])/gi;
const QUOTED = /['"`]([A-Za-z_-][\w./-]*)['"`]/g;
const IDENT = /\b([A-Z][A-Za-z0-9]+|[a-z][a-zA-Z0-9]{2,}|[a-z]+(?:_[a-z0-9]+)+)\b/g;
const ENV_KEY = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const FLAG = /(?:^|[\s(`'"])(--[a-z][a-z0-9-]*)/g;
/**
 * `code-intel vscode-install`, `npm run build`: the word after a program name
 * is a command when it is hyphenated or the span is backticked; in running
 * prose ("how does code-intel stop agents") the next word is just a verb.
 */
const COMMAND_AFTER_PROGRAM = /`(?:code-intel|npm run|npx|pnpm|yarn)\s+([a-z][a-z0-9]*(?:-[a-z0-9]+)*)|\b(?:code-intel|npm run|npx|pnpm|yarn)\s+([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g;
const SNAKE = /^[a-z]+(?:_[a-z0-9]+)+$/;
const LOWER_CAMEL = /^[a-z]+[a-z0-9]*[A-Z][A-Za-z0-9]*$/;
const CLAUSE_SPLIT = /[,;:\n]|\s(?:and|or|plus|also|then)\s|\?\s|\.\s/i;

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
  'would',
  'explain',
  'versus',
  'happens',
  'which',
  'there',
  'their',
  'about',
  'other',
  'using'
]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Words joined to a neighbour by a hyphen in running text ("OpenAI-compatible",
 * "multi-root") are prose, not identifiers, unless the span was backticked.
 */
function hyphenatedProseWords(rawQuery: string, quoted: Set<string>): Set<string> {
  const words = new Set<string>();
  for (const match of rawQuery.matchAll(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g)) {
    if (quoted.has(match[0]) || match[0].startsWith('-')) continue;
    for (const part of match[0].split('-')) words.add(part);
  }
  return words;
}

/** Case-boundary parts that contain lowercase letters: `OpenAICompatibleProvider` has 3, `OpenAI` 1. */
function lowercaseHumps(token: string): number {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .filter((part) => /[a-z]/.test(part)).length;
}

/** snake_case, lowerCamel, or PascalCase with at least two worded humps (`LanceVectorStore`, not `OpenAI` or `MCP`). */
function looksLikeCodeIdentifier(token: string): boolean {
  return SNAKE.test(token) || LOWER_CAMEL.test(token) || (/^[A-Z]/.test(token) && lowercaseHumps(token) >= 2);
}

export function countClauses(rawQuery: string): number {
  return rawQuery
    .split(CLAUSE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).length >= 2).length;
}

export function analyzeQuery(rawQuery: string, mode?: ContextMode): RetrievalIntent {
  const files = unique([...rawQuery.matchAll(FILE_RE)].map((m) => m[0]));
  const quoted = unique([...rawQuery.matchAll(QUOTED)].map((m) => m[1] ?? ''));
  const quotedSet = new Set(quoted);
  const prose = hyphenatedProseWords(rawQuery, quotedSet);
  const envKeys = unique([...rawQuery.matchAll(ENV_KEY)].map((m) => m[0]));
  const flags = unique([...rawQuery.matchAll(FLAG)].map((m) => m[1] ?? ''));
  const commands = unique([...rawQuery.matchAll(COMMAND_AFTER_PROGRAM)].map((m) => m[1] ?? m[2] ?? ''));
  const identifiers = unique(
    [...rawQuery.matchAll(IDENT)]
      .map((m) => m[1] ?? '')
      .filter((token) => !STOP.has(token.toLowerCase()))
  );

  const symbols = unique([
    ...quoted.filter((t) => /^[A-Za-z_][\w]*$/.test(t)),
    ...identifiers.filter((t) => !prose.has(t) && looksLikeCodeIdentifier(t)),
    ...envKeys
  ]);

  const exactTerms = unique([
    ...quoted.filter((t) => !files.includes(t)),
    ...commands,
    ...flags,
    ...envKeys,
    ...identifiers.filter((t) => !prose.has(t) && (SNAKE.test(t) || LOWER_CAMEL.test(t)))
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

  const symbolSet = new Set(symbols.map((s) => s.toLowerCase()));
  const concepts = unique(
    identifiers
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 4 && !symbolSet.has(t))
  );

  return {
    rawQuery,
    concepts,
    symbols,
    exactTerms,
    files,
    likelyLanguages,
    operations,
    requestedContext,
    clauses: countClauses(rawQuery)
  };
}
