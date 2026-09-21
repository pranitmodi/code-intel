import type { RetrievalCandidate, RetrievalTrace } from './types.js';

export function formatSearchExplain(trace: RetrievalTrace, selected: RetrievalCandidate[]): string {
  const lines: string[] = [];
  lines.push(`Query: ${trace.query}`);
  lines.push('');
  lines.push(`Candidates: ${trace.candidateCount}`);
  lines.push('');

  const top = selected[0];
  if (top) {
    lines.push('Top result:');
    lines.push(`${top.file}:${top.startLine}-${top.endLine}`);
    lines.push(`score: ${top.score.total}`);
    lines.push(`  semantic:   ${top.score.semantic.toFixed(2)}`);
    lines.push(`  keyword:    ${top.score.keyword.toFixed(2)}`);
    lines.push(`  symbol:     ${top.score.symbol.toFixed(2)}`);
    lines.push(`  path:       ${top.score.path.toFixed(2)}`);
    lines.push(`  structural: ${top.score.structural.toFixed(2)}`);
    lines.push(`  test:       ${top.score.test.toFixed(2)}`);
    lines.push(`  recency:    ${top.score.recency.toFixed(2)}`);
    lines.push('');
  }

  if (trace.discarded.length > 0) {
    const byReason = new Map<string, number>();
    for (const item of trace.discarded) {
      byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
    }
    lines.push('Discarded:');
    for (const [reason, count] of byReason) {
      lines.push(`  ${reason}: ${count}`);
    }
    lines.push('');
  }

  const files = new Set(selected.map((c) => c.file));
  lines.push('Final context:');
  lines.push(`${selected.length} chunks`);
  lines.push(`${files.size} files`);
  lines.push(`${trace.estimatedTokens.toLocaleString()} estimated tokens`);
  lines.push(`${trace.latencyMs}ms`);
  return lines.join('\n');
}
