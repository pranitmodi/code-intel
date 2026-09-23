import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveCliEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, '..', '..');
  const distCli = join(packageRoot, 'dist', 'cli', 'index.js');
  if (existsSync(distCli)) return distCli;
  throw new Error(`Built CLI not found at ${distCli} — run \`npm run build\` first.`);
}

export function packageRootFromCli(cliPath: string): string {
  const marker = `${sep}dist${sep}cli${sep}index.js`;
  if (cliPath.endsWith(marker)) return resolve(cliPath, '..', '..', '..');
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}
