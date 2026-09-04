---
name: local-code-intel
description: >-
  Routes codebase search, symbol lookup, and repo orientation through the
  local-code-intelligence MCP (LanceDB + local Ollama embeddings). Use whenever
  finding code, exploring a repository, indexing, or answering where/how
  something works. Never Grep/Glob/Task-explore first and never re-embed the corpus.
---

# Local code intelligence

Corpus embeddings already live in local LanceDB. Ollama (`nomic-embed-text`) embeds **only the search query**. Retrieved snippets go to the chat model — not vectors, not the whole tree.

## MCP namespace

`user-local-code-intelligence`

## Required order

1. `search_codebase` with `max_tokens` 800–1500 (optional `repo` for Savor children)
2. `search_symbol` / `find_references` when you have a name
3. `get_file_context` with a line range for the hit you will change
4. Grep/Glob/Read only after those miss, and only on a specific file or subdirectory

If `index_status` says unindexed, run `code-intel setup --repo <path>` via Shell, then search again.
