// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let nativeListener: ((state: { isActive: boolean }) => void) | undefined;
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event, listener) => {
      nativeListener = listener;
      return { remove: vi.fn(async () => {}) };
    }),
  },
}));

import { installWebSocketRecoveryListeners } from './websocket-lifecycle';

describe('WebSocket foreground recovery lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('coalesces native, visibility, and online recovery signals', async () => {
    const recover = vi.fn();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const cleanup = installWebSocketRecoveryListeners(recover);
    await vi.runOnlyPendingTimersAsync();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    nativeListener?.({ isActive: true });
    await vi.runOnlyPendingTimersAsync();

    expect(recover).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(recover).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('rechecks lock state after the native active event before recovering', async () => {
    const recover = vi.fn();
    let unlocked = true;
    const cleanup = installWebSocketRecoveryListeners(recover, () => unlocked);
    await Promise.resolve();
    nativeListener?.({ isActive: true });
    unlocked = false;
    await vi.runOnlyPendingTimersAsync();
    expect(recover).not.toHaveBeenCalled();
    cleanup();
  });
});
