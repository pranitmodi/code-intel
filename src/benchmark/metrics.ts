export function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (k <= 0) return 0;
  const top = retrieved.slice(0, k);
  if (top.length === 0) return 0;
  const hits = top.filter((item) => relevant.has(item)).length;
  return hits / top.length;
}

export function recallAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = retrieved.slice(0, k);
  const hits = top.filter((item) => relevant.has(item)).length;
  return hits / relevant.size;
}

export function meanReciprocalRank(retrieved: string[], relevant: Set<string>): number {
  const index = retrieved.findIndex((item) => relevant.has(item));
  if (index < 0) return 0;
  return 1 / (index + 1);
}

export function dcg(gains: number[]): number {
  return gains.reduce((sum, gain, i) => sum + gain / Math.log2(i + 2), 0);
}

export function ndcgAtK(
  retrieved: string[],
  relevanceLevels: Record<string, number>,
  k: number
): number {
  const gains = retrieved.slice(0, k).map((item) => relevanceLevels[item] ?? 0);
  const ideal = Object.values(relevanceLevels)
    .sort((a, b) => b - a)
    .slice(0, k);
  const denom = dcg(ideal);
  if (denom === 0) return 0;
  return dcg(gains) / denom;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export function tokenReductionPercent(baselineTokens: number, systemTokens: number): number {
  if (baselineTokens <= 0) return 0;
  return ((baselineTokens - systemTokens) / baselineTokens) * 100;
}
