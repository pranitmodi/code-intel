import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCursorHooksConfig } from './hooks.js';
import { LOCAL_CODE_INTEL_SKILL } from './skill.js';
import { LOCAL_CODE_INTEL_RULE_FILENAME, LOCAL_CODE_INTEL_USER_RULE } from './userRule.js';

const SERVER_NAME = 'local-code-intelligence';

export interface CursorInstallResult {
  mcpPath: string;
  rulePath: string;
  hooksPath: string;
  skillPath: string;
  cliPath: string;
  createdMcp: boolean;
}

export function resolveCliEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, '..', '..');
  const distCli = join(packageRoot, 'dist', 'cli', 'index.js');
  if (existsSync(distCli)) return distCli;
  throw new Error(`Built CLI not found at ${distCli} — run \`npm run build\` first.`);
}

export function cursorMcpServerEntry(cliPath: string): { command: string; args: string[] } {
  return {
    command: 'node',
    args: [cliPath, 'mcp', '--repo', '${workspaceFolder}']
  };
}

export function mergeCursorMcpConfig(existingRaw: string | undefined, cliPath: string): string {
  let existing: Record<string, unknown> = {};
  if (existingRaw?.trim()) {
    try {
      const parsed = JSON.parse(existingRaw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error('Existing ~/.cursor/mcp.json is not valid JSON; fix or move it before re-running cursor-install.');
    }
  }

  const mcpServers =
    existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};

  mcpServers[SERVER_NAME] = cursorMcpServerEntry(cliPath);

  return `${JSON.stringify({ ...existing, mcpServers }, null, 2)}\n`;
}

export function packageRootFromCli(cliPath: string): string {
  const marker = `${sep}dist${sep}cli${sep}index.js`;
  if (cliPath.endsWith(marker)) return resolve(cliPath, '..', '..', '..');
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function installCursorIntegration(options: { cursorHome?: string; cliPath?: string } = {}): CursorInstallResult {
  const cursorHome = options.cursorHome ?? join(homedir(), '.cursor');
  const mcpPath = join(cursorHome, 'mcp.json');
  const rulesDir = join(cursorHome, 'rules');
  const rulePath = join(rulesDir, LOCAL_CODE_INTEL_RULE_FILENAME);
  const hooksPath = join(cursorHome, 'hooks.json');
  const skillPath = join(cursorHome, 'skills', 'local-code-intel', 'SKILL.md');
  const cliPath = options.cliPath ?? resolveCliEntry();
  const packageRoot = packageRootFromCli(cliPath);

  mkdirSync(cursorHome, { recursive: true });
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(dirname(skillPath), { recursive: true });

  const createdMcp = !existsSync(mcpPath);
  const previousMcp = existsSync(mcpPath) ? readFileSync(mcpPath, 'utf-8') : undefined;
  writeFileSync(mcpPath, mergeCursorMcpConfig(previousMcp, cliPath));
  writeFileSync(rulePath, LOCAL_CODE_INTEL_USER_RULE);
  const previousHooks = existsSync(hooksPath) ? readFileSync(hooksPath, 'utf-8') : undefined;
  writeFileSync(hooksPath, mergeCursorHooksConfig(previousHooks, packageRoot));
  writeFileSync(skillPath, LOCAL_CODE_INTEL_SKILL);

  return { mcpPath, rulePath, hooksPath, skillPath, cliPath, createdMcp };
}
