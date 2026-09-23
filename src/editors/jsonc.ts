import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type JSONPath,
  type ParseError
} from 'jsonc-parser';

export interface JsoncObject {
  /** Source text without a byte-order mark; `{}` when the input was empty. */
  text: string;
  value: Record<string, unknown>;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

/** Structural equality that ignores object key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Parse an editor config file (JSON with comments and trailing commas, as
 * written by VS Code and Cursor) whose top level must be an object.
 */
export function parseJsoncObject(
  raw: string | undefined,
  describeInvalid: (reason: string) => string
): JsoncObject {
  const text = (raw ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) return { text: '{}', value: {} };

  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  const [first] = errors;
  if (first) {
    throw new Error(describeInvalid(`${printParseErrorCode(first.error)} at offset ${first.offset}`));
  }
  if (!isPlainObject(value)) throw new Error(describeInvalid('the top level must be a JSON object'));
  return { text, value };
}

function formattingFor(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent?.length ?? 2, eol };
}

/** Set `path` to `value`, keeping comments and formatting elsewhere in the document. */
export function setJsoncValue(text: string, path: JSONPath, value: unknown): string {
  const edited = applyEdits(text, modify(text, path, value, { formattingOptions: formattingFor(text) }));
  return /\r?\n$/.test(edited) ? edited : `${edited}\n`;
}

export function readTextIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
}

/**
 * Write only when the content changed, so reruns leave mtimes alone (editors
 * restart MCP servers when their config is touched). Writing in place keeps
 * symlinked config files, common in dotfile setups, pointing at their target.
 */
export function writeIfChanged(path: string, next: string, previous = readTextIfExists(path)): boolean {
  if (previous === next) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return true;
}
