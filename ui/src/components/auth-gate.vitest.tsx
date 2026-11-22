import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No build-time server: only a stored address can configure a native app.
vi.hoisted(() => {
  vi.stubEnv('VITE_LOCAL_IP', '');
  vi.stubEnv('VITE_API_URL', '');
});

const native = vi.hoisted(() => ({
  android: true,
  hasPin: false,
  verify: vi.fn(),
  request: vi.fn(),
  savedPassword: vi.fn(),
  resetPin: vi.fn(),
  sign: vi.fn(),
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...original,
    Capacitor: {
      ...original.Capacitor,
      isNativePlatform: () => native.android,
      getPlatform: () => (native.android ? 'android' : 'web'),
    },
    CapacitorHttp: { request: native.request },
  };
});
vi.mock('capacitor-native-biometric', () => ({
  NativeBiometric: {
    isAvailable: async () => ({ isAvailable: true }),
    verifyIdentity: native.verify,
    getCredentials: native.savedPassword,
  },
}));
vi.mock('@/lib/native-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/native-bridge')>()),
  get isNative() {
    return native.android;
  },
}));
vi.mock('@/lib/push-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push-bridge')>()),
  hasNativeCredentials: async () => true,
  nativeCanVerifyUser: async () => true,
  nativeHasAppPin: async () => native.hasPin,
  nativeResetAppPinAttempts: native.resetPin,
  nativeVerifyAppPin: async () => ({ ok: true }),
  nativeSignPayload: native.sign,
}));
vi.mock('@/lib/router', () => ({
  router: { navigate: vi.fn(async () => {}) },
}));
vi.mock('@/lib/push', () => ({ initPush: vi.fn(), disposePush: vi.fn() }));
vi.mock('@/lib/websocket', () => ({
  connectWebSocket: vi.fn(),
  disconnectWebSocket: vi.fn(),
}));

import { AuthGate } from './auth-gate';
import { setServerConfig } from '@/lib/api-config';
import { useAuth } from '@/lib/auth';
import { initPush } from '@/lib/push';
import { vaultClearAll, vaultGetAuthToken } from '@/lib/session-vault';

const user = { id: 'tablet-user', username: 'tablet', role: 'admin' };

beforeEach(() => {
  vi.clearAllMocks();
  native.android = true;
  setServerConfig({ homeUrl: 'https://board.test' });
  native.hasPin = false;
  native.verify.mockReset().mockResolvedValue(undefined);
  native.savedPassword.mockResolvedValue(null);
  native.sign.mockResolvedValue({
    signature: 'device-signature',
    deviceId: 'tablet-device',
  });
  native.request.mockReset().mockImplementation(async ({ url, headers }) => {
    expect(new Headers(headers).get('X-Carapa-Device-ID')).toBe(
      'tablet-device',
    );
    expect(new Headers(headers).get('X-Carapa-Signature')).toBe(
      'device-signature',
    );
    expect(native.verify).toHaveBeenCalledOnce();
    if (url.endsWith('/api/auth/token')) {
      return {
        status: 200,
        data: JSON.stringify({ token: 'renewed-session' }),
        headers: {},
      };
    }
    expect(url.endsWith('/api/auth/check')).toBe(true);
    expect(new Headers(headers).get('Authorization')).toBe(
      'Bearer renewed-session',
    );
    return {
      status: 200,
      data: JSON.stringify({
        required: true,
        authenticated: true,
        user,
        device: { isApproved: true },
      }),
      headers: {},
    };
  });
  vaultClearAll();
  localStorage.setItem('auth_token', 'expired-session');
  useAuth.setState({
    authRequired: null,
    authenticated: false,
    checking: true,
    locked: true,
    user: null,
    deviceApproved: null,
    duressMode: false,
    sessionExpired: false,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            required: true,
            authenticated: false,
            user: null,
            device: null,
          }),
        ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setServerConfig(null);
});

describe('expired-session recovery', () => {
  it.each([false, true])(
    'restores Android with biometrics and respects app PIN=%s',
    async (hasPin) => {
      native.hasPin = hasPin;
      render(
        <AuthGate>
          <div>Signed-in content</div>
        </AuthGate>,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'Login with Biometrics' }),
      );

      if (hasPin) {
        await screen.findByRole('heading', { name: 'Enter PIN' });
        expect(screen.queryByText('Signed-in content')).toBeNull();
        expect(native.resetPin).not.toHaveBeenCalled();
        expect(initPush).not.toHaveBeenCalled();
        fireEvent.change(screen.getByPlaceholderText('PIN'), {
          target: { value: '1234' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      }
      await screen.findByText('Signed-in content');
      expect(vaultGetAuthToken()).toBe('renewed-session');
      expect(useAuth.getState().user?.id).toBe(user.id);
      expect(native.savedPassword).not.toHaveBeenCalled();
      expect(native.verify).toHaveBeenCalledOnce();
      expect(native.request).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(initPush).toHaveBeenCalledOnce());
    },
  );

  it('keeps the login available after cancellation, a revoked device, or a network failure', async () => {
    native.verify.mockRejectedValueOnce({
      code: '13',
      message: 'User canceled',
    });
    render(
      <AuthGate>
        <div>Signed-in content</div>
      </AuthGate>,
    );
    const button = await screen.findByRole('button', {
      name: 'Login with Biometrics',
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    expect(native.request).not.toHaveBeenCalled();

    native.request.mockResolvedValueOnce({
      status: 401,
      data: '{}',
      headers: {},
    });
    fireEvent.click(button);
    await screen.findByText(/This device could not restore your session/);
    expect(vaultGetAuthToken()).toBe('expired-session');

    native.request.mockRejectedValueOnce(new Error('Offline'));
    fireEvent.click(button);
    await screen.findByText(/Check your connection and try again/);
    expect(screen.queryByText('Signed-in content')).toBeNull();
    expect(useAuth.getState().authenticated).toBe(false);
    expect(native.savedPassword).not.toHaveBeenCalled();
    expect(vaultGetAuthToken()).toBe('expired-session');
  });

  it('keeps an expired browser session on password login', async () => {
    native.android = false;
    render(
      <AuthGate>
        <div>Signed-in content</div>
      </AuthGate>,
    );
    await screen.findByPlaceholderText('Password');
    expect(
      screen.queryByRole('button', { name: 'Login with Biometrics' }),
    ).toBeNull();
    expect(screen.queryByText('Signed-in content')).toBeNull();
    expect(native.verify).not.toHaveBeenCalled();
    expect(native.request).not.toHaveBeenCalled();
  });

  it('explains a 401 on the login screen, but not on cold start or after logout', async () => {
    native.android = false;
    useAuth.setState({
      authRequired: true,
      authenticated: false,
      checking: false,
    });
    render(
      <AuthGate>
        <div>Signed-in content</div>
      </AuthGate>,
    );
    await screen.findByPlaceholderText('Password');
    expect(screen.queryByText(/Your session expired/)).toBeNull();

    act(() =>
      useAuth.getState().setAuth(true, true, { ...user, role: 'admin' }),
    );
    await screen.findByText('Signed-in content');
    act(() => useAuth.getState().expireSession());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your session expired. Sign in again.',
    );
    expect(screen.queryByText('Signed-in content')).toBeNull();

    act(() =>
      useAuth.getState().setAuth(true, true, { ...user, role: 'admin' }),
    );
    await screen.findByText('Signed-in content');
    expect(useAuth.getState().sessionExpired).toBe(false);

    // A late 401 from a request in flight during logout must not flag it.
    act(() => useAuth.getState().setAuth(true, false, null));
    act(() => useAuth.getState().expireSession());
    await screen.findByPlaceholderText('Password');
    expect(screen.queryByText(/Your session expired/)).toBeNull();
  });

  it('shows the setup screen, and contacts no server, when none is configured', async () => {
    // A previous server's identity, e.g. after "Reset to app defaults".
    setServerConfig(null);
    useAuth.setState({
      authRequired: null,
      checking: true,
      user: { ...user, role: 'admin' },
    });
    render(
      <AuthGate>
        <div>Signed-in content</div>
      </AuthGate>,
    );
    await screen.findByText('Set up your server');
    expect(screen.getByText(/scan the setup QR code/)).toBeTruthy();
    expect(screen.queryByText('Connection Failed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // Not "checking", so a setup link can be handled on this screen.
    expect(useAuth.getState().checking).toBe(false);
    expect(useAuth.getState().user).toBeNull();
    expect(localStorage.getItem('auth_user')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Enter the address manually' }),
    );
    await screen.findAllByPlaceholderText('https://board.example.com');
    expect(fetch).not.toHaveBeenCalled();
    expect(native.request).not.toHaveBeenCalled();
  });

  it('runs the normal auth check, not the setup screen, when a server is configured', async () => {
    render(
      <AuthGate>
        <div>Signed-in content</div>
      </AuthGate>,
    );
    await screen.findByRole('button', { name: 'Login with Biometrics' });
    expect(screen.queryByText('Set up your server')).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/check'),
      expect.anything(),
    );
  });
});
