import type { ContextPackage } from '../retrieval/types.js';

/**
 * Tool results are read by a model and billed per token, so they are compact
 * JSON. Benchmarks and usage accounting must measure this exact string.
 */
export function serializeToolResult(value: unknown): string {
  return JSON.stringify(value);
}

export interface TaskContextPayload {
  repo: string;
  confidence: ContextPackage['confidence'];
  estimatedTokens: number;
  files: Array<{
    path: string;
    reason: string;
    score: number;
    chunks: ContextPackage['files'][number]['chunks'];
  }>;
  relationships?: NonNullable<ContextPackage['relationships']>;
}

/**
 * What get_task_context sends: the chunks plus the facts an agent acts on.
 * Per-signal score breakdowns and retrieval stats stay in `explain` output,
 * and relationships are limited to files the agent actually receives.
 */
export function taskContextPayload(repo: string, pkg: ContextPackage): TaskContextPayload {
  const included = new Set(pkg.files.map((file) => file.path));
  const relationships = (pkg.relationships ?? []).filter(
    (rel) => rel.from !== rel.to && included.has(rel.from) && included.has(rel.to)
  );
  return {
    repo,
    confidence: pkg.confidence,
    estimatedTokens: pkg.estimatedTokens,
    files: pkg.files.map((file) => ({
      path: file.path,
      reason: file.reason,
      score: file.score.total,
      chunks: file.chunks
    })),
    ...(relationships.length > 0 ? { relationships } : {})
  };
}
