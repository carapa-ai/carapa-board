import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import type { Task } from '@/types';
import { TaskDetailDialog } from './task-detail-dialog';
import { chooseOption, selectedLabel } from '@/test-utils/select';

const PROJECT_ID = 'project-priority';

const server = vi.hoisted(() => ({
  tasks: [] as Array<{ id: string; priority: number }>,
  patchFails: false,
}));

vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>();
  return {
    ...actual,
    toast: Object.assign(
      (...args: Parameters<typeof actual.toast>) => actual.toast(...args),
      actual.toast,
      { error: vi.fn() },
    ),
  };
});

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchTasks: vi.fn(async () => server.tasks.map((t) => makeTask(t))),
  fetchTaskMessages: vi.fn(async () => ({
    messages: [],
    total: 0,
    hasMore: false,
    nextOffset: 0,
  })),
  fetchTaskRuns: vi.fn(async () => ({
    runs: [],
    latest_scored_review_run: null,
    total: 0,
    stageDurations: [],
    persistent_comments: [],
  })),
  fetchTaskRecordings: vi.fn(async () => []),
  fetchRuntimeCatalog: vi.fn(async () => ({
    version: 2,
    harnesses: [],
    models: [],
    presets: [],
    defaults: {
      chat: { harnessId: '', modelId: '' },
      kanban: { fallback: { harnessId: '', modelId: '' }, stages: {} },
    },
  })),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: PROJECT_ID,
        name: 'Header sync project',
        effectiveStages: [
          { id: 'backlog', title: 'Backlog', type: 'queue', color: '#111111' },
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active',
            color: '#222222',
          },
          { id: 'completed', title: 'Done', type: 'done', color: '#333333' },
        ],
      },
    ],
  }),
}));
vi.mock('@/hooks/use-elapsed-time', () => ({ useElapsedTime: () => 0 }));
vi.mock('@/lib/agents', () => ({
  useResolveModelLabel: () => (value: string | null | undefined) =>
    value ?? null,
  useResolveAgentLabel: () => (value: string) => value,
  useResolveRuntimeSelectionLabel: () => () => '',
}));
vi.mock('@/components/chat/chat-message-bubble', () => ({
  ChatMessageBubble: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ projectId: PROJECT_ID }),
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makeTask(t: { id: string; priority: number }): Task {
  return {
    id: t.id,
    project_id: PROJECT_ID,
    title: t.id,
    description: t.id,
    status: 'completed',
    priority: t.priority,
    created_at: '2026-08-20T00:00:00.000Z',
    running: false,
    archived: false,
    depends_on_ids: [],
    skip_stages: [],
  } as Task;
}

// useUpdateTask reaches the API module through a namespace import that
// `vi.mock('@/lib/api')` does not replace, so intercept its HTTP call.
function stubTaskRequests() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'PATCH' && path.includes('/tasks/')) {
        if (server.patchFails) {
          return Response.json({ error: 'boom' }, { status: 500 });
        }
        const taskId = path.split('/tasks/')[1];
        const { priority } = JSON.parse(String(init.body));
        const stored = server.tasks.find((t) => t.id === taskId)!;
        stored.priority = priority;
        return Response.json(makeTask(stored));
      }
      return Response.json({ error: 'not stubbed' }, { status: 404 });
    }),
  );
}

async function renderDialog(taskId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  useStore.setState({ detailTaskId: taskId });
  render(
    <QueryClientProvider client={queryClient}>
      <TaskDetailDialog project_id={PROJECT_ID} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByPlaceholderText('Title')).toHaveProperty(
      'value',
      taskId,
    ),
  );
  return queryClient;
}

const prioritySelect = () => screen.getByTitle('Priority');

beforeEach(() => {
  server.tasks = [
    { id: 'task-top', priority: -2000 },
    { id: 'task-mid', priority: 1000 },
    { id: 'task-last', priority: 2000 },
  ];
  server.patchFails = false;
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  stubTaskRequests();
  useStore.setState({ detailTaskId: null, draftByKey: {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useStore.getState().setDetailTaskId(null);
});

describe('TaskDetailDialog priority select', () => {
  it('opens with Top priority for the task at the head of the queue', async () => {
    await renderDialog('task-top');
    expect(selectedLabel(prioritySelect())).toBe('Top priority');
  });

  it('opens with Next in line for a task behind the head, and Top for a lone task', async () => {
    await renderDialog('task-mid');
    expect(selectedLabel(prioritySelect())).toBe('Next in line');
    cleanup();
    server.tasks = [{ id: 'task-solo', priority: -1 }];
    await renderDialog('task-solo');
    expect(selectedLabel(prioritySelect())).toBe('Top priority');
  });

  it('keeps Top priority after selecting it and the list refetches', async () => {
    const queryClient = await renderDialog('task-last');
    await chooseOption(prioritySelect(), 'Top priority');
    expect(selectedLabel(prioritySelect())).toBe('Top priority');
    await waitFor(() =>
      expect(server.tasks.find((t) => t.id === 'task-last')!.priority).toBe(
        -3000,
      ),
    );
    await queryClient.refetchQueries({ queryKey: ['tasks'] });
    await waitFor(() =>
      expect(selectedLabel(prioritySelect())).toBe('Top priority'),
    );
  });

  it('restores the previous value when the priority PATCH fails', async () => {
    server.patchFails = true;
    await renderDialog('task-last');
    await chooseOption(prioritySelect(), 'Top priority');
    await waitFor(() =>
      expect(selectedLabel(prioritySelect())).toBe('Next in line'),
    );
  });
});
