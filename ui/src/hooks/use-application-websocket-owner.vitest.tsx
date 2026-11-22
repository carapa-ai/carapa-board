// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth';
import { useApplicationWebSocketOwner } from './use-application-websocket-owner';

describe('application WebSocket owner', () => {
  beforeEach(() => {
    useAuth.setState({
      authRequired: true,
      authenticated: true,
      locked: true,
      deviceApproved: true,
    });
  });

  it('connects exactly once after a locked foreground is unlocked', () => {
    const removeRecoveryListeners = vi.fn();
    const dependencies = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      installRecoveryListeners: vi.fn(() => removeRecoveryListeners),
    };
    const { unmount } = renderHook(() =>
      useApplicationWebSocketOwner(dependencies),
    );

    expect(dependencies.connect).not.toHaveBeenCalled();

    act(() => useAuth.getState().setLocked(false));
    expect(dependencies.connect).toHaveBeenCalledTimes(1);
    expect(dependencies.connect).toHaveBeenLastCalledWith(false);
    expect(dependencies.installRecoveryListeners).toHaveBeenCalledTimes(1);

    act(() => useAuth.getState().setLocked(false));
    expect(dependencies.connect).toHaveBeenCalledTimes(1);

    act(() => useAuth.getState().setLocked(true));
    expect(removeRecoveryListeners).toHaveBeenCalledTimes(1);
    expect(dependencies.disconnect).toHaveBeenCalledTimes(1);

    act(() => useAuth.getState().setLocked(false));
    expect(dependencies.connect).toHaveBeenCalledTimes(2);
    expect(dependencies.installRecoveryListeners).toHaveBeenCalledTimes(2);

    unmount();
    expect(dependencies.disconnect).toHaveBeenCalledTimes(2);
  });
});
