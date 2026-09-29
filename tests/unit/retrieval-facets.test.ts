import { describe, expect, it } from 'vitest';
import { coverageReport, facetRelevance, selectWithCoverage } from '../../src/retrieval/coverage.js';
import { planQuery, type TaskFacet } from '../../src/retrieval/facets.js';
import { analyzeQuery } from '../../src/retrieval/intent.js';
import { contentWords, stem, wordsOf } from '../../src/retrieval/terms.js';
import type { RetrievalCandidate } from '../../src/retrieval/types.js';

const AB_PROMPT =
  'Explain how `code-intel vscode-install` configures VS Code: how it copes with nvm and a GUI-launched VS Code that lacks the shell PATH, user versus workspace installation, single-folder versus multi-root windows, prompting for OpenAI-compatible embedding credentials, system CA settings, preserving JSONC comments and other MCP servers in mcp.json, and what happens when --repo is missing or unusable.';

describe('terms', () => {
  it('splits identifiers and normalises word forms', () => {
    expect(wordsOf('computeChunkId')).toEqual(expect.arrayContaining(['comput', 'chunk', 'id', 'computechunkid']));
    expect(wordsOf('IDs are computed')).toEqual(expect.arrayContaining(['id', 'comput']));
    expect(stem('indexing')).toBe(stem('indexed'));
  });

  it('drops prose stop words, including their inflected forms', () => {
    expect(contentWords('How does the watcher handle versus copes')).toEqual(['watcher']);
  });
});

describe('planQuery', () => {
  it('keeps a short focused request as one facet', () => {
    const plan = planQuery('Where is searchCodebase implemented?', analyzeQuery('Where is searchCodebase implemented?'));
    expect(plan.route).toBe('focused');
    expect(plan.facets).toHaveLength(1);
  });

  it('splits a multi-part request into anchored facets', () => {
    const plan = planQuery(AB_PROMPT, analyzeQuery(AB_PROMPT));
    expect(plan.route).toBe('broad');
    const parts = plan.facets.filter((facet) => !facet.auxiliary);
    expect(parts.length).toBeGreaterThanOrEqual(8);
    expect(plan.facets.at(-1)).toMatchObject({ id: 'task', auxiliary: true });
    expect(plan.facets[0]).toMatchObject({ kind: 'command', anchors: ['vscode-install'] });
    expect(plan.facets.some((facet) => facet.anchors.includes('--repo'))).toBe(true);
    expect(plan.facets.some((facet) => facet.terms.includes('jsonc'))).toBe(true);
    // "versus" joins the two sides of one facet.
    expect(plan.facets.some((facet) => facet.label === 'user versus workspace installation')).toBe(true);
    const total = plan.facets.reduce((sum, facet) => sum + facet.weight, 0);
    expect(total).toBeCloseTo(1);
    // Every facet but the subject is embedded with the subject for context.
    expect(plan.facets[1]?.embedText.startsWith(plan.facets[0]!.label)).toBe(true);
  });
});

function candidate(id: string, file: string, content: string, total = 0.5, tokens = 100): RetrievalCandidate {
  return {
    id,
    file,
    symbol: null,
    symbolType: 'function',
    parentSymbol: null,
    startLine: 1,
    endLine: 10,
    content,
    lastIndexedAt: null,
    extra: { imports: [], exports: [], referencedSymbols: [], isTest: false, isConfig: false },
    sources: ['semantic'],
    score: { total, semantic: total, keyword: 0, symbol: 0, path: 0, structural: 0, dependency: 0, reference: 0, test: 0, recency: 0 },
    estimatedTokens: tokens,
    reason: 'test'
  };
}

const facets: TaskFacet[] = [
  { id: 'f0', kind: 'concept', label: 'system CA settings', terms: contentWords('system CA settings'), anchors: [], weight: 0.5, embedText: '' },
  { id: 'f1', kind: 'concept', label: 'JSONC comments', terms: contentWords('JSONC comments'), anchors: [], weight: 0.5, embedText: '' }
];
/** Each facet's own search found the chunks that mention it first. */
const rankings = [
  { ranks: new Map([['ca-1', 0], ['ca-2', 1]]) },
  { ranks: new Map([['jsonc', 0]]) }
];

describe('coverage selection', () => {
  const pool = [
    candidate('ca-1', 'src/corporate/systemCa.ts', 'export function systemCaChildEnv() { /* system CA settings */ }', 0.9),
    candidate('ca-2', 'src/corporate/systemCaExtra.ts', 'system CA settings again', 0.85),
    candidate('jsonc', 'src/editors/jsonc.ts', 'parse JSONC and keep comments', 0.4),
    candidate('noise', 'src/other.ts', 'unrelated payments code', 0.95)
  ];

  it('gives each facet evidence before any facet gets a second chunk', () => {
    const relevance = facetRelevance(pool, facets, rankings);
    const { selected } = selectWithCoverage(pool, facets, relevance, { limit: 2, maxChunksPerFile: 2, maxChunksPerSymbol: 2 });
    expect(selected.map((c) => c.id).sort()).toEqual(['ca-1', 'jsonc']);
  });

  it('reports complete only when every facet is covered', () => {
    const relevance = facetRelevance(pool, facets, rankings);
    const partial = coverageReport([pool[0]!], facets, relevance);
    expect(partial.complete).toBe(false);
    expect(partial.facets.map((f) => f.status)).toEqual(['covered', 'missing']);
    const full = coverageReport([pool[0]!, pool[2]!], facets, relevance);
    expect(full.complete).toBe(true);
    expect(full.facets[1]?.evidence[0]?.path).toBe('src/editors/jsonc.ts');
  });

  it('never picks a chunk that covers nothing', () => {
    const relevance = facetRelevance(pool, facets, rankings);
    const { selected } = selectWithCoverage(pool, facets, relevance, { limit: 10, maxChunksPerFile: 2, maxChunksPerSymbol: 2 });
    expect(selected.map((c) => c.id)).not.toContain('noise');
  });

  it('discounts docs that restate the request unless docs are asked for', () => {
    const doc = candidate('doc', 'docs/GUIDE.md', 'system CA settings and JSONC comments', 0.5);
    const relevance = facetRelevance([doc, ...pool], facets, rankings);
    expect(relevance.get('doc')![0]!).toBeLessThan(relevance.get('ca-1')![0]! + 0.001);
    const asked = facetRelevance([doc, ...pool], facets, rankings, { wantsDocs: true });
    expect(asked.get('doc')![0]!).toBeGreaterThan(relevance.get('doc')![0]!);
  });
});
