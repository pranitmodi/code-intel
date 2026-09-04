import { extname } from 'node:path';

/**
 * Extension -> language name, covering the spec's full language list. Only a subset
 * (see `languageRegistry.ts`) has a wired-up Tree-sitter grammar; the rest still get
 * correct `language` metadata and fall back to text chunking.
 */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.rb': 'ruby',
  '.php': 'php',
  '.sql': 'sql',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash'
};

export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? 'text';
}
