# Contributing to code-intel

Thanks for helping. The goal of this project is a **local-first** code index: embeddings and source stay on the contributor's machine, and AI agents query that index over MCP instead of re-scanning the tree.

Before changing a subsystem, read [Architecture](docs/ARCHITECTURE.md). Retrieval changes must follow the measurement rules in [Benchmarks](docs/BENCHMARKS.md). Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- Node.js 20+
- [Ollama](https://ollama.com/download) with the default embedding model (needed only for indexer / semantic-search tests):

```bash
ollama pull nomic-embed-text
ollama serve   # if it is not already running
```

`code-intel doctor` checks that Ollama and the model are reachable.

## Setup

```bash
git clone https://github.com/pranitmodi/code-intel.git
cd code-intel
./scripts/dev-link.sh    # npm install + build + npm link
npm test
```

Or the same steps by hand: `npm install && npm run build && npm test`. From this checkout you can also run `./scripts/onboard.sh --repo /path/to/your-project` instead of a global `code-intel onboard`.

Unit tests in `tests/unit` never need Ollama. Integration tests in `tests/integration` talk to a real local model and **skip automatically** when Ollama or `nomic-embed-text` is missing.

```bash
npm run typecheck
npm run test:unit          # CI default
npm run benchmark:retrieval  # labeled retrieval metrics (needs an index + embeddings)
npm test                   # unit + integration (integration skipped without Ollama)
npm run dev -- status      # CLI from source, no build step
```

## Fixture repo

`tests/fixtures/test-repo` is a tiny TypeScript tree used by the acceptance and MCP integration tests. To index it by hand:

```bash
npm run build
node dist/cli/index.js setup --repo tests/fixtures/test-repo
node dist/cli/index.js search "how does authentication work?" --repo tests/fixtures/test-repo
```

Indexes live under `~/.local-code-intelligence` (or `CODE_INTEL_DB_PATH`), not inside this checkout.

## MCP tests

`tests/integration/mcp.test.ts` spawns `code-intel mcp` over stdio with `@modelcontextprotocol/client` — the same transport Cursor uses. When you add or rename a tool, update that file's expected tool list.

## Retrieval and benchmark changes

Retrieval quality is part of the product contract. A ranking change should include:

- focused unit tests for the intended signal;
- `code-intel search "<query>" --explain` or `code-intel context "<task>" --explain` output for the affected case;
- before/after `npm run benchmark:retrieval` results;
- an explanation for any task-label or relevance-grade change.

Do not improve metrics by broadening the context until it resembles a tree scan. The release floor is relevant-file coverage@5 ≥ 0.60, Recall@10 ≥ 0.75, MRR ≥ 0.70, and average per-task token reduction ≥ 60% on the repository dataset.

When adding a benchmark task, use a realistic engineering request and defensible relevant files. Avoid tasks designed around the current ranker's implementation.

## Publishing (maintainers)

Releases are made from a clean, tested `main` commit:

```bash
npm run typecheck
npm run test:unit
npm run build
npm run benchmark:retrieval
npm audit --omit=dev
npm pack --dry-run
npm login
npm publish --access public
```

The package name is `@pranitmodi/code-intel` (scoped; unscoped `code-intel` is blocked by npm as too similar to `codeintel`).

`prepublishOnly` builds `dist/` and runs unit tests. Inspect the tarball before publishing. It must contain only the built CLI/server and public documentation—never indexes, `.code-intel` config, credentials, private paths, benchmark secrets, or `~/.local-code-intelligence` data.

Update [CHANGELOG.md](CHANGELOG.md), bump `package.json` and `package-lock.json` together, tag the exact published commit, verify it with `npm view`, and create a matching GitHub release.

## Pull requests

- Keep changes focused; match the existing module boundaries (`src/discovery`, `src/chunker`, `src/embeddings`, `src/vector-store`, `src/indexer`, `src/search`, `src/retrieval`, `src/benchmark`, `src/mcp`).
- Do not commit `node_modules/`, `dist/`, or anything under `~/.local-code-intelligence`.
- Do not add cloud embedding APIs as the default path; local Ollama is the contract.
- Run `npm run typecheck` and `npm run test:unit` before opening a PR.
- Keep public examples provider-neutral. Do not commit organization-specific endpoints, usernames, paths, source, or benchmark credentials.
- Update documentation when changing CLI commands, MCP tools, privacy boundaries, storage, or watcher behavior.

## Security

Secret-shaped files (`.env*`, keys, credentials) are excluded from indexing by default. Do not weaken those filters without a documented, opt-in config flag.

Do not report vulnerabilities or credential exposure in a public issue. Follow [SECURITY.md](SECURITY.md) and use GitHub private vulnerability reporting.
