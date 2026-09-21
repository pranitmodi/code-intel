export const LOCAL_CODE_INTEL_RULE_FILENAME = 'use-local-code-intel.mdc';

export const LOCAL_CODE_INTEL_USER_RULE = [
  '---',
  'description: Mandatory local LanceDB/Ollama code search via MCP — never tree-scan or re-embed first',
  'alwaysApply: true',
  '---',
  '',
  '# Local code index is mandatory',
  '',
  'MCP namespace: `user-local-code-intelligence`. The corpus is already embedded in local LanceDB with Ollama (`nomic-embed-text`). The chat model must not re-embed or re-index source.',
  '',
  '## Always do this first',
  '',
  '1. For a new or broad coding task, `get_task_context`. Only the query is embedded locally; stored vectors retrieve snippets.',
  '2. `search_symbol` for a known name; `search_codebase` for conceptual exploration; `find_references` for occurrences.',
  '3. `get_file_context` with `start_line`/`end_line` for the range you will edit.',
  '4. `get_repo_context` / `list_indexed_repos` / `index_status` for orientation.',
  '',
  '## Never do this first',
  '',
  '- Grep, Glob, or Task `explore` across the repo',
  '- Read whole files to "see how it works"',
  '- Ask the cloud model to embed or index code',
  '',
  'If retrieval reports low confidence, the index is stale, or the path is unindexed, targeted filesystem search is allowed. If the workspace is a parent of indexed repos, `list_indexed_repos` and pass `repo`. If unindexed, run `code-intel setup --repo <path>` via Shell, then search again.',
  ''
].join('\n');
