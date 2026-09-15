import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsx = resolve(projectRoot, 'node_modules/.bin/tsx');
const cli = resolve(projectRoot, 'src/cli/index.ts');

describe('onboard CLI', () => {
  it('exposes onboard and doctor --fix in help', async () => {
    const { stdout: rootHelp } = await execFileAsync(tsx, [cli, '--help'], { cwd: projectRoot });
    expect(rootHelp).toContain('onboard');
    expect(rootHelp).toMatch(/pull the embedding model|index this repo|wire Cursor/i);

    const { stdout: doctorHelp } = await execFileAsync(tsx, [cli, 'doctor', '--help'], {
      cwd: projectRoot
    });
    expect(doctorHelp).toContain('--fix');

    const { stdout: onboardHelp } = await execFileAsync(tsx, [cli, 'onboard', '--help'], {
      cwd: projectRoot
    });
    expect(onboardHelp).toContain('--no-cursor');
  });
});
