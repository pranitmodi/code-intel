import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { searchCodebase } from '../search/searchCodebase.js';
import { searchSymbol } from '../search/searchSymbol.js';
import { findReferences } from '../search/findReferences.js';
import { getFileContext } from '../search/getFileContext.js';
import { getRepoContext } from '../search/getRepoContext.js';
import { MCP_SERVER_INSTRUCTIONS } from '../cursor/mcpInstructions.js';
import { createMcpRuntime, type McpRuntime, type ResolveOk } from './runtime.js';

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const repoField = z
  .string()
  .optional()
  .describe('Indexed repo path, id, or basename. Defaults to the MCP --repo / current workspace.');

async function withRepo(
  runtime: McpRuntime,
  repo: string | undefined,
  fn: (resolved: ResolveOk['context']) => Promise<unknown>
) {
  const resolved = await runtime.resolve(repo);
  if (!resolved.ok) return textResult(resolved);
  return textResult(await fn(resolved.context));
}

/** Exposes the local index to any MCP client (Cursor, VS Code, Claude Code, Codex, ...) — read-only (spec section 20/22). */
export function buildServer(runtime: McpRuntime): McpServer {
  const server = new McpServer(
    { name: 'local-code-intelligence', version: '0.1.0' },
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
        'REQUIRED first tool for code discovery. Uses precomputed local Ollama embeddings in LanceDB; only the query is embedded (corpus is not re-embedded). Returns retrieved snippets — never send vectors to the chat model. Prefer this over Grep/Glob/explore. Pass max_tokens to cap payload size.',
      inputSchema: z.object({
        query: z.string().describe('Natural-language or keyword query'),
        limit: z.number().int().positive().max(50).optional(),
        min_score: z.number().min(0).max(1).optional(),
        max_tokens: z.number().int().positive().optional(),
        repo: repoField
      })
    },
    async ({ query, limit, min_score, max_tokens, repo }) =>
      withRepo(runtime, repo, async (context) => {
        const results = await searchCodebase(
          query,
          context.vectorStore,
          context.embeddingProvider,
          context.config.search,
          { limit, minScore: min_score, maxTokens: max_tokens }
        );
        return { repo: context.repoRoot, results };
      })
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
      withRepo(runtime, repo, async (context) => ({
        repo: context.repoRoot,
        matches: await searchSymbol(name, context.vectorStore, limit)
      }))
  );

  server.registerTool(
    'get_file_context',
    {
      description:
        'Reads exact source content from the repository (authoritative — not the vector DB) for a file and optional line range. Prefer a line range over reading the whole file.',
      inputSchema: z.object({
        file: z.string().describe('Path relative to the repository root'),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        repo: repoField
      })
    },
    async ({ file, start_line, end_line, repo }) =>
      withRepo(runtime, repo, async (context) => ({
        repo: context.repoRoot,
        ...(await getFileContext(context.repoRoot, file, start_line, end_line))
      }))
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
      withRepo(runtime, repo, async (context) => ({
        repo: context.repoRoot,
        references: await findReferences(symbol, context.vectorStore, limit)
      }))
  );

  return server;
}

export async function startMcpServer(repoRoot?: string): Promise<void> {
  const runtime = await createMcpRuntime(repoRoot);
  const server = buildServer(runtime);
  const label = runtime.defaultRepoRoot ?? '(no default repo — pass repo on each tool call)';
  console.error(`local-code-intelligence MCP server running on stdio (repo: ${label})`);
  serveStdio(() => server);
}
