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
import { McpConnectionsPage } from './admin.mcp-connections';
import type { McpConnectionsView } from '@/lib/api';

const api = vi.hoisted(() => ({
  fetchMcpConnections: vi.fn(),
  startMcpLogin: vi.fn(),
  completeMcpLogin: vi.fn(),
  cancelMcpLogin: vi.fn(),
  revokeMcpConnection: vi.fn(),
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

const service = (
  projects: McpConnectionsView['services'][number]['projects'],
) => ({ service: 'cloudinary', host: 'asset.example.com', projects });
const view = (
  projects: McpConnectionsView['services'][number]['projects'],
  logins: McpConnectionsView['logins'] = [],
): McpConnectionsView => ({ services: [service(projects)], logins });

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <McpConnectionsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe('MCP connections page', () => {
  it('keeps a failed load on screen without polling until Retry', async () => {
    vi.useFakeTimers();
    try {
      api.fetchMcpConnections.mockRejectedValueOnce(new Error('relay down'));
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <McpConnectionsPage />
        </QueryClientProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole('alert').textContent).toBe('relay down');

      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(screen.getByRole('alert').textContent).toBe('relay down');
      expect(screen.queryByRole('status')).toBeNull();
      expect(api.fetchMcpConnections).toHaveBeenCalledTimes(1);

      api.fetchMcpConnections.mockResolvedValue(view([]));
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(api.fetchMcpConnections).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(api.fetchMcpConnections).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders states, failed login error codes and the empty state', async () => {
    api.fetchMcpConnections.mockResolvedValue(
      view(
        [
          { project: 'carapa', state: 'connected' },
          { project: 'other', state: 'loginRequired' },
          { project: 'broken', state: 'refreshFailed' },
        ],
        [
          {
            id: 'login-1',
            service: 'cloudinary',
            project: 'other',
            state: 'failed',
            expiresAt: 1,
            error: 'resource_mismatch',
          },
        ],
      ),
    );
    renderPage();

    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText('Login required')).toBeTruthy();
    expect(screen.getByText('Refresh failed')).toBeTruthy();
    expect(screen.getByText('resource_mismatch')).toBeTruthy();

    cleanup();
    api.fetchMcpConnections.mockResolvedValue({ services: [], logins: [] });
    renderPage();
    expect(
      await screen.findByText(
        'No mcp-oauth services configured in CarapaBox relay-clients.',
      ),
    ).toBeTruthy();
  });

  it('connects: polls for the sign-in link, then completes with the pasted URL', async () => {
    const pending = (state: 'starting' | 'awaitingCallback') => ({
      id: 'login-1',
      service: 'cloudinary',
      project: 'other',
      state,
      expiresAt: Date.now() + 60_000,
      ...(state === 'awaitingCallback'
        ? { authorizationUrl: 'https://auth.example.com/authorize?x=1' }
        : {}),
    });
    const rows = [{ project: 'other', state: 'loginRequired' as const }];
    api.fetchMcpConnections
      .mockResolvedValueOnce(view(rows))
      .mockResolvedValueOnce(view(rows, [pending('starting')]))
      .mockResolvedValue(view(rows, [pending('awaitingCallback')]));
    api.startMcpLogin.mockResolvedValue({ id: 'login-1' });
    api.completeMcpLogin.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(api.startMcpLogin).toHaveBeenCalledWith({
      service: 'cloudinary',
      project: 'other',
    });

    const link = await screen.findByRole(
      'link',
      { name: 'Open sign-in' },
      { timeout: 5000 },
    );
    expect(link.getAttribute('href')).toBe(
      'https://auth.example.com/authorize?x=1',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    const callback = 'http://127.0.0.1:33418/callback?code=abc&state=def';
    await user.type(screen.getByLabelText('Callback URL'), callback);
    await user.click(screen.getByRole('button', { name: 'Complete login' }));
    await waitFor(() =>
      expect(api.completeMcpLogin).toHaveBeenCalledWith('login-1', callback),
    );
  });

  it('revokes only after confirmation and cancels a pending login', async () => {
    api.fetchMcpConnections.mockResolvedValue(
      view(
        [
          { project: 'carapa', state: 'connected' },
          { project: 'other', state: 'loginRequired' },
        ],
        [
          {
            id: 'login-2',
            service: 'cloudinary',
            project: 'other',
            state: 'starting',
            expiresAt: Date.now() + 60_000,
          },
        ],
      ),
    );
    api.revokeMcpConnection.mockResolvedValue({ ok: true });
    api.cancelMcpLogin.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(api.revokeMcpConnection).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() =>
      expect(api.revokeMcpConnection).toHaveBeenCalledWith({
        service: 'cloudinary',
        project: 'carapa',
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Cancel login' }));
    await waitFor(() =>
      expect(api.cancelMcpLogin).toHaveBeenCalledWith('login-2'),
    );
  });
});
