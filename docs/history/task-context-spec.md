# code-intel: Next-Generation Agent Context Architecture

> Historical implementation specification for the task-context work introduced in v0.2.0. Some acceptance items are now implemented and some remain future work. See the maintained [architecture](../ARCHITECTURE.md), [benchmarks](../BENCHMARKS.md), and [changelog](../../CHANGELOG.md) for current behavior.

## Purpose

This document is the implementation specification for evolving `code-intel` from a local semantic code-search server into a **persistent context layer for AI coding agents**.

The current package already provides:

- Tree-sitter structural parsing and chunking
- Local Ollama or OpenAI-compatible embeddings
- Persistent LanceDB storage
- Incremental chunk-level indexing
- Hybrid semantic, keyword, and symbol search
- MCP tools
- File watching
- Cursor integration and search-enforcement hooks
- Token/cost savings estimation

The next iteration should build on that foundation rather than replacing it.

The three priorities are:

1. **Retrieval quality**: return the smallest set of highly relevant code/context needed to solve an agent task.
2. **Agent orchestration**: turn retrieval into a deliberate multi-step context-building workflow rather than exposing only independent search primitives.
3. **Benchmarking**: objectively measure retrieval quality, token reduction, latency, cost, and task success against realistic coding-agent baselines.

The goal is not to make the index larger. The goal is to make the **context supplied to an agent better, smaller, more explainable, and measurable**.

---

# 1. Product Thesis

## Current thesis

AI coding agents repeatedly rediscover repository structure by using broad filesystem searches, Grep/Glob, directory listings, and large file reads.

`code-intel` should maintain repository knowledge once and expose targeted context through MCP.

## New thesis

> `code-intel` is a persistent context layer for AI coding agents that retrieves and assembles the minimum useful repository context for a task.

The package should optimize for:

```text
Task
  ↓
Understand intent
  ↓
Retrieve candidate symbols/files
  ↓
Rank and diversify candidates
  ↓
Trace dependencies/references
  ↓
Assemble minimal context
  ↓
Return context package to agent
  ↓
Measure retrieval + token efficiency
```

Do not optimize for "return more search results."

Optimize for:

> **maximum task-relevant information per token.**

---

# 2. Design Principles

## 2.1 Minimal context wins

Every returned chunk must justify its presence.

Prefer:

```text
3 highly relevant symbols
+ 2 dependency definitions
+ 1 configuration file section
```

over:

```text
20 vaguely related files
```

## 2.2 Retrieval must be explainable

Every result should carry metadata explaining why it was selected:

- semantic similarity
- keyword match
- symbol match
- dependency relationship
- reference relationship
- path relevance
- recency/change relevance
- structural importance
- confidence

The agent should be able to understand why a result matters.

## 2.3 Search and orchestration are different layers

Keep low-level primitives:

- semantic search
- keyword search
- symbol lookup
- references
- file context

But add a higher-level orchestration layer that composes them.

Do not bury orchestration logic inside the vector store.

## 2.4 Indexing and retrieval are independent

The indexing pipeline should remain:

```text
Discovery
→ Parser
→ Chunker
→ Hasher
→ Embedding Provider
→ Vector Store
```

Retrieval should operate over the resulting index and metadata.

## 2.5 Local-first remains the default

Default behavior must preserve the current privacy model:

- Ollama is local by default.
- LanceDB stays local.
- No telemetry by default.
- Sensitive files remain excluded by default.

The benchmarking subsystem must not silently upload source code.

## 2.6 Deterministic baselines matter

A benchmark is useful only if the baseline is reproducible.

Do not compare against an arbitrary manual search session.

Define explicit baseline strategies.

---

# 3. Retrieval Quality System

## 3.1 Build a retrieval pipeline

Replace the mental model:

```text
query → vector search → top 10
```

with:

```text
query
→ query understanding
→ candidate generation
→ candidate scoring
→ structural expansion
→ deduplication
→ diversity control
→ context budgeting
→ final ranked context
```

Each stage should be independently testable.

---

# 4. Query Understanding

Create a query-analysis layer that converts an agent request into structured retrieval intent.

Example task:

> "Add rate limiting to the API endpoint that creates users and update the tests."

Produce an internal representation similar to:

```ts
interface RetrievalIntent {
  rawQuery: string;
  concepts: string[];
  symbols?: string[];
  files?: string[];
  likelyLanguages?: string[];
  operations: Array<
    "find_implementation" |
    "find_tests" |
    "find_config" |
    "find_references" |
    "find_dependencies"
  >;
  requestedContext: "minimal" | "normal" | "deep";
}
```

The first implementation does NOT need an LLM.

Use deterministic extraction first:

- quoted identifiers
- camelCase/PascalCase/snake_case tokens
- file extensions
- path fragments
- test-related words
- framework/library names
- verbs such as "add", "fix", "refactor", "update", "remove"

Optionally support an embedding-based semantic query expansion later.

---

# 5. Candidate Generation

Candidate generation should use multiple independent retrieval channels.

## 5.1 Semantic candidates

Use vector similarity to retrieve conceptual matches.

Example:

```text
"authentication middleware"
```

should find code even if the implementation calls it:

```text
verifySession()
```

## 5.2 Keyword candidates

Use exact token/path/content matching.

This is especially valuable for:

- function names
- class names
- constants
- environment variables
- API routes
- configuration keys

## 5.3 Symbol candidates

Use exact and fuzzy symbol lookup.

Prioritize symbol matches when the query contains identifier-like terms.

## 5.4 Structural candidates

Retrieve:

- containing class/module
- imports
- exported symbols
- direct dependencies
- direct dependents
- test files
- configuration files

## 5.5 Reference candidates

If the initial result contains a symbol, use `find_references` to locate callers/usages.

This allows retrieval to move from:

```text
"Where is this?"
```

to:

```text
"How does this participate in the system?"
```

---

# 6. Ranking Model

The current configurable weights are:

```yaml
search:
  vector_weight: 0.7
  keyword_weight: 0.2
  symbol_weight: 0.1
```

Retain these as sensible defaults, but introduce a richer internal score.

Recommended conceptual scoring model:

```text
score =
  semantic_score
  + keyword_score
  + symbol_score
  + path_score
  + structural_score
  + dependency_score
  + reference_score
  + test_score
  + recency_score
```

Normalize every component to `[0, 1]`.

Do not blindly add all scores. Apply configurable weights and make the scoring model inspectable.

Example:

```ts
interface RetrievalScore {
  total: number;
  semantic: number;
  keyword: number;
  symbol: number;
  path: number;
  structural: number;
  dependency: number;
  reference: number;
  test: number;
  recency: number;
}
```

Every retrieved item should retain this breakdown internally.

---

# 7. Structural Awareness

Tree-sitter already provides structural chunking. Extend its metadata.

Each chunk should ideally know:

```ts
interface CodeChunkMetadata {
  repoId: string;
  filePath: string;

  language: string;

  symbolName?: string;
  symbolType?: string;

  parentSymbol?: string;

  startLine: number;
  endLine: number;

  imports: string[];
  exports: string[];

  referencedSymbols?: string[];

  isTest?: boolean;
  isConfig?: boolean;

  contentHash: string;

  lastIndexedAt: string;
}
```

Do not require perfect semantic AST analysis for every language.

Use progressively richer metadata:

1. Tree-sitter structural metadata
2. textual references
3. import/export relationships
4. future language-server/semantic resolution

The current known gap is that `find_references` is textual rather than full semantic reference resolution. Preserve that behavior and make the architecture ready for stronger resolution later.

---

# 8. Context Expansion

After retrieving high-confidence seed chunks, perform controlled expansion.

Example:

```text
Seed:
UserController.createUser()

Expand:
→ UserService.createUser()
→ UserRepository.insert()
→ CreateUserRequest
→ user creation tests
→ relevant route registration
```

Do NOT recursively traverse the entire graph.

Use a strict expansion budget.

Recommended defaults:

```yaml
retrieval:
  seed_results: 8
  max_expansion_hops: 2
  max_context_chunks: 20
  max_context_tokens: 12000
```

Expansion priority:

1. direct dependency
2. direct caller/reference
3. containing module
4. associated test
5. relevant configuration
6. second-degree dependency

Stop expanding when marginal relevance falls below a threshold.

---

# 9. Diversity Control

Vector search frequently returns several nearly identical chunks.

Example:

```text
auth.ts
auth.test.ts
auth.mock.ts
auth-helper.ts
```

The final context should not contain ten variations of the same implementation.

Implement a diversity stage.

Possible techniques:

- path-level deduplication
- symbol-level deduplication
- maximal marginal relevance
- per-file result caps
- per-symbol result caps

Recommended initial rule:

```text
maximum 4 chunks per file
maximum 2 chunks per symbol
```

unless the user explicitly requests deep context.

---

# 10. Context Budgeting

Every orchestration request must have a context budget.

The system should estimate tokens before returning results.

Example:

```ts
interface ContextBudget {
  maxTokens: number;
  reservedTokens?: number;
  maxFiles?: number;
  maxChunks?: number;
}
```

Selection algorithm:

```text
rank candidates
↓
take highest-value candidate
↓
check token budget
↓
check redundancy
↓
add if useful
↓
continue until budget exhausted
```

The objective becomes:

```text
maximize relevance / token
```

not simply:

```text
maximize relevance
```

---

# 11. Context Package

Introduce a structured output representing the final context.

Example:

```ts
interface ContextPackage {
  query: string;

  summary: string;

  files: Array<{
    path: string;
    reason: string;
    score: RetrievalScore;
    chunks: Array<{
      symbol?: string;
      startLine: number;
      endLine: number;
      content: string;
    }>;
  }>;

  relationships?: Array<{
    from: string;
    to: string;
    type: "imports" | "calls" | "references" | "tests";
  }>;

  estimatedTokens: number;

  retrievalStats: {
    candidatesConsidered: number;
    candidatesSelected: number;
    expansionHops: number;
  };
}
```

This becomes the canonical internal representation used by MCP, CLI, and benchmarks.

---

# 12. Agent Orchestration

## 12.1 Add a high-level MCP tool

Keep all existing MCP tools.

Add:

```text
get_task_context
```

Purpose:

> Given a coding task, retrieve and assemble the minimum useful repository context.

Example:

```json
{
  "task": "Add rate limiting to the user creation API endpoint and update the tests.",
  "repo": "/path/to/repo",
  "max_tokens": 10000
}
```

Return a `ContextPackage`.

The existing tools remain available for agents that want lower-level control.

---

# 13. Recommended Orchestration Algorithm

Implement this exact first version:

```text
1. Receive task.
2. Analyze query.
3. Generate semantic candidates.
4. Generate keyword candidates.
5. Generate symbol candidates.
6. Merge and normalize candidates.
7. Rank candidates.
8. Select top seed chunks.
9. Inspect imports/exports/references.
10. Expand only high-confidence relationships.
11. Search for associated tests.
12. Search relevant configuration when task implies configuration.
13. Deduplicate.
14. Apply diversity rules.
15. Apply token budget.
16. Construct ContextPackage.
17. Return context + retrieval metadata.
```

Do not call an external LLM merely to orchestrate this first version.

The retrieval engine should be deterministic and fast.

---

# 14. Agent-Friendly Search Strategy

Teach the Cursor rule/skill generated by `cursor-install` to prefer:

```text
get_task_context
```

for broad coding tasks.

Then:

```text
search_symbol
search_codebase
find_references
get_file_context
```

for focused follow-ups.

Desired agent behavior:

```text
New task
↓
get_task_context
↓
inspect returned context
↓
search_symbol / references if necessary
↓
edit code
```

Undesired behavior:

```text
Glob **
↓
rg entire repository
↓
read 15 files
↓
repeat next turn
```

The enforcement mechanism should continue to prevent broad workspace exploration where practical.

---

# 15. Progressive Retrieval

The agent should not always retrieve the maximum amount of context.

Define three modes:

## Minimal

Use for:

- simple bug fixes
- known symbol
- obvious one-file changes

Target:

```text
2–5 chunks
~2k–5k tokens
```

## Normal

Use for:

- feature implementation
- refactoring
- multi-file changes

Target:

```text
5–15 chunks
~5k–12k tokens
```

## Deep

Use for:

- architecture changes
- unfamiliar subsystems
- cross-cutting refactors

Target:

```text
10–30 chunks
~10k–25k tokens
```

These must be configurable.

---

# 16. Retrieval Feedback

Add a way for the agent or benchmark harness to report:

```ts
interface RetrievalFeedback {
  queryId: string;
  usefulChunks?: string[];
  irrelevantChunks?: string[];
  missingConcepts?: string[];
  taskSucceeded?: boolean;
}
```

This should initially be local-only.

Do not send feedback anywhere by default.

Future versions can use this data to tune ranking weights.

---

# 17. Benchmarking System

This is the second major pillar.

The package needs to prove that it reduces context cost **without reducing task performance**.

Do not market savings based only on theoretical token counts.

Measure real retrieval and coding tasks.

---

# 18. Benchmark Architecture

Create:

```text
src/benchmark/
  datasets/
  baseline/
  retrieval/
  tokenization/
  scoring/
  runner/
  reporters/
```

CLI:

```bash
code-intel benchmark
```

and:

```bash
code-intel benchmark --repo /path/to/repo
```

---

# 19. Baseline A: Workspace Scan

Implement a deterministic approximation of the common agent workflow.

The existing `savings` command already compares against a typical:

```text
Glob
+
rg
+
read matching files
```

baseline.

Formalize this into a benchmark baseline.

Example:

```text
workspace-scan
```

Steps:

1. discover files
2. run keyword search
3. select matching files
4. read relevant source
5. estimate tokens

Record:

```ts
interface BaselineResult {
  filesRead: number;
  linesRead: number;
  estimatedTokens: number;
  latencyMs: number;
}
```

---

# 20. Baseline B: Semantic Retrieval

Benchmark the current search engine without orchestration.

```text
semantic-search
```

Record:

- candidates
- selected chunks
- tokens
- latency

This establishes whether the new orchestration actually improves over today's implementation.

---

# 21. Baseline C: Task Context

Benchmark:

```text
get_task_context
```

This is the new system.

Compare it against both baselines.

---

# 22. Benchmark Metrics

At minimum measure:

## Retrieval metrics

### Precision@K

How many of the top K retrieved chunks are actually relevant?

### Recall@K

How much of the relevant context was retrieved?

### MRR

How early does the first useful result appear?

### NDCG

Useful when multiple results have different relevance levels.

---

# 23. Token Metrics

Measure:

```text
baseline_tokens
code_intel_tokens
tokens_saved
token_reduction_percent
```

Formula:

```text
token_reduction_percent =
  (baseline_tokens - code_intel_tokens)
  / baseline_tokens
  * 100
```

Also measure:

```text
files_read
chunks_read
lines_read
```

Do not use dollar savings as the only metric.

Token counts are more portable.

---

# 24. Latency Metrics

Measure separately:

```text
index_time
query_time
candidate_generation_time
ranking_time
expansion_time
context_assembly_time
total_retrieval_time
```

Report:

- p50
- p95
- p99

Do not let an impressive token reduction hide unacceptable retrieval latency.

---

# 25. Task Success

The ultimate benchmark should answer:

> Does the smaller context actually allow an agent to solve the task?

Create a task dataset containing real coding tasks.

Each task should include:

```yaml
id: add-rate-limit
repo: example-repo
commit: abc123
prompt: >
  Add rate limiting to the user creation endpoint
  and update the relevant tests.

expected_files:
  - src/api/users.ts
  - src/middleware/rateLimit.ts
  - test/users.test.ts

relevant_symbols:
  - createUser
  - rateLimit
```

The initial benchmark can use human-labeled relevance.

Later, integrate actual coding agents.

---

# 26. Agent-Level Benchmark

Eventually support:

```bash
code-intel benchmark --agent
```

The harness should compare:

```text
Agent + normal repository access
vs
Agent + code-intel
```

Keep the coding model/provider configurable.

Record:

```text
task success
input tokens
output tokens
tool calls
files inspected
retrieval latency
total latency
estimated cost
```

The key metric is:

```text
task success per input token
```

A second useful metric:

```text
task success per dollar
```

---

# 27. Benchmark Dataset Design

Do not create only trivial search queries.

Include:

### Category 1: Known symbol

> "Where is the authentication middleware?"

### Category 2: Conceptual

> "How does the application decide whether a user is authorized?"

### Category 3: Feature

> "Add retry logic to failed API requests."

### Category 4: Bug

> "Fix the race condition when two workers update the same job."

### Category 5: Refactor

> "Move authentication logic out of the controller."

### Category 6: Cross-cutting

> "Add request IDs to API logs and propagate them through background jobs."

### Category 7: Tests

> "Find the tests that cover payment failure handling."

### Category 8: Configuration

> "Where is the production database connection configured?"

This prevents the retrieval system from overfitting to symbol lookup.

---

# 28. Ground Truth

Ground truth should be explicit.

For every benchmark task:

```ts
interface BenchmarkTask {
  id: string;
  prompt: string;

  relevantFiles: string[];
  relevantSymbols?: string[];

  relevanceLevels?: Record<string, 0 | 1 | 2 | 3>;
}
```

Suggested relevance:

```text
0 = irrelevant
1 = tangential
2 = useful
3 = essential
```

This allows NDCG-style scoring.

---

# 29. Benchmark Output

CLI output should be readable:

```text
code-intel benchmark

Task                         Baseline    Code-Intel    Reduction
-----------------------------------------------------------------
add-rate-limit               18,420      6,210         66.3%
auth-refactor                24,100      8,420         65.1%
payment-retry                15,870      5,110         67.8%

Average token reduction: 66.4%

Retrieval
-----------------------------------------------------------------
Precision@5                  0.86
Recall@10                    0.91
MRR                          0.93

Latency
-----------------------------------------------------------------
p50                          180ms
p95                          410ms

Task success
-----------------------------------------------------------------
Baseline                     87%
Code-Intel                   89%
```

Do not manufacture success numbers. Every number must come from an actual run.

---

# 30. Machine-Readable Benchmark Results

Support:

```bash
code-intel benchmark --format json
```

Output should be suitable for CI.

Example:

```json
{
  "version": 1,
  "repository": "...",
  "timestamp": "...",
  "tasks": [],
  "aggregate": {
    "tokenReduction": 0.66,
    "precisionAt5": 0.86,
    "recallAt10": 0.91,
    "mrr": 0.93
  }
}
```

Never include source code in benchmark reports unless explicitly requested.

---

# 31. Regression Testing

Every meaningful retrieval-engine change should be benchmarkable.

Add:

```bash
npm test
npm run benchmark:retrieval
```

CI should detect:

- retrieval quality regressions
- token regressions
- latency regressions

Example thresholds:

```yaml
benchmark:
  max_token_regression_percent: 10
  min_precision_at_5: 0.75
  min_recall_at_10: 0.80
  max_p95_latency_ms: 1000
```

Make thresholds configurable.

---

# 32. Retrieval Observability

Add a local retrieval trace.

For every search/task-context operation, internally record:

```text
query
candidate count
candidate sources
scores
expansion operations
selected chunks
discarded chunks
estimated tokens
latency
```

Example debug command:

```bash
code-intel search "authentication flow" --explain
```

Output:

```text
Query: authentication flow

Candidates: 37

Top result:
src/auth/middleware.ts:42-91
score: 0.91
  semantic:   0.88
  keyword:    0.74
  symbol:     0.30
  structural: 0.92

Expanded:
  src/auth/session.ts
  src/routes/auth.ts
  test/auth.test.ts

Final context:
7 chunks
4 files
5,820 estimated tokens
```

This is essential for debugging retrieval quality.

---

# 33. Storage Changes

Extend the LanceDB schema without breaking existing indexes where possible.

Potential additional fields:

```text
symbol_name
symbol_type
parent_symbol
imports
exports
is_test
is_config
language
start_line
end_line
```

If schema migration becomes too complicated, provide:

```bash
code-intel rebuild
```

as the explicit migration path.

Existing behavior already requires rebuild when changing embedding models. Preserve that operational model.

---

# 34. CLI Additions

Add:

```text
code-intel context "<task>"
code-intel context "<task>" --max-tokens 10000
code-intel context "<task>" --mode minimal
code-intel context "<task>" --explain

code-intel benchmark
code-intel benchmark --repo <path>
code-intel benchmark --format json
code-intel benchmark --task <id>

code-intel search "<query>" --explain
```

Keep existing commands unchanged.

---

# 35. MCP Additions

Existing tools remain:

```text
search_codebase
search_symbol
get_file_context
get_repo_context
find_references
list_indexed_repos
index_status
```

Add:

```text
get_task_context
```

Potential future tools:

```text
explain_retrieval
get_code_relationships
get_context_trace
```

Do not expose every internal implementation detail as an MCP tool immediately.

Prefer one high-level tool plus existing primitives.

---

# 36. Cursor Integration

Update the generated Cursor skill/rule.

Preferred instruction hierarchy:

```text
1. For a new or broad coding task, use get_task_context.
2. For a known symbol, use search_symbol.
3. For conceptual exploration, use search_codebase.
4. For call-site analysis, use find_references.
5. Use get_file_context for exact source ranges.
6. Avoid workspace-wide Grep/Glob unless the retrieval tools genuinely cannot answer.
```

Continue using hooks where supported to discourage broad scans.

Do not make the agent incapable of using the filesystem for legitimate operations.

The goal is **retrieval-first**, not blind filesystem prohibition.

---

# 37. Important Safety Valve

The enforcement mechanism should never trap the agent.

Introduce an escape hatch.

For example:

```text
code-intel:
  retrieval_required: true
  allow_fallback_after_failed_retrieval: true
```

If:

- index is stale
- repository is unsupported
- search returns low confidence
- required files are unindexed

the agent must be allowed to fall back to normal filesystem tools.

A bad retrieval system that prevents fallback can be worse than no retrieval system.

---

# 38. Confidence-Based Fallback

Define:

```ts
interface RetrievalConfidence {
  score: number;
  reason: string;
}
```

If:

```text
confidence < threshold
```

return:

```text
Low-confidence retrieval.
Recommended fallback: targeted repository search.
```

Do not pretend to know the answer.

This will also make benchmarking more honest.

---

# 39. Performance Requirements

The retrieval path should be substantially faster than an LLM round trip.

Target:

```text
warm local query: <250ms p50
normal query: <500ms p95
```

These are targets, not claims.

Measure them.

Avoid:

- embedding the same query repeatedly
- unnecessary filesystem scans
- loading the entire vector database into memory
- repeated parsing
- unbounded graph traversal

Cache normalized query embeddings where useful.

---

# 40. Incremental Indexing Requirements

The current system correctly hashes chunks and avoids re-embedding unchanged chunks. Preserve this behavior.

When a file changes:

```text
parse
→ produce chunks
→ hash chunks
→ compare hashes
→ embed only changed chunks
→ update affected metadata
→ update relationships
```

Do not rebuild the entire repository because one function changed.

Also invalidate cached retrieval metadata only when the affected symbols/files change.

---

# 41. Relationship Graph

Do not build a complicated graph database initially.

Use relational metadata inside the existing local storage layer.

Represent relationships such as:

```text
A imports B
A references B
A contains B
A tests B
A exports B
```

Later, if the graph becomes central, introduce a dedicated graph representation.

First prove that lightweight relationship expansion improves retrieval quality.

---

# 42. Tests Required

Add unit tests for:

### Query understanding

- identifier extraction
- test intent detection
- configuration intent
- language detection

### Ranking

- semantic score
- keyword score
- symbol score
- relationship boost
- path boost

### Diversity

- duplicate symbol suppression
- per-file limits

### Budgeting

- hard token limit
- chunk truncation behavior
- minimum useful context

### Expansion

- one-hop dependencies
- two-hop limits
- cycle handling
- confidence thresholds

### Benchmarking

- deterministic baseline
- token calculation
- metric calculation
- JSON serialization

### MCP

- `get_task_context`
- invalid repo
- empty results
- stale index
- low-confidence result

---

# 43. Acceptance Criteria

The implementation is complete when:

## Retrieval

- [ ] A natural-language task can produce a ranked context package.
- [ ] Semantic, keyword, and symbol retrieval are combined.
- [ ] Results are structurally expanded.
- [ ] Duplicate/redundant results are suppressed.
- [ ] A hard token budget is respected.
- [ ] Retrieval explanations are available.
- [ ] Low-confidence retrieval is clearly reported.

## Orchestration

- [ ] `get_task_context` exists as an MCP tool.
- [ ] CLI exposes `code-intel context`.
- [ ] Cursor guidance prefers task-context retrieval.
- [ ] Existing low-level MCP tools continue working.
- [ ] Filesystem fallback remains possible.

## Benchmarking

- [ ] Workspace-scan baseline exists.
- [ ] Current semantic-search baseline exists.
- [ ] Task-context retrieval can be benchmarked.
- [ ] Precision@K is measured.
- [ ] Recall@K is measured.
- [ ] MRR/NDCG is measured.
- [ ] Input token reduction is measured.
- [ ] Retrieval latency is measured.
- [ ] JSON benchmark output exists.
- [ ] Benchmark results are reproducible.

## Quality

- [ ] Existing tests continue to pass.
- [ ] Incremental indexing remains incremental.
- [ ] No secrets are added to telemetry.
- [ ] Default local privacy behavior remains intact.
- [ ] Existing Ollama workflow remains functional.
- [ ] OpenAI-compatible providers remain functional.

---

# 44. Suggested Implementation Order

Do not implement everything simultaneously.

## Phase 1: Retrieval foundations

1. Extend chunk metadata.
2. Implement unified candidate representation.
3. Implement richer ranking.
4. Add diversity filtering.
5. Add token budgeting.
6. Add `--explain`.

Deliverable:

```bash
code-intel search "authentication flow" --explain
```

returns noticeably better results.

## Phase 2: Task context

1. Implement query intent.
2. Implement seed retrieval.
3. Implement relationship expansion.
4. Implement test/config discovery.
5. Implement context assembly.
6. Add `code-intel context`.
7. Add `get_task_context` MCP tool.

Deliverable:

```bash
code-intel context "Add rate limiting to the user creation API"
```

returns a minimal, task-oriented context package.

## Phase 3: Cursor workflow

1. Update Cursor rule/skill.
2. Prefer `get_task_context`.
3. Refine search-enforcement hooks.
4. Add confidence-based fallback.
5. Test against realistic coding tasks.

Deliverable:

A coding agent naturally starts with repository context instead of broad scanning.

## Phase 4: Benchmarking

1. Formalize existing savings baseline.
2. Create benchmark task schema.
3. Build labeled task dataset.
4. Implement retrieval metrics.
5. Implement token metrics.
6. Implement latency metrics.
7. Add JSON output.
8. Add regression thresholds.

Deliverable:

```bash
code-intel benchmark
```

produces a reproducible comparison.

## Phase 5: Agent-level validation

1. Integrate a configurable coding-agent runner.
2. Run real coding tasks.
3. Compare baseline vs `code-intel`.
4. Measure task success.
5. Measure tokens and cost.
6. Publish reproducible benchmark methodology.

Deliverable:

Evidence that the system reduces context while maintaining or improving task completion.

---

# 45. What Success Looks Like

The final system should make this transformation possible.

### Before

```text
User:
"Add pagination to the orders API."

Agent:
Glob repository
↓
Grep orders
↓
Read controller
↓
Read service
↓
Read repository
↓
Read routes
↓
Read tests
↓
Read unrelated files
↓
Repeat next turn
```

### After

```text
User:
"Add pagination to the orders API."

Agent
↓
get_task_context(...)
↓
code-intel
    ↓
    semantic retrieval
    ↓
    symbol retrieval
    ↓
    relationship expansion
    ↓
    test discovery
    ↓
    ranking
    ↓
    deduplication
    ↓
    token budget
↓
~6 highly relevant chunks
↓
Agent implements change
```

The important difference is not merely fewer tokens.

It is:

> **The agent gets a coherent model of the relevant part of the repository instead of reconstructing it from raw filesystem operations.**

---

# 46. Product-Level Definition of Done

Do not consider this project successful because:

> "The search results look good."

The real definition of done is:

> **For realistic software-engineering tasks, `code-intel` should provide coding agents with materially less repository context while preserving or improving their ability to complete the task.**

The three proof points must therefore be:

### 1. Better retrieval

```text
Higher relevance
Higher recall
Less redundancy
```

### 2. Better orchestration

```text
Task
→ relevant subsystem
→ dependencies
→ references
→ tests/config
→ minimal context
```

### 3. Measurable improvement

```text
fewer tokens
+ acceptable latency
+ equal/better task success
= useful product
```

If the benchmark cannot demonstrate those three things, continue improving retrieval rather than adding more features.

---

# 47. Final Engineering Direction

Do not turn `code-intel` into another generic "AI codebase chatbot."

The strongest direction is:

```text
                    AI Coding Agent
                           │
                           ▼
                  ┌─────────────────┐
                  │    code-intel    │
                  │ Context Layer    │
                  └─────────────────┘
                     │      │      │
                     ▼      ▼      ▼
                  Search  Graph  Ranking
                     │      │      │
                     └──────┼──────┘
                            ▼
                    Minimal Context
                            │
                            ▼
                     Coding Agent
```

The repository becomes an indexed knowledge source.

The agent becomes the reasoning layer.

`code-intel` becomes the **context intelligence layer between them**.

That is the product architecture to optimize for.
