import { isPlainObject, parseJsoncObject, sameJson, setJsoncValue } from './jsonc.js';

export const MCP_SERVER_NAME = 'local-code-intelligence';

/** Repository placeholder expanded by both Cursor and VS Code when they spawn the server. */
export const WORKSPACE_FOLDER_ARG = '${workspaceFolder}';

/** Shallow copy of `container[key]` when it is a plain object, otherwise a new object. */
export function plainObjectAt(
  container: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = container[key];
  return isPlainObject(value) ? { ...value } : {};
}

export function mergeServerEnv(
  existingEnv: Record<string, string>,
  serverEnv?: Record<string, string>
): Record<string, string> {
  const merged = { ...existingEnv, ...serverEnv };
  if (existingEnv.NODE_OPTIONS && serverEnv?.NODE_OPTIONS) {
    const options = new Set(
      `${existingEnv.NODE_OPTIONS} ${serverEnv.NODE_OPTIONS}`.trim().split(/\s+/).filter(Boolean)
    );
    merged.NODE_OPTIONS = [...options].join(' ');
  }
  return merged;
}

/** Environment already configured for this server in an editor config file. */
export function existingServerEnv(
  existingRaw: string | undefined,
  containerKey: string
): Record<string, string> {
  if (!existingRaw?.trim()) return {};
  let doc;
  try {
    doc = parseJsoncObject(existingRaw, (reason) => reason);
  } catch {
    return {};
  }
  const container = doc.value[containerKey];
  if (!isPlainObject(container)) return {};
  const server = container[MCP_SERVER_NAME];
  if (!isPlainObject(server)) return {};
  return plainObjectAt(server, 'env') as Record<string, string>;
}

export interface UpsertMcpServerOptions {
  /** `mcpServers` for Cursor, `servers` for VS Code. */
  containerKey: string;
  entry: (env?: Record<string, string>) => Record<string, unknown>;
  serverEnv?: Record<string, string>;
  /** How the file is named in error messages. */
  label: string;
  /** CLI command to re-run once the file is fixed. */
  command: string;
}

/**
 * Add or refresh this server's entry in an editor's MCP config. Other servers,
 * unknown keys on our entry, comments, and formatting are left untouched.
 */
export function upsertMcpServer(existingRaw: string | undefined, options: UpsertMcpServerOptions): string {
  const fixHint = `fix or move it before re-running ${options.command}`;
  const doc = parseJsoncObject(
    existingRaw,
    (reason) => `Existing ${options.label} is not valid JSON (${reason}); ${fixHint}.`
  );
  const container = doc.value[options.containerKey];
  if (container !== undefined && !isPlainObject(container)) {
    throw new Error(`"${options.containerKey}" in ${options.label} must be an object; ${fixHint}.`);
  }

  const existingServer = plainObjectAt(container ?? {}, MCP_SERVER_NAME);
  const mergedEnv = mergeServerEnv(
    plainObjectAt(existingServer, 'env') as Record<string, string>,
    options.serverEnv
  );
  const next = {
    ...existingServer,
    ...options.entry(Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined)
  };
  if (existingRaw !== undefined && isPlainObject(container?.[MCP_SERVER_NAME]) && sameJson(existingServer, next)) {
    return existingRaw;
  }
  return setJsoncValue(doc.text, [options.containerKey, MCP_SERVER_NAME], next);
}
