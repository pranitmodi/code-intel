import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookCommands, mergeCursorHooksConfig } from '../../src/cursor/hooks.js';
import { installCursorIntegration, mergeCursorMcpConfig } from '../../src/cursor/install.js';
import { installVscodeIntegration, mergeVscodeMcpConfig } from '../../src/vscode/install.js';

const SERVER = 'local-code-intelligence';

type McpDoc = { servers: Record<string, Record<string, unknown>> };

describe('editor config edge cases', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-intel-editor-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('edits a commented VS Code mcp.json in place, keeping comments and other servers', () => {
    const existing = [
      '{',
      '  // Servers for this profile',
      '  "servers": {',
      '    /* team server */',
      '    "github": { "type": "http", "url": "https://example.com/mcp" },',
      '  },',
      '  "inputs": [],',
      '}',
      ''
    ].join('\n');

    const merged = mergeVscodeMcpConfig(existing, '/abs/cli.js');
    expect(merged).toContain('// Servers for this profile');
    expect(merged).toContain('/* team server */');
    const doc = parseJsonc(merged) as McpDoc & { inputs: unknown[] };
    expect(doc.servers.github).toEqual({ type: 'http', url: 'https://example.com/mcp' });
    expect(doc.servers[SERVER]).toMatchObject({ type: 'stdio', command: process.execPath });
    expect(doc.inputs).toEqual([]);
  });

  it('accepts a UTF-8 byte-order mark', () => {
    const merged = mergeVscodeMcpConfig('\uFEFF{ "servers": {} }', '/abs/cli.js');
    expect(merged.startsWith('\uFEFF')).toBe(false);
    expect((JSON.parse(merged) as McpDoc).servers[SERVER]).toBeDefined();
  });

  it('refuses configs whose shape would force it to discard user data', () => {
    expect(() => mergeVscodeMcpConfig('[]', '/abs/cli.js')).toThrow(/top level must be a JSON object/);
    expect(() => mergeVscodeMcpConfig('"text"', '/abs/cli.js')).toThrow(/top level must be a JSON object/);
    expect(() => mergeVscodeMcpConfig('{ "servers": [] }', '/abs/cli.js')).toThrow(/"servers" .* must be an object/);
    expect(() => mergeCursorMcpConfig('{ "mcpServers": "x" }', '/abs/cli.js')).toThrow(
      /"mcpServers" .* must be an object/
    );
    expect(() => mergeCursorHooksConfig('{ "hooks": [] }', '/pkg')).toThrow(/"hooks" .* must be an object/);
  });

  it('treats empty and whitespace-only files as a fresh config', () => {
    for (const raw of ['', '   \n']) {
      expect((JSON.parse(mergeVscodeMcpConfig(raw, '/abs/cli.js')) as McpDoc).servers[SERVER]).toBeDefined();
    }
  });

  it('keeps extra keys the user set on our server entry', () => {
    const existing = JSON.stringify({
      servers: { [SERVER]: { type: 'stdio', command: 'old', disabled: false, envFile: '${workspaceFolder}/.env' } }
    });
    const server = (JSON.parse(mergeVscodeMcpConfig(existing, '/abs/cli.js')) as McpDoc).servers[SERVER];
    expect(server).toMatchObject({
      command: process.execPath,
      disabled: false,
      envFile: '${workspaceFolder}/.env'
    });
  });

  it('preserves tab indentation and CRLF line endings', () => {
    const tabs = mergeVscodeMcpConfig('{\n\t"servers": {}\n}\n', '/abs/cli.js');
    expect(tabs).toMatch(/\n\t\t"local-code-intelligence"/);

    const crlf = mergeVscodeMcpConfig('{\r\n  "servers": {}\r\n}\r\n', '/abs/cli.js');
    expect(crlf.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('leaves an up-to-date config byte-for-byte untouched on rerun', async () => {
    const userDir = join(dir, 'Code', 'User');
    const first = installVscodeIntegration({ home: dir, userDir, cliPath: '/abs/cli.js' });
    const before = await readFile(first.mcpPath, 'utf-8');
    const mtime = (await stat(first.mcpPath)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = installVscodeIntegration({ home: dir, userDir, cliPath: '/abs/cli.js' });
    expect(second.createdMcp).toBe(false);
    expect(await readFile(second.mcpPath, 'utf-8')).toBe(before);
    expect((await stat(second.mcpPath)).mtimeMs).toBe(mtime);
  });

  it('writes through a symlinked mcp.json instead of replacing the link', async () => {
    const userDir = join(dir, 'Code', 'User');
    const dotfiles = join(dir, 'dotfiles');
    await mkdir(userDir, { recursive: true });
    await mkdir(dotfiles, { recursive: true });
    const target = join(dotfiles, 'mcp.json');
    await writeFile(target, '{ "servers": {} }\n');
    await symlink(target, join(userDir, 'mcp.json'));

    installVscodeIntegration({ home: dir, userDir, cliPath: '/abs/cli.js' });
    expect((await lstat(join(userDir, 'mcp.json'))).isSymbolicLink()).toBe(true);
    expect((JSON.parse(await readFile(target, 'utf-8')) as McpDoc).servers[SERVER]).toBeDefined();
  });

  it('quotes hook script paths that contain spaces', () => {
    const commands = hookCommands('/Users/dev/Application Support/code intel');
    expect(commands.sessionStart[0]?.command).toBe(
      `node "${join('/Users/dev/Application Support/code intel', 'dist', 'cursor', 'sessionHookMain.js')}"`
    );
    expect(hookCommands('/opt/code-intel').preToolUse[0]?.command).toBe(
      `node ${join('/opt/code-intel', 'dist', 'cursor', 'preferHookMain.js')}`
    );
  });

  it('replaces hooks from an older install path in place and keeps user hooks', () => {
    const existing = JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          { command: 'echo mine-before' },
          { command: 'node /old/npx-cache/code-intel/dist/cursor/sessionHookMain.js' },
          { command: 'echo mine-after' }
        ],
        preToolUse: [
          { command: 'node /old/npx-cache/code-intel/dist/cursor/preferHookMain.js', matcher: 'Grep' },
          { command: 'node /older/code-intel/dist/cursor/preferHookMain.js', matcher: 'Grep|Glob' }
        ],
        afterFileEdit: [{ command: 'echo formatter' }]
      }
    });

    const merged = JSON.parse(mergeCursorHooksConfig(existing, '/new/pkg')) as {
      hooks: Record<string, Array<{ command: string; matcher?: string }>>;
    };
    const ours = hookCommands('/new/pkg');
    expect(merged.hooks.sessionStart?.map((hook) => hook.command)).toEqual([
      'echo mine-before',
      ours.sessionStart[0]?.command,
      'echo mine-after'
    ]);
    expect(merged.hooks.preToolUse).toEqual(ours.preToolUse);
    expect(merged.hooks.subagentStart).toEqual(ours.subagentStart);
    expect(merged.hooks.afterFileEdit).toEqual([{ command: 'echo formatter' }]);
  });

  it('keeps comments in hooks.json and is a no-op when hooks are current', () => {
    const once = mergeCursorHooksConfig('{\n  // my hooks\n  "hooks": {}\n}\n', '/pkg');
    expect(once).toContain('// my hooks');
    expect(mergeCursorHooksConfig(once, '/pkg')).toBe(once);
  });

  it('reruns Cursor install without duplicating hooks or rewriting files', async () => {
    const cursorHome = join(dir, '.cursor');
    const cliPath = join(dir, 'pkg', 'dist', 'cli', 'index.js');
    const first = installCursorIntegration({ cursorHome, cliPath });
    const hooksBefore = await readFile(first.hooksPath, 'utf-8');
    const mcpBefore = await readFile(first.mcpPath, 'utf-8');

    installCursorIntegration({ cursorHome, cliPath });
    expect(await readFile(first.hooksPath, 'utf-8')).toBe(hooksBefore);
    expect(await readFile(first.mcpPath, 'utf-8')).toBe(mcpBefore);
    const hooks = JSON.parse(hooksBefore) as { hooks: Record<string, unknown[]> };
    expect(hooks.hooks.sessionStart).toHaveLength(1);
    expect(hooks.hooks.preToolUse).toHaveLength(1);
  });
});
