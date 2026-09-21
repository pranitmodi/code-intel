import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FALLBACK_FILE = 'fallback-ok.json';
const WINDOW_MS = 10 * 60 * 1000;

interface FallbackRecord {
  allowedUntil: string;
  repo?: string;
  reason: string;
}

export function fallbackStatePath(databasePath: string): string {
  return join(databasePath, FALLBACK_FILE);
}

export function grantFilesystemFallback(
  databasePath: string,
  reason: string,
  repo?: string,
  now = Date.now()
): void {
  mkdirSync(databasePath, { recursive: true });
  const record: FallbackRecord = {
    allowedUntil: new Date(now + WINDOW_MS).toISOString(),
    repo,
    reason
  };
  writeFileSync(fallbackStatePath(databasePath), JSON.stringify(record), 'utf8');
}

export function isFilesystemFallbackOpen(databasePath: string, now = Date.now()): boolean {
  const path = fallbackStatePath(databasePath);
  if (!existsSync(path)) return false;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as FallbackRecord;
    const until = Date.parse(record.allowedUntil);
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}
