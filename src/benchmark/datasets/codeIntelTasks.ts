export interface BenchmarkTask {
  id: string;
  prompt: string;
  category:
    | 'known-symbol'
    | 'conceptual'
    | 'feature'
    | 'bug'
    | 'refactor'
    | 'cross-cutting'
    | 'tests'
    | 'configuration';
  relevantFiles: string[];
  relevantSymbols?: string[];
  /** 0 irrelevant … 3 essential, keyed by file path. */
  relevanceLevels?: Record<string, 0 | 1 | 2 | 3>;
}

export const CODE_INTEL_TASKS: BenchmarkTask[] = [
  {
    id: 'known-search-codebase',
    category: 'known-symbol',
    prompt: 'Where is searchCodebase implemented?',
    relevantFiles: ['src/search/searchCodebase.ts'],
    relevantSymbols: ['searchCodebase'],
    relevanceLevels: {
      'src/search/searchCodebase.ts': 3,
      'src/retrieval/hybrid.ts': 2,
      'src/mcp/server.ts': 1
    }
  },
  {
    id: 'conceptual-hybrid-search',
    category: 'conceptual',
    prompt: 'How does hybrid semantic and keyword ranking work?',
    relevantFiles: ['src/search/searchCodebase.ts', 'src/retrieval/hybrid.ts', 'src/retrieval/score.ts'],
    relevantSymbols: ['hybridSearch', 'combineScore'],
    relevanceLevels: {
      'src/retrieval/hybrid.ts': 3,
      'src/retrieval/score.ts': 3,
      'src/search/searchCodebase.ts': 2
    }
  },
  {
    id: 'feature-task-context',
    category: 'feature',
    prompt: 'Add rate limiting around get_task_context and update the tests.',
    relevantFiles: ['src/retrieval/taskContext.ts', 'src/mcp/server.ts'],
    relevantSymbols: ['getTaskContext'],
    relevanceLevels: {
      'src/retrieval/taskContext.ts': 3,
      'src/mcp/server.ts': 2,
      'src/retrieval/intent.ts': 1
    }
  },
  {
    id: 'bug-stale-index',
    category: 'bug',
    prompt: 'Fix stale index detection when discoverable file counts drift.',
    relevantFiles: ['src/indexer/status.ts'],
    relevantSymbols: ['getIndexStatus'],
    relevanceLevels: { 'src/indexer/status.ts': 3, 'src/indexer/Indexer.ts': 1 }
  },
  {
    id: 'refactor-search-ranking',
    category: 'refactor',
    prompt: 'Move ranking weights out of searchCodebase into a dedicated scorer.',
    relevantFiles: ['src/retrieval/score.ts', 'src/search/searchCodebase.ts'],
    relevantSymbols: ['combineScore'],
    relevanceLevels: {
      'src/retrieval/score.ts': 3,
      'src/search/searchCodebase.ts': 2,
      'src/config/types.ts': 1
    }
  },
  {
    id: 'cross-cutting-mcp-instructions',
    category: 'cross-cutting',
    prompt: 'Add request IDs to MCP tool responses and the Cursor skill instructions.',
    relevantFiles: ['src/mcp/server.ts', 'src/cursor/mcpInstructions.ts', 'src/cursor/skill.ts'],
    relevanceLevels: {
      'src/mcp/server.ts': 3,
      'src/cursor/mcpInstructions.ts': 2,
      'src/cursor/skill.ts': 2
    }
  },
  {
    id: 'tests-tree-scan',
    category: 'tests',
    prompt: 'Find the tests that cover workspace-wide Grep and Glob denial.',
    relevantFiles: ['tests/unit/tree-scan-policy.test.ts', 'src/cursor/treeScanPolicy.ts'],
    relevantSymbols: ['shouldDenyTreeScan'],
    relevanceLevels: {
      'tests/unit/tree-scan-policy.test.ts': 3,
      'src/cursor/treeScanPolicy.ts': 2
    }
  },
  {
    id: 'config-embedding',
    category: 'configuration',
    prompt: 'Where is the default embedding model and search weight configuration?',
    relevantFiles: ['src/config/defaults.ts', 'src/config/types.ts'],
    relevanceLevels: {
      'src/config/defaults.ts': 3,
      'src/config/types.ts': 2,
      'src/config/load.ts': 1
    }
  }
];
