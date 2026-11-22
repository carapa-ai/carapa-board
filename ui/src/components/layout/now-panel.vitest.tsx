// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NowGroups, NowRowModel } from '@/lib/attention';
import { queryKeys } from '@/lib/query-keys';
import { useStore } from '@/store';
import { NowPanel } from './now-panel';

const routerLocation = vi.hoisted(() => ({
  pathname: '/chat/project-1',
  search: {} as Record<string, unknown>,
}));

const api = vi.hoisted(() => ({
  dismissAttentionGroup: vi.fn(async () => ({ ok: true, dismissed: 2 })),
  dismissAttentionItems: vi.fn(async () => ({ ok: true })),
  acknowledgeUnreadNotifications: vi.fn(async () => undefined),
  markConversationRead: vi.fn(async () => undefined),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: any) => select({ location: routerLocation }),
}));
vi.mock('@/hooks/use-attention', () => ({
  useAttention: () => ({
    data: { generatedAt: new Date().toISOString(), items: [] },
  }),
  useAttentionPartition: () => ({ groups: {} }),
}));
vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({ data: [] }),
}));
vi.mock('@/lib/api', () => api);
vi.mock('sonner', () => ({ toast: vi.fn() }));

function row(id: string, overrides: Partial<NowRowModel> = {}): NowRowModel {
  return {
    key: `${overrides.kind ?? 'conversation'}:${id}`,
    kind: 'conversation',
    id,
    projectId: 'project-1',
    title: id,
    state: 'unread',
    at: new Date().toISOString(),
    notificationIds: [],
    ...overrides,
  };
}

const groups: NowGroups = {
  running: [row('conv-running', { state: 'running' })],
  'needs-you': [],
  unread: [row('conv-a'), row('conv-b'), row('conv-a', { kind: 'task' })],
  completed: [],
};

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NowPanel groups={groups} />
    </QueryClientProvider>,
  );
}

function currentRows(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-ui="sidebar-now-item"][data-current]',
    ),
  ].map((el) => `${el.dataset.kind}:${el.dataset.entityId}`);
}

describe('NowPanel current conversation', () => {
  afterEach(() => {
    cleanup();
    routerLocation.pathname = '/chat/project-1';
    routerLocation.search = {};
    useStore.setState({ activeConvByProject: {} });
  });

  it('highlights the conversation from the route', () => {
    routerLocation.search = { conversationId: 'conv-b' };
    const { container } = renderPanel();
    expect(currentRows(container)).toEqual(['conversation:conv-b']);
    expect(
      container.querySelector('[data-current] button[aria-current="page"]'),
    ).not.toBeNull();
  });

  it('falls back to the remembered chat selection', () => {
    useStore.setState({ activeConvByProject: { 'project-1': 'conv-a' } });
    const { container } = renderPanel();
    expect(currentRows(container)).toEqual(['conversation:conv-a']);
  });

  it('uses the objective selection on objective pages', () => {
    routerLocation.pathname = '/objective/project-1/obj-1';
    useStore.setState({
      activeConvByProject: { 'project-1': 'conv-a', 'obj-1': 'conv-running' },
    });
    const { container } = renderPanel();
    expect(currentRows(container)).toEqual(['conversation:conv-running']);
  });

  it('highlights nothing outside conversation views', () => {
    routerLocation.pathname = '/board/project-1';
    useStore.setState({ activeConvByProject: { 'project-1': 'conv-a' } });
    const { container } = renderPanel();
    expect(currentRows(container)).toEqual([]);
  });
});

describe('NowPanel check off the replies group', () => {
  afterEach(() => {
    cleanup();
    routerLocation.pathname = '/chat/project-1';
    routerLocation.search = {};
    useStore.setState({ activeConvByProject: {} });
    vi.clearAllMocks();
  });

  it('reloads the conversation lists of the read replies', async () => {
    const queryClient = new QueryClient();
    const conversationList = queryClient.getQueryCache().build(queryClient, {
      queryKey: queryKeys.conversations.all('project-1'),
    });
    const objectiveList = queryClient.getQueryCache().build(queryClient, {
      queryKey: queryKeys.objectiveConversations.all('project-2', 'obj-1'),
    });
    const otherProject = queryClient.getQueryCache().build(queryClient, {
      queryKey: queryKeys.conversations.all('project-2'),
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <NowPanel
          groups={{
            running: [],
            'needs-you': [],
            unread: [
              row('conv-a'),
              row('conv-b', { projectId: 'project-2', objectiveId: 'obj-1' }),
            ],
            completed: [],
          }}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      container.querySelector<HTMLElement>(
        '[data-ui="sidebar-now-group-dismiss-all"][data-group="unread"]',
      )!,
    );

    await waitFor(() => {
      expect(api.dismissAttentionGroup).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(conversationList.state.isInvalidated).toBe(true);
    });
    expect(objectiveList.state.isInvalidated).toBe(true);
    expect(otherProject.state.isInvalidated).toBe(true);
  });
});

describe('NowPanel row action names', () => {
  afterEach(cleanup);

  it('shows no bell on text-notification rows and names the dismiss buttons after their row', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NowPanel
          groups={{
            running: [],
            'needs-you': [],
            unread: [
              row('conv-a', { title: 'Alpha reply', notificationIds: ['n-1'] }),
              row('conv-b', { title: 'Beta reply' }),
            ],
            completed: [],
          }}
        />
      </QueryClientProvider>,
    );

    const dismissA = screen.getByRole('button', {
      name: 'Dismiss Alpha reply',
    });
    const dismissB = screen.getByRole('button', { name: 'Dismiss Beta reply' });
    expect(
      screen.queryByRole('button', { name: /Open notification/ }),
    ).toBeNull();
    expect(dismissA.getAttribute('aria-label')).not.toBe(
      dismissB.getAttribute('aria-label'),
    );
  });
});
