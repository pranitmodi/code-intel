import type { TreeScanInput } from '../cursor/treeScanPolicy.js';
import { estimateTokensFromText } from '../utils/tokens.js';
import { baselineTokensForRepo, filesIndexedForPath } from './heuristic.js';
import { appendUsageEvent } from './store.js';

export function recordMcpRetrieval(input: {
  tool: string;
  repo?: string;
  payloadText: string;
  latencyMs: number;
}): void {
  const resultTokens = estimateTokensFromText(input.payloadText);
  const filesIndexed = filesIndexedForPath(input.repo);
  appendUsageEvent({
    ts: new Date().toISOString(),
    kind: 'mcp_retrieval',
    tool: input.tool,
    repo: input.repo,
    resultTokens,
    baselineTokens: baselineTokensForRepo(input.repo, filesIndexed),
    latencyMs: input.latencyMs
  });
}

export function recordDeniedScan(input: TreeScanInput): void {
  const repo = input.cwd ?? input.workspace_roots?.[0];
  const filesIndexed = filesIndexedForPath(repo);
  const baseline = baselineTokensForRepo(repo, filesIndexed);
  appendUsageEvent({
    ts: new Date().toISOString(),
    kind: 'denied_scan',
    tool: input.tool_name ?? input.subagent_type ?? 'tree-scan',
    repo,
    resultTokens: 0,
    baselineTokens: baseline
  });
}
