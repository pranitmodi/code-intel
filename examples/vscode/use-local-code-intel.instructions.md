---
name: Local code intelligence
description: 'Retrieve repository context through the local-code-intelligence MCP server before scanning files'
applyTo: '**'
---

# Use the local code index first

The `local-code-intelligence` MCP server already indexes this repository and keeps it current. Only your query is embedded; it returns ranked snippets within a token budget.

1. `get_task_context` for a new or broad task.
2. `search_symbol` for a known name, `search_codebase` for a concept, `find_references` for occurrences.
3. `get_file_context` with `start_line`/`end_line` for the lines you will edit.

Do not start with workspace-wide text search, file globbing, or whole-file reads, and never re-embed code. Targeted file search is fine when a result reports low confidence or a stale or unindexed repo. In a parent folder of several repos, call `list_indexed_repos` and pass `repo`; if nothing is indexed, run `code-intel setup --repo <path>` in the terminal.
