import { describe, expect, it } from 'vitest';
import type { RetrievalCandidate } from '../../src/retrieval/types.js';
import { selectCandidates } from '../../src/retrieval/select.js';

function candidate(
  overrides: Partial<RetrievalCandidate> & { id: string; file: string; scoreTotal: number }
): RetrievalCandidate {
  const estimatedTokens = overrides.estimatedTokens ?? 10;
  return {
    symbol: overrides.symbol ?? 'fn',
    symbolType: 'function',
    parentSymbol: null,
    startLine: 1,
    endLine: 10,
    content: 'x'.repeat(estimatedTokens * 4),
    lastIndexedAt: null,
    extra: { imports: [], exports: [], referencedSymbols: [], isTest: false, isConfig: false },
    sources: overrides.sources ?? ['semantic'],
    score: {
      total: overrides.scoreTotal,
      semantic: overrides.scoreTotal,
      keyword: 0,
      symbol: 0,
      path: 0,
      structural: 0,
      dependency: 0,
      reference: 0,
      test: 0,
      recency: 0
    },
    estimatedTokens,
    reason: 'test',
    id: overrides.id,
    file: overrides.file
  };
}

describe('selectCandidates', () => {
  it('caps chunks per file and per symbol', () => {
    const ranked = [
      candidate({ id: '1', file: 'a.ts', symbol: 'foo', scoreTotal: 1 }),
      candidate({ id: '2', file: 'a.ts', symbol: 'foo', scoreTotal: 0.9 }),
      candidate({ id: '3', file: 'a.ts', symbol: 'bar', scoreTotal: 0.8 }),
      candidate({ id: '4', file: 'a.ts', symbol: 'baz', scoreTotal: 0.7 }),
      candidate({ id: '5', file: 'a.ts', symbol: 'qux', scoreTotal: 0.6 }),
      candidate({ id: '6', file: 'a.ts', symbol: 'zap', scoreTotal: 0.5 })
    ];
    const result = selectCandidates(ranked, {
      limit: 10,
      maxChunksPerFile: 4,
      maxChunksPerSymbol: 2
    });
    expect(result.selected).toHaveLength(4);
    expect(result.selected.filter((c) => c.symbol === 'foo')).toHaveLength(2);
    expect(result.discarded.some((d) => d.reason === 'per_file_cap')).toBe(true);
  });

  it('respects a hard token budget but keeps the first useful chunk', () => {
    const ranked = [
      candidate({ id: '1', file: 'a.ts', symbol: 'a', scoreTotal: 1, estimatedTokens: 80 }),
      candidate({ id: '2', file: 'b.ts', symbol: 'b', scoreTotal: 0.9, estimatedTokens: 80 })
    ];
    const result = selectCandidates(ranked, {
      limit: 10,
      maxTokens: 50,
      maxChunksPerFile: 4,
      maxChunksPerSymbol: 2
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.id).toBe('1');
    expect(result.discarded.some((d) => d.reason === 'token_budget')).toBe(true);
  });

  it('keeps expansion-only files from crowding direct hits out of the top five', () => {
    const ranked = [
      candidate({ id: 'e1', file: 'dep-a.ts', symbol: 'a', scoreTotal: 1, sources: ['expansion'] }),
      candidate({ id: 'e2', file: 'dep-b.ts', symbol: 'b', scoreTotal: 0.95, sources: ['expansion'] }),
      candidate({ id: 'e3', file: 'dep-c.ts', symbol: 'c', scoreTotal: 0.9, sources: ['expansion'] }),
      candidate({ id: 'd1', file: 'implementation.ts', symbol: 'implementation', scoreTotal: 0.85 }),
      candidate({ id: 'd2', file: 'tests.ts', symbol: 'tests', scoreTotal: 0.8 })
    ];
    const result = selectCandidates(ranked, {
      limit: 5,
      maxChunksPerFile: 4,
      maxChunksPerSymbol: 2,
      maxExpansionOnlyFilesInTopK: 2,
      expansionTopK: 5
    });
    expect(result.selected.map((item) => item.file)).toContain('implementation.ts');
    expect(result.selected.filter((item) => item.sources[0] === 'expansion')).toHaveLength(2);
    expect(result.discarded.some((item) => item.reason === 'expansion_top_k_cap')).toBe(true);
  });

  it('drops a chunk that repeats one already selected, even from another file', () => {
    const rule =
      'Use get_task_context first for broad tasks, search_symbol for known names, and get_file_context for exact ranges before editing any file in the repository.';
    const ranked = [
      { ...candidate({ id: 'src', file: 'src/rule.ts', symbol: 'RULE', scoreTotal: 0.9 }), content: rule },
      { ...candidate({ id: 'copy', file: 'examples/rule.mdc', symbol: null, scoreTotal: 0.8 }), content: `# Rule\n\n${rule}` },
      { ...candidate({ id: 'short', file: 'src/a.ts', symbol: 'a', scoreTotal: 0.7 }), content: 'export const a = 1;' },
      { ...candidate({ id: 'short2', file: 'src/b.ts', symbol: 'b', scoreTotal: 0.6 }), content: 'export const a = 1;' }
    ];
    const result = selectCandidates(ranked, { limit: 10, maxChunksPerFile: 4, maxChunksPerSymbol: 2 });
    expect(result.selected.map((item) => item.id)).toEqual(['src', 'short', 'short2']);
    expect(result.discarded).toContainEqual({ id: 'copy', file: 'examples/rule.mdc', reason: 'duplicate' });
  });

  it('applies minOrganicScore to organic hits only', () => {
    const ranked = [
      { ...candidate({ id: 'exact', file: 'a.ts', symbol: 'a', scoreTotal: 0.3 }), exactFloor: 0.3 },
      candidate({ id: 'strong', file: 'b.ts', symbol: 'b', scoreTotal: 0.6 }),
      candidate({ id: 'weak', file: 'c.ts', symbol: 'c', scoreTotal: 0.4 })
    ];
    const result = selectCandidates(ranked, {
      limit: 10,
      minOrganicScore: 0.5,
      maxChunksPerFile: 4,
      maxChunksPerSymbol: 2
    });
    expect(result.selected.map((item) => item.id)).toEqual(['exact', 'strong']);
    expect(result.discarded).toContainEqual({ id: 'weak', file: 'c.ts', reason: 'min_score' });
  });
});
