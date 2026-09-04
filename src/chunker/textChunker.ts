import type { IndexingConfig } from '../config/types.js';
import type { CodeChunk } from './types.js';

const CHARS_PER_TOKEN = 4;

/** Overlapping line-window chunker for files with no structural parser (or no matching symbols). */
export function textChunk(content: string, config: IndexingConfig): CodeChunk[] {
  const lines = content.split('\n');
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return [];

  const maxChars = config.maxChunkTokens * CHARS_PER_TOKEN;
  const overlapLines = Math.max(0, config.chunkOverlap);
  const chunks: CodeChunk[] = [];

  let start = 0;
  while (start < lines.length) {
    let end = start;
    let charCount = 0;
    while (end < lines.length) {
      const lineLength = (lines[end] ?? '').length + 1;
      if (end > start && charCount + lineLength > maxChars) break;
      charCount += lineLength;
      end++;
    }

    chunks.push({
      symbolName: null,
      symbolType: null,
      parentSymbol: null,
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join('\n')
    });

    if (end >= lines.length) break;
    start = end - overlapLines > start ? end - overlapLines : end;
  }

  return chunks;
}
