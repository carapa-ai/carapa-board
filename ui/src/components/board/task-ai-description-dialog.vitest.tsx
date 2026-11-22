import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useStore } from '@/store';
import { TaskDetailDialog } from './task-detail-dialog';

const state = vi.hoisted(() => ({
  draft: vi.fn(),
  createConversation: vi.fn(async () => ({ id: 'conv-ai-edit' })),
  updateTask: {
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => undefined),
    isPending: false,
  },
}));

let taskFixture: Record<string, unknown> = {};

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  draftTaskDescription: state.draft,
  createConversation: state.createConversation,
  fetchTask: vi.fn(async () => taskFixture),
  fetchTaskRuns: vi.fn(
    async () =>
      ({
        runs: [],
        total: 0,
        stageDurations: [],
        persistent_comments: [],
      }) as never,
  ),
  updateTaskStageComment: vi.fn(
    async () =>
      ({
        stageId: 'build',
        content: '',
        updatedAt: new Date().toISOString(),
        runId: null,
      }) as never,
  ),
}));

vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({ data: [taskFixture] }),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: 'project-1',
        name: 'Test project',
        effectiveStages: [
          { id: 'build', title: 'Build', type: 'active', color: '#123456' },
          {
            id: 'testing',
            title: 'Android Testing',
            type: 'testing',
            color: '#654321',
          },
          { id: 'review', title: 'Review', type: 'review', color: '#abcdef' },
        ],
      },
    ],
  }),
}));

vi.mock('@/hooks/use-task-mutations', () => {
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  });
  return {
    useUpdateTask: () => state.updateTask,
    useDeleteTask: mutation,
    useStopTask: mutation,
    useExecuteTask: mutation,
    useForkTask: mutation,
    useMoveTaskToProject: mutation,
  };
});

vi.mock('@/hooks/use-smart-scroll', () => ({
  useSmartScroll: () => ({
    scrollToBottom: vi.fn(),
    settleToBottom: vi.fn(),
    suspendAutoScroll: vi.fn(),
    resumeAutoScroll: vi.fn(),
  }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useInfiniteQuery: () => ({
      data: { pages: [{ messages: [], hasMore: false }] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
    }),
  };
});

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-ai-edit',
    title: 'AI edit dialog task',
    description: 'Original **description**',
    status: 'backlog',
    priority: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    running: false,
    archived: false,
    error: null,
    owner: null,
    latestTrigger: null,
    depends_on_ids: [],
    skip_stages: [],
    ...overrides,
  };
}

beforeEach(() => {
  taskFixture = baseTask();
  state.draft.mockReset();
  state.draft.mockResolvedValue({ draft: 'Drafted description' });
  state.createConversation.mockClear();
  state.updateTask.mutate.mockClear();
  state.updateTask.mutateAsync.mockClear();
  state.updateTask.mutateAsync.mockResolvedValue(undefined);
  state.updateTask.isPending = false;
  useStore.setState({
    detailTaskId: 'task-ai-edit',
    reviewRunIntent: null,
    streamingOutput: {},
    liveTaskIds: {},
  });
});

afterEach(() => {
  cleanup();
  useStore.getState().setDetailTaskId(null);
});

function renderTaskDetailDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskDetailDialog project_id="project-1" />
    </QueryClientProvider>,
  );
}

async function openDetailsTab() {
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Details' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
  await waitFor(() =>
    expect(document.querySelector('[data-ui="task-description"]')).toBeTruthy(),
  );
}

describe('TaskDetailDialog AI description panel wiring', () => {
  it('apply patches the description through the existing update mutation and closes the panel', async () => {
    let resolveUpdate: () => void = () => {};
    state.updateTask.mutateAsync.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        resolveUpdate = () => resolve(undefined);
      }),
    );
    renderTaskDetailDialog();
    await openDetailsTab();
    fireEvent.click(screen.getByRole('button', { name: 'AI edit' }));

    const input = screen.getByPlaceholderText(
      'e.g. add acceptance criteria, tighten the scope',
    );
    fireEvent.change(input, { target: { value: 'tighten the scope' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const panelEl = () =>
      document.querySelector(
        '[data-ui="task-ai-description"]',
      ) as HTMLElement | null;
    await waitFor(() =>
      expect(panelEl()?.getAttribute('data-state')).toBe('preview'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(state.updateTask.mutateAsync).toHaveBeenCalledTimes(1);
    expect(state.updateTask.mutateAsync).toHaveBeenCalledWith({
      task_id: 'task-ai-edit',
      data: { description: 'Drafted description' },
    });
    // The panel stays open while the PATCH is still in flight.
    expect(panelEl()).not.toBeNull();

    resolveUpdate();
    await waitFor(() => expect(panelEl()).toBeNull());
  });

  it('does not leak a late Apply result into a task opened while the request is unresolved', async () => {
    let resolveUpdate: () => void = () => {};
    state.updateTask.mutateAsync.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        resolveUpdate = () => resolve(undefined);
      }),
    );
    renderTaskDetailDialog();
    await openDetailsTab();
    fireEvent.click(screen.getByRole('button', { name: 'AI edit' }));

    const input = screen.getByPlaceholderText(
      'e.g. add acceptance criteria, tighten the scope',
    );
    fireEvent.change(input, { target: { value: 'tighten the scope' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-ui="task-ai-description"]')
          ?.getAttribute('data-state'),
      ).toBe('preview'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Close' }).hasAttribute('disabled'),
      ).toBe(true),
    );

    // Exercise the close/reopen race even if dismissal is initiated outside
    // the dialog's disabled close control (for example, by route state).
    useStore.getState().setDetailTaskId(null);
    taskFixture = baseTask({
      id: 'task-two',
      title: 'Second task',
      description: 'Second task description',
    });
    useStore.getState().setDetailTaskId('task-two');
    await waitFor(() =>
      expect(document.querySelector('[data-task-id="task-two"]')).toBeTruthy(),
    );

    resolveUpdate();
    await waitFor(() =>
      expect(state.updateTask.mutateAsync).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit desc' }));
    expect(
      (screen.getByPlaceholderText('Describe the task…') as HTMLTextAreaElement)
        .value,
    ).toBe('Second task description');
  });

  it('opens the task worktree in chat when the task has complete worktree metadata', async () => {
    taskFixture = baseTask({
      branch_name: 'task/ai-edit',
      worktree_path: '/workspace/worktrees/task-ai-edit',
    });
    renderTaskDetailDialog();
    await openDetailsTab();
    fireEvent.click(screen.getByRole('button', { name: 'AI edit' }));

    fireEvent.click(screen.getByRole('button', { name: 'Open in chat' }));

    await waitFor(() =>
      expect(state.createConversation).toHaveBeenCalledWith('project-1', {
        taskContextId: 'task-ai-edit',
        use_worktree: true,
        branch: 'task/ai-edit',
      }),
    );
  });

  it('opens an ordinary project chat when the task has no worktree', async () => {
    renderTaskDetailDialog();
    await openDetailsTab();
    fireEvent.click(screen.getByRole('button', { name: 'AI edit' }));

    fireEvent.click(screen.getByRole('button', { name: 'Open in chat' }));

    await waitFor(() =>
      expect(state.createConversation).toHaveBeenCalledWith('project-1', {
        taskContextId: 'task-ai-edit',
      }),
    );
  });

  it('falls back to an ordinary project chat for incomplete worktree metadata', async () => {
    taskFixture = baseTask({ branch_name: 'task/incomplete' });
    renderTaskDetailDialog();
    await openDetailsTab();
    fireEvent.click(screen.getByRole('button', { name: 'AI edit' }));

    fireEvent.click(screen.getByRole('button', { name: 'Open in chat' }));

    await waitFor(() =>
      expect(state.createConversation).toHaveBeenCalledWith('project-1', {
        taskContextId: 'task-ai-edit',
      }),
    );
  });

  it('disables apply while the task has an active run', async () => {
    taskFixture = baseTask({
      status: 'build',
      running: true,
      phase: 'running',
    });
    renderTaskDetailDialog();
    await openDetailsTab();
    fireEvent.click(screen.getByRole('button', { name: 'AI edit' }));

    const input = screen.getByPlaceholderText(
      'e.g. add acceptance criteria, tighten the scope',
    );
    fireEvent.change(input, { target: { value: 'tighten the scope' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(
        document
          .querySelector('[data-ui="task-ai-description"]')
          ?.getAttribute('data-state'),
      ).toBe('preview'),
    );

    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply.hasAttribute('disabled')).toBe(true);

    // The running-lock explanation must be reachable: it lives on an
    // enabled, focusable wrapper, not on the disabled (pointer-events-none)
    // button itself.
    const hint = document.querySelector<HTMLElement>(
      '[data-ui="task-ai-description-apply-hint"]',
    );
    expect(hint).not.toBeNull();
    expect(hint?.hasAttribute('disabled')).toBe(false);
    expect(hint?.getAttribute('title')).toContain('run is active');
    hint?.focus();
    expect(document.activeElement).toBe(hint);
  });

  it('disables AI apply while a manual description update is pending', async () => {
    let manualUpdatePending = false;
    state.updateTask.mutate.mockImplementation(() => {
      manualUpdatePending = true;
      state.updateTask.isPending = manualUpdatePending;
    });

    renderTaskDetailDialog();
    await openDetailsTab();

    fireEvent.click(screen.getByRole('button', { name: 'Edit desc' }));
    fireEvent.change(screen.getByPlaceholderText('Describe the task…'), {
      target: { value: 'Manual description update' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }));

    fireEvent.click(screen.getByRole('button', { name: 'AI edit' }));
    const input = screen.getByPlaceholderText(
      'e.g. add acceptance criteria, tighten the scope',
    );
    fireEvent.change(input, { target: { value: 'tighten the scope' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(
        document
          .querySelector('[data-ui="task-ai-description"]')
          ?.getAttribute('data-state'),
      ).toBe('preview'),
    );

    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply.hasAttribute('disabled')).toBe(true);
    expect(
      document
        .querySelector('[data-ui="task-ai-description-apply-hint"]')
        ?.getAttribute('title'),
    ).toContain('other task update');

    fireEvent.click(apply);
    expect(state.updateTask.mutateAsync).not.toHaveBeenCalled();
  });
});
