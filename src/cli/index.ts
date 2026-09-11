#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { Ollama } from 'ollama';
import {
  applyCredentialsToEnv,
  resolveCorporateCredentials,
  resolveCorporateSettings,
  resolveEmbeddingRoute,
  resolveOllamaSettings,
  writeCorporateConfig,
  writeOllamaConfig,
  type CorporatePrompt
} from '../corporate/setup.js';
import { cursorSystemCaEnv, relaunchWithSystemCa } from '../corporate/systemCa.js';
import { createContext, type AppContext } from '../context.js';
import { createEmbeddingProvider } from '../embeddings/createEmbeddingProvider.js';
import { loadConfig, type EmbeddingConfigOverrides, type LoadConfigOptions } from '../config/load.js';
import { resolveRepoPaths } from '../config/paths.js';
import { installCursorIntegration } from '../cursor/install.js';
import { resolveIndexRoots } from '../discovery/gitRoots.js';
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
  .option('--repo <path>', 'repository root (defaults to the current directory) — use this when a host spawns the process with an unrelated cwd')
  .option('--embedding-provider <name>', 'ollama or openai-compatible')
  .option('--embedding-model <name>', 'embedding model id (e.g. nomic-embed-text or Qwen3-Embedding-8B)')
  .option('--embedding-host <url>', 'Ollama host (provider=ollama)')
  .option('--embedding-base-url <url>', 'OpenAI-compatible API origin or full /embeddings URL')
  .option('--embedding-path <path>', 'embeddings path appended to base URL (default /embeddings)');

interface CliGlobalOptions {
  repo?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingHost?: string;
  embeddingBaseUrl?: string;
  embeddingPath?: string;
}

function resolveRepoRoot(): string {
  const opts = program.opts<CliGlobalOptions>();
  const candidate = opts.repo ? resolve(opts.repo) : process.cwd();
  return existsSync(candidate) ? candidate : resolve(opts.repo ?? process.cwd());
}

function cliLoadOptions(): LoadConfigOptions {
  const opts = program.opts<CliGlobalOptions>();
  const overrides: EmbeddingConfigOverrides = {
    provider: opts.embeddingProvider,
    model: opts.embeddingModel,
    host: opts.embeddingHost,
    baseUrl: opts.embeddingBaseUrl,
    embeddingsPath: opts.embeddingPath
  };
  const hasOverride = Object.values(overrides).some((value) => value !== undefined);
  return { repoRoot: resolveRepoRoot(), ...(hasOverride ? { overrides } : {}) };
}

program.hook('preAction', (_command, actionCommand) => {
  const name = actionCommand.name();
  const wizardLike = name === 'corporate-setup' || name === 'wizard';
  const embedding = loadConfig(cliLoadOptions()).embedding;
  if (!wizardLike && !(embedding.provider === 'openai-compatible' && embedding.useSystemCa)) return;

  const childStatus = relaunchWithSystemCa();
  if (childStatus !== undefined) process.exit(childStatus);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    console.warn('[WARN] Ignoring insecure NODE_TLS_REJECT_UNAUTHORIZED=0; using the system CA store.');
  }
});

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
  const context = await createContext(repoRoot, cliLoadOptions());
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

function createTextPrompt(promptInterface: ReturnType<typeof createInterface>): CorporatePrompt {
  return async (label: string, fallback?: string): Promise<string> => {
    const suffix = fallback ? ` [${fallback}]` : '';
    return promptInterface.question(`${label}${suffix}: `);
  };
}

async function promptHidden(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    const fallback = createInterface({ input: stdin, output: process.stdout });
    try {
      return (await fallback.question(`${label}: `)).trim();
    } finally {
      fallback.close();
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdout.write(`${label}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (char: string): void => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        cleanup();
        process.stdout.write('\n');
        resolve(chunks.join('').trim());
        return;
      }
      if (char === '\u0003') {
        cleanup();
        reject(new Error('Cancelled'));
        return;
      }
      if (char === '\u007f' || char === '\b') {
        chunks.pop();
        return;
      }
      chunks.push(char);
      process.stdout.write('*');
    };
    stdin.on('data', onData);
  });
}

async function rebuildIndex(repoRoot: string): Promise<void> {
  const config = loadConfig({ repoRoot });
  const repoId = computeRepoId(repoRoot);
  const paths = resolveRepoPaths(config, repoRoot, repoId);
  if (existsSync(paths.indexDir)) {
    rmSync(paths.indexDir, { recursive: true, force: true });
    removeRegistryEntry(config.database.path, repoId);
    console.log(`Removed previous index ${paths.indexDir}`);
  }
  const scaffold = scaffoldRepo(repoRoot);
  if (isIndexInsideRepo(scaffold.paths)) addGitignoreEntry(repoRoot, scaffold.paths.indexDir);
  console.log(`Repository id: ${scaffold.repoId}\n`);
  await runIndex(repoRoot);
}

interface WizardOptions {
  provider?: string;
  model?: string;
  host?: string;
  baseUrl?: string;
  embeddingsPath?: string;
  apiKey?: string;
  user?: string;
  batchSize?: number;
  timeoutMs?: number;
  nonInteractive?: boolean;
  cursor: boolean;
}

async function setupTargets(requestedRoot: string): Promise<string[]> {
  const targets = await resolveIndexRoots(requestedRoot);
  if (targets.length > 1) {
    console.log(`Found ${targets.length} Git repositories; each will use a separate index:`);
    for (const target of targets) console.log(`  ${target}`);
    console.log();
  } else if (targets[0] !== requestedRoot) {
    console.log(`Using owning Git repository: ${targets[0]}\n`);
  }
  return targets;
}

async function runWizard(options: WizardOptions): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const targets = await setupTargets(repoRoot);
  const existing = loadConfig(cliLoadOptions());
  const globalOptions = program.opts<CliGlobalOptions>();
  const promptInterface = options.nonInteractive
    ? undefined
    : createInterface({ input: process.stdin, output: process.stdout });
  const prompt = promptInterface ? createTextPrompt(promptInterface) : undefined;

  try {
    const route = await resolveEmbeddingRoute(options.provider, prompt);
    if (route === 'ollama') {
      const settings = await resolveOllamaSettings(
        {
          model: options.model ?? globalOptions.embeddingModel ?? process.env.CODE_INTEL_EMBEDDING_MODEL,
          host: options.host ?? globalOptions.embeddingHost ?? process.env.CODE_INTEL_EMBEDDING_HOST,
          defaults:
            existing.embedding.provider === 'ollama'
              ? { model: existing.embedding.model, host: existing.embedding.host }
              : undefined
        },
        prompt
      );
      for (const target of targets) {
        const configPath = writeOllamaConfig(target, settings);
        console.log(`Configured ${configPath}`);
      }
      const config = loadConfig({ repoRoot: targets[0] });
      const dimensions = await createEmbeddingProvider(config.embedding).dimensions();
      console.log(`[OK] ${config.embedding.model} returned ${dimensions}-dimension vectors`);
      for (const target of targets) await rebuildIndex(target);
      if (options.cursor) {
        const result = installCursorIntegration();
        console.log(`\n${result.createdMcp ? 'Created' : 'Updated'} ${result.mcpPath}`);
        console.log('Reload MCP in Cursor (Settings → MCP).');
      }
      console.log('\nOllama setup complete.');
      return;
    }

    const credentials = await resolveCorporateCredentials(
      {
        apiKey: options.apiKey ?? process.env.CODE_INTEL_EMBEDDING_API_KEY,
        user: options.user ?? process.env.CODE_INTEL_EMBEDDING_USER
      },
      prompt,
      promptInterface
        ? async (label) => {
            promptInterface.pause();
            try {
              return await promptHidden(label);
            } finally {
              promptInterface.resume();
            }
          }
        : undefined
    );
    applyCredentialsToEnv(credentials);

    const previousCorporate =
      existing.embedding.provider === 'openai-compatible' ? existing.embedding : undefined;
    const settings = await resolveCorporateSettings(
      {
        model: options.model ?? globalOptions.embeddingModel ?? process.env.CODE_INTEL_EMBEDDING_MODEL,
        baseUrl:
          options.baseUrl ?? globalOptions.embeddingBaseUrl ?? process.env.CODE_INTEL_EMBEDDING_BASE_URL,
        embeddingsPath:
          options.embeddingsPath ?? globalOptions.embeddingPath ?? process.env.CODE_INTEL_EMBEDDING_PATH,
        batchSize: options.batchSize ?? previousCorporate?.batchSize,
        timeoutMs: options.timeoutMs ?? previousCorporate?.timeoutMs,
        defaults: previousCorporate
          ? {
              model: previousCorporate.model,
              baseUrl: previousCorporate.baseUrl,
              embeddingsPath: previousCorporate.embeddingsPath
            }
          : undefined
      },
      prompt
    );

    for (const target of targets) {
      const configPath = writeCorporateConfig(target, settings);
      console.log(`Configured ${configPath}`);
    }
    console.log('API key and username are kept in this process only; they are not written to YAML.');

    const config = loadConfig({ repoRoot: targets[0] });
    const dimensions = await createEmbeddingProvider(config.embedding).dimensions();
    console.log(`[OK] ${config.embedding.model} returned ${dimensions}-dimension vectors`);
    for (const target of targets) await rebuildIndex(target);

    if (options.cursor) {
      const result = installCursorIntegration({ serverEnv: cursorSystemCaEnv() });
      console.log(`\n${result.createdMcp ? 'Created' : 'Updated'} ${result.mcpPath}`);
      console.log(
        'Reload MCP in Cursor. Put CODE_INTEL_EMBEDDING_API_KEY (and USER if needed) in Cursor’s company-managed environment; code-intel does not save them.'
      );
    }
    console.log('\nCorporate setup complete.');
  } finally {
    promptInterface?.close();
  }
}

program
  .command('init')
  .description('Scaffold the local index location for the current repository')
  .action(() => {
    const repoRoot = resolveRepoRoot();
    const { repoId, paths } = scaffoldRepo(repoRoot, cliLoadOptions());

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
    const targets = await setupTargets(resolveRepoRoot());
    for (const repoRoot of targets) {
      const { repoId, paths } = scaffoldRepo(repoRoot, cliLoadOptions());
      if (isIndexInsideRepo(paths)) {
        addGitignoreEntry(repoRoot, paths.indexDir);
      }
      console.log(`Repository id: ${repoId}\n`);
      await runIndex(repoRoot);
    }
    console.log('\nDone. Query this index from Cursor via the local-code-intelligence MCP tools.');
    console.log('If Cursor is not wired up yet, run `code-intel cursor-install`.');
  });

program
  .command('wizard')
  .description('Interactive setup: choose Ollama or a company embedding proxy, then index this repo')
  .option('--provider <name>', 'ollama or openai-compatible (skips the first question)')
  .option('--model <name>', 'embedding model id')
  .option('--host <url>', 'Ollama host')
  .option('--base-url <url>', 'OpenAI-compatible API origin or full embeddings URL')
  .option('--embeddings-path <path>', 'path appended to the base URL')
  .option('--api-key <key>', 'embedding API key (not saved to disk; prefer the environment)')
  .option('--user <name>', 'optional user value required by some corporate proxies')
  .option('--batch-size <number>', 'texts per embedding request', (value) => Number.parseInt(value, 10))
  .option('--timeout-ms <number>', 'request timeout in milliseconds', (value) => Number.parseInt(value, 10))
  .option('--non-interactive', 'fail instead of prompting for missing settings')
  .option('--no-cursor', 'do not install or update the Cursor MCP integration')
  .action(async (options: WizardOptions) => {
    await runWizard(options);
  });

program
  .command('corporate-setup')
  .description('Configure a company OpenAI-compatible embedding service (same as wizard --provider openai-compatible)')
  .option('--model <name>', 'embedding model id')
  .option('--base-url <url>', 'OpenAI-compatible API origin or full embeddings URL')
  .option('--embeddings-path <path>', 'path appended to the base URL')
  .option('--api-key <key>', 'embedding API key (not saved to disk; prefer the environment)')
  .option('--user <name>', 'optional user value required by some corporate proxies')
  .option('--batch-size <number>', 'texts per embedding request', (value) => Number.parseInt(value, 10))
  .option('--timeout-ms <number>', 'request timeout in milliseconds', (value) => Number.parseInt(value, 10))
  .option('--non-interactive', 'fail instead of prompting for missing settings')
  .option('--no-cursor', 'do not install or update the Cursor MCP integration')
  .action(async (options: Omit<WizardOptions, 'provider' | 'host'>) => {
    await runWizard({ ...options, provider: 'openai-compatible' });
  });

program
  .command('watch')
  .description('Watch the working tree and incrementally re-index after edits')
  .action(async () => {
    const context = await createContext(resolveRepoRoot(), cliLoadOptions());
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
    const config = loadConfig(cliLoadOptions());
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
      if (repo.progress) {
        const label = repo.progress.active ? 'indexing' : 'partial';
        console.log(
          `  ${label} ${repo.progress.filesProcessed}/${repo.progress.filesDiscovered} files, ${repo.progress.chunksEmbedded} chunks embedded`
        );
      }
      console.log();
    }
  });

program
  .command('search <query>')
  .description('Semantic + keyword + symbol hybrid search')
  .option('-l, --limit <number>', 'max results', (v) => Number.parseInt(v, 10))
  .option('--json', 'print raw JSON instead of a table')
  .action(async (query: string, options: { limit?: number; json?: boolean }) => {
    const context = await createContext(resolveRepoRoot(), cliLoadOptions());
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
    const context = await createContext(resolveRepoRoot(), cliLoadOptions());
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
    const config = loadConfig(cliLoadOptions());
    const status = await getIndexStatus(repoRoot);

    console.log(`Repository:        ${status.repoRoot}`);
    console.log(`Index location:    ${status.indexLocation ?? '(none)'}`);
    console.log(`Embedding provider: ${config.embedding.provider}`);
    console.log(`Embedding model:   ${status.embeddingModel ?? config.embedding.model}`);
    if (config.embedding.provider === 'openai-compatible') {
      console.log(`Embedding base URL: ${config.embedding.baseUrl || '(unset)'}`);
      console.log(`Embedding path:    ${config.embedding.embeddingsPath}`);
    } else {
      console.log(`Embedding host:    ${config.embedding.host}`);
    }

    if (!status.indexed) {
      if (status.progress) {
        const label = status.progress.active ? 'Indexing' : 'Partial index';
        console.log(
          `\n${label}: ${status.progress.filesProcessed}/${status.progress.filesDiscovered} files processed, ` +
            `${status.progress.filesIndexed} indexed, ${status.progress.filesSkipped} skipped, ` +
            `${status.progress.chunksEmbedded} chunks embedded`
        );
        console.log(`Progress updated:  ${status.progress.updatedAt}`);
      }
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
    if (status.progress) {
      console.log(
        `${status.progress.active ? 'Indexing' : 'Partial update'}:    ` +
          `${status.progress.filesProcessed}/${status.progress.filesDiscovered} files processed`
      );
    }

    if (status.stale && status.filesDiscoverable != null) {
      console.log(
        `\nStale index: ${status.filesDiscoverable} files currently discoverable vs ${status.filesIndexed} at last index — run \`code-intel index\`.`
      );
    }
  });

program
  .command('doctor')
  .description('Diagnose embedding provider, model, credentials, and database accessibility')
  .action(async () => {
    const repoRoot = resolveRepoRoot();
    const config = loadConfig(cliLoadOptions());
    let healthy = true;

    if (config.embedding.provider === 'ollama') {
      const client = new Ollama({ host: config.embedding.host });
      try {
        const { models } = await client.list();
        console.log(`[OK] Ollama reachable at ${config.embedding.host}`);
        const hasModel = models.some(
          (model) => model.name === config.embedding.model || model.name.startsWith(`${config.embedding.model}:`)
        );
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
    } else {
      try {
        const provider = createEmbeddingProvider(config.embedding);
        const dimensions = await provider.dimensions();
        console.log(`[OK] Embedding proxy reachable at ${config.embedding.baseUrl}`);
        console.log(`[OK] Model "${config.embedding.model}" returned ${dimensions}-dimension vectors`);
      } catch (error) {
        healthy = false;
        console.log(`[FAIL] OpenAI-compatible embedding provider is not ready`);
        console.log(`       ${error instanceof Error ? error.message : String(error)}`);
      }
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
    const config = loadConfig(cliLoadOptions());
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
    const config = loadConfig(cliLoadOptions());
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
    const opts = program.opts<CliGlobalOptions>();
    const repoRoot = opts.repo && existsSync(resolve(opts.repo)) ? resolve(opts.repo) : resolveRepoRoot();
    await startMcpServer(repoRoot, { watch: options.watch !== false });
  });

void program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
