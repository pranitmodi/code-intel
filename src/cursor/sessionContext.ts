import { isSameOrInside, type RegistryEntry } from '../indexer/registry.js';

const MAX_LISTED_REPOS = 8;

/**
 * Context injected at the start of every Cursor session. It is paid for on
 * every conversation, so it names only indexed repos that overlap the open
 * workspace and leaves the tool order to the rule and MCP instructions.
 */
export function sessionContext(workspaceRoots: string[], repos: RegistryEntry[]): string {
  const lines = [
    'Local code index active (MCP namespace user-local-code-intelligence). Start with get_task_context or search_symbol, then get_file_context for a line range; avoid repo-wide Grep/Glob first.'
  ];
  const populated = repos.filter((repo) => repo.filesIndexed > 0);
  if (workspaceRoots.length === 0) {
    lines.push(
      populated.length > 0
        ? `${populated.length} repos indexed; call list_indexed_repos to pick one.`
        : 'No repos indexed. Run: code-intel setup --repo <path>'
    );
    return lines.join('\n');
  }

  const relevant = populated.filter((repo) =>
    workspaceRoots.some((root) => isSameOrInside(repo.path, root) || isSameOrInside(root, repo.path))
  );
  if (relevant.length === 0) {
    lines.push(`This workspace is not indexed. Run: code-intel setup --repo ${workspaceRoots[0]}`);
    return lines.join('\n');
  }
  lines.push('Indexed here:');
  for (const repo of relevant.slice(0, MAX_LISTED_REPOS)) {
    lines.push(`- ${repo.name} (${repo.filesIndexed} files) ${repo.path}`);
  }
  if (relevant.length > MAX_LISTED_REPOS) {
    lines.push(`- and ${relevant.length - MAX_LISTED_REPOS} more; call list_indexed_repos.`);
  }
  return lines.join('\n');
}
