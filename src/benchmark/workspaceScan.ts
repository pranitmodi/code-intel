import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { estimateTokensFromChars } from '../utils/tokens.js';

const RG_GLOBS = ['!node_modules/**', '!.git/**', '!dist/**', '!build/**'];
const MAX_READ_FILES = 12;

export interface WorkspaceScanResult {
  filesRead: number;
  linesRead: number;
  estimatedTokens: number;
  latencyMs: number;
  files: string[];
}

function rgBin(): string {
  return process.env.CODE_INTEL_RG ?? 'rg';
}

function assertRgSucceeded(
  result: { error?: Error; status: number | null; stderr?: Buffer | string | null },
  operation: string,
  allowNoMatches = false
): void {
  if (result.error) {
    throw new Error(
      `Workspace-scan baseline could not run ripgrep (${rgBin()}): ${result.error.message}. ` +
        'Install ripgrep or set CODE_INTEL_RG to its executable path.'
    );
  }
  if (result.status === 0 || (allowNoMatches && result.status === 1)) return;
  const stderr =
    typeof result.stderr === 'string'
      ? result.stderr.trim()
      : Buffer.from(result.stderr ?? Buffer.alloc(0)).toString('utf8').trim();
  throw new Error(
    `Workspace-scan baseline failed during ${operation} (ripgrep exit ${result.status ?? 'unknown'})` +
      `${stderr ? `: ${stderr}` : '.'}`
  );
}

function globArgs(repo: string, extra: string[]): string[] {
  const globs = RG_GLOBS.flatMap((g) => ['--glob', g]);
  return [...globs, ...extra, repo];
}

export function workspaceScan(repo: string, keyword: string): WorkspaceScanResult {
  const started = Date.now();
  const listed = spawnSync(rgBin(), globArgs(repo, ['--files']), {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024
  });
  assertRgSucceeded(listed, 'file listing');
  const globTokens = estimateTokensFromChars((listed.stdout ?? Buffer.alloc(0)).length);

  const dump = spawnSync(rgBin(), globArgs(repo, ['-n', '-C', '2', '--max-count', '200', '--', keyword]), {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024
  });
  assertRgSucceeded(dump, 'content search', true);
  const filesOut = spawnSync(rgBin(), globArgs(repo, ['-l', '--max-count', '200', '--', keyword]), {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  assertRgSucceeded(filesOut, 'matching-file search', true);
  const files = (filesOut.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let readBytes = 0;
  let linesRead = 0;
  for (const file of files.slice(0, MAX_READ_FILES)) {
    try {
      const st = statSync(file);
      readBytes += st.size;
      linesRead += Math.max(1, Math.ceil(st.size / 40));
    } catch {
      /* skip */
    }
  }

  const grepDumpTokens = estimateTokensFromChars((dump.stdout ?? Buffer.alloc(0)).length);
  const readTopFilesTokens = estimateTokensFromChars(readBytes);
  return {
    filesRead: Math.min(files.length, MAX_READ_FILES),
    linesRead,
    estimatedTokens: globTokens + grepDumpTokens + readTopFilesTokens,
    latencyMs: Date.now() - started,
    files: files.slice(0, MAX_READ_FILES)
  };
}

export function keywordFromPrompt(prompt: string): string {
  const ident = prompt.match(/\b[A-Za-z][A-Za-z0-9]{3,}\b/g);
  return ident?.[ident.length - 1] ?? prompt.split(/\s+/)[0] ?? prompt;
}
