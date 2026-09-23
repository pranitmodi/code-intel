import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tests must not read the developer's global config, credentials, or editor
 * profiles, nor write into them. Workers inherit this environment.
 */
export default function isolateEnvironment(): () => void {
  const home = mkdtempSync(join(tmpdir(), 'code-intel-test-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.XDG_CONFIG_HOME;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CODE_INTEL_')) delete process.env[key];
  }
  return () => rmSync(home, { recursive: true, force: true });
}
