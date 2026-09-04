import { describe, expect, it } from 'vitest';
import { shouldDenyTreeScan } from '../../src/cursor/treeScanPolicy.js';

const cwd = '/Users/me/proj';

describe('shouldDenyTreeScan', () => {
  it('denies workspace-wide Grep and Glob', () => {
    expect(shouldDenyTreeScan({ tool_name: 'Grep', cwd, workspace_roots: [cwd], tool_input: { pattern: 'foo' } })).toBe(true);
    expect(
      shouldDenyTreeScan({
        tool_name: 'Glob',
        cwd,
        workspace_roots: [cwd],
        tool_input: { glob_pattern: '**/*.ts' }
      })
    ).toBe(true);
  });

  it('allows Grep of a specific file', () => {
    expect(
      shouldDenyTreeScan({
        tool_name: 'Grep',
        cwd,
        workspace_roots: [cwd],
        tool_input: { pattern: 'foo', path: 'src/auth.ts' }
      })
    ).toBe(false);
  });

  it('denies Task explore subagents', () => {
    expect(shouldDenyTreeScan({ hook_event_name: 'subagentStart', subagent_type: 'explore' })).toBe(true);
    expect(
      shouldDenyTreeScan({
        tool_name: 'Task',
        tool_input: { subagent_type: 'explore', prompt: 'Find auth' }
      })
    ).toBe(true);
  });

  it('allows a non-explore Task', () => {
    expect(
      shouldDenyTreeScan({
        tool_name: 'Task',
        tool_input: { subagent_type: 'shell', prompt: 'Run the tests' }
      })
    ).toBe(false);
  });
});
