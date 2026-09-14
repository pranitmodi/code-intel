/** Bounded parallel map — keeps at most `concurrency` promises in flight. */
export async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await fn(item, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
}

/** FIFO mutex so LanceDB writes stay single-writer while file parse/embed overlap. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
