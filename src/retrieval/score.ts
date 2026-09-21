import type { SearchConfig } from '../config/types.js';
import { isConfigPath, isTestPath, parseChunkExtraMetadata } from '../chunker/chunkMetadata.js';
import { estimateTokensFromChars } from '../utils/tokens.js';
import type { ChunkSearchResult } from '../vector-store/schema.js';
import type { CandidateSource, RetrievalCandidate, RetrievalScore } from './types.js';

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

export function basenameMatchScore(filePath: string, queryLower: string): number {
  const base = filePath.replaceAll('\\', '/').split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
  const normalizedBase = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalizedBase.length < 4) return 0;
  const compactQuery = queryLower.toLowerCase().replace(/[^a-z0-9]/g, '');
  return compactQuery.includes(normalizedBase) ? 1 : 0;
}

export function pathScore(filePath: string, queryLower: string): number {
  const path = filePath.toLowerCase().replaceAll('\\', '/');
  if (basenameMatchScore(filePath, queryLower) === 1) return 1;
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

export function recencyScore(lastIndexedAt: string | null, now = Date.now()): number {
  if (!lastIndexedAt) return 0;
  const then = Date.parse(lastIndexedAt);
  if (!Number.isFinite(then)) return 0;
  const ageMs = Math.max(0, now - then);
  const week = 7 * 24 * 60 * 60 * 1000;
  return clamp01(1 - ageMs / week);
}

export function symbolMatchScore(
  record: { symbol_name: string | null; parent_symbol: string | null },
  queryLower: string
): number {
  const name = record.symbol_name?.toLowerCase();
  if (name && queryLower.includes(name)) return 1;
  const parent = record.parent_symbol?.toLowerCase();
  if (parent && queryLower.includes(parent)) return 0.5;
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
  queryLower: string
): RetrievalCandidate {
  const extra = parseChunkExtraMetadata(record.extra_metadata);
  const isTest = extra.isTest || isTestPath(record.file_path);
  const isConfig = extra.isConfig || isConfigPath(record.file_path);
  extra.isTest = isTest;
  extra.isConfig = isConfig;
  const symbol = parts.symbol ?? symbolMatchScore(record, queryLower);
  const path = clamp01(parts.path ?? pathScore(record.file_path, queryLower));
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
  const score = buildRetrievalScore(scoreParts, weights);
  const exactSymbol = symbol === 1;
  const exactBasename = parts.path === 1 || basenameMatchScore(record.file_path, queryLower) === 1;
  if (exactSymbol) score.total = Math.max(score.total, 0.95);
  else if (parts.exactIdentifier) score.total = Math.max(score.total, 0.82 + 0.13 * scoreParts.keyword);
  else if (exactBasename) score.total = Math.max(score.total, 0.9);
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
    estimatedTokens: estimateTokensFromChars(record.content.length),
    reason: exactSymbol
      ? `exact symbol match: ${record.symbol_name}`
      : parts.exactIdentifier
        ? parts.reason
      : exactBasename
        ? `exact file match: ${record.file_path}`
        : parts.reason
  };
}
