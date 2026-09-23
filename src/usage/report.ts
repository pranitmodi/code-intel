import type { BenchmarkFile, SavingsOptions, SavingsReport, UsageEvent } from './types.js';

export function dollarsForTokens(tokens: number, ratePerMillion: number): number {
  return (tokens / 1_000_000) * ratePerMillion;
}

export function summarizeUsage(
  events: UsageEvent[],
  options: SavingsOptions,
  benchmark?: BenchmarkFile
): SavingsReport {
  const searches = events.filter((e) => e.kind === 'mcp_retrieval');
  const denied = events.filter((e) => e.kind === 'denied_scan');
  const resultTokens = searches.reduce((sum, e) => sum + e.resultTokens, 0);
  const searchBaseline = searches.reduce((sum, e) => sum + e.baselineTokens, 0);
  const tokensSavedPerTurn = Math.max(0, searchBaseline - resultTokens);
  const tokensSavedCompounded = tokensSavedPerTurn * options.turns;

  const report: SavingsReport = {
    ratePerMillion: options.ratePerMillion,
    turns: options.turns,
    searches: searches.length,
    deniedScans: denied.length,
    resultTokens,
    baselineTokens: searchBaseline,
    tokensSavedPerTurn,
    tokensSavedCompounded,
    usdSavedPerTurn: dollarsForTokens(tokensSavedPerTurn, options.ratePerMillion),
    usdSavedCompounded: dollarsForTokens(tokensSavedCompounded, options.ratePerMillion)
  };

  if (benchmark?.repos.length) {
    const queries = benchmark.repos.flatMap((repo) => repo.queries);
    const n = queries.length;
    if (n > 0) {
      const avg = (pick: (q: (typeof queries)[number]) => number) =>
        queries.reduce((sum, q) => sum + pick(q), 0) / n;
      report.benchmark = {
        ranAt: benchmark.ranAt,
        queries: n,
        avgNaiveTokens: Math.round(avg((q) => q.naiveAgentTokens)),
        avgSearchTokens: Math.round(avg((q) => q.searchTokens)),
        avgSavedTokens: Math.round(avg((q) => q.tokensSavedPerTurn)),
        avgPctSaved: Math.round(avg((q) => q.pctSaved) * 10) / 10,
        avgSearchMs: Math.round(avg((q) => q.searchMs)),
        avgGrepMs: Math.round(avg((q) => q.grepMs)),
        repos: benchmark.repos.map((repo) => {
          const qn = repo.queries.length || 1;
          return {
            name: repo.name,
            filesListed: repo.filesListed,
            avgSavedTokens: Math.round(repo.queries.reduce((s, q) => s + q.tokensSavedPerTurn, 0) / qn),
            avgPctSaved: Math.round((repo.queries.reduce((s, q) => s + q.pctSaved, 0) / qn) * 10) / 10
          };
        })
      };
    }
  }

  return report;
}

function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatSavingsReport(report: SavingsReport): string {
  const lines: string[] = [];
  lines.push('Retrieval vs a typical agent tree scan (workspace Glob + Grep -C2 + read 12 matching files).');
  lines.push(
    `Token estimate: 4 chars/token. Price: $${report.ratePerMillion}/million input tokens. Compounding: ${report.turns}-turn chat.`
  );
  lines.push('');

  if (report.benchmark) {
    const b = report.benchmark;
    lines.push(`Benchmark (${b.ranAt.slice(0, 10)}, ${b.queries} queries):`);
    lines.push(
      `  Naive dump ${formatTokens(b.avgNaiveTokens)} tok  vs  index ${formatTokens(b.avgSearchTokens)} tok  →  ${formatTokens(b.avgSavedTokens)} tok saved/turn (${b.avgPctSaved}%)`
    );
    lines.push(
      `  Tool wall-clock: Grep ${b.avgGrepMs}ms, get_task_context ~${b.avgSearchMs}ms (includes embedding the query). The $ savings is model input, not disk I/O.`
    );
    for (const repo of b.repos) {
      lines.push(
        `  ${repo.name}: ${formatTokens(repo.avgSavedTokens)} tok/turn (${repo.avgPctSaved}%) across ${repo.filesListed} files`
      );
    }
    const usdTurn = dollarsForTokens(b.avgSavedTokens, report.ratePerMillion);
    const usdChat = usdTurn * report.turns;
    lines.push(
      `  At $${report.ratePerMillion}/M: ${formatUsd(usdTurn)}/discovery turn, ${formatUsd(usdChat)}/${report.turns}-turn chat if the dump would have stayed in context.`
    );
    lines.push('');
  }

  lines.push('Live usage (MCP searches + blocked tree scans):');
  if (report.searches === 0 && report.deniedScans === 0) {
    lines.push('  No events yet. Use the MCP tools in Cursor, then re-run this command.');
    lines.push('  Blocked workspace Grep/Glob is counted when cursor-install hooks are active.');
  } else {
    lines.push(`  MCP retrievals:     ${report.searches}`);
    lines.push(`  Blocked tree scans: ${report.deniedScans}`);
    lines.push(`  Tokens returned:    ${formatTokens(report.resultTokens)}`);
    lines.push(`  Estimated naive:    ${formatTokens(report.baselineTokens)}`);
    lines.push(`  Saved this session: ${formatTokens(report.tokensSavedPerTurn)} tok  (${formatUsd(report.usdSavedPerTurn)})`);
    lines.push(
      `  If those dumps stayed ${report.turns} turns: ${formatTokens(report.tokensSavedCompounded)} tok  (${formatUsd(report.usdSavedCompounded)})`
    );
  }
  return lines.join('\n');
}
