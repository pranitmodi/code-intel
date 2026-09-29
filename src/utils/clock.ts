/**
 * Current time in ms. `CODE_INTEL_CLOCK=<ISO time>` pins it so time-dependent
 * scores (recency) are reproducible in benchmarks and tests.
 */
export function clockNow(): number {
  const fixed = process.env.CODE_INTEL_CLOCK?.trim();
  if (fixed) {
    const parsed = Date.parse(fixed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}
