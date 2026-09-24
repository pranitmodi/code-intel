import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installVscodeIntegration,
  mergeVscodeMcpConfig,
  vscodeUserDirCandidates
} from '../../src/vscode/install.js';
import { LOCAL_CODE_INTEL_INSTRUCTIONS_FILENAME } from '../../src/vscode/instructions.js';

describe('vscode-install', () => {
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('merges under the servers key with an explicit stdio type', () => {
    const existing = JSON.stringify({
      inputs: [{ id: 'token', type: 'promptString' }],
      servers: { other: { type: 'stdio', command: 'echo', args: ['hi'] } }
    });
    const merged = JSON.parse(mergeVscodeMcpConfig(existing, '/abs/cli.js')) as {
      inputs: unknown[];
      servers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(merged.inputs).toHaveLength(1);
    expect(merged.servers.other).toEqual({ type: 'stdio', command: 'echo', args: ['hi'] });
    expect(merged.servers['local-code-intelligence']).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: ['/abs/cli.js', 'mcp', '--repo', '${workspaceFolder}']
    });
  });

  it('keeps existing server environment while adding system CA settings', () => {
    const existing = JSON.stringify({
      servers: {
        'local-code-intelligence': {
          command: 'old-command',
          env: { COMPANY_PROXY: 'enabled', NODE_OPTIONS: '--enable-source-maps' }
        }
      }
    });
    const merged = JSON.parse(
      mergeVscodeMcpConfig(existing, '/abs/cli.js', {
        serverEnv: { NODE_USE_SYSTEM_CA: '1', NODE_OPTIONS: '--use-system-ca' }
      })
    ) as { servers: { 'local-code-intelligence': { command: string; env: Record<string, string> } } };
    const server = merged.servers['local-code-intelligence'];
    expect(server.command).toBe(process.execPath);
    expect(server.env.COMPANY_PROXY).toBe('enabled');
    expect(server.env.NODE_USE_SYSTEM_CA).toBe('1');
    expect(server.env.NODE_OPTIONS).toBe('--enable-source-maps --use-system-ca');
  });

  it('rejects a truncated config instead of overwriting it', () => {
    expect(() => mergeVscodeMcpConfig('{ "servers": { // comment', '/abs/cli.js')).toThrow(
      /not valid JSON/
    );
  });

  it('writes the user profile mcp.json and both instruction locations', async () => {
    home = await mkdtemp(join(tmpdir(), 'code-intel-vscode-'));
    const userDir = join(home, 'Code', 'User');
    const parent = join(home, 'work', 'multi-root parent');
    const result = installVscodeIntegration({
      home,
      userDir,
      cliPath: '/abs/cli.js',
      repoPath: parent,
      nodePath: '/abs/node'
    });

    expect(result.mcpPath).toBe(join(userDir, 'mcp.json'));
    const mcp = JSON.parse(await readFile(result.mcpPath, 'utf-8')) as {
      servers: {
        'local-code-intelligence': { type: string; command: string; args: string[] };
      };
    };
    expect(mcp.servers['local-code-intelligence'].type).toBe('stdio');
    expect(mcp.servers['local-code-intelligence'].command).toBe('/abs/node');
    expect(mcp.servers['local-code-intelligence'].args).toEqual([
      '/abs/cli.js',
      'mcp',
      '--repo',
      parent
    ]);
    expect(result.instructionPaths).toEqual([
      join(userDir, 'prompts', LOCAL_CODE_INTEL_INSTRUCTIONS_FILENAME),
      join(home, '.copilot', 'instructions', LOCAL_CODE_INTEL_INSTRUCTIONS_FILENAME)
    ]);
    expect(result.repoArgument).toBe(parent);
    for (const path of result.instructionPaths) {
      const instructions = await readFile(path, 'utf-8');
      expect(instructions).toContain("applyTo: '**'");
      expect(instructions).toContain('get_task_context');
    }
  });

  it('writes workspace-scoped files inside the repository', async () => {
    home = await mkdtemp(join(tmpdir(), 'code-intel-vscode-ws-'));
    const result = installVscodeIntegration({
      scope: 'workspace',
      workspaceRoot: home,
      cliPath: '/abs/cli.js'
    });

    expect(result.mcpPath).toBe(join(home, '.vscode', 'mcp.json'));
    expect(result.instructionPaths).toEqual([
      join(home, '.github', 'instructions', LOCAL_CODE_INTEL_INSTRUCTIONS_FILENAME)
    ]);
    const mcp = JSON.parse(await readFile(result.mcpPath, 'utf-8')) as {
      servers: { 'local-code-intelligence': { args: string[] } };
    };
    expect(mcp.servers['local-code-intelligence'].args.at(-1)).toBe('${workspaceFolder}');
  });

  it('asks VS Code to prompt for embedding credentials instead of storing them', async () => {
    home = await mkdtemp(join(tmpdir(), 'code-intel-vscode-creds-'));
    const userDir = join(home, 'Code', 'User');
    const result = installVscodeIntegration({
      home,
      userDir,
      cliPath: '/abs/cli.js',
      promptForCredentials: true
    });

    expect(result.promptedFor).toEqual([
      'CODE_INTEL_EMBEDDING_API_KEY',
      'CODE_INTEL_EMBEDDING_USER'
    ]);
    const mcp = JSON.parse(await readFile(result.mcpPath, 'utf-8')) as {
      inputs: Array<{ id: string; type: string; password?: boolean }>;
      servers: { 'local-code-intelligence': { env: Record<string, string> } };
    };
    expect(mcp.servers['local-code-intelligence'].env).toEqual({
      CODE_INTEL_EMBEDDING_API_KEY: '${input:code-intel-embedding-api-key}',
      CODE_INTEL_EMBEDDING_USER: '${input:code-intel-embedding-user}'
    });
    expect(mcp.inputs.map((input) => input.id)).toEqual([
      'code-intel-embedding-api-key',
      'code-intel-embedding-user'
    ]);
    expect(mcp.inputs[0].password).toBe(true);

    // Rerunning must not duplicate the prompts.
    const again = installVscodeIntegration({ home, userDir, cliPath: '/abs/cli.js', promptForCredentials: true });
    expect(again.promptedFor).toEqual([]);
    const rerun = JSON.parse(await readFile(result.mcpPath, 'utf-8')) as { inputs: unknown[] };
    expect(rerun.inputs).toHaveLength(2);
  });

  it('keeps credentials a user already configured', () => {
    const existing = JSON.stringify({
      servers: {
        'local-code-intelligence': { env: { CODE_INTEL_EMBEDDING_API_KEY: 'literal-key' } }
      }
    });
    const merged = JSON.parse(mergeVscodeMcpConfig(existing, '/abs/cli.js')) as {
      servers: { 'local-code-intelligence': { env: Record<string, string> } };
    };
    expect(merged.servers['local-code-intelligence'].env.CODE_INTEL_EMBEDDING_API_KEY).toBe('literal-key');
  });

  it('prefers stable VS Code but offers Insiders and VSCodium profiles per platform', () => {
    const support = join('/Users/dev', 'Library', 'Application Support');
    expect(vscodeUserDirCandidates({ platform: 'darwin', home: '/Users/dev' })).toEqual([
      join(support, 'Code', 'User'),
      join(support, 'Code - Insiders', 'User'),
      join(support, 'VSCodium', 'User')
    ]);
    expect(vscodeUserDirCandidates({ platform: 'linux', home: '/home/dev', env: {} })[0]).toBe(
      join('/home/dev', '.config', 'Code', 'User')
    );
    expect(
      vscodeUserDirCandidates({ platform: 'linux', home: '/home/dev', env: { XDG_CONFIG_HOME: '/cfg' } })[0]
    ).toBe(join('/cfg', 'Code', 'User'));
    expect(
      vscodeUserDirCandidates({ platform: 'win32', home: 'C:/Users/dev', env: { APPDATA: 'C:/Roaming' } })[0]
    ).toBe(join('C:/Roaming', 'Code', 'User'));
    expect(vscodeUserDirCandidates({ platform: 'win32', home: 'C:/Users/dev', env: {} })[0]).toBe(
      join('C:/Users/dev', 'AppData', 'Roaming', 'Code', 'User')
    );
  });
});
