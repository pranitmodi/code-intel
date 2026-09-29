import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextCalls, renderTaskContext, renderTaskContextReply, replyFormat, replyTokenCap } from '../../src/mcp/render.js';
import { parseRangeRef, readFileRanges, renderFileRanges } from '../../src/search/getFileContext.js';
import type { ContextPackage } from '../../src/retrieval/types.js';

const score = { total: 0.9, semantic: 0.6, keyword: 0.4, symbol: 1, path: 0, structural: 0.7, dependency: 0, reference: 0, test: 0, recency: 0.2 };

function pkg(overrides: Partial<ContextPackage> = {}): ContextPackage {
  return {
    query: 'q',
    summary: '',
    files: [
      {
        path: 'src/a.ts',
        reason: 'exact symbol match: a',
        score,
        chunks: [{ symbol: 'a', startLine: 1, endLine: 3, content: 'export function a() {   \n  return "x";\n}' }]
      },
      { path: 'src/b.ts', reason: 'semantic similarity', score: { ...score, total: 0.5 }, chunks: [{ startLine: 4, endLine: 5, content: 'const b = 2;' }] }
    ],
    estimatedTokens: 20,
    retrievalStats: { candidatesConsidered: 10, candidatesSelected: 2, expansionHops: 0 },
    confidence: { score: 0.9, reason: 'Top results exceeded the confidence threshold.' },
    ...overrides
  };
}

describe('renderTaskContext', () => {
  it('sends raw code blocks with no absolute path, scores, or trailing whitespace', () => {
    const text = renderTaskContext(pkg(), { repoName: 'repo' });
    expect(text.startsWith('repo · confidence 0.9 · ~')).toBe(true);
    expect(text).toContain('### [1] src/a.ts:1-3 a\nexport function a() {\n  return "x";\n}');
    expect(text).toContain('### [2] src/b.ts:4-5\nconst b = 2;');
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('0.912');
  });

  it('is smaller than the JSON payload for the same content', () => {
    const repoRoot = '/Users/someone/code/repo';
    expect(renderTaskContextReply(repoRoot, pkg(), 'text').length).toBeLessThan(renderTaskContextReply(repoRoot, pkg(), 'json').length);
  });

  it('is deterministic', () => {
    expect(renderTaskContext(pkg(), { repoName: 'repo' })).toBe(renderTaskContext(pkg(), { repoName: 'repo' }));
  });

  it('lists coverage per part with block references and exact next calls when incomplete', () => {
    const text = renderTaskContext(
      pkg({
        complete: false,
        facets: [
          { facetId: 'f0', label: 'first part', kind: 'concept', weight: 0.5, status: 'covered', strength: 0.9, evidence: [{ path: 'src/a.ts', startLine: 1, endLine: 3 }] },
          { facetId: 'f1', label: 'second part', kind: 'concept', weight: 0.3, status: 'weak', strength: 0.4, evidence: [] },
          { facetId: 'f2', label: 'third part', kind: 'concept', weight: 0.2, status: 'missing', strength: 0, evidence: [] }
        ],
        followUps: [{ facetId: 'f1', label: 'second part', path: 'src/c.ts', startLine: 10, endLine: 40, estimatedTokens: 300 }]
      }),
      { repoName: 'repo' }
    );
    expect(text).toContain('incomplete 1/3 parts covered');
    expect(text).toContain('covered  first part  [1]');
    expect(text).toContain('missing  third part');
    expect(text).toContain('Next (2 calls, ~');
    expect(text).toContain('get_file_context {"ranges":["src/c.ts:10-40"]}');
    expect(text).toContain('search_codebase {"query":"third part","limit":3}');
  });

  it('suggests nothing once the reply is complete', () => {
    expect(nextCalls(pkg({ complete: true, facets: [] }))).toEqual([]);
  });

  it('caps replies below the client output limit when one is configured', () => {
    expect(replyTokenCap({})).toBeUndefined();
    expect(replyTokenCap({ CODE_INTEL_MAX_REPLY_TOKENS: '4000' })).toBe(4000);
    expect(replyTokenCap({ MAX_MCP_OUTPUT_TOKENS: '10000' })).toBe(8000);
  });

  it('defaults to text and honours CODE_INTEL_MCP_FORMAT=json', () => {
    expect(replyFormat({})).toBe('text');
    expect(replyFormat({ CODE_INTEL_MCP_FORMAT: 'json' })).toBe('json');
  });
});

describe('file ranges', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-ranges-'));
    await writeFile(join(repoRoot, 'long.ts'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
    await writeFile(join(repoRoot, '.env'), 'SECRET=1');
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('parses path:start-end, path:line, and bare paths', () => {
    expect(parseRangeRef('src/a.ts:10-20')).toEqual({ file: 'src/a.ts', startLine: 10, endLine: 20 });
    expect(parseRangeRef('src/a.ts:7')).toEqual({ file: 'src/a.ts', startLine: 7, endLine: 7 });
    expect(parseRangeRef('src/a.ts')).toEqual({ file: 'src/a.ts' });
  });

  it('reads several ranges in one call and caps long ones with a pointer to the rest', async () => {
    const results = await readFileRanges(repoRoot, [parseRangeRef('long.ts:2-3'), parseRangeRef('long.ts')], { maxLinesPerRange: 10 });
    const text = renderFileRanges(results);
    expect(text).toContain('### long.ts:2-3 (of 50 lines)\nline 2\nline 3');
    expect(text).toContain('### long.ts:1-10 (of 50 lines)');
    expect(text).toContain('(40 more lines below: long.ts:11-50)');
  });

  it('reports a range past the end of the file instead of returning other lines', async () => {
    const [result] = await readFileRanges(repoRoot, [parseRangeRef('long.ts:500-520')]);
    expect(result?.error).toMatch(/past the end of the file \(50 lines\)/);
  });

  it('fails a bad entry without failing the call', async () => {
    const results = await readFileRanges(repoRoot, [parseRangeRef('.env'), parseRangeRef('long.ts:1-1')]);
    expect(results[0]?.error).toMatch(/secrets/);
    expect(results[1]?.content).toBe('line 1');
  });

  it('stops at the per-call line budget', async () => {
    const results = await readFileRanges(repoRoot, [parseRangeRef('long.ts:1-30'), parseRangeRef('long.ts:31-50')], {
      maxLinesPerRange: 100,
      maxLinesTotal: 30
    });
    expect(results[0]?.omittedLines).toBe(0);
    expect(renderFileRanges(results)).toContain('long.ts:31-50 not sent');
  });
});
