import { describe, expect, it, vi } from 'vitest';
import { FreshnessCache, PENDING_GRACE_MS, staleFromSnapshot } from '../../src/mcp/freshness.js';
import type { WatchSnapshot } from '../../src/indexer/watch.js';

const idle: WatchSnapshot = { running: false, pendingSince: null, failing: false, caughtUp: true };

describe('staleFromSnapshot', () => {
  it('trusts a caught-up watcher with nothing queued', () => {
    expect(staleFromSnapshot(idle)).toBe(false);
  });

  it('cannot vouch for the tree before the startup catch-up finishes', () => {
    expect(staleFromSnapshot({ ...idle, caughtUp: false })).toBeUndefined();
  });

  it('treats edits inside the debounce window as fresh and older ones as stale', () => {
    const now = 1_000_000;
    expect(staleFromSnapshot({ ...idle, pendingSince: now - 1_000 }, now)).toBe(false);
    expect(staleFromSnapshot({ ...idle, pendingSince: now - PENDING_GRACE_MS - 1 }, now)).toBe(true);
  });

  it('reports stale while a failed batch waits for a retry', () => {
    expect(staleFromSnapshot({ ...idle, failing: true })).toBe(true);
  });
});

describe('FreshnessCache', () => {
  it('answers from a live watcher without walking the tree', async () => {
    const check = vi.fn(async () => true);
    const cache = new FreshnessCache(check);
    cache.registerWatcher('/repo', () => idle);
    expect(await cache.peek('/repo')).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it('measures once, then serves the cached result within the TTL', async () => {
    const check = vi.fn(async () => true);
    const cache = new FreshnessCache(check, { ttlMs: 60_000 });
    expect(await cache.peek('/repo', 1_000)).toBe(true);
    expect(await cache.peek('/repo', 2_000)).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('never makes a reply wait for a slow first walk', async () => {
    let finish: (value: boolean) => void = () => undefined;
    const check = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const cache = new FreshnessCache(check, { maxWaitMs: 10 });
    expect(await cache.peek('/repo')).toBeNull();
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cache.peek('/repo')).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('serves the previous value while an expired entry is re-measured', async () => {
    const results = [false, true];
    const check = vi.fn(async () => results.shift() ?? true);
    const cache = new FreshnessCache(check, { ttlMs: 100 });
    expect(await cache.peek('/repo', 0)).toBe(false);
    expect(await cache.peek('/repo', Date.now() + 1_000)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cache.peek('/repo')).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('falls back to measuring once the watcher stops', async () => {
    const check = vi.fn(async () => true);
    const cache = new FreshnessCache(check);
    cache.registerWatcher('/repo', () => idle);
    cache.unregisterWatcher('/repo');
    expect(await cache.peek('/repo')).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
