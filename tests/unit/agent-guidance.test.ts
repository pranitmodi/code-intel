import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionContext } from '../../src/cursor/sessionContext.js';
import { MCP_SERVER_INSTRUCTIONS } from '../../src/cursor/mcpInstructions.js';
import { LOCAL_CODE_INTEL_SKILL } from '../../src/cursor/skill.js';
import { LOCAL_CODE_INTEL_USER_RULE } from '../../src/cursor/userRule.js';
import type { RegistryEntry } from '../../src/indexer/registry.js';
import { estimateTokensFromText } from '../../src/utils/tokens.js';
import { LOCAL_CODE_INTEL_INSTRUCTIONS } from '../../src/vscode/instructions.js';

const root = join(import.meta.dirname, '..', '..');

function repo(name: string, path: string, filesIndexed = 10): RegistryEntry {
  return { id: name, name, path, filesIndexed, chunksIndexed: filesIndexed * 4, lastIndexedAt: null, embeddingModel: null };
}

describe('agent guidance', () => {
  it('ships example files identical to what the installers write (npm run sync:guidance)', () => {
    const read = (path: string) => readFileSync(join(root, path), 'utf-8');
    expect(read('examples/cursor/use-local-code-intel.mdc')).toBe(LOCAL_CODE_INTEL_USER_RULE);
    expect(read('.cursor/rules/use-local-code-intel.mdc')).toBe(LOCAL_CODE_INTEL_USER_RULE);
    expect(read('examples/cursor/local-code-intel.SKILL.md')).toBe(LOCAL_CODE_INTEL_SKILL);
    expect(read('examples/vscode/use-local-code-intel.instructions.md')).toBe(LOCAL_CODE_INTEL_INSTRUCTIONS);
  });

  it('stays small and does not name an embedding provider it may not be using', () => {
    for (const text of [MCP_SERVER_INSTRUCTIONS, LOCAL_CODE_INTEL_USER_RULE, LOCAL_CODE_INTEL_SKILL, LOCAL_CODE_INTEL_INSTRUCTIONS]) {
      expect(estimateTokensFromText(text)).toBeLessThan(260);
      expect(text).not.toMatch(/ollama|nomic/i);
      expect(text).toContain('get_task_context');
    }
  });

  it('lists only indexed repos that overlap the workspace', () => {
    const repos = [
      repo('app', '/work/app'),
      repo('lib', '/work/libs/lib'),
      repo('empty', '/work/empty', 0),
      repo('other', '/elsewhere/other')
    ];
    const text = sessionContext(['/work'], repos);
    expect(text).toContain('- app (10 files) /work/app');
    expect(text).toContain('- lib (10 files) /work/libs/lib');
    expect(text).not.toContain('empty');
    expect(text).not.toContain('other');

    expect(sessionContext(['/work/app/src'], repos)).toContain('- app (10 files) /work/app');
    expect(sessionContext(['/new'], repos)).toContain('not indexed. Run: code-intel setup --repo /new');
    expect(sessionContext([], repos)).toContain('3 repos indexed');
  });

  it('caps the repo list', () => {
    const many = Array.from({ length: 12 }, (_, index) => repo(`r${index}`, `/work/r${index}`));
    const text = sessionContext(['/work'], many);
    expect(text.match(/^- r\d+/gm)).toHaveLength(8);
    expect(text).toContain('and 4 more');
  });
});
