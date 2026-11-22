import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { NotificationOverlayHost } from './NotificationOverlayHost';
import { UnreadBell } from './UnreadBell';
import {
  closeNotification,
  openNotification,
} from '@/lib/notification-overlay';
import { gatedNavigate, gatedOpenNotification } from '@/lib/push';
import { useAuth } from '@/lib/auth';

const fetchUnreadNotifications = vi.hoisted(() => vi.fn());
const apiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-unread-notifications', () => ({
  useUnreadNotifications: () => ({ data: fetchUnreadNotifications() }),
  invalidateUnreadNotifications: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  apiFetch,
  fetchAttention: async () => ({ items: [], objectives: [] }),
  acknowledgeUnreadNotifications: vi.fn(),
}));
vi.mock('@/lib/api-config', () => ({ API_BASE_URL: '' }));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    registerPlugin: () => ({ addListener: vi.fn() }),
  },
}));
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: {} }));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: {} }));
vi.mock('@/lib/push-bridge', () => ({
  attachNotifTapListener: vi.fn(),
  detachNotifTapListener: vi.fn(),
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  value: ResizeObserverMock,
});

const unread = {
  items: [
    {
      id: 'notification-android',
      kind: 'text' as const,
      summary: 'Android notification',
      created_at: '2026-08-09T00:00:00.000Z',
    },
  ],
  count: 1,
};

afterEach(() => {
  closeNotification();
  useAuth.getState().setAuth(false, false, null);
  cleanup();
  fetchUnreadNotifications.mockReset();
  apiFetch.mockReset();
});

function renderIntegration(initialPath = '/chat/project') {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <div data-testid="underlying-page">
          {initialPath.startsWith('/board') ? 'Kanban page' : 'Chat page'}
        </div>
        <UnreadBell />
        <NotificationOverlayHost />
        <Outlet />
      </>
    ),
  });
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/chat/$projectId',
  });
  const boardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/board/$projectId',
  });
  const targetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/target',
  });
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' });
  const routeTree = rootRoute.addChildren([
    homeRoute,
    chatRoute,
    boardRoute,
    targetRoute,
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

describe('notification overlay integration', () => {
  it('opens over the same underlying page on Android bell selection', async () => {
    fetchUnreadNotifications.mockReturnValue(unread);
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        item: {
          id: 'notification-android',
          kind: 'text',
          summary: 'Android notification',
          content: 'Details',
        },
      }),
    });

    const view = renderIntegration('/board/project');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /1 items/ })).toBeTruthy(),
    );
    await userEvent.click(screen.getByRole('button', { name: /1 items/ }));
    await userEvent.click(
      screen.getByRole('menuitem', { name: /Android notification/ }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('underlying-page')).toBeTruthy(),
    );
    expect(
      document
        .querySelector('[data-ui="notification-dialog"]')
        ?.getAttribute('data-notification-id'),
    ).toBe('notification-android');
    expect(screen.getByText('Kanban page')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="notification-dialog"]'),
      ).toBeNull(),
    );
    expect(screen.getByText('Kanban page')).toBeTruthy();
    expect(view.router.state.location.pathname).toBe('/board/project');
    openNotification('notification-android');
    await screen.findByText('Details');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="notification-dialog"]'),
      ).toBeNull(),
    );
    expect(view.router.state.location.pathname).toBe('/board/project');
  });

  it('does not fetch a locked native tap until unlock, then preserves the route', async () => {
    fetchUnreadNotifications.mockReturnValue({ items: [], count: 0 });
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        item: {
          id: 'queued-id',
          kind: 'text',
          summary: 'Queued notification',
          content: 'Private details',
        },
      }),
    });

    const view = renderIntegration('/chat/project');
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-testid="underlying-page"]'),
      ).toBeTruthy(),
    );
    useAuth
      .getState()
      .setAuth(true, true, { id: 'user-1', username: 'user', role: 'user' });
    useAuth.getState().setLocked(true);
    gatedOpenNotification('queued-id');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(
      view.container.querySelector('[data-ui="notification-dialog"]'),
    ).toBeNull();
    expect(
      view.container.querySelector('[data-testid="underlying-page"]'),
    ).toBeTruthy();
    useAuth.getState().setLocked(false);
    await waitFor(() =>
      expect(screen.getByText('Private details')).toBeTruthy(),
    );
    expect(screen.getByText('Chat page')).toBeTruthy();
    expect(view.router.state.location.pathname).toBe('/chat/project');
  });

  it('keeps only the latest locked external intent', async () => {
    fetchUnreadNotifications.mockReturnValue({ items: [], count: 0 });
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        item: {
          id: 'latest-id',
          kind: 'text',
          summary: 'Latest notification',
          content: 'Latest details',
        },
      }),
    });

    const view = renderIntegration('/chat/project');
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-testid="underlying-page"]'),
      ).toBeTruthy(),
    );
    useAuth
      .getState()
      .setAuth(true, true, { id: 'user-1', username: 'user', role: 'user' });
    useAuth.getState().setLocked(true);
    gatedOpenNotification('stale-id');
    gatedNavigate('/target');
    gatedOpenNotification('latest-id');
    useAuth.getState().setLocked(false);

    await waitFor(() =>
      expect(screen.getByText('Latest details')).toBeTruthy(),
    );
    expect(view.router.state.location.pathname).toBe('/chat/project');
    expect(screen.queryByText('stale-id')).toBeNull();
  });

  it('submits a form and removes only the overlay on the current route', async () => {
    fetchUnreadNotifications.mockReturnValue({ items: [], count: 0 });
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        item: {
          id: 'form-id',
          kind: 'json_form',
          summary: 'Form notification',
          content: JSON.stringify({
            type: 'object',
            properties: { answer: { type: 'string', title: 'Answer' } },
            required: ['answer'],
          }),
        },
      }),
    });

    const view = renderIntegration();
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-testid="underlying-page"]'),
      ).toBeTruthy(),
    );
    openNotification('form-id');
    await userEvent.type(
      await screen.findByLabelText('Answer *'),
      'Keep me here',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="notification-dialog"]'),
      ).toBeNull(),
    );
    expect(view.router.state.location.pathname).toBe('/chat/project');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a replacement notification open when the previous acknowledgement finishes', async () => {
    let resolveAck!: (response: Response) => void;
    const ackPending = new Promise<Response>((resolve) => {
      resolveAck = resolve;
    });
    apiFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/ack')) return ackPending;
      const id = url.includes('first-id') ? 'first-id' : 'second-id';
      return {
        ok: true,
        json: async () => ({
          item: {
            id,
            kind: 'text',
            summary: `${id} summary`,
            content: `${id} details`,
          },
        }),
      };
    });

    renderIntegration();
    await waitFor(() =>
      expect(screen.getByTestId('underlying-page')).toBeTruthy(),
    );
    openNotification('first-id');
    await screen.findByText('first-id details');
    const dismiss = userEvent.click(
      screen.getByRole('button', { name: 'Dismiss' }),
    );
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/first-id/ack'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );

    openNotification('second-id');
    await screen.findByText('second-id details');
    resolveAck({ ok: true } as Response);
    await dismiss;

    expect(screen.getByText('second-id details')).toBeTruthy();
    expect(
      document.querySelector('[data-notification-id="second-id"]'),
    ).toBeTruthy();
  });
});
