// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { liveModeSessionId } from './live-mode-session';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('Live Mode browser session identity', () => {
  it('survives a refresh within the same tab session', () => {
    const storage = memoryStorage();
    const first = liveModeSessionId(false, storage);
    expect(liveModeSessionId(false, storage)).toBe(first);
  });

  it('rotates ownership when user-bound state is reset', () => {
    const storage = memoryStorage();
    const first = liveModeSessionId(false, storage);
    expect(liveModeSessionId(true, storage)).not.toBe(first);
  });
});
