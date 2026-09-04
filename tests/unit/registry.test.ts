import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listIndexedRepos,
  readRegistry,
  registryEntryFrom,
  removeRegistryEntry,
  resolveRepoRef,
  upsertRegistryEntry
} from '../../src/indexer/registry.js';
import { writeState } from '../../src/indexer/state.js';

describe('registry', () => {
  let dbHome: string;

  afterEach(async () => {
    if (dbHome) await rm(dbHome, { recursive: true, force: true });
  });

  async function emptyDb(): Promise<string> {
    dbHome = await mkdtemp(join(tmpdir(), 'code-intel-registry-'));
    return dbHome;
  }

  it('upserts, lists, resolves by id/name/path, and removes entries', async () => {
    const databasePath = await emptyDb();
    const savor = registryEntryFrom('/tmp/SavorApp', 'aaaaaaaaaaaaaaaa', {
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      filesIndexed: 10,
      chunksIndexed: 20,
      embeddingModel: 'nomic-embed-text'
    });
    const admin = registryEntryFrom('/tmp/savor-admin', 'bbbbbbbbbbbbbbbb', {
      lastIndexedAt: '2026-01-02T00:00:00.000Z',
      filesIndexed: 5,
      chunksIndexed: 8,
      embeddingModel: 'nomic-embed-text'
    });

    upsertRegistryEntry(databasePath, savor);
    upsertRegistryEntry(databasePath, admin);

    expect(readRegistry(databasePath).repos).toHaveLength(2);
    expect(resolveRepoRef(databasePath, 'aaaaaaaaaaaaaaaa')?.name).toBe('SavorApp');
    expect(resolveRepoRef(databasePath, 'savor-admin')?.id).toBe('bbbbbbbbbbbbbbbb');
    expect(resolveRepoRef(databasePath, '/tmp/SavorApp')?.id).toBe('aaaaaaaaaaaaaaaa');

    removeRegistryEntry(databasePath, savor.id);
    expect(listIndexedRepos(databasePath).map((r) => r.id)).toEqual(['bbbbbbbbbbbbbbbb']);
  });

  it('merges per-repo state.json onto the registry listing', async () => {
    const databasePath = await emptyDb();
    const repoId = 'cccccccccccccccc';
    const stateDir = join(databasePath, 'repos', repoId);
    await mkdir(stateDir, { recursive: true });
    writeState(join(stateDir, 'state.json'), {
      lastIndexedAt: '2026-02-01T00:00:00.000Z',
      lastDurationMs: 12,
      filesIndexed: 4,
      chunksIndexed: 9,
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 768,
      repoRoot: '/tmp/legacy-repo',
      repoName: 'legacy-repo'
    });

    const listed = listIndexedRepos(databasePath);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: repoId,
      path: '/tmp/legacy-repo',
      name: 'legacy-repo',
      filesIndexed: 4,
      chunksIndexed: 9
    });
  });
});
