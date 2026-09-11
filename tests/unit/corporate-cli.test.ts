import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('corporate-setup CLI', () => {
  it('fails cleanly without persisting or prompting when the company key is absent', async () => {
    const env = { ...process.env, NODE_USE_SYSTEM_CA: '1' };
    delete env.CODE_INTEL_EMBEDDING_API_KEY;

    await expect(
      execFileAsync(
        resolve(projectRoot, 'node_modules/.bin/tsx'),
        [
          resolve(projectRoot, 'src/cli/index.ts'),
          'corporate-setup',
          '--non-interactive',
          '--repo',
          projectRoot
        ],
        { cwd: projectRoot, env }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('API key (not saved to disk) is required')
    });
  });
});
