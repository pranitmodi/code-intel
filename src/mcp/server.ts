import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { searchCodebase } from '../search/searchCodebase.js';
import { searchSymbol } from '../search/searchSymbol.js';
import { findReferences } from '../search/findReferences.js';
import { parseRangeRef, readFileRanges, renderFileRanges } from '../search/getFileContext.js';
import { getRepoContext } from '../search/getRepoContext.js';
import { getTaskContext } from '../retrieval/taskContext.js';
import { grantFilesystemFallback } from '../retrieval/fallback.js';
import { MCP_SERVER_INSTRUCTIONS } from '../cursor/mcpInstructions.js';
import { createMcpRuntime, type McpRuntime, type ResolveOk } from './runtime.js';
import { startWorkspaceWatchers } from './watchOnStart.js';
import { recordMcpRetrieval } from '../usage/record.js';
import { serializeToolResult } from './payload.js';
import { renderSearchResults, renderTaskContextReply, replyFormat, replyTokenCap } from './render.js';
import { sessionDedupEnabled, SessionStore } from './session.js';
import { sharedFreshness } from './freshness.js';
import { recoverySteps } from '../cli/formatCliFailure.js';
import { PACKAGE_VERSION } from '../version.js';

/** How long an in-flight index batch may delay exit after the client disconnects. */
const SHUTDOWN_GRACE_MS = 5_000;

function textResult(value: unknown, text = serializeToolResult(value)) {
  return { content: [{ type: 'text' as const, text }] };
}

/** A tool result already rendered for the model; sent as-is instead of as JSON. */
class RenderedText {
  constructor(readonly text: string) {}
}

const repoField = z
  .string()
  .optional()
  .describe('Indexed repo path, id, or basename. Defaults to the MCP --repo / current workspace.');

async function withRepo(
  runtime: McpRuntime,
  repo: string | undefined,
  fn: (resolved: ResolveOk['context']) => Promise<unknown>,
  usageTool?: string
) {
  const started = Date.now();
  const resolved = await runtime.resolve(repo);
  if (!resolved.ok) {
    if (runtime.config.retrieval.allowFallbackAfterFailedRetrieval) {
      grantFilesystemFallback(runtime.config.database.path, resolved.message, resolved.repo);
    }
    return textResult({
      ...resolved,
      recovery: recoverySteps(new Error(resolved.message))
    });
  }
  try {
    const value = await fn(resolved.context);
    const text = value instanceof RenderedText ? value.text : serializeToolResult(value);
    if (usageTool) {
      const latencyMs = Date.now() - started;
      const repoRoot = resolved.context.repoRoot;
      // Accounting reads config and registry files; keep it off the reply path.
      setImmediate(() => {
        try {
          recordMcpRetrieval({ tool: usageTool, repo: repoRoot, payloadText: text, latencyMs });
        } catch {
          // Usage accounting must never affect a tool call.
        }
      });
    }
    return textResult(value, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult({
      ok: false,
      message,
      recovery: recoverySteps(error)
    });
  }
}

/** Exposes the local index to any MCP client (Cursor, VS Code, Claude Code, Codex, ...) — read-only (spec section 20/22). */
const ctxField = z
  .string()
  .optional()
  .describe('The ctx id from an earlier get_task_context reply in this conversation; skips code already sent.');

export function buildServer(runtime: McpRuntime, sessions: SessionStore = new SessionStore()): McpServer {
  const dedup = sessionDedupEnabled();
  const server = new McpServer(
    { name: 'local-code-intelligence', version: PACKAGE_VERSION },
    { instructions: MCP_SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    'list_indexed_repos',
    {
      description:
        'List every locally indexed repository (id, path, name, file/chunk counts, last indexed, stale flag). Use this when the workspace is a parent folder of indexed projects.',
      inputSchema: z.object({})
    },
    async () => textResult({ repos: await runtime.listRepos() })
  );

  server.registerTool(
    'index_status',
    {
      description:
        'Index freshness for the current workspace or a named repo: whether it is indexed, stale vs the working tree, and how to (re)index if missing.',
      inputSchema: z.object({ repo: repoField })
    },
    async ({ repo }) => textResult(await runtime.status(repo))
  );

  server.registerTool(
    'search_codebase',
    {
      description:
        'Conceptual hybrid search (semantic + keyword + symbol). For a new or broad coding task prefer get_task_context. Uses precomputed local embeddings in LanceDB; only the query is embedded. Pass max_tokens to cap payload size.',
      inputSchema: z.object({
        query: z.string().describe('Natural-language or keyword query'),
        limit: z.number().int().positive().max(50).optional(),
        min_score: z.number().min(0).max(1).optional(),
        max_tokens: z.number().int().positive().optional(),
        ctx: ctxField,
        repo: repoField
      })
    },
    async ({ query, limit, min_score, max_tokens, ctx, repo }) =>
      withRepo(
        runtime,
        repo,
        async (context) => {
          const results = await searchCodebase(
            query,
            context.vectorStore,
            context.embeddingProvider,
            context.config.search,
            { limit, minScore: min_score, maxTokens: max_tokens }
          );
          if (replyFormat() === 'json') return { repo: context.repoRoot, results };
          const ledger = dedup ? sessions.get(ctx, context.repoRoot) : undefined;
          if (ledger) ledger.calls += 1;
          return new RenderedText(renderSearchResults(results, { repoName: basename(context.repoRoot), query, ledger }));
        },
        'search_codebase'
      )
  );

  server.registerTool(
    'search_symbol',
    {
      description:
        'Exact/fuzzy symbol lookup by name (functions, classes, methods, interfaces, ...) independent of embeddings.',
      inputSchema: z.object({
        name: z.string(),
        limit: z.number().int().positive().max(100).optional(),
        repo: repoField
      })
    },
    async ({ name, limit, repo }) =>
      withRepo(
        runtime,
        repo,
        async (context) => ({
          repo: context.repoRoot,
          matches: await searchSymbol(name, context.vectorStore, limit)
        }),
        'search_symbol'
      )
  );

  server.registerTool(
    'get_file_context',
    {
      description:
        'Exact current source from the working tree. Pass ranges like "src/a.ts:120-168" (several at once) or file with start_line/end_line. Long ranges are capped and say where they resume.',
      inputSchema: z.object({
        ranges: z
          .array(z.string())
          .max(12)
          .optional()
          .describe('Ranges to read in one call: "path:start-end", "path:line", or "path"'),
        file: z.string().optional().describe('Path relative to the repository root'),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        ctx: ctxField,
        repo: repoField
      })
    },
    async ({ ranges, file, start_line, end_line, ctx, repo }) =>
      withRepo(
        runtime,
        repo,
        async (context) => {
          const requests = [
            ...(ranges ?? []).map(parseRangeRef),
            ...(file ? [{ file, startLine: start_line, endLine: end_line }] : [])
          ];
          if (requests.length === 0) throw new Error('Pass ranges, or file with an optional start_line/end_line.');
          const results = await readFileRanges(context.repoRoot, requests, {
            allowSensitiveFiles: context.config.security.allowSensitiveFiles
          });
          if (replyFormat() === 'json') {
            const [single] = results;
            if (!ranges && single) {
              if (single.error) throw new Error(single.error);
              return { repo: context.repoRoot, file: single.file, startLine: single.startLine, endLine: single.endLine, content: single.content, totalLines: single.totalLines, omittedLines: single.omittedLines };
            }
            return { repo: context.repoRoot, ranges: results };
          }
          const ledger = dedup ? sessions.get(ctx, context.repoRoot) : undefined;
          if (ledger) ledger.calls += 1;
          return new RenderedText(renderFileRanges(results, ledger));
        },
        'get_file_context'
      )
  );

  server.registerTool(
    'get_repo_context',
    {
      description:
        'Deterministic architectural overview: language breakdown, top directories, and detected package manager files.',
      inputSchema: z.object({ repo: repoField })
    },
    async ({ repo }) =>
      withRepo(runtime, repo, async (context) => ({
        repo: context.repoRoot,
        ...(await getRepoContext(context.repoRoot, context.vectorStore))
      }))
  );

  server.registerTool(
    'get_task_context',
    {
      description:
        'Given a coding task, retrieve and assemble the minimum useful repository context (ranked chunks, relationships, token budget, confidence). Prefer this for new or broad tasks.',
      inputSchema: z.object({
        task: z.string().describe('Natural-language coding task or question'),
        max_tokens: z.number().int().positive().optional(),
        mode: z.enum(['minimal', 'normal', 'deep']).optional(),
        ctx: ctxField,
        repo: repoField
      })
    },
    async ({ task, max_tokens, mode, ctx, repo }) =>
      withRepo(
        runtime,
        repo,
        async (context) => {
          const stale = await sharedFreshness.peek(context.repoRoot);
          const pkg = await getTaskContext(task, context, {
            maxTokens: max_tokens,
            maxTokensCap: replyTokenCap(),
            mode,
            stale
          });
          // A new question opens a context; passing ctx continues one, so code sent for an earlier question is not resent.
          const ledger = dedup ? (sessions.get(ctx, context.repoRoot) ?? sessions.open(context.repoRoot)) : undefined;
          if (ledger) ledger.calls += 1;
          return new RenderedText(renderTaskContextReply(context.repoRoot, pkg, replyFormat(), ledger));
        },
        'get_task_context'
      )
  );

  server.registerTool(
    'find_references',
    {
      description:
        'Textual occurrence scan for a symbol name across indexed files (not full semantic reference resolution).',
      inputSchema: z.object({
        symbol: z.string(),
        limit: z.number().int().positive().max(200).optional(),
        repo: repoField
      })
    },
    async ({ symbol, limit, repo }) =>
      withRepo(
        runtime,
        repo,
        async (context) => ({
          repo: context.repoRoot,
          references: await findReferences(symbol, context.vectorStore, limit)
        }),
        'find_references'
      )
  );

  return server;
}

export async function startMcpServer(
  repoRoot?: string,
  options: { watch?: boolean } = {}
): Promise<void> {
  const runtime = await createMcpRuntime(repoRoot);
  // One context store for the process: contexts are named, so every connection can share it safely.
  const sessions = new SessionStore();
  const watchEnabled = options.watch !== false && runtime.config.indexing.watch;
  const label = runtime.defaultRepoRoot ?? '(no default repo — pass repo on each tool call)';
  console.error(
    `local-code-intelligence MCP server running on stdio (repo: ${label}${watchEnabled ? ', watch on' : ''})`
  );

  const watchers: Promise<(() => Promise<void>) | undefined> = watchEnabled
    ? startWorkspaceWatchers(runtime).catch((error: unknown) => {
        console.error(
          `[WATCH] failed to start: ${error instanceof Error ? error.message : String(error)}`
        );
        return undefined;
      })
    : Promise.resolve(undefined);

  // A fresh server per connection (the SDK also builds one for a discarded probe); state lives in `sessions`.
  const connection = serveStdio(() => buildServer(runtime, sessions));
  // Open the default index while the client is still initialising, so the
  // first tool call does not pay for connecting to LanceDB.
  if (runtime.defaultRepoRoot) void runtime.resolve().catch(() => undefined);

  // Watchers keep the event loop alive, so the process must exit explicitly
  // once the client is gone; editors that crash only close stdin.
  let exiting = false;
  const shutdown = (): void => {
    if (exiting) return;
    exiting = true;
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    void watchers
      .then((stop) => stop?.())
      .then(() => connection.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, shutdown);
}
