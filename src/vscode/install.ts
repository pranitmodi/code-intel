import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCliEntry } from '../editors/cliEntry.js';
import { readTextIfExists, writeIfChanged } from '../editors/jsonc.js';
import { WORKSPACE_FOLDER_ARG, upsertMcpServer } from '../editors/mcpConfig.js';
import {
  LOCAL_CODE_INTEL_INSTRUCTIONS,
  LOCAL_CODE_INTEL_INSTRUCTIONS_FILENAME
} from './instructions.js';

/** Editor data directories that use VS Code's `mcp.json` layout, most common first. */
const VSCODE_APP_DIRS: [string, ...string[]] = ['Code', 'Code - Insiders', 'VSCodium'];

export type VscodeInstallScope = 'user' | 'workspace';

export interface VscodeUserDirOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface VscodeInstallOptions extends VscodeUserDirOptions {
  /** `user` writes the VS Code profile; `workspace` writes `.vscode/` and `.github/` in the repo. */
  scope?: VscodeInstallScope;
  /** Explicit VS Code `User` directory, bypassing detection (user scope). */
  userDir?: string;
  /** Repository root that receives the config (workspace scope). */
  workspaceRoot?: string;
  cliPath?: string;
  serverEnv?: Record<string, string>;
}

export interface VscodeInstallResult {
  scope: VscodeInstallScope;
  mcpPath: string;
  instructionPaths: string[];
  cliPath: string;
  createdMcp: boolean;
}

function vscodeConfigBase(options: VscodeUserDirOptions): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME ?? join(home, '.config');
}

export function vscodeUserDirCandidates(
  options: VscodeUserDirOptions = {}
): [string, ...string[]] {
  const base = vscodeConfigBase(options);
  const [stable, ...others] = VSCODE_APP_DIRS;
  return [join(base, stable, 'User'), ...others.map((app) => join(base, app, 'User'))];
}

export function resolveVscodeUserDir(options: VscodeUserDirOptions = {}): string {
  const candidates = vscodeUserDirCandidates(options);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * VS Code needs an explicit transport type, and reads servers from `servers`
 * rather than Cursor's `mcpServers`.
 */
export function vscodeMcpServerEntry(
  cliPath: string,
  env?: Record<string, string>
): { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> } {
  return {
    type: 'stdio',
    command: 'node',
    args: [cliPath, 'mcp', '--repo', WORKSPACE_FOLDER_ARG],
    ...(env && Object.keys(env).length > 0 ? { env } : {})
  };
}

/**
 * VS Code's `mcp.json` is JSON with comments; user comments and formatting
 * outside our entry are preserved.
 */
export function mergeVscodeMcpConfig(
  existingRaw: string | undefined,
  cliPath: string,
  options: { serverEnv?: Record<string, string>; configPath?: string } = {}
): string {
  return upsertMcpServer(existingRaw, {
    containerKey: 'servers',
    entry: (env) => vscodeMcpServerEntry(cliPath, env),
    serverEnv: options.serverEnv,
    label: options.configPath ?? 'the VS Code mcp.json',
    command: 'vscode-install'
  });
}

interface VscodeTargets {
  mcpPath: string;
  instructionPaths: string[];
}

function workspaceTargets(workspaceRoot: string): VscodeTargets {
  return {
    mcpPath: join(workspaceRoot, '.vscode', 'mcp.json'),
    instructionPaths: [
      join(workspaceRoot, '.github', 'instructions', LOCAL_CODE_INTEL_INSTRUCTIONS_FILENAME)
    ]
  };
}

function userTargets(userDir: string, home: string): VscodeTargets {
  return {
    mcpPath: join(userDir, 'mcp.json'),
    instructionPaths: [
      join(userDir, 'prompts', LOCAL_CODE_INTEL_INSTRUCTIONS_FILENAME),
      // Newer VS Code builds read user-level instructions from this
      // harness-agnostic folder instead of the profile directory.
      join(home, '.copilot', 'instructions', LOCAL_CODE_INTEL_INSTRUCTIONS_FILENAME)
    ]
  };
}

export function installVscodeIntegration(options: VscodeInstallOptions = {}): VscodeInstallResult {
  const scope = options.scope ?? 'user';
  const cliPath = options.cliPath ?? resolveCliEntry();
  const home = options.home ?? homedir();

  const { mcpPath, instructionPaths } =
    scope === 'workspace'
      ? workspaceTargets(resolve(options.workspaceRoot ?? process.cwd()))
      : userTargets(options.userDir ?? resolveVscodeUserDir({ ...options, home }), home);

  const createdMcp = !existsSync(mcpPath);
  const previousMcp = readTextIfExists(mcpPath);
  const mcp = mergeVscodeMcpConfig(previousMcp, cliPath, {
    serverEnv: options.serverEnv,
    configPath: mcpPath
  });
  writeIfChanged(mcpPath, mcp, previousMcp);
  for (const path of instructionPaths) writeIfChanged(path, LOCAL_CODE_INTEL_INSTRUCTIONS);

  return { scope, mcpPath, instructionPaths, cliPath, createdMcp };
}
