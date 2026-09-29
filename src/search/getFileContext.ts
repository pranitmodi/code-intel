import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { isSecretPath } from '../discovery/discover.js';

export interface FileContext {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface FileContextOptions {
  /** Mirrors `security.allowSensitiveFiles`: permit files the indexer skips as likely secrets. */
  allowSensitiveFiles?: boolean;
}

/** Reads directly from the working tree — the repository, not the vector DB, is the source of truth (spec section 18). */
export async function getFileContext(
  repoRoot: string,
  relativeFilePath: string,
  startLine?: number,
  endLine?: number,
  options: FileContextOptions = {}
): Promise<FileContext> {
  const root = resolve(repoRoot);
  const absolutePath = resolve(root, relativeFilePath);
  if (absolutePath !== root && !absolutePath.startsWith(root + sep)) {
    throw new Error('file path escapes the repository root');
  }
  if (!options.allowSensitiveFiles && isSecretPath(relative(root, absolutePath))) {
    throw new Error(
      'refusing to read a file that may contain secrets (.env, keys, credentials); set security.allowSensitiveFiles to allow it'
    );
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

export interface FileRangeRequest {
  file: string;
  startLine?: number;
  endLine?: number;
}

/** `src/a.ts:120-168`, `src/a.ts:120`, or `src/a.ts`. */
export function parseRangeRef(ref: string): FileRangeRequest {
  const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(ref.trim());
  if (!match) return { file: ref.trim() };
  const startLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : startLine;
  return { file: match[1]!, startLine, endLine: Math.max(startLine, endLine) };
}

export interface FileRangeResult {
  file: string;
  startLine: number;
  endLine: number;
  /** Lines in the whole file, so an agent never has to guess what lies beyond the range. */
  totalLines: number;
  content: string;
  /** Lines of the requested range left out by the line cap. */
  omittedLines: number;
  error?: string;
}

export interface FileRangesOptions extends FileContextOptions {
  /** Most lines returned per range; the rest are named, not sent. */
  maxLinesPerRange?: number;
  /** Most lines returned per call across all ranges. */
  maxLinesTotal?: number;
}

export const DEFAULT_MAX_LINES_PER_RANGE = 400;
export const DEFAULT_MAX_LINES_TOTAL = 1200;

/**
 * Read several ranges in one call, capped so a whole-file read cannot flood
 * the context: a capped range reports what it left out and where it resumes.
 * A bad path fails its own entry, not the call.
 */
export async function readFileRanges(
  repoRoot: string,
  requests: FileRangeRequest[],
  options: FileRangesOptions = {}
): Promise<FileRangeResult[]> {
  const perRange = options.maxLinesPerRange ?? DEFAULT_MAX_LINES_PER_RANGE;
  let budget = options.maxLinesTotal ?? DEFAULT_MAX_LINES_TOTAL;
  const results: FileRangeResult[] = [];
  const files = new Map<string, string[]>();
  for (const request of requests) {
    try {
      let lines = files.get(request.file);
      if (!lines) {
        lines = (await getFileContext(repoRoot, request.file, undefined, undefined, options)).content.split('\n');
        files.set(request.file, lines);
      }
      const totalLines = lines.length;
      if ((request.startLine ?? 1) > totalLines) {
        throw new Error(`line ${request.startLine} is past the end of the file (${totalLines} lines)`);
      }
      const start = Math.max(1, request.startLine ?? 1);
      const requestedEnd = Math.min(totalLines, request.endLine ?? totalLines);
      const allowed = Math.max(0, Math.min(perRange, budget));
      const end = Math.min(requestedEnd, start + allowed - 1);
      budget -= Math.max(0, end - start + 1);
      results.push({
        file: request.file,
        startLine: start,
        endLine: end,
        totalLines,
        content: end >= start ? lines.slice(start - 1, end).join('\n') : '',
        omittedLines: Math.max(0, requestedEnd - Math.max(end, start - 1))
      });
    } catch (error) {
      results.push({
        file: request.file,
        startLine: request.startLine ?? 1,
        endLine: request.endLine ?? request.startLine ?? 1,
        totalLines: 0,
        content: '',
        omittedLines: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

/** What the conversation has already been sent (see `ContextLedger`). */
export interface SentLines {
  fullySeen(path: string, startLine: number, lines: string[]): boolean;
  classify(path: string, startLine: number, lines: string[]): Array<{ start: number; end: number; seen: boolean }>;
  record(path: string, startLine: number, lines: string[]): void;
  avoidedLines: number;
}

/**
 * `### path:a-b (of N lines)` blocks of raw lines, with a pointer to anything
 * the cap left out. With `sent`, stretches the conversation already has are
 * replaced by a one-line note; a range requested again in full is resent
 * whole, since the agent may have lost it to context compaction.
 */
export function renderFileRanges(results: FileRangeResult[], sent?: SentLines): string {
  return results
    .map((result) => {
      if (result.error) return `### ${result.file}\nerror: ${result.error}`;
      if (result.endLine < result.startLine) {
        const last = result.startLine + result.omittedLines - 1;
        return `### ${result.file}:${result.startLine}-${last} not sent (this call's line budget is used up; read it separately)`;
      }
      const header = `### ${result.file}:${result.startLine}-${result.endLine} (of ${result.totalLines} lines)`;
      const cleaned = result.content.replace(/[ \t]+$/gm, '');
      const lines = cleaned.split('\n');
      let body = cleaned;
      if (sent && !sent.fullySeen(result.file, result.startLine, lines)) {
        body = sent
          .classify(result.file, result.startLine, lines)
          .map((run) => {
            const slice = lines.slice(run.start - result.startLine, run.end - result.startLine + 1);
            if (!run.seen) return slice.join('\n');
            sent.avoidedLines += slice.length;
            return `… lines ${run.start}-${run.end} unchanged, already sent in this conversation …`;
          })
          .join('\n');
      }
      sent?.record(result.file, result.startLine, lines);
      const more =
        result.omittedLines > 0
          ? `\n(${result.omittedLines} more lines below: ${result.file}:${result.endLine + 1}-${result.endLine + result.omittedLines})`
          : '';
      return `${header}\n${body}${more}`;
    })
    .join('\n\n');
}
