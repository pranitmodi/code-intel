import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Recursively sums file sizes under a directory; returns 0 if the directory doesn't exist. */
export function getDirectorySizeBytes(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getDirectorySizeBytes(fullPath);
    } else if (entry.isFile()) {
      try {
        total += statSync(fullPath).size;
      } catch {
        // skip unreadable file
      }
    }
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
