import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installCursorIntegration, mergeCursorMcpConfig } from '../../src/cursor/install.js';
import { LOCAL_CODE_INTEL_RULE_FILENAME } from '../../src/cursor/userRule.js';

describe('cursor-install', () => {
  let cursorHome: string;

  afterEach(async () => {
    if (cursorHome) await rm(cursorHome, { recursive: true, force: true });
  });

  it('merges the local-code-intelligence server without dropping existing MCP servers', () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { command: 'echo', args: ['hi'] }
      }
    });
    const merged = JSON.parse(mergeCursorMcpConfig(existing, '/abs/cli.js')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(merged.mcpServers.other).toEqual({ command: 'echo', args: ['hi'] });
    expect(merged.mcpServers['local-code-intelligence']).toEqual({
      command: 'node',
      args: ['/abs/cli.js', 'mcp', '--repo', '${workspaceFolder}']
    });
  });

  it('writes mcp.json and the always-on user rule', async () => {
    cursorHome = await mkdtemp(join(tmpdir(), 'code-intel-cursor-'));
    await mkdir(join(cursorHome, 'rules'), { recursive: true });
    const result = installCursorIntegration({ cursorHome, cliPath: '/abs/cli.js' });
    const mcp = JSON.parse(await readFile(result.mcpPath, 'utf-8')) as {
      mcpServers: { 'local-code-intelligence': { command: string } };
    };
    expect(mcp.mcpServers['local-code-intelligence'].command).toBe('node');
    const rule = await readFile(join(cursorHome, 'rules', LOCAL_CODE_INTEL_RULE_FILENAME), 'utf-8');
    expect(rule).toContain('alwaysApply: true');
    expect(rule).toContain('search_codebase');
    const hooks = JSON.parse(await readFile(result.hooksPath, 'utf-8')) as {
      hooks: { preToolUse: { matcher: string }[]; sessionStart: { command: string }[] };
    };
    expect(hooks.hooks.preToolUse[0]?.matcher).toBe('Grep|Glob|Task');
    expect(hooks.hooks.sessionStart[0]?.command).toContain('sessionHookMain.js');
    const skill = await readFile(result.skillPath, 'utf-8');
    expect(skill).toContain('user-local-code-intelligence');
  });
});
