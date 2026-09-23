import type { LoadConfigOptions } from '../config/load.js';
import { createContext } from '../context.js';
import { getTaskContext } from '../retrieval/taskContext.js';
import { searchCodebase } from '../search/searchCodebase.js';
import { estimateTokensFromText } from '../utils/tokens.js';
import { serializeToolResult, taskContextPayload } from '../mcp/payload.js';
import { CODE_INTEL_TASKS, type BenchmarkTask } from './datasets/codeIntelTasks.js';
import {
  meanReciprocalRank,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  tokenReductionPercent
} from './metrics.js';
import { keywordFromPrompt, workspaceScan } from './workspaceScan.js';

export interface RetrievalBenchmarkOptions {
  repoRoot: string;
  taskId?: string;
  loadOptions?: Omit<LoadConfigOptions, 'repoRoot'>;
}

export interface RetrievalBenchmarkReport {
  version: 1;
  repository: string;
  timestamp: string;
  tasks: Array<{
    id: string;
    relevantFiles: string[];
    semanticFiles: string[];
    retrievedFiles: string[];
    missingRelevantFiles: string[];
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
  }>;
  aggregate: {
    tokenReduction: number;
    precisionAt5: number;
    precisionAt5Ceiling: number;
    relevantCoverageAt5: number;
    recallAt10: number;
    mrr: number;
    ndcg: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
  };
  text: string;
}

function relevantSet(task: BenchmarkTask): Set<string> {
  return new Set(task.relevantFiles);
}

function levels(task: BenchmarkTask): Record<string, number> {
  if (task.relevanceLevels) return task.relevanceLevels;
  return Object.fromEntries(task.relevantFiles.map((file) => [file, 3]));
}

export async function runRetrievalBenchmark(
  options: RetrievalBenchmarkOptions
): Promise<RetrievalBenchmarkReport> {
  const app = await createContext(options.repoRoot, options.loadOptions);
  const tasks = options.taskId
    ? CODE_INTEL_TASKS.filter((task) => task.id === options.taskId)
    : CODE_INTEL_TASKS;
  if (tasks.length === 0) {
    throw new Error(`No benchmark task matches "${options.taskId}".`);
  }

  const rows: RetrievalBenchmarkReport['tasks'] = [];
  const latencies: number[] = [];

  for (const task of tasks) {
    const relevant = relevantSet(task);
    const relLevels = levels(task);
    const scan = workspaceScan(options.repoRoot, keywordFromPrompt(task.prompt));

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

    const taskStarted = Date.now();
    const pkg = await getTaskContext(task.prompt, app, { maxTokens: 8000 });
    const taskContextLatencyMs = Date.now() - taskStarted;
    const taskFiles = pkg.files.map((file) => file.path);
    const taskTokens = estimateTokensFromText(serializeToolResult(taskContextPayload(app.repoRoot, pkg)));

    latencies.push(scan.latencyMs, semanticLatencyMs, taskContextLatencyMs);
    rows.push({
      id: task.id,
      relevantFiles: task.relevantFiles,
      semanticFiles: [...new Set(semanticFiles)],
      retrievedFiles: taskFiles,
      missingRelevantFiles: task.relevantFiles.filter((file) => !taskFiles.includes(file)),
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
      taskContextLatencyMs
    });
  }

  const avg = (pick: (row: (typeof rows)[number]) => number) =>
    rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;

  const aggregate = {
    tokenReduction: avg((row) => row.tokenReductionVsScan) / 100,
    precisionAt5: avg((row) => row.precisionAt5),
    precisionAt5Ceiling: avg((row) => row.precisionAt5Ceiling),
    relevantCoverageAt5: avg((row) => row.relevantCoverageAt5),
    recallAt10: avg((row) => row.recallAt10),
    mrr: avg((row) => row.mrr),
    ndcg: avg((row) => row.ndcg),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99)
  };

  const header = 'Task                         Baseline    Code-Intel    Reduction';
  const body = rows
    .map((row) => {
      const id = row.id.padEnd(28);
      const base = String(Math.round(row.baselineTokens)).padStart(10);
      const ci = String(Math.round(row.taskContextTokens)).padStart(12);
      const red = `${row.tokenReductionVsScan.toFixed(1)}%`.padStart(12);
      return `${id}${base}${ci}${red}`;
    })
    .join('\n');

  const text = [
    'code-intel benchmark',
    '',
    header,
    '-'.repeat(64),
    body,
    '',
    `Average token reduction: ${(aggregate.tokenReduction * 100).toFixed(1)}%`,
    '',
    'Retrieval',
    '-'.repeat(64),
    `Precision@5                  ${aggregate.precisionAt5.toFixed(2)} (of the files returned; a full five-file answer could reach ${aggregate.precisionAt5Ceiling.toFixed(2)})`,
    `Relevant coverage@5          ${aggregate.relevantCoverageAt5.toFixed(2)}`,
    `Recall@10                    ${aggregate.recallAt10.toFixed(2)}`,
    `MRR                          ${aggregate.mrr.toFixed(2)}`,
    `NDCG                         ${aggregate.ndcg.toFixed(2)}`,
    '',
    'Latency',
    '-'.repeat(64),
    `p50                          ${Math.round(aggregate.p50LatencyMs)}ms`,
    `p95                          ${Math.round(aggregate.p95LatencyMs)}ms`
  ].join('\n');

  return {
    version: 1,
    repository: options.repoRoot,
    timestamp: new Date().toISOString(),
    tasks: rows,
    aggregate,
    text
  };
}
