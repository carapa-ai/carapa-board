import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/router', () => ({
  router: { navigate: vi.fn(async () => {}) },
}));
vi.mock('@/lib/push', () => ({ initPush: vi.fn(), disposePush: vi.fn() }));
vi.mock('@/lib/websocket', () => ({
  connectWebSocket: vi.fn(),
  disconnectWebSocket: vi.fn(),
}));

import { AuthGate } from './auth-gate';
import { PinVaultSettings } from './account/pin-vault-settings';
import { login, useAuth } from '@/lib/auth';
import { enrollPinVault, hasPinVault, unlockPinVault } from '@/lib/pin-vault';
import {
  savePerUserDeviceCreds,
  vaultClearAll,
  vaultGetAuthToken,
  vaultGetDeviceCreds,
  vaultSetPinSession,
} from '@/lib/session-vault';

const PIN = '2468'; // legacy short PIN, enrolled directly (bypasses the UI policy)
const STRONG_PIN = 'abc12345';
const creds = {
  deviceId: 'dev-pin',
  pubKeyB64: 'pub-b64',
  privKeyB64: 'priv-b64',
};
const user = { id: 'u-alice', username: 'alice', role: 'user' as const };
const PLAINTEXT_KEYS = [
  'device_priv_key',
  'device_id',
  'device_pub_key',
  'auth_token',
];

function expectNoPlaintext() {
  for (const key of PLAINTEXT_KEYS)
    expect(localStorage.getItem(key)).toBeNull();
  expect(localStorage.getItem('carapa_device_alice')).toBeNull();
}

function stubFetch(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body))),
  );
}

beforeEach(() => {
  localStorage.clear();
  vaultClearAll();
  useAuth.setState({
    authRequired: null,
    authenticated: false,
    checking: true,
    locked: false,
    user: null,
    deviceApproved: null,
    duressMode: false,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('web PIN vault protects the logged-in session', () => {
  it('keeps keypair and token out of localStorage after PIN login, and persists them only wrapped', async () => {
    const enrolled = await enrollPinVault('alice', PIN, creds);
    expect(enrolled.ok).toBe(true);
    // Plaintext residue from before the PIN existed must be removed by login.
    localStorage.setItem('device_priv_key', 'stale');
    localStorage.setItem('auth_token', 'stale');
    stubFetch({ token: 'tok-1', user, device: { isApproved: true } });

    const result = await login(undefined, 'alice', 'pw', PIN);

    expect(result.ok).toBe(true);
    expectNoPlaintext();
    expect(vaultGetAuthToken()).toBe('tok-1');
    expect(vaultGetDeviceCreds()).toEqual({
      deviceId: 'dev-pin',
      privKeyB64: 'priv-b64',
    });
    const reopened = await unlockPinVault('alice', PIN);
    expect(reopened.ok && reopened.authToken).toBe('tok-1');
  });

  it('removes plaintext copies when the settings flow enrols a PIN', async () => {
    useAuth.setState({ user });
    savePerUserDeviceCreds('alice', creds);
    localStorage.setItem('device_priv_key', creds.privKeyB64);
    localStorage.setItem('device_id', creds.deviceId);
    localStorage.setItem('device_pub_key', creds.pubKeyB64);
    localStorage.setItem('auth_token', 'tok-live');

    render(<PinVaultSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Set up PIN/ }));
    fireEvent.change(screen.getByPlaceholderText('New PIN'), {
      target: { value: STRONG_PIN },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirm PIN'), {
      target: { value: STRONG_PIN },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText('New PIN')).toBeNull(),
    );
    expect(screen.queryByText(/Your PIN is short/)).toBeNull();
    expectNoPlaintext();
    expect(vaultGetAuthToken()).toBe('tok-live');
    expect(vaultGetDeviceCreds().privKeyB64).toBe(creds.privKeyB64);
  });

  it('rejects a weak PIN in the settings flow without enrolling', async () => {
    useAuth.setState({ user });
    savePerUserDeviceCreds('alice', creds);

    render(<PinVaultSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Set up PIN/ }));
    fireEvent.change(screen.getByPlaceholderText('New PIN'), {
      target: { value: '123456' },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirm PIN'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await screen.findByText(/PIN must be 8-64 characters/);
    expect(hasPinVault('alice')).toBe(false);
  });

  it('still unlocks a legacy short-PIN vault and warns about it in settings', async () => {
    await enrollPinVault('alice', PIN, creds);
    useAuth.setState({ user });

    render(<PinVaultSettings />);
    await screen.findByText(/Your PIN is short/);
    expect((await unlockPinVault('alice', PIN)).ok).toBe(true);
  });

  it('boots to a PIN lock screen that rejects a wrong PIN and unlocks with the right one', async () => {
    await enrollPinVault('alice', PIN, creds, 'tok-saved');
    vaultSetPinSession('alice');
    useAuth.setState({ locked: true });
    stubFetch({
      required: true,
      authenticated: true,
      user,
      device: { isApproved: true },
    });

    render(
      <AuthGate>
        <div>Signed-in content</div>
      </AuthGate>,
    );
    const input = await screen.findByPlaceholderText('PIN');
    expect(vaultGetAuthToken()).toBeNull();

    fireEvent.change(input, { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByText('Wrong PIN. 4 attempts left.');
    expect(screen.queryByText('Signed-in content')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('PIN'), {
      target: { value: PIN },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByText('Signed-in content');
    expect(vaultGetAuthToken()).toBe('tok-saved');
    expect(vaultGetDeviceCreds().deviceId).toBe('dev-pin');
    expectNoPlaintext();
  });
});
