import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useStore } from '@/store';
import { NotifDialog } from './NotifDialog';

const navigate = vi.hoisted(() =>
  vi.fn(async (_options?: unknown) => undefined),
);
const apiFetch = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => navigate,
    createFileRoute: () => (options: object) => ({
      ...options,
      useParams: () => ({ id: 'notification-1' }),
    }),
  };
});

const createConversation = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ apiFetch, createConversation }));
const payload = {
  id: 'notification-1',
  kind: 'text' as const,
  summary: 'New conversation message',
  content: 'There is a new message.',
  action_url: '/chat/project-a?conversationId=conversation-a',
  created_at: '2026-08-09T00:00:00.000Z',
  delivered_at: '2026-08-09T00:00:01.000Z',
  acked_at: null,
  expires_at: '2026-08-10T00:00:00.000Z',
};

function mockPayloadApi(
  calls: string[],
  ackOk = true,
  item: object = payload,
  ack?: { status: number; body?: unknown },
) {
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push(init?.method === 'POST' ? 'ack' : 'fetch');
    if (init?.method === 'POST') {
      if (ack) {
        return {
          ok: ack.status >= 200 && ack.status < 300,
          status: ack.status,
          json: async () => {
            if (ack.body === undefined) throw new Error('not json');
            return ack.body;
          },
        };
      }
      return { ok: ackOk, status: ackOk ? 200 : 404 };
    }
    return { ok: true, json: async () => ({ item }) };
  });
}

const formPayload = {
  ...payload,
  kind: 'json_form' as const,
  action_url: null,
  content: JSON.stringify({
    type: 'object',
    properties: { answer: { type: 'string', title: 'Answer' } },
    required: ['answer'],
  }),
};

async function submitForm(
  onClose: () => void,
  ack: { status: number; body?: unknown },
) {
  mockPayloadApi([], true, formPayload, ack);
  withQueryClient(<NotifDialog payloadId={payload.id} onClose={onClose} />);
  const input = (await screen.findByLabelText(/Answer/)) as HTMLInputElement;
  await userEvent.type(input, 'my answer');
  await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
  return input;
}

function withQueryClient(ui: ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  navigate.mockClear();
  createConversation.mockReset();
});

describe('notification internal navigation', () => {
  it('acknowledges before opening the dialog action URL and closes the dialog', async () => {
    const calls: string[] = [];
    mockPayloadApi(calls);
    navigate.mockImplementation(async () => {
      calls.push('navigate');
    });
    const onClose = vi.fn(() => {
      calls.push('close');
    });
    const hardNavigation = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: hardNavigation },
    });

    try {
      withQueryClient(<NotifDialog payloadId={payload.id} onClose={onClose} />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy(),
      );

      await userEvent.click(screen.getByRole('button', { name: 'Open' }));

      expect(calls).toEqual(['fetch', 'ack', 'navigate', 'close']);
      expect(navigate).toHaveBeenCalledWith({
        to: '/chat/project-a',
        search: { conversationId: 'conversation-a' },
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(hardNavigation).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('acknowledges and lands on each repeated action URL across projects', async () => {
    const calls: string[] = [];
    const onClose = vi.fn(() => calls.push('close'));
    const actionUrls = [
      '/chat/project-a?conversationId=conversation-a',
      '/chat/project-b?conversationId=conversation-b',
      '/objective/project-a/obj-1?report=2026-10-13-morning-brief.md',
    ];
    const expectedNavigations = [
      { to: '/chat/project-a', search: { conversationId: 'conversation-a' } },
      { to: '/chat/project-b', search: { conversationId: 'conversation-b' } },
      {
        to: '/objective/project-a/obj-1',
        search: { report: '2026-10-13-morning-brief.md' },
      },
    ];
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push(init?.method === 'POST' ? 'ack' : 'fetch');
      if (init?.method === 'POST') return { ok: true, status: 200 };
      const notificationIndex =
        Number(
          decodeURIComponent(url.split('/').at(-1) ?? '')
            .split('-')
            .at(-1),
        ) - 1;
      return {
        ok: true,
        json: async () => ({
          item: {
            ...payload,
            id: `notification-${notificationIndex + 1}`,
            action_url: actionUrls[notificationIndex],
          },
        }),
      };
    });
    navigate.mockImplementation(async () => {
      calls.push('navigate');
    });

    const view = withQueryClient(
      <NotifDialog payloadId="notification-1" onClose={onClose} />,
    );
    for (let index = 0; index < actionUrls.length; index++) {
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy(),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Open' }));
      view.rerender(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <NotifDialog
            payloadId={`notification-${index + 2}`}
            onClose={onClose}
          />
        </QueryClientProvider>,
      );
    }
    expect(navigate.mock.calls.map((call) => call[0])).toEqual(
      expectedNavigations,
    );
    expect(calls.filter((call) => call === 'ack')).toHaveLength(3);
    expect(calls.filter((call) => call === 'navigate')).toHaveLength(3);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('does not navigate or close the dialog when acknowledgement fails', async () => {
    const calls: string[] = [];
    mockPayloadApi(calls, false);
    const onClose = vi.fn();

    withQueryClient(<NotifDialog payloadId={payload.id} onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(calls).toEqual(['fetch', 'ack']);
    expect(navigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByText('Notification acknowledgement failed'),
    ).toBeTruthy();
  });

  it('replies in a fresh objective conversation with the quoted draft', async () => {
    const calls: string[] = [];
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      calls.push(init?.method === 'POST' ? 'ack' : 'fetch');
      if (init?.method === 'POST') return { ok: true, status: 200 };
      return {
        ok: true,
        json: async () => ({
          item: {
            ...payload,
            content: 'line one\nline two',
            action_url: '/objective/project-a/obj-1?report=r.md',
          },
        }),
      };
    });
    createConversation.mockImplementation(async () => {
      calls.push('create');
      return { id: 'conv-new' };
    });
    const onClose = vi.fn();

    withQueryClient(<NotifDialog payloadId={payload.id} onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));

    expect(calls).toEqual(['fetch', 'create', 'ack']);
    expect(createConversation).toHaveBeenCalledWith('project-a', {
      objective_id: 'obj-1',
    });
    const state = useStore.getState();
    expect(state.activeConvByProject['obj-1']).toBe('conv-new');
    expect(state.draftByKey['project-a:conv-new']).toBe(
      'Re: notification "New conversation message" (2026-08-09T00:00:00.000Z)\n> line one\n> line two\n\n',
    );
    expect(navigate).toHaveBeenCalledWith({
      to: '/objective/$projectId/$objectiveId',
      params: { projectId: 'project-a', objectiveId: 'obj-1' },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open and shows the error when reply creation fails', async () => {
    const calls: string[] = [];
    mockPayloadApi(calls);
    createConversation.mockRejectedValue(new Error('create failed'));
    const onClose = vi.fn();

    withQueryClient(<NotifDialog payloadId={payload.id} onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));

    expect(createConversation).toHaveBeenCalledWith('project-a', undefined);
    expect(await screen.findByText('create failed')).toBeTruthy();
    expect(calls).toEqual(['fetch']);
    expect(navigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(['Reply', 'Open'])(
    'ignores Escape and disables Dismiss while %s is pending, then acts once',
    async (action) => {
      const calls: string[] = [];
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          calls.push('ack');
          if (action === 'Open') await gate;
          return { ok: true, status: 200 };
        }
        return { ok: true, json: async () => ({ item: payload }) };
      });
      createConversation.mockImplementation(async () => {
        await gate;
        return { id: 'conv-pending' };
      });
      const onClose = vi.fn();

      withQueryClient(<NotifDialog payloadId={payload.id} onClose={onClose} />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: action })).toBeTruthy(),
      );
      await userEvent.click(screen.getByRole('button', { name: action }));
      await userEvent.keyboard('{Escape}');
      const dismiss = screen.getByRole('button', {
        name: 'Dismiss',
      }) as HTMLButtonElement;
      expect(dismiss.disabled).toBe(true);
      expect(
        (screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      await userEvent.click(dismiss);

      expect(onClose).not.toHaveBeenCalled();
      expect(calls.filter((call) => call === 'ack')).toHaveLength(
        action === 'Open' ? 1 : 0,
      );
      releaseGate();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(calls.filter((call) => call === 'ack')).toHaveLength(1);
    },
  );

  it('does not navigate or write drafts when unmounted during a pending reply', async () => {
    const calls: string[] = [];
    mockPayloadApi(calls);
    let releaseCreate: () => void = () => {};
    createConversation.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      return { id: 'conv-unmounted' };
    });
    const onClose = vi.fn();

    const view = withQueryClient(
      <NotifDialog payloadId={payload.id} onClose={onClose} />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));
    view.unmount();
    releaseCreate();
    await waitFor(() => expect(createConversation).toHaveBeenCalled());
    await Promise.resolve();

    expect(calls).toEqual(['fetch']);
    expect(navigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      useStore.getState().draftByKey['project-a:conv-unmounted'],
    ).toBeUndefined();
  });

  it.each([
    [
      400,
      { error: 'Invalid form response', details: 'answer is too short' },
      'Invalid form response: answer is too short',
    ],
    [401, { error: 'Unauthorized' }, 'Unauthorized'],
    [500, undefined, 'Submit failed (500)'],
  ])(
    'keeps the form open with typed values when the answer is rejected with %s',
    async (status, body, message) => {
      const onClose = vi.fn();
      const input = await submitForm(onClose, { status, body });

      expect(await screen.findByText(message)).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
      expect(input.value).toBe('my answer');
    },
  );

  it.each([200, 409])(
    'closes the form dialog on a %s answer',
    async (status) => {
      const onClose = vi.fn();
      await submitForm(onClose, { status, body: {} });

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    },
  );
});
