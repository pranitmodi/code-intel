# code-intel

AI coding agents burn tokens re-scanning your repository every turn. **code-intel** indexes the tree once with local [Ollama](https://ollama.com) embeddings, stores vectors on disk in [LanceDB](https://lancedb.github.io/lancedb/), and serves targeted snippets over the [Model Context Protocol](https://modelcontextprotocol.io) so Cursor, VS Code, Claude Code, Codex, or any MCP client can search without dumping the whole codebase into context.

Source code, embeddings, and the vector database never leave your machine. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.

A local-first semantic code indexing and retrieval server. It indexes a repository into a local vector database once, keeps that index incrementally in sync as files change, and exposes semantic + keyword + symbol search to AI coding agents.

## What it does

- Parses your repository with Tree-sitter and chunks it at structural boundaries (functions, classes, methods, interfaces, ...), not fixed character windows.
- Embeds each chunk locally via **Ollama** and stores vectors + metadata in a local **LanceDB** database.
- Re-indexes incrementally: unchanged files/chunks are never re-embedded; only new or edited chunks are.
- Serves `search_codebase`, `search_symbol`, `get_file_context`, `get_repo_context`, `find_references`, `list_indexed_repos`, and `index_status` as MCP tools over stdio, so any MCP-capable IDE/agent can query the same persistent index instead of re-scanning or re-embedding the repository itself.

## Architecture

```text
Git Repo -> Discovery -> Parser/Chunker -> Hasher -> Embedding Provider (Ollama) -> LanceDB
                                                                                       |
                                                              MCP Server (stdio) <-----+
                                                                       |
                                                    Cursor / VS Code / Claude Code / Codex
```

Each stage is an independent module (`src/discovery`, `src/parser`, `src/chunker`, `src/hashing`, `src/embeddings`, `src/vector-store`, `src/indexer`, `src/search`, `src/mcp`, `src/cli`) so the embedding provider or vector database can be swapped without touching the others.

## Installation

Requires Node.js 20+ and [Ollama](https://ollama.com/download).

```bash
npm install -g @pranitmodi/code-intel
ollama pull nomic-embed-text
code-intel doctor
code-intel cursor-install          # wires Cursor MCP + the local-search rule
cd /path/to/your-project
code-intel setup                   # index this repo locally
```

The package is scoped (`@pranitmodi/code-intel`) because npm rejected unscoped `code-intel` as too similar to existing [`codeintel`](https://www.npmjs.com/package/codeintel). The installed command is still `code-intel`.

Reload MCP in Cursor (Settings → MCP). After that, agents query the local index instead of re-scanning the tree.

Without a global install you can use `npx`:

```bash
npx -y @pranitmodi/code-intel doctor
npx -y @pranitmodi/code-intel setup --repo /path/to/your-project
npx -y @pranitmodi/code-intel cursor-install
```

From a git checkout (contributors):

```bash
npm install
npm run build
npm link
```

## Ollama setup

```bash
ollama pull nomic-embed-text   # default embedding model, ~274MB
```

`code-intel doctor` verifies Ollama is reachable and the model is present.

## Initial indexing

From the root of the repository you want to index:

```bash
cd /path/to/your-project
code-intel setup     # scaffold + index in one step
code-intel status    # files/chunks indexed, database size, staleness check
```

Or the two-step form: `code-intel init` then `code-intel index`.

The index lives outside your repo by default (see **Database location**), so nothing is written into your project and no `.gitignore` changes are needed.

Re-run `code-intel index` any time after editing files — only new/changed chunks are re-embedded. The MCP server starts incremental watchers by default for every indexed repo under the workspace (including child projects in a parent folder). Edits are re-indexed after a quiet period (`indexing.debounce_ms`, default 1s), and unchanged chunks are never re-embedded. `code-intel watch` is the same loop as a standalone process; `code-intel mcp --no-watch` or `indexing.watch: false` turns it off.

## CLI usage

```text
code-intel setup                   scaffold + index in one step
code-intel init                    scaffold the index location
code-intel index                   full/incremental index
code-intel watch                   incremental re-index on file changes
code-intel repos                   list every locally indexed repository
code-intel search "<query>"        hybrid semantic+keyword+symbol search
code-intel symbol <name>           exact/fuzzy symbol lookup
code-intel file <path> [--start N --end M]   exact source content
code-intel status                  repo/index status
code-intel doctor                  diagnose Ollama/model/database health
code-intel rebuild                 wipe and fully re-index
code-intel clean                   remove the local index (not your source)
code-intel cursor-install          merge ~/.cursor/mcp.json and write the user rule
code-intel mcp                     start the MCP server over stdio (watch on by default)
code-intel mcp --no-watch          start the MCP server without file watchers
code-intel savings                 estimate token/$ savings vs tree scans
code-intel savings --benchmark     re-run the Grep vs search A/B on indexed repos
```

Every command accepts `--repo <path>` to target a repository other than the current directory — this is what makes MCP configuration below work regardless of the IDE's spawn working directory.

## Measuring savings

`code-intel savings` compares local retrieval to a typical agent tree scan (workspace Glob + `rg -C 2` + reading the first 12 matching files). It does **not** see Cursor's invoice; it estimates input tokens that never reach the model.

```bash
code-intel savings --benchmark --rate 3 --turns 15
```

`--benchmark` runs that A/B on every indexed repo (needs Ollama and `rg`). Live MCP searches and blocked workspace Grep/Glob (from `cursor-install` hooks) append to `~/.local-code-intelligence/usage.jsonl`. Re-run `code-intel savings` after a real coding session to see session totals. Dollar figures use `--rate` as dollars per million **input** tokens (default `$3`, a Sonnet-class list price). `--turns` compounds a dump that would have stayed in the chat.

## MCP configuration

### VS Code

Add to `.vscode/mcp.json` in your project (see [examples/mcp/vscode.mcp.json](examples/mcp/vscode.mcp.json)):

```json
{
  "servers": {
    "local-code-intelligence": {
      "command": "code-intel",
      "args": ["mcp", "--repo", "${workspaceFolder}"]
    }
  }
}
```

Reload/trust the server when prompted, then ask Copilot Chat to use the tools (or let it pick them up automatically).

### Cursor

The reliable setup after `npm install -g code-intel` (or `npm link` from a checkout):

```bash
code-intel cursor-install
```

That merges `~/.cursor/mcp.json` (it will not drop other MCP servers), writes an always-on user rule and skill, and installs hooks that:

- Inject the indexed-repo list at session start
- Block workspace-wide Grep/Glob and Task `explore` so the agent has to hit `search_codebase` first

Then reload MCP in Cursor (Settings → MCP).

The checked-in example is [examples/mcp/cursor.mcp.json](examples/mcp/cursor.mcp.json) (`code-intel mcp --repo ${workspaceFolder}`). `cursor-install` writes an equivalent server entry that points at the installed package's `dist/cli/index.js` (so Cursor does not need `code-intel` on its GUI `PATH`). Tools accept an optional `repo` (path, id, or basename) so a parent workspace can query indexed children. The server starts file watchers for those indexed repos by default so new and edited code is chunked incrementally.

Note the different top-level key (`mcpServers` vs VS Code's `servers`) — this is a real difference between the two clients' config formats, not a typo.

Both IDEs will then list `search_codebase`, `search_symbol`, `get_file_context`, `get_repo_context`, `find_references`, `list_indexed_repos`, and `index_status` as available tools, backed by the index you already built with `code-intel setup` — the agent never re-scans or re-embeds your repository itself.

## Database location

Default: `~/.local-code-intelligence/repos/<repo-id>/{db,metadata,state.json,logs}`, where `<repo-id>` is a SHA-256 hash of the repository's real absolute path. A `registry.json` in the same home directory maps those ids back to paths and names (`code-intel repos`). Override via `database.path` in config or the `CODE_INTEL_DB_PATH` environment variable. If you point it inside the repo, the directory is automatically added to `.gitignore`.

## Privacy guarantees

- Source code, chunks, embeddings, and the vector database stay on this machine.
- No telemetry, no cloud APIs, no source-code uploads by default.
- `.env*`, private keys, and other secret-shaped files are excluded by default (`security.allow_sensitive_files: false`); files with likely secret *values* are skipped even if their name would otherwise be allowed.

## Configuration

`.code-intel/config.yaml` (repo-level) or `~/.local-code-intelligence/config.yaml` (global), merged over built-in defaults, then overridden by environment variables (`CODE_INTEL_EMBEDDING_MODEL`, `CODE_INTEL_EMBEDDING_HOST`, `CODE_INTEL_DB_PATH`, `CODE_INTEL_WATCH`):

```yaml
embedding:
  model: nomic-embed-text
  host: http://127.0.0.1:11434
  batch_size: 32
database:
  path: ~/.local-code-intelligence
indexing:
  max_chunk_tokens: 800
  chunk_overlap: 100
  debounce_ms: 1000
  watch: true
search:
  default_limit: 10
  vector_weight: 0.7
  keyword_weight: 0.2
  symbol_weight: 0.1
security:
  allow_sensitive_files: false
ignore: []
```

## Troubleshooting

- `code-intel doctor` — checks Ollama reachability, model presence, and index-directory write access.
- "Model not found" — run `ollama pull <model>` for whatever `embedding.model` is configured.
- MCP tools not appearing — reload the IDE's MCP servers list; check the IDE's MCP output/log panel for the spawned process's stderr.
- Switching embedding models requires `code-intel rebuild` (a different model produces vectors in a different space).

## Performance considerations

- Structural chunking with per-chunk content hashing means only edited chunks are re-embedded, not the whole file.
- No automatic vector ANN index is built by default — brute-force kNN is fine up to a few hundred thousand chunks; add one later if a repository grows beyond that.
- A single-writer PID lock file prevents two `index`/`watch` processes from corrupting the same repo's index concurrently. The `mcp` command reads the index and, by default, incrementally writes when watched files change.

## Development

```bash
npm run typecheck
npm test
npm run dev -- <command>   # run the CLI from source via tsx, no build step
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor workflow. `tests/fixtures/test-repo` plus `tests/integration/acceptance.test.ts` and `tests/integration/mcp.test.ts` exercise the full spec acceptance scenario end-to-end against a real local Ollama model (skipped automatically if Ollama/the model isn't available).

## Known gaps

- Structural (Tree-sitter) chunking currently covers TypeScript/TSX, JavaScript, Python, Go, and Bash; other languages from the spec's list still get correctly tagged and indexed, just via generic text chunking rather than symbol-level chunks.
- `find_references` is a textual occurrence scan, not full semantic reference resolution.
