import { describe, expect, it } from 'vitest';
import { analyzeQuery } from '../../src/retrieval/intent.js';

describe('analyzeQuery', () => {
  it('extracts quoted identifiers and identifier-like tokens', () => {
    const intent = analyzeQuery('Add rate limiting to createUser and update the tests.');
    expect(intent.symbols).toContain('createUser');
    expect(intent.operations).toContain('find_implementation');
    expect(intent.operations).toContain('find_tests');
  });

  it('detects configuration intent', () => {
    const intent = analyzeQuery('Where is the production database connection configured?');
    expect(intent.operations).toContain('find_config');
  });

  it('detects language from file extensions', () => {
    const intent = analyzeQuery('Fix src/api/users.ts');
    expect(intent.files).toContain('src/api/users.ts');
    expect(intent.likelyLanguages).toContain('typescript');
  });

  it('keeps normal context for a short known-symbol question unless mode is explicit', () => {
    const intent = analyzeQuery('Where is AuthService?');
    expect(intent.requestedContext).toBe('normal');
    expect(intent.symbols).toContain('AuthService');
    expect(analyzeQuery('Where is AuthService?', 'minimal').requestedContext).toBe('minimal');
  });

  it('does not add test expansion just because a task is a fix', () => {
    expect(analyzeQuery('Fix stale index detection.').operations).not.toContain('find_tests');
    expect(analyzeQuery('Fix stale index detection and update tests.').operations).toContain('find_tests');
  });

  it('keeps product acronyms as concepts instead of treating them as code symbols', () => {
    const intent = analyzeQuery('Add request IDs to MCP tool responses.');
    expect(intent.symbols).not.toContain('MCP');
    expect(intent.symbols).not.toContain('IDs');
  });
});
