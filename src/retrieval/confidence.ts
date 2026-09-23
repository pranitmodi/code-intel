import { isDocPath } from './docs.js';
import type { RetrievalCandidate, RetrievalConfidence } from './types.js';

const CODE_CHANGE =
  /\b(add|fix|implement|update|refactor|change|bug|endpoint|api|function|class|test)\b/i;

export function queryLooksLikeCodeChange(query: string): boolean {
  return CODE_CHANGE.test(query);
}

export function confidenceFor(
  selected: RetrievalCandidate[],
  threshold: number,
  options: { stale?: boolean | null; query?: string } = {}
): RetrievalConfidence {
  if (options.stale) {
    return { score: 0.2, reason: 'Index is stale relative to the working tree.' };
  }
  if (selected.length === 0) {
    return { score: 0, reason: 'Low-confidence retrieval. Recommended fallback: targeted repository search.' };
  }
  const top = selected[0]!;
  if (
    options.query &&
    queryLooksLikeCodeChange(options.query) &&
    isDocPath(top.file)
  ) {
    return {
      score: Math.min(top.score.total, Math.max(0, threshold - 0.01)),
      reason:
        'Top hit is documentation while the query looks like a code change. Recommended fallback: targeted repository search.'
    };
  }
  if (top.score.total < threshold) {
    return {
      score: top.score.total,
      reason: 'Low-confidence retrieval. Recommended fallback: targeted repository search.'
    };
  }
  return { score: top.score.total, reason: 'Top results exceeded the confidence threshold.' };
}
