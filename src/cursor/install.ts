import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { packageRootFromCli, resolveCliEntry } from '../editors/cliEntry.js';
import { readTextIfExists, writeIfChanged } from '../editors/jsonc.js';
import { WORKSPACE_FOLDER_ARG, upsertMcpServer } from '../editors/mcpConfig.js';
import { mergeCursorHooksConfig } from './hooks.js';
import { LOCAL_CODE_INTEL_SKILL } from './skill.js';
import { LOCAL_CODE_INTEL_RULE_FILENAME, LOCAL_CODE_INTEL_USER_RULE } from './userRule.js';

export { packageRootFromCli, resolveCliEntry };

export interface CursorInstallResult {
  mcpPath: string;
  rulePath: string;
  hooksPath: string;
  skillPath: string;
  cliPath: string;
  createdMcp: boolean;
}

export interface CursorInstallOptions {
  cursorHome?: string;
  cliPath?: string;
  serverEnv?: Record<string, string>;
}

export function cursorMcpServerEntry(
  cliPath: string,
  env?: Record<string, string>
): { command: string; args: string[]; env?: Record<string, string> } {
  return {
    command: 'node',
    args: [cliPath, 'mcp', '--repo', WORKSPACE_FOLDER_ARG],
    ...(env && Object.keys(env).length > 0 ? { env } : {})
  };
}

export function mergeCursorMcpConfig(
  existingRaw: string | undefined,
  cliPath: string,
  serverEnv?: Record<string, string>
): string {
  return upsertMcpServer(existingRaw, {
    containerKey: 'mcpServers',
    entry: (env) => cursorMcpServerEntry(cliPath, env),
    serverEnv,
    label: '~/.cursor/mcp.json',
    command: 'cursor-install'
  });
}

export function installCursorIntegration(options: CursorInstallOptions = {}): CursorInstallResult {
  const cursorHome = options.cursorHome ?? join(homedir(), '.cursor');
  const mcpPath = join(cursorHome, 'mcp.json');
  const rulePath = join(cursorHome, 'rules', LOCAL_CODE_INTEL_RULE_FILENAME);
  const hooksPath = join(cursorHome, 'hooks.json');
  const skillPath = join(cursorHome, 'skills', 'local-code-intel', 'SKILL.md');
  const cliPath = options.cliPath ?? resolveCliEntry();
  const packageRoot = packageRootFromCli(cliPath);

  mkdirSync(cursorHome, { recursive: true });

  const createdMcp = !existsSync(mcpPath);
  const previousMcp = readTextIfExists(mcpPath);
  const previousHooks = readTextIfExists(hooksPath);
  const mcp = mergeCursorMcpConfig(previousMcp, cliPath, options.serverEnv);
  const hooks = mergeCursorHooksConfig(previousHooks, packageRoot);

  writeIfChanged(mcpPath, mcp, previousMcp);
  writeIfChanged(hooksPath, hooks, previousHooks);
  writeIfChanged(rulePath, LOCAL_CODE_INTEL_USER_RULE);
  writeIfChanged(skillPath, LOCAL_CODE_INTEL_SKILL);

  return { mcpPath, rulePath, hooksPath, skillPath, cliPath, createdMcp };
}
