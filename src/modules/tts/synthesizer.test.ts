import { afterEach, describe, expect, test } from 'bun:test';

import { normalizeTtsPunctuation, synthesize } from './synthesizer.js';

describe('normalizeTtsPunctuation', () => {
  test('strips emoji variation selector U+FE0F', () => {
    const out = normalizeTtsPunctuation('⚠️ ok');
    expect(out).not.toContain('️');
    expect(out).toBe('⚠ ok');
  });

  test('strips text variation selector U+FE0E', () => {
    expect(normalizeTtsPunctuation('a︎b')).toBe('ab');
  });

  test('still normalizes smart quotes and ellipsis', () => {
    expect(normalizeTtsPunctuation('“hi”…')).toBe('"hi"...');
  });
});

describe('normalizeTtsPunctuation math and arrow symbols', () => {
  test('maps symbols to spoken-friendly ASCII', () => {
    expect(normalizeTtsPunctuation('x ≥ 5')).toBe('x  >=  5');
    expect(normalizeTtsPunctuation('a→b')).toBe('a -> b');
    expect(normalizeTtsPunctuation('a↔b')).toBe('a <-> b');
    expect(normalizeTtsPunctuation('3×4≈12')).toBe('3 x 4 ~ 12');
  });
});

describe('synthesize unsupported character fallback', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(statuses: number[], detail: string) {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      const status = statuses[bodies.length - 1] ?? 200;
      return status === 200
        ? new Response(new Uint8Array([1, 2]), {
            headers: { 'X-Audio-Duration': '1' },
          })
        : new Response(detail, { status });
    }) as typeof fetch;
    return bodies;
  }

  const rejected = 'Found 1 unsupported character(s): [U+2603]';

  test('strips the rejected character and retries once', async () => {
    const bodies = mockFetch([500, 200], rejected);
    const out = await synthesize('it is ☃ outside');
    expect(out.audio.length).toBe(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('☃');
    expect(bodies[1]).not.toContain('☃');
    expect(JSON.parse(bodies[1]).text).toBe('it is outside');
  });

  test('rethrows when the retry also fails', async () => {
    const bodies = mockFetch([500, 500], rejected);
    await expect(synthesize('it is ☃ outside')).rejects.toThrow(/TTS 500/);
    expect(bodies).toHaveLength(2);
  });

  test('rethrows without retry when no characters can be parsed', async () => {
    const bodies = mockFetch([500], 'synthesis_failed');
    await expect(synthesize('hello')).rejects.toThrow(/TTS 500/);
    expect(bodies).toHaveLength(1);
  });
});
