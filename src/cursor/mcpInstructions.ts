export const MCP_SERVER_INSTRUCTIONS = `Local code index for repositories on this machine. Replies contain exact, current source.

1. Call get_task_context once with the user's whole request, every part included.
2. If the reply says complete, or answers a single question, answer or edit from it without searching again.
3. If it says incomplete, run only the calls listed under Next, then answer.
4. For more lines, call get_file_context with ranges like "src/a.ts:120-168" (batch several) and the reply's ctx. Do not re-request code you already have.
5. Use search_symbol, search_codebase, or find_references only for what the reply did not cover.

Use Grep/Glob or whole-file reads only for parts marked missing, or a stale or unindexed repo. For a parent folder of several repos, call list_indexed_repos and pass repo. If nothing is indexed, ask the user to run: code-intel setup --repo <path>
`;
