import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { UnreadBell } from './UnreadBell';

const fetchUnreadNotifications = vi.hoisted(() => vi.fn());
const acknowledgeUnreadNotifications = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  fetchAttention: async () => ({ items: [], objectives: [] }),
  fetchUnreadNotifications,
  acknowledgeUnreadNotifications,
}));
vi.mock('@/lib/push', () => ({ gatedNavigate: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
}));

const unread = {
  items: [
    {
      id: 'notification-1',
      kind: 'text' as const,
      summary: 'A message',
      created_at: '2026-08-09T00:00:00.000Z',
    },
    {
      id: 'notification-2',
      kind: 'json_form' as const,
      summary: 'A request',
      created_at: '2026-08-09T00:01:00.000Z',
    },
  ],
  count: 2,
};

function renderBell() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UnreadBell />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  fetchUnreadNotifications.mockReset();
  acknowledgeUnreadNotifications.mockReset();
  toastError.mockReset();
});

describe('UnreadBell bulk dismissal', () => {
  it('shows Dismiss all only for unread items, clears immediately, and prevents duplicates', async () => {
    fetchUnreadNotifications.mockResolvedValue(unread);
    let resolve!: () => void;
    acknowledgeUnreadNotifications.mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );

    renderBell();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /2 items/ })).toBeTruthy(),
    );
    await userEvent.click(screen.getByRole('button', { name: /2 items/ }));
    const dismiss = screen.getByRole('menuitem', { name: 'Dismiss all' });
    await userEvent.click(dismiss);

    expect(acknowledgeUnreadNotifications).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText('No notifications need your attention'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('menuitem', { name: 'Dismissing…' })
        .getAttribute('data-disabled'),
    ).toBe('');
    resolve();
    await waitFor(() => expect(screen.queryByText('Dismissing…')).toBeNull());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('restores the unread list and reports an error when dismissal fails', async () => {
    fetchUnreadNotifications.mockResolvedValue(unread);
    acknowledgeUnreadNotifications.mockRejectedValue(new Error('network down'));

    renderBell();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /2 items/ })).toBeTruthy(),
    );
    await userEvent.click(screen.getByRole('button', { name: /2 items/ }));
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Dismiss all' }),
    );

    await waitFor(() => expect(screen.getByText('A message')).toBeTruthy());
    expect(screen.getByText('A request')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Notifications: 2 items',
        hidden: true,
      }),
    ).toBeTruthy();
    expect(toastError).toHaveBeenCalledWith(
      'Failed to dismiss notifications: network down',
    );
  });
});

describe('UnreadBell source icons', () => {
  it('lists only non-conversation, non-task notifications, each with its source icon', async () => {
    const item = (id: string, action_url: string | null) => ({
      id,
      kind: 'text' as const,
      summary: id,
      action_url,
      created_at: '2026-08-09T00:00:00.000Z',
    });
    fetchUnreadNotifications.mockResolvedValue({
      items: [
        item('objective', '/objective/project-a/obj-1'),
        item('board', '/board/project-a?taskId=task-1'),
        item('chat', '/chat/project-a?conversationId=conv-1'),
        item('plain', null),
      ],
      count: 4,
    });

    renderBell();
    // Board and chat notifications are shown on their Now rows, not here.
    await userEvent.click(
      await screen.findByRole('button', { name: /2 items/ }),
    );
    expect(screen.queryByText('board')).toBeNull();
    expect(screen.queryByText('chat')).toBeNull();

    const iconClass = (summary: string) =>
      screen
        .getByText(summary)
        .closest('[role="menuitem"]')!
        .querySelector('[data-ui="notification-source-icon"]')!
        .getAttribute('class');
    expect(iconClass('objective')).toContain('lucide-target');
    expect(iconClass('plain')).toContain('lucide-message-square');
  });
});
