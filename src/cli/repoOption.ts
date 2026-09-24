import { resolve } from 'node:path';

/**
 * Editors expand `${workspaceFolder}` before spawning the server. A window with
 * no folder, or a multi-root workspace, leaves it empty or literal instead.
 */
const EDITOR_VARIABLE = /^\$\{[^}]*\}$/;

/**
 * Path from `--repo`, or undefined when the host passed nothing usable: a bare
 * flag (commander yields `true` for an optional argument), an empty string, or
 * a variable the editor never expanded.
 */
export function repoOptionPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || EDITOR_VARIABLE.test(trimmed)) return undefined;
  return resolve(trimmed);
}

/** `--repo` was given, but carried no usable path. */
export function repoOptionUnresolved(value: unknown): boolean {
  return value !== undefined && repoOptionPath(value) === undefined;
}

export const REPO_OPTION_UNRESOLVED_HINT =
  '[WARN] --repo did not receive a folder path (the editor left ${workspaceFolder} unexpanded). ' +
  'Falling back to the current folder; tools still work when a call passes repo explicitly. ' +
  'Open a single folder in the editor, or put an absolute path in the MCP config.';
