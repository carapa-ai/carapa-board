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

const PROJECT_ID = 'project-archive';
const TASK_ID = 'task-archive';

const server = vi.hoisted(() => ({
  tasks: [] as unknown[],
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchTasks: vi.fn(async () => server.tasks),
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
        name: 'Archive project',
        coStageOptions: [],
        effectiveStages: [
          { id: 'backlog', title: 'Backlog', type: 'queue', color: '#111111' },
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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: 'Archive me',
    description: 'Archive confirmation',
    status: 'backlog',
    priority: 0,
    created_at: '2026-08-20T00:00:00.000Z',
    running: false,
    archived: false,
    error: null,
    owner: null,
    latestTrigger: null,
    depends_on_ids: [],
    skip_stages: [],
    ...overrides,
  } as Task;
}

async function renderDialog(overrides: Partial<Task>) {
  server.tasks = [makeTask(overrides)];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  useStore.setState({ detailTaskId: TASK_ID });
  render(
    <QueryClientProvider client={queryClient}>
      <TaskDetailDialog project_id={PROJECT_ID} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByPlaceholderText('Title')).toHaveProperty(
      'value',
      'Archive me',
    ),
  );
}

const confirmSpy = vi.fn();

beforeEach(() => {
  server.updateTask.mockReset().mockResolvedValue(undefined);
  server.deleteTask.mockReset().mockResolvedValue(undefined);
  confirmSpy.mockReset();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('confirm', confirmSpy);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (
        init?.method === 'PATCH' &&
        String(url).endsWith(`/tasks/${TASK_ID}`)
      ) {
        const body = JSON.parse(String(init.body));
        await server.updateTask(TASK_ID, body);
        server.tasks = [{ ...(server.tasks[0] as Task), ...body }];
        return Response.json(server.tasks[0]);
      }
      if (
        init?.method === 'DELETE' &&
        String(url).endsWith(`/tasks/${TASK_ID}`)
      ) {
        await server.deleteTask(TASK_ID);
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: 'not stubbed' }, { status: 404 });
    }),
  );
  useStore.setState({ detailTaskId: null, draftByKey: {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useStore.getState().setDetailTaskId(null);
});

describe('TaskDetailDialog archive confirmation', () => {
  it('asks before archiving a task with a worktree; cancel sends nothing, OK archives', async () => {
    await renderDialog({ worktree_path: '/wt/task', branch_name: 'task/x' });

    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/worktree/i);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/uncommitted changes/i);
    expect(server.updateTask).not.toHaveBeenCalled();

    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(server.updateTask).toHaveBeenCalledTimes(1));
    expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, { archived: true });
  });

  it.each([
    ['merged', { branch_name: 'task/x', merge_commit: 'abc123' }],
    ['without a worktree or branch', {}],
  ])('archives a task %s without confirming', async (_n, overrides) => {
    await renderDialog(overrides);

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(server.updateTask).toHaveBeenCalledTimes(1));
    expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, { archived: true });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('restores an archived task without confirming', async () => {
    await renderDialog({ archived: true, worktree_path: '/wt/task' });

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(server.updateTask).toHaveBeenCalledTimes(1));
    expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, {
      archived: false,
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('TaskDetailDialog delete confirmation', () => {
  it('asks before deleting; cancel sends nothing, OK deletes and closes', async () => {
    await renderDialog({});

    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toMatch(/cannot be undone/i);
    expect(server.deleteTask).not.toHaveBeenCalled();
    expect(useStore.getState().detailTaskId).toBe(TASK_ID);

    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(server.deleteTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useStore.getState().detailTaskId).toBeNull());
  });
});
