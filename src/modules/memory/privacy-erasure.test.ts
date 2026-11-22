import { createHash } from 'crypto';
import { describe, expect, test } from 'bun:test';
import { mayHaveGraphStorage } from './privacy-erasure.js';
import { protectedTargetTokens } from './privacy-token.js';

describe('privacy erasure', () => {
  test('treats a truly unconfigured vector store as having no external graph', () => {
    expect(mayHaveGraphStorage(false, false, '')).toBe(false);
    expect(mayHaveGraphStorage(false, true, '')).toBe(true);
    expect(mayHaveGraphStorage(false, false, 'configured-secret')).toBe(true);
  });

  test('durable matching tokens are keyed rather than dictionary hashes', () => {
    const [token] = protectedTargetTokens('jasmine');
    const dictionaryHash = createHash('sha256').update('jasmine').digest('hex');
    expect(token).not.toBe(dictionaryHash);
    expect(token).toHaveLength(64);
  });
});
