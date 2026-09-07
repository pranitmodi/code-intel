import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateNaiveDiscoveryTokens } from '../../src/usage/heuristic.js';
import { recordDeniedScan, recordMcpRetrieval } from '../../src/usage/record.js';
import { dollarsForTokens, formatSavingsReport, summarizeUsage } from '../../src/usage/report.js';
import { readUsageEvents } from '../../src/usage/store.js';
import { estimateTokensFromChars, estimateTokensFromText } from '../../src/utils/tokens.js';

const prevDb = process.env.CODE_INTEL_DB_PATH;

describe('token estimate', () => {
  it('uses 4 chars per token, rounding up', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromText('abcd')).toBe(1);
  });
});

describe('naive discovery heuristic', () => {
  it('grows with indexed file count but stays capped', () => {
    expect(estimateNaiveDiscoveryTokens(74)).toBeGreaterThan(5_000);
    expect(estimateNaiveDiscoveryTokens(74)).toBeLessThan(30_000);
    expect(estimateNaiveDiscoveryTokens(514)).toBeGreaterThan(30_000);
    expect(estimateNaiveDiscoveryTokens(10_000)).toBeLessThanOrEqual(93_000);
  });
});

describe('usage report', () => {
  it('subtracts returned tokens from the naive baseline and compounds turns', () => {
    const report = summarizeUsage(
      [
        {
          ts: '2026-09-07T00:00:00.000Z',
          kind: 'mcp_retrieval',
          tool: 'search_codebase',
          resultTokens: 1200,
          baselineTokens: 40_000
        },
        {
          ts: '2026-09-07T00:00:01.000Z',
          kind: 'denied_scan',
          tool: 'Grep',
          resultTokens: 0,
          baselineTokens: 40_000
        }
      ],
      { ratePerMillion: 3, turns: 15 }
    );
    expect(report.searches).toBe(1);
    expect(report.deniedScans).toBe(1);
    expect(report.tokensSavedPerTurn).toBe(38_800);
    expect(report.tokensSavedCompounded).toBe(38_800 * 15);
    expect(report.usdSavedPerTurn).toBeCloseTo(dollarsForTokens(38_800, 3));
    expect(formatSavingsReport(report)).toContain('Blocked tree scans: 1');
  });

  it('includes benchmark averages when present', () => {
    const report = summarizeUsage([], { ratePerMillion: 3, turns: 15 }, {
      ranAt: '2026-09-07T16:00:00.000Z',
      charsPerToken: 4,
      maxReadFiles: 12,
      searchTokenCap: 1200,
      repos: [
        {
          name: 'SavorApp',
          path: '/tmp/SavorApp',
          filesListed: 514,
          corpusTokens: 1000,
          globListMs: 10,
          globListTokens: 100,
          queries: [
            {
              query: 'login',
              grepKeyword: 'login',
              grepMs: 8,
              grepDumpTokens: 160,
              matchingFiles: 3,
              readTopFiles: 3,
              readTopFilesTokens: 2000,
              globListTokens: 100,
              naiveAgentTokens: 16_000,
              searchMs: 900,
              resultCount: 8,
              searchTokens: 2000,
              searchTokensCapped: 1200,
              tokensSavedPerTurn: 14_800,
              pctSaved: 92.5
            }
          ]
        }
      ]
    });
    expect(report.benchmark?.avgSavedTokens).toBe(14_800);
    expect(report.benchmark?.repos[0]?.name).toBe('SavorApp');
  });
});

describe('usage log', () => {
  let home: string;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    if (prevDb === undefined) delete process.env.CODE_INTEL_DB_PATH;
    else process.env.CODE_INTEL_DB_PATH = prevDb;
  });

  it('appends MCP and denied-scan events without throwing', () => {
    home = mkdtempSync(join(tmpdir(), 'code-intel-usage-'));
    process.env.CODE_INTEL_DB_PATH = home;
    recordMcpRetrieval({
      tool: 'search_codebase',
      repo: '/tmp/proj',
      payloadText: 'abcd',
      latencyMs: 12
    });
    recordDeniedScan({ tool_name: 'Grep', cwd: '/tmp/proj', workspace_roots: ['/tmp/proj'] });
    const events = readUsageEvents(home);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('mcp_retrieval');
    expect(events[0]?.resultTokens).toBe(1);
    expect(events[1]?.kind).toBe('denied_scan');
    expect(JSON.parse(readFileSync(join(home, 'usage.jsonl'), 'utf-8').trim().split('\n')[0] ?? '{}')).toMatchObject({
      tool: 'search_codebase'
    });
  });
});
