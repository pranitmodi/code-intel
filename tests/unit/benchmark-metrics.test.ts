import { describe, expect, it } from 'vitest';
import {
  meanReciprocalRank,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  tokenReductionPercent
} from '../../src/benchmark/metrics.js';
import { workspaceScan } from '../../src/benchmark/workspaceScan.js';

describe('retrieval metrics', () => {
  const retrieved = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
  const relevant = new Set(['b.ts', 'z.ts']);

  it('computes precision and recall at K', () => {
    expect(precisionAtK(retrieved, relevant, 2)).toBe(0.5);
    expect(recallAtK(retrieved, relevant, 10)).toBe(0.5);
  });

  it('computes MRR from the first relevant hit', () => {
    expect(meanReciprocalRank(retrieved, relevant)).toBe(0.5);
  });

  it('computes NDCG with graded relevance', () => {
    const ndcg = ndcgAtK(['a.ts', 'b.ts'], { 'a.ts': 3, 'b.ts': 1 }, 2);
    expect(ndcg).toBeGreaterThan(0.8);
    expect(ndcg).toBeLessThanOrEqual(1);
  });

  it('computes token reduction and percentiles', () => {
    expect(tokenReductionPercent(100, 40)).toBe(60);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
  });

  it('serializes a report without source content fields', () => {
    const report = {
      version: 1,
      tasks: [{ id: 'x', retrievedFiles: ['a.ts'], missingRelevantFiles: ['b.ts'] }],
      aggregate: { precisionAt5: 1 }
    };
    const json = JSON.stringify(report);
    expect(json).not.toContain('function ');
    expect(json).toContain('"version":1');
  });

  it('fails clearly instead of reporting a zero baseline when ripgrep is missing', () => {
    const previous = process.env.CODE_INTEL_RG;
    process.env.CODE_INTEL_RG = '/definitely/missing/code-intel-rg';
    try {
      expect(() => workspaceScan(process.cwd(), 'searchCodebase')).toThrow(/Install ripgrep|CODE_INTEL_RG/);
    } finally {
      if (previous === undefined) delete process.env.CODE_INTEL_RG;
      else process.env.CODE_INTEL_RG = previous;
    }
  });
});
