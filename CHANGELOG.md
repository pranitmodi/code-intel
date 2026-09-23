# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org).

## [Unreleased]

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

[Unreleased]: https://github.com/pranitmodi/code-intel/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/pranitmodi/code-intel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/pranitmodi/code-intel/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/pranitmodi/code-intel/releases/tag/v0.1.1
[0.1.0]: https://github.com/pranitmodi/code-intel/releases/tag/v0.1.0
