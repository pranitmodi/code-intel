import { describe, expect, it } from 'vitest';
import { chunkFile } from '../../src/chunker/chunker.js';

const config = { maxChunkTokens: 800, chunkOverlap: 50, debounceMs: 1000 };

function coverage(source: string, chunks: Array<{ startLine: number; endLine: number }>): number {
  const lines = source.split('\n');
  const covered = new Set<number>();
  for (const chunk of chunks) for (let line = chunk.startLine; line <= chunk.endLine; line++) covered.add(line);
  const code = lines
    .map((text, index) => [text, index + 1] as const)
    .filter(([text]) => text.trim() && !/^(?:import\b|#!)/.test(text));
  return code.filter(([, line]) => covered.has(line)).length / code.length;
}

const CLI = `#!/usr/bin/env node
import { Command } from 'commander';
import { install } from './install.js';

const program = new Command();

program
  .command('vscode-install')
  .description('Register the MCP server for VS Code')
  .option('--workspace', 'write .vscode/mcp.json')
  .action((options) => {
    install({ scope: options.workspace ? 'workspace' : 'user' });
  });

program
  .command('file <path>')
  .option('--start <number>', 'start line')
  .action(() => undefined);

void program.parseAsync(process.argv);
`;

describe('structural chunking', () => {
  it('turns CLI command registrations into named command chunks', async () => {
    const { chunks } = await chunkFile(CLI, 'src/cli/index.ts', config);
    const command = chunks.find((chunk) => chunk.symbolName === 'vscode-install');
    expect(command).toMatchObject({ symbolType: 'command', startLine: 7, endLine: 13 });
    expect(command?.meta?.literals).toEqual(expect.arrayContaining(['vscode-install', '--workspace']));
    expect(command?.meta?.calls).toEqual(expect.arrayContaining(['command', 'install']));
    expect(chunks.find((chunk) => chunk.symbolName === 'file')?.symbolType).toBe('command');
    expect(coverage(CLI, chunks)).toBe(1);
  });

  it('keeps doc comments and export with arrow-function and const declarations', async () => {
    const source = `import { z } from 'zod';

/** Shared repo argument. */
export const repoField = z.string().optional();

/** Resolve the default target. */
export const defaultTarget = (workspace: string): string => {
  return workspace.trim();
};

export const MODE_LIMITS = {
  minimal: { chunks: 5 },
  normal: { chunks: 8 }
};
`;
    const { chunks } = await chunkFile(source, 'src/mcp/server.ts', config);
    const arrow = chunks.find((chunk) => chunk.symbolName === 'defaultTarget');
    expect(arrow).toMatchObject({ symbolType: 'function', startLine: 6 });
    expect(arrow?.content.startsWith('/** Resolve the default target. */\nexport const')).toBe(true);
    expect(chunks.find((chunk) => chunk.symbolName === 'repoField')).toMatchObject({ symbolType: 'const', startLine: 3 });
    expect(chunks.find((chunk) => chunk.symbolName === 'MODE_LIMITS')?.symbolType).toBe('const');
  });

  it('splits a class into a header and its methods without repeating method text', async () => {
    const source = `export class Store {
  private rows = 0;

  /** Count rows. */
  count(): number {
    return this.rows;
  }

  add(): void {
    this.rows++;
  }
}
`;
    const { chunks } = await chunkFile(source, 'src/store.ts', config);
    const header = chunks.find((chunk) => chunk.symbolType === 'class');
    expect(header).toMatchObject({ symbolName: 'Store', startLine: 1, endLine: 3 });
    expect(header?.meta?.defines).toEqual(['count:L5-7', 'add:L9-11']);
    expect(chunks.find((chunk) => chunk.symbolName === 'count')).toMatchObject({ parentSymbol: 'Store', startLine: 4 });
    const lines = new Map<number, number>();
    for (const chunk of chunks) for (let l = chunk.startLine; l <= chunk.endLine; l++) lines.set(l, (lines.get(l) ?? 0) + 1);
    expect([...lines.values()].every((count) => count === 1)).toBe(true);
  });

  it('chunks test files by describe/it title', async () => {
    const source = `import { describe, it, expect } from 'vitest';

describe('parser', () => {
  it('reads a flag', () => {
    expect(1).toBe(1);
  });
});
`;
    const { chunks } = await chunkFile(source, 'tests/unit/parser.test.ts', config);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ symbolType: 'test', symbolName: 'parser' });
  });

  it('splits an oversized function at statements, registrations standing alone', async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `  const value${i} = compute(${i}, 'padding padding padding');`).join('\n');
    const source = `export function buildServer(server: Server): Server {
${filler}
  server.registerTool('get_task_context', { description: 'task context' }, async () => ({}));
${filler}
  return server;
}
`;
    const { chunks } = await chunkFile(source, 'src/mcp/server.ts', config);
    const tool = chunks.find((chunk) => chunk.symbolName === 'get_task_context');
    expect(tool).toMatchObject({ symbolType: 'command', parentSymbol: 'buildServer' });
    expect(chunks.filter((chunk) => chunk.symbolName === 'buildServer').length).toBeGreaterThan(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks.every((chunk) => chunk.content.length <= config.maxChunkTokens * 4)).toBe(true);
    expect(coverage(source, chunks)).toBeGreaterThan(0.97);
  });

  it('handles Python decorators, methods, and module constants', async () => {
    const source = `import os

SETTINGS = {
    'debug': False,
}

@app.route('/users')
def list_users():
    return []

class Repo:
    def find(self, key):
        return key
`;
    const { chunks } = await chunkFile(source, 'app/views.py', config);
    expect(chunks.find((chunk) => chunk.symbolName === 'SETTINGS')?.symbolType).toBe('const');
    expect(chunks.find((chunk) => chunk.symbolName === 'list_users')).toMatchObject({ symbolType: 'function', startLine: 7 });
    expect(chunks.find((chunk) => chunk.symbolName === 'find')).toMatchObject({ parentSymbol: 'Repo', symbolType: 'function' });
  });

  it('names Go types and attaches methods to their receiver', async () => {
    const source = `package main

// Tree holds nodes.
type Tree struct {
\tNodes int
}

func (t *Tree) Walk() int {
\treturn t.Nodes
}
`;
    const { chunks } = await chunkFile(source, 'tree.go', config);
    expect(chunks.find((chunk) => chunk.symbolName === 'Tree')).toMatchObject({ symbolType: 'type', startLine: 3 });
    expect(chunks.find((chunk) => chunk.symbolName === 'Walk')).toMatchObject({ symbolType: 'method', parentSymbol: 'Tree' });
  });
});
