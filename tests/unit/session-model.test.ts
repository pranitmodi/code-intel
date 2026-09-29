import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_PARAMS, groupIntoTurns, simulateSession } from '../../src/benchmark/sessionModel.js';

const params = { ...DEFAULT_SESSION_PARAMS, baseContextTokens: 1_000, outputTokensPerToolTurn: 100, answerTokens: 500 };

describe('simulateSession', () => {
  it('re-reads the resident context on every model call', () => {
    const cost = simulateSession([[2_000]], params);
    // call 1 reads 1,000; call 2 (answer) reads 1,000 + 100 output + 2,000 result.
    expect(cost.modelCalls).toBe(2);
    expect(cost.toolCalls).toBe(1);
    expect(cost.repoContextTokens).toBe(2_000);
    expect(cost.inputTokens).toBe(1_000 + 3_100);
    expect(cost.outputTokens).toBe(600);
    expect(cost.costUncached).toBe(4_100 + 5 * 600);
    // cached: first call writes 1,000; second reads 1,000 and writes 2,100.
    expect(cost.costCached).toBe(Math.round(1.25 * 1_000 + 0.1 * 1_000 + 1.25 * 2_100 + 5 * 600));
  });

  it('charges an extra turn more than the tokens it returns', () => {
    const oneTurn = simulateSession([[3_000]], params);
    const twoTurns = simulateSession([[1_500], [1_500]], params);
    expect(twoTurns.repoContextTokens).toBe(oneTurn.repoContextTokens);
    expect(twoTurns.costCached).toBeGreaterThan(oneTurn.costCached);
    expect(twoTurns.costUncached).toBeGreaterThan(oneTurn.costUncached);
  });

  it('prices a session with no tool calls as a single answer', () => {
    const cost = simulateSession([], params);
    expect(cost.modelCalls).toBe(1);
    expect(cost.repoContextTokens).toBe(0);
  });
});

describe('groupIntoTurns', () => {
  it('batches parallel calls per turn', () => {
    expect(groupIntoTurns([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(groupIntoTurns([], 3)).toEqual([]);
  });
});
