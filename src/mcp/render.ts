import { basename } from 'node:path';
import type { ContextPackage } from '../retrieval/types.js';
import { estimateTokensFromText } from '../utils/tokens.js';
import { serializeToolResult, taskContextPayload } from './payload.js';
import type { ContextLedger } from './session.js';

/**
 * `text` (default): a manifest and raw code blocks, which cost fewer tokens
 * than JSON-escaped strings and are easier for a model to quote exactly.
 * `json`: the compact JSON payload of earlier versions, for clients or
 * scripts that parse replies.
 */
export type ReplyFormat = 'text' | 'json';

export function replyFormat(env: NodeJS.ProcessEnv = process.env): ReplyFormat {
  return env.CODE_INTEL_MCP_FORMAT?.trim().toLowerCase() === 'json' ? 'json' : 'text';
}

/**
 * The most tokens a reply may use, from `CODE_INTEL_MAX_REPLY_TOKENS` or, under
 * Claude Code, 80% of `MAX_MCP_OUTPUT_TOKENS`: an over-limit reply is saved to
 * a file and costs the agent an extra read.
 */
export function replyTokenCap(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const explicit = Number(env.CODE_INTEL_MAX_REPLY_TOKENS);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const client = Number(env.MAX_MCP_OUTPUT_TOKENS);
  if (Number.isFinite(client) && client > 0) return Math.floor(client * 0.8);
  return undefined;
}

/** One exact tool call the agent should make next. */
export interface NextCall {
  tool: 'get_file_context' | 'search_codebase';
  args: Record<string, unknown>;
  estimatedTokens: number;
}

/** At most this many calls are suggested; more would invite the open-ended exploration they replace. */
const MAX_NEXT_CALLS = 3;
/** Ranges per suggested read, so one call closes several gaps. */
const MAX_RANGES_PER_CALL = 8;
const LABEL_WIDTH = 70;
const DEFAULT_CONFIDENCE_REASON = 'Top results exceeded the confidence threshold.';

function rangeRef(item: { path: string; startLine: number; endLine: number }): string {
  return `${item.path}:${item.startLine}-${item.endLine}`;
}

/**
 * Exact follow-up calls for the parts the reply leaves weak or missing: one
 * batched read of the best unsent chunks, then a search for any part with no
 * candidate at all. Empty when the reply is complete.
 */
export function nextCalls(pkg: ContextPackage, ctx?: string): NextCall[] {
  if (!pkg.facets || pkg.complete) return [];
  const calls: NextCall[] = [];
  const followUps = pkg.followUps ?? [];
  if (followUps.length > 0) {
    const reads = followUps.slice(0, MAX_RANGES_PER_CALL);
    calls.push({
      tool: 'get_file_context',
      args: { ...(ctx ? { ctx } : {}), ranges: reads.map(rangeRef) },
      estimatedTokens: reads.reduce((sum, item) => sum + item.estimatedTokens, 0) + 20 * reads.length
    });
  }
  const unread = new Set(followUps.map((item) => item.facetId));
  for (const facet of pkg.facets) {
    if (calls.length >= MAX_NEXT_CALLS) break;
    if (facet.status !== 'missing' || unread.has(facet.facetId)) continue;
    calls.push({ tool: 'search_codebase', args: { query: facet.label, limit: 3 }, estimatedTokens: 600 });
  }
  return calls.slice(0, MAX_NEXT_CALLS);
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function trimTrailingWhitespace(content: string): string {
  return content.replace(/[ \t]+$/gm, '').replace(/\r\n/g, '\n');
}

function truncateLabel(label: string): string {
  const flat = label.replace(/\s+/g, ' ').trim();
  return flat.length > LABEL_WIDTH ? `${flat.slice(0, LABEL_WIDTH - 1)}…` : flat;
}

/**
 * The reply an agent reads. Layout:
 *
 *   <repo> · <coverage or confidence> · ~<tokens> tokens
 *   covered  <part>  [1] [3]            (multi-part requests)
 *   missing  <part>
 *   Next (1 call, ~600 tokens), then answer:
 *   get_file_context {"ranges":["src/a.ts:10-40"]}
 *
 *   ### [1] src/a.ts:10-40 symbol
 *   <code, exactly as indexed>
 *
 * No absolute paths, per-signal scores, or timestamps: identical retrievals
 * give identical bytes, which keeps client prompt caches warm.
 */
export function renderTaskContext(
  pkg: ContextPackage,
  options: { repoName: string; ledger?: ContextLedger }
): string {
  const { ledger } = options;
  const blocks: string[] = [];
  const blockIds = new Map<string, number>();
  let id = 0;
  let unchanged = 0;
  for (const file of pkg.files) {
    for (const chunk of file.chunks) {
      id += 1;
      blockIds.set(`${file.path}:${chunk.startLine}`, id);
      const symbol = chunk.symbol ? ` ${chunk.symbol}` : '';
      const header = `### [${id}] ${file.path}:${chunk.startLine}-${chunk.endLine}${symbol}`;
      const content = trimTrailingWhitespace(chunk.content);
      const lines = content.split('\n');
      // Later questions in the same conversation name code the agent already has instead of resending it.
      if (ledger?.fullySeen(file.path, chunk.startLine, lines)) {
        unchanged += 1;
        ledger.avoidedLines += lines.length;
        blocks.push(`${header} = already sent in this conversation, unchanged`);
        continue;
      }
      ledger?.record(file.path, chunk.startLine, lines);
      blocks.push(`${header}\n${content}`);
    }
  }

  const lines: string[] = [];
  if (pkg.facets) {
    for (const facet of pkg.facets) {
      const refs = facet.evidence
        .map((evidence) => blockIds.get(`${evidence.path}:${evidence.startLine}`))
        .filter((ref): ref is number => ref !== undefined)
        .map((ref) => `[${ref}]`)
        .join(' ');
      lines.push(`${facet.status.padEnd(8)} ${truncateLabel(facet.label)}${refs ? `  ${refs}` : ''}`);
    }
    const calls = nextCalls(pkg, ledger?.id);
    if (calls.length > 0) {
      const total = calls.reduce((sum, call) => sum + call.estimatedTokens, 0);
      lines.push(`Next (${calls.length} call${calls.length === 1 ? '' : 's'}, ~${formatTokens(total)} tokens), then answer:`);
      for (const call of calls) lines.push(`${call.tool} ${JSON.stringify(call.args)}`);
    }
  } else if (pkg.confidence.reason !== DEFAULT_CONFIDENCE_REASON) {
    lines.push(pkg.confidence.reason);
  }
  if (pkg.files.length === 0) lines.push('No indexed code matched. Search the files directly for this request.');

  const body = [lines.join('\n'), blocks.join('\n\n')].filter(Boolean).join('\n\n');
  const covered = pkg.facets?.filter((facet) => facet.status === 'covered').length ?? 0;
  const status = pkg.facets
    ? pkg.complete
      ? `complete ${covered}/${pkg.facets.length} parts`
      : `incomplete ${covered}/${pkg.facets.length} parts covered`
    : `confidence ${pkg.confidence.score}`;
  const tokens = estimateTokensFromText(body) + 12;
  const context = ledger ? ` · ctx ${ledger.id}` : '';
  const reused = unchanged > 0 ? ` · ${unchanged} block${unchanged === 1 ? '' : 's'} already sent` : '';
  return `${options.repoName}${context} · ${status}${reused} · ~${formatTokens(tokens)} tokens\n${body}\n`;
}

/** The exact text sent for a task-context reply in the configured format; usage and benchmarks count these bytes. */
export function renderTaskContextReply(
  repoRoot: string,
  pkg: ContextPackage,
  format: ReplyFormat = replyFormat(),
  ledger?: ContextLedger
): string {
  if (format === 'json') return serializeToolResult(taskContextPayload(repoRoot, pkg));
  return renderTaskContext(pkg, { repoName: basename(repoRoot), ledger });
}


/**
 * Search results as code blocks, like a task-context reply. With a context
 * (`ctx`), results the conversation already has are named, not resent.
 */
export function renderSearchResults(
  results: Array<{ file: string; symbol: string | null; startLine: number; endLine: number; content: string }>,
  options: { repoName: string; query: string; ledger?: ContextLedger }
): string {
  const { ledger } = options;
  let unchanged = 0;
  const blocks = results.map((result, index) => {
    const symbol = result.symbol ? ` ${result.symbol}` : '';
    const header = `### [${index + 1}] ${result.file}:${result.startLine}-${result.endLine}${symbol}`;
    const content = trimTrailingWhitespace(result.content);
    const lines = content.split('\n');
    if (ledger?.fullySeen(result.file, result.startLine, lines)) {
      unchanged += 1;
      ledger.avoidedLines += lines.length;
      return `${header} = already sent in this conversation, unchanged`;
    }
    ledger?.record(result.file, result.startLine, lines);
    return `${header}\n${content}`;
  });
  const body = results.length > 0 ? blocks.join('\n\n') : 'No indexed code matched. Search the files directly for this query.';
  const reused = unchanged > 0 ? ` · ${unchanged} already sent` : '';
  const context = ledger ? ` · ctx ${ledger.id}` : '';
  const tokens = estimateTokensFromText(body) + 12;
  return `${options.repoName}${context} · ${results.length} result${results.length === 1 ? '' : 's'}${reused} · ~${formatTokens(tokens)} tokens\n${body}\n`;
}
