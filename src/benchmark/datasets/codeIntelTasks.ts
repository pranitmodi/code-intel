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
  /** `qa` asks for an explanation; `change` asks for an edit. */
  kind?: 'qa' | 'change';
  /**
   * Files a complete answer cannot do without. The first reply's coverage of
   * these decides how much follow-up an agent needs. Defaults to relevantFiles.
   */
  essentialFiles?: string[];
  /** The separate parts of a multi-part request and the files that answer each. */
  facets?: Array<{ id: string; label: string; files: string[] }>;
}

/**
 * Multi-part questions of the kind that made agents spend more tokens with the
 * index than without it: the first reply must cover every part, not only the
 * best-matching one. Labels reflect the current source tree.
 */
export const CROSS_CUTTING_TASKS: BenchmarkTask[] = [
  {
    id: 'vscode-install-ab',
    category: 'cross-cutting',
    kind: 'qa',
    prompt:
      'Explain how `code-intel vscode-install` configures VS Code: how it copes with nvm and a GUI-launched VS Code that lacks the shell PATH, user versus workspace installation, single-folder versus multi-root windows, prompting for OpenAI-compatible embedding credentials, system CA settings, preserving JSONC comments and other MCP servers in mcp.json, and what happens when --repo is missing or unusable.',
    relevantFiles: [
      'src/vscode/install.ts',
      'src/cli/index.ts',
      'src/editors/mcpConfig.ts',
      'src/editors/jsonc.ts',
      'src/editors/cliEntry.ts',
      'src/cli/repoOption.ts',
      'src/corporate/systemCa.ts'
    ],
    relevantSymbols: ['installVscodeIntegration', 'upsertMcpServer', 'setJsoncValue', 'repoOptionPath', 'cursorSystemCaEnv'],
    relevanceLevels: {
      'src/vscode/install.ts': 3,
      'src/cli/index.ts': 3,
      'src/editors/mcpConfig.ts': 3,
      'src/editors/jsonc.ts': 3,
      'src/cli/repoOption.ts': 3,
      'src/corporate/systemCa.ts': 2,
      'src/editors/cliEntry.ts': 2,
      'src/mcp/runtime.ts': 1,
      'src/vscode/instructions.ts': 1
    },
    facets: [
      { id: 'command', label: 'vscode-install command', files: ['src/cli/index.ts', 'src/vscode/install.ts'] },
      { id: 'gui-path', label: 'nvm and GUI PATH', files: ['src/vscode/install.ts', 'src/editors/cliEntry.ts'] },
      { id: 'scope', label: 'user vs workspace scope', files: ['src/vscode/install.ts'] },
      { id: 'multi-root', label: 'single-folder vs multi-root', files: ['src/vscode/install.ts', 'src/cli/repoOption.ts'] },
      { id: 'credentials', label: 'credential prompts', files: ['src/vscode/install.ts'] },
      { id: 'system-ca', label: 'system CA', files: ['src/corporate/systemCa.ts'] },
      { id: 'jsonc', label: 'JSONC comment preservation', files: ['src/editors/jsonc.ts'] },
      { id: 'other-servers', label: 'other MCP servers kept', files: ['src/editors/mcpConfig.ts'] },
      { id: 'repo-flag', label: 'missing or unusable --repo', files: ['src/cli/repoOption.ts', 'src/cli/index.ts'] }
    ]
  },
  {
    id: 'cursor-scan-denial',
    category: 'cross-cutting',
    kind: 'qa',
    prompt:
      'How does code-intel stop Cursor agents from running repo-wide Grep and Glob, when are they allowed again after a low-confidence retrieval, and how are denied scans counted in the savings report?',
    relevantFiles: [
      'src/cursor/treeScanPolicy.ts',
      'src/cursor/preferHookMain.ts',
      'src/retrieval/fallback.ts',
      'src/usage/record.ts'
    ],
    relevantSymbols: ['shouldDenyTreeScan', 'grantFilesystemFallback', 'recordDeniedScan'],
    relevanceLevels: {
      'src/cursor/treeScanPolicy.ts': 3,
      'src/cursor/preferHookMain.ts': 3,
      'src/retrieval/fallback.ts': 3,
      'src/usage/record.ts': 2,
      'src/cursor/hooks.ts': 1
    },
    facets: [
      { id: 'deny', label: 'repo-wide Grep/Glob denial', files: ['src/cursor/treeScanPolicy.ts', 'src/cursor/preferHookMain.ts'] },
      { id: 'fallback', label: 'fallback after low confidence', files: ['src/retrieval/fallback.ts'] },
      { id: 'savings', label: 'denied scans in savings', files: ['src/usage/record.ts'] }
    ]
  },
  {
    id: 'save-to-search',
    category: 'cross-cutting',
    kind: 'qa',
    prompt:
      'After I save a file in the editor, how does the change reach search results, and when does the server report the index as stale?',
    relevantFiles: [
      'src/indexer/watch.ts',
      'src/mcp/watchOnStart.ts',
      'src/indexer/Indexer.ts',
      'src/indexer/status.ts',
      'src/mcp/freshness.ts'
    ],
    relevantSymbols: ['watchRepo', 'startWorkspaceWatchers', 'runChangedPaths', 'getIndexFreshness'],
    relevanceLevels: {
      'src/indexer/watch.ts': 3,
      'src/mcp/watchOnStart.ts': 3,
      'src/indexer/Indexer.ts': 2,
      'src/indexer/status.ts': 2,
      'src/mcp/freshness.ts': 2,
      'src/indexer/freshness.ts': 1
    },
    facets: [
      { id: 'watch', label: 'file watcher', files: ['src/indexer/watch.ts', 'src/mcp/watchOnStart.ts'] },
      { id: 'reindex', label: 'incremental re-index', files: ['src/indexer/Indexer.ts'] },
      { id: 'stale', label: 'stale reporting', files: ['src/indexer/status.ts', 'src/mcp/freshness.ts'] }
    ]
  },
  {
    id: 'parent-folder-resolution',
    category: 'cross-cutting',
    kind: 'qa',
    prompt:
      'Which repository does the MCP server use when a tool call has no repo argument and the editor opened a parent folder of several indexed repos, or a subfolder of one?',
    relevantFiles: ['src/mcp/runtime.ts', 'src/indexer/registry.ts', 'src/mcp/watchOnStart.ts'],
    relevantSymbols: ['createMcpRuntime', 'containingRepoPath', 'indexedChildrenOf', 'watchTargetsForWorkspace'],
    relevanceLevels: {
      'src/mcp/runtime.ts': 3,
      'src/indexer/registry.ts': 3,
      'src/mcp/watchOnStart.ts': 2
    },
    facets: [
      { id: 'default', label: 'default target without repo', files: ['src/mcp/runtime.ts'] },
      { id: 'parent', label: 'parent folder of indexed repos', files: ['src/indexer/registry.ts', 'src/mcp/runtime.ts'] },
      { id: 'subfolder', label: 'subfolder of an indexed repo', files: ['src/indexer/registry.ts'] }
    ]
  },
  {
    id: 'embedding-failures',
    category: 'cross-cutting',
    kind: 'qa',
    prompt:
      'What happens during indexing when the OpenAI-compatible embedding endpoint times out, rate-limits, or rejects a chunk as too large, and what does the CLI tell the user?',
    relevantFiles: [
      'src/embeddings/OpenAICompatibleEmbeddingProvider.ts',
      'src/indexer/Indexer.ts',
      'src/cli/formatCliFailure.ts'
    ],
    relevantSymbols: ['isEmbeddingInputTooLargeError', 'formatCliFailure'],
    relevanceLevels: {
      'src/embeddings/OpenAICompatibleEmbeddingProvider.ts': 3,
      'src/indexer/Indexer.ts': 2,
      'src/cli/formatCliFailure.ts': 2
    },
    facets: [
      { id: 'retry', label: 'timeouts and rate limits', files: ['src/embeddings/OpenAICompatibleEmbeddingProvider.ts'] },
      { id: 'too-large', label: 'input too large', files: ['src/embeddings/OpenAICompatibleEmbeddingProvider.ts', 'src/indexer/Indexer.ts'] },
      { id: 'cli', label: 'CLI failure message', files: ['src/cli/formatCliFailure.ts'] }
    ]
  },
  {
    id: 'chunk-identity',
    category: 'cross-cutting',
    kind: 'qa',
    prompt:
      'How are chunk ids computed, and when does re-indexing reuse an existing embedding instead of calling the embedding provider?',
    relevantFiles: ['src/hashing/hash.ts', 'src/indexer/Indexer.ts', 'src/chunker/chunker.ts'],
    relevantSymbols: ['computeChunkId', 'hashChunkContent'],
    relevanceLevels: {
      'src/hashing/hash.ts': 3,
      'src/indexer/Indexer.ts': 3,
      'src/chunker/chunker.ts': 1
    },
    facets: [
      { id: 'ids', label: 'chunk id computation', files: ['src/hashing/hash.ts', 'src/indexer/Indexer.ts'] },
      { id: 'reuse', label: 'embedding reuse', files: ['src/indexer/Indexer.ts'] }
    ]
  },
  {
    id: 'index-lock',
    category: 'cross-cutting',
    kind: 'qa',
    prompt:
      'How do two processes avoid writing the same index at the same time, and how is a lock left behind by a crashed process recovered?',
    relevantFiles: ['src/indexer/lock.ts', 'src/indexer/Indexer.ts', 'src/vector-store/LanceVectorStore.ts'],
    relevantSymbols: ['acquireLock', 'IndexerLockedError', 'syncLatest'],
    relevanceLevels: {
      'src/indexer/lock.ts': 3,
      'src/indexer/Indexer.ts': 2,
      'src/vector-store/LanceVectorStore.ts': 1
    },
    facets: [
      { id: 'lock', label: 'cross-process writer lock', files: ['src/indexer/lock.ts'] },
      { id: 'stale-lock', label: 'crashed-process recovery', files: ['src/indexer/lock.ts'] },
      { id: 'sync', label: 'latest table version before writing', files: ['src/vector-store/LanceVectorStore.ts', 'src/indexer/Indexer.ts'] }
    ]
  }
];

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
