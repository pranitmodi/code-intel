import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverFiles } from '../../src/discovery/discover.js';
import { resolveIndexRoots } from '../../src/discovery/gitRoots.js';

describe('discoverFiles', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'code-intel-discovery-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function write(relativePath: string, content = ''): Promise<void> {
    const fullPath = join(repoRoot, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content);
  }

  it('excludes dependency/build directories and mobile-specific vendor directories by default', async () => {
    await write('src/index.ts', 'export const a = 1;');
    await write('node_modules/pkg/index.js', 'module.exports = {};');
    await write('apps/mobile/ios/Pods/SomePod/SomePod.swiftinterface', 'nonsense');
    await write('apps/mobile/ios/DerivedData/foo.txt', 'nonsense');
    await write('apps/mobile/.expo/settings.json', '{}');
    await write('apps/mobile/ios/MyApp.xcworkspace/contents.xcworkspacedata', '<x/>');

    const files = await discoverFiles(repoRoot, { allowSensitiveFiles: false, extraIgnorePatterns: [] });
    const relativePaths = files.map((f) => f.relativePath);

    expect(relativePaths).toEqual(['src/index.ts']);
  });

  it('respects .gitignore in addition to the built-in defaults', async () => {
    await write('.gitignore', 'generated/\n');
    await write('src/index.ts', 'export const a = 1;');
    await write('generated/output.ts', 'export const b = 2;');

    const files = await discoverFiles(repoRoot, { allowSensitiveFiles: false, extraIgnorePatterns: [] });
    // .gitignore itself is a small, harmless text file and is legitimately discovered too —
    // only the path it excludes (generated/) should be missing.
    expect(files.map((f) => f.relativePath).sort()).toEqual(['.gitignore', 'src/index.ts']);
  });

  it('excludes secret-shaped files unless allowSensitiveFiles is set', async () => {
    await write('.env', 'SECRET=1');
    await write('src/index.ts', 'export const a = 1;');

    const excluded = await discoverFiles(repoRoot, { allowSensitiveFiles: false, extraIgnorePatterns: [] });
    expect(excluded.map((f) => f.relativePath)).toEqual(['src/index.ts']);

    const included = await discoverFiles(repoRoot, { allowSensitiveFiles: true, extraIgnorePatterns: [] });
    expect(included.map((f) => f.relativePath).sort()).toEqual(['.env', 'src/index.ts']);
  });

  it('honors user-configured extra ignore patterns', async () => {
    await write('src/index.ts', 'export const a = 1;');
    await write('scripts/one-off.ts', 'export const b = 2;');

    const files = await discoverFiles(repoRoot, { allowSensitiveFiles: false, extraIgnorePatterns: ['scripts/'] });
    expect(files.map((f) => f.relativePath)).toEqual(['src/index.ts']);
  });

  it('excludes generated assets, model files, and logs by default', async () => {
    await write('src/index.ts', 'export const a = 1;');
    await write('assets/banner.svg', '<svg/>');
    await write('models/embed.onnx', 'generated model');
    await write('logs/server.log', 'generated log');

    const files = await discoverFiles(repoRoot, { allowSensitiveFiles: false, extraIgnorePatterns: [] });
    expect(files.map((f) => f.relativePath)).toEqual(['src/index.ts']);
  });

  it('treats nested Git repositories as separate index boundaries', async () => {
    await write('notes.md', 'workspace notes');
    await write('repo-a/.git/HEAD', 'ref: refs/heads/main');
    await write('repo-a/src/a.ts', 'export const a = 1;');
    await write('group/repo-b/.git/HEAD', 'ref: refs/heads/main');
    await write('group/repo-b/src/b.ts', 'export const b = 2;');

    const files = await discoverFiles(repoRoot, { allowSensitiveFiles: false, extraIgnorePatterns: [] });
    expect(files.map((file) => file.relativePath)).toEqual(['notes.md']);
    await expect(resolveIndexRoots(repoRoot)).resolves.toEqual([
      join(repoRoot, 'group/repo-b'),
      join(repoRoot, 'repo-a')
    ]);
    await expect(resolveIndexRoots(join(repoRoot, 'repo-a/src'))).resolves.toEqual([
      join(repoRoot, 'repo-a')
    ]);
  });
});
