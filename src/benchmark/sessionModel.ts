/**
 * Deterministic cost model for a whole agent session, not just one tool reply.
 *
 * Every model call re-reads the resident context (system prompt, tools, and
 * every earlier tool result), so an extra turn costs far more than the tokens
 * it returns. With prompt caching the re-read is billed at a fraction of the
 * input price, while newly appended tokens are written to the cache at a
 * premium and output is billed at a multiple. Costs are reported in
 * input-token equivalents so they compare across models and prices.
 */

export interface SessionCostParams {
  /** System prompt, tool definitions, and the user prompt, resident before the first call. */
  baseContextTokens: number;
  /** Model output per tool-calling turn: the calls themselves plus brief reasoning. */
  outputTokensPerToolTurn: number;
  /** The final answer. */
  answerTokens: number;
  /** Tool calls an agent issues in parallel in one turn. */
  callsPerTurn: number;
  /**
   * Result size of one follow-up search (a symbol/semantic search or an extra
   * grep) that an agent needs to locate a file it has not seen yet.
   */
  searchResultTokens: number;
  /** Prices relative to uncached input (Anthropic list prices: read 0.1x, 5-minute write 1.25x, output 5x). */
  cacheReadMultiplier: number;
  cacheWriteMultiplier: number;
  outputMultiplier: number;
}

export const DEFAULT_SESSION_PARAMS: SessionCostParams = {
  baseContextTokens: 6_000,
  outputTokensPerToolTurn: 150,
  answerTokens: 700,
  callsPerTurn: 3,
  searchResultTokens: 1_500,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
  outputMultiplier: 5
};

export interface SessionCost {
  /** Model calls, including the final answer. */
  modelCalls: number;
  toolCalls: number;
  /** Tokens returned by tools, i.e. repository context the agent took in. */
  repoContextTokens: number;
  /** Input processed across all model calls (resident context re-read each time). */
  inputTokens: number;
  outputTokens: number;
  /** Input-token equivalents without prompt caching. */
  costUncached: number;
  /** Input-token equivalents with prompt caching. */
  costCached: number;
}

/** Group tool results into turns of `callsPerTurn` parallel calls. */
export function groupIntoTurns(results: number[], callsPerTurn = DEFAULT_SESSION_PARAMS.callsPerTurn): number[][] {
  const turns: number[][] = [];
  const size = Math.max(1, callsPerTurn);
  for (let i = 0; i < results.length; i += size) turns.push(results.slice(i, i + size));
  return turns;
}

/**
 * Cost of a session whose model calls return the given tool results, followed
 * by one final answer. `turns[i]` holds the token sizes of the tool results
 * produced by the calls made in model call i.
 */
export function simulateSession(turns: number[][], params: SessionCostParams = DEFAULT_SESSION_PARAMS): SessionCost {
  let resident = params.baseContextTokens;
  let cached = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUncached = 0;
  let costCached = 0;
  let repoContextTokens = 0;
  let toolCalls = 0;

  for (let call = 0; call <= turns.length; call++) {
    const final = call === turns.length;
    const output = final ? params.answerTokens : params.outputTokensPerToolTurn;
    inputTokens += resident;
    outputTokens += output;
    costUncached += resident + params.outputMultiplier * output;
    costCached +=
      params.cacheReadMultiplier * cached +
      params.cacheWriteMultiplier * (resident - cached) +
      params.outputMultiplier * output;
    cached = resident;
    if (final) break;
    const results = turns[call] ?? [];
    const added = results.reduce((sum, tokens) => sum + tokens, 0);
    toolCalls += results.length;
    repoContextTokens += added;
    resident += output + added;
  }

  return {
    modelCalls: turns.length + 1,
    toolCalls,
    repoContextTokens,
    inputTokens,
    outputTokens,
    costUncached: Math.round(costUncached),
    costCached: Math.round(costCached)
  };
}
