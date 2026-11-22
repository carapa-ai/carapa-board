import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesTab } from './devices-tab';

const api = vi.hoisted(() => ({
  removeDevice: vi.fn(),
  devices: [] as Array<Record<string, unknown>>,
}));

function device(
  deviceId: string,
  label: string,
  overrides: {
    isActive?: boolean;
    isApproved?: boolean;
    isCurrent?: boolean;
  } = {},
) {
  return {
    kind: 'interactive',
    scopes: [],
    expiresAt: null,
    deviceId,
    label,
    createdAt: '2026-08-20T00:00:00.000Z',
    lastUsedAt: '2026-08-20T00:00:00.000Z',
    isActive: true,
    isApproved: true,
    isCurrent: false,
    ...overrides,
  };
}

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DevicesTab />
    </QueryClientProvider>,
  );
}

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ logout: vi.fn() }));
vi.mock('./device-pairing', () => ({ IntegrationDetails: () => null }));
vi.mock('@/lib/api', () => ({
  fetchUserDevices: async () => ({
    currentDeviceId: 'device-a',
    devices: api.devices,
  }),
  updateDeviceStatus: vi.fn(),
  updateDeviceLabel: vi.fn(),
  removeDevice: api.removeDevice,
}));

beforeEach(() => {
  api.devices = [
    device('device-a', 'This laptop', { isCurrent: true }),
    device('device-b', 'Other phone'),
  ];
});

afterEach(() => {
  cleanup();
  api.removeDevice.mockReset();
});

async function removeButtonFor(label: string) {
  const row = (await screen.findByText(label)).closest(
    'div.relative',
  ) as HTMLElement;
  return within(row).getByRole('button', { name: 'Remove' });
}

describe('DevicesTab remove confirmation', () => {
  it('disables the confirm button while the removal is pending', async () => {
    let finish!: (value: { signedOut: boolean }) => void;
    api.removeDevice.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderTab();

    fireEvent.click(await removeButtonFor('Other phone'));
    const confirm = screen.getAllByRole('button', { name: 'Remove' }).at(-1)!;
    fireEvent.click(confirm);

    await waitFor(() =>
      expect((confirm as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.click(confirm);
    expect(api.removeDevice).toHaveBeenCalledTimes(1);
    finish({ signedOut: false });
  });

  it('exposes an alertdialog that takes focus and closes on Escape', async () => {
    renderTab();

    fireEvent.click(await removeButtonFor('Other phone'));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Remove this device?',
    });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Cancel' }),
    );

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.removeDevice).not.toHaveBeenCalled();
  });

  it('gives the rename input an accessible name', async () => {
    renderTab();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Rename Other phone' }),
    );
    expect(
      screen.getByRole('textbox', { name: 'Name for Other phone' }),
    ).toBeTruthy();
  });
});

describe('DevicesTab last active device', () => {
  it('disables Remove with a visible hint for the sole active device', async () => {
    api.devices = [device('device-a', 'This laptop', { isCurrent: true })];
    renderTab();

    const remove = (await removeButtonFor('This laptop')) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    const hint = screen.getByText('Add another device to remove this one');
    expect(remove.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('keeps Remove enabled on every device when two are active', async () => {
    renderTab();

    expect(
      ((await removeButtonFor('This laptop')) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      ((await removeButtonFor('Other phone')) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('only blocks the active device when the other one is inactive', async () => {
    api.devices = [
      device('device-a', 'This laptop', { isCurrent: true }),
      device('device-b', 'Other phone', { isActive: false }),
    ];
    renderTab();

    expect(
      ((await removeButtonFor('This laptop')) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      ((await removeButtonFor('Other phone')) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('does not count a pending device as a second active device', async () => {
    api.devices = [
      device('device-a', 'This laptop', { isCurrent: true }),
      device('device-b', 'New browser', { isApproved: false }),
    ];
    renderTab();

    expect(
      ((await removeButtonFor('This laptop')) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      ((await removeButtonFor('New browser')) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('labels the rename button with the device name', async () => {
    renderTab();

    expect(
      await screen.findByRole('button', { name: 'Rename This laptop' }),
    ).toBeTruthy();
  });
});
