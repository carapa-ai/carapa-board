import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearAvatarGenerationStates,
  startAvatarGeneration,
} from './avatar-generation.js';

afterEach(clearAvatarGenerationStates);

describe('AI user avatar background generation', () => {
  test('deduplicates concurrent starts for the same AI user', async () => {
    let calls = 0;
    const started = Promise.withResolvers<void>();
    const work = new Promise<void>(() => {});
    const generate = () => {
      calls += 1;
      started.resolve();
      return work;
    };

    startAvatarGeneration('ai-1', generate);
    startAvatarGeneration('ai-1', generate);
    await started.promise;
    expect(calls).toBe(1);
  });
});
