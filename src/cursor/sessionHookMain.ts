import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import { listIndexedRepos } from '../indexer/registry.js';
import { sessionContext } from './sessionContext.js';

function readStdin(): { workspace_roots?: string[] } {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as { workspace_roots?: string[] }) : {};
  } catch {
    return {};
  }
}

const input = readStdin();
const workspaceRoots = input.workspace_roots ?? [];
const config = loadConfig({ repoRoot: workspaceRoots[0] });
const repos = listIndexedRepos(config.database.path);

process.stdout.write(JSON.stringify({ additional_context: sessionContext(workspaceRoots, repos) }));
