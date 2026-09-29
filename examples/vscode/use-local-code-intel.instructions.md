---
name: Local code intelligence
description: 'Retrieve repository context through the local-code-intelligence MCP server before scanning files'
applyTo: '**'
---

# Use the local code index first

The `local-code-intelligence` MCP server indexes this repository and keeps it current. Its replies contain exact, current source.

1. Call `get_task_context` once with the user's whole request.
2. If it says `complete`, or answers a single question, answer or edit from it without more searching.
3. If it says `incomplete`, run only its `Next` calls, then answer.
4. For more lines, call `get_file_context` with `ranges` like `path:120-168`, batched, plus `ctx`. Never re-read code you already have.

Use workspace-wide text search, file globbing, or whole-file reads only for parts marked `missing`, or a stale or unindexed repo. In a parent folder of several repos, call `list_indexed_repos` and pass `repo`; if nothing is indexed, run `code-intel setup --repo <path>` in the terminal.
