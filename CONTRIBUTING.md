# Contributing to code-intel

Thanks for helping. The goal of this project is a **local-first** code index: embeddings and source stay on the contributor's machine, and AI agents query that index over MCP instead of re-scanning the tree.

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
npm install
npm run build
npm test
```

Unit tests in `tests/unit` never need Ollama. Integration tests in `tests/integration` talk to a real local model and **skip automatically** when Ollama or `nomic-embed-text` is missing.

```bash
npm run typecheck
npm run test:unit          # CI default
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

## Publishing (maintainers)

```bash
npm login
npm publish --access public
```

The package name is `@pranitmodi/code-intel` (scoped; unscoped `code-intel` is blocked by npm as too similar to `codeintel`).

`prepublishOnly` builds `dist/` and runs unit tests. The tarball includes `dist/` plus README and LICENSE; indexes under `~/.local-code-intelligence` are never published.

## Pull requests

- Keep changes focused; match the existing module boundaries (`src/discovery`, `src/chunker`, `src/embeddings`, `src/vector-store`, `src/indexer`, `src/search`, `src/mcp`).
- Do not commit `node_modules/`, `dist/`, or anything under `~/.local-code-intelligence`.
- Do not add cloud embedding APIs as the default path; local Ollama is the contract.
- Run `npm run typecheck` and `npm run test:unit` before opening a PR.

## Security

Secret-shaped files (`.env*`, keys, credentials) are excluded from indexing by default. Do not weaken those filters without a documented, opt-in config flag.
