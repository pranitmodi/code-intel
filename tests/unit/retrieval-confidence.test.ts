import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { confidenceFor, isDocHeavyPath, queryLooksLikeCodeChange } from '../../src/retrieval/confidence.js';
import type { RetrievalCandidate } from '../../src/retrieval/types.js';

function candidate(file: string, total = 0.9): RetrievalCandidate {
  return {
    id: file,
    file,
    symbol: null,
    symbolType: null,
    parentSymbol: null,
    startLine: 1,
    endLine: 2,
    content: 'x',
    lastIndexedAt: null,
    extra: { imports: [], exports: [], referencedSymbols: [], isTest: false, isConfig: false },
    sources: ['semantic'],
    score: {
      total,
      semantic: total,
      keyword: 0,
      symbol: 0,
      path: 0,
      structural: 0,
      dependency: 0,
      reference: 0,
      test: 0,
      recency: 0
    },
    estimatedTokens: 4,
    reason: 'semantic similarity'
  };
}

describe('retrieval confidence', () => {
  const threshold = DEFAULT_CONFIG.retrieval.confidenceThreshold;

  it('flags documentation paths', () => {
    expect(isDocHeavyPath('CODE_INTEL_NEXT_PHASE.md')).toBe(true);
    expect(isDocHeavyPath('examples/cursor/local-code-intel.SKILL.md')).toBe(true);
    expect(isDocHeavyPath('src/retrieval/taskContext.ts')).toBe(false);
  });

  it('softens confidence when a code-change query ranks a doc first', () => {
    expect(queryLooksLikeCodeChange('Add request IDs to MCP tool responses.')).toBe(true);
    const result = confidenceFor(
      [candidate('instructions.md'), candidate('src/mcp/server.ts', 0.4)],
      threshold,
      { query: 'Add request IDs to MCP tool responses.' }
    );
    expect(result.score).toBeLessThan(threshold);
    expect(result.reason).toMatch(/documentation/i);
  });

  it('keeps high confidence when the top hit is source', () => {
    const result = confidenceFor([candidate('src/mcp/server.ts')], threshold, {
      query: 'Add request IDs to MCP tool responses.'
    });
    expect(result.score).toBe(0.9);
  });
});
