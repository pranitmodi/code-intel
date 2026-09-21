import { describe, expect, it } from 'vitest';
import { candidateImportPaths } from '../../src/retrieval/resolveImport.js';

describe('candidateImportPaths', () => {
  it('resolves a relative JS specifier to TypeScript candidates next to the importer', () => {
    const paths = candidateImportPaths('src/mcp/server.ts', '../search/searchCodebase.js');
    expect(paths).toContain('src/search/searchCodebase.ts');
    expect(paths).toContain('src/search/searchCodebase.js');
    expect(paths.every((path) => path.startsWith('src/search/'))).toBe(true);
  });

  it('resolves ./foo to the same directory and index files', () => {
    const paths = candidateImportPaths('src/auth/middleware.ts', './session');
    expect(paths).toContain('src/auth/session.ts');
    expect(paths).toContain('src/auth/session/index.ts');
  });

  it('ignores package imports and paths that escape the repo', () => {
    expect(candidateImportPaths('src/a.ts', 'zod')).toEqual([]);
    expect(candidateImportPaths('src/a.ts', '../../outside')).toEqual([]);
  });
});
