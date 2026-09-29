export interface ChunkExtraMetadata {
  imports: string[];
  exports: string[];
  referencedSymbols: string[];
  isTest: boolean;
  isConfig: boolean;
  /** Chunker version that produced the chunk; absent before version 3. */
  v?: number;
  /** Declaration up to its body. */
  signature?: string;
  /** Functions and methods the chunk calls. */
  calls?: string[];
  /** Code-shaped string literals: command names, flags, env keys, routes. */
  literals?: string[];
  /** For a class header: its members with line ranges (`run:L12-40`). */
  defines?: string[];
}

export interface StructuralFacts {
  signature?: string;
  calls?: string[];
  literals?: string[];
  defines?: string[];
}

const CONFIG_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'jsconfig.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'go.sum',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'makefile',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.prettierrc',
  'vite.config.ts',
  'vite.config.js',
  'webpack.config.js',
  'vitest.config.ts',
  'jest.config.js'
]);

const TS_JS_IMPORT =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const TS_JS_EXPORT_NAME =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const PYTHON_IMPORT = /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
const IDENTIFIER = /\b[A-Z][A-Za-z0-9]+|[a-z][a-zA-Z0-9]{3,}|[a-z]+_[a-z0-9_]+\b/g;
const KEYWORDS = new Set([
  'function',
  'class',
  'const',
  'return',
  'import',
  'export',
  'from',
  'async',
  'await',
  'interface',
  'type',
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'super',
  'default',
  'extends',
  'implements'
]);

export function isTestPath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  return (
    normalized.includes('.test.') ||
    normalized.includes('.spec.') ||
    normalized.includes('_test.') ||
    normalized.includes('/__tests__/') ||
    normalized.includes('/tests/') ||
    normalized.endsWith('_test.go') ||
    /\/test\/[^/]+$/.test(normalized)
  );
}

export function isConfigPath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  const base = normalized.split('/').pop()?.toLowerCase() ?? '';
  if (CONFIG_BASENAMES.has(base)) return true;
  if (base.endsWith('.config.ts') || base.endsWith('.config.js') || base.endsWith('.config.mjs')) {
    return true;
  }
  if (base.startsWith('.') && (base.endsWith('rc') || base.endsWith('rc.json'))) return true;
  return false;
}

export function extractImports(content: string, language: string): string[] {
  const found = new Set<string>();
  if (language === 'python') {
    for (const match of content.matchAll(PYTHON_IMPORT)) {
      const value = match[1] ?? match[2];
      if (value) found.add(value);
    }
    return [...found];
  }
  for (const match of content.matchAll(TS_JS_IMPORT)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) found.add(value);
  }
  return [...found];
}

export function extractExports(content: string, language: string): string[] {
  const found = new Set<string>();
  if (language === 'python') {
    for (const match of content.matchAll(/^__all__\s*=\s*\[([^\]]+)\]/m)) {
      for (const name of match[1]?.match(/['"]([^'"]+)['"]/g) ?? []) {
        found.add(name.replaceAll(/['"]/g, ''));
      }
    }
    return [...found];
  }
  for (const match of content.matchAll(TS_JS_EXPORT_NAME)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

export function extractReferencedSymbols(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(IDENTIFIER)) {
    const token = match[0];
    if (!KEYWORDS.has(token) && token.length >= 2) found.add(token);
    if (found.size >= 40) break;
  }
  return [...found];
}

export function buildChunkExtraMetadata(
  filePath: string,
  fileContent: string,
  chunkContent: string,
  language: string,
  facts: StructuralFacts & { v?: number } = {}
): ChunkExtraMetadata {
  return {
    imports: extractImports(fileContent, language),
    exports: extractExports(fileContent, language),
    referencedSymbols: extractReferencedSymbols(chunkContent),
    isTest: isTestPath(filePath),
    isConfig: isConfigPath(filePath),
    ...(facts.v !== undefined ? { v: facts.v } : {}),
    ...(facts.signature ? { signature: facts.signature } : {}),
    ...(facts.calls?.length ? { calls: facts.calls } : {}),
    ...(facts.literals?.length ? { literals: facts.literals } : {}),
    ...(facts.defines?.length ? { defines: facts.defines } : {})
  };
}

/** Chunker version recorded in stored metadata; 0 for chunks written before versions were recorded. */
export function chunkerVersionOf(raw: string | null | undefined): number {
  if (!raw) return 0;
  const match = /"v":(\d+)/.exec(raw);
  return match ? Number(match[1]) : 0;
}

export function serializeChunkExtraMetadata(meta: ChunkExtraMetadata): string {
  return JSON.stringify(meta);
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

export function parseChunkExtraMetadata(raw: string | null | undefined): ChunkExtraMetadata {
  if (!raw) {
    return { imports: [], exports: [], referencedSymbols: [], isTest: false, isConfig: false };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ChunkExtraMetadata>;
    const calls = stringList(parsed.calls);
    const literals = stringList(parsed.literals);
    const defines = stringList(parsed.defines);
    return {
      imports: stringList(parsed.imports) ?? [],
      exports: stringList(parsed.exports) ?? [],
      referencedSymbols: stringList(parsed.referencedSymbols) ?? [],
      isTest: Boolean(parsed.isTest),
      isConfig: Boolean(parsed.isConfig),
      ...(typeof parsed.v === 'number' ? { v: parsed.v } : {}),
      ...(typeof parsed.signature === 'string' ? { signature: parsed.signature } : {}),
      ...(calls ? { calls } : {}),
      ...(literals ? { literals } : {}),
      ...(defines ? { defines } : {})
    };
  } catch {
    return { imports: [], exports: [], referencedSymbols: [], isTest: false, isConfig: false };
  }
}
