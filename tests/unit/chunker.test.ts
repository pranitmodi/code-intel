import { describe, expect, it } from 'vitest';
import { chunkFile } from '../../src/chunker/chunker.js';

const config = { maxChunkTokens: 800, chunkOverlap: 50, debounceMs: 1000 };

const TS_SAMPLE = `export class AuthService {
  async refreshToken(): Promise<string> {
    return renewSession();
  }
}

export function login(user: string): boolean {
  return user.length > 0;
}
`;

const PY_SAMPLE = `class PaymentProcessor:
    def charge(self, amount):
        return process(amount)


def refund(amount):
    return -amount
`;

describe('chunkFile', () => {
  it('structurally chunks TypeScript into class/method/function symbols', async () => {
    const { language, chunks } = await chunkFile(TS_SAMPLE, 'src/auth.ts', config);
    expect(language).toBe('typescript');

    const method = chunks.find((c) => c.symbolName === 'refreshToken');
    expect(method).toBeDefined();
    expect(method?.symbolType).toBe('method');
    expect(method?.parentSymbol).toBe('AuthService');

    const fn = chunks.find((c) => c.symbolName === 'login');
    expect(fn?.symbolType).toBe('function');
    expect(fn?.parentSymbol).toBeNull();

    const cls = chunks.find((c) => c.symbolName === 'AuthService');
    expect(cls?.symbolType).toBe('class');
    expect(cls?.startLine).toBe(1);
  });

  it('structurally chunks Python into class/method/function symbols', async () => {
    const { language, chunks } = await chunkFile(PY_SAMPLE, 'src/payments.py', config);
    expect(language).toBe('python');
    expect(chunks.some((c) => c.symbolName === 'charge' && c.parentSymbol === 'PaymentProcessor')).toBe(true);
    expect(chunks.some((c) => c.symbolName === 'refund' && c.parentSymbol === null)).toBe(true);
  });

  it('falls back to text chunking for languages without a grammar', async () => {
    const { language, chunks } = await chunkFile('* { color: red; }\n.a { color: blue; }\n', 'style.css', config);
    expect(language).toBe('css');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.symbolName).toBeNull();
  });

  it('falls back to text chunking when a file of a supported language has no matching symbols', async () => {
    const { chunks } = await chunkFile('export const PI = 3.14159;\n', 'src/constants.ts', config);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('PI');
  });

  it('hard-splits an oversized single-line asset before embedding', async () => {
    const maxChars = config.maxChunkTokens * 4;
    const oneLineSvg = `<svg><path d="${'x'.repeat(maxChars * 3)}"/></svg>`;
    const { chunks } = await chunkFile(oneLineSvg, 'generated/banner.svg', config);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= maxChars)).toBe(true);
    expect(chunks.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1)).toBe(true);
  });

  it('hard-splits oversized structural symbols to the same budget', async () => {
    const maxChars = config.maxChunkTokens * 4;
    const source = `export function generated() {\n  return "${'x'.repeat(maxChars * 2)}";\n}\n`;
    const { chunks } = await chunkFile(source, 'src/generated.ts', config);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= maxChars)).toBe(true);
  });
});
