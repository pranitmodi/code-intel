import { randomBytes } from 'node:crypto';

/**
 * What one conversation has already received, so later replies need not send
 * the same unchanged code again. A context is opened by `get_task_context`
 * and named in its reply (`ctx`); other tools deduplicate only when the agent
 * passes that name back. Nothing is keyed by process or connection, because
 * Cursor and VS Code serve several chats from one server process.
 */

/** FNV-1a of a line without trailing whitespace: equal lines hash equal wherever they moved. */
function lineHash(line: string): number {
  const text = line.replace(/\s+$/, '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface LineRun {
  /** First and last line numbers of the run, 1-based. */
  start: number;
  end: number;
  /** The agent already has these exact lines from this context. */
  seen: boolean;
}

/** Seen runs shorter than this are resent: a stub costs about as much as a few lines. */
export const MIN_STUB_LINES = 8;

export class ContextLedger {
  private readonly files = new Map<string, Map<number, number>>();
  /** Tool calls made against this context. */
  calls = 0;
  sentLines = 0;
  avoidedLines = 0;
  lastUsed: number;

  constructor(
    readonly id: string,
    readonly repoRoot: string,
    now = Date.now()
  ) {
    this.lastUsed = now;
  }

  /** Remember that `lines` (starting at `startLine`) of `path` were sent. */
  record(path: string, startLine: number, lines: string[]): void {
    const sent = this.files.get(path) ?? new Map<number, number>();
    lines.forEach((line, i) => sent.set(startLine + i, lineHash(line)));
    this.files.set(path, sent);
    this.sentLines += lines.length;
  }

  /** Split lines into runs the agent already has unchanged and runs it does not. */
  classify(path: string, startLine: number, lines: string[]): LineRun[] {
    const sent = this.files.get(path);
    const runs: LineRun[] = [];
    lines.forEach((line, i) => {
      const number = startLine + i;
      const seen = sent?.get(number) === lineHash(line);
      const last = runs.at(-1);
      if (last && last.seen === seen && last.end === number - 1) last.end = number;
      else runs.push({ start: number, end: number, seen });
    });
    // Short seen runs are not worth a stub; fold them into their neighbours.
    for (const run of runs) if (run.seen && run.end - run.start + 1 < MIN_STUB_LINES) run.seen = false;
    return runs.reduce<LineRun[]>((merged, run) => {
      const last = merged.at(-1);
      if (last && last.seen === run.seen && last.end === run.start - 1) last.end = run.end;
      else merged.push({ ...run });
      return merged;
    }, []);
  }

  /** Whether every line was already sent unchanged. */
  fullySeen(path: string, startLine: number, lines: string[]): boolean {
    const sent = this.files.get(path);
    return lines.length > 0 && lines.every((line, i) => sent?.get(startLine + i) === lineHash(line));
  }
}

export interface SessionStoreOptions {
  /** Idle time after which a context is forgotten. */
  ttlMs?: number;
  maxContexts?: number;
  /** Fixed prefix for context ids (`CODE_INTEL_CTX_NONCE`), so benchmark replies are reproducible. */
  nonce?: string;
}

const DEFAULT_TTL_MS = 45 * 60 * 1000;
const DEFAULT_MAX_CONTEXTS = 64;

export class SessionStore {
  private readonly contexts = new Map<string, ContextLedger>();
  private readonly nonce: string;
  private counter = 0;

  constructor(private readonly options: SessionStoreOptions = {}) {
    this.nonce = options.nonce ?? process.env.CODE_INTEL_CTX_NONCE ?? randomBytes(2).toString('hex');
  }

  open(repoRoot: string, now = Date.now()): ContextLedger {
    this.sweep(now);
    this.counter += 1;
    const ledger = new ContextLedger(`${this.nonce}-${this.counter}`, repoRoot, now);
    this.contexts.set(ledger.id, ledger);
    while (this.contexts.size > (this.options.maxContexts ?? DEFAULT_MAX_CONTEXTS)) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) break;
      this.contexts.delete(oldest);
    }
    return ledger;
  }

  /** The named context if it exists, belongs to this repo, and has not expired. */
  get(id: string | undefined, repoRoot: string, now = Date.now()): ContextLedger | undefined {
    if (!id) return undefined;
    this.sweep(now);
    const ledger = this.contexts.get(id.trim());
    if (!ledger || ledger.repoRoot !== repoRoot) return undefined;
    ledger.lastUsed = now;
    // Most recently used last, so eviction drops the stalest context.
    this.contexts.delete(ledger.id);
    this.contexts.set(ledger.id, ledger);
    return ledger;
  }

  private sweep(now: number): void {
    const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS;
    for (const [id, ledger] of this.contexts) if (now - ledger.lastUsed > ttl) this.contexts.delete(id);
  }
}

/** Off with `CODE_INTEL_MCP_SESSION=0`: every reply is then sent in full. */
export function sessionDedupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'off', 'no'].includes(env.CODE_INTEL_MCP_SESSION?.trim().toLowerCase() ?? '');
}
