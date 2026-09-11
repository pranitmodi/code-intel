import type { IndexingConfig } from '../config/types.js';
import { detectLanguage } from '../parser/detectLanguage.js';
import { parseStructural } from '../parser/TreeSitterParser.js';
import { textChunk } from './textChunker.js';
import type { CodeChunk } from './types.js';

const CHARS_PER_TOKEN = 4;

export interface ChunkFileResult {
  language: string;
  chunks: CodeChunk[];
}

/** Structural (Tree-sitter) chunking when a grammar is available and finds symbols; text-window fallback otherwise. */
export async function chunkFile(content: string, filePath: string, config: IndexingConfig): Promise<ChunkFileResult> {
  const language = detectLanguage(filePath);

  const structural = await parseStructural(content, language).catch(() => null);
  if (structural && structural.length > 0) {
    return { language, chunks: structural.flatMap((chunk) => splitIfOversized(chunk, config)) };
  }

  return { language, chunks: textChunk(content, config) };
}

/** Enforce the embedding-input budget even when one structural symbol is unusually large. */
function splitIfOversized(chunk: CodeChunk, config: IndexingConfig): CodeChunk[] {
  const maxChars = config.maxChunkTokens * CHARS_PER_TOKEN;
  if (chunk.content.length <= maxChars) return [chunk];

  return textChunk(chunk.content, config).map((piece) => ({
    ...piece,
    symbolName: chunk.symbolName,
    symbolType: chunk.symbolType,
    parentSymbol: chunk.parentSymbol,
    startLine: chunk.startLine + piece.startLine - 1,
    endLine: chunk.startLine + piece.endLine - 1
  }));
}
