import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { watchTargetsForWorkspace } from '../../src/mcp/watchOnStart.js';

describe('watchTargetsForWorkspace', () => {
  const parent = '/Users/me/workspace';
  const admin = `${parent}/admin`;
  const web = `${parent}/web`;
  const app = `${parent}/app`;
  const other = '/Users/me/other-project';

  it('watches indexed children when the workspace is a parent folder', () => {
    expect(watchTargetsForWorkspace(parent, [admin, web, app, other])).toEqual([admin, web, app]);
  });

  it('watches only the repo when the workspace itself is indexed', () => {
    expect(watchTargetsForWorkspace(app, [admin, web, app, other])).toEqual([app]);
  });

  it('watches nothing without a workspace root', () => {
    expect(watchTargetsForWorkspace(undefined, [admin, web, app])).toEqual([]);
  });

  it('watches the owning repo when a subfolder of it is opened', () => {
    expect(watchTargetsForWorkspace(`${app}/packages/ui`, [admin, web, app, other])).toEqual([app]);
  });

  it('prefers the deepest owning repo and ignores name-prefix siblings', () => {
    const nested = `${app}/vendor/lib`;
    expect(watchTargetsForWorkspace(`${nested}/src`, [app, nested])).toEqual([nested]);
    expect(watchTargetsForWorkspace(`${parent}/app-two`, [app])).toEqual([]);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('enables incremental watch by default', () => {
    expect(DEFAULT_CONFIG.indexing.watch).toBe(true);
  });

  it('indexes up to four files at once by default', () => {
    expect(DEFAULT_CONFIG.indexing.concurrency).toBe(4);
  });
});
