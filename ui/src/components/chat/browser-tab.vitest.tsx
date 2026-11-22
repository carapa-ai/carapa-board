import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Profiler } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseOption } from '@/test-utils/select';
import { BrowserTab } from './browser-tab';
const api = vi.hoisted(() => ({
  fetchBrowserSessions: vi.fn(),
  attachBrowserViewer: vi.fn(),
  controlBrowserSession: vi.fn(),
}));
vi.mock('@/lib/api', () => api);
const sessions = [
  {
    sessionId: 'task-run',
    scope: 'run',
    runId: 'task-run',
    projectId: 'project',
    taskId: 'task',
    conversationId: null,
    agentName: 'Task agent',
  },
  {
    sessionId: 'chat-session',
    scope: 'conversation',
    runId: 'chat-run',
    projectId: 'project',
    taskId: null,
    conversationId: 'chat',
    agentName: 'Chat agent',
  },
];
function mount(
  active = true,
  onAnnotationSubmitted?: (submission: {
    frames: Array<{ data: string; title?: string; url?: string }>;
    feedback: string;
  }) => void,
  onCommit?: () => void,
) {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={query}>
      <Profiler id="browser" onRender={() => onCommit?.()}>
        <BrowserTab
          projectId="project"
          conversationId="chat"
          active={active}
          onAnnotationSubmitted={onAnnotationSubmitted}
        />
      </Profiler>
    </QueryClientProvider>,
  );
  return { ...view, query };
}
beforeEach(() => {
  vi.clearAllMocks();
  api.fetchBrowserSessions.mockResolvedValue(sessions);
  api.controlBrowserSession.mockResolvedValue(undefined);
  api.attachBrowserViewer.mockImplementation(async (_project, runId) => ({
    viewerId: runId,
    ticket: 'one-use-ticket',
  }));
});
describe('shared browser pane', () => {
  it('accepts the first viewer status before passive effects run', async () => {
    let sent = false;
    mount(true, undefined, () => {
      const frame = document.querySelector<HTMLIFrameElement>(
        '[data-ui="browser-viewer"]',
      );
      if (!frame || sent) return;
      sent = true;
      // Profiler runs at commit, after child layout effects but before passive
      // effects. Send once: retrying would hide a dropped initial status.
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: new URL(frame.src).origin,
          data: {
            type: 'carapa-browser-status',
            viewerId: 'chat-session',
            state: 'connected',
          },
        }),
      );
    });
    await screen.findByTitle('Agent browser');
    expect(sent).toBe(true);
    await waitFor(() =>
      expect(screen.queryByText('Connecting to the agent browser…')).toBeNull(),
    );
  });

  it('forwards annotated screenshots and feedback from its iframe', async () => {
    const onAnnotationSubmitted = vi.fn();
    const view = mount(true, onAnnotationSubmitted);
    const frame = (await screen.findByTitle(
      'Agent browser',
    )) as HTMLIFrameElement;

    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: new URL(frame.src).origin,
          data: {
            type: 'carapa-browser-annotation',
            viewerId: 'chat-session',
            frames: [{ data: 'c2NyZWVuc2hvdA==', title: 'Pictures' }],
            feedback: 'Move the button higher',
          },
        }),
      ),
    );

    expect(onAnnotationSubmitted).toHaveBeenCalledWith({
      frames: [{ data: 'c2NyZWVuc2hvdA==', title: 'Pictures', url: undefined }],
      feedback: 'Move the button higher',
    });
    view.unmount();
  });

  it('defers attachment while hidden, prefers the selected conversation and allows choosing another run', async () => {
    const hidden = mount(false);
    expect(api.fetchBrowserSessions).not.toHaveBeenCalled();
    hidden.unmount();
    mount();
    const frame = await screen.findByTitle('Agent browser');
    expect(api.attachBrowserViewer).toHaveBeenCalledWith(
      'project',
      'chat-session',
    );
    expect(screen.getByText('Shared with agent')).toBeTruthy();
    expect(frame.getAttribute('src')).toContain(
      '#viewerId=chat-session&ticket=one-use-ticket',
    );
    await chooseOption(
      screen.getByRole('combobox', { name: 'Browser session' }),
      /Task task/,
    );
    await waitFor(() =>
      expect(api.attachBrowserViewer).toHaveBeenLastCalledWith(
        'project',
        'task-run',
      ),
    );
  });
  it('trusts status only from its own iframe, reconnects with a new ticket and keeps an idle conversation attached and releases a removed context', async () => {
    const view = mount();
    const frame = (await screen.findByTitle(
      'Agent browser',
    )) as HTMLIFrameElement;
    const status = (
      source: Window | null,
      origin: string,
      viewerId: string,
      state: string,
    ) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source,
            origin,
            data: { type: 'carapa-browser-status', viewerId, state },
          }),
        );
      });
    status(window, window.location.origin, 'chat-session', 'connected');
    expect(screen.getByText('Connecting to the agent browser…')).toBeTruthy();
    status(
      frame.contentWindow,
      new URL(frame.src).origin,
      'chat-session',
      'connected',
    );
    expect(screen.queryByText('Connecting to the agent browser…')).toBeNull();
    status(
      frame.contentWindow,
      new URL(frame.src).origin,
      'chat-session',
      'disconnected',
    );
    expect(screen.getByText(/Browser disconnected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect browser' }));
    await waitFor(() =>
      expect(api.attachBrowserViewer).toHaveBeenCalledTimes(2),
    );
    const count = api.attachBrowserViewer.mock.calls.length;
    act(() =>
      view.query.setQueryData(
        ['browser-sessions', 'project', 'chat'],
        sessions.map((session) => ({ ...session, runId: null })),
      ),
    );
    expect(screen.getByTitle('Agent browser')).toBeTruthy();
    await screen.findByText(/Agent idle/);
    expect(api.attachBrowserViewer.mock.calls).toHaveLength(count);
    act(() =>
      view.query.setQueryData(['browser-sessions', 'project', 'chat'], []),
    );
    await waitFor(() =>
      expect(screen.queryByTitle('Agent browser')).toBeNull(),
    );
    expect(
      screen.getByText('This browser session is no longer available.'),
    ).toBeTruthy();
  });
  it('starts and restarts the default branch on demand with an app URL and closes explicitly', async () => {
    api.fetchBrowserSessions.mockResolvedValue([
      {
        sessionId: 'default',
        scope: 'default',
        projectId: 'project',
        conversationId: null,
        runId: null,
      },
    ]);
    mount();
    await screen.findByTitle('Agent browser');
    expect(api.controlBrowserSession).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'App URL' }), {
      target: { value: 'http://nginx/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start browser' }));
    await waitFor(() =>
      expect(api.controlBrowserSession).toHaveBeenLastCalledWith(
        'project',
        'default',
        'start',
        'http://nginx/',
      ),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Restart browser',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restart browser' }));
    let confirmation = screen.getByRole('dialog', { name: 'Restart browser?' });
    expect(api.controlBrowserSession).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(confirmation).getByRole('button', { name: 'Cancel' }),
    );
    expect(api.controlBrowserSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Restart browser' }));
    confirmation = screen.getByRole('dialog', { name: 'Restart browser?' });
    fireEvent.click(
      within(confirmation).getByRole('button', { name: 'Restart browser' }),
    );
    await waitFor(() =>
      expect(api.controlBrowserSession).toHaveBeenLastCalledWith(
        'project',
        'default',
        'restart',
        'http://nginx/',
      ),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Close browser',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close browser' }));
    confirmation = screen.getByRole('dialog', { name: 'Close browser?' });
    expect(api.controlBrowserSession).toHaveBeenCalledTimes(2);
    expect(screen.getByTitle('Agent browser')).toBeTruthy();
    fireEvent.click(
      within(confirmation).getByRole('button', { name: 'Cancel' }),
    );
    expect(api.controlBrowserSession).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close browser' }));
    confirmation = screen.getByRole('dialog', { name: 'Close browser?' });
    fireEvent.click(
      within(confirmation).getByRole('button', { name: 'Close browser' }),
    );
    await waitFor(() =>
      expect(screen.queryByTitle('Agent browser')).toBeNull(),
    );
    expect(api.controlBrowserSession).toHaveBeenLastCalledWith(
      'project',
      'default',
      'close',
      undefined,
    );
  });
});
