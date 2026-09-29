# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.4.0] - 2026-09-29

Removed the internal design specs (`docs/history/`) and the status/roadmap document; the maintained docs are the README, `docs/ARCHITECTURE.md`, and `docs/BENCHMARKS.md`.

Cheaper and faster whole agent sessions, not just smaller first replies. A September A/B test found the first `get_task_context` reply was small but missed 8 of 10 key files for a multi-part question. The agent then spent more tokens on follow-up calls than a filesystem-only agent. This release fixes the causes found in the code.

### Changed

- **Multi-part requests are split into parts and each part is retrieved separately.**
  - A request that lists several things is split deterministically into facets (no LLM involved).
  - Each facet gets its own semantic, keyword, and file-name search; all embeddings are made in one provider call.
  - The reply is chosen to cover every part before adding second chunks for any one part.
  - Results with `Qwen3-Embedding-8B` on the new cross-cutting benchmark tasks:
    - first-reply essential files: 0.37 → 0.54;
    - parts covered: 0.56 → 0.75;
    - Recall@10: 0.39 → 0.53.
  - On the original 8 tasks, Recall@10 holds at 0.96 and MRR rises from 0.92 to 1.00.
  - `get_task_context` replies are 19–27% smaller. See [docs/BENCHMARKS.md](docs/BENCHMARKS.md).
- **Confidence for multi-part requests now means coverage.** Replies report each part as `covered`, `weak`, or `missing`, and say `complete` only when every part has evidence. For those requests the score is the covered share, no longer the top chunk's score.
- **`get_task_context` replies are plain text by default.**
  - Replies are a short manifest plus raw code blocks, which is about 16% smaller than the JSON form for the same content.
  - The absolute repo path, per-file scores, and reasons are no longer sent.
  - When a reply is incomplete, it lists at most three exact `Next` calls (for example one batched `get_file_context`).
  - Set `CODE_INTEL_MCP_FORMAT=json` for the previous JSON payload.
- **Every top-level statement is now indexed.** Before, a file with any declaration had only its declarations chunked, which missed about a third of source lines. Now indexed as well:
  - CLI command registrations (`program.command('vscode-install')`), MCP tool registrations, and routes, as named `command` chunks;
  - `const` arrow functions, schemas, and constants;
  - test bodies, as `test` chunks named by title.
  - Doc comments and `export` stay with their declaration.
  - Class chunks no longer repeat their methods' text.
  - The first `code-intel index` after upgrading re-chunks every file once and reuses embeddings wherever chunk text is unchanged.
- **Exact-match boosts need exact evidence.**
  - A prose word no longer gets the definition boost: "OpenAI" in "OpenAI-compatible", a one-word class such as `User` matched by "user", or a test title.
  - A comment that mentions an identifier no longer counts.
  - A generic file name such as "server" or "paths" no longer counts.
  - Command names in backticks, `--flags`, and `ENV_KEYS` are recognised, and a string-named command or tool is found where it is registered.
- **The agent guidance for all clients (MCP instructions, Cursor rule and skill, Copilot instructions, Cursor hook messages) teaches a bounded workflow:** one `get_task_context` with the whole request, `Next` calls only when incomplete, ranged reads with `ctx`, and no re-reads.

### Added

- **`get_file_context` accepts `ranges`** (`"src/a.ts:120-168"`, up to 12 per call).
  - Output is capped at 400 lines per range and 1,200 per call. Capped output says where the rest resumes and how long the file is.
  - It refuses `.env`, keys, and other secret-pattern files unless `security.allowSensitiveFiles` is set.
- **Conversation contexts.**
  - Each `get_task_context` reply names a `ctx`. Passing it back to `get_task_context`, `get_file_context`, or `search_codebase` replaces unchanged code the conversation already has with a one-line note.
  - An exact re-request of a range still returns it in full, in case the client dropped it from context.
  - Contexts are keyed by id, not by process, so editors that serve several chats from one server stay correct.
  - Disable with `CODE_INTEL_MCP_SESSION=0`.
- **`search_codebase` returns text code blocks**, with the same `ctx` de-duplication.
- **A reply cap:** `CODE_INTEL_MAX_REPLY_TOKENS`, or 80% of Claude Code's `MAX_MCP_OUTPUT_TOKENS` when set, so a reply is never diverted to a file.
- **Benchmark additions:**
  - `code-intel benchmark --suite core|cross-cutting|all`.
  - Seven multi-part tasks with facet labels.
  - First-reply essential-file and facet coverage metrics.
  - A session cost model that prices follow-up turns with prompt caching.
- **Deterministic benchmark runs:** `CODE_INTEL_EMBEDDING_PROVIDER=hash` (offline embeddings for CI), `CODE_INTEL_ANN_INDEX=off`, and `CODE_INTEL_CLOCK`.

### Fixed

- **Opening an index no longer rebuilds all of its indexes.** `createIndex` replaces existing indexes by default, so every process start retrained every index. With IVF-PQ, first calls took 14–18 s. Only missing indexes are now created.
- **IVF-PQ is built only at 10,000 rows or more, and queried with wider probes plus exact re-ranking.** Smaller tables use exact search, so similarity scores are no longer approximate.
- **`get_task_context` no longer walks the whole working tree on every call to check staleness.** A live watcher reports freshness; otherwise the check is cached for 60 s and never delays a reply by more than 150 ms. The watcher's 30-second refresh no longer walks every indexed repo.
- **Parser and syntax-tree memory is released after each file**, fixing a slow leak in long-running watchers.
- **File names in a request match exactly** (`mcp.json` no longer matches `cursor.mcp.json`).
- **The watcher folds new rows into the indexes periodically**, so searches do not slow down over a long session of edits.

## [0.3.2] - 2026-09-24

### Fixed

- VS Code user-profile installs no longer depend on the GUI process inheriting nvm's `PATH`. The generated MCP entry uses absolute paths for the running Node executable and the package's CLI entry point.
- VS Code empty and multi-root windows no longer fail before the MCP process starts because `${workspaceFolder}` cannot be resolved. The user-profile installer records the repository or parent folder from which onboarding ran; parent folders continue to serve every indexed child repository.
- The checked-in VS Code example no longer recommends the fragile bare `code-intel` command.

### Changed

- `code-intel vscode-install` reports the exact Node and repository paths written to `mcp.json`.
- `--workspace` remains portable and committable by using `${workspaceFolder}` and is documented as single-folder only.
- The README now documents multi-root setup from a common parent and the nvm/GUI PATH failure mode.

## [0.3.1] - 2026-09-24

### Fixed

- The MCP server no longer exits with `option '--repo <path>' argument missing` when an editor passes `--repo` without a path. VS Code leaves `${workspaceFolder}` unexpanded in a window with no folder open, and in multi-root workspaces. The server now starts, logs one warning, and falls back to the current folder; tool calls that name a `repo` keep working.

### Added

- `code-intel vscode-install` wires VS Code `${input:…}` prompts for `CODE_INTEL_EMBEDDING_API_KEY` and `CODE_INTEL_EMBEDDING_USER` when the provider is OpenAI-compatible, so VS Code collects them once into its own secret storage instead of holding them in `mcp.json`. Values already present are left alone, and reruns do not duplicate the prompts.
- `code-intel vscode-install` adds the system-CA environment when the configured provider needs it, matching what `setup --vscode` already did.

### Changed

- Editor installers print what VS Code will prompt for and remind you to open a single folder so `${workspaceFolder}` resolves.
- README documents the VS Code path next to the Cursor one: a one-command setup (`code-intel onboard --vscode --no-cursor`), how credentials are prompted, and troubleshooting for the unexpanded workspace variable.

## [0.3.0] - 2026-09-23

VS Code and GitHub Copilot support, reliable auto-indexing, and smaller answers. On the labeled benchmark, `get_task_context` sends 41% fewer tokens than 0.2.0 at the same Recall@10 (0.96), precision@5 rises from 0.30 to 0.43, and always-on agent guidance in Cursor drops from about 945 to 465 tokens. See [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

### Added

- `code-intel vscode-install`, which merges the VS Code `mcp.json` (`servers` key, explicit `stdio` type) and writes an always-applied Copilot instructions file. `--workspace` targets `.vscode/` and `.github/instructions/` in the repository; `--user-dir` overrides profile detection for stable, Insiders, and VSCodium.
- `--vscode` on `setup`, `onboard`, `wizard`, and `corporate-setup` so one run can wire Cursor, VS Code, or both.
- The MCP server starts watching repositories indexed after it launched (rechecked every 30 seconds) and stops watching repositories that were cleaned.
- Opening a subfolder of an indexed repository uses that repository for MCP tools and auto-indexing.
- Near-duplicate chunks are dropped from context packages.
- `get_task_context` stops early: a definition lookup with an exact symbol match returns only exact matches, and other tasks end at the first large score gap.

### Changed

- MCP tools return compact JSON. `get_task_context` sends path, reason, one score, and chunks per file, plus relationships between files it sent; the score breakdown, summary, and retrieval statistics moved to `code-intel context --explain`.
- Exact-match score floors apply only to real matches: whole-word symbol names, full file names or long multi-word stems, and no generic stems (`index`, `types`, `config`) or data files.
- Documentation and other prose files are down-weighted for code-change tasks and keep full weight for documentation questions.
- MCP instructions, the Cursor rule and skill, and Copilot instructions are shorter and no longer name a specific embedding provider. The Cursor session hook lists only indexed repositories that overlap the open workspace.
- The retrieval benchmark counts the exact payload the MCP server returns. `code-intel savings --benchmark` now measures `get_task_context` instead of a `search_codebase` result clipped at 1,200 tokens, and uses the same generic tasks for every repository.
- Editor config files are parsed as JSON with comments. Installers edit only their own entry, keep user comments and formatting, and leave files untouched when nothing changed.
- Cursor hook commands quote script paths containing spaces, and hooks left by an older install location are replaced instead of duplicated.
- MCP config merging, CLI entry resolution, and server environment merging are shared between the Cursor and VS Code installers.
- The checked-in VS Code MCP example declares `"type": "stdio"`, without which VS Code skips the entry.
- The MCP server reports the package version, and `npm run build` starts from an empty `dist/`.
- Design notes from earlier phases moved to `docs/history/`, and the npm package now ships only the README, license, changelog, security policy, code of conduct, architecture, and benchmark docs.

### Fixed

- The watcher no longer ignores every change when the repository path goes through a symlink, such as macOS temporary folders or a symlinked projects directory.
- Folders moved into a repository are indexed, folders moved out are removed, and editing `.gitignore` rescans so newly ignored files leave the index.
- Watch batches that fail because the embedding provider is down or another process holds the index lock are retried with backoff instead of dropped.
- The index lock is acquired atomically, so two processes (for example Cursor and VS Code both running the MCP server) never index the same repository at once. Locks left by crashed processes are reclaimed.
- Concurrent indexers no longer write duplicate rows from a stale LanceDB table version, and readers see other processes' writes within about a second.
- The MCP server exits when the editor disconnects, crashes, or sends SIGTERM, instead of lingering with active file watchers and continuing to index.
- Installers refuse editor configs whose top level is not an object instead of silently replacing them.

## [0.2.0] - 2026-09-21

### Added

- `get_task_context`, a high-level MCP tool that returns a ranked, token-budgeted context package for a coding task.
- `code-intel context`, retrieval modes, confidence reporting, and `--explain` traces.
- Deterministic task intent, relationship expansion, diversity controls, and hard context budgets.
- Exact symbol and basename ranking floors, score-ordered files, and test/config intent handling.
- Lightweight chunk metadata for imports, exports, referenced identifiers, tests, and configuration files.
- TypeScript path-alias and Python module expansion.
- Labeled retrieval benchmark with Precision@5, coverage@5, Recall@10, MRR, NDCG, token reduction, latency, and auditable retrieved paths.
- Per-file watcher updates for small event batches, content-sample freshness detection, and persisted watcher errors in `index_status`.
- Actionable CLI and MCP recovery guidance plus confidence-based targeted filesystem fallback.

### Changed

- Cursor rules, skill, hooks, and MCP instructions now prefer `get_task_context` for broad tasks.
- Hybrid retrieval now combines semantic, keyword, symbol, path, structure, relationship, test, and recency signals.
- MCP starts an incremental catch-up when it opens an indexed workspace.
- Documentation now separates measured benchmark claims from estimates and describes the privacy boundary for each provider.

### Fixed

- Duplicate symbol chunk IDs no longer abort a LanceDB merge.
- Unchanged chunks reuse embeddings while refreshing metadata and line ranges.
- Large event bursts fall back to full incremental discovery instead of issuing many individual writes.
- Code-change queries that rank documentation first are treated as low confidence.

## [0.1.1] - 2026-09-07

### Added

- Guided onboarding, Ollama health checks, and Cursor integration.
- OpenAI-compatible embedding provider support and Git-aware multi-repository indexing.
- Parallel file indexing and IVF-PQ vector indexing for larger tables.

## [0.1.0] - 2026-09-01

### Added

- Initial public npm release.
- Structural chunking, local LanceDB storage, incremental indexing, hybrid search, MCP tools, and file watching.

[Unreleased]: https://github.com/pranitmodi/code-intel/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/pranitmodi/code-intel/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/pranitmodi/code-intel/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/pranitmodi/code-intel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/pranitmodi/code-intel/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/pranitmodi/code-intel/releases/tag/v0.1.1
[0.1.0]: https://github.com/pranitmodi/code-intel/releases/tag/v0.1.0
