import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSecretPath } from '../../src/discovery/discover.js';
import { getFileContext } from '../../src/search/getFileContext.js';

describe('getFileContext', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-file-context-'));
    await mkdir(join(repoRoot, 'config'), { recursive: true });
    await writeFile(join(repoRoot, 'app.ts'), 'line1\nline2\nline3\n');
    await writeFile(join(repoRoot, '.env'), 'API_KEY=secret\n');
    await writeFile(join(repoRoot, 'config', 'server.pem'), '-----BEGIN KEY-----\n');
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('reads a line range from the working tree', async () => {
    const context = await getFileContext(repoRoot, 'app.ts', 2, 3);
    expect(context).toEqual({ file: 'app.ts', startLine: 2, endLine: 3, content: 'line2\nline3' });
  });

  it('refuses files the indexer skips as likely secrets', async () => {
    await expect(getFileContext(repoRoot, '.env')).rejects.toThrow(/secrets/);
    await expect(getFileContext(repoRoot, './.env')).rejects.toThrow(/secrets/);
    await expect(getFileContext(repoRoot, 'config/server.pem')).rejects.toThrow(/secrets/);
  });

  it('reads secret-pattern files only when sensitive files are allowed', async () => {
    const context = await getFileContext(repoRoot, '.env', undefined, undefined, { allowSensitiveFiles: true });
    expect(context.content).toContain('API_KEY');
  });

  it('still rejects paths outside the repository', async () => {
    await expect(getFileContext(repoRoot, '../outside.ts')).rejects.toThrow(/escapes/);
  });
});

describe('isSecretPath', () => {
  it('matches the default secret patterns at any depth', () => {
    expect(isSecretPath('.env.local')).toBe(true);
    expect(isSecretPath('deploy/id_rsa')).toBe(true);
    expect(isSecretPath('src/env.ts')).toBe(false);
    expect(isSecretPath('package.json')).toBe(false);
  });
});
