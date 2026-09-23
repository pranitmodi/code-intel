import { describe, expect, it } from 'vitest';
import { serializeToolResult, taskContextPayload } from '../../src/mcp/payload.js';
import type { ContextPackage } from '../../src/retrieval/types.js';

const score = {
  total: 0.912,
  semantic: 0.6,
  keyword: 0.4,
  symbol: 1,
  path: 0,
  structural: 0.7,
  dependency: 0,
  reference: 0,
  test: 0,
  recency: 0.2
};

const pkg: ContextPackage = {
  query: 'add rate limiting',
  summary: 'Retrieved 2 files.',
  files: [
    { path: 'src/a.ts', reason: 'exact symbol match: a', score, chunks: [{ symbol: 'a', startLine: 1, endLine: 3, content: 'export function a() {}' }] },
    { path: 'src/b.ts', reason: 'semantic similarity', score, chunks: [{ startLine: 4, endLine: 9, content: 'const b = 2;' }] }
  ],
  relationships: [
    { from: 'src/a.ts', to: 'src/b.ts', type: 'imports' },
    { from: 'src/a.ts', to: 'src/not-sent.ts', type: 'imports' },
    { from: 'src/a.ts', to: 'src/a.ts', type: 'references' }
  ],
  estimatedTokens: 12,
  retrievalStats: { candidatesConsidered: 40, candidatesSelected: 2, expansionHops: 1 },
  confidence: { score: 0.912, reason: 'Top results exceeded the confidence threshold.' },
  trace: { query: 'add rate limiting', candidateCount: 40, selectedCount: 2, discarded: [], estimatedTokens: 12, latencyMs: 5, expansionHops: 1 }
};

describe('MCP payloads', () => {
  it('sends task context without score breakdowns, stats, or trace', () => {
    const payload = taskContextPayload('/repo', pkg);
    expect(payload.files.map((file) => file.score)).toEqual([0.912, 0.912]);
    expect(payload).not.toHaveProperty('trace');
    expect(payload).not.toHaveProperty('retrievalStats');
    expect(payload).not.toHaveProperty('summary');
    expect(payload.files[0]?.chunks[0]?.content).toBe('export function a() {}');
  });

  it('keeps only relationships between files the agent receives', () => {
    expect(taskContextPayload('/repo', pkg).relationships).toEqual([
      { from: 'src/a.ts', to: 'src/b.ts', type: 'imports' }
    ]);
    expect(taskContextPayload('/repo', { ...pkg, relationships: [] })).not.toHaveProperty('relationships');
  });

  it('serializes compactly', () => {
    const text = serializeToolResult(taskContextPayload('/repo', pkg));
    expect(text).not.toContain('\n  ');
    expect(JSON.parse(text)).toEqual(taskContextPayload('/repo', pkg));
  });
});
