export type UsageKind = 'mcp_retrieval' | 'denied_scan';

export interface UsageEvent {
  ts: string;
  kind: UsageKind;
  tool: string;
  repo?: string;
  resultTokens: number;
  baselineTokens: number;
  latencyMs?: number;
}

export interface BenchmarkQuery {
  query: string;
  grepKeyword: string;
  grepMs: number;
  grepDumpTokens: number;
  matchingFiles: number;
  readTopFiles: number;
  readTopFilesTokens: number;
  globListTokens: number;
  naiveAgentTokens: number;
  searchMs: number;
  resultCount: number;
  searchTokens: number;
  searchTokensCapped: number;
  tokensSavedPerTurn: number;
  pctSaved: number;
}

export interface BenchmarkRepo {
  name: string;
  path: string;
  filesListed: number;
  corpusTokens: number;
  globListMs: number;
  globListTokens: number;
  queries: BenchmarkQuery[];
}

export interface BenchmarkFile {
  ranAt: string;
  charsPerToken: number;
  maxReadFiles: number;
  searchTokenCap: number;
  repos: BenchmarkRepo[];
}

export interface SavingsOptions {
  ratePerMillion: number;
  turns: number;
}

export interface SavingsReport {
  ratePerMillion: number;
  turns: number;
  searches: number;
  deniedScans: number;
  resultTokens: number;
  baselineTokens: number;
  tokensSavedPerTurn: number;
  tokensSavedCompounded: number;
  usdSavedPerTurn: number;
  usdSavedCompounded: number;
  benchmark?: {
    ranAt: string;
    queries: number;
    avgNaiveTokens: number;
    avgSearchTokens: number;
    avgSavedTokens: number;
    avgPctSaved: number;
    avgSearchMs: number;
    avgGrepMs: number;
    repos: { name: string; avgSavedTokens: number; avgPctSaved: number; filesListed: number }[];
  };
}
