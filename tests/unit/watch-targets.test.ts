import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { watchTargetsForWorkspace } from '../../src/mcp/watchOnStart.js';

describe('watchTargetsForWorkspace', () => {
  const savor = '/Users/me/Savor - Food with friends';
  const admin = `${savor}/savor-admin`;
  const web = `${savor}/savor-web`;
  const app = `${savor}/SavorApp`;
  const other = '/Users/me/LocalCodeDB';

  it('watches indexed children when the workspace is a parent folder', () => {
    expect(watchTargetsForWorkspace(savor, [admin, web, app, other])).toEqual([admin, web, app]);
  });

  it('watches only the repo when the workspace itself is indexed', () => {
    expect(watchTargetsForWorkspace(app, [admin, web, app, other])).toEqual([app]);
  });

  it('watches nothing without a workspace root', () => {
    expect(watchTargetsForWorkspace(undefined, [admin, web, app])).toEqual([]);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('enables incremental watch by default', () => {
    expect(DEFAULT_CONFIG.indexing.watch).toBe(true);
  });
});
