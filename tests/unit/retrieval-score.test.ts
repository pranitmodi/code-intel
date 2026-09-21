import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import {
  basenameMatchScore,
  buildRetrievalScore,
  candidateFromRecord,
  combineScore,
  pathScore,
  recencyScore,
  structuralScore,
  symbolMatchScore
} from '../../src/retrieval/score.js';
import type { ChunkSearchResult } from '../../src/vector-store/schema.js';

const weights = DEFAULT_CONFIG.search;

function record(overrides: Partial<ChunkSearchResult> = {}): ChunkSearchResult {
  return {
    id: '1',
    repo_id: 'repo',
    file_path: 'src/search/searchCodebase.ts',
    absolute_path: '/repo/src/search/searchCodebase.ts',
    language: 'typescript',
    symbol_name: 'searchCodebase',
    symbol_type: 'function',
    parent_symbol: null,
    start_line: 1,
    end_line: 10,
    content: 'export function searchCodebase() {}',
    content_hash: 'content',
    file_hash: 'file',
    embedding: [],
    last_indexed_at: null,
    git_commit: null,
    extra_metadata: null,
    ...overrides
  };
}

describe('retrieval scoring', () => {
  it('combines semantic, keyword, and symbol with configured weights', () => {
    const total = combineScore(
      {
        semantic: 1,
        keyword: 0,
        symbol: 0,
        path: 0,
        structural: 0,
        dependency: 0,
        reference: 0,
        test: 0,
        recency: 0
      },
      weights
    );
    expect(total).toBeCloseTo(0.7, 5);
  });

  it('boosts keyword independently of semantic', () => {
    const total = combineScore(
      {
        semantic: 0,
        keyword: 1,
        symbol: 0,
        path: 0,
        structural: 0,
        dependency: 0,
        reference: 0,
        test: 0,
        recency: 0
      },
      weights
    );
    expect(total).toBeCloseTo(0.2, 5);
  });

  it('scores symbol matches when the query contains the identifier', () => {
    expect(symbolMatchScore({ symbol_name: 'searchCodebase', parent_symbol: null }, 'where is searchcodebase')).toBe(1);
    expect(symbolMatchScore({ symbol_name: 'run', parent_symbol: 'Indexer' }, 'indexer flow')).toBe(0.5);
    expect(symbolMatchScore({ symbol_name: 'foo', parent_symbol: null }, 'bar')).toBe(0);
  });

  it('gives a path boost when the query tokens appear in the file path', () => {
    expect(pathScore('src/search/searchCodebase.ts', 'search codebase ranking')).toBeGreaterThan(0);
    expect(basenameMatchScore('src/search/searchCodebase.ts', 'where is searchCodebase implemented')).toBe(1);
    expect(pathScore('src/unrelated.ts', 'authentication middleware')).toBe(0);
  });

  it('ranks exact symbols above generic semantic neighbors', () => {
    const exact = candidateFromRecord(
      record(),
      { semantic: 0.2, keyword: 0, sources: ['semantic'], reason: 'semantic similarity' },
      weights,
      'where is searchcodebase implemented'
    );
    const generic = candidateFromRecord(
      record({
        id: '2',
        file_path: 'src/other/highSimilarity.ts',
        symbol_name: 'highSimilarity'
      }),
      { semantic: 0.9, keyword: 0, sources: ['semantic'], reason: 'semantic similarity' },
      weights,
      'where is searchcodebase implemented'
    );
    expect(exact.score.total).toBeGreaterThan(generic.score.total);
    expect(exact.reason).toMatch(/exact symbol/);
  });

  it('boosts test files only when the query asks for tests', () => {
    const testRecord = record({ file_path: 'tests/searchCodebase.test.ts', symbol_name: 'coversSearch' });
    const normal = candidateFromRecord(
      testRecord,
      { semantic: 0.5, keyword: 0, sources: ['semantic'], reason: 'semantic similarity' },
      weights,
      'fix search ranking'
    );
    const requested = candidateFromRecord(
      testRecord,
      { semantic: 0.5, keyword: 0, sources: ['semantic'], reason: 'semantic similarity' },
      weights,
      'find search ranking tests'
    );
    expect(normal.score.test).toBe(0);
    expect(requested.score.test).toBe(1);
    expect(requested.score.total).toBeGreaterThan(normal.score.total);
  });

  it('gives structural score for named symbols', () => {
    expect(structuralScore({ symbol_name: 'run', parent_symbol: 'Indexer' })).toBe(1);
    expect(structuralScore({ symbol_name: null, parent_symbol: null })).toBe(0);
  });

  it('decays recency over a week', () => {
    const now = Date.parse('2026-01-08T00:00:00.000Z');
    expect(recencyScore(new Date(now).toISOString(), now)).toBe(1);
    expect(recencyScore('2026-01-01T00:00:00.000Z', now)).toBeCloseTo(0, 5);
  });

  it('keeps a rounded inspectable total', () => {
    const score = buildRetrievalScore(
      {
        semantic: 1,
        keyword: 1,
        symbol: 1,
        path: 0,
        structural: 0,
        dependency: 0,
        reference: 0,
        test: 0,
        recency: 0
      },
      weights
    );
    expect(score.total).toBe(1);
    expect(score.semantic).toBe(1);
  });
});
