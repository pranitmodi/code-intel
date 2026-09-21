# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org).

## [Unreleased]

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

[Unreleased]: https://github.com/pranitmodi/code-intel/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/pranitmodi/code-intel/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/pranitmodi/code-intel/releases/tag/v0.1.1
[0.1.0]: https://github.com/pranitmodi/code-intel/releases/tag/v0.1.0
