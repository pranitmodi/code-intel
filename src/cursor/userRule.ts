export const LOCAL_CODE_INTEL_RULE_FILENAME = 'use-local-code-intel.mdc';

export const LOCAL_CODE_INTEL_USER_RULE = [
  '---',
  'description: Use the local code index (local-code-intelligence MCP) before scanning or reading files',
  'alwaysApply: true',
  '---',
  '',
  '# Use the local code index first',
  '',
  'The `local-code-intelligence` MCP server (namespace `user-local-code-intelligence`) already indexes this repository and keeps it current.',
  '',
  '1. `get_task_context` for a new or broad task.',
  '2. `search_symbol` for a known name, `search_codebase` for a concept, `find_references` for occurrences.',
  '3. `get_file_context` with `start_line`/`end_line` for the lines you will edit.',
  '',
  'Do not start with repo-wide Grep/Glob, Task `explore`, or whole-file reads, and never re-embed code. Targeted file search is fine when a result reports low confidence or a stale or unindexed repo. In a parent folder of several repos, call `list_indexed_repos` and pass `repo`; if nothing is indexed, run `code-intel setup --repo <path>`.',
  ''
].join('\n');
