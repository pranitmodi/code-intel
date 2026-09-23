import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  grantFilesystemFallback,
  isFilesystemFallbackOpen
} from '../../src/retrieval/fallback.js';
import { buildContextPackageForTest, minOrganicScore } from '../../src/retrieval/taskContext.js';
import type { RetrievalCandidate } from '../../src/retrieval/types.js';
import { shouldDenyTreeScan } from '../../src/cursor/treeScanPolicy.js';

function fakeCandidate(): RetrievalCandidate {
  return {
    id: '1',
    file: 'src/search/searchCodebase.ts',
    symbol: 'searchCodebase',
    symbolType: 'function',
    parentSymbol: null,
    startLine: 1,
    endLine: 20,
    content: 'export async function searchCodebase() {}',
    lastIndexedAt: null,
    extra: { imports: [], exports: ['searchCodebase'], referencedSymbols: [], isTest: false, isConfig: false },
    sources: ['semantic'],
    score: {
      total: 0.8,
      semantic: 0.8,
      keyword: 0,
      symbol: 1,
      path: 0,
      structural: 1,
      dependency: 0,
      reference: 0,
      test: 0,
      recency: 0
    },
    estimatedTokens: 12,
    reason: 'semantic similarity'
  };
}

function scored(total: number, exactFloor?: number): RetrievalCandidate {
  return { ...fakeCandidate(), score: { ...fakeCandidate().score, total }, ...(exactFloor ? { exactFloor } : {}) };
}

describe('context cutoff', () => {
  it('returns only the definition for a "where is X" lookup that found X exactly', () => {
    const ranked = [scored(0.95, 0.95), scored(0.44), scored(0.43)];
    expect(minOrganicScore(ranked, 'Where is searchCodebase implemented?')).toBe(Number.POSITIVE_INFINITY);
    expect(minOrganicScore(ranked, 'Where is searchCodebase used?')).toBe(0);
    expect(minOrganicScore([scored(0.9, 0.9), scored(0.5)], 'Where is the config?')).toBe(0);
  });

  it('cuts organic hits only at a clear score drop past the top two', () => {
    expect(minOrganicScore([scored(0.76), scored(0.7), scored(0.52), scored(0.5)], 'find the grep tests')).toBe(0.7);
    expect(minOrganicScore([scored(0.69), scored(0.5), scored(0.49)], 'fix stale index')).toBe(0);
    expect(minOrganicScore([scored(0.6), scored(0.58), scored(0.55), scored(0.5)], 'how does ranking work')).toBe(0);
  });
});

describe('context package', () => {
  it('groups chunks by file and reports empty-result confidence', () => {
    const empty = buildContextPackageForTest(
      'missing thing',
      [],
      0,
      0,
      { score: 0, reason: 'Low-confidence retrieval. Recommended fallback: targeted repository search.' }
    );
    expect(empty.files).toEqual([]);
    expect(empty.confidence.score).toBe(0);
    expect(empty.confidence.reason).toMatch(/Low-confidence/);

    const packed = buildContextPackageForTest('search', [fakeCandidate()], 4, 1, {
      score: 0.8,
      reason: 'ok'
    });
    expect(packed.files).toHaveLength(1);
    expect(packed.files[0]?.path).toBe('src/search/searchCodebase.ts');
    expect(packed.retrievalStats.candidatesConsidered).toBe(4);
  });

  it('orders packaged files by their best score, not insertion order', () => {
    const best = fakeCandidate();
    const lower: RetrievalCandidate = {
      ...fakeCandidate(),
      id: '2',
      file: 'src/unrelated.ts',
      score: { ...fakeCandidate().score, total: 0.2 }
    };
    const packed = buildContextPackageForTest('search', [lower, best], 2, 0, {
      score: 0.8,
      reason: 'ok'
    });
    expect(packed.files.map((file) => file.path)).toEqual([
      'src/search/searchCodebase.ts',
      'src/unrelated.ts'
    ]);
  });
});

describe('filesystem fallback window', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('opens a short window after a failed retrieval', async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-intel-fallback-'));
    expect(isFilesystemFallbackOpen(dir)).toBe(false);
    grantFilesystemFallback(dir, 'low confidence', '/repo');
    expect(isFilesystemFallbackOpen(dir)).toBe(true);
  });
});

describe('shouldDenyTreeScan fallback', () => {
  const cwd = '/Users/me/proj';

  it('allows workspace Grep/Glob when fallback is armed, but still denies explore', () => {
    expect(
      shouldDenyTreeScan(
        { tool_name: 'Grep', cwd, workspace_roots: [cwd], tool_input: { pattern: 'foo' } },
        { allowFallback: true }
      )
    ).toBe(false);
    expect(
      shouldDenyTreeScan({ hook_event_name: 'subagentStart', subagent_type: 'explore' }, { allowFallback: true })
    ).toBe(true);
  });
});
