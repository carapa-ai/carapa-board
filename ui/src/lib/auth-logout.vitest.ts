import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sonner')>()),
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

import { logout, useAuth } from './auth';

const fetchMock = vi.fn();

beforeEach(() => {
  toastError.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  useAuth.getState().setAuth(true, true, null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('logout server-session warning', () => {
  it('clears local state and warns once when the server returns 503', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await logout();
    expect(useAuth.getState().authenticated).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('clears local state and warns when the request rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await logout();
    expect(useAuth.getState().authenticated).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('does not warn when the server ends the session', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await logout();
    expect(useAuth.getState().authenticated).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });
});
