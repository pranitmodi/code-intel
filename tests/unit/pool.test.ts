import { describe, expect, it } from 'vitest';
import { mapPool, Mutex } from '../../src/utils/pool.js';

describe('mapPool', () => {
  it('processes every item with a bounded number of workers', async () => {
    const seen: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    await mapPool([1, 2, 3, 4, 5], 2, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push(item);
      inFlight--;
    });

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('is a no-op for an empty list', async () => {
    let calls = 0;
    await mapPool([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});

describe('Mutex', () => {
  it('runs overlapping work one at a time', async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const first = mutex.run(async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first-end');
      return 1;
    });
    const second = mutex.run(async () => {
      order.push('second-start');
      order.push('second-end');
      return 2;
    });

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });
});
