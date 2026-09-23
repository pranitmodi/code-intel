import { join } from 'node:path';
import { isPlainObject, parseJsoncObject, sameJson, setJsoncValue } from '../editors/jsonc.js';

/** Matches our hook scripts from any install location, including older ones. */
const OUR_HOOK_SCRIPT = /[\\/]dist[\\/]cursor[\\/](?:sessionHookMain|preferHookMain)\.js\b/;

function shellPath(path: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(path) ? path : `"${path}"`;
}

export function hookCommands(packageRoot: string): {
  sessionStart: { command: string }[];
  preToolUse: { command: string; matcher: string }[];
  subagentStart: { command: string; matcher: string }[];
} {
  const session = `node ${shellPath(join(packageRoot, 'dist', 'cursor', 'sessionHookMain.js'))}`;
  const prefer = `node ${shellPath(join(packageRoot, 'dist', 'cursor', 'preferHookMain.js'))}`;
  return {
    sessionStart: [{ command: session }],
    preToolUse: [{ command: prefer, matcher: 'Grep|Glob|Task' }],
    subagentStart: [{ command: prefer, matcher: 'explore' }]
  };
}

function isOurHook(item: unknown): boolean {
  return isPlainObject(item) && typeof item.command === 'string' && OUR_HOOK_SCRIPT.test(item.command);
}

/**
 * Install our hooks alongside the user's own. An existing entry for one of our
 * scripts (for example from a previous install path) is replaced in place.
 */
export function mergeCursorHooksConfig(existingRaw: string | undefined, packageRoot: string): string {
  const fixHint = 'fix or move it before re-running cursor-install';
  const doc = parseJsoncObject(
    existingRaw,
    (reason) => `Existing ~/.cursor/hooks.json is not valid JSON (${reason}); ${fixHint}.`
  );
  const hooks = doc.value.hooks;
  if (hooks !== undefined && !isPlainObject(hooks)) {
    throw new Error(`"hooks" in ~/.cursor/hooks.json must be an object; ${fixHint}.`);
  }

  let text = doc.text;
  if (doc.value.version === undefined) text = setJsoncValue(text, ['version'], 1);

  for (const [event, ours] of Object.entries(hookCommands(packageRoot))) {
    const existing = hooks?.[event];
    const current: unknown[] = Array.isArray(existing) ? existing : [];
    const next: unknown[] = [];
    let placed = false;
    for (const item of current) {
      if (!isOurHook(item)) next.push(item);
      else if (!placed) {
        next.push(...ours);
        placed = true;
      }
    }
    if (!placed) next.push(...ours);
    if (!Array.isArray(existing) || !sameJson(current, next)) {
      text = setJsoncValue(text, ['hooks', event], next);
    }
  }

  if (existingRaw !== undefined && text === doc.text) return existingRaw;
  return /\r?\n$/.test(text) ? text : `${text}\n`;
}
