import { relative, sep } from 'node:path';
import type { LoadConfigOptions } from '../config/load.js';
import { createContext } from '../context.js';
import { getTaskContext } from '../retrieval/taskContext.js';
import { searchCodebase } from '../search/searchCodebase.js';
import { estimateTokensFromText } from '../utils/tokens.js';
import { serializeToolResult } from '../mcp/payload.js';
import { renderTaskContextReply } from '../mcp/render.js';
import { CODE_INTEL_TASKS, CROSS_CUTTING_TASKS, type BenchmarkTask } from './datasets/codeIntelTasks.js';
import {
  meanReciprocalRank,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  tokenReductionPercent
} from './metrics.js';
import { DEFAULT_SESSION_PARAMS, groupIntoTurns, simulateSession, type SessionCost } from './sessionModel.js';
import { fileTokens, filesQuoting, keywordFromPrompt, workspaceScan } from './workspaceScan.js';

/** The labeled tasks quote every prompt verbatim, so retrieval must not count them as answers. */
const BENCHMARK_DATASET_PATHS = ['src/benchmark/datasets/'];

/** `core` is the original 8-task regression set; `cross-cutting` holds multi-part questions. */
export type BenchmarkSuite = 'core' | 'cross-cutting' | 'all';

export interface RetrievalBenchmarkOptions {
  repoRoot: string;
  taskId?: string;
  suite?: BenchmarkSuite;
  loadOptions?: Omit<LoadConfigOptions, 'repoRoot'>;
}

export interface TaskSessionComparison {
  /** First `get_task_context` reply, then a search and a whole-file read per essential file it missed. */
  indexed: SessionCost;
  /** File listing, one content search, a search per essential file the grep missed, then whole-file reads. */
  filesystem: SessionCost;
  /** indexed / filesystem, cached input-token equivalents; below 1 means the index saved. */
  costRatio: number;
}

export interface BenchmarkTaskRow {
  id: string;
  suite: Exclude<BenchmarkSuite, 'all'>;
  relevantFiles: string[];
  semanticFiles: string[];
  retrievedFiles: string[];
  missingRelevantFiles: string[];
  essentialFiles: string[];
  missingEssentialFiles: string[];
  /** Share of essential files present in the first reply. */
  essentialCoverage: number;
  /** Share of labeled facets with at least one of their files in the first reply; null without facets. */
  facetCoverage: number | null;
  baselineTokens: number;
  semanticTokens: number;
  taskContextTokens: number;
  tokenReductionVsScan: number;
  precisionAt5: number;
  precisionAt5Ceiling: number;
  relevantCoverageAt5: number;
  recallAt10: number;
  mrr: number;
  ndcg: number;
  scanLatencyMs: number;
  semanticLatencyMs: number;
  taskContextLatencyMs: number;
  session: TaskSessionComparison;
}

export interface BenchmarkAggregate {
  tasks: number;
  tokenReduction: number;
  precisionAt5: number;
  precisionAt5Ceiling: number;
  relevantCoverageAt5: number;
  recallAt10: number;
  mrr: number;
  ndcg: number;
  essentialCoverage: number;
  /** Mean over tasks with facet labels; null when none have them. */
  facetCoverage: number | null;
  /** Median of per-task session cost ratios (indexed / filesystem, cached). */
  sessionCostRatio: number;
  indexedModelCalls: number;
  filesystemModelCalls: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

export interface RetrievalBenchmarkReport {
  version: 2;
  repository: string;
  timestamp: string;
  tasks: BenchmarkTaskRow[];
  aggregate: BenchmarkAggregate;
  suites: Partial<Record<Exclude<BenchmarkSuite, 'all'>, BenchmarkAggregate>>;
  text: string;
}

function relevantSet(task: BenchmarkTask): Set<string> {
  return new Set(task.relevantFiles);
}

function levels(task: BenchmarkTask): Record<string, number> {
  if (task.relevanceLevels) return task.relevanceLevels;
  return Object.fromEntries(task.relevantFiles.map((file) => [file, 3]));
}

function tasksFor(options: RetrievalBenchmarkOptions): Array<{ task: BenchmarkTask; suite: BenchmarkTaskRow['suite'] }> {
  const suite = options.suite ?? 'all';
  const all = [
    ...(suite !== 'cross-cutting' ? CODE_INTEL_TASKS.map((task) => ({ task, suite: 'core' as const })) : []),
    ...(suite !== 'core'
      ? CROSS_CUTTING_TASKS.map((task) => ({ task, suite: 'cross-cutting' as const }))
      : [])
  ];
  return options.taskId ? all.filter(({ task }) => task.id === options.taskId) : all;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function aggregateRows(rows: BenchmarkTaskRow[]): BenchmarkAggregate {
  const avg = (pick: (row: BenchmarkTaskRow) => number) =>
    rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
  const faceted = rows.filter((row) => row.facetCoverage !== null);
  const latencies = rows.flatMap((row) => [row.scanLatencyMs, row.semanticLatencyMs, row.taskContextLatencyMs]);
  return {
    tasks: rows.length,
    tokenReduction: avg((row) => row.tokenReductionVsScan) / 100,
    precisionAt5: avg((row) => row.precisionAt5),
    precisionAt5Ceiling: avg((row) => row.precisionAt5Ceiling),
    relevantCoverageAt5: avg((row) => row.relevantCoverageAt5),
    recallAt10: avg((row) => row.recallAt10),
    mrr: avg((row) => row.mrr),
    ndcg: avg((row) => row.ndcg),
    essentialCoverage: avg((row) => row.essentialCoverage),
    facetCoverage:
      faceted.length === 0 ? null : faceted.reduce((sum, row) => sum + (row.facetCoverage ?? 0), 0) / faceted.length,
    sessionCostRatio: median(rows.map((row) => row.session.costRatio)),
    indexedModelCalls: avg((row) => row.session.indexed.modelCalls),
    filesystemModelCalls: avg((row) => row.session.filesystem.modelCalls),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99)
  };
}

export async function runRetrievalBenchmark(
  options: RetrievalBenchmarkOptions
): Promise<RetrievalBenchmarkReport> {
  const app = await createContext(options.repoRoot, options.loadOptions);
  const tasks = tasksFor(options);
  if (tasks.length === 0) {
    throw new Error(`No benchmark task matches "${options.taskId}".`);
  }

  const rows: BenchmarkTaskRow[] = [];

  for (const { task, suite } of tasks) {
    const relevant = relevantSet(task);
    const relLevels = levels(task);
    const scan = workspaceScan(options.repoRoot, keywordFromPrompt(task.prompt));

    // Task context runs first so its query embedding is measured cold, as an agent's first call is.
    const taskStarted = Date.now();
    const excludePaths = [...BENCHMARK_DATASET_PATHS, ...filesQuoting(options.repoRoot, task.prompt)];
    const pkg = await getTaskContext(task.prompt, app, { maxTokens: 8000, excludePaths });
    const taskContextLatencyMs = Date.now() - taskStarted;
    const taskFiles = pkg.files.map((file) => file.path);
    // Count exactly what the MCP server would send in the configured reply format.
    const taskTokens = estimateTokensFromText(renderTaskContextReply(app.repoRoot, pkg));

    const semanticStarted = Date.now();
    const semantic = await searchCodebase(
      task.prompt,
      app.vectorStore,
      app.embeddingProvider,
      app.config.search,
      { limit: 10, maxTokens: 4000 }
    );
    const semanticLatencyMs = Date.now() - semanticStarted;
    const semanticFiles = semantic.map((item) => item.file);
    const semanticTokens = estimateTokensFromText(
      serializeToolResult({ repo: app.repoRoot, results: semantic })
    );

    const essentialFiles = task.essentialFiles ?? task.relevantFiles;
    const retrieved = new Set(taskFiles);
    const missingEssentialFiles = essentialFiles.filter((file) => !retrieved.has(file));
    const facetCoverage = task.facets?.length
      ? task.facets.filter((facet) => facet.files.some((file) => retrieved.has(file))).length / task.facets.length
      : null;

    // Both agents need one search to locate each essential file they have not
    // seen yet (the index's reply, or the grep's matches), then read it whole.
    const search = DEFAULT_SESSION_PARAMS.searchResultTokens;
    const grepHits = new Set(scan.files.map((file) => relative(options.repoRoot, file).split(sep).join('/')));
    const unmatched = essentialFiles.filter((file) => !grepHits.has(file));
    const indexed = simulateSession([
      [taskTokens],
      ...groupIntoTurns(missingEssentialFiles.map(() => search)),
      ...groupIntoTurns(missingEssentialFiles.map((file) => fileTokens(options.repoRoot, file)))
    ]);
    const filesystem = simulateSession([
      [scan.listTokens],
      [scan.grepTokens],
      ...groupIntoTurns(unmatched.map(() => search)),
      ...groupIntoTurns(essentialFiles.map((file) => fileTokens(options.repoRoot, file)))
    ]);

    rows.push({
      id: task.id,
      suite,
      relevantFiles: task.relevantFiles,
      semanticFiles: [...new Set(semanticFiles)],
      retrievedFiles: taskFiles,
      missingRelevantFiles: task.relevantFiles.filter((file) => !retrieved.has(file)),
      essentialFiles,
      missingEssentialFiles,
      essentialCoverage: essentialFiles.length === 0 ? 1 : 1 - missingEssentialFiles.length / essentialFiles.length,
      facetCoverage,
      baselineTokens: scan.estimatedTokens,
      semanticTokens,
      taskContextTokens: taskTokens,
      tokenReductionVsScan: tokenReductionPercent(scan.estimatedTokens, taskTokens),
      precisionAt5: precisionAtK(taskFiles, relevant, 5),
      precisionAt5Ceiling: Math.min(5, relevant.size) / 5,
      relevantCoverageAt5: recallAtK(taskFiles, relevant, 5),
      recallAt10: recallAtK(taskFiles, relevant, 10),
      mrr: meanReciprocalRank(taskFiles.length > 0 ? taskFiles : semanticFiles, relevant),
      ndcg: ndcgAtK(taskFiles, relLevels, 10),
      scanLatencyMs: scan.latencyMs,
      semanticLatencyMs,
      taskContextLatencyMs,
      session: {
        indexed,
        filesystem,
        costRatio: filesystem.costCached > 0 ? indexed.costCached / filesystem.costCached : 1
      }
    });
  }

  const aggregate = aggregateRows(rows);
  const suites: RetrievalBenchmarkReport['suites'] = {};
  for (const suite of ['core', 'cross-cutting'] as const) {
    const suiteRows = rows.filter((row) => row.suite === suite);
    if (suiteRows.length > 0) suites[suite] = aggregateRows(suiteRows);
  }

  return {
    version: 2,
    repository: options.repoRoot,
    timestamp: new Date().toISOString(),
    tasks: rows,
    aggregate,
    suites,
    text: formatReport(rows, aggregate, suites)
  };
}

function formatAggregate(label: string, aggregate: BenchmarkAggregate): string[] {
  return [
    `${label} (${aggregate.tasks} task${aggregate.tasks === 1 ? '' : 's'})`,
    '-'.repeat(64),
    `Precision@5                  ${aggregate.precisionAt5.toFixed(2)} (of the files returned; a full five-file answer could reach ${aggregate.precisionAt5Ceiling.toFixed(2)})`,
    `Relevant coverage@5          ${aggregate.relevantCoverageAt5.toFixed(2)}`,
    `Recall@10                    ${aggregate.recallAt10.toFixed(2)}`,
    `MRR                          ${aggregate.mrr.toFixed(2)}`,
    `NDCG                         ${aggregate.ndcg.toFixed(2)}`,
    `Essential files, 1st reply   ${aggregate.essentialCoverage.toFixed(2)}`,
    ...(aggregate.facetCoverage !== null
      ? [`Facets covered, 1st reply    ${aggregate.facetCoverage.toFixed(2)}`]
      : []),
    `Session cost vs filesystem   ${aggregate.sessionCostRatio.toFixed(2)}x (median, cached; model calls ${aggregate.indexedModelCalls.toFixed(1)} vs ${aggregate.filesystemModelCalls.toFixed(1)})`,
    ''
  ];
}

function formatReport(
  rows: BenchmarkTaskRow[],
  aggregate: BenchmarkAggregate,
  suites: RetrievalBenchmarkReport['suites']
): string {
  const header = 'Task                         Baseline    Code-Intel    Reduction   Essential';
  const body = rows
    .map((row) => {
      const id = row.id.padEnd(28);
      const base = String(Math.round(row.baselineTokens)).padStart(10);
      const ci = String(Math.round(row.taskContextTokens)).padStart(12);
      const red = `${row.tokenReductionVsScan.toFixed(1)}%`.padStart(12);
      const essential = `${Math.round(row.essentialCoverage * row.essentialFiles.length)}/${row.essentialFiles.length}`.padStart(12);
      return `${id}${base}${ci}${red}${essential}`;
    })
    .join('\n');

  const suiteSections = (['core', 'cross-cutting'] as const).flatMap((suite) =>
    suites[suite] ? formatAggregate(suite === 'core' ? 'Core tasks' : 'Cross-cutting tasks', suites[suite]!) : []
  );

  return [
    'code-intel benchmark',
    '',
    header,
    '-'.repeat(76),
    body,
    '',
    `Average token reduction: ${(aggregate.tokenReduction * 100).toFixed(1)}%`,
    '',
    ...suiteSections,
    'Session model',
    '-'.repeat(64),
    `Each essential file an agent has not seen costs one search (~${DEFAULT_SESSION_PARAMS.searchResultTokens} tokens) and a whole-file read, ${DEFAULT_SESSION_PARAMS.callsPerTurn} calls per turn.`,
    'Costs are input-token equivalents with prompt caching (read 0.1x, write 1.25x, output 5x).',
    '',
    'Latency',
    '-'.repeat(64),
    `p50                          ${Math.round(aggregate.p50LatencyMs)}ms`,
    `p95                          ${Math.round(aggregate.p95LatencyMs)}ms`
  ].join('\n');
}
