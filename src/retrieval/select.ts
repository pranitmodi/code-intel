import type { RetrievalCandidate } from './types.js';

export interface SelectOptions {
  limit: number;
  maxTokens?: number;
  minScore?: number;
  /** Like minScore, but exact symbol/identifier/file-name matches are exempt. */
  minOrganicScore?: number;
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

/** Word-set Jaccard at or above this means the chunk repeats one already selected. */
const DUPLICATE_SIMILARITY = 0.8;
/** Short chunks share vocabulary by accident, so only compare chunks with this many distinct words. */
const DUPLICATE_MIN_WORDS = 12;

function distinctWords(content: string): Set<string> {
  return new Set(content.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const word of small) if (large.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
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
  const selectedWords: Set<string>[] = [];
  let estimatedTokens = 0;
  const minScore = options.minScore ?? 0;

  for (const candidate of ranked) {
    if (selected.length >= options.limit) {
      discarded.push({ id: candidate.id, file: candidate.file, reason: 'limit' });
      continue;
    }
    if (
      candidate.score.total < minScore ||
      (!candidate.exactFloor && candidate.score.total < (options.minOrganicScore ?? 0))
    ) {
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
    const words = distinctWords(candidate.content);
    if (
      words.size >= DUPLICATE_MIN_WORDS &&
      selectedWords.some((other) => other.size >= DUPLICATE_MIN_WORDS && similarity(words, other) >= DUPLICATE_SIMILARITY)
    ) {
      discarded.push({ id: candidate.id, file: candidate.file, reason: 'duplicate' });
      continue;
    }

    selected.push(candidate);
    selectedWords.push(words);
    estimatedTokens += candidate.estimatedTokens;
    perFile.set(candidate.file, fileCount + 1);
    perSymbol.set(key, symbolCount + 1);
    if (expansionOnly) expansionOnlyFiles.add(candidate.file);
  }

  return { selected, discarded, estimatedTokens };
}

/**
 * Same chunk found by several retrievers keeps the stronger score rather than
 * a sum: adding full-text (BM25) evidence to vector similarity lifted prose and
 * test chunks over the code on natural-language tasks in the labeled benchmark.
 */
export function mergeCandidates(existing: RetrievalCandidate, incoming: RetrievalCandidate): RetrievalCandidate {
  const sources = [...new Set([...existing.sources, ...incoming.sources])];
  const winner = incoming.score.total > existing.score.total ? incoming : existing;
  const exactFloor = Math.max(existing.exactFloor ?? 0, incoming.exactFloor ?? 0);
  const { exactFloor: _floor, ...base } = existing;
  return {
    ...base,
    sources,
    score: winner.score,
    ...(exactFloor > 0 ? { exactFloor } : {}),
    extra: {
      imports: [...new Set([...existing.extra.imports, ...incoming.extra.imports])],
      exports: [...new Set([...existing.extra.exports, ...incoming.extra.exports])],
      referencedSymbols: [
        ...new Set([...existing.extra.referencedSymbols, ...incoming.extra.referencedSymbols])
      ],
      isTest: existing.extra.isTest || incoming.extra.isTest,
      isConfig: existing.extra.isConfig || incoming.extra.isConfig
    },
    reason: winner.reason
  };
}
