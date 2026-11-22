import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const mocks = vi.hoisted(() => ({
  sendDuressSignal: vi.fn(),
  clearNativeCredentials: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  sendDuressSignal: mocks.sendDuressSignal,
}));
vi.mock('@/lib/push-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push-bridge')>()),
  clearNativeCredentials: mocks.clearNativeCredentials,
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  logout: mocks.logout,
}));

import { runDuressSequence } from './duress';
import { handleVerifyFailure } from '@/components/account/pin-settings';
import { useAuth } from '@/lib/auth';

beforeEach(() => {
  calls.length = 0;
  mocks.sendDuressSignal.mockReset().mockImplementation(async () => {
    calls.push('signal');
  });
  mocks.clearNativeCredentials.mockReset().mockImplementation(async () => {
    calls.push('clear');
  });
  mocks.logout.mockReset().mockImplementation(async () => {
    calls.push('logout');
  });
  useAuth.setState({ duressMode: false });
});

describe('runDuressSequence', () => {
  it('signals, wipes credentials, logs out, then enables duress mode', async () => {
    await runDuressSequence();
    expect(calls).toEqual(['signal', 'clear', 'logout']);
    expect(useAuth.getState().duressMode).toBe(true);
  });

  it('still wipes credentials when the duress signal fails', async () => {
    mocks.sendDuressSignal.mockRejectedValue(new Error('offline'));
    await runDuressSequence();
    expect(calls).toEqual(['clear', 'logout']);
    expect(useAuth.getState().duressMode).toBe(true);
  });
});

describe('PIN settings duress entry', () => {
  it('runs the duress sequence and reports the form as taken over', async () => {
    const setError = vi.fn();
    const handled = await handleVerifyFailure(
      { ok: false, reason: 'duress' },
      setError,
    );
    expect(handled).toBe(true);
    expect(calls).toEqual(['signal', 'clear', 'logout']);
    expect(useAuth.getState().duressMode).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });
});
