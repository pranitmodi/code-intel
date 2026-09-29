import { describe, expect, it } from 'vitest';
import { renderTaskContext } from '../../src/mcp/render.js';
import { ContextLedger, MIN_STUB_LINES, SessionStore } from '../../src/mcp/session.js';
import { renderFileRanges, type FileRangeResult } from '../../src/search/getFileContext.js';
import type { ContextPackage } from '../../src/retrieval/types.js';

const lines = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);

describe('ContextLedger', () => {
  it('knows which exact lines were sent, wherever the request starts', () => {
    const ledger = new ContextLedger('c-1', '/repo');
    ledger.record('a.ts', 10, lines(10, 40));
    expect(ledger.fullySeen('a.ts', 10, lines(10, 40))).toBe(true);
    expect(ledger.fullySeen('a.ts', 20, lines(20, 30))).toBe(true);
    expect(ledger.fullySeen('a.ts', 5, lines(5, 40))).toBe(false);
    expect(ledger.classify('a.ts', 1, lines(1, 60))).toEqual([
      { start: 1, end: 9, seen: false },
      { start: 10, end: 40, seen: true },
      { start: 41, end: 60, seen: false }
    ]);
  });

  it('treats edited lines as unseen', () => {
    const ledger = new ContextLedger('c-1', '/repo');
    ledger.record('a.ts', 1, lines(1, 20));
    const edited = lines(1, 20);
    edited[9] = 'changed';
    expect(ledger.fullySeen('a.ts', 1, edited)).toBe(false);
    expect(ledger.classify('a.ts', 1, edited).some((run) => run.seen && run.start <= 10 && run.end >= 10)).toBe(false);
  });

  it('does not stub seen runs too short to be worth it', () => {
    const ledger = new ContextLedger('c-1', '/repo');
    ledger.record('a.ts', 5, lines(5, 5 + MIN_STUB_LINES - 2));
    expect(ledger.classify('a.ts', 1, lines(1, 30)).every((run) => !run.seen)).toBe(true);
  });
});

describe('SessionStore', () => {
  it('scopes contexts to a repo and forgets idle ones', () => {
    const store = new SessionStore({ nonce: 'n', ttlMs: 1_000 });
    const ledger = store.open('/repo', 0);
    expect(ledger.id).toBe('n-1');
    expect(store.get('n-1', '/repo', 500)).toBe(ledger);
    expect(store.get('n-1', '/other', 500)).toBeUndefined();
    expect(store.get('n-1', '/repo', 2_000)).toBeUndefined();
    expect(store.get(undefined, '/repo', 0)).toBeUndefined();
  });

  it('evicts the least recently used context beyond its limit', () => {
    const store = new SessionStore({ nonce: 'n', maxContexts: 2 });
    store.open('/repo', 0);
    store.open('/repo', 1);
    store.get('n-1', '/repo', 2);
    store.open('/repo', 3);
    expect(store.get('n-1', '/repo', 4)).toBeDefined();
    expect(store.get('n-2', '/repo', 4)).toBeUndefined();
  });
});

const score = { total: 0.9, semantic: 0.6, keyword: 0.4, symbol: 1, path: 0, structural: 0.7, dependency: 0, reference: 0, test: 0, recency: 0.2 };
const pkg: ContextPackage = {
  query: 'q',
  summary: '',
  files: [{ path: 'src/a.ts', reason: 'r', score, chunks: [{ symbol: 'a', startLine: 1, endLine: 12, content: lines(1, 12).join('\n') }] }],
  estimatedTokens: 10,
  retrievalStats: { candidatesConsidered: 1, candidatesSelected: 1, expansionHops: 0 },
  confidence: { score: 0.9, reason: 'Top results exceeded the confidence threshold.' }
};

describe('deduplicated replies', () => {
  it('names the context and stubs blocks a follow-up question would resend', () => {
    const ledger = new ContextLedger('n-1', '/repo');
    const first = renderTaskContext(pkg, { repoName: 'repo', ledger });
    expect(first).toContain('· ctx n-1 ·');
    expect(first).toContain('line 12');
    const second = renderTaskContext(pkg, { repoName: 'repo', ledger });
    expect(second).toContain('### [1] src/a.ts:1-12 a = already sent in this conversation, unchanged');
    expect(second).not.toContain('line 12');
    expect(second).toContain('1 block already sent');
    expect(ledger.avoidedLines).toBe(12);
  });

  it('trims already-sent stretches from a larger file read but resends an exact repeat', () => {
    const ledger = new ContextLedger('n-1', '/repo');
    ledger.record('src/a.ts', 1, lines(1, 12));
    const read = (start: number, end: number): FileRangeResult => ({
      file: 'src/a.ts', startLine: start, endLine: end, totalLines: 40, content: lines(start, end).join('\n'), omittedLines: 0
    });
    const wider = renderFileRanges([read(1, 30)], ledger);
    expect(wider).toContain('… lines 1-12 unchanged, already sent in this conversation …');
    expect(wider).toContain('line 13\n');
    expect(wider).not.toContain('line 5\n');
    const repeat = renderFileRanges([read(1, 12)], ledger);
    expect(repeat).toContain('line 5');
  });
});
