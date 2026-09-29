import { isTestPath } from '../chunker/chunkMetadata.js';
import { isDocPath } from './docs.js';
import type { TaskFacet } from './facets.js';
import { compareCandidates, overlapsSelected, type SelectOptions, type SelectResult } from './select.js';
import { chunkWordSet } from './terms.js';
import type { RetrievalCandidate } from './types.js';

/** What the reply says about one part of the request. */
export interface FacetCoverage {
  facetId: string;
  label: string;
  kind: TaskFacet['kind'];
  weight: number;
  /** `covered`: selected code addresses this part; `weak`: only partly; `missing`: not at all. */
  status: 'covered' | 'weak' | 'missing';
  strength: number;
  /** Selected chunks that address this part, best first. */
  evidence: Array<{ path: string; startLine: number; endLine: number }>;
}

export const COVERED_STRENGTH = 0.6;
export const WEAK_STRENGTH = 0.35;
/** Weak facets may carry at most this much of the request's weight before the reply stops counting as complete. */
const WEAK_WEIGHT_ALLOWED = 0.15;
/** Share of a candidate's general relevance added to its facet gain, so ties go to the stronger match. */
const TASK_GAIN_WEIGHT = 0.15;
/** Below this marginal gain another chunk adds nothing the reply lacks. */
const MIN_GAIN = 0.02;
/** A second piece of evidence for a facet is worth this share of the first, so strong facets get backup before the reply stops. */
const SECOND_EVIDENCE_SHARE = 0.3;
/**
 * Prose and tests restate what code does in the task's own words, so word
 * overlap overstates how much they cover unless the task asks for them.
 */
const DOC_FACTOR = 0.55;
const TEST_FACTOR = 0.55;

export interface FacetRanking {
  /** Candidate id -> rank (0 = best) in this facet's own retrieval results. */
  ranks: Map<string, number>;
}

/** Whether a chunk carries one of the facet's anchors verbatim: its symbol, a literal, a file name, or the text. */
function anchorMatches(candidate: RetrievalCandidate, anchors: string[]): boolean {
  if (anchors.length === 0) return false;
  const symbol = candidate.symbol?.split('.').pop();
  const literals = candidate.extra.literals ?? [];
  return anchors.some(
    (anchor) =>
      symbol === anchor ||
      literals.includes(anchor) ||
      candidate.file === anchor ||
      candidate.file.endsWith(`/${anchor}`) ||
      (anchor.length >= 6 && /[-_.A-Z]/.test(anchor) && candidate.content.includes(anchor))
  );
}

/**
 * How well each candidate covers each facet, 0..1. Deterministic and
 * independent of the embedding model's score scale: an exact anchor match
 * counts fully; otherwise it is the share of the facet's words the chunk
 * contains, weighted by how rare each word is among the candidates, nudged
 * up when the facet's own search ranked the chunk highly.
 */
export function facetRelevance(
  candidates: RetrievalCandidate[],
  facets: TaskFacet[],
  rankings: FacetRanking[],
  options: { wantsDocs?: boolean; wantsTests?: boolean } = {}
): Map<string, number[]> {
  const words = new Map(candidates.map((c) => [c.id, chunkWordSet({ file: c.file, symbol: c.symbol, content: c.content })]));
  const pool = Math.max(1, candidates.length);
  const relevance = new Map<string, number[]>();
  const idfByFacet = facets.map((facet) =>
    facet.terms.map((term) => {
      let df = 0;
      for (const set of words.values()) if (set.has(term)) df++;
      return Math.log(1 + pool / (df + 1));
    })
  );
  for (const candidate of candidates) {
    const set = words.get(candidate.id)!;
    const factor =
      isDocPath(candidate.file) && !options.wantsDocs
        ? DOC_FACTOR
        : (candidate.extra.isTest || isTestPath(candidate.file)) && !options.wantsTests
          ? TEST_FACTOR
          : 1;
    relevance.set(
      candidate.id,
      facets.map((facet, f) => {
        if (anchorMatches(candidate, facet.anchors)) return factor;
        const idf = idfByFacet[f]!;
        const total = idf.reduce((sum, value) => sum + value, 0);
        let matched = 0;
        facet.terms.forEach((term, i) => {
          if (set.has(term)) matched += idf[i]!;
        });
        const lexical = total === 0 ? 0 : matched / total;
        // The facet's own search ranking counts as much as literal word overlap:
        // code often implements a part of the request without repeating its words.
        const rank = rankings[f]?.ranks.get(candidate.id);
        const ranked = rank === undefined ? 0 : 1 / (1 + rank / 3);
        return factor * (0.5 * lexical + 0.5 * ranked);
      })
    );
  }
  return relevance;
}

/**
 * Budgeted coverage selection: repeatedly take the chunk that adds the most
 * uncovered facet weight per unit of cost, so every part of a multi-part
 * request gets evidence before any part gets a second chunk. Diversity caps
 * and the token budget apply as in `selectCandidates`; the best single
 * affordable chunk is kept when greedy picks would cover less (Khuller et al.).
 */
export function selectWithCoverage(
  candidates: RetrievalCandidate[],
  facets: TaskFacet[],
  relevance: Map<string, number[]>,
  options: SelectOptions
): SelectResult {
  const remaining = [...candidates].sort(compareCandidates);
  const best = facets.map(() => 0);
  const second = facets.map(() => 0);
  const selected: RetrievalCandidate[] = [];
  const discarded: SelectResult['discarded'] = [];
  const perFile = new Map<string, number>();
  const perSymbol = new Map<string, number>();
  const ranges = new Map<string, Array<[number, number]>>();
  let tokens = 0;

  const gainOf = (candidate: RetrievalCandidate): number => {
    const rel = relevance.get(candidate.id) ?? [];
    let gain = 0;
    facets.forEach((facet, f) => {
      const value = rel[f] ?? 0;
      gain += facet.weight * (Math.max(0, value - best[f]!) + SECOND_EVIDENCE_SHARE * Math.max(0, Math.min(value, best[f]!) - second[f]!));
    });
    return gain > 0 ? gain + TASK_GAIN_WEIGHT * candidate.score.total : 0;
  };
  const costOf = (candidate: RetrievalCandidate): number => Math.sqrt(Math.max(1, candidate.estimatedTokens / 200));
  const symbolKey = (candidate: RetrievalCandidate): string =>
    (candidate.symbol ?? `${candidate.file}:${candidate.startLine}`).toLowerCase();

  while (selected.length < options.limit && remaining.length > 0) {
    let pick = -1;
    let pickValue = 0;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      if ((perFile.get(candidate.file) ?? 0) >= options.maxChunksPerFile) continue;
      if ((perSymbol.get(symbolKey(candidate)) ?? 0) >= options.maxChunksPerSymbol) continue;
      if (options.maxTokens && selected.length > 0 && tokens + candidate.estimatedTokens > options.maxTokens) continue;
      if (overlapsSelected(candidate, ranges.get(candidate.file))) continue;
      const value = gainOf(candidate) / costOf(candidate);
      if (value > pickValue) {
        pickValue = value;
        pick = i;
      }
    }
    if (pick < 0 || pickValue * costOf(remaining[pick]!) < MIN_GAIN) break;
    const [chosen] = remaining.splice(pick, 1);
    const candidate = chosen!;
    const rel = relevance.get(candidate.id) ?? [];
    facets.forEach((_, f) => {
      const value = rel[f] ?? 0;
      if (value > best[f]!) {
        second[f] = best[f]!;
        best[f] = value;
      } else if (value > second[f]!) {
        second[f] = value;
      }
    });
    selected.push(candidate);
    tokens += candidate.estimatedTokens;
    perFile.set(candidate.file, (perFile.get(candidate.file) ?? 0) + 1);
    perSymbol.set(symbolKey(candidate), (perSymbol.get(symbolKey(candidate)) ?? 0) + 1);
    const fileRanges = ranges.get(candidate.file) ?? [];
    fileRanges.push([candidate.startLine, candidate.endLine]);
    ranges.set(candidate.file, fileRanges);
  }

  for (const candidate of remaining) discarded.push({ id: candidate.id, file: candidate.file, reason: 'coverage' });
  return { selected, discarded, estimatedTokens: tokens };
}

/** Per-facet status of a selection, and whether the reply answers every part of the request. */
export function coverageReport(
  selected: RetrievalCandidate[],
  facets: TaskFacet[],
  relevance: Map<string, number[]>
): { facets: FacetCoverage[]; complete: boolean; score: number } {
  const report = facets.flatMap((facet, f): FacetCoverage[] => {
    if (facet.auxiliary) return [];
    const scored = selected
      .map((candidate) => ({ candidate, rel: relevance.get(candidate.id)?.[f] ?? 0 }))
      .filter((item) => item.rel >= WEAK_STRENGTH)
      .sort((a, b) => b.rel - a.rel);
    const strength = scored[0]?.rel ?? 0;
    return [{
      facetId: facet.id,
      label: facet.label,
      kind: facet.kind,
      weight: facet.weight,
      status: strength >= COVERED_STRENGTH ? 'covered' : strength >= WEAK_STRENGTH ? 'weak' : 'missing',
      strength: Math.round(strength * 100) / 100,
      evidence: scored.slice(0, 3).map(({ candidate }) => ({
        path: candidate.file,
        startLine: candidate.startLine,
        endLine: candidate.endLine
      }))
    }];
  });
  const weakWeight = report.filter((facet) => facet.status === 'weak').reduce((sum, facet) => sum + facet.weight, 0);
  const complete = report.every((facet) => facet.status !== 'missing') && weakWeight <= WEAK_WEIGHT_ALLOWED;
  const reported = report.reduce((sum, facet) => sum + facet.weight, 0) || 1;
  const score = report.reduce((sum, facet) => sum + facet.weight * Math.min(1, facet.strength), 0) / reported;
  return { facets: report, complete, score: Math.round(score * 100) / 100 };
}

/** Follow-up reads per weak or missing facet, and in total. */
const FOLLOW_UPS_PER_FACET = 2;
const MAX_FOLLOW_UPS = 8;

/**
 * The best chunks left out of the reply for each part it does not cover
 * well: what `next` tells the agent to read, so it need not search again.
 */
export function followUpsFor(
  candidates: RetrievalCandidate[],
  selected: RetrievalCandidate[],
  facets: TaskFacet[],
  relevance: Map<string, number[]>,
  coverage: FacetCoverage[]
): Array<{ facetId: string; label: string; candidate: RetrievalCandidate }> {
  const chosen = new Set(selected.map((candidate) => candidate.id));
  const sentRanges = new Map<string, Array<[number, number]>>();
  for (const candidate of selected) {
    const list = sentRanges.get(candidate.file) ?? [];
    list.push([candidate.startLine, candidate.endLine]);
    sentRanges.set(candidate.file, list);
  }
  const out: Array<{ facetId: string; label: string; candidate: RetrievalCandidate }> = [];
  const used = new Set<string>();
  for (const report of coverage) {
    if (report.status === 'covered') continue;
    const f = facets.findIndex((facet) => facet.id === report.facetId);
    if (f < 0) continue;
    const ranked = candidates
      .filter((candidate) => !chosen.has(candidate.id) && !used.has(candidate.id))
      .filter((candidate) => !overlapsSelected(candidate, sentRanges.get(candidate.file)))
      .map((candidate) => ({ candidate, rel: relevance.get(candidate.id)?.[f] ?? 0 }))
      .filter((item) => item.rel > (report.strength ?? 0) && item.rel >= WEAK_STRENGTH)
      .sort((a, b) => b.rel - a.rel || compareCandidates(a.candidate, b.candidate))
      .slice(0, FOLLOW_UPS_PER_FACET);
    for (const { candidate } of ranked) {
      used.add(candidate.id);
      out.push({ facetId: report.facetId, label: report.label, candidate });
      if (out.length >= MAX_FOLLOW_UPS) return out;
    }
  }
  return out;
}
