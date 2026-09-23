import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { confidenceFor, queryLooksLikeCodeChange } from '../../src/retrieval/confidence.js';
import { isDocPath, proseWeightFor } from '../../src/retrieval/docs.js';
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
    expect(isDocPath('docs/DESIGN_NOTES.md')).toBe(true);
    expect(isDocPath('examples/cursor/local-code-intel.SKILL.md')).toBe(true);
    expect(isDocPath('.cursor/rules/use-local-code-intel.mdc')).toBe(true);
    expect(isDocPath('LICENSE')).toBe(true);
    expect(isDocPath('src/retrieval/taskContext.ts')).toBe(false);
    expect(isDocPath('src/docs/render.ts')).toBe(false);
  });

  it('weights prose by how much the task is about documentation', () => {
    expect(proseWeightFor('update the readme install section')).toBe(1);
    expect(proseWeightFor('how does hybrid ranking work')).toBeLessThan(1);
    expect(proseWeightFor('where is searchCodebase implemented')).toBeLessThan(
      proseWeightFor('how does hybrid ranking work')
    );
    expect(proseWeightFor('add rate limiting to the search endpoint')).toBe(
      proseWeightFor('where is searchCodebase implemented')
    );
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
