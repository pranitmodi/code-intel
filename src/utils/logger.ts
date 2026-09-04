/**
 * Structured logger. Always writes to stderr so stdout stays free for MCP's
 * JSON-RPC stream and for CLI commands that print machine-readable results.
 * Never pass chunk/file source content into `meta` — logs must not leak code.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

let sharedLevel: LogLevel = (process.env.CODE_INTEL_LOG_LEVEL as LogLevel | undefined) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  sharedLevel = level;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(tag: string): Logger;
}

class ConsoleLogger implements Logger {
  constructor(private readonly tag: string) {}

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[sharedLevel]) return;
    const ts = new Date().toISOString();
    const metaSuffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    process.stderr.write(`${ts} [${level.toUpperCase()}] [${this.tag}] ${message}${metaSuffix}\n`);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  child(tag: string): Logger {
    return new ConsoleLogger(`${this.tag}:${tag}`);
  }
}

export function createLogger(tag: string): Logger {
  return new ConsoleLogger(tag);
}
