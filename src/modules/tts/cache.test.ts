import { describe, expect, test } from 'bun:test';
import { ttsCacheKey } from './cache.js';

describe('TTS content-addressed cache key', () => {
  test('is deterministic for the same complete synthesis specification', async () => {
    const first = await ttsCacheKey('Hello world.', {
      voice: 'M1',
      lang: 'en',
      format: 'ogg',
      steps: 8,
      speed: 1,
    });
    const second = await ttsCacheKey('Hello world.', {
      voice: 'M1',
      lang: 'en',
      format: 'ogg',
      steps: 8,
      speed: 1,
    });
    expect(first.id).toBe(second.id);
  });

  test('separates text, voice, language, and synthesis settings', async () => {
    const base = (
      await ttsCacheKey('Hello.', { voice: 'M1', lang: 'en', steps: 8 })
    ).id;
    expect(
      (await ttsCacheKey('Goodbye.', { voice: 'M1', lang: 'en', steps: 8 })).id,
    ).not.toBe(base);
    expect(
      (await ttsCacheKey('Hello.', { voice: 'F1', lang: 'en', steps: 8 })).id,
    ).not.toBe(base);
    expect(
      (await ttsCacheKey('Hello.', { voice: 'M1', lang: 'ro', steps: 8 })).id,
    ).not.toBe(base);
    expect(
      (await ttsCacheKey('Hello.', { voice: 'M1', lang: 'en', steps: 10 })).id,
    ).not.toBe(base);
  });
});
