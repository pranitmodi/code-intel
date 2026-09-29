import type { RetrievalIntent } from './intent.js';
import { contentWords } from './terms.js';

/**
 * One part of a multi-part request. A reply that leaves a facet uncovered
 * costs the agent a follow-up search, so selection reserves room for each.
 */
export interface TaskFacet {
  id: string;
  kind: 'command' | 'flag' | 'env' | 'symbol' | 'file' | 'concept';
  /** The request text this facet came from, trimmed. */
  label: string;
  /** Content words, split and singular, used to judge whether code covers the facet. */
  terms: string[];
  /** Code-shaped tokens in the facet (commands, flags, env keys, identifiers, file names) for exact lookups. */
  anchors: string[];
  /** Relative importance; weights of a plan sum to 1. */
  weight: number;
  /** Text embedded for this facet's semantic search: the request's subject plus the facet. */
  embedText: string;
  /**
   * The request as a whole, ranked by the whole-task search. It lets code that
   * serves the request without echoing any one part's words earn credit, and
   * is never reported as a part of its own.
   */
  auxiliary?: boolean;
}

export interface QueryPlan {
  facets: TaskFacet[];
  /** `focused` requests keep the single-query pipeline; `multi` and `broad` retrieve per facet. */
  route: 'focused' | 'multi' | 'broad';
}

/** Longer requests than this, or ones listing parts, are split into facets. */
const MIN_WORDS_TO_SPLIT = 12;
const MIN_SEPARATORS_TO_SPLIT = 2;
const MAX_FACETS = 10;
/** The whole-request facet's weight relative to an average part. */
const WHOLE_TASK_SHARE = 0.5;
/** A segment with fewer content words joins its neighbour ("or unusable"). */
const MIN_FACET_WORDS = 2;
const ANCHOR_BONUS = 0.5;

/** Clause boundaries. "versus", "vs", and "/" join the two sides of one facet, so they are not boundaries. */
const SEGMENT_SPLIT = /[;:\n]+|,\s+|\s+(?:and|or|plus|also|then)\s+|\?\s+|\.\s+|\s+[-*•]\s+/i;
const SEPARATORS = /[,;\n]|\s(?:and|or)\s/gi;

function anchorKind(anchor: string, intent: RetrievalIntent): TaskFacet['kind'] {
  if (anchor.startsWith('--')) return 'flag';
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(anchor)) return 'env';
  if (intent.files.includes(anchor)) return 'file';
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(anchor)) return 'command';
  return 'symbol';
}

function segmentsOf(task: string): string[] {
  return task
    .split(SEGMENT_SPLIT)
    .map((segment) =>
      segment
        .replace(/^[\s,.;:()]+|[\s,.;:()?]+$/g, '')
        .replace(/^(?:and|or|also|then|plus)\s+/i, '')
        .trim()
    )
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const shared = b.filter((word) => setA.has(word)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

/**
 * Split a request into facets deterministically: clauses and list items
 * become facets, code-shaped tokens anchor them, and tiny or overlapping
 * segments merge. A short or single-part request yields one facet and keeps
 * the single-query pipeline, so focused lookups behave exactly as before.
 */
export function planQuery(task: string, intent: RetrievalIntent): QueryPlan {
  const words = contentWords(task);
  const separators = task.match(SEPARATORS)?.length ?? 0;
  const anchorsIn = (text: string): string[] =>
    [...new Set([...intent.exactTerms, ...intent.symbols, ...intent.files])].filter((anchor) => text.includes(anchor));

  const whole: TaskFacet = {
    id: 'f0',
    kind: 'concept',
    label: task.trim().slice(0, 160),
    terms: words,
    anchors: anchorsIn(task),
    weight: 1,
    embedText: task
  };
  if (words.length < MIN_WORDS_TO_SPLIT && separators < MIN_SEPARATORS_TO_SPLIT) {
    return { facets: [whole], route: 'focused' };
  }

  // Merge segments too small to stand alone into the one before them.
  const merged: string[] = [];
  for (const segment of segmentsOf(task)) {
    const small = contentWords(segment).length < MIN_FACET_WORDS && anchorsIn(segment).length === 0;
    if (small && merged.length > 0) merged[merged.length - 1] = `${merged[merged.length - 1]} ${segment}`;
    else merged.push(segment);
  }
  const parts = merged.filter((segment) => contentWords(segment).length > 0 || anchorsIn(segment).length > 0);
  if (parts.length < 2) return { facets: [whole], route: 'focused' };

  const subject = parts[0]!;
  const draft: Array<Omit<TaskFacet, 'id' | 'weight'>> = [];
  for (const part of parts) {
    const terms = contentWords(part);
    const anchors = anchorsIn(part);
    const overlapping = draft.find((facet) => jaccard(facet.terms, terms) >= 0.5 && anchors.every((a) => facet.anchors.includes(a)));
    if (overlapping) {
      overlapping.terms = [...new Set([...overlapping.terms, ...terms])];
      overlapping.label = `${overlapping.label}; ${part}`.slice(0, 160);
      continue;
    }
    draft.push({
      kind: anchors.length > 0 ? anchorKind(anchors[0]!, intent) : 'concept',
      label: part.slice(0, 160),
      terms,
      anchors,
      embedText: part === subject ? part : `${subject}: ${part}`
    });
  }

  // Keep the heaviest facets when a request lists more parts than one reply can cover.
  const scored = draft.map((facet, index) => ({ facet, index, raw: 1 + ANCHOR_BONUS * facet.anchors.length }));
  const kept = scored
    .sort((a, b) => b.raw - a.raw || a.index - b.index)
    .slice(0, MAX_FACETS)
    .sort((a, b) => a.index - b.index);
  if (kept.length < 2) return { facets: [whole], route: 'focused' };
  const wholeRaw = (WHOLE_TASK_SHARE * kept.reduce((sum, item) => sum + item.raw, 0)) / kept.length;
  const total = kept.reduce((sum, item) => sum + item.raw, 0) + wholeRaw;
  const facets: TaskFacet[] = kept.map((item, i) => ({ ...item.facet, id: `f${i}`, weight: item.raw / total }));
  facets.push({ ...whole, id: 'task', label: 'whole request', weight: wholeRaw / total, auxiliary: true });
  return { facets, route: kept.length >= 4 ? 'broad' : 'multi' };
}
