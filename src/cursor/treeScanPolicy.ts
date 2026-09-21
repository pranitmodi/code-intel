export interface TreeScanInput {
  hook_event_name?: string;
  tool_name?: string;
  subagent_type?: string;
  cwd?: string;
  workspace_roots?: string[];
  tool_input?: Record<string, unknown>;
}

const EXPLORE_TASK =
  /\b(explor(e|ing)|search the (code|repo|codebase)|find where|how does)\b/i;

export const TREE_SCAN_DENY_MESSAGE =
  'Use MCP user-local-code-intelligence first (get_task_context / search_codebase / search_symbol / get_file_context). Corpus embeddings already live in local LanceDB; Ollama only embeds the query. Grep/Glob/explore is allowed after those tools miss, after low-confidence retrieval, or against a specific file or subdirectory — not the whole repo.';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function resolveWorkspaceRoots(input: TreeScanInput): string[] {
  const roots = [...(input.workspace_roots ?? [])];
  if (input.cwd) roots.push(input.cwd);
  return [...new Set(roots.filter(Boolean))];
}

export function looksLikeFile(target: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(target);
}

export function isWorkspaceRoot(target: string | undefined, roots: string[]): boolean {
  if (!target) return true;
  const normalized = target.replace(/\/+$/, '');
  return roots.some((root) => normalized === root.replace(/\/+$/, '') || normalized === '.');
}

export interface TreeScanPolicyOptions {
  /** When true, workspace-wide Grep/Glob is allowed (low-confidence / stale / unindexed retrieval). Explore tasks stay denied. */
  allowFallback?: boolean;
}

export function shouldDenyTreeScan(input: TreeScanInput, options: TreeScanPolicyOptions = {}): boolean {
  const event = input.hook_event_name ?? '';
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};
  const roots = resolveWorkspaceRoots(input);

  if (event === 'subagentStart' || (input.subagent_type && !tool)) {
    return input.subagent_type === 'explore';
  }

  if (tool === 'Task') {
    const sub = asString(args.subagent_type) || asString(args.subagentType);
    const blob = [args.description, args.prompt, args.task].map(asString).join(' ');
    return sub === 'explore' || EXPLORE_TASK.test(blob);
  }

  if (options.allowFallback && (tool === 'Grep' || tool === 'Glob')) {
    return false;
  }

  if (tool === 'Grep') {
    const target = asString(args.path) || asString(args.target_directory);
    return !looksLikeFile(target) && isWorkspaceRoot(target || undefined, roots);
  }

  if (tool === 'Glob') {
    const target = asString(args.target_directory);
    const pattern = asString(args.glob_pattern) || asString(args.globPattern);
    const broadPattern = !pattern || pattern.includes('**') || pattern === '*' || pattern === '*.*';
    return broadPattern && isWorkspaceRoot(target || undefined, roots);
  }

  return false;
}
