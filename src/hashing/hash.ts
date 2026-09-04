import { createHash } from 'node:crypto';

/**
 * Normalizes content before hashing so purely cosmetic whitespace changes
 * (trailing spaces, CRLF vs LF) don't force an unnecessary re-embedding.
 */
export function normalizeForHash(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hash of raw file bytes — any byte change (including whitespace) changes this. */
export function hashFileContent(content: string | Buffer): string {
  return sha256Hex(content);
}

/** Hash of normalized chunk content — used to decide whether a chunk needs re-embedding. */
export function hashChunkContent(content: string): string {
  return sha256Hex(normalizeForHash(content));
}

/**
 * Deterministic chunk row id, keyed by symbol identity (parent + type + name) rather than
 * line position — so a chunk keeps its id (and reuses its embedding) even when unrelated
 * edits elsewhere in the file shift its line range.
 */
export function computeChunkId(repoId: string, filePath: string, ...identity: (string | number)[]): string {
  return sha256Hex([repoId, filePath, ...identity].join(':'));
}
