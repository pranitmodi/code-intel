import type { SearchConfig } from '../config/types.js';
import { isConfigPath, isTestPath, parseChunkExtraMetadata } from '../chunker/chunkMetadata.js';
import { clockNow } from '../utils/clock.js';
import { estimateTokensFromChars } from '../utils/tokens.js';
import type { ChunkSearchResult } from '../vector-store/schema.js';
import { isDocPath, proseWeightFor } from './docs.js';
import type { CandidateSource, RetrievalCandidate, RetrievalScore } from './types.js';

export const EXACT_SYMBOL_FLOOR = 0.95;
/** Weight of test chunks when the task does not ask about tests. */
const TEST_WEIGHT_UNASKED = 0.85;
const NAMED_BY_WORDS = 0.8;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function qualifiedSymbolName(
  symbolName: string | null | undefined,
  parentSymbol: string | null | undefined
): string | null {
  if (!symbolName) return null;
  return parentSymbol ? `${parentSymbol}.${symbolName}` : symbolName;
}

const PATH_QUERY_STOP = new Set([
  'add',
  'and',
  'does',
  'find',
  'fix',
  'how',
  'implemented',
  'implementation',
  'into',
  'the',
  'update',
  'where',
  'with'
]);

function identifierParts(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !PATH_QUERY_STOP.has(token));
}

function queryWords(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** True when `compact` is one query word or several consecutive ones ("task context", "task_context"). */
function queryNames(words: string[], compact: string): boolean {
  for (let start = 0; start < words.length; start++) {
    let joined = '';
    for (let end = start; end < words.length && joined.length < compact.length; end++) {
      joined += words[end];
      if (joined === compact) return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Basenames that name a role rather than a feature, so a query saying "index" or "types" is not asking for them. */
const GENERIC_STEMS = new Set([
  'app', 'base', 'common', 'config', 'constant', 'core', 'data', 'default', 'file', 'helper', 'index',
  'init', 'lib', 'main', 'mod', 'model', 'setup', 'shared', 'spec', 'test', 'type', 'util'
]);

const DATA_FILE = /\.(?:json|jsonc|ya?ml|toml|ini|xml|csv|lock|env)$/i;

function singular(word: string): string {
  return word.length > 3 ? word.replace(/s$/, '') : word;
}

/** Plain words only: "get_task_context" or "src/index.ts" do not contribute "context" or "index". */
function standaloneWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.replace(/^[./-]+|[./-]+$/g, ''))
    .filter((token) => token && !/[_./]/.test(token))
    .flatMap((token) => token.split('-'))
    .filter(Boolean);
}

/** What a query's words point at beyond the query itself. */
export interface QueryNaming {
  /**
   * Words that name exactly one code file by its stem ("jsonc"). A one-word
   * file stem counts as named by the query only when it is specific like this,
   * or the file's directory is named too; "server" or "paths" alone are not.
   */
  specificStems?: ReadonlySet<string>;
}

function directoryWords(filePath: string): string[] {
  const parts = filePath.replaceAll('\\', '/').split('/');
  parts.pop();
  return parts.flatMap((part) =>
    part
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 2 && !GENERIC_STEMS.has(singular(word)) && word !== 'src')
  );
}

/**
 * 1 when the query names this file: its full file name ("hybrid.ts"), or a
 * multi-word basename written as one identifier or as consecutive words.
 * NAMED_BY_WORDS when every word of the basename appears as a query word
 * ("skill instructions" for skill.ts). Substrings ("discoverable" for
 * discover.ts) and generic basenames ("index", "types") do not count, and a
 * one-word basename counts only when `naming` says the word is specific to it
 * or the query also names its directory ("vscode install" for vscode/install.ts).
 */
export function basenameMatchScore(filePath: string, queryLower: string, naming: QueryNaming = {}): number {
  const fileName = (filePath.replaceAll('\\', '/').split('/').pop() ?? '').toLowerCase();
  const query = queryLower.toLowerCase();
  if (fileName.includes('.') && fileName.length >= 4) {
    if (new RegExp(`(?:^|[^a-z0-9_-])${escapeRegExp(fileName)}(?![a-z0-9_-])`).test(query)) return 1;
  }
  const stem = (filePath.replaceAll('\\', '/').split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  const parts = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compact = parts.join('');
  if (parts.length >= 2 && compact.length >= 6 && queryNames(queryWords(query), compact)) return 1;
  if (DATA_FILE.test(fileName)) return 0;
  const specific = parts.map(singular).filter((part) => !GENERIC_STEMS.has(part));
  if (specific.length === 0 || (parts.length === 1 && compact.length < 4)) return 0;
  const present = new Set(standaloneWords(query).map(singular));
  if (!parts.every((part) => present.has(singular(part)))) return 0;
  if (parts.length >= 2) return NAMED_BY_WORDS;
  const word = singular(parts[0]!);
  const directoryNamed = directoryWords(filePath).some((dir) => present.has(singular(dir)));
  return directoryNamed || naming.specificStems?.has(word) ? NAMED_BY_WORDS : 0;
}

export function pathScore(filePath: string, queryLower: string, naming: QueryNaming = {}): number {
  const path = filePath.toLowerCase().replaceAll('\\', '/');
  if (basenameMatchScore(filePath, queryLower, naming) > 0) return 1;
  const tokens = identifierParts(queryLower);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (path.includes(token)) hits += 1;
  }
  return clamp01(hits / tokens.length);
}

export function structuralScore(record: {
  symbol_name: string | null;
  parent_symbol: string | null;
}): number {
  if (record.symbol_name && record.parent_symbol) return 1;
  if (record.symbol_name) return 0.7;
  if (record.parent_symbol) return 0.4;
  return 0;
}

export function recencyScore(lastIndexedAt: string | null, now = clockNow()): number {
  if (!lastIndexedAt) return 0;
  const then = Date.parse(lastIndexedAt);
  if (!Number.isFinite(then)) return 0;
  const ageMs = Math.max(0, now - then);
  const week = 7 * 24 * 60 * 60 * 1000;
  return clamp01(1 - ageMs / week);
}

/**
 * Whether the query names a registered command or tool: a hyphenated or
 * underscored name as a whole token (`vscode-install`, `search_codebase`); a
 * plain word only when written as a command — backticked, after the program
 * name, or next to "command"/"tool". "the savings report" does not name the
 * `savings` command, and "get_task_context" does not name `context`.
 */
function commandNamedIn(name: string, queryLower: string): boolean {
  const w = escapeRegExp(name);
  if (/[-_]/.test(name)) return new RegExp(`(?:^|[^a-z0-9_-])${w}(?:$|[^a-z0-9_-])`).test(queryLower);
  return (
    queryLower.includes('`' + name + '`') ||
    new RegExp(`\\b(?:code-intel|npm run|npx|yarn|pnpm)\\s+${w}\\b`).test(queryLower) ||
    new RegExp(`\\b${w}\\s+(?:command|subcommand|tool)\\b`).test(queryLower) ||
    new RegExp(`\\b(?:command|subcommand|tool)\\s+${w}\\b`).test(queryLower)
  );
}

/** Symbol kinds that define something, as opposed to a constant, gap block, registration, or test. */
const DECLARATION_TYPES = new Set(['function', 'class', 'method', 'interface', 'type', 'enum', 'namespace']);

/**
 * How the query names a symbol: `literal` when it writes the identifier as
 * code — one word (`searchCodebase`) or words joined by `_`/`-`
 * (`get_task_context` for `getTaskContext`) — and `joined` when separate prose
 * words happen to concatenate to it ("task context" for `TaskContext`).
 */
function symbolNaming(symbol: string, queryLower: string): 'literal' | 'joined' | null {
  const compact = symbol.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact.length < 3) return null;
  const tokens = [...queryLower.matchAll(/[a-z0-9]+/g)].map((match) => ({ word: match[0], start: match.index ?? 0 }));
  for (let first = 0; first < tokens.length; first++) {
    let joined = '';
    for (let last = first; last < tokens.length && joined.length < compact.length; last++) {
      joined += tokens[last]!.word;
      if (joined !== compact) continue;
      for (let i = first; i < last; i++) {
        const gap = queryLower.slice(tokens[i]!.start + tokens[i]!.word.length, tokens[i + 1]!.start);
        if (!/^[_-]$/.test(gap)) return 'joined';
      }
      return 'literal';
    }
  }
  return null;
}

function symbolNamedIn(symbol: string | null | undefined, words: string[]): boolean {
  const compact = symbol?.toLowerCase().replace(/[^a-z0-9]/g, '');
  return Boolean(compact && compact.length >= 3 && queryNames(words, compact));
}

/** `vscodeInstall`, `get_task_context`, `vscode-install`, `LanceVectorStore`: more than one plain word. */
function codeShapedName(name: string): boolean {
  return /[_\-\d]/.test(name) || /[a-z][A-Z]/.test(name) || /[A-Z][a-z]+[A-Z]/.test(name);
}

/** The query treats `word` as code: backticked, called, or asked about as a definition ("where is run defined"). */
function namedAsSymbol(word: string, queryLower: string): boolean {
  if (queryLower.includes('`' + word + '`') || queryLower.includes(word + '(')) return true;
  const w = escapeRegExp(word);
  return (
    new RegExp(`\\b(?:where is|where's|find|locate|definition of|implementation of|function|method|class|symbol)\\s+${w}\\b`).test(queryLower) ||
    new RegExp(`\\b${w}\\s+(?:is\\s+)?(?:defined|implemented|declared|function|method|class)\\b`).test(queryLower)
  );
}

/**
 * Symbols must appear as whole words, so `run` does not match "running". A
 * symbol that is one plain word (`User`, `run`) matched by prose ("user
 * versus workspace") is only partial evidence unless the query writes it as
 * code (backticked or called). Test titles are prose and never match.
 */
export function symbolMatchScore(
  record: { symbol_name: string | null; parent_symbol: string | null; symbol_type?: string | null; file_path?: string },
  queryLower: string
): number {
  if (record.symbol_type === 'test') return 0;
  const words = queryWords(queryLower);
  const name = record.symbol_name;
  const naming = name ? symbolNaming(name, queryLower) : null;
  if (name && naming) {
    const lower = name.toLowerCase();
    // A registered command or tool is named by its exact string ("vscode-install",
    // "search_codebase"), not by an identifier that compacts the same way (`searchCodebase`).
    if (record.symbol_type === 'command') return commandNamedIn(lower, queryLower) ? 1 : 0.5;
    // Prose words that happen to join into a name ("embedding model" -> `embeddingModel`)
    // only point at declarations in source, not at a local constant in a test.
    const inTest = record.file_path ? isTestPath(record.file_path) : false;
    const declaration = record.symbol_type === undefined || DECLARATION_TYPES.has(record.symbol_type ?? '');
    if (naming === 'joined' && (!declaration || inTest)) return 0.5;
    if (inTest && !namedAsSymbol(lower, queryLower)) return 0.5;
    return codeShapedName(name) || namedAsSymbol(lower, queryLower) ? 1 : 0.5;
  }
  if (symbolNamedIn(record.parent_symbol, words)) return 0.5;
  return 0;
}

export function combineScore(parts: Omit<RetrievalScore, 'total'>, weights: SearchConfig): number {
  return clamp01(
    weights.vectorWeight * parts.semantic +
      weights.keywordWeight * parts.keyword +
      weights.symbolWeight * parts.symbol +
      weights.pathWeight * parts.path +
      weights.structuralWeight * parts.structural +
      weights.dependencyWeight * parts.dependency +
      weights.referenceWeight * parts.reference +
      weights.testWeight * parts.test +
      weights.recencyWeight * parts.recency
  );
}

export function buildRetrievalScore(
  parts: Omit<RetrievalScore, 'total'>,
  weights: SearchConfig
): RetrievalScore {
  const total = Math.round(combineScore(parts, weights) * 1000) / 1000;
  return { total, ...parts };
}

/** Weighted signals scaled by `factor`, never below the exact-match floor. */
function scoredParts(
  parts: Omit<RetrievalScore, 'total'>,
  weights: SearchConfig,
  exactFloor = 0,
  factor = 1
): RetrievalScore {
  const weighted = Math.round(combineScore(parts, weights) * factor * 1000) / 1000;
  return { total: Math.max(weighted, Math.round(exactFloor * 1000) / 1000), ...parts };
}

export function candidateFromRecord(
  record: ChunkSearchResult,
  parts: {
    semantic: number;
    keyword: number;
    symbol?: number;
    path?: number;
    dependency?: number;
    reference?: number;
    exactIdentifier?: boolean;
    sources: CandidateSource[];
    reason: string;
  },
  weights: SearchConfig,
  queryLower: string,
  naming: QueryNaming = {}
): RetrievalCandidate {
  const extra = parseChunkExtraMetadata(record.extra_metadata);
  const isTest = extra.isTest || isTestPath(record.file_path);
  const isConfig = extra.isConfig || isConfigPath(record.file_path);
  extra.isTest = isTest;
  extra.isConfig = isConfig;
  const symbol = parts.symbol ?? symbolMatchScore(record, queryLower);
  const path = clamp01(parts.path ?? pathScore(record.file_path, queryLower, naming));
  const wantsTests = /\b(test|tests|spec|coverage)\b/i.test(queryLower);
  const scoreParts = {
    semantic: clamp01(parts.semantic),
    keyword: clamp01(parts.keyword),
    symbol,
    path,
    structural: structuralScore(record),
    dependency: clamp01(parts.dependency ?? 0),
    reference: clamp01(parts.reference ?? 0),
    test: isTest && wantsTests ? 1 : 0,
    recency: recencyScore(record.last_indexed_at)
  };
  const prose = isDocPath(record.file_path);
  // Tests restate behaviour in plain words, so unless the task asks for tests
  // they would outrank the code they exercise on "how does X work" questions.
  const proseWeight = prose ? proseWeightFor(queryLower) : isTest && !wantsTests ? TEST_WEIGHT_UNASKED : 1;
  const exactSymbol = symbol === 1 && proseWeight === 1;
  const exactIdentifier = Boolean(parts.exactIdentifier) && proseWeight === 1;
  const named = basenameMatchScore(record.file_path, queryLower, naming);
  const exactBasename = parts.path === 1 || named === 1;
  const namedByWords = !exactBasename && !prose && named === NAMED_BY_WORDS;
  const exactFloor = exactSymbol
    ? EXACT_SYMBOL_FLOOR
    : exactIdentifier
      ? 0.82 + 0.13 * scoreParts.keyword
      : exactBasename
        ? 0.9
        : namedByWords
          ? NAMED_BY_WORDS
          : 0;
  const scoreFactor = exactBasename ? 1 : proseWeight;
  const score = scoredParts(scoreParts, weights, exactFloor, scoreFactor);
  return {
    id: record.id,
    file: record.file_path,
    symbol: qualifiedSymbolName(record.symbol_name, record.parent_symbol),
    symbolType: record.symbol_type,
    parentSymbol: record.parent_symbol,
    startLine: record.start_line,
    endLine: record.end_line,
    content: record.content,
    lastIndexedAt: record.last_indexed_at,
    extra,
    sources: parts.sources,
    score,
    ...(exactFloor > 0 ? { exactFloor } : {}),
    estimatedTokens: estimateTokensFromChars(record.content.length),
    reason: exactSymbol
      ? `exact symbol match: ${record.symbol_name}`
      : exactIdentifier
        ? parts.reason
      : exactBasename
        ? `exact file match: ${record.file_path}`
        : namedByWords
          ? `file named in query: ${record.file_path}`
          : parts.reason
  };
}
