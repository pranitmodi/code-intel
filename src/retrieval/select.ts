import type { RetrievalCandidate } from './types.js';

export interface SelectOptions {
  limit: number;
  maxTokens?: number;
  minScore?: number;
  maxChunksPerFile: number;
  maxChunksPerSymbol: number;
  /** Prevent relationship expansion from crowding direct hits out of the first file slots. */
  maxExpansionOnlyFilesInTopK?: number;
  expansionTopK?: number;
}

export interface SelectResult {
  selected: RetrievalCandidate[];
  discarded: Array<{ id: string; file: string; reason: string }>;
  estimatedTokens: number;
}

function symbolKey(candidate: RetrievalCandidate): string {
  return (candidate.symbol ?? `${candidate.file}:${candidate.startLine}`).toLowerCase();
}

/**
 * Ranked greedy pack: keep the highest-value remaining candidate that fits
 * diversity caps and the token budget. Always keeps the first accepted chunk
 * even if it exceeds maxTokens so the caller is never empty when candidates exist.
 */
export function selectCandidates(
  ranked: RetrievalCandidate[],
  options: SelectOptions
): SelectResult {
  const perFile = new Map<string, number>();
  const perSymbol = new Map<string, number>();
  const selected: RetrievalCandidate[] = [];
  const discarded: SelectResult['discarded'] = [];
  const expansionOnlyFiles = new Set<string>();
  let estimatedTokens = 0;
  const minScore = options.minScore ?? 0;

  for (const candidate of ranked) {
    if (selected.length >= options.limit) {
      discarded.push({ id: candidate.id, file: candidate.file, reason: 'limit' });
      continue;
    }
    if (candidate.score.total < minScore) {
      discarded.push({ id: candidate.id, file: candidate.file, reason: 'min_score' });
      continue;
    }
    const fileCount = perFile.get(candidate.file) ?? 0;
    if (fileCount >= options.maxChunksPerFile) {
      discarded.push({ id: candidate.id, file: candidate.file, reason: 'per_file_cap' });
      continue;
    }
    const key = symbolKey(candidate);
    const symbolCount = perSymbol.get(key) ?? 0;
    if (symbolCount >= options.maxChunksPerSymbol) {
      discarded.push({ id: candidate.id, file: candidate.file, reason: 'per_symbol_cap' });
      continue;
    }
    const expansionOnly =
      candidate.sources.length > 0 && candidate.sources.every((source) => source === 'expansion');
    const expansionTopK = options.expansionTopK ?? 5;
    const maxExpansionFiles = options.maxExpansionOnlyFilesInTopK;
    if (
      expansionOnly &&
      selected.length < expansionTopK &&
      maxExpansionFiles !== undefined &&
      !expansionOnlyFiles.has(candidate.file) &&
      expansionOnlyFiles.size >= maxExpansionFiles
    ) {
      discarded.push({ id: candidate.id, file: candidate.file, reason: 'expansion_top_k_cap' });
      continue;
    }
    if (
      options.maxTokens &&
      selected.length > 0 &&
      estimatedTokens + candidate.estimatedTokens > options.maxTokens
    ) {
      discarded.push({ id: candidate.id, file: candidate.file, reason: 'token_budget' });
      continue;
    }

    selected.push(candidate);
    estimatedTokens += candidate.estimatedTokens;
    perFile.set(candidate.file, fileCount + 1);
    perSymbol.set(key, symbolCount + 1);
    if (expansionOnly) expansionOnlyFiles.add(candidate.file);
  }

  return { selected, discarded, estimatedTokens };
}

export function mergeCandidates(existing: RetrievalCandidate, incoming: RetrievalCandidate): RetrievalCandidate {
  const sources = [...new Set([...existing.sources, ...incoming.sources])];
  const score = existing.score.total >= incoming.score.total ? existing.score : incoming.score;
  return {
    ...existing,
    sources,
    score,
    extra: {
      imports: [...new Set([...existing.extra.imports, ...incoming.extra.imports])],
      exports: [...new Set([...existing.extra.exports, ...incoming.extra.exports])],
      referencedSymbols: [
        ...new Set([...existing.extra.referencedSymbols, ...incoming.extra.referencedSymbols])
      ],
      isTest: existing.extra.isTest || incoming.extra.isTest,
      isConfig: existing.extra.isConfig || incoming.extra.isConfig
    },
    reason: existing.score.total >= incoming.score.total ? existing.reason : incoming.reason
  };
}
