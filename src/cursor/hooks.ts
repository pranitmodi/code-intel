import { join } from 'node:path';

export function hookCommands(packageRoot: string): {
  sessionStart: { command: string }[];
  preToolUse: { command: string; matcher: string }[];
  subagentStart: { command: string; matcher: string }[];
} {
  const session = `node ${join(packageRoot, 'dist', 'cursor', 'sessionHookMain.js')}`;
  const prefer = `node ${join(packageRoot, 'dist', 'cursor', 'preferHookMain.js')}`;
  return {
    sessionStart: [{ command: session }],
    preToolUse: [{ command: prefer, matcher: 'Grep|Glob|Task' }],
    subagentStart: [{ command: prefer, matcher: 'explore' }]
  };
}

export function mergeCursorHooksConfig(existingRaw: string | undefined, packageRoot: string): string {
  let existing: { version?: number; hooks?: Record<string, unknown[]> } = { version: 1, hooks: {} };
  if (existingRaw?.trim()) {
    try {
      const parsed = JSON.parse(existingRaw) as { version?: number; hooks?: Record<string, unknown[]> };
      if (parsed && typeof parsed === 'object') {
        existing = {
          version: parsed.version ?? 1,
          hooks: parsed.hooks && typeof parsed.hooks === 'object' ? { ...parsed.hooks } : {}
        };
      }
    } catch {
      throw new Error('Existing ~/.cursor/hooks.json is not valid JSON; fix or move it before re-running cursor-install.');
    }
  }

  const ours = hookCommands(packageRoot);
  const hooks = existing.hooks ?? {};
  for (const [event, entries] of Object.entries(ours)) {
    const current = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    for (const entry of entries) {
      const already = current.some(
        (item) => item && typeof item === 'object' && (item as { command?: string }).command === entry.command
      );
      if (!already) current.push(entry);
    }
    hooks[event] = current;
  }

  return `${JSON.stringify({ version: existing.version ?? 1, hooks }, null, 2)}\n`;
}
