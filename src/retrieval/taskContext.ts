import { basename } from 'node:path';
import type { AppContext } from '../context.js';
import { findReferences } from '../search/findReferences.js';
import { estimateTokensFromText } from '../utils/tokens.js';
import type { ChunkSearchResult } from '../vector-store/schema.js';
import type { LanceVectorStore } from '../vector-store/LanceVectorStore.js';
import { grantFilesystemFallback } from './fallback.js';
import { coverageReport, facetRelevance, followUpsFor, selectWithCoverage, type FacetRanking } from './coverage.js';
import { planQuery, type QueryPlan } from './facets.js';
import { embedQueries, hybridSearch } from './hybrid.js';
import { analyzeQuery } from './intent.js';
import { confidenceFor } from './confidence.js';
import { candidateImportPaths, loadTsPathAliases } from './resolveImport.js';
import { isDocPath, isDocTask } from './docs.js';
import { matchPathTerms, specificStemWords } from './pathTerms.js';
import { candidateFromRecord, EXACT_SYMBOL_FLOOR, type QueryNaming } from './score.js';
import { compareCandidates, mergeCandidates, selectCandidates } from './select.js';
import type {
  ContextMode,
  ContextPackage,
  RetrievalCandidate,
  RetrievalConfidence,
  RetrievalTrace
} from './types.js';

interface ModeLimits {
  chunks: number;
  tokens: number;
  perFile: number;
  perSymbol: number;
}

const MODE_LIMITS: Record<ContextMode, ModeLimits> = {
  minimal: { chunks: 5, tokens: 5000, perFile: 2, perSymbol: 1 },
  normal: { chunks: 8, tokens: 8000, perFile: 2, perSymbol: 2 },
  deep: { chunks: 24, tokens: 25_000, perFile: 6, perSymbol: 4 }
};

/**
 * A request with several parts needs a file or two per part; eight chunks
 * cannot cover a nine-part question, and each missing part costs the agent a
 * follow-up turn. Same token budget, more (and so smaller) chunks.
 */
const MULTI_LIMITS: ModeLimits = { chunks: 12, tokens: 8000, perFile: 2, perSymbol: 2 };
const BROAD_LIMITS: ModeLimits = { chunks: 16, tokens: 8000, perFile: 2, perSymbol: 2 };
/** Results per facet from each retriever. */
const FACET_SEARCH_LIMIT = 16;
/** A missing facet this heavy means the agent must search on its own, so filesystem search is allowed. */
const MISSING_FACET_FALLBACK_WEIGHT = 0.08;

/** An identifier found in more files than this is shared vocabulary, not a pointer to one definition. */
const MAX_EXACT_TERM_FILES = 4;
/** Files per identifier that may rank as exact matches, so one term cannot fill the reply. */
const MAX_EXACT_FILES_PER_TERM = 2;

function limitsFor(mode: ContextMode, route: QueryPlan['route']): ModeLimits {
  if (mode !== 'normal' || route === 'focused') return MODE_LIMITS[mode];
  return route === 'broad' ? BROAD_LIMITS : MULTI_LIMITS;
}

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

/** Chunks of files whose name is exactly `fileName` (`mcp.json` finds `.vscode/mcp.json`, not `cursor.mcp.json`). */
async function queryFilesNamed(
  vectorStore: LanceVectorStore,
  fileName: string,
  limit: number
): Promise<ChunkSearchResult[]> {
  const name = escapeSqlString(fileName);
  return vectorStore.queryAll(CHUNK_COLUMNS, `(file_path = '${name}' OR file_path LIKE '%/${name}')`, limit);
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

/** `filePaths()` returns the same array until the table changes, so its stem counts are computed once per version. */
const specificStemCache = new WeakMap<string[], Set<string>>();
function cachedSpecificStems(filePaths: string[]): Set<string> {
  let stems = specificStemCache.get(filePaths);
  if (!stems) {
    stems = specificStemWords(filePaths);
    specificStemCache.set(filePaths, stems);
  }
  return stems;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `registerTool('get_task_context'`, `.command('vscode-install'`: the term as a call's first string argument. */
function registrationPattern(term: string): RegExp {
  return new RegExp(`\\(\\s*['"\`]${escapeRegExp(term)}(?:\\s[^'"\`]*)?['"\`]`);
}

/** Source text without line, block, and `#` comments (approximate: string contents are left alone). */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/^\s*#(?!!).*$/gm, '');
}

/** LIKE treats `%` and `_` as wildcards; escape them so `get_task_context` matches only itself. */
function escapeLikePattern(value: string): string {
  return escapeSqlString(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Chunks that contain `term` verbatim. Full-text search tokenises `vscode-install`,
 * `--repo`, or `CODE_INTEL_DB_PATH` into common words, so terms with separators
 * use a substring scan; single-token identifiers use full-text search.
 */
async function identifierOccurrences(vectorStore: LanceVectorStore, term: string): Promise<ChunkSearchResult[]> {
  if (/[-_.]/.test(term)) {
    return vectorStore.queryAll(CHUNK_COLUMNS, `content LIKE '%${escapeLikePattern(term)}%' ESCAPE '\\'`, 40).catch(() => []);
  }
  const rows = await vectorStore.fullTextSearch(term, 12).catch(() => [] as ChunkSearchResult[]);
  const lower = term.toLowerCase();
  return rows.filter((row) => row.content.toLowerCase().includes(lower));
}

/**
 * Chunks mentioning an identifier the query names but no symbol defines (a
 * config key, a CLI command, a tool name). Only a rare identifier is exact
 * evidence, and only its top files rank as exact matches.
 */
function addOccurrences(
  merged: Map<string, RetrievalCandidate>,
  rows: ChunkSearchResult[],
  term: string,
  app: AppContext,
  queryLower: string,
  naming: QueryNaming
): void {
  const perFile = new Map<string, number>();
  const registered = new Set<string>();
  const registration = registrationPattern(term);
  // A mention inside a comment is not the identifier in use.
  const inCode = rows.filter((row) => !isDocPath(row.file_path) && stripComments(row.content).includes(term));
  for (const row of inCode) {
    perFile.set(row.file_path, (perFile.get(row.file_path) ?? 0) + 1);
    if (registration.test(row.content)) registered.add(row.file_path);
  }
  const inCodeIds = new Set(inCode.map((row) => row.id));
  const rare = perFile.size > 0 && perFile.size <= MAX_EXACT_TERM_FILES;
  const ranked = [...perFile.entries()]
    .sort((a, b) => Number(registered.has(b[0])) - Number(registered.has(a[0])) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([file]) => file);
  // A string-named entity (CLI command, MCP tool, route) is defined where it is
  // registered, however many other files mention it.
  const exactFiles = new Set(
    ranked.filter((file) => rare || registered.has(file)).slice(0, MAX_EXACT_FILES_PER_TERM)
  );
  for (const record of rows) {
    addCandidate(
      merged,
      candidateFromRecord(
        record,
        {
          semantic: 0,
          keyword: 0.8,
          exactIdentifier: exactFiles.has(record.file_path) && inCodeIds.has(record.id),
          sources: ['keyword'],
          reason: `exact identifier occurrence: ${term}`
        },
        app.config.search,
        queryLower,
            naming
      )
    );
  }
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
      const rankedChunks = [...chunks].sort(compareCandidates);
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
  /** Path prefixes never returned, e.g. a benchmark's own dataset, which quotes every task verbatim. */
  excludePaths?: string[];
  /** Ceiling on the reply budget from the client's output limit; lowers but never raises the budget. */
  maxTokensCap?: number;
}

export async function getTaskContext(
  task: string,
  app: AppContext,
  options: TaskContextOptions = {}
): Promise<ContextPackage> {
  const intent = analyzeQuery(task, options.mode);
  const plan = planQuery(task, intent);
  const mode = intent.requestedContext;
  const caps = limitsFor(mode, plan.route);
  const retrieval = app.config.retrieval;
  const maxTokens = Math.min(
    options.maxTokens ?? Math.min(retrieval.maxContextTokens, caps.tokens),
    options.maxTokensCap ?? Number.POSITIVE_INFINITY
  );
  const seedLimit = Math.min(retrieval.seedResults, caps.chunks);
  const queryLower = task.toLowerCase();
  const started = Date.now();
  const aliases = loadTsPathAliases(app.repoRoot);

  const filePaths = await app.vectorStore.filePaths();
  const naming: QueryNaming = { specificStems: cachedSpecificStems(filePaths) };
  const multiFacet = plan.route !== 'focused';
  // One provider call embeds the whole task and every facet; the searches below hit the cache.
  const facetVectors = multiFacet
    ? (await embedQueries([task, ...plan.facets.map((facet) => (facet.auxiliary ? task : facet.embedText))], app.embeddingProvider)).slice(1)
    : [];

  const seed = await hybridSearch(task, app.vectorStore, app.embeddingProvider, app.config.search, {
    naming,
    limit: seedLimit,
    maxTokens,
    maxChunksPerFile: caps.perFile,
    maxChunksPerSymbol: caps.perSymbol
  });

  const merged = new Map<string, RetrievalCandidate>();
  for (const candidate of seed.allCandidates) addCandidate(merged, candidate);

  const exactTerms = new Set(intent.exactTerms);
  await Promise.all(
    intent.symbols.slice(0, 8).map(async (symbol) => {
      const rows = await app.vectorStore.queryAll(CHUNK_COLUMNS, `symbol_name = '${escapeSqlString(symbol)}'`, 8);
      for (const record of rows) {
        addCandidate(
          merged,
          candidateFromRecord(
            record,
            { semantic: 0, keyword: 0.8, symbol: 1, sources: ['symbol'], reason: `symbol ${symbol}` },
            app.config.search,
            queryLower,
            naming
          )
        );
      }
      // Only code-shaped tokens count as exact identifiers when no symbol defines
      // them; a capitalised prose word ("OpenAI") matches everything that mentions it.
      if (rows.length === 0 && exactTerms.has(symbol)) {
        addOccurrences(merged, await identifierOccurrences(app.vectorStore, symbol), symbol, app, queryLower, naming);
      }
    })
  );

  const symbolSet = new Set(intent.symbols);
  await Promise.all(
    intent.exactTerms
      .filter((term) => !symbolSet.has(term))
      .slice(0, 8)
      .map(async (term) => {
        addOccurrences(merged, await identifierOccurrences(app.vectorStore, term), term, app, queryLower, naming);
      })
  );

  const pathTerms = intent.files
    .map((file) => file.replaceAll('\\', '/').split('/').pop() ?? file)
    .slice(0, 8);
  const configStems = intent.operations.includes('find_config')
    ? intent.concepts.filter((concept) => CONFIG_STEM.test(concept))
    : [];
  for (const term of [...new Set([...pathTerms, ...configStems])]) {
    const rows = pathTerms.includes(term)
      ? await queryFilesNamed(app.vectorStore, term, 4)
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
          queryLower,
            naming
        )
      );
    }
  }

  // Each query word is matched against every indexed path on its own, so a long
  // prompt cannot dilute a word that names a directory or file ("vscode", "jsonc").
  const namingTerms = [
    ...intent.concepts,
    ...intent.exactTerms.flatMap((term) => term.split(/[-_]+/)).filter(Boolean)
  ];
  const pathHits = matchPathTerms(filePaths, namingTerms);
  if (pathHits.size > 0) {
    const rows = await queryFilesExact(app.vectorStore, [...pathHits.keys()], pathHits.size * 12);
    for (const record of rows) {
      const hit = pathHits.get(record.file_path);
      if (!hit) continue;
      addCandidate(
        merged,
        candidateFromRecord(
          record,
          {
            semantic: 0,
            keyword: 0.3 + 0.3 * hit.specificity,
            // Below 1: a word naming a directory or file part is not the query naming the file.
            path: 0.9 * hit.specificity,
            sources: ['keyword'],
            reason: `path names "${hit.term}"`
          },
          app.config.search,
          queryLower,
            naming
        )
      );
    }
  }

  const facetRankings: FacetRanking[] = multiFacet
    ? await retrieveFacets(plan, facetVectors, app, filePaths, naming, merged, seed.allCandidates)
    : [];

  const relationships: NonNullable<ContextPackage['relationships']> = [];
  let hops = 0;
  const maxHops = retrieval.maxExpansionHops;
  const excluded = (path: string): boolean => (options.excludePaths ?? []).some((prefix) => path.startsWith(prefix));
  const rankedSeeds = [...merged.values()].filter((candidate) => !excluded(candidate.file)).sort(compareCandidates);
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
            queryLower,
            naming
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
              queryLower,
            naming
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
            queryLower,
            naming
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
            queryLower,
            naming
          )
        );
      }
    }

    frontier = next.filter((c) => c.score.total >= retrieval.confidenceThreshold).slice(0, seedLimit);
  }

  const all = [...merged.values()].filter((candidate) => !excluded(candidate.file)).sort(compareCandidates);
  const selectOptions = {
    limit: Math.min(retrieval.maxContextChunks, caps.chunks),
    maxTokens,
    maxChunksPerFile: caps.perFile,
    maxChunksPerSymbol: caps.perSymbol
  };
  let packed: ReturnType<typeof selectCandidates>;
  let coverage: ReturnType<typeof coverageReport> | undefined;
  let followUps: NonNullable<ContextPackage['followUps']> = [];
  if (multiFacet) {
    const relevance = facetRelevance(all, plan.facets, facetRankings, {
      wantsDocs: isDocTask(task),
      wantsTests: intent.operations.includes('find_tests')
    });
    packed = selectWithCoverage(all, plan.facets, relevance, selectOptions);
    coverage = coverageReport(packed.selected, plan.facets, relevance);
    followUps = followUpsFor(all, packed.selected, plan.facets, relevance, coverage.facets).map(({ facetId, label, candidate }) => ({
      facetId,
      label,
      path: candidate.file,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      estimatedTokens: candidate.estimatedTokens
    }));
  } else {
    packed = selectCandidates(all, {
      ...selectOptions,
      minOrganicScore: minOrganicScore(all, task),
      maxExpansionOnlyFilesInTopK: 3,
      expansionTopK: 5
    });
  }

  const confidence = coverage
    ? coverageConfidence(coverage, options.stale)
    : confidenceFor(packed.selected, retrieval.confidenceThreshold, { stale: options.stale, query: task });
  const heavyFacetMissing = Boolean(
    coverage?.facets.some((facet) => facet.status === 'missing' && facet.weight >= MISSING_FACET_FALLBACK_WEIGHT)
  );
  if (
    app.config.retrieval.allowFallbackAfterFailedRetrieval &&
    (confidence.score < retrieval.confidenceThreshold || heavyFacetMissing)
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

  const pkg = packageFromSelected(task, packed.selected, all.length, hops, confidence, uniqueRels, trace);
  return coverage
    ? { ...pkg, facets: coverage.facets, complete: coverage.complete, ...(followUps.length > 0 ? { followUps } : {}) }
    : pkg;
}

/** Confidence for a multi-part request: the weighted share of its parts the reply covers. */
function coverageConfidence(
  coverage: ReturnType<typeof coverageReport>,
  stale: boolean | null | undefined
): RetrievalConfidence {
  if (stale) return { score: 0.2, reason: 'Index is stale relative to the working tree.' };
  const missing = coverage.facets.filter((facet) => facet.status === 'missing').map((facet) => facet.label);
  const weak = coverage.facets.filter((facet) => facet.status === 'weak').map((facet) => facet.label);
  const covered = coverage.facets.length - missing.length - weak.length;
  if (coverage.complete) {
    return { score: coverage.score, reason: `Covers all ${coverage.facets.length} parts of the request.` };
  }
  const parts = [
    `Covers ${covered} of ${coverage.facets.length} parts`,
    ...(missing.length > 0 ? [`missing: ${missing.join('; ')}`] : []),
    ...(weak.length > 0 ? [`partial: ${weak.join('; ')}`] : [])
  ];
  return { score: coverage.score, reason: parts.join('. ') + '.' };
}

/**
 * Search each facet separately — semantic, keyword, and path — so a part of
 * the request that shares no words with the rest still finds its code. Every
 * hit joins the candidate pool; each facet's own ranking feeds its relevance.
 */
async function retrieveFacets(
  plan: QueryPlan,
  vectors: number[][],
  app: AppContext,
  filePaths: string[],
  naming: QueryNaming,
  merged: Map<string, RetrievalCandidate>,
  wholeTask: RetrievalCandidate[]
): Promise<FacetRanking[]> {
  const perFacet = await Promise.all(
    plan.facets.map(async (facet, f) => {
      if (facet.auxiliary) return { semantic: [], lexical: [], pathHits: new Map() };
      const vector = vectors[f] ?? [];
      const [semantic, lexical] = await Promise.all([
        vector.length > 0 ? app.vectorStore.vectorSearch(vector, FACET_SEARCH_LIMIT).catch(() => []) : [],
        facet.terms.length > 0
          ? app.vectorStore.fullTextSearch(facet.terms.join(' '), FACET_SEARCH_LIMIT).catch(() => [])
          : []
      ]);
      return { semantic, lexical, pathHits: matchPathTerms(filePaths, facet.terms) };
    })
  );

  const pathFiles = [...new Set(perFacet.flatMap((result) => [...result.pathHits.keys()]))];
  const pathRows = pathFiles.length > 0 ? await queryFilesExact(app.vectorStore, pathFiles, pathFiles.length * 12) : [];

  return plan.facets.map((facet, f) => {
    // The whole request keeps the ranking the whole-task search already produced.
    if (facet.auxiliary) return { ranks: new Map(wholeTask.map((candidate, rank) => [candidate.id, rank])) };
    const { semantic, lexical, pathHits } = perFacet[f]!;
    const facetQuery = facet.label.toLowerCase();
    const scored = new Map<string, RetrievalCandidate>();
    // The facet's own retrievers decide its ranking, not floored totals: a
    // floor ranks a named definition first overall, but says nothing about
    // whether it answers this particular part of the request.
    const signal = new Map<string, number>();
    const add = (candidate: RetrievalCandidate, strength: number): void => {
      const existing = scored.get(candidate.id);
      scored.set(candidate.id, existing ? mergeCandidates(existing, candidate) : candidate);
      signal.set(candidate.id, Math.max(signal.get(candidate.id) ?? 0, strength));
    };
    // Rank positions per channel, so similarity and BM25 scales never mix.
    semantic.forEach((record, rank) => {
      const similarity = Math.min(1, Math.max(0, 1 - (record._distance ?? 2) / 2));
      add(
        candidateFromRecord(
          record,
          { semantic: similarity, keyword: 0, sources: ['semantic'], reason: `semantic match for "${facet.label.slice(0, 40)}"` },
          app.config.search,
          facetQuery,
          naming
        ),
        1 / (1 + rank)
      );
    });
    const maxLexical = Math.max(...lexical.map((row) => row._score ?? 0), 1e-9);
    lexical.forEach((record, rank) => {
      add(
        candidateFromRecord(
          record,
          {
            semantic: 0,
            keyword: Math.min(1, (record._score ?? 0) / maxLexical),
            sources: ['keyword'],
            reason: `keyword match for "${facet.label.slice(0, 40)}"`
          },
          app.config.search,
          facetQuery,
          naming
        ),
        1 / (1 + rank)
      );
    });
    for (const record of pathRows) {
      const hit = pathHits.get(record.file_path);
      if (!hit) continue;
      add(
        candidateFromRecord(
          record,
          {
            semantic: 0,
            keyword: 0.3 + 0.3 * hit.specificity,
            path: 0.9 * hit.specificity,
            sources: ['keyword'],
            reason: `path names "${hit.term}"`
          },
          app.config.search,
          facetQuery,
          naming
        ),
        0.5 * hit.specificity
      );
    }
    const ranked = [...scored.values()].sort(
      (a, b) => (signal.get(b.id) ?? 0) - (signal.get(a.id) ?? 0) || compareCandidates(a, b)
    );
    for (const candidate of ranked) addCandidate(merged, candidate);
    return { ranks: new Map(ranked.map((candidate, rank) => [candidate.id, rank])) };
  });
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
