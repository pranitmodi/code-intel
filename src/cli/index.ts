#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { Ollama } from 'ollama';
import { createContext, type AppContext } from '../context.js';
import { loadConfig } from '../config/load.js';
import { resolveRepoPaths } from '../config/paths.js';
import { installCursorIntegration } from '../cursor/install.js';
import { computeRepoId } from '../utils/repo-id.js';
import { removeRegistryEntry } from '../indexer/registry.js';
import { isIndexInsideRepo, scaffoldRepo } from '../indexer/scaffold.js';
import { getIndexStatus, listIndexedReposWithStale } from '../indexer/status.js';
import { Indexer, type IndexSummary } from '../indexer/Indexer.js';
import { watchRepo } from '../indexer/watch.js';
import { searchCodebase } from '../search/searchCodebase.js';
import { searchSymbol } from '../search/searchSymbol.js';
import { getFileContext } from '../search/getFileContext.js';
import { startMcpServer } from '../mcp/server.js';
import { formatBytes } from '../utils/dirSize.js';
import { runSavingsBenchmark } from '../usage/benchmark.js';
import { formatSavingsReport, summarizeUsage } from '../usage/report.js';
import { readBenchmark, readUsageEvents } from '../usage/store.js';

const program = new Command();
program
  .name('code-intel')
  .description('Local-first semantic code indexing and retrieval, exposed to AI agents via MCP.')
  .option('--repo <path>', 'repository root (defaults to the current directory) — use this when a host spawns the process with an unrelated cwd');

function resolveRepoRoot(): string {
  const opts = program.opts<{ repo?: string }>();
  const candidate = opts.repo ? resolve(opts.repo) : process.cwd();
  return existsSync(candidate) ? candidate : resolve(opts.repo ?? process.cwd());
}

function indexerFrom(context: AppContext): Indexer {
  return new Indexer({
    repoRoot: context.repoRoot,
    repoId: context.repoId,
    config: context.config,
    vectorStore: context.vectorStore,
    embeddingProvider: context.embeddingProvider,
    paths: context.paths
  });
}

function printSummary(summary: IndexSummary): void {
  console.log(`Files discovered: ${summary.filesDiscovered}`);
  console.log(`Files indexed:    ${summary.filesIndexed}`);
  console.log(`Files unchanged:  ${summary.filesUnchanged}`);
  console.log(`Files renamed:    ${summary.filesRenamed}`);
  console.log(`Files deleted:    ${summary.filesDeleted}`);
  console.log(`Files skipped:    ${summary.filesSkipped}`);
  console.log(`Chunks embedded:  ${summary.chunksEmbedded}`);
  console.log(`Chunks reused:    ${summary.chunksReused}`);
  console.log(`Chunks deleted:   ${summary.chunksDeleted}`);
  console.log(`\nDuration: ${(summary.durationMs / 1000).toFixed(1)}s`);
}

async function runIndex(repoRoot: string): Promise<{ context: AppContext; summary: IndexSummary }> {
  const context = await createContext(repoRoot);
  console.log(`Repository: ${context.repoRoot}`);
  console.log(`Index: ${context.paths.indexDir}\n`);
  const summary = await indexerFrom(context).runFullIndex();
  printSummary(summary);
  return { context, summary };
}

function addGitignoreEntry(repoRoot: string, indexDir: string): void {
  const gitignorePath = `${repoRoot}/.gitignore`;
  const relative = indexDir.startsWith(repoRoot) ? indexDir.slice(repoRoot.length + 1) : indexDir;
  const entry = `${relative}/`;
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  if (existing.split('\n').includes(entry)) return;
  const withNewline = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
  writeFileSync(gitignorePath, `${withNewline}${entry}\n`);
}

program
  .command('init')
  .description('Scaffold the local index location for the current repository')
  .action(() => {
    const repoRoot = resolveRepoRoot();
    const { repoId, paths } = scaffoldRepo(repoRoot);

    if (isIndexInsideRepo(paths)) {
      addGitignoreEntry(repoRoot, paths.indexDir);
    }

    console.log(`Repository: ${repoRoot}`);
    console.log(`Repository id: ${repoId}`);
    console.log(`Index location: ${paths.indexDir}`);
    console.log('\nNext: run `code-intel index` to build the initial index.');
  });

program
  .command('index')
  .description('Index (or incrementally update) the current repository')
  .action(async () => {
    await runIndex(resolveRepoRoot());
  });

program
  .command('setup')
  .description('Scaffold and index the current repository in one step')
  .action(async () => {
    const repoRoot = resolveRepoRoot();
    const { repoId, paths } = scaffoldRepo(repoRoot);
    if (isIndexInsideRepo(paths)) {
      addGitignoreEntry(repoRoot, paths.indexDir);
    }
    console.log(`Repository id: ${repoId}\n`);
    await runIndex(repoRoot);
    console.log('\nDone. Query this index from Cursor via the local-code-intelligence MCP tools.');
    console.log('If Cursor is not wired up yet, run `code-intel cursor-install`.');
  });

program
  .command('watch')
  .description('Watch the working tree and incrementally re-index after edits')
  .action(async () => {
    const context = await createContext(resolveRepoRoot());
    console.log(`Repository: ${context.repoRoot}`);
    console.log(`Index: ${context.paths.indexDir}`);
    console.log(`Watching for changes (debounce ${context.config.indexing.debounceMs}ms). Ctrl-C to stop.\n`);

    const stop = await watchRepo(context, {
      onIndex: (summary) => {
        const changed = summary.filesIndexed + summary.filesDeleted + summary.filesRenamed;
        if (changed === 0 && summary.chunksEmbedded === 0) return;
        console.log(
          `[${new Date().toISOString()}] indexed=${summary.filesIndexed} unchanged=${summary.filesUnchanged} embedded=${summary.chunksEmbedded} (${(summary.durationMs / 1000).toFixed(1)}s)`
        );
      }
    });

    const shutdown = async () => {
      await stop();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    await new Promise(() => {
      /* run until signal */
    });
  });

program
  .command('repos')
  .description('List locally indexed repositories')
  .option('--json', 'print raw JSON')
  .action(async (options: { json?: boolean }) => {
    const config = loadConfig({ repoRoot: resolveRepoRoot() });
    const repos = await listIndexedReposWithStale(config.database.path);
    if (options.json) {
      console.log(JSON.stringify({ repos }, null, 2));
      return;
    }
    if (repos.length === 0) {
      console.log('No indexed repositories. Run `code-intel setup` from a project root.');
      return;
    }
    for (const repo of repos) {
      const stale = repo.stale ? ' stale' : repo.stale === false ? '' : '';
      const when = repo.lastIndexedAt ?? 'never';
      console.log(`${repo.name}  ${repo.id}${stale}`);
      console.log(`  ${repo.path || '(path unknown)'}`);
      console.log(`  files ${repo.filesIndexed}  chunks ${repo.chunksIndexed}  last ${when}`);
      console.log();
    }
  });

program
  .command('search <query>')
  .description('Semantic + keyword + symbol hybrid search')
  .option('-l, --limit <number>', 'max results', (v) => Number.parseInt(v, 10))
  .option('--json', 'print raw JSON instead of a table')
  .action(async (query: string, options: { limit?: number; json?: boolean }) => {
    const context = await createContext(resolveRepoRoot());
    const results = await searchCodebase(query, context.vectorStore, context.embeddingProvider, context.config.search, {
      limit: options.limit
    });

    if (options.json) {
      console.log(JSON.stringify({ results }, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log('No results.');
      return;
    }
    results.forEach((result, index) => {
      console.log(`${index + 1}. ${result.file}`);
      if (result.symbol) console.log(`   ${result.symbol}`);
      console.log(`   lines ${result.startLine}-${result.endLine}`);
      console.log(`   similarity: ${result.score}`);
      console.log();
    });
  });

program
  .command('symbol <name>')
  .description('Exact/fuzzy symbol lookup, independent of embeddings')
  .action(async (name: string) => {
    const context = await createContext(resolveRepoRoot());
    const matches = await searchSymbol(name, context.vectorStore);
    if (matches.length === 0) {
      console.log('No symbols found.');
      return;
    }
    for (const match of matches) {
      const qualified = match.parentSymbol ? `${match.parentSymbol}.${match.symbol}` : match.symbol;
      console.log(`${qualified} (${match.symbolType ?? 'symbol'}) — ${match.file}:${match.startLine}-${match.endLine}`);
    }
  });

program
  .command('file <path>')
  .description('Retrieve exact file content by path and optional line range')
  .option('--start <number>', 'start line', (v) => Number.parseInt(v, 10))
  .option('--end <number>', 'end line', (v) => Number.parseInt(v, 10))
  .action(async (path: string, options: { start?: number; end?: number }) => {
    const context = await getFileContext(resolveRepoRoot(), path, options.start, options.end);
    console.log(`${context.file}:${context.startLine}-${context.endLine}\n`);
    console.log(context.content);
  });

program
  .command('status')
  .description('Show repository/index status')
  .action(async () => {
    const repoRoot = resolveRepoRoot();
    const config = loadConfig({ repoRoot });
    const status = await getIndexStatus(repoRoot);

    console.log(`Repository:        ${status.repoRoot}`);
    console.log(`Index location:    ${status.indexLocation ?? '(none)'}`);
    console.log(`Embedding provider: ${config.embedding.provider}`);
    console.log(`Embedding model:   ${status.embeddingModel ?? config.embedding.model}`);

    if (!status.indexed) {
      console.log(`\n${status.message}`);
      if (status.indexedChildren?.length) {
        console.log('\nIndexed children:');
        for (const child of status.indexedChildren) {
          console.log(`  ${child.name}  ${child.path}`);
        }
      }
      return;
    }

    console.log(`Files indexed:     ${status.filesIndexed}`);
    console.log(`Chunks indexed:    ${status.chunksIndexed}`);
    console.log(`Last update:       ${status.lastIndexedAt}`);
    console.log(`Database size:     ${status.databaseBytes != null ? formatBytes(status.databaseBytes) : 'unknown'}`);

    if (status.stale && status.filesDiscoverable != null) {
      console.log(
        `\nStale index: ${status.filesDiscoverable} files currently discoverable vs ${status.filesIndexed} at last index — run \`code-intel index\`.`
      );
    }
  });

program
  .command('doctor')
  .description('Diagnose Ollama availability, model presence, and database accessibility')
  .action(async () => {
    const repoRoot = resolveRepoRoot();
    const config = loadConfig({ repoRoot });
    let healthy = true;

    const client = new Ollama({ host: config.embedding.host });
    try {
      const { models } = await client.list();
      console.log(`[OK] Ollama reachable at ${config.embedding.host}`);
      const hasModel = models.some((m) => m.name === config.embedding.model || m.name.startsWith(`${config.embedding.model}:`));
      if (hasModel) {
        console.log(`[OK] Model "${config.embedding.model}" is available`);
      } else {
        healthy = false;
        console.log(`[FAIL] Model "${config.embedding.model}" not found — run \`ollama pull ${config.embedding.model}\``);
      }
    } catch (error) {
      healthy = false;
      console.log(`[FAIL] Ollama not reachable at ${config.embedding.host} — is \`ollama serve\` running?`);
      console.log(`       ${error instanceof Error ? error.message : String(error)}`);
    }

    const repoId = computeRepoId(repoRoot);
    const paths = resolveRepoPaths(config, repoRoot, repoId);
    try {
      mkdirSync(paths.dbDir, { recursive: true });
      const probeFile = `${paths.dbDir}/.write-probe`;
      writeFileSync(probeFile, 'ok');
      rmSync(probeFile);
      console.log(`[OK] Index directory is writable (${paths.indexDir})`);
    } catch (error) {
      healthy = false;
      console.log(`[FAIL] Index directory is not writable (${paths.indexDir})`);
      console.log(`       ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log(existsSync(paths.lockFile) ? '[INFO] A lock file is present — another process may be indexing.' : '[OK] No stale lock file.');

    if (!healthy) process.exitCode = 1;
  });

program
  .command('clean')
  .description('Remove the local index for the current repository (does not touch source files)')
  .action(() => {
    const repoRoot = resolveRepoRoot();
    const config = loadConfig({ repoRoot });
    const repoId = computeRepoId(repoRoot);
    const paths = resolveRepoPaths(config, repoRoot, repoId);
    rmSync(paths.indexDir, { recursive: true, force: true });
    removeRegistryEntry(config.database.path, repoId);
    console.log(`Removed ${paths.indexDir}`);
  });

program
  .command('rebuild')
  .description('Remove the local index and rebuild it from scratch')
  .action(async () => {
    const repoRoot = resolveRepoRoot();
    const config = loadConfig({ repoRoot });
    const repoId = computeRepoId(repoRoot);
    const paths = resolveRepoPaths(config, repoRoot, repoId);
    rmSync(paths.indexDir, { recursive: true, force: true });
    removeRegistryEntry(config.database.path, repoId);
    console.log(`Removed ${paths.indexDir}\n`);
    await runIndex(repoRoot);
  });

program
  .command('savings')
  .description('Estimate token and dollar savings vs workspace-wide Grep/Glob/Read')
  .option('--benchmark', 're-run the A/B experiment on every indexed repository')
  .option('--rate <dollars>', 'dollars per million input tokens', (v) => Number.parseFloat(v), 3)
  .option('--turns <n>', 'conversation length used to compound a dump that stays in context', (v) => Number.parseInt(v, 10), 15)
  .option('--json', 'print JSON instead of text')
  .action(async (options: { benchmark?: boolean; rate: number; turns: number; json?: boolean }) => {
    if (options.benchmark) {
      await runSavingsBenchmark((line) => {
        if (!options.json) console.error(line);
      });
    }
    const report = summarizeUsage(
      readUsageEvents(),
      { ratePerMillion: options.rate, turns: options.turns },
      readBenchmark()
    );
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatSavingsReport(report));
  });

program
  .command('cursor-install')
  .description('Register the MCP server and user rule in ~/.cursor (merges existing mcp.json)')
  .action(() => {
    const result = installCursorIntegration();
    console.log(`${result.createdMcp ? 'Created' : 'Updated'} ${result.mcpPath}`);
    console.log(`Wrote     ${result.rulePath}`);
    console.log(`Wrote     ${result.hooksPath}`);
    console.log(`Wrote     ${result.skillPath}`);
    console.log(`MCP CLI:  ${result.cliPath}`);
    console.log('\nReload MCP in Cursor (Settings → MCP). New chats pick up the rule, skill, and hooks.');
  });

program
  .command('mcp')
  .description('Start the MCP server over stdio (watches indexed repos under the workspace by default)')
  .option('--no-watch', 'do not start incremental file watchers')
  .action(async (options: { watch?: boolean }) => {
    const opts = program.opts<{ repo?: string }>();
    const repoRoot = opts.repo && existsSync(resolve(opts.repo)) ? resolve(opts.repo) : resolveRepoRoot();
    await startMcpServer(repoRoot, { watch: options.watch !== false });
  });

program.parseAsync(process.argv);
