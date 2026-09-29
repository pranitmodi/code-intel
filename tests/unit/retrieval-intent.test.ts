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

describe('analyzeQuery code-shaped tokens', () => {
  const abPrompt =
    'Explain how `code-intel vscode-install` configures VS Code: how it copes with nvm and a GUI-launched VS Code that lacks the shell PATH, user versus workspace installation, prompting for OpenAI-compatible embedding credentials, preserving JSONC comments in mcp.json, and what happens when --repo is missing.';

  it('keeps CLI commands and flags as exact terms and prose brand words out of symbols', () => {
    const intent = analyzeQuery(abPrompt);
    expect(intent.exactTerms).toEqual(expect.arrayContaining(['vscode-install', '--repo']));
    expect(intent.symbols).not.toContain('OpenAI');
    expect(intent.exactTerms).not.toContain('OpenAI');
  });

  it('still treats multi-word class names as symbols', () => {
    expect(analyzeQuery('Where is OpenAICompatibleEmbeddingProvider?').symbols).toContain(
      'OpenAICompatibleEmbeddingProvider'
    );
    expect(analyzeQuery('Where is LanceVectorStore defined?').symbols).toContain('LanceVectorStore');
  });

  it('recognises environment keys and snake_case identifiers', () => {
    const intent = analyzeQuery('Set CODE_INTEL_EMBEDDING_API_KEY before calling get_task_context');
    expect(intent.symbols).toEqual(expect.arrayContaining(['CODE_INTEL_EMBEDDING_API_KEY', 'get_task_context']));
    expect(intent.exactTerms).toEqual(expect.arrayContaining(['CODE_INTEL_EMBEDDING_API_KEY', 'get_task_context']));
  });

  it('reads mcp.json as a JSON file name, not mcp.js', () => {
    expect(analyzeQuery(abPrompt).files).toEqual(['mcp.json']);
  });

  it('counts the parts of a multi-part request', () => {
    expect(analyzeQuery(abPrompt).clauses).toBeGreaterThanOrEqual(4);
    expect(analyzeQuery('Where is searchCodebase implemented?').clauses).toBe(1);
  });
});
