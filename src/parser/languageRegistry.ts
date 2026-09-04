export interface LanguageConfig {
  name: string;
  /** Package + wasm filename, resolved via `require.resolve` at load time. */
  wasmModule: string;
  /** tree-sitter node type -> our `symbol_type` label, for nodes that should become their own chunk. */
  symbolNodeTypes: Record<string, string>;
  /** node types that can hold nested symbols and act as `parent_symbol` for them. */
  containerNodeTypes: string[];
}

const TS_LIKE_SYMBOLS: Record<string, string> = {
  function_declaration: 'function',
  class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum'
};
const TS_LIKE_CONTAINERS = ['class_declaration', 'interface_declaration', 'enum_declaration'];

export const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  typescript: {
    name: 'typescript',
    wasmModule: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
    symbolNodeTypes: TS_LIKE_SYMBOLS,
    containerNodeTypes: TS_LIKE_CONTAINERS
  },
  tsx: {
    name: 'tsx',
    wasmModule: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
    symbolNodeTypes: TS_LIKE_SYMBOLS,
    containerNodeTypes: TS_LIKE_CONTAINERS
  },
  javascript: {
    name: 'javascript',
    wasmModule: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
    symbolNodeTypes: {
      function_declaration: 'function',
      class_declaration: 'class',
      method_definition: 'method'
    },
    containerNodeTypes: ['class_declaration']
  },
  python: {
    name: 'python',
    wasmModule: 'tree-sitter-python/tree-sitter-python.wasm',
    symbolNodeTypes: {
      function_definition: 'function',
      class_definition: 'class'
    },
    containerNodeTypes: ['class_definition']
  },
  go: {
    name: 'go',
    wasmModule: 'tree-sitter-go/tree-sitter-go.wasm',
    symbolNodeTypes: {
      function_declaration: 'function',
      method_declaration: 'method',
      type_declaration: 'type'
    },
    containerNodeTypes: []
  },
  bash: {
    name: 'bash',
    wasmModule: 'tree-sitter-bash/tree-sitter-bash.wasm',
    symbolNodeTypes: {
      function_definition: 'function'
    },
    containerNodeTypes: []
  }
};
