import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config/load.js';
import type { BenchmarkFile, UsageEvent } from './types.js';

export function usageHome(): string {
  return loadConfig().database.path;
}

export function usageLogPath(home = usageHome()): string {
  return join(home, 'usage.jsonl');
}

export function benchmarkPath(home = usageHome()): string {
  return join(home, 'savings-benchmark.json');
}

export function appendUsageEvent(event: UsageEvent, home = usageHome()): void {
  try {
    const path = usageLogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`);
  } catch {
    // Usage accounting must never break search, MCP, or Cursor hooks.
  }
}

export function readUsageEvents(home = usageHome()): UsageEvent[] {
  const path = usageLogPath(home);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as UsageEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function readBenchmark(home = usageHome()): BenchmarkFile | undefined {
  const path = benchmarkPath(home);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as BenchmarkFile;
  } catch {
    return undefined;
  }
}

export function writeBenchmark(benchmark: BenchmarkFile, home = usageHome()): void {
  const path = benchmarkPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(benchmark, null, 2)}\n`);
}
