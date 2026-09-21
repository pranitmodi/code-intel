import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { candidateImportPaths, loadTsPathAliases } from '../../src/retrieval/resolveImport.js';

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

  it('resolves tsconfig-style path aliases', () => {
    const aliases = [{ prefix: '@app/', targets: ['src/'] }];
    const paths = candidateImportPaths('src/mcp/server.ts', '@app/search/searchCodebase', aliases);
    expect(paths).toContain('src/search/searchCodebase.ts');
  });

  it('resolves Python dotted modules next to the importer and from repo-style packages', () => {
    expect(candidateImportPaths('src/retrieval/task.py', '.score')).toContain('src/retrieval/score.py');
    expect(candidateImportPaths('pkg/mod.py', 'retrieval.score')).toContain('retrieval/score.py');
    expect(candidateImportPaths('pkg/mod.py', 'retrieval.score')).toContain('retrieval/score/__init__.py');
  });

  it('loads TypeScript path aliases from tsconfig.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-intel-alias-'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } })
    );
    const aliases = loadTsPathAliases(dir);
    expect(aliases[0]?.prefix).toBe('@app/');
    expect(candidateImportPaths('src/a.ts', '@app/search/searchCodebase', aliases)).toContain(
      'src/search/searchCodebase.ts'
    );
  });
});
