export const MCP_SERVER_INSTRUCTIONS = `This server is the primary code-discovery path for Cursor on this machine.

Corpus embeddings already live in local LanceDB (Ollama nomic-embed-text). search_codebase embeds ONLY the user's query locally, then retrieves stored chunks — never re-index or re-embed the tree, and never send vectors to the chat model.

Required order:
1. search_codebase / search_symbol / find_references / get_repo_context
2. get_file_context with a line range for the hit you will edit
3. Grep/Glob/Read only if those tools miss or the path is unindexed

If the workspace is a parent folder, call list_indexed_repos and pass repo (path, id, or name). If nothing is indexed, tell the user to run: code-intel setup --repo <path>.
`;
