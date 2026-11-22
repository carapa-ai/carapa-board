import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseOption } from '@/test-utils/select';
import { MailTab, mailBodySegments } from './mail-tab';
import { mailRequest } from '@/lib/api';
import { canViewProjectMail, useMailState } from '@/lib/mail-state';
import type { Project } from '@/types';

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: any) => selector({ user: { id: 'user', role: 'user' } }),
}));
vi.mock('@/lib/api', () => ({
  mailRequest: vi.fn(),
  mailResponse: vi.fn(),
  getNativeBinaryDataUrl: vi.fn(),
}));
const request = vi.mocked(mailRequest);
const details = {
  uid: 7,
  from: 'Sender <sender@example.com>',
  to: 'a@example.com',
  subject: 'Project update',
  date: '2026-09-14T10:00:00Z',
  seen: false,
  attachmentCount: 1,
  cc: '',
  bodyText: '<img src=x onerror=alert(1)>\nMessage text',
  replyTo: 'reply@example.com',
  messageId: '<parent@example.com>',
  references: ['<root@example.com>'],
  attachments: [{ name: 'document.txt', size: 20, type: 'text/plain' }],
};
let editable = true;
let trashKnown = true;
let seen = false;
let moved = false;
let failSend = false;
let caches: QueryClient[] = [];
function mount(projectId = 'project-a', active = true, configured = true) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  caches.push(cache);
  const tree = (project = projectId, visible = active) => (
    <QueryClientProvider client={cache}>
      <MailTab projectId={project} active={visible} configured={configured} />
    </QueryClientProvider>
  );
  const result = render(tree());
  return {
    ...result,
    cache,
    rerenderTab: (project: string, visible: boolean) =>
      result.rerender(tree(project, visible)),
  };
}
beforeEach(() => {
  editable = true;
  trashKnown = true;
  seen = false;
  moved = false;
  failSend = false;
  useMailState.setState({ accounts: {}, navigation: {} });
  request.mockReset();
  request.mockImplementation(async (project, operation, params, body) => {
    if (operation === 'accounts')
      return {
        accounts: ['a', 'b'].map((id) => ({
          id,
          email: `${id}@example.com`,
          capabilities: { read: true, send: editable, organize: editable },
        })),
      };
    if (operation === 'folders')
      return [
        { name: 'Inbox', path: 'INBOX', total: 21, unseen: seen ? 0 : 1 },
        {
          name: 'Trash',
          path: 'Trash',
          total: 0,
          unseen: 0,
          ...(trashKnown ? { specialUse: '\\Trash' } : {}),
        },
      ];
    if (operation === 'messages')
      return {
        items: moved
          ? []
          : [
              {
                ...details,
                subject: params?.query
                  ? `Search: ${params.query}`
                  : `${project} message`,
                seen,
              },
            ],
        total: 21,
        page: Number(params?.page || 1),
        totalPages: 2,
        hasMore: params?.page !== 2,
      };
    if (operation === 'messages/7') return { ...details, seen };
    if (operation === 'read-state') {
      seen = (body as any).seen;
      return { updated: 1 };
    }
    if (operation === 'move') {
      moved = true;
      return { moved: 1 };
    }
    if (operation === 'send') {
      if (failSend) throw new Error('Connection timed out');
      return { sent: true, messageId: '<sent@example.com>' };
    }
    throw new Error(`Unexpected ${operation}`);
  });
});
afterEach(() => {
  cleanup();
  for (const cache of caches) cache.clear();
  caches = [];
});

describe('mailBodySegments', () => {
  it('parses bracketed, bare, and markdown links while preserving text', () => {
    const segments = mailBodySegments(
      'A [https://ex.com/x] B https://ex.com/y [C](https://ex.com/z)',
    );
    expect(segments.filter((s) => s.type === 'link')).toEqual([
      { type: 'link', url: 'https://ex.com/x' },
      { type: 'link', url: 'https://ex.com/y' },
      { type: 'link', url: 'https://ex.com/z', label: 'C' },
    ]);
    expect(
      segments
        .filter((s) => s.type === 'text')
        .map((s) => (s as any).text)
        .join(''),
    ).toBe('A  B  ');
  });
});

describe('Mail tab', () => {
  it('reads as text, replies with threading, and retains a failed draft across remounts and accounts', async () => {
    const view = mount();
    fireEvent.click(await screen.findByText('project-a message'));
    expect(
      await screen.findByText('<img src=x onerror=alert(1)> Message text', {
        exact: false,
      }),
    ).toBeTruthy();
    expect(
      view.container.querySelector('[data-ui="mail-message-body"] img'),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe(
      'reply@example.com',
    );
    expect(
      (screen.getByLabelText('Message') as HTMLTextAreaElement).value,
    ).toContain('> Message text');
    failSend = true;
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    const sends = request.mock.calls.filter((c) => c[1] === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0][3]).toMatchObject({
      account: 'a',
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>', '<parent@example.com>'],
    });
    view.unmount();
    mount();
    await screen.findByLabelText('To');
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe(
      'reply@example.com',
    );
    await chooseOption(screen.getByLabelText('Mail account'), 'b@example.com');
    await screen.findByText('project-a message');
    expect(screen.queryByLabelText('To')).toBeNull();
    await chooseOption(screen.getByLabelText('Mail account'), 'a@example.com');
    await screen.findByLabelText('To');
    fireEvent.click(screen.getByRole('button', { name: 'Compose' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Keep draft' }));
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe(
      'reply@example.com',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      [...dialog.querySelectorAll('button')].find(
        (b) => b.textContent === 'Discard draft',
      )!,
    );
    await waitFor(() => expect(screen.queryByLabelText('To')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Resume draft' })).toBeNull();
  });

  it('warns before unload only while an unsent draft has content', async () => {
    mount();
    await screen.findByText('project-a message');
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    fireEvent.click(screen.getByRole('button', { name: 'Compose' }));
    await screen.findByLabelText('To');
    expect(unload()).toBe(false);
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'unsent text' },
    });
    expect(unload()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      [...dialog.querySelectorAll('button')].find(
        (b) => b.textContent === 'Discard draft',
      )!,
    );
    await waitFor(() => expect(screen.queryByLabelText('To')).toBeNull());
    expect(unload()).toBe(false);
  });

  it('keeps viewers read-only, supports submitted search and pagination, and pauses while hidden', async () => {
    editable = false;
    const view = mount();
    await screen.findByText('project-a message');
    fireEvent.change(screen.getByLabelText('Search mail'), {
      target: { value: 'budget' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Search: budget');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          (c) =>
            c[1] === 'messages' && c[2]?.page === 2 && c[2]?.query === 'budget',
        ),
      ).toBe(true),
    );
    fireEvent.click(await screen.findByText('Search: budget'));
    await screen.findByText('Project update');
    expect(screen.queryByRole('button', { name: 'Compose' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark unread' })).toBeNull();
    expect(request.mock.calls.some((c) => c[1] === 'read-state')).toBe(false);
    view.rerenderTab('project-a', false);
    request.mockClear();
    await view.cache.invalidateQueries({ queryKey: ['mail'] });
    expect(request).not.toHaveBeenCalled();
  });

  it('marks read once, allows marking unread, and uses move rather than deletion for Trash', async () => {
    mount();
    fireEvent.click(await screen.findByText('project-a message'));
    await waitFor(() =>
      expect(request.mock.calls.some((c) => c[1] === 'read-state')).toBe(true),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Mark unread' })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread' }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter((c) => c[1] === 'read-state'),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByText('Updating mail…')).toBeNull(),
    );
    expect(seen).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await screen.findByText('This folder is empty.');
    const mutations = request.mock.calls.filter((c) => c[3] !== undefined);
    expect(mutations.map((c) => c[1])).toEqual([
      'read-state',
      'read-state',
      'move',
    ]);
    expect(mutations.at(-1)?.[3]).toEqual({
      account: 'a',
      folder: 'INBOX',
      uids: [7],
      destination: 'Trash',
    });
  });

  it('supports bulk selection and explicitly choosing a Trash destination when metadata is missing', async () => {
    trashKnown = false;
    mount();
    await screen.findByText('project-a message');
    fireEvent.click(screen.getByLabelText('Select all messages on this page'));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await screen.findByRole('dialog');
    expect(request.mock.calls.some((c) => c[1] === 'move')).toBe(false);
    const original = request.getMockImplementation()!;
    request.mockImplementation((...args) =>
      args[1] === 'move'
        ? Promise.reject(new Error('Move failed on server'))
        : original(...args),
    );
    await chooseOption(screen.getByLabelText('Destination folder'), 'Trash');
    fireEvent.click(screen.getByRole('button', { name: 'Move messages' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Move failed on server');
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Move failed on server',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    const reopened = await screen.findByRole('dialog');
    expect(within(reopened).queryByRole('alert')).toBeNull();
    request.mockImplementation(original);
    await chooseOption(screen.getByLabelText('Destination folder'), 'Trash');
    fireEvent.click(screen.getByRole('button', { name: 'Move messages' }));
    await screen.findByText('This folder is empty.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not expose one project’s late response in another project or duplicate a pending send', async () => {
    const view = mount();
    await screen.findByText('project-a message');
    const original = request.getMockImplementation()!;
    let resolveDetail!: (value: any) => void;
    request.mockImplementation((...args) =>
      args[0] === 'project-a' && args[1] === 'messages/7'
        ? new Promise((resolve) => {
            resolveDetail = resolve;
          })
        : original(...args),
    );
    fireEvent.click(screen.getByText('project-a message'));
    await waitFor(() => expect(resolveDetail).toBeDefined());
    view.rerenderTab('project-b', true);
    await screen.findByText('project-b message');
    resolveDetail(details);
    await waitFor(() =>
      expect(screen.queryByText('Project update')).toBeNull(),
    );
    let resolveSend!: (value: any) => void;
    request.mockImplementation((...args) =>
      args[1] === 'send'
        ? new Promise((resolve) => {
            resolveSend = resolve;
          })
        : original(...args),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Compose' }));
    fireEvent.change(screen.getByLabelText('To'), {
      target: { value: 'to@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(resolveSend).toBeDefined());
    view.unmount();
    mount('project-b');
    const send = await screen.findByRole('button', {
      name: 'Send',
    });
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.click(send);
    expect(request.mock.calls.filter((c) => c[1] === 'send')).toHaveLength(1);
    resolveSend({ sent: true });
    await waitFor(() => expect(screen.queryByLabelText('To')).toBeNull());
  });

  it('shows missing-token setup without querying mail and restricts tab visibility to project members', () => {
    mount('project-a', true, false);
    expect(screen.getByText(/Add a CarapaMail token/)).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    const project = {
      settings: { carapaMailEnabled: true },
      accessLevel: 'viewer',
      userId: 'owner',
    } as Project;
    expect(canViewProjectMail(project, { id: 'user', role: 'user' })).toBe(
      true,
    );
    expect(
      canViewProjectMail(
        { ...project, accessLevel: null },
        { id: 'user', role: 'user' },
      ),
    ).toBe(false);
    expect(
      canViewProjectMail(
        { ...project, isMain: true },
        { id: 'admin', role: 'admin' },
      ),
    ).toBe(false);
    expect(
      canViewProjectMail(
        { ...project, settings: { carapaMailEnabled: false } },
        { id: 'user', role: 'user' },
      ),
    ).toBe(false);
  });
});
