# code-intel: Project Status, Evidence, Bottlenecks, and Roadmap

Last updated: September 29, 2026  
Current public release: `@pranitmodi/code-intel` 0.3.2  
Repository commit at review: `e900a22`

## 1. Executive summary

`code-intel` is a local-first repository context layer for AI coding agents. It
indexes a repository once, keeps that index current, and exposes ranked,
token-budgeted code context through the Model Context Protocol (MCP). The goal
is not merely to provide semantic search. The goal is:

> Give an agent materially less repository context while preserving or
> improving its ability to complete a software-engineering task.

The project has achieved the major retrieval, indexing, editor-integration,
privacy, and operational foundations required for that goal:

- persistent, incremental local indexing;
- structural chunks for the primary supported languages;
- hybrid vector, keyword, symbol, path, and relationship retrieval;
- task-oriented context assembly with hard token budgets;
- confidence reporting and targeted fallback;
- Cursor and VS Code / GitHub Copilot integration;
- multi-repository and parent-workspace support;
- reliable file watching and concurrent-writer protection;
- Ollama by default and an opt-in OpenAI-compatible provider;
- reproducible retrieval benchmarks and savings estimates;
- compact MCP payloads and reduced always-on agent instructions.

The labeled retrieval benchmark is strong. On eight tasks in this repository,
0.3.0 reduced the measured `get_task_context` payload from 26,607 tokens in
0.2.0 to 15,589 tokens while holding Recall@10 at 0.958. Compared with the
workspace-scan baseline, the aggregate payload was 93% smaller.

However, the first controlled full-chat A/B study found an important
bottleneck. For one complex cross-cutting prompt:

- the initial `get_task_context` payload was 1,548 tokens;
- filesystem discovery consumed 14,752 estimated tokens;
- both final answers passed all ten factual rubric checks;
- but the initial indexed context contained only 2 of 10 key implementation
  files;
- the indexed agent compensated with repeated retrieval calls and consumed an
  estimated 24,000–30,000 repository-context tokens.

This means the retrieval primitive is efficient, but the complete agent
workflow is not yet guaranteed to be cheaper. The next project phase must
therefore optimize **end-to-end agent behavior**, not only individual retrieval
responses.

## 2. The problem being solved

Without a persistent index, coding agents commonly repeat this sequence:

1. list the repository;
2. grep for a keyword;
3. read several complete files;
4. search again for imports, references, tests, and configuration;
5. repeat the process in a later turn or a new session.

Most of that text enters the model context whether it is ultimately relevant or
not. This creates four problems:

- unnecessary input-token usage;
- slower task startup;
- relevant code diluted by unrelated files;
- repeated discovery work across sessions and editors.

`code-intel` separates that work into two paths:

### Write path

1. discover files while respecting `.gitignore` and security exclusions;
2. parse supported languages into symbol-aware chunks;
3. hash files and chunks;
4. embed only new or changed chunks;
5. store source, vectors, symbols, and metadata in LanceDB;
6. incrementally update the index as files change.

### Read path

1. analyze the agent's task for concepts, symbols, files, and intent;
2. retrieve semantic, keyword, symbol, and path candidates;
3. rank and merge evidence;
4. expand imports, references, tests, and configuration relationships;
5. remove duplicates and low-value padding;
6. stop when evidence weakens;
7. pack the result under a token budget;
8. return confidence and concise reasons with the selected source.

The intended result is a coherent model of the relevant subsystem, not a list
of loosely related search hits.

## 3. Current product state

### 3.1 Package and supported clients

The public npm package is:

```text
@pranitmodi/code-intel
```

Release 0.3.2 is published as `latest`. Node.js 20.9 or newer is required.

Supported MCP workflows include:

- Cursor;
- VS Code with GitHub Copilot;
- other stdio MCP clients that can start `code-intel mcp`.

### 3.2 MCP tools

The server exposes eight tools:

| Tool | Purpose |
| --- | --- |
| `get_task_context` | Preferred first call for a broad coding task |
| `search_symbol` | Find a known function, class, type, or symbol |
| `search_codebase` | Conceptual hybrid search |
| `find_references` | Find textual occurrences of an identifier |
| `get_file_context` | Read an authoritative line range from disk |
| `get_repo_context` | Summarize an indexed repository |
| `list_indexed_repos` | Discover repositories available to the server |
| `index_status` | Report index freshness, progress, watcher state, and recovery information |

Every repository-aware tool accepts an optional `repo` path, id, or basename.
This lets one MCP server cover a parent folder containing several indexed
repositories.

### 3.3 CLI

The CLI currently supports:

```text
init
index
setup
onboard
wizard
corporate-setup
watch
repos
search
context
benchmark
symbol
file
status
doctor
clean
rebuild
savings
cursor-install
vscode-install
mcp
```

Important workflows:

```bash
# Cursor
code-intel onboard

# VS Code / GitHub Copilot only
code-intel onboard --vscode --no-cursor

# Both editors
code-intel onboard --vscode
```

### 3.4 Embedding providers

Two provider paths are implemented:

- **Ollama**, the default local-first path;
- **OpenAI-compatible embeddings**, for a hosted provider, organization
  gateway, or local compatible service.

With local Ollama, source, queries, vectors, and the database can remain on the
machine. With an OpenAI-compatible provider, chunks and semantic queries are
sent to that endpoint, while the vector database remains local.

Credentials are environment-only. They are not read from repository YAML and
are not stored in the index.

### 3.5 Storage and privacy

Indexes live outside the repository under:

```text
~/.local-code-intelligence/
```

The index stores source text with each chunk so retrieval does not need to
re-scan the working tree. Files likely to contain secrets, `.env` files, binary
files, ignored paths, and oversized files are excluded by default.

There is no product telemetry. Local usage records are written only for the
user's own savings report.

### 3.6 Structural parsing

Symbol-aware chunking is implemented for:

- TypeScript and TSX;
- JavaScript;
- Python;
- Go;
- Bash.

Other detected languages use bounded text windows. The package also includes
language parsers used for discovery and metadata support, but compiler-grade
semantic analysis is not claimed.

### 3.7 Incremental indexing and watching

The watcher handles:

- new, modified, deleted, and renamed files;
- directories moved into or out of a repository;
- `.gitignore` changes;
- symlink-resolved repository roots;
- small targeted batches and large-event fallback;
- provider outages and writer-lock contention;
- repositories indexed after the MCP server starts;
- repositories removed while the server is running.

Important reliability mechanisms:

- SHA-256 file and normalized chunk hashes;
- embedding reuse for unchanged chunks;
- content-identical rename handling;
- atomic cross-process writer locks;
- stale-lock recovery;
- LanceDB version refresh before concurrent writes;
- retry with exponential backoff;
- persisted watcher errors;
- content-sample freshness checks in addition to file counts;
- explicit process shutdown when the editor disconnects.

## 4. Major achievements by release

### 4.1 Version 0.1.0

Established the initial product:

- structural chunking;
- local LanceDB storage;
- embeddings and hybrid search;
- incremental indexing;
- MCP tools;
- file watching;
- public npm package.

### 4.2 Version 0.1.1

Improved onboarding and deployment:

- guided setup;
- Ollama health checks;
- Cursor integration;
- OpenAI-compatible provider;
- Git-aware multi-repository indexing;
- parallel indexing;
- IVF-PQ vector indexing for larger tables.

### 4.3 Version 0.2.0

Moved from generic search toward task-oriented retrieval:

- `get_task_context`;
- `code-intel context`;
- retrieval modes and token budgets;
- task intent;
- relationship expansion;
- exact symbol and filename floors;
- confidence and fallback;
- `--explain` traces;
- labeled retrieval benchmark;
- Precision@5, coverage@5, Recall@10, MRR, NDCG, token, and latency metrics;
- richer import, export, test, reference, and configuration metadata;
- TypeScript path-alias and Python import expansion.

### 4.4 Version 0.3.0

Reduced token overhead and added robust VS Code support:

- VS Code / GitHub Copilot installer;
- JSONC-preserving editor config merging;
- `--vscode` support in onboarding commands;
- compact MCP task-context payload;
- strict whole-word and filename matching;
- prose down-weighting for code tasks;
- near-duplicate suppression;
- definition-lookup and score-gap stopping rules;
- smaller provider-neutral agent guidance;
- relevant-workspace filtering in Cursor's session hook;
- exact payload measurement in both benchmark paths;
- uncapped, generic `savings --benchmark` tasks.

### 4.5 Version 0.3.1

Fixed VS Code startup and credential handling:

- a missing or unexpanded `--repo` no longer terminates the MCP process;
- VS Code `${input:…}` prompts collect embedding credentials;
- system-CA environment is propagated when configured;
- installer output explains the resulting setup.

### 4.6 Version 0.3.2

Made VS Code setup robust with nvm and multi-root workspaces:

- absolute Node executable in user-level MCP configuration;
- absolute CLI entry path;
- absolute repository or parent-folder path;
- no dependency on a GUI process inheriting shell `PATH`;
- no dependency on `${workspaceFolder}` in empty or multi-root user windows;
- portable `${workspaceFolder}` retained for committable, single-folder
  workspace configuration;
- corrected public VS Code example and troubleshooting documentation.

## 5. Retrieval architecture already implemented

### 5.1 Candidate sources

Task context combines:

- embedding similarity;
- LanceDB full-text relevance;
- exact/fuzzy symbol lookup;
- filename and path matches;
- structural metadata;
- imports and dependencies;
- identifier references;
- test intent;
- configuration intent;
- recency.

Evidence from different sources is merged by retaining the stronger score.
Adding vector and keyword scores together was tested and rejected because it
reduced benchmark quality.

### 5.2 Exact-match handling

Exact matches receive score floors so a known definition is not buried under
vague semantic similarity. Floors are limited to defensible evidence:

- a whole-word symbol named in the query;
- an identifier found through exact lexical search;
- a full filename or sufficiently specific multi-word stem;
- a lower filename tier when all non-generic stem words appear separately.

Generic stems such as `index`, `types`, and `config`, and data filenames, do not
receive the same treatment.

### 5.3 Prose weighting

Documentation is treated differently depending on task intent:

- full weight for documentation requests;
- reduced weight for explanatory requests;
- further reduced weight for code-change or location tasks.

This prevents README and design prose from outranking implementation for
questions such as "where is this implemented?" while preserving documentation
retrieval when it is actually requested.

### 5.4 Selection and stopping

Selection includes:

- per-file chunk caps;
- per-symbol chunk caps;
- expansion limits;
- hard context-token budgets;
- near-duplicate suppression using word-set overlap;
- minimum organic score;
- expansion ordering;
- definition-specific stopping;
- score-gap stopping.

A definition lookup with an exact symbol can return only exact matches. Other
tasks stop at a sufficiently large score gap after retaining a minimum number
of organic results. Exact-match floors are exempt from the organic cutoff.

### 5.5 Compact agent payload

The MCP task-context payload contains:

- repository;
- confidence;
- estimated tokens;
- selected file paths;
- concise reasons;
- one aggregate score;
- source chunks;
- only relationships whose endpoints were included.

Internal traces, score-component breakdowns, summaries, and retrieval
statistics remain available for local explanation and debugging but are not
sent on every MCP call.

## 6. Benchmarks completed

## 6.1 Labeled retrieval benchmark

The main benchmark contains eight labeled engineering tasks:

1. known-symbol lookup;
2. conceptual hybrid-search explanation;
3. task-context feature work;
4. stale-index bug diagnosis;
5. search-ranking refactor;
6. cross-cutting MCP instruction change;
7. tree-scan test discovery;
8. embedding configuration.

Each task defines relevant files and optional graded relevance. The benchmark
compares:

1. a workspace scan;
2. semantic search;
3. task context.

The workspace baseline:

- lists files with `rg --files`;
- searches with `rg -n -C 2`;
- reads up to 12 matching files.

Tokens are estimated consistently at four characters per token.

### 6.1.1 Aggregate 0.2.0 versus 0.3.0

Measured September 23, 2026 on the same index snapshot with
`Qwen3-Embedding-8B` through an OpenAI-compatible endpoint:

| Metric | 0.2.0 | 0.3.0 |
| --- | ---: | ---: |
| `get_task_context` tokens, eight tasks | 26,607 | 15,589 |
| Change in task-context payload | — | **41% fewer** |
| Workspace-scan tokens | 233,680 | 233,680 |
| Average per-task reduction vs scan | 75.7% | **85.1%** |
| Precision@5, over files actually returned | 0.30 | **0.425** |
| Relevant-file coverage@5 | 0.792 | **0.854** |
| Recall@10 | 0.958 | 0.958 |
| MRR | 0.900 | **0.917** |
| NDCG | 0.744 | **0.779** |
| Task-context median latency | 58 ms | 58 ms |
| Task-context slowest call in that run | 129 ms | 152 ms |

The 15,589-token task-context total is 93% smaller than the 233,680-token
aggregate workspace baseline.

Important interpretation:

- recall was preserved;
- precision and ranking improved;
- token output fell substantially;
- the benchmark measures retrieval payload, not a provider invoice;
- latency and ranking can move slightly as the watcher updates the index.

### 6.1.2 Per-task 0.3.0 audit

| Task | Scan tokens | Task-context tokens | Reduction | Coverage@5 | Recall@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Known `searchCodebase` symbol | 29,259 | 356 | 98.8% | 1.00 | 1.00 | 1.00 |
| Conceptual hybrid search | 48,383 | 1,248 | 97.4% | 0.67 | 0.67 | 1.00 |
| Task-context feature | 48,783 | 3,732 | 92.4% | 1.00 | 1.00 | 1.00 |
| Stale-index bug | 7,481 | 2,833 | 62.1% | 1.00 | 1.00 | 0.33 |
| Search-ranking refactor | 5,196 | 1,213 | 76.7% | 1.00 | 1.00 | 1.00 |
| Cross-cutting MCP instructions | 43,720 | 2,296 | 94.7% | 0.67 | 1.00 | 1.00 |
| Tree-scan policy tests | 6,181 | 2,350 | 62.0% | 1.00 | 1.00 | 1.00 |
| Embedding configuration | 44,677 | 1,561 | 96.5% | 0.50 | 1.00 | 1.00 |

Known misses and weak rankings were retained in the report rather than hidden:

- the conceptual task missed `src/retrieval/score.ts`;
- the stale-index task ranked its first relevant file third;
- the cross-cutting task put `src/mcp/server.ts` seventh;
- embedding configuration put `src/config/types.ts` sixth.

## 6.2 Savings benchmark

`code-intel savings --benchmark` compares:

- a generic list + grep + read-files scan;
- the exact `get_task_context` response, without the previous clipping.

The three generic queries cover:

- authentication and login sessions;
- error handling in a request path;
- location of an API request client.

In the isolated smoke run on this repository:

| Path | Average estimated tokens |
| --- | ---: |
| Naive workspace dump | 72,086 |
| `get_task_context` | 1,082 |
| Reduction | approximately 98.5% |

This is a payload comparison and should not be presented as a guaranteed
invoice reduction.

## 6.3 Always-on agent guidance

Agent instructions cost tokens before repository work begins. They were
measured and reduced:

| Guidance text | Earlier size | 0.3.0-era size |
| --- | ---: | ---: |
| MCP server instructions | 224 | 170 |
| Cursor rule | 305 | 218 |
| Cursor skill | 317 | approximately 257 |
| VS Code Copilot instructions | 321 | 242 |
| Cursor session hook | 416 | 77 |

The always-on Cursor cost fell from approximately 945 to approximately 465
tokens. The session hook now lists only indexed repositories relevant to the
open workspace, capped at eight.

## 6.4 Controlled full-chat A/B study

On September 28, 2026, the same model and answer instructions were used for one
cross-cutting prompt about `vscode-install`.

Conditions:

- **Indexed:** current indexed checkout and local-code-intelligence tools.
- **Filesystem:** byte-identical unindexed archive of commit `e900a22`, using
  targeted filesystem discovery after the required index check failed.
- The first filesystem run was discarded because it accessed the indexed twin.
- Both final answers were limited to 700 words and evaluated on ten factual
  dimensions.

Prompt topics included:

- nvm and GUI `PATH`;
- user versus workspace installation;
- single-folder versus multi-root behavior;
- OpenAI-compatible credential prompts;
- system CA settings;
- JSONC and comment preservation;
- other MCP servers;
- missing and unusable `--repo`.

Results:

| Metric | Indexed chat | Filesystem chat |
| --- | ---: | ---: |
| Factual rubric checks passed | 10/10 | 10/10 |
| Initial task-context payload | 1,548 tokens | not applicable |
| Key implementation files in initial payload | 2/10 | not applicable |
| Unique/deduplicated repository context | approximately 24,000 tokens | 14,752 tokens |
| Repeated-output upper estimate | approximately 30,000 tokens | approximately 15,250 including omitted small snippets |

The raw task-context payload was approximately 89.5% smaller than the measured
filesystem context. However, the indexed agent's full discovery path consumed
at least 63% more repository context, and potentially about twice as much,
because it continued searching.

The initial 1,548-token context had confidence 0.95 but prioritized generic
OpenAI/provider matches and omitted central files including:

- `src/vscode/install.ts`;
- `src/editors/mcpConfig.ts`;
- `src/editors/jsonc.ts`;
- `src/editors/cliEntry.ts`;
- `src/cli/repoOption.ts`;
- `src/corporate/systemCa.ts`.

The final answer was still correct because the agent recovered through many
follow-up searches and reads.

### What this study proves

- Compact retrieval can be dramatically smaller than filesystem discovery.
- Final answer quality can be preserved in both conditions.
- A small first response does not guarantee a small complete conversation.
- High confidence is not currently a reliable measure of subsystem
  completeness for a complex prompt.
- Agent orchestration and stopping behavior are as important as payload size.

### What this study does not prove

- It is one prompt on one TypeScript repository.
- It does not include provider-reported billing tokens.
- It does not include a comparable wall-clock latency metric.
- It does not establish that filesystem search is generally better.
- It does not invalidate the eight-task retrieval benchmark.

It establishes the need for an end-to-end benchmark layer above the retrieval
benchmark.

## 7. Testing achieved

### 7.1 Current verification

Re-run September 29, 2026:

```text
TypeScript typecheck: clean
Test files: 39 passed, 1 skipped
Tests: 196 passed, 11 skipped
Duration: 8.47 seconds
```

The skipped tests are integration paths that require a reachable real Ollama
model. Unit tests do not require Ollama.

### 7.2 Areas covered by unit tests

The unit suite covers:

- agent-guidance size, provider neutrality, and example drift;
- benchmark metrics;
- chunk IDs, collision handling, metadata, and chunking;
- configuration loading and provider overrides;
- context creation;
- corporate CLI and corporate setup;
- Cursor installation;
- VS Code installation;
- JSONC editor config merging;
- CLI diagnostics and recovery guidance;
- file discovery and secret filtering;
- stale-index and content-sample freshness;
- index progress persistence;
- cross-process lock behavior;
- compact MCP payloads;
- MCP workspace and repository resolution;
- onboarding CLI behavior;
- OpenAI-compatible embedding errors and retries;
- bounded worker pools;
- repository registry and parent/child resolution;
- optional/unexpanded `--repo` handling;
- import resolution;
- retrieval confidence;
- task-context assembly;
- task intent;
- score computation;
- candidate selection and deduplication;
- savings reports;
- Cursor tree-scan policy;
- LanceDB vector-store behavior;
- watcher event mapping;
- live watcher behavior;
- watcher targets, retries, moves, deletes, and `.gitignore`;
- multi-process and shutdown edge cases.

### 7.3 Integration coverage

Integration tests cover:

- fixture-repository acceptance behavior;
- real MCP stdio transport and tool listing/calls.

The MCP integration starts the server through the same stdio transport used by
editors.

### 7.4 Release and packaging checks performed

Release preparation for 0.3.x included:

- `tsc --noEmit`;
- full Vitest suite;
- production build;
- `npm pack --dry-run`;
- package file-list audit;
- internal-path and internal-reference scan;
- fresh installation from npm;
- CLI version verification;
- MCP server startup smoke tests;
- VS Code generated-config smoke tests;
- an end-to-end `get_task_context` call through the generated VS Code MCP
  configuration;
- GitHub CI verification.

## 8. Operational and editor achievements

### 8.1 Cursor

The Cursor installer:

- merges its MCP entry without replacing other servers;
- installs a short user rule;
- installs a reusable skill;
- installs session and retrieval-preference hooks;
- quotes paths containing spaces;
- replaces obsolete hooks from earlier install locations;
- lists only indexed repositories relevant to the workspace;
- discourages broad scanning while preserving targeted fallback.

### 8.2 VS Code and GitHub Copilot

The VS Code installer:

- writes the required `servers` layout and `type: "stdio"`;
- detects stable VS Code, Insiders, and VSCodium;
- supports user and workspace scope;
- preserves JSONC comments and unrelated servers;
- writes Copilot instructions;
- uses an absolute Node executable;
- uses an absolute CLI script;
- captures an absolute repository or parent folder for user scope;
- preserves portable `${workspaceFolder}` for single-folder workspace scope;
- supports multi-root use through a common absolute parent;
- creates secure VS Code input prompts for embedding credentials;
- merges system-CA settings;
- avoids duplicate prompts on rerun;
- leaves existing user-provided environment values untouched.

### 8.3 Multi-repository workspaces

Parent-folder behavior has been validated in real use:

- the parent itself need not be indexed;
- indexed child repositories are discovered;
- each tool can address a child by `repo`;
- each indexed child can be watched;
- subfolders resolve to the indexed repository that owns them.

## 9. Claims we can make today

The evidence supports these claims:

1. `code-intel` can return much smaller repository payloads than a representative
   list + grep + read-files baseline.
2. On the eight labeled retrieval tasks, the smaller 0.3.0 payload maintained
   Recall@10 and improved precision and ranking relative to 0.2.0.
3. Known-symbol and narrowly scoped tasks can produce extremely small, precise
   responses.
4. The index is incremental and can remain current while code changes.
5. Cursor and VS Code integrations are functional and tested.
6. The default provider path is local-first.
7. The package has meaningful automated coverage of indexing, retrieval,
   editors, concurrency, and failure recovery.

## 10. Claims we should not make yet

The evidence does not yet support:

1. every complete coding-agent chat uses 85% or 90% fewer tokens;
2. payload reduction translates directly into the same invoice reduction;
3. quality is proven on large polyglot monorepos;
4. quality is proven across many embedding models;
5. task completion is better than or equal to baseline across a broad agent
   benchmark;
6. confidence 0.95 always means the context is complete;
7. textual references are equivalent to compiler-resolved references;
8. all framework-specific module resolution is supported.

These distinctions should remain explicit in public documentation.

## 11. Current bottlenecks

## 11.1 Query decomposition is too shallow

A complex prompt often contains:

- exact command names;
- exact symbols;
- files or subsystems;
- broad concepts;
- requested relationships;
- operational concerns.

The current retrieval can allow generic conceptual terms to dominate the
initial candidate pool. In the chat study, "OpenAI-compatible" attracted
provider configuration and tests while the central `vscode-install`
implementation was absent.

### Consequence

The agent must issue extra searches to reconstruct the subsystem, erasing the
initial token advantage.

## 11.2 Confidence measures relevance, not completeness

The A/B prompt received confidence 0.95 despite containing only 2 of 10 key
implementation files.

Current confidence signals can answer:

> Are the top-ranked results individually plausible?

They do not reliably answer:

> Did we cover every major aspect requested by this multi-part task?

### Consequence

The agent is told retrieval is strong even when important task dimensions are
missing.

## 11.3 Agent follow-up behavior is unbounded

The indexed chat continued with many symbol searches, conceptual searches,
reference searches, and overlapping file reads.

### Consequence

A 1,548-token initial response became a 24,000–30,000-token discovery path.

## 11.4 Retrieval is optimized per call, not per session

Near-duplicate suppression applies within a selected context package. It does
not prevent a later tool call from returning source the agent already saw.

### Consequence

Repeated overlapping calls can reintroduce the same source and score metadata.

## 11.5 The benchmark stops at retrieval

The labeled benchmark accurately measures individual retrieval quality and
payload size. It does not run a complete agent answer or implementation.

### Consequence

The project can improve benchmark token reduction while a real agent spends
more tokens in follow-up calls.

## 11.6 Dataset scope is narrow

The current labeled dataset is:

- one repository;
- primarily TypeScript;
- eight tasks;
- one main embedding model in the published comparison.

### Consequence

Regression detection is useful, but external validity is limited.

## 11.7 References and import resolution are lightweight

`find_references` is textual. Import expansion currently handles selected
JavaScript/TypeScript and Python patterns.

### Consequence

Dynamic resolution, project references, framework aliases, generated imports,
and compiler-level symbol identity may require fallback.

## 11.8 Absolute editor paths can age

VS Code user setup records the current absolute Node and package paths. This is
more reliable than depending on GUI `PATH`, but an nvm Node version can later be
removed.

### Consequence

After switching and deleting Node versions, users may need to rerun
`code-intel vscode-install`.

## 12. Proposed technical improvements

## 12.1 P0: Build an end-to-end agent benchmark

This is the highest priority because it changes what the project can prove.

### Required harness behavior

Run the same:

- repository snapshot;
- prompt;
- model;
- system instructions;
- answer format;
- time and tool budgets.

Compare two conditions:

1. code-intel retrieval;
2. filesystem discovery after confirming the repository is unindexed.

Record:

- every tool call;
- exact serialized tool payload;
- cumulative repository characters and estimated tokens;
- repeated/overlapping source;
- unique source;
- tool-call count;
- retrieval latency;
- wall-clock task latency;
- provider-reported input/output tokens when available;
- answer correctness;
- relevant-file coverage;
- implementation success for change tasks;
- tests passing after a change task;
- fallback reason.

### Proposed artifacts

```text
src/agent-benchmark/
  runner.ts
  conditions.ts
  recorder.ts
  scoring.ts
  reports.ts
  datasets/
```

The existing retrieval benchmark should remain. The agent benchmark should sit
above it, not replace it.

## 12.2 P0: Add task decomposition before retrieval

Convert one broad prompt into structured facets:

```ts
interface TaskFacet {
  kind: 'symbol' | 'command' | 'file' | 'concept' | 'relationship' | 'test' | 'config';
  value: string;
  priority: number;
}
```

For the VS Code study prompt, decomposition should have produced:

```text
command: vscode-install
symbol: installVscodeIntegration
concept: GUI PATH / nvm
concept: multi-root workspace
concept: credential prompts
concept: system CA
relationship: config merge
edge case: unusable --repo
```

Retrieval should run focused subqueries per facet, then merge by maximum
evidence while reserving space for distinct facets.

### Expected benefit

Generic provider terms can no longer consume the entire initial result set.

## 12.3 P0: Introduce task-facet coverage

Before returning high confidence, evaluate whether every important task facet
has evidence.

Example:

```ts
interface FacetCoverage {
  facet: TaskFacet;
  covered: boolean;
  evidenceFiles: string[];
  score: number;
}
```

Confidence should include:

- top-result strength;
- score separation;
- exact evidence;
- number of covered facets;
- relationship coverage;
- stale/index health.

High relevance with low facet coverage should produce:

```text
confidence: medium
reason: Strong credential-provider matches, but no installer or repo-resolution evidence.
recommended_follow_up: search_symbol("installVscodeIntegration")
```

## 12.4 P0: Add bounded retrieval plans

`get_task_context` should return a concise next-step plan:

```json
{
  "sufficient": false,
  "missing_facets": ["system CA", "repo fallback"],
  "recommended_reads": [
    {"path": "src/vscode/install.ts", "start_line": 100, "end_line": 240},
    {"path": "src/cli/repoOption.ts", "start_line": 1, "end_line": 40}
  ],
  "follow_up_budget": {
    "file_reads": 4,
    "searches": 1
  }
}
```

Recommended agent policy:

1. one `get_task_context`;
2. up to five targeted `get_file_context` calls;
3. at most one `search_symbol` or `find_references` follow-up;
4. no repeated conceptual search unless confidence is low;
5. filesystem fallback only when stale, unindexed, low confidence, or a facet
   remains uncovered.

The exact limits should be validated, not assumed.

## 12.5 P1: Add session-level context accounting

Track chunk hashes returned during one MCP connection:

```ts
interface RetrievalSession {
  seenChunkHashes: Set<string>;
  uniqueCharsSent: number;
  repeatedCharsAvoided: number;
  calls: number;
}
```

Later calls should:

- omit exact chunks already sent;
- return a compact "already provided" reference;
- prefer unseen line ranges;
- expose cumulative budget usage;
- optionally allow `include_seen: true` for explicit retries.

This should remain local and contain no source telemetry outside the machine.

## 12.6 P1: Improve exact command and CLI-path retrieval

Command-shaped tokens such as:

```text
vscode-install
get_task_context
--repo
CODE_INTEL_EMBEDDING_API_KEY
```

should receive specialized lexical treatment:

- preserve punctuation and hyphens;
- search command registration and option definitions;
- search generated examples and tests at lower priority;
- prefer source definitions over documentation mentions;
- connect a command registration to called functions.

For `vscode-install`, command registration in `src/cli/index.ts` should seed
`installVscodeIntegration`, which should then expand to editor config helpers.

## 12.7 P1: Improve relationship-aware completeness

Once a command or entry point is found, expansion should distinguish:

- direct imports used by the command;
- called setup functions;
- configuration loaders;
- serializer/merger helpers;
- tests for the same feature;
- documentation.

Suggested priority:

```text
entry point
→ direct implementation
→ direct helpers
→ configuration and edge-case helpers
→ focused tests
→ documentation
```

The current generic import/reference expansion should gain feature-boundary and
call-path awareness.

## 12.8 P1: Calibrate confidence against labeled completeness

Add calibration metrics to the benchmark:

- high-confidence precision;
- relevant-file coverage at confidence bands;
- false-high-confidence rate;
- expected calibration error;
- Brier-style score for facet coverage.

Release criteria should include:

```text
No high-confidence package may cover fewer than a configured fraction of
labeled essential facets on the benchmark dataset.
```

## 12.9 P1: Expand the benchmark dataset

Add at least:

- 20–30 tasks in this repository;
- multiple repositories;
- one large monorepo;
- one Python project;
- one Go project;
- one mixed-language project;
- parent-folder and multi-repository tasks;
- documentation-only tasks;
- exact-symbol tasks;
- broad architecture questions;
- bug fixes requiring tests and configuration;
- implementation tasks with automated test verification.

Labels should include:

- essential files;
- secondary files;
- required symbols;
- task facets;
- expected tests;
- unacceptable distractors.

## 12.10 P1: Add repeated-run stability

Run each agent benchmark condition at least three times.

Report:

- mean and median;
- p50/p95 latency;
- standard deviation;
- min/max token use;
- answer-quality variance;
- tool-path variance.

One successful run should not be treated as proof.

## 12.11 P2: Improve import and reference resolution

Potential work:

- TypeScript project references;
- nested `tsconfig` and package-level aliases;
- framework-specific aliases;
- JavaScript package exports;
- richer Python package resolution;
- optional language-server or compiler integration;
- symbol-identity references instead of plain text.

This should be modular and optional. The project should not require a compiler
service merely to provide basic local retrieval.

## 12.12 P2: Harden editor lifecycle validation

Add an editor diagnostics command:

```bash
code-intel editor-doctor vscode
code-intel editor-doctor cursor
```

Checks could include:

- configured Node path still exists;
- CLI script still exists;
- repository path exists;
- credential inputs are present when required;
- system CA settings are consistent;
- server starts and completes MCP initialization;
- expected eight tools are visible;
- workspace/parent children are indexed;
- package version is current.

The installer can recommend rerunning itself after an nvm version is removed.

## 13. Proposed implementation phases

## Phase A: Measure the complete workflow

Deliverables:

- end-to-end benchmark runner;
- exact payload recorder;
- answer-quality rubric;
- at least ten representative tasks;
- indexed versus filesystem reports;
- repeatable JSON output.

Exit criteria:

- total context, duplicate context, tool count, latency, and task success are
  visible for every task;
- benchmark conditions are isolated and reproducible.

## Phase B: Fix first-response completeness

Deliverables:

- task-facet decomposition;
- command/option lexical handling;
- facet-aware candidate merging;
- feature-boundary relationship expansion;
- calibrated confidence.

Exit criteria:

- cross-cutting prompts no longer report high confidence with major uncovered
  facets;
- initial key-file coverage improves without exceeding the context budget.

## Phase C: Bound agent follow-ups

Deliverables:

- recommended exact reads;
- missing-facet reporting;
- follow-up budget;
- session-level duplicate suppression;
- updated Cursor and Copilot instructions.

Exit criteria:

- median discovery calls stay within the validated budget;
- repeated source is below the target threshold;
- answer quality does not regress.

## Phase D: Broaden external validity

Deliverables:

- more tasks and repositories;
- repeated runs;
- multiple embedding models;
- polyglot and monorepo results;
- published methodology and raw benchmark reports.

Exit criteria:

- claims are supported beyond this repository;
- release thresholds are stable across project types.

## 14. Proposed success metrics

The following are targets for validation, not current claims:

### Retrieval quality

- Recall@10 at least 0.95 on the expanded dataset;
- coverage@5 at least 0.85;
- no regression in MRR or NDCG;
- cross-cutting essential-facet coverage at least 0.80;
- materially lower false-high-confidence rate.

### End-to-end efficiency

- at least 40% lower total repository context than filesystem discovery on the
  median task;
- improvement on at least 80% of benchmark tasks;
- no more than eight discovery calls on the median task;
- repeated repository source below 10% of sent source;
- no increase in failed task completion.

### Operational quality

- retrieval p95 comfortably below one second for the benchmark environment;
- watcher retries recover without manual reindexing;
- concurrent editor processes do not duplicate or corrupt rows;
- generated editor config passes startup diagnostics;
- no credentials or private source in public artifacts.

### Answer and implementation quality

- equal or better factual rubric score;
- required files and symbols cited;
- change tasks pass their expected tests;
- low-confidence cases correctly recommend fallback;
- no benchmark improvement obtained by simply broadening context.

## 15. Recommended immediate backlog

Priority order:

1. Implement end-to-end benchmark recording.
2. Add the VS Code A/B prompt as the first agent-level regression task.
3. Add task-facet decomposition.
4. Add exact command/option extraction.
5. Add facet-aware confidence and missing-facet reporting.
6. Return bounded recommended reads.
7. Add cumulative/session context accounting.
8. Update agent instructions to honor the bounded plan.
9. Add ten more cross-cutting and implementation tasks.
10. Repeat the full A/B study and publish the before/after report.

## 16. Recommended product position

Today, `code-intel` should be described as:

> A local-first MCP context layer that indexes a repository once and returns
> ranked, token-budgeted code context to coding agents.

The strongest proven value is:

- substantially smaller retrieval payloads;
- persistent local indexing;
- useful task-oriented context;
- reliable editor integration;
- privacy and provider flexibility;
- auditable ranking and benchmark methodology.

The next proof point is:

> End-to-end evidence that complete coding-agent tasks use less total context
> while maintaining task quality.

That proof point should become the central goal of the next development phase.

## 17. Reference documents

- [README](../README.md)
- [Architecture](ARCHITECTURE.md)
- [Benchmarks](BENCHMARKS.md)
- [Changelog](../CHANGELOG.md)
- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)
- [Original task-context design history](history/task-context-spec.md)

## 18. Final assessment

The project is beyond a prototype. It has:

- a published package;
- a real local index;
- two embedding-provider paths;
- mature incremental indexing;
- eight MCP tools;
- two editor integrations;
- multi-repository support;
- deterministic retrieval metrics;
- compact payloads;
- meaningful automated coverage;
- documented privacy and recovery behavior.

The primary remaining risk is not whether the index can find code. It can. The
primary risk is whether an agent uses the index efficiently enough that the
whole conversation is cheaper and more focused.

The immediate engineering direction should therefore be:

```text
better task decomposition
        +
better completeness/confidence
        +
bounded follow-up behavior
        +
end-to-end measurement
        =
provable agent-level value
```

