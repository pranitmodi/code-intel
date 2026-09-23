import { basename } from 'node:path';
import type { AppContext } from '../context.js';
import { findReferences } from '../search/findReferences.js';
import { searchSymbol } from '../search/searchSymbol.js';
import { estimateTokensFromText } from '../utils/tokens.js';
import type { ChunkSearchResult } from '../vector-store/schema.js';
import type { LanceVectorStore } from '../vector-store/LanceVectorStore.js';
import { grantFilesystemFallback } from './fallback.js';
import { hybridSearch } from './hybrid.js';
import { analyzeQuery } from './intent.js';
import { confidenceFor } from './confidence.js';
import { candidateImportPaths, loadTsPathAliases } from './resolveImport.js';
import { candidateFromRecord, EXACT_SYMBOL_FLOOR, pathScore } from './score.js';
import { mergeCandidates, selectCandidates } from './select.js';
import type {
  ContextMode,
  ContextPackage,
  RetrievalCandidate,
  RetrievalConfidence,
  RetrievalTrace
} from './types.js';

const MODE_LIMITS: Record<ContextMode, { chunks: number; tokens: number; perFile: number; perSymbol: number }> = {
  minimal: { chunks: 5, tokens: 5000, perFile: 2, perSymbol: 1 },
  normal: { chunks: 8, tokens: 8000, perFile: 2, perSymbol: 2 },
  deep: { chunks: 24, tokens: 25_000, perFile: 6, perSymbol: 4 }
};

const CONFIG_STEM = /^(defaults?|configs?|settings?)$/;
/** "Where is X implemented?" — once X is found exactly, its definition is the answer. */
const DEFINITION_LOOKUP = /^\s*(?:where\b|which (?:file|module|function|class)\b|locate\b|find (?:the )?(?:definition|implementation)\b)/i;
const USAGE_LOOKUP = /\b(?:tests?|specs?|usages?|used|references?|callers?|called|calls)\b/i;
/** A drop this large between consecutive non-exact scores separates matches from noise. */
const SCORE_GAP = 0.15;
const MIN_ORGANIC_KEPT = 2;

/**
 * Lowest score a non-exact chunk may have. Similarity scores are compressed
 * (relevant and unrelated chunks often differ by a few hundredths), so the
 * cut is made only at a clear drop, never at a fixed ratio.
 */
export function minOrganicScore(ranked: RetrievalCandidate[], task: string): number {
  if (
    DEFINITION_LOOKUP.test(task) &&
    !USAGE_LOOKUP.test(task) &&
    ranked.some((candidate) => (candidate.exactFloor ?? 0) >= EXACT_SYMBOL_FLOOR)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const organic = ranked.filter((candidate) => !candidate.exactFloor).map((candidate) => candidate.score.total);
  for (let index = MIN_ORGANIC_KEPT; index < organic.length; index++) {
    if (organic[index - 1]! - organic[index]! >= SCORE_GAP) return organic[index - 1]!;
  }
  return 0;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function fileStem(filePath: string): string {
  return basename(filePath).replace(/\.[^.]+$/, '');
}

const CHUNK_COLUMNS = [
  'id',
  'file_path',
  'symbol_name',
  'symbol_type',
  'parent_symbol',
  'start_line',
  'end_line',
  'content',
  'last_indexed_at',
  'extra_metadata'
];

async function queryFilesLike(
  vectorStore: LanceVectorStore,
  pattern: string,
  limit: number
): Promise<ChunkSearchResult[]> {
  return vectorStore.queryAll(
    CHUNK_COLUMNS,
    `file_path LIKE '%${escapeSqlString(pattern)}%'`,
    limit
  );
}

/** Files literally named `<stem>.<ext>` (singular or plural stem), so "default" skips default-ignore.ts. */
async function queryFilesWithStem(
  vectorStore: LanceVectorStore,
  stem: string,
  limit: number
): Promise<ChunkSearchResult[]> {
  const singular = stem.toLowerCase().replace(/s$/, '');
  const clauses = [singular, `${singular}s`].flatMap((name) => {
    const s = escapeSqlString(name);
    return [`file_path LIKE '%/${s}.%'`, `file_path LIKE '${s}.%'`];
  });
  const rows = await vectorStore.queryAll(CHUNK_COLUMNS, `(${clauses.join(' OR ')})`, limit * 4);
  return rows
    .filter((row) => fileStem(row.file_path).toLowerCase().replace(/s$/, '') === singular)
    .slice(0, limit);
}

async function queryFilesExact(
  vectorStore: LanceVectorStore,
  paths: string[],
  limit: number
): Promise<ChunkSearchResult[]> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return [];
  const list = unique.map((path) => `'${escapeSqlString(path)}'`).join(', ');
  return vectorStore.queryAll(CHUNK_COLUMNS, `file_path IN (${list})`, limit);
}

async function queryFilesLikeTestStem(
  vectorStore: LanceVectorStore,
  stem: string,
  limit: number
): Promise<ChunkSearchResult[]> {
  const s = escapeSqlString(stem);
  return vectorStore.queryAll(
    CHUNK_COLUMNS,
    `(file_path LIKE '%/${s}.test.%' OR file_path LIKE '${s}.test.%' OR file_path LIKE '%/${s}.spec.%' OR file_path LIKE '${s}.spec.%')`,
    limit
  );
}

function addCandidate(
  map: Map<string, RetrievalCandidate>,
  incoming: RetrievalCandidate
): void {
  const existing = map.get(incoming.id);
  map.set(incoming.id, existing ? mergeCandidates(existing, incoming) : incoming);
}

function packageFromSelected(
  query: string,
  selected: RetrievalCandidate[],
  considered: number,
  hops: number,
  confidence: RetrievalConfidence,
  relationships: ContextPackage['relationships'],
  trace?: RetrievalTrace
): ContextPackage {
  const byFile = new Map<string, RetrievalCandidate[]>();
  for (const candidate of selected) {
    const list = byFile.get(candidate.file) ?? [];
    list.push(candidate);
    byFile.set(candidate.file, list);
  }

  const files = [...byFile.entries()]
    .map(([path, chunks]) => {
      const rankedChunks = [...chunks].sort((a, b) => b.score.total - a.score.total);
      const best = rankedChunks[0]!;
      return {
        path,
        reason: best.reason,
        score: best.score,
        chunks: rankedChunks.map((chunk) => ({
          symbol: chunk.symbol ?? undefined,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content
        }))
      };
    })
    .sort((a, b) => b.score.total - a.score.total || a.path.localeCompare(b.path));

  const estimatedTokens = estimateTokensFromText(JSON.stringify({ files: files.map((f) => ({ path: f.path, chunks: f.chunks })) }));

  return {
    query,
    summary: `Retrieved ${selected.length} chunk(s) across ${files.length} file(s) for: ${query.slice(0, 120)}`,
    files,
    relationships,
    estimatedTokens,
    retrievalStats: {
      candidatesConsidered: considered,
      candidatesSelected: selected.length,
      expansionHops: hops
    },
    confidence,
    trace
  };
}

export interface TaskContextOptions {
  maxTokens?: number;
  mode?: ContextMode;
  stale?: boolean | null;
}

export async function getTaskContext(
  task: string,
  app: AppContext,
  options: TaskContextOptions = {}
): Promise<ContextPackage> {
  const intent = analyzeQuery(task, options.mode);
  const mode = intent.requestedContext;
  const caps = MODE_LIMITS[mode];
  const retrieval = app.config.retrieval;
  const maxTokens = options.maxTokens ?? Math.min(retrieval.maxContextTokens, caps.tokens);
  const seedLimit = Math.min(retrieval.seedResults, caps.chunks);
  const queryLower = task.toLowerCase();
  const started = Date.now();
  const aliases = loadTsPathAliases(app.repoRoot);

  const seed = await hybridSearch(task, app.vectorStore, app.embeddingProvider, app.config.search, {
    limit: seedLimit,
    maxTokens,
    maxChunksPerFile: caps.perFile,
    maxChunksPerSymbol: caps.perSymbol
  });

  const merged = new Map<string, RetrievalCandidate>();
  for (const candidate of seed.allCandidates) addCandidate(merged, candidate);

  for (const symbol of intent.symbols.slice(0, 8)) {
    const matches = await searchSymbol(symbol, app.vectorStore, 8);
    let foundExactSymbol = false;
    if (matches.length > 0) {
      const rows = await app.vectorStore.queryAll(
        CHUNK_COLUMNS,
        `symbol_name = '${escapeSqlString(symbol)}'`,
        8
      );
      foundExactSymbol = rows.length > 0;
      for (const record of rows) {
        addCandidate(
          merged,
          candidateFromRecord(
            record,
            { semantic: 0, keyword: 0.8, symbol: 1, sources: ['symbol'], reason: `symbol ${symbol}` },
            app.config.search,
            queryLower
          )
        );
      }
    }

    if (!foundExactSymbol) {
      const lexical = await app.vectorStore.fullTextSearch(symbol, 12).catch(() => []);
      const maxScore = Math.max(...lexical.map((row) => row._score ?? 0), 1e-9);
      for (const record of lexical) {
        addCandidate(
          merged,
          candidateFromRecord(
            record,
            {
              semantic: 0,
              keyword: Math.min(1, Math.max(0, (record._score ?? 0) / maxScore)),
              exactIdentifier: true,
              sources: ['keyword'],
              reason: `exact identifier occurrence: ${symbol}`
            },
            app.config.search,
            queryLower
          )
        );
      }
    }
  }

  const pathTerms = intent.files
    .map((file) => file.replaceAll('\\', '/').split('/').pop() ?? file)
    .slice(0, 8);
  const configStems = intent.operations.includes('find_config')
    ? intent.concepts.filter((concept) => CONFIG_STEM.test(concept))
    : [];
  for (const term of [...new Set([...pathTerms, ...configStems])]) {
    const rows = pathTerms.includes(term)
      ? await queryFilesLike(app.vectorStore, term, 4)
      : await queryFilesWithStem(app.vectorStore, term, 4);
    for (const record of rows) {
      addCandidate(
        merged,
        candidateFromRecord(
          record,
          {
            semantic: 0,
            keyword: 0.8,
            path: 1,
            sources: ['keyword'],
            reason: `file path match: ${term}`
          },
          app.config.search,
          queryLower
        )
      );
    }
  }

  for (const term of [...new Set(intent.concepts.filter((concept) => concept.length >= 5))].slice(0, 8)) {
    const rows = await queryFilesLike(app.vectorStore, term, 6);
    for (const record of rows) {
      const measuredPathScore = pathScore(record.file_path, queryLower);
      if (measuredPathScore < 0.25) continue;
      addCandidate(
        merged,
        candidateFromRecord(
          record,
          {
            semantic: 0,
            keyword: 0.6,
            path: measuredPathScore,
            sources: ['keyword'],
            reason: `multi-token file path match: ${record.file_path}`
          },
          app.config.search,
          queryLower
        )
      );
    }
  }

  const relationships: NonNullable<ContextPackage['relationships']> = [];
  let hops = 0;
  const maxHops = retrieval.maxExpansionHops;
  const rankedSeeds = [...merged.values()].sort((a, b) => b.score.total - a.score.total);
  let frontier = selectCandidates(rankedSeeds, {
    limit: seedLimit,
    maxTokens,
    maxChunksPerFile: caps.perFile,
    maxChunksPerSymbol: caps.perSymbol
  }).selected;

  while (hops < maxHops && frontier.length > 0) {
    hops += 1;
    const next: RetrievalCandidate[] = [];
    for (const seedChunk of frontier) {
      const importSpecs = seedChunk.extra.imports.filter((imp) => imp.startsWith('.') || !imp.startsWith('http'));
      for (const imp of importSpecs.slice(0, 8)) {
        const paths = candidateImportPaths(seedChunk.file, imp, aliases);
        if (paths.length === 0) continue;
        const rows = await queryFilesExact(app.vectorStore, paths, 8);
        for (const record of rows) {
          const candidate = candidateFromRecord(
            record,
            {
              semantic: 0,
              keyword: 0.2,
              dependency: 1,
              sources: ['expansion'],
              reason: `import of ${imp}`
            },
            app.config.search,
            queryLower
          );
          addCandidate(merged, candidate);
          next.push(candidate);
          relationships.push({
            from: seedChunk.file,
            to: record.file_path,
            type: 'imports'
          });
        }
      }

      if (intent.operations.includes('find_references') && seedChunk.symbol) {
        const refs = await findReferences(seedChunk.symbol.split('.').pop() ?? seedChunk.symbol, app.vectorStore, 12);
        for (const ref of refs.slice(0, 8)) {
          const rows = await queryFilesExact(app.vectorStore, [ref.file], 4);
          for (const record of rows) {
            const candidate = candidateFromRecord(
              record,
              {
                semantic: 0,
                keyword: 0.2,
                reference: 1,
                sources: ['expansion'],
                reason: `reference to ${seedChunk.symbol}`
              },
              app.config.search,
              queryLower
            );
            addCandidate(merged, candidate);
            next.push(candidate);
            relationships.push({
              from: seedChunk.file,
              to: record.file_path,
              type: 'references'
            });
          }
        }
      }

      if (intent.operations.includes('find_tests')) {
        const stem = fileStem(seedChunk.file);
        const rows = await queryFilesLikeTestStem(app.vectorStore, stem, 4);
        for (const record of rows) {
          const candidate = candidateFromRecord(
            record,
            {
              semantic: 0,
              keyword: 0.3,
              sources: ['expansion'],
              reason: `tests for ${stem}`
            },
            app.config.search,
            queryLower
          );
          addCandidate(merged, candidate);
          next.push(candidate);
          relationships.push({ from: seedChunk.file, to: record.file_path, type: 'tests' });
        }
      }
    }

    if (intent.operations.includes('find_config') && hops === 1) {
      const configs = await app.vectorStore.queryAll(
        CHUNK_COLUMNS,
        `extra_metadata LIKE '%"isConfig":true%'`,
        8
      );
      for (const record of configs) {
        addCandidate(
          merged,
          candidateFromRecord(
            record,
            { semantic: 0, keyword: 0.4, sources: ['expansion'], reason: 'configuration file' },
            app.config.search,
            queryLower
          )
        );
      }
    }

    frontier = next.filter((c) => c.score.total >= retrieval.confidenceThreshold).slice(0, seedLimit);
  }

  const all = [...merged.values()].sort((a, b) => b.score.total - a.score.total);
  const packed = selectCandidates(all, {
    limit: Math.min(retrieval.maxContextChunks, caps.chunks),
    maxTokens,
    minOrganicScore: minOrganicScore(all, task),
    maxChunksPerFile: caps.perFile,
    maxChunksPerSymbol: caps.perSymbol,
    maxExpansionOnlyFilesInTopK: 3,
    expansionTopK: 5
  });

  const confidence = confidenceFor(packed.selected, retrieval.confidenceThreshold, {
    stale: options.stale,
    query: task
  });
  if (
    app.config.retrieval.allowFallbackAfterFailedRetrieval &&
    confidence.score < retrieval.confidenceThreshold
  ) {
    grantFilesystemFallback(app.config.database.path, confidence.reason, app.repoRoot);
  }

  const uniqueRels = relationships.filter(
    (rel, index, arr) => arr.findIndex((r) => r.from === rel.from && r.to === rel.to && r.type === rel.type) === index
  );

  const trace: RetrievalTrace = {
    query: task,
    candidateCount: all.length,
    selectedCount: packed.selected.length,
    discarded: packed.discarded,
    estimatedTokens: packed.estimatedTokens,
    latencyMs: Date.now() - started,
    expansionHops: hops
  };

  return packageFromSelected(task, packed.selected, all.length, hops, confidence, uniqueRels, trace);
}

export function formatContextPackage(pkg: ContextPackage, explain = false): string {
  const lines: string[] = [];
  lines.push(pkg.summary);
  lines.push(`Estimated tokens: ${pkg.estimatedTokens}`);
  lines.push(`Confidence: ${pkg.confidence.score} (${pkg.confidence.reason})`);
  lines.push('');
  for (const file of pkg.files) {
    lines.push(`${file.path} — ${file.reason} (score ${file.score.total})`);
    for (const chunk of file.chunks) {
      const symbol = chunk.symbol ? ` ${chunk.symbol}` : '';
      lines.push(`  L${chunk.startLine}-${chunk.endLine}${symbol}`);
    }
  }
  if (explain && pkg.trace) {
    lines.push('');
    lines.push(`Candidates considered: ${pkg.trace.candidateCount}`);
    lines.push(`Expansion hops: ${pkg.trace.expansionHops}`);
    lines.push(`Latency: ${pkg.trace.latencyMs}ms`);
  }
  return lines.join('\n');
}

/** Used by tests that only need packaging, not a live index. */
export function buildContextPackageForTest(
  query: string,
  selected: RetrievalCandidate[],
  considered: number,
  hops: number,
  confidence: RetrievalConfidence
): ContextPackage {
  return packageFromSelected(query, selected, considered, hops, confidence, []);
}
