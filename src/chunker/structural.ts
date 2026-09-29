import type { Node } from 'web-tree-sitter';
import type { CodeChunk } from './types.js';

/**
 * Structural chunking over a syntax tree. Every top-level statement except
 * imports lands in exactly one chunk, so constants, schemas, CLI command
 * registrations, and test bodies are searchable, not only named declarations.
 *
 * - Declarations (functions, classes, interfaces, arrow-function consts, ...)
 *   become one chunk each, with their leading doc comment and `export`.
 * - A class becomes a header chunk (declaration, fields) plus one chunk per
 *   method, so method text is never stored twice.
 * - A registration call (`program.command('x')`, `server.registerTool('x')`,
 *   `app.get('/x', h)`) becomes a `command` chunk named by its string; a test
 *   call (`describe`/`it`/`test`) becomes a `test` chunk named by its title.
 * - Oversized functions split at statement boundaries, with registrations in
 *   their body split out as `command` chunks.
 * - Remaining statements are grouped into `block` chunks.
 */

export interface LanguageRules {
  /** Node type -> symbol type for nodes that are a chunk of their own. */
  declarations: Record<string, string>;
  /** Class-like declarations that split into a header plus member chunks. */
  containers: Set<string>;
  /** Member node type -> symbol type inside a container body. */
  members: Record<string, string>;
  /** Wrappers whose inner declaration decides the unit: `export_statement`, `decorated_definition`. */
  wrappers: Record<string, string>;
  /** Variable declarations that may hold a function value or a large constant. */
  variables: Set<string>;
  /** Value node types that make a variable a function. */
  functionValues: Set<string>;
  /** Value node types that make a variable worth its own chunk regardless of size. */
  structuredValues: Set<string>;
  imports: Set<string>;
  comments: Set<string>;
  /** Statement node types that may hold a registration or test call. */
  expressionStatements: Set<string>;
  callTypes: Set<string>;
  stringTypes: Set<string>;
  /** Top-level nodes skipped entirely (`package main`, `#!/usr/bin/env node`). */
  skipped: Set<string>;
}

const TS_DECLARATIONS: Record<string, string> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  internal_module: 'namespace',
  module: 'namespace'
};

const TS_RULES: LanguageRules = {
  declarations: TS_DECLARATIONS,
  containers: new Set(['class_declaration', 'abstract_class_declaration']),
  members: { method_definition: 'method', abstract_method_signature: 'method' },
  wrappers: { export_statement: 'declaration' },
  variables: new Set(['lexical_declaration', 'variable_declaration']),
  functionValues: new Set(['arrow_function', 'function_expression', 'function', 'generator_function']),
  structuredValues: new Set(['object', 'array', 'call_expression', 'new_expression', 'as_expression', 'satisfies_expression', 'template_string']),
  imports: new Set(['import_statement']),
  comments: new Set(['comment']),
  expressionStatements: new Set(['expression_statement']),
  callTypes: new Set(['call_expression']),
  stringTypes: new Set(['string', 'template_string']),
  skipped: new Set(['hash_bang_line', 'empty_statement'])
};

const JS_RULES: LanguageRules = {
  ...TS_RULES,
  declarations: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    class_declaration: 'class'
  },
  containers: new Set(['class_declaration']),
  members: { method_definition: 'method' }
};

const PYTHON_RULES: LanguageRules = {
  declarations: { function_definition: 'function', class_definition: 'class' },
  containers: new Set(['class_definition']),
  // Earlier index versions typed Python methods as functions; keeping it keeps their chunk ids.
  members: { function_definition: 'function', decorated_definition: 'function' },
  wrappers: { decorated_definition: 'definition' },
  variables: new Set(),
  functionValues: new Set(['lambda']),
  structuredValues: new Set(['dictionary', 'list', 'call', 'set', 'tuple']),
  imports: new Set(['import_statement', 'import_from_statement', 'future_import_statement']),
  comments: new Set(['comment']),
  expressionStatements: new Set(['expression_statement', 'decorated_definition']),
  callTypes: new Set(['call']),
  stringTypes: new Set(['string']),
  skipped: new Set()
};

const GO_RULES: LanguageRules = {
  declarations: { function_declaration: 'function', method_declaration: 'method', type_declaration: 'type' },
  containers: new Set(),
  members: {},
  wrappers: {},
  variables: new Set(['const_declaration', 'var_declaration']),
  functionValues: new Set(['func_literal']),
  structuredValues: new Set(['composite_literal', 'call_expression']),
  imports: new Set(['import_declaration']),
  comments: new Set(['comment']),
  expressionStatements: new Set(['expression_statement']),
  callTypes: new Set(['call_expression']),
  stringTypes: new Set(['interpreted_string_literal', 'raw_string_literal']),
  skipped: new Set(['package_clause'])
};

const BASH_RULES: LanguageRules = {
  declarations: { function_definition: 'function' },
  containers: new Set(),
  members: {},
  wrappers: {},
  variables: new Set(),
  functionValues: new Set(),
  structuredValues: new Set(),
  imports: new Set(),
  comments: new Set(['comment']),
  expressionStatements: new Set(),
  callTypes: new Set(),
  stringTypes: new Set(),
  skipped: new Set()
};

export const STRUCTURAL_RULES: Record<string, LanguageRules> = {
  typescript: TS_RULES,
  tsx: TS_RULES,
  javascript: JS_RULES,
  python: PYTHON_RULES,
  go: GO_RULES,
  bash: BASH_RULES
};

/** Methods whose first string argument names a command, tool, route, or handler being registered. */
const REGISTRARS = new Set([
  'command', 'addCommand', 'registerTool', 'registerResource', 'registerPrompt', 'tool', 'resource', 'prompt',
  'route', 'add_parser', 'add_command', 'subcommand', 'on', 'handle', 'task'
]);
/** HTTP-style registrars only count with a handler argument, so `map.get('key')` is not a route. */
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'head', 'options']);
const TEST_CALLS = new Set(['describe', 'it', 'test', 'suite', 'context']);
/** Code-shaped strings worth keeping for exact lookups: commands, flags, env keys, identifiers, routes. */
const CODE_LITERAL = /^(?:--?[a-z][\w-]*|[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|\/[\w/:.-]+|[a-z]+[A-Z][A-Za-z0-9]*)$/;
const MAX_CALLS = 40;
const MAX_LITERALS = 20;
const MAX_SIGNATURE = 200;
/** Gap statements shorter than this carry too little to be worth a chunk of their own. */
const MIN_BLOCK_CHARS = 24;

interface Unit {
  kind: 'declaration' | 'container' | 'variable' | 'command' | 'test';
  /** The node whose name, body, and calls describe the unit (inside any wrapper). */
  target: Node;
  symbolType: string;
  name: string | null;
  parent: string | null;
}

export interface ChunkTreeOptions {
  maxChars: number;
}

function stringValue(node: Node): string {
  const inner = node.namedChildren.filter((child) => child && /fragment|content/.test(child.type));
  if (inner.length > 0) return inner.map((child) => child!.text).join('');
  return node.text.replace(/^[`'"]+|[`'"]+$/g, '');
}

function nameOf(node: Node): string | null {
  const name = node.childForFieldName('name');
  if (name) return name.text;
  // Go `type` declarations name their type_spec children.
  const spec = node.namedChildren.find((child) => child?.type === 'type_spec');
  return spec?.childForFieldName('name')?.text ?? null;
}

/** Go method receivers: `func (t *Tree) Walk()` belongs to Tree. */
function receiverType(node: Node): string | null {
  const receiver = node.childForFieldName('receiver');
  if (!receiver) return null;
  const ids = receiver.descendantsOfType('type_identifier');
  return ids[0]?.text ?? null;
}

function unwrap(node: Node, rules: LanguageRules): Node {
  let current = node;
  for (let depth = 0; depth < 3; depth++) {
    const field = rules.wrappers[current.type];
    if (!field) return current;
    const inner =
      current.childForFieldName(field) ??
      current.namedChildren.find(
        (child) => child && (rules.declarations[child.type] || rules.variables.has(child.type))
      ) ??
      null;
    if (!inner) return current;
    current = inner;
  }
  return current;
}

interface Registration {
  kind: 'command' | 'test';
  name: string;
}

/** A registration or test call anywhere in a statement's call chain. */
function findRegistration(statement: Node, rules: LanguageRules): Registration | null {
  if (rules.callTypes.size === 0) return null;
  for (const call of statement.descendantsOfType([...rules.callTypes])) {
    if (!call) continue;
    const fn = call.childForFieldName('function');
    const args = call.childForFieldName('arguments');
    const first = args?.namedChildren[0];
    if (!fn || !args || !first || !rules.stringTypes.has(first.type)) continue;
    const literal = stringValue(first).trim();
    if (!literal) continue;
    if (fn.type === 'identifier' && TEST_CALLS.has(fn.text)) {
      return { kind: 'test', name: literal.slice(0, 120) };
    }
    const property = fn.childForFieldName('property') ?? fn.childForFieldName('attribute') ?? fn.childForFieldName('field');
    const object = fn.childForFieldName('object') ?? fn.childForFieldName('operand');
    if (!property) continue;
    if (object && object.type === 'identifier' && TEST_CALLS.has(object.text)) {
      return { kind: 'test', name: literal.slice(0, 120) };
    }
    const method = property.text;
    if (REGISTRARS.has(method) || (HTTP_VERBS.has(method) && args.namedChildren.length >= 2)) {
      return { kind: 'command', name: literal.split(/\s+/)[0] ?? literal };
    }
  }
  return null;
}

/** The body of a registration's or test's callback: `describe('x', () => { ... })`. */
function callbackBody(statement: Node, rules: LanguageRules): Node | null {
  const call = statement.descendantsOfType([...rules.callTypes])[0];
  const args = call?.childForFieldName('arguments');
  const callbacks = (args?.namedChildren ?? []).filter((arg) => arg && rules.functionValues.has(arg.type));
  return callbacks.at(-1)?.childForFieldName('body') ?? null;
}

function classify(node: Node, rules: LanguageRules): Unit | null {
  const target = unwrap(node, rules);
  const declared = rules.declarations[target.type];
  if (declared) {
    const receiver = target.type === 'method_declaration' ? receiverType(target) : null;
    return {
      kind: rules.containers.has(target.type) ? 'container' : 'declaration',
      target,
      symbolType: declared,
      name: nameOf(target),
      parent: receiver
    };
  }
  if (rules.variables.has(target.type)) {
    const declarators = target.namedChildren.filter(
      (child) => child && /declarator|spec/.test(child.type)
    ) as Node[];
    const first = declarators[0];
    const value = first?.childForFieldName('value');
    const valueNode = value?.type === 'expression_list' ? value.namedChildren[0] : value;
    const name = first?.childForFieldName('name')?.text ?? null;
    if (declarators.length === 1 && valueNode && rules.functionValues.has(valueNode.type)) {
      return { kind: 'declaration', target: valueNode, symbolType: 'function', name, parent: null };
    }
    const lines = node.endPosition.row - node.startPosition.row + 1;
    if (lines >= 3 || (valueNode && rules.structuredValues.has(valueNode.type))) {
      return { kind: 'variable', target, symbolType: 'const', name, parent: null };
    }
    return null;
  }
  if (rules.expressionStatements.has(node.type)) {
    // Python module constants: `CONFIG = {...}`.
    const assignment = node.namedChildren[0];
    if (assignment?.type === 'assignment') {
      const right = assignment.childForFieldName('right');
      const lines = node.endPosition.row - node.startPosition.row + 1;
      if (lines >= 3 || (right && rules.structuredValues.has(right.type))) {
        return { kind: 'variable', target: node, symbolType: 'const', name: assignment.childForFieldName('left')?.text ?? null, parent: null };
      }
    }
    const registration = findRegistration(node, rules);
    if (registration) {
      return { kind: registration.kind, target: node, symbolType: registration.kind, name: registration.name, parent: null };
    }
  }
  return null;
}

function unique(values: Iterable<string>, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

/** Callee names: `g` for `g()`, `h` for `obj.h()`. */
function callsIn(node: Node, rules: LanguageRules): string[] {
  if (rules.callTypes.size === 0) return [];
  const names: string[] = [];
  for (const call of node.descendantsOfType([...rules.callTypes])) {
    const fn = call?.childForFieldName('function');
    if (!fn) continue;
    if (fn.type === 'identifier') names.push(fn.text);
    else {
      const property = fn.childForFieldName('property') ?? fn.childForFieldName('attribute') ?? fn.childForFieldName('field');
      if (property) names.push(property.text);
    }
  }
  return unique(names, MAX_CALLS);
}

function literalsIn(node: Node, rules: LanguageRules): string[] {
  if (rules.stringTypes.size === 0) return [];
  const values: string[] = [];
  for (const literal of node.descendantsOfType([...rules.stringTypes])) {
    if (!literal) continue;
    const value = stringValue(literal).trim();
    const head = value.split(/\s+/)[0] ?? '';
    if (head.length >= 3 && head.length <= 60 && CODE_LITERAL.test(head)) values.push(head);
  }
  return unique(values, MAX_LITERALS);
}

/** Declaration text up to its body, whitespace collapsed: `export async function f(a: number): Promise<void>`. */
function signatureOf(source: string, start: Node, target: Node): string {
  const body = target.childForFieldName('body');
  const end = body && body.startIndex > start.startIndex ? body.startIndex : start.endIndex;
  const text = source.slice(start.startIndex, Math.min(end, start.startIndex + MAX_SIGNATURE * 2));
  const firstLine = body ? text : (text.split('\n')[0] ?? text);
  return firstLine.replace(/\s+/g, ' ').trim().slice(0, MAX_SIGNATURE);
}

/**
 * Walks a parsed file. `lines` are the source lines; chunk content is always
 * whole lines, so indentation is preserved exactly as on disk.
 */
export function chunkTree(root: Node, source: string, rules: LanguageRules, options: ChunkTreeOptions): CodeChunk[] {
  const lines = source.split('\n');
  const out: CodeChunk[] = [];
  const maxChars = options.maxChars;

  const text = (startRow: number, endRow: number): string => lines.slice(startRow, endRow + 1).join('\n');

  const push = (
    startRow: number,
    endRow: number,
    fields: Pick<CodeChunk, 'symbolName' | 'symbolType' | 'parentSymbol'> & { meta?: CodeChunk['meta'] }
  ): void => {
    const content = text(startRow, endRow);
    if (!content.trim()) return;
    out.push({ ...fields, startLine: startRow + 1, endLine: endRow + 1, content });
  };

  /** Consecutive statements grouped into chunks of at most maxChars, split at statement boundaries. */
  const pushGroups = (
    nodes: Node[],
    fields: (first: Node) => Pick<CodeChunk, 'symbolName' | 'symbolType' | 'parentSymbol'>,
    minChars: number,
    fromRow?: number
  ): void => {
    let groupStart: number | null = fromRow ?? null;
    let groupEnd = -1;
    let first: Node | null = null;
    let calls: string[] = [];
    let literals: string[] = [];
    const flush = (): void => {
      if (groupStart === null || !first) return;
      const content = text(groupStart, groupEnd);
      if (content.trim().length >= minChars) {
        const groupMeta = { calls: unique(calls, MAX_CALLS), literals: unique(literals, MAX_LITERALS) };
        if (content.length > maxChars) pushWindows(groupStart, groupEnd, fields(first), groupMeta);
        else push(groupStart, groupEnd, { ...fields(first), meta: groupMeta });
      }
      groupStart = null;
      first = null;
      calls = [];
      literals = [];
    };
    for (const node of nodes) {
      const start = groupStart ?? node.startPosition.row;
      const size = text(start, node.endPosition.row).length;
      if (first && size > maxChars) flush();
      groupStart ??= node.startPosition.row;
      first ??= node;
      groupEnd = node.endPosition.row;
      calls.push(...callsIn(node, rules));
      literals.push(...literalsIn(node, rules));
    }
    flush();
  };

  /** Leading comments directly above `node` (no blank line between) move into its chunk. */
  const leadingStart = (node: Node, comments: Node[]): number => {
    let start = node.startPosition.row;
    const above = comments
      .filter((comment) => comment.endPosition.row < node.startPosition.row)
      .sort((a, b) => a.endPosition.row - b.endPosition.row);
    for (let i = above.length - 1; i >= 0; i--) {
      const comment = above[i]!;
      if (comment.endPosition.row + 1 < start) break;
      start = comment.startPosition.row;
    }
    return start;
  };

  const emitUnit = (unit: Unit, startRow: number, node: Node): void => {
    const endRow = node.endPosition.row;
    const meta = {
      signature: signatureOf(source, node, unit.target),
      calls: callsIn(unit.target, rules),
      literals: unique([...(unit.kind === 'command' && unit.name ? [unit.name] : []), ...literalsIn(unit.target, rules)], MAX_LITERALS)
    };
    const fields = { symbolName: unit.name, symbolType: unit.symbolType, parentSymbol: unit.parent };

    if (unit.kind === 'container') {
      emitContainer(unit, startRow, node, meta);
      return;
    }
    if (text(startRow, endRow).length <= maxChars) {
      push(startRow, endRow, { ...fields, meta });
      return;
    }
    const body = unit.kind === 'command' || unit.kind === 'test' ? callbackBody(unit.target, rules) : unit.target.childForFieldName('body');
    if (body && body.namedChildren.length > 1) {
      splitBody(unit, startRow, body, meta);
      return;
    }
    pushWindows(startRow, endRow, fields, meta);
  };

  /** Fixed windows for a unit with no statement structure to split on. */
  const pushWindows = (
    startRow: number,
    endRow: number,
    fields: Pick<CodeChunk, 'symbolName' | 'symbolType' | 'parentSymbol'>,
    meta: CodeChunk['meta']
  ): void => {
    let row = startRow;
    while (row <= endRow) {
      let end = row;
      let size = (lines[row] ?? '').length + 1;
      while (end + 1 <= endRow && size + (lines[end + 1] ?? '').length + 1 <= maxChars) {
        end++;
        size += (lines[end] ?? '').length + 1;
      }
      const piece = text(row, end);
      if (piece.length > maxChars) {
        // One enormous line: slice it so no chunk exceeds the embedding budget.
        for (let offset = 0; offset < piece.length; offset += maxChars) {
          out.push({ ...fields, startLine: row + 1, endLine: end + 1, content: piece.slice(offset, offset + maxChars), meta });
        }
      } else {
        push(row, end, { ...fields, meta });
      }
      row = end + 1;
    }
  };

  /** An oversized function: the signature with its first statements, then statement groups; registrations stand alone. */
  const splitBody = (unit: Unit, startRow: number, body: Node, meta: CodeChunk['meta']): void => {
    const statements = body.namedChildren.filter((child): child is Node => Boolean(child));
    const fields = { symbolName: unit.name, symbolType: unit.symbolType, parentSymbol: unit.parent };
    const run: Node[] = [];
    let headerPending = true;
    const flushRun = (nextRow?: number): void => {
      if (run.length === 0) {
        // A body that opens with a registration still owes its signature lines.
        if (headerPending && nextRow !== undefined && nextRow - 1 >= startRow) {
          push(startRow, nextRow - 1, { ...fields, meta });
          headerPending = false;
        }
        return;
      }
      const before = out.length;
      pushGroups(run.splice(0, run.length), () => fields, 0, headerPending ? startRow : undefined);
      if (headerPending && out.length > before) {
        out[before]!.meta = { ...out[before]!.meta, signature: meta?.signature };
      }
      headerPending = false;
    };
    for (const statement of statements) {
      const registration = rules.expressionStatements.has(statement.type) ? findRegistration(statement, rules) : null;
      if (!registration) {
        run.push(statement);
        continue;
      }
      flushRun(statement.startPosition.row);
      emitUnit(
        { kind: registration.kind, target: statement, symbolType: registration.kind, name: registration.name, parent: unit.name },
        statement.startPosition.row,
        statement
      );
    }
    flushRun();
  };

  const emitContainer = (unit: Unit, startRow: number, node: Node, meta: CodeChunk['meta']): void => {
    const body = unit.target.childForFieldName('body');
    const members = (body?.namedChildren ?? []).filter((child): child is Node => Boolean(child));
    const methods = members.filter((member) => rules.members[unwrap(member, rules).type] || rules.members[member.type]);
    const endRow = node.endPosition.row;
    if (methods.length === 0) {
      if (text(startRow, endRow).length <= maxChars) push(startRow, endRow, { symbolName: unit.name, symbolType: unit.symbolType, parentSymbol: unit.parent, meta });
      else pushWindows(startRow, endRow, { symbolName: unit.name, symbolType: unit.symbolType, parentSymbol: unit.parent }, meta);
      return;
    }
    const memberComments: Node[] = [];
    const firstMethodStart = leadingStart(methods[0]!, members.filter((m) => rules.comments.has(m.type)));
    const defines = methods.map((method) => {
      const target = unwrap(method, rules);
      return `${nameOf(target) ?? '?'}:L${method.startPosition.row + 1}-${method.endPosition.row + 1}`;
    });
    const headerEnd = Math.max(startRow, firstMethodStart - 1);
    const header = text(startRow, headerEnd);
    if (header.length <= maxChars) {
      push(startRow, headerEnd, {
        symbolName: unit.name,
        symbolType: unit.symbolType,
        parentSymbol: unit.parent,
        meta: { ...meta, defines }
      });
    } else {
      pushWindows(startRow, headerEnd, { symbolName: unit.name, symbolType: unit.symbolType, parentSymbol: unit.parent }, { ...meta, defines });
    }
    const trailing: Node[] = [];
    for (const member of members) {
      if (member.startPosition.row < firstMethodStart && !methods.includes(member)) continue;
      if (rules.comments.has(member.type)) {
        memberComments.push(member);
        continue;
      }
      const target = unwrap(member, rules);
      const memberType = rules.members[target.type] ?? rules.members[member.type];
      if (!memberType) {
        trailing.push(member);
        continue;
      }
      const memberUnit: Unit = { kind: 'declaration', target, symbolType: memberType, name: nameOf(target), parent: unit.name };
      emitUnit(memberUnit, leadingStart(member, memberComments), member);
      memberComments.length = 0;
    }
    if (trailing.length > 0) {
      pushGroups(trailing, () => ({ symbolName: unit.name, symbolType: 'block', parentSymbol: unit.name }), MIN_BLOCK_CHARS);
    }
  };

  let gap: Node[] = [];
  let comments: Node[] = [];
  const flushGap = (): void => {
    if (gap.length === 0) return;
    pushGroups(
      gap,
      (first) => {
        const target = unwrap(first, rules);
        const declarator = target.namedChildren.find((child) => child && /declarator|spec|assignment/.test(child.type));
        const name =
          declarator?.childForFieldName('name')?.text ??
          declarator?.childForFieldName('left')?.text ??
          null;
        return { symbolName: name, symbolType: 'block', parentSymbol: null };
      },
      MIN_BLOCK_CHARS
    );
    gap = [];
  };

  for (const node of root.namedChildren) {
    if (!node || rules.skipped.has(node.type)) continue;
    if (rules.comments.has(node.type)) {
      comments.push(node);
      continue;
    }
    if (rules.imports.has(node.type)) {
      // A file header comment above the imports says little about any one chunk.
      comments = [];
      continue;
    }
    const unit = classify(node, rules);
    if (!unit) {
      gap.push(...comments, node);
      comments = [];
      continue;
    }
    // A short statement directly above a declaration (`const logger = ...;`)
    // joins it rather than being dropped as too small to stand alone.
    let attached: number | null = null;
    const lastGap = gap.at(-1);
    if (
      lastGap &&
      text(gap[0]!.startPosition.row, lastGap.endPosition.row).trim().length < MIN_BLOCK_CHARS &&
      lastGap.endPosition.row + 1 >= (comments[0] ?? node).startPosition.row
    ) {
      attached = gap[0]!.startPosition.row;
      gap = [];
    }
    flushGap();
    const startRow = attached ?? leadingStart(node, comments);
    const detached = comments.filter((comment) => comment.startPosition.row < startRow);
    if (detached.length > 0) pushGroups(detached, () => ({ symbolName: null, symbolType: 'block', parentSymbol: null }), MIN_BLOCK_CHARS);
    comments = [];
    emitUnit(unit, startRow, node);
  }
  gap.push(...comments);
  flushGap();

  return out;
}
