import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Ollama } from 'ollama';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { resolveRepoPaths } from '../../src/config/paths.js';
import { computeRepoId } from '../../src/utils/repo-id.js';
import { OllamaEmbeddingProvider } from '../../src/embeddings/OllamaEmbeddingProvider.js';
import { LanceVectorStore } from '../../src/vector-store/LanceVectorStore.js';
import { Indexer } from '../../src/indexer/Indexer.js';

const EMBEDDING_MODEL = 'nomic-embed-text';
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'test-repo');
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL_TOOLS = [
  'find_references',
  'get_file_context',
  'get_repo_context',
  'index_status',
  'list_indexed_repos',
  'search_codebase',
  'search_symbol'
];

async function isOllamaReady(): Promise<boolean> {
  try {
    const client = new Ollama({ host: 'http://127.0.0.1:11434' });
    const { models } = await client.list();
    return models.some((m) => m.name === EMBEDDING_MODEL || m.name.startsWith(`${EMBEDDING_MODEL}:`));
  } catch {
    return false;
  }
}

function parseToolText(result: { content: unknown }): Record<string, unknown> {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function connectMcp(repoRoot: string, dbHome: string): Promise<Client> {
  const client = new Client({ name: 'test-harness', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: resolve(PROJECT_ROOT, 'node_modules/.bin/tsx'),
    args: [resolve(PROJECT_ROOT, 'src/cli/index.ts'), 'mcp', '--repo', repoRoot],
    env: { ...(process.env as Record<string, string>), CODE_INTEL_DB_PATH: dbHome }
  });
  await client.connect(transport);
  return client;
}

const ollamaReady = await isOllamaReady();

describe('MCP server without an index', () => {
  let repoRoot: string;
  let dbHome: string;
  let client: Client;

  beforeAll(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-mcp-empty-'));
    dbHome = await mkdtemp(join(tmpdir(), 'code-intel-mcp-empty-db-'));
    client = await connectMcp(repoRoot, dbHome);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(dbHome, { recursive: true, force: true });
  });

  it('starts and exposes list/status plus the five retrieval tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
  });

  it('index_status reports the workspace is not indexed', async () => {
    const payload = parseToolText(await client.callTool({ name: 'index_status', arguments: {} }));
    expect(payload.indexed).toBe(false);
    expect(String(payload.message)).toMatch(/code-intel/);
  });

  it('search_codebase returns an index hint instead of crashing', async () => {
    const payload = parseToolText(
      await client.callTool({ name: 'search_codebase', arguments: { query: 'anything' } })
    );
    expect(payload.ok).toBe(false);
    expect(payload.indexed).toBe(false);
  });
});

// Verifies the MCP server itself: a real client, spawned over stdio (same transport a host IDE uses),
// calling the exact tools an agent would (spec section 44's "connect through MCP" step).
describe.skipIf(!ollamaReady)('MCP server (spec section 20/44)', () => {
  let repoRoot: string;
  let dbHome: string;
  let client: Client;

  beforeAll(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-mcp-repo-'));
    dbHome = await mkdtemp(join(tmpdir(), 'code-intel-mcp-db-'));
    await cp(FIXTURE_DIR, repoRoot, { recursive: true });

    const config = loadConfig({ repoRoot });
    config.database.path = dbHome;
    const repoId = computeRepoId(repoRoot);
    const paths = resolveRepoPaths(config, repoRoot, repoId);

    const embeddingProvider = new OllamaEmbeddingProvider({ host: config.embedding.host, model: config.embedding.model });
    const dimensions = await embeddingProvider.dimensions();
    const vectorStore = await LanceVectorStore.open(paths.dbDir, dimensions);
    await new Indexer({ repoRoot, repoId, config, vectorStore, embeddingProvider, paths }).runFullIndex();

    client = await connectMcp(repoRoot, dbHome);
  }, 60000);

  afterAll(async () => {
    await client?.close();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(dbHome, { recursive: true, force: true });
  });

  it('starts and exposes all tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
  });

  it('list_indexed_repos includes the fixture repo', async () => {
    const payload = parseToolText(await client.callTool({ name: 'list_indexed_repos', arguments: {} })) as {
      repos: { path: string; filesIndexed: number }[];
    };
    expect(payload.repos.some((r) => r.path === repoRoot)).toBe(true);
  });

  it('index_status reports the fixture as indexed', async () => {
    const payload = parseToolText(await client.callTool({ name: 'index_status', arguments: {} }));
    expect(payload.indexed).toBe(true);
    expect(payload.repoRoot).toBe(repoRoot);
  });

  it('search_codebase returns file/symbol/line-range/score/content for a real query', async () => {
    const payload = parseToolText(
      await client.callTool({ name: 'search_codebase', arguments: { query: 'how does authentication work?' } })
    ) as { results: { file: string; startLine: number; endLine: number; score: number }[] };
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0]?.file).toBe('auth.ts');
    expect(typeof payload.results[0]?.startLine).toBe('number');
    expect(typeof payload.results[0]?.score).toBe('number');
  }, 30000);

  it('accepts an explicit repo path for search_symbol', async () => {
    const payload = parseToolText(
      await client.callTool({ name: 'search_symbol', arguments: { name: 'AuthService', repo: repoRoot } })
    ) as { matches: { symbol: string }[]; repo: string };
    expect(payload.repo).toBe(repoRoot);
    expect(payload.matches.some((m) => m.symbol === 'AuthService')).toBe(true);
  });

  it('get_file_context reads real source content, not a stale vector-store copy', async () => {
    const payload = parseToolText(
      await client.callTool({ name: 'get_file_context', arguments: { file: 'auth.ts', start_line: 1, end_line: 3 } })
    ) as { content: string };
    expect(payload.content).toContain('AuthService');
  });

  it('get_repo_context returns a deterministic language/directory rollup', async () => {
    const payload = parseToolText(await client.callTool({ name: 'get_repo_context', arguments: {} })) as {
      totalFiles: number;
      languages: { language: string }[];
    };
    expect(payload.totalFiles).toBe(4);
    expect(payload.languages.some((l) => l.language === 'typescript')).toBe(true);
  });
});
