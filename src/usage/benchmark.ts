import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from '../config/load.js';
import { createContext, type AppContext } from '../context.js';
import { listIndexedRepos } from '../indexer/registry.js';
import { serializeToolResult, taskContextPayload } from '../mcp/payload.js';
import { getTaskContext } from '../retrieval/taskContext.js';
import { estimateTokensFromChars, estimateTokensFromText } from '../utils/tokens.js';
import { writeBenchmark } from './store.js';
import type { BenchmarkFile, BenchmarkQuery, BenchmarkRepo } from './types.js';

const MAX_READ_FILES = 12;
const INDEX_TOOL = 'get_task_context';
const RG_GLOBS = ['!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!Pods/**', '!DerivedData/**'];

const CASES: { query: string; grepKeyword: string }[] = [
  { query: 'How does authentication and login session handling work?', grepKeyword: 'auth' },
  { query: 'Fix error handling in the request path', grepKeyword: 'error' },
  { query: 'Where is the API request client implemented?', grepKeyword: 'api' }
];

function rgBin(): string {
  return process.env.CODE_INTEL_RG ?? 'rg';
}

function rg(args: string[]): { stdout: Buffer; ms: number; ok: boolean } {
  const started = Date.now();
  const result = spawnSync(rgBin(), args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  return { stdout: result.stdout ?? Buffer.alloc(0), ms: Date.now() - started, ok: result.error == null };
}

function globArgs(repo: string, extra: string[]): string[] {
  const globs = RG_GLOBS.flatMap((g) => ['--glob', g]);
  return [...globs, ...extra, repo];
}

function corpusAndGlob(repo: string): Pick<
  BenchmarkRepo,
  'filesListed' | 'corpusTokens' | 'globListMs' | 'globListTokens'
> {
  const listed = rg(globArgs(repo, ['--files']));
  const files = listed.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  let bytes = 0;
  for (const file of files) {
    try {
      bytes += statSync(file).size;
    } catch {
      /* skip */
    }
  }
  return {
    filesListed: files.length,
    corpusTokens: estimateTokensFromChars(bytes),
    globListMs: listed.ms,
    globListTokens: estimateTokensFromChars(listed.stdout.length)
  };
}

function grepSide(repo: string, keyword: string, globListTokens: number): Omit<
  BenchmarkQuery,
  | 'query'
  | 'searchMs'
  | 'resultCount'
  | 'searchTokens'
  | 'tokensSavedPerTurn'
  | 'pctSaved'
> {
  const dump = rg(globArgs(repo, ['-n', '-C', '2', '--max-count', '200', '--', keyword]));
  const filesOut = rg(globArgs(repo, ['-l', '--max-count', '200', '--', keyword]));
  const files = filesOut.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  let readBytes = 0;
  for (const file of files.slice(0, MAX_READ_FILES)) {
    try {
      readBytes += statSync(file).size;
    } catch {
      /* skip */
    }
  }
  const grepDumpTokens = estimateTokensFromChars(dump.stdout.length);
  const readTopFilesTokens = estimateTokensFromChars(readBytes);
  return {
    grepKeyword: keyword,
    grepMs: dump.ms,
    grepDumpTokens,
    matchingFiles: files.length,
    readTopFiles: Math.min(files.length, MAX_READ_FILES),
    readTopFilesTokens,
    globListTokens,
    naiveAgentTokens: globListTokens + grepDumpTokens + readTopFilesTokens
  };
}

/** Tokens of the exact get_task_context result an agent would receive, uncapped. */
async function searchSide(context: AppContext, query: string): Promise<{
  searchMs: number;
  resultCount: number;
  searchTokens: number;
}> {
  const started = Date.now();
  const pkg = await getTaskContext(query, context);
  const searchMs = Date.now() - started;
  return {
    searchMs,
    resultCount: pkg.files.reduce((sum, file) => sum + file.chunks.length, 0),
    searchTokens: estimateTokensFromText(serializeToolResult(taskContextPayload(context.repoRoot, pkg)))
  };
}

export async function runSavingsBenchmark(onProgress?: (line: string) => void): Promise<BenchmarkFile> {
  const indexed = listIndexedRepos(loadConfig().database.path).filter(
    (entry) => entry.path && entry.filesIndexed > 0
  );

  const out: BenchmarkFile = {
    ranAt: new Date().toISOString(),
    charsPerToken: 4,
    maxReadFiles: MAX_READ_FILES,
    indexTool: INDEX_TOOL,
    repos: []
  };

  for (const entry of indexed) {
    const repoPath = entry.path;
    const name = entry.name || basename(repoPath);
    onProgress?.(`Benchmarking ${name}…`);
    const corpus = corpusAndGlob(repoPath);
    const context = await createContext(repoPath);
    const queries: BenchmarkQuery[] = [];
    await searchSide(context, CASES[0]!.query);
    for (const c of CASES) {
      const grep = grepSide(repoPath, c.grepKeyword, corpus.globListTokens);
      const search = await searchSide(context, c.query);
      const indexedTokens = search.searchTokens;
      const tokensSavedPerTurn = Math.max(0, grep.naiveAgentTokens - indexedTokens);
      const pctSaved = grep.naiveAgentTokens > 0 ? Math.round((1000 * tokensSavedPerTurn) / grep.naiveAgentTokens) / 10 : 0;
      queries.push({
        query: c.query,
        ...grep,
        ...search,
        tokensSavedPerTurn,
        pctSaved
      });
      onProgress?.(
        `  ${c.grepKeyword}: naive ${grep.naiveAgentTokens} tok → index ${indexedTokens} tok (${pctSaved}% saved)`
      );
    }
    out.repos.push({ name, path: repoPath, ...corpus, queries });
  }

  writeBenchmark(out);
  return out;
}
