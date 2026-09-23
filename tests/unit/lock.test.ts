import { spawn } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, IndexerLockedError } from '../../src/indexer/lock.js';

const LOCK_MODULE = resolve('src/indexer/lock.ts');

interface ContenderResult {
  won: boolean;
  acquiredAt: number;
  releasedAt: number;
}

/** Runs `acquireLock` in a separate Node process and reports when it held the lock. */
function contender(lockFile: string, startAt: number, holdMs: number): Promise<ContenderResult> {
  const script = `
    const { acquireLock } = await import(${JSON.stringify(LOCK_MODULE)});
    while (Date.now() < ${startAt}) {}
    try {
      const release = acquireLock(${JSON.stringify(lockFile)});
      const acquiredAt = Date.now();
      await new Promise((r) => setTimeout(r, ${holdMs}));
      const releasedAt = Date.now();
      release();
      console.log(JSON.stringify({ won: true, acquiredAt, releasedAt }));
    } catch {
      console.log(JSON.stringify({ won: false, acquiredAt: 0, releasedAt: 0 }));
    }
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', () => resolvePromise(JSON.parse(out.trim()) as ContenderResult));
  });
}

describe('index lock', () => {
  let dir: string;
  let lockFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-intel-lock-'));
    lockFile = join(dir, 'index', '.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a second holder in the same process and frees the lock on release', () => {
    const release = acquireLock(lockFile);
    expect(() => acquireLock(lockFile)).toThrow(IndexerLockedError);
    release();
    expect(existsSync(lockFile)).toBe(false);
    acquireLock(lockFile)();
  });

  it('reclaims a lock whose process no longer exists', () => {
    acquireLock(lockFile)();
    writeFileSync(lockFile, '2147483646');
    const release = acquireLock(lockFile);
    expect(readFileSync(lockFile, 'utf-8')).toBe(String(process.pid));
    release();
  });

  it('respects an empty lock that is still being written, but reclaims an old one', () => {
    acquireLock(lockFile)();
    writeFileSync(lockFile, '');
    expect(() => acquireLock(lockFile)).toThrow(IndexerLockedError);

    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);
    acquireLock(lockFile)();
  });

  it('does not delete a lock that another process has since taken over', () => {
    const release = acquireLock(lockFile);
    writeFileSync(lockFile, '1');
    release();
    expect(readFileSync(lockFile, 'utf-8')).toBe('1');
  });

  it('never lets two processes hold the lock at the same time', async () => {
    acquireLock(lockFile)();
    const startAt = Date.now() + 3_000;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => contender(lockFile, startAt, 600))
    );
    const holds = results.filter((result) => result.won).sort((a, b) => a.acquiredAt - b.acquiredAt);
    expect(holds.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < holds.length; i++) {
      expect(holds[i]!.acquiredAt).toBeGreaterThanOrEqual(holds[i - 1]!.releasedAt);
    }
    expect(existsSync(lockFile)).toBe(false);
  });

  it('blocks this process while another process holds the lock', async () => {
    acquireLock(lockFile)();
    const holder = contender(lockFile, Date.now(), 1_500);
    const deadline = Date.now() + 5_000;
    while (!existsSync(lockFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(() => acquireLock(lockFile)).toThrow(/pid \d+/);
    expect((await holder).won).toBe(true);
    acquireLock(lockFile)();
  });
});
