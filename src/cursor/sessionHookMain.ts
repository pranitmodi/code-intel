import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import { listIndexedRepos } from '../indexer/registry.js';

function readStdin(): { workspace_roots?: string[] } {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as { workspace_roots?: string[] }) : {};
  } catch {
    return {};
  }
}

const input = readStdin();
const repoRoot = input.workspace_roots?.[0];
const config = loadConfig({ repoRoot });
const repos = listIndexedRepos(config.database.path);

const lines = repos.slice(0, 12).map((repo) => {
  return `- ${repo.name} (${repo.filesIndexed} files / ${repo.chunksIndexed} chunks)\n  ${repo.path}`;
});

const parts = [
  'LOCAL CODE INDEX is active. Corpus embeddings already live in LanceDB (Ollama nomic-embed-text). Do not re-embed source or tree-scan.',
  'MCP namespace: user-local-code-intelligence. First tools: search_codebase (query embedded locally; stored vectors retrieve snippets), search_symbol, get_file_context with a line range.',
  'Forbidden first moves: Grep, Glob, Task explore, dumping whole files.',
  repos.length > 0
    ? `Indexed repos:\n${lines.join('\n')}`
    : 'No repos indexed. Run: code-intel setup --repo <path>'
];

if (input.workspace_roots?.length) {
  parts.push(`Workspace: ${input.workspace_roots.join(', ')}`);
}

process.stdout.write(JSON.stringify({ additional_context: parts.join('\n\n') }));
