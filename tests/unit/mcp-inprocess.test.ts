import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { resolveRepoPaths } from '../../src/config/paths.js';
import type { AppContext } from '../../src/context.js';
import { HashEmbeddingProvider } from '../../src/embeddings/HashEmbeddingProvider.js';
import { Indexer } from '../../src/indexer/Indexer.js';
import type { McpRuntime } from '../../src/mcp/runtime.js';
import { buildServer } from '../../src/mcp/server.js';
import { MIN_STUB_LINES, SessionStore } from '../../src/mcp/session.js';
import { computeRepoId } from '../../src/utils/repo-id.js';
import { LanceVectorStore } from '../../src/vector-store/LanceVectorStore.js';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/test-repo');

function text(result: { content: unknown }): string {
  return ((result.content as Array<{ text: string }>)[0]?.text ?? '');
}

describe('MCP server in process', () => {
  let root: string;
  let client: Client;
  const originalDbPath = process.env.CODE_INTEL_DB_PATH;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'code-intel-inprocess-'));
    const repoRoot = join(root, 'repo');
    await cp(FIXTURE, repoRoot, { recursive: true });
    process.env.CODE_INTEL_DB_PATH = join(root, 'db');
    const config = loadConfig({ repoRoot });
    const repoId = computeRepoId(repoRoot);
    const paths = resolveRepoPaths(config, repoRoot, repoId);
    const embeddingProvider = new HashEmbeddingProvider({ dimensions: 64 });
    const vectorStore = await LanceVectorStore.open(paths.dbDir, 64);
    await new Indexer({ repoRoot, repoId, config, vectorStore, embeddingProvider, paths }).runFullIndex();
    const context: AppContext = { repoRoot, repoId, config, paths, embeddingProvider, vectorStore };
    const runtime: McpRuntime = {
      defaultRepoRoot: repoRoot,
      config,
      resolve: async () => ({ ok: true, context }),
      listRepos: async () => [],
      listRegistered: () => [],
      status: async () => ({}),
      evict: () => undefined
    };
    const server = buildServer(runtime, new SessionStore({ nonce: 't' }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(clientTransport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await rm(root, { recursive: true, force: true });
    if (originalDbPath === undefined) delete process.env.CODE_INTEL_DB_PATH;
    else process.env.CODE_INTEL_DB_PATH = originalDbPath;
  });

  it('replies to get_task_context as text with a context id and raw code', async () => {
    const reply = text(await client.callTool({ name: 'get_task_context', arguments: { task: 'Where is AuthService defined?' } }));
    expect(reply).toMatch(/^repo · ctx t-1 · /);
    expect(reply).toContain('### [1] auth.ts:');
    expect(reply).toContain('class AuthService');
    expect(reply).not.toContain('"chunks"');
  });

  it('skips code this conversation already received when the ctx is passed back', async () => {
    const task = 'How does login check the password and create a session for the user?';
    const first = text(await client.callTool({ name: 'get_task_context', arguments: { task } }));
    const ctx = /ctx (t-\d+)/.exec(first)?.[1];
    expect(ctx).toBeDefined();
    const again = text(
      await client.callTool({ name: 'get_task_context', arguments: { task, ctx } })
    );
    expect(again).toContain('already sent in this conversation, unchanged');
    // Widen the largest block sent so far: the already-sent part comes back as a note, the rest in full.
    const blocks = [...first.matchAll(/### \[\d+\] (\S+):(\d+)-(\d+)/g)].map((m) => ({ file: m[1]!, start: Number(m[2]), end: Number(m[3]) }));
    const largest = blocks.sort((a, b) => b.end - b.start - (a.end - a.start))[0]!;
    expect(largest.end - largest.start + 1).toBeGreaterThanOrEqual(MIN_STUB_LINES);
    const range = `${largest.file}:${Math.max(1, largest.start - 2)}-${largest.end + 2}`;
    const read = text(await client.callTool({ name: 'get_file_context', arguments: { ctx, ranges: [range] } }));
    expect(read).toContain('unchanged, already sent in this conversation');
  });

  it('renders search results as text and names ones this conversation already has', async () => {
    const first = text(await client.callTool({ name: 'get_task_context', arguments: { task: 'Where is AuthService defined?' } }));
    const ctx = /ctx (t-\d+)/.exec(first)?.[1];
    const plain = text(await client.callTool({ name: 'search_codebase', arguments: { query: 'AuthService login', limit: 5 } }));
    expect(plain).toMatch(/^repo · \d+ results? · /);
    expect(plain).toContain('### [1] ');
    const deduped = text(await client.callTool({ name: 'search_codebase', arguments: { query: 'AuthService login', limit: 5, ctx } }));
    expect(deduped).toContain(`ctx ${ctx}`);
    const again = text(await client.callTool({ name: 'search_codebase', arguments: { query: 'AuthService login', limit: 5, ctx } }));
    expect(again).toMatch(/already sent/);
  });

  it('reads batched ranges and refuses secret files', async () => {
    const read = text(await client.callTool({ name: 'get_file_context', arguments: { ranges: ['auth.ts:1-2', 'users.ts:1-1', '.env'] } }));
    expect(read).toContain('### auth.ts:1-2 (of');
    expect(read).toContain('### users.ts:1-1 (of');
    expect(read).toMatch(/### \.env\nerror: .*secrets/);
  });
});
