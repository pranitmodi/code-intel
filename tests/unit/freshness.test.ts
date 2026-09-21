import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeSampleFingerprint,
  isContentSampleStale,
  pickSamplePaths
} from '../../src/indexer/freshness.js';
import { hashFileContent } from '../../src/hashing/hash.js';

describe('index freshness sample', () => {
  it('picks a stable evenly spaced subset', () => {
    const paths = Array.from({ length: 100 }, (_, i) => `f${String(i).padStart(3, '0')}.ts`);
    const sample = pickSamplePaths(paths, 8);
    expect(sample).toHaveLength(8);
    expect(pickSamplePaths(paths, 8)).toEqual(sample);
  });

  it('detects a content change when the file count is unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-intel-fresh-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 1;\n');
    const samplePaths = ['src/a.ts', 'src/b.ts'];
    const fingerprint = computeSampleFingerprint(dir, samplePaths);
    expect(fingerprint).toBeTruthy();
    expect(isContentSampleStale(dir, { samplePaths, sampleFingerprint: fingerprint! })).toBe(false);

    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    expect(isContentSampleStale(dir, { samplePaths, sampleFingerprint: fingerprint! })).toBe(true);
    expect(hashFileContent('export const a = 2;\n')).not.toBe(hashFileContent('export const a = 1;\n'));
  });
});
