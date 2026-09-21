import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WatchStatus {
  lastError?: string;
  lastErrorAt?: string;
  lastSuccessAt?: string;
}

export function readWatchStatus(path: string): WatchStatus | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WatchStatus;
  } catch {
    return null;
  }
}

export function recordWatchError(path: string, message: string, now = new Date()): void {
  const previous = readWatchStatus(path) ?? {};
  writeWatchStatus(path, {
    ...previous,
    lastError: message,
    lastErrorAt: now.toISOString()
  });
}

export function recordWatchSuccess(path: string, now = new Date()): void {
  writeWatchStatus(path, {
    lastSuccessAt: now.toISOString()
  });
}

function writeWatchStatus(path: string, status: WatchStatus): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(status, null, 2));
}
