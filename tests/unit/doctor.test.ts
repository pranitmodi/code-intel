import { describe, expect, it } from 'vitest';
import { ollamaHasModel } from '../../src/cli/doctor.js';

describe('ollamaHasModel', () => {
  it('matches a bare name and a tagged name', () => {
    expect(ollamaHasModel([{ name: 'nomic-embed-text:latest' }], 'nomic-embed-text')).toBe(true);
    expect(ollamaHasModel([{ name: 'nomic-embed-text' }], 'nomic-embed-text')).toBe(true);
    expect(ollamaHasModel([{ name: 'other' }], 'nomic-embed-text')).toBe(false);
  });
});
