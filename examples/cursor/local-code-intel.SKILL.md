---
name: local-code-intel
description: >-
  Find code, symbols, and repository context through the local-code-intelligence
  MCP server (a local, always-current index) instead of Grep/Glob or reading whole
  files. Use when locating code, exploring a repository, or answering where or how
  something works.
---

# Local code intelligence

MCP namespace: `user-local-code-intelligence`. Only the query is embedded; results are ranked snippets within a token budget.

1. `get_task_context` for a new or broad task (`repo` picks a child repo; `mode` `minimal` for a quick look, `deep` for cross-cutting work).
2. `search_symbol` for a known name, `search_codebase` for a concept (`max_tokens` 800–1500), `find_references` for occurrences.
3. `get_file_context` with a line range for the code you will change.
4. Grep/Glob/Read a specific file or directory only after these miss or report low confidence or a stale or unindexed repo.

If `index_status` reports the repo unindexed, run `code-intel setup --repo <path>` and retry.
