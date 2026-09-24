import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCliEntry } from '../editors/cliEntry.js';
import { isPlainObject, parseJsoncObject, readTextIfExists, setJsoncValue, writeIfChanged } from '../editors/jsonc.js';
import { WORKSPACE_FOLDER_ARG, existingServerEnv, upsertMcpServer } from '../editors/mcpConfig.js';
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

export interface PromptStringInput {
  type: 'promptString';
  id: string;
  description: string;
  password?: boolean;
}

/**
 * VS Code has no place to keep secrets in a config file, so credentials are
 * collected once through `inputs` prompts and stored by the editor instead.
 */
export const EMBEDDING_CREDENTIAL_INPUTS: Array<{ envVar: string; input: PromptStringInput }> = [
  {
    envVar: 'CODE_INTEL_EMBEDDING_API_KEY',
    input: {
      type: 'promptString',
      id: 'code-intel-embedding-api-key',
      description: 'code-intel: embedding API key',
      password: true
    }
  },
  {
    envVar: 'CODE_INTEL_EMBEDDING_USER',
    input: {
      type: 'promptString',
      id: 'code-intel-embedding-user',
      description: 'code-intel: embedding user name (leave blank if the endpoint does not need one)'
    }
  }
];

export interface VscodeInstallOptions extends VscodeUserDirOptions {
  /** `user` writes the VS Code profile; `workspace` writes `.vscode/` and `.github/` in the repo. */
  scope?: VscodeInstallScope;
  /** Explicit VS Code `User` directory, bypassing detection (user scope). */
  userDir?: string;
  /** Repository root that receives the config (workspace scope). */
  workspaceRoot?: string;
  /** Absolute repository or parent folder the user-scoped server should cover. */
  repoPath?: string;
  /** Node executable used by VS Code; defaults to this process, avoiding GUI PATH differences. */
  nodePath?: string;
  cliPath?: string;
  serverEnv?: Record<string, string>;
  /** Collect embedding credentials through VS Code prompts instead of plain text. */
  promptForCredentials?: boolean;
}

export interface VscodeInstallResult {
  scope: VscodeInstallScope;
  mcpPath: string;
  instructionPaths: string[];
  cliPath: string;
  nodePath: string;
  repoArgument: string;
  createdMcp: boolean;
  /** Environment variables VS Code will now prompt for on first start. */
  promptedFor: string[];
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
  env?: Record<string, string>,
  options: { nodePath?: string; repoArgument?: string } = {}
): { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> } {
  return {
    type: 'stdio',
    command: options.nodePath ?? process.execPath,
    args: [cliPath, 'mcp', '--repo', options.repoArgument ?? WORKSPACE_FOLDER_ARG],
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
  options: {
    serverEnv?: Record<string, string>;
    configPath?: string;
    nodePath?: string;
    repoArgument?: string;
  } = {}
): string {
  return upsertMcpServer(existingRaw, {
    containerKey: 'servers',
    entry: (env) =>
      vscodeMcpServerEntry(cliPath, env, {
        nodePath: options.nodePath,
        repoArgument: options.repoArgument
      }),
    serverEnv: options.serverEnv,
    label: options.configPath ?? 'the VS Code mcp.json',
    command: 'vscode-install'
  });
}

/**
 * Credential variables this config does not set yet, mapped to the prompt VS
 * Code should ask for. Values a user already wrote are left alone.
 */
function credentialEnvFor(existingRaw: string | undefined): Record<string, string> {
  const already = existingServerEnv(existingRaw, 'servers');
  const missing = EMBEDDING_CREDENTIAL_INPUTS.filter(({ envVar }) => !already[envVar]);
  return Object.fromEntries(missing.map(({ envVar, input }) => [envVar, `\${input:${input.id}}`]));
}

/** Add prompt definitions for `${input:…}` references, keeping any that exist. */
function upsertPromptInputs(text: string, inputs: PromptStringInput[]): string {
  if (inputs.length === 0) return text;
  const doc = parseJsoncObject(text, (reason) => `Cannot add credential prompts (${reason}).`);
  const existing = Array.isArray(doc.value.inputs) ? doc.value.inputs : [];
  const ids = new Set(
    existing.filter(isPlainObject).map((entry) => (typeof entry.id === 'string' ? entry.id : undefined))
  );
  const added = inputs.filter((input) => !ids.has(input.id));
  if (added.length === 0) return text;
  return setJsoncValue(doc.text, ['inputs'], [...existing, ...added]);
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
  const nodePath = options.nodePath ?? process.execPath;
  const home = options.home ?? homedir();
  // User-level config may be launched from empty or multi-root windows where
  // VS Code refuses to expand ${workspaceFolder}. Capture the install folder.
  // Workspace config keeps the variable so a committed file remains portable.
  const repoArgument =
    scope === 'user' ? resolve(options.repoPath ?? options.workspaceRoot ?? process.cwd()) : WORKSPACE_FOLDER_ARG;

  const { mcpPath, instructionPaths } =
    scope === 'workspace'
      ? workspaceTargets(resolve(options.workspaceRoot ?? process.cwd()))
      : userTargets(options.userDir ?? resolveVscodeUserDir({ ...options, home }), home);

  const createdMcp = !existsSync(mcpPath);
  const previousMcp = readTextIfExists(mcpPath);
  const credentialEnv = options.promptForCredentials ? credentialEnvFor(previousMcp) : {};
  const serverEnv = { ...options.serverEnv, ...credentialEnv };
  const merged = mergeVscodeMcpConfig(previousMcp, cliPath, {
    ...(Object.keys(serverEnv).length > 0 ? { serverEnv } : {}),
    configPath: mcpPath,
    nodePath,
    repoArgument
  });
  const promptedFor = Object.keys(credentialEnv);
  const mcp = upsertPromptInputs(
    merged,
    EMBEDDING_CREDENTIAL_INPUTS.filter(({ envVar }) => promptedFor.includes(envVar)).map(
      ({ input }) => input
    )
  );
  writeIfChanged(mcpPath, mcp, previousMcp);
  for (const path of instructionPaths) writeIfChanged(path, LOCAL_CODE_INTEL_INSTRUCTIONS);

  return {
    scope,
    mcpPath,
    instructionPaths,
    cliPath,
    nodePath,
    repoArgument,
    createdMcp,
    promptedFor
  };
}
