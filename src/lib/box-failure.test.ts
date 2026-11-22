import { describe, test, expect } from 'bun:test';

import { summarizeBoxFailure } from './box-failure.js';

describe('summarizeBoxFailure', () => {
  test('returns the first line, bounded to 240 chars', () => {
    expect(summarizeBoxFailure('boom\nsecond\nthird')).toBe('boom');
    const out = summarizeBoxFailure(`${'y'.repeat(500)}\nrest`);
    expect(out).toBe('y'.repeat(240));
  });

  test('returns empty string for empty input', () => {
    expect(summarizeBoxFailure('')).toBe('');
    expect(summarizeBoxFailure(undefined)).toBe('');
  });
});
