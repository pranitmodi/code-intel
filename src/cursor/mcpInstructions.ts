export const MCP_SERVER_INSTRUCTIONS = `This server is the primary code-discovery path for Cursor on this machine.

Corpus embeddings already live in local LanceDB (Ollama nomic-embed-text). Only the search query is embedded locally; stored vectors retrieve snippets — never re-index or re-embed the tree, and never send vectors to the chat model.

Required order:
1. For a new or broad coding task, use get_task_context.
2. For a known symbol, use search_symbol.
3. For conceptual exploration, use search_codebase.
4. For call-site analysis, use find_references.
5. Use get_file_context for exact source ranges.
6. Avoid workspace-wide Grep/Glob unless retrieval returned low confidence, the index is stale/unindexed, or those tools genuinely cannot answer.

If the workspace is a parent folder, call list_indexed_repos and pass repo (path, id, or name). If nothing is indexed, tell the user to run: code-intel setup --repo <path>.
`;
