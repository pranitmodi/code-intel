import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoOptionPath, repoOptionUnresolved } from '../../src/cli/repoOption.js';

describe('--repo option', () => {
  it('resolves a real path to an absolute one', () => {
    expect(repoOptionPath('.')).toBe(resolve('.'));
    expect(repoOptionPath('/tmp/repo')).toBe(resolve('/tmp/repo'));
    expect(repoOptionUnresolved('/tmp/repo')).toBe(false);
  });

  it('falls back when the editor leaves ${workspaceFolder} unexpanded', () => {
    for (const value of ['${workspaceFolder}', '${workspaceFolder:api}', ' ${workspaceFolder} ']) {
      expect(repoOptionPath(value)).toBeUndefined();
      expect(repoOptionUnresolved(value)).toBe(true);
    }
  });

  it('falls back on an empty value or a bare flag', () => {
    // Commander yields `true` for `--repo` with no argument.
    for (const value of ['', '   ', true]) {
      expect(repoOptionPath(value)).toBeUndefined();
      expect(repoOptionUnresolved(value)).toBe(true);
    }
  });

  it('reports nothing to warn about when --repo was not passed', () => {
    expect(repoOptionPath(undefined)).toBeUndefined();
    expect(repoOptionUnresolved(undefined)).toBe(false);
  });
});
