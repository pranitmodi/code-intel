import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export interface FileContext {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
}

/** Reads directly from the working tree — the repository, not the vector DB, is the source of truth (spec section 18). */
export async function getFileContext(
  repoRoot: string,
  relativeFilePath: string,
  startLine?: number,
  endLine?: number
): Promise<FileContext> {
  const root = resolve(repoRoot);
  const absolutePath = resolve(root, relativeFilePath);
  if (absolutePath !== root && !absolutePath.startsWith(root + sep)) {
    throw new Error('file path escapes the repository root');
  }

  const content = await readFile(absolutePath, 'utf-8');
  const lines = content.split('\n');
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? lines.length);

  return {
    file: relativeFilePath,
    startLine: start,
    endLine: end,
    content: lines.slice(start - 1, end).join('\n')
  };
}
