// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  cancelNativeBootLock,
  requestNativeBootLock,
  shouldLockNativeBoot,
} from './native-boot-lock';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('native boot lock', () => {
  test('forces exactly the next boot to lock despite a recent hide', () => {
    const storage = memoryStorage();
    requestNativeBootLock(storage);

    expect(shouldLockNativeBoot(true, storage)).toBe(true);
    expect(shouldLockNativeBoot(true, storage)).toBe(false);
  });

  test('preserves the normal cold-boot and grace-period decisions', () => {
    const storage = memoryStorage();

    expect(shouldLockNativeBoot(false, storage)).toBe(true);
    expect(shouldLockNativeBoot(true, storage)).toBe(false);
  });

  test('can cancel the override when activation fails', () => {
    const storage = memoryStorage();
    requestNativeBootLock(storage);
    cancelNativeBootLock(storage);

    expect(shouldLockNativeBoot(true, storage)).toBe(false);
  });
});
