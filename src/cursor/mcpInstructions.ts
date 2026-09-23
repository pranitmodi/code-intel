export const MCP_SERVER_INSTRUCTIONS = `Local code index for repositories on this machine. Code is already embedded and stored locally; only your query is embedded, and results come back ranked and trimmed to a token budget. Use it before scanning files.

1. get_task_context for a new or broad task.
2. search_symbol for a known name, search_codebase for a concept, find_references for occurrences.
3. get_file_context with start_line/end_line before editing.

Fall back to targeted file search only when a result reports low confidence or a stale or unindexed repo. For a parent folder of several repos, call list_indexed_repos and pass repo. If nothing is indexed, ask the user to run: code-intel setup --repo <path>
`;
