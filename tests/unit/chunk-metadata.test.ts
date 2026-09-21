import { describe, expect, it } from 'vitest';
import {
  buildChunkExtraMetadata,
  extractImports,
  isConfigPath,
  isTestPath,
  parseChunkExtraMetadata
} from '../../src/chunker/chunkMetadata.js';

describe('chunk metadata', () => {
  it('detects tests and config from paths', () => {
    expect(isTestPath('tests/unit/foo.test.ts')).toBe(true);
    expect(isTestPath('src/foo.ts')).toBe(false);
    expect(isConfigPath('package.json')).toBe(true);
    expect(isConfigPath('vite.config.ts')).toBe(true);
    expect(isConfigPath('src/search/searchCodebase.ts')).toBe(false);
  });

  it('extracts TS imports and exports', () => {
    const content = `
import { searchCodebase } from '../search/searchCodebase.js';
export function buildServer() {}
`;
    expect(extractImports(content, 'typescript')).toContain('../search/searchCodebase.js');
    const meta = buildChunkExtraMetadata('src/mcp/server.ts', content, content, 'typescript');
    expect(meta.exports).toContain('buildServer');
    expect(meta.isTest).toBe(false);
  });

  it('round-trips JSON extra_metadata', () => {
    const meta = buildChunkExtraMetadata(
      'tests/unit/foo.test.ts',
      'import "./bar.js"',
      'searchCodebase()',
      'typescript'
    );
    expect(meta.isTest).toBe(true);
    const parsed = parseChunkExtraMetadata(JSON.stringify(meta));
    expect(parsed.isTest).toBe(true);
    expect(parsed.imports.length).toBeGreaterThan(0);
  });

  it('returns empty metadata for invalid JSON', () => {
    expect(parseChunkExtraMetadata('not-json').imports).toEqual([]);
  });
});
