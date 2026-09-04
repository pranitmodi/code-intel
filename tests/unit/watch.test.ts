import { describe, expect, it } from 'vitest';
import { watchIgnorePatterns } from '../../src/indexer/watch.js';

describe('watchIgnorePatterns', () => {
  it('turns gitignore-style directory and extension patterns into globs', () => {
    const patterns = watchIgnorePatterns();
    expect(patterns).toContain('**/node_modules/**');
    expect(patterns).toContain('**/.git/**');
    expect(patterns).toContain('**/*.lock');
  });
});
