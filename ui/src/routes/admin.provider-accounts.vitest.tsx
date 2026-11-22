import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderAccountsPage } from './admin.provider-accounts';

const api = vi.hoisted(() => ({
  fetchProviderAccounts: vi.fn(),
  fetchProviderUsage: vi.fn(),
  startProviderLogin: vi.fn(),
  completeProviderLogin: vi.fn(),
  cancelProviderLogin: vi.fn(),
  updateProviderAccount: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: unknown) => unknown) =>
    select({ user: { role: 'admin' } }),
}));
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

const id = '0f8fad5b-d9cb-469f-a165-8c4b1a2b3c4d';
const listing = () => ({
  accounts: [
    {
      id,
      provider: 'anthropic',
      label: 'Main',
      scope: 'shared',
      state: 'connected',
      tier: 'Max',
      capacity: 100,
    },
  ],
  clients: [],
  logins: [],
});
const usage = () => ({
  usage: {
    [id]: {
      windows: [{ label: 'Weekly', usedPercent: 87 }],
      fetchedAt: Date.now(),
    },
  },
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProviderAccountsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe('provider account edit', () => {
  it('keeps a failed load on screen without polling until Retry', async () => {
    vi.useFakeTimers();
    try {
      api.fetchProviderAccounts.mockRejectedValueOnce(new Error('relay down'));
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <ProviderAccountsPage />
        </QueryClientProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole('alert').textContent).toBe('relay down');

      await act(() => vi.advanceTimersByTimeAsync(7000));
      expect(screen.getByRole('alert').textContent).toBe('relay down');
      expect(screen.queryByRole('status')).toBeNull();
      expect(api.fetchProviderAccounts).toHaveBeenCalledTimes(1);

      api.fetchProviderAccounts.mockResolvedValue(listing());
      api.fetchProviderUsage.mockResolvedValue({ usage: {} });
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(api.fetchProviderAccounts).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(api.fetchProviderAccounts).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows capacity left per window and sends only the changed fields', async () => {
    api.fetchProviderAccounts.mockResolvedValue(listing());
    api.fetchProviderUsage.mockResolvedValue(usage());
    api.updateProviderAccount.mockResolvedValue({});
    renderPage();
    expect(await screen.findByText(/≈ 13 of 100 left/)).toBeTruthy();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Label'));
    await user.type(screen.getByLabelText('Label'), 'Renamed');
    await user.clear(screen.getByLabelText('Capacity'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(api.updateProviderAccount).toHaveBeenCalledWith(id, {
        label: 'Renamed',
        capacity: null,
      }),
    );
    expect(api.updateProviderAccount.mock.calls[0][1]).not.toHaveProperty(
      'tier',
    );
  });

  it('shows the validation message Box returns for a rejected edit', async () => {
    api.fetchProviderAccounts.mockResolvedValue(listing());
    api.fetchProviderUsage.mockResolvedValue({ usage: {} });
    api.updateProviderAccount.mockRejectedValue(
      new Error('tier is not allowed for this provider'),
    );
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Tier'));
    await user.type(screen.getByLabelText('Tier'), 'Pro');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'tier is not allowed for this provider',
    );
  });

  it('reconnects an API-key account by sending a new key, never by starting a login', async () => {
    api.fetchProviderAccounts.mockResolvedValue({
      accounts: [
        {
          id,
          provider: 'mistral-vibe',
          label: 'Seat 2',
          scope: 'client',
          client: 'carapa-board',
          state: 'connected',
        },
      ],
      clients: [{ name: 'carapa-board', isolation: 'shared', patterns: [] }],
      logins: [],
    });
    api.fetchProviderUsage.mockResolvedValue({ usage: {} });
    api.startProviderLogin.mockResolvedValue({ id, installed: true });
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reconnect' }));
    expect(api.startProviderLogin).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: 'Save key' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('API key'), 'new-vibe-key');
    await user.click(save);

    await waitFor(() =>
      expect(api.startProviderLogin.mock.calls[0]?.[0]).toEqual({
        provider: 'mistral-vibe',
        label: 'Seat 2',
        scope: 'client',
        client: 'carapa-board',
        apiKey: 'new-vibe-key',
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe(
        '',
      ),
    );
  });
});
