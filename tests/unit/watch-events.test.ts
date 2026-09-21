import { describe, expect, it } from 'vitest';
import { planWatchIndex, WATCH_FULL_INDEX_THRESHOLD } from '../../src/indexer/watch.js';

describe('planWatchIndex', () => {
  const options = { allowSensitiveFiles: false, extraIgnorePatterns: [] as string[] };

  it('plans a partial upsert for a single source edit', () => {
    const plan = planWatchIndex('/repo', [{ type: 'update', path: '/repo/src/a.ts' }], options);
    expect(plan.mode).toBe('partial');
    expect(plan.upserts).toEqual(['src/a.ts']);
    expect(plan.deletes).toEqual([]);
  });

  it('records deletes even when the file is gone', () => {
    const plan = planWatchIndex('/repo', [{ type: 'delete', path: '/repo/src/gone.ts' }], options);
    expect(plan.deletes).toEqual(['src/gone.ts']);
  });

  it('falls back to a full scan when a burst exceeds the threshold', () => {
    const events = Array.from({ length: WATCH_FULL_INDEX_THRESHOLD + 1 }, (_, i) => ({
      type: 'update',
      path: `/repo/src/f${i}.ts`
    }));
    expect(planWatchIndex('/repo', events, options).mode).toBe('full');
  });
});
