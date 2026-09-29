import { createRequire } from 'node:module';
import { Language, Node, Parser } from 'web-tree-sitter';
import { chunkTree, STRUCTURAL_RULES } from '../chunker/structural.js';
import type { CodeChunk } from '../chunker/types.js';
import { LANGUAGE_CONFIGS, type LanguageConfig } from './languageRegistry.js';

const require = createRequire(import.meta.url);

let initialized: Promise<void> | undefined;
const languageCache = new Map<string, Language>();

async function ensureInitialized(): Promise<void> {
  if (!initialized) initialized = Parser.init();
  await initialized;
}

async function loadLanguage(config: LanguageConfig): Promise<Language> {
  const cached = languageCache.get(config.name);
  if (cached) return cached;
  await ensureInitialized();
  const wasmPath = require.resolve(config.wasmModule);
  const language = await Language.load(wasmPath);
  languageCache.set(config.name, language);
  return language;
}

export interface ParseStructuralOptions {
  /** Largest chunk, in characters; bigger declarations split at statement boundaries. */
  maxChars?: number;
}

/** Returns null when no Tree-sitter grammar is wired up for this language — caller should fall back to text chunking. */
export async function parseStructural(
  content: string,
  languageName: string,
  options: ParseStructuralOptions = {}
): Promise<CodeChunk[] | null> {
  const config = LANGUAGE_CONFIGS[languageName];
  if (!config) return null;
  const rules = STRUCTURAL_RULES[languageName];

  const language = await loadLanguage(config);
  // Parsers and trees live in WASM memory that the JS garbage collector never
  // frees, so both must be deleted explicitly or a long-running watcher leaks.
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (!tree) return null;
    try {
      if (rules && options.maxChars) {
        return chunkTree(tree.rootNode, content, rules, { maxChars: options.maxChars });
      }
      const types = Object.keys(config.symbolNodeTypes);
      const nodes = tree.rootNode.descendantsOfType(types);
      return nodes.filter((node): node is Node => Boolean(node)).map((node) => buildChunk(node, config));
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

function buildChunk(node: Node, config: LanguageConfig): CodeChunk {
  return {
    symbolName: node.childForFieldName('name')?.text ?? null,
    symbolType: config.symbolNodeTypes[node.type] ?? 'symbol',
    parentSymbol: findParentSymbol(node, config),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    content: node.text
  };
}

function findParentSymbol(node: Node, config: LanguageConfig): string | null {
  let current = node.parent;
  while (current) {
    if (config.containerNodeTypes.includes(current.type)) {
      return current.childForFieldName('name')?.text ?? null;
    }
    current = current.parent;
  }
  return null;
}
