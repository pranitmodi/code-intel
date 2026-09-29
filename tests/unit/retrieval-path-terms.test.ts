import { describe, expect, it } from 'vitest';
import { isCodePath, matchPathTerms, termPathMatch } from '../../src/retrieval/pathTerms.js';

const paths = [
  'src/vscode/install.ts',
  'src/vscode/instructions.ts',
  'src/cursor/install.ts',
  'src/editors/jsonc.ts',
  'src/editors/mcpConfig.ts',
  'src/editors/cliEntry.ts',
  'src/corporate/systemCa.ts',
  'tests/unit/vscode-install.test.ts',
  'examples/cursor/local-code-intel.SKILL.md',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  'src/index.ts'
];

describe('termPathMatch', () => {
  it('matches stem words and directory names on their own', () => {
    expect(termPathMatch('src/corporate/systemCa.ts', 'system')).toBe('stem');
    expect(termPathMatch('src/vscode/install.ts', 'vscode')).toBe('dir');
    expect(termPathMatch('src/editors/jsonc.ts', 'editor')).toBe('dir');
    expect(termPathMatch('src/index.ts', 'index')).toBeNull();
  });
});

describe('isCodePath', () => {
  it('excludes docs, data files, and dot-directories', () => {
    expect(isCodePath('src/vscode/install.ts')).toBe(true);
    expect(isCodePath('examples/cursor/local-code-intel.SKILL.md')).toBe(false);
    expect(isCodePath('.github/ISSUE_TEMPLATE/feature_request.yml')).toBe(false);
  });
});

describe('matchPathTerms', () => {
  it('finds files a single long-prompt word names, weighting rare words higher', () => {
    const hits = matchPathTerms(paths, ['jsonc', 'install', 'vscode']);
    expect(hits.get('src/editors/jsonc.ts')).toEqual({ term: 'jsonc', specificity: 1 });
    expect(hits.get('src/vscode/install.ts')?.specificity).toBeCloseTo(1 / 3);
    expect(hits.has('src/vscode/instructions.ts')).toBe(false);
  });

  it('skips words that name a whole directory of files', () => {
    const hits = matchPathTerms(paths, ['editor']);
    expect(hits.size).toBe(0);
  });

  it('never returns docs or data files', () => {
    const hits = matchPathTerms(paths, ['skill', 'request']);
    expect([...hits.keys()]).toEqual([]);
  });
});
