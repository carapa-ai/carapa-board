import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/query-keys';
import { useStore } from '@/store';
import type { Task } from '@/types';
import { TaskDetailDialog } from './task-detail-dialog';
import { chooseOption, selectedLabel } from '@/test-utils/select';

const PROJECT_ID = 'project-deps';
const TASK_ID = 'task-deps';

const server = vi.hoisted(() => ({
  tasks: [] as unknown[],
  updateTask: vi.fn(),
  executeTask: vi.fn(),
  sendTaskMessage: vi.fn(),
  fetchTask: vi.fn(),
  messagesNotFound: false,
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchTasks: vi.fn(async () => server.tasks),
  sendTaskMessage: vi.fn(
    async (_projectId: string, taskId: string, content: string) =>
      server.sendTaskMessage(taskId, content),
  ),
  fetchTask: vi.fn(async (_projectId: string, taskId: string) =>
    server.fetchTask(taskId),
  ),
  fetchTaskMessages: vi.fn(async (_projectId: string, taskId: string) => {
    if (server.messagesNotFound) throw new Error('Task not found');
    return {
      messages:
        taskId !== TASK_ID
          ? []
          : [
              {
                id: 'm1',
                task_id: TASK_ID,
                role: 'assistant',
                content: 'Earlier answer',
                created_at: '2026-08-20T00:10:00.000Z',
              },
            ],
      total: 1,
      hasMore: false,
      nextOffset: 1,
    };
  }),
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
        name: 'Deps project',
        coStageOptions: ['review.o', 'testing.u'],
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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: 'Old',
    description: 'Header sync',
    status: 'completed',
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

const DEP_A = 'dep-a';
const DEP_B = 'dep-b';
const DEP_C = 'dep-c';
const DEPENDENT = 'dependent-task';

let queryClient: QueryClient;

function setTasks(deps: string[]) {
  server.tasks = [
    makeTask({ title: 'Main task', priority: 1000, depends_on_ids: deps }),
    makeTask({ id: DEP_A, title: 'Dep A', status: 'backlog' }),
    makeTask({ id: DEP_B, title: 'Dep B', status: 'backlog' }),
    makeTask({ id: DEP_C, title: 'Dep C', status: 'backlog' }),
    makeTask({
      id: DEPENDENT,
      title: 'Dependent',
      status: 'backlog',
      depends_on_ids: [TASK_ID],
    }),
  ];
}

async function renderDialog() {
  queryClient = new QueryClient({
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
      'Main task',
    ),
  );
  await screen.findByText('Earlier answer');
}

const chips = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>('[data-ui="task-dependency-chip"]'),
  ).map((el) => el.dataset.taskId);

async function openPicker() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Depends on/ }));
  return user;
}

beforeEach(() => {
  setTasks([DEP_A, DEP_B]);
  server.updateTask.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (
        init?.method === 'PATCH' &&
        String(url).endsWith(`/tasks/${TASK_ID}`)
      ) {
        await server.updateTask(TASK_ID, body);
        return Response.json({ ...(server.tasks[0] as Task), ...body });
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

describe('TaskDetailDialog dependencies', () => {
  it('shows every dependency and keeps the others when one is swapped', async () => {
    await renderDialog();
    expect(chips()).toEqual([DEP_A, DEP_B]);

    const user = await openPicker();
    const options = await screen.findAllByRole('menuitem');
    const option = (title: string) =>
      options.find((el) => el.textContent?.includes(title))!;
    // A task that depends on this one would create a cycle and is not offered.
    expect(options.some((el) => el.textContent?.includes('Dependent'))).toBe(
      false,
    );
    await user.click(option('Dep A'));
    await user.click(option('Dep C'));
    await user.keyboard('{Escape}');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, {
        depends_on_ids: [DEP_B, DEP_C],
      }),
    );
  });

  it('removes only the chosen dependency via its chip', async () => {
    await renderDialog();
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove dependency Dep A' }),
    );
    expect(chips()).toEqual([DEP_B]);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, {
        depends_on_ids: [DEP_B],
      }),
    );
  });

  it('reverts the priority select to the stored mode when the update fails', async () => {
    await renderDialog();
    const select = screen.getByTitle('Priority');
    expect(selectedLabel(select)).toBe('Next in line');

    server.updateTask.mockRejectedValueOnce(new Error('boom'));
    await chooseOption(select, 'Top priority');
    await waitFor(() =>
      expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, {
        priority: expect.any(Number),
      }),
    );
    await waitFor(() => expect(selectedLabel(select)).toBe('Next in line'));
  });
});
