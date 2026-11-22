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
import type { TaskMessage } from '@/types';
import { TaskDetailDialog } from './task-detail-dialog';
import { chooseOption } from '@/test-utils/select';

const historyState = vi.hoisted(() => ({
  // Keep the mocked API's server state separate from each query response.
  // This ensures the test can only observe a saved note after the real
  // invalidateQueries -> fetchTaskRuns -> render lifecycle completes.
  serverComments: [] as Array<{
    stage_id: string;
    content: string;
    updated_at: string;
    run_id: string | null;
  }>,
  fetch: vi.fn(async () => ({
    runs: runHistoryData?.runs ?? [],
    total: runHistoryData?.total ?? 0,
    stageDurations: runHistoryData?.stageDurations ?? [],
    persistent_comments: historyState.serverComments.map((comment) => ({
      ...comment,
    })),
  })),
  update: vi.fn(
    async (_project: string, _task: string, stage: string, content: string) => {
      const saved = {
        stage_id: stage,
        content: content.trim(),
        updated_at: new Date().toISOString(),
        run_id: null,
      };
      const existingIndex = historyState.serverComments.findIndex(
        (comment) => comment.stage_id === stage,
      );
      if (existingIndex === -1) {
        historyState.serverComments = [...historyState.serverComments, saved];
      } else {
        historyState.serverComments = historyState.serverComments.map(
          (comment, index) => (index === existingIndex ? saved : comment),
        );
      }
      return {
        stageId: stage,
        content: content.trim(),
        updatedAt: saved.updated_at,
        runId: null,
      };
    },
  ),
  messages: [] as TaskMessage[],
}));
const moveTask = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchTaskRuns: historyState.fetch,
  updateTaskStageComment: historyState.update,
  fetchRuntimeCatalog: vi.fn(async () => ({
    version: 2,
    harnesses: [
      { id: 'codex', label: 'Codex', kind: 'cli', sessionFamily: 'codex' },
    ],
    models: [
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        capabilities: [],
        bindings: [
          {
            harnessId: 'codex',
            runtimeId: 'codex:gpt-5.6-sol',
            reasoning: { options: ['medium', 'high'], default: 'medium' },
          },
        ],
      },
    ],
    presets: [],
    defaults: {
      chat: { harnessId: 'codex', modelId: 'gpt-5.6-sol' },
      kanban: {
        fallback: { harnessId: 'codex', modelId: 'gpt-5.6-sol' },
        stages: {},
      },
    },
  })),
}));

const task = {
  id: 'task-description-test',
  title: 'Description integration task',
  description: '# Ship it\n\n**Markdown** description',
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
  runtimeSelection: {
    harnessId: 'codex',
    modelId: 'gpt-5.6-sol',
    reasoning: 'high',
  },
  started_at: '',
};

let runHistoryData:
  | {
      runs: Array<{
        id: string;
        task_id: string;
        run_at: string;
        reviewScore: number | null;
        stage: string;
      }>;
      total: number;
      stageDurations: Array<{
        stageId: string | null;
        completedDurationMs: number;
        runningStartedAt: string[];
        runningDurationMs: number;
        runningReferenceAt: string;
        costUsd: number | null;
      }>;
      persistent_comments: Array<{
        stage_id: string;
        content: string;
        updated_at: string;
        run_id: string | null;
      }>;
    }
  | undefined;

vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({ data: [task] }),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: 'project-1',
        name: 'Test project',
        order: 0,
        effectiveStages: [
          { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888888' },
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
      {
        id: 'destination-parent',
        name: 'Destination parent',
        order: 1,
        settings: { isParent: true, enabledModes: ['kanban'] },
      },
      {
        id: 'destination-child',
        name: 'Destination child',
        parentId: 'destination-parent',
        order: 0,
        settings: { enabledModes: ['kanban'] },
      },
      {
        id: 'chat-only',
        name: 'Chat only',
        order: 2,
        settings: { enabledModes: ['chat'] },
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
    useUpdateTask: mutation,
    useDeleteTask: mutation,
    useStopTask: mutation,
    useExecuteTask: mutation,
    useForkTask: mutation,
    useMoveTaskToProject: () => ({
      mutate: moveTask.mutate,
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
    }),
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
      data: { pages: [{ messages: historyState.messages, hasMore: false }] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
    }),
  };
});

vi.mock('@/components/chat/chat-message-bubble', () => ({
  ChatMessageBubble: ({ content }: { content: string }) => <div>{content}</div>,
}));

afterEach(() => {
  cleanup();
  useStore.getState().setDetailTaskId(null);
  historyState.serverComments = [];
  historyState.messages = [];
  historyState.fetch.mockClear();
  historyState.update.mockClear();
  moveTask.mutate.mockClear();
});

beforeEach(() => {
  task.status = 'backlog';
  task.started_at = '';
  runHistoryData = {
    runs: [
      {
        id: 'run-1',
        task_id: task.id,
        run_at: '2026-08-01T00:00:00.000Z',
        reviewScore: null,
        stage: 'build',
      },
    ],
    total: 1,
    stageDurations: [
      {
        stageId: 'build',
        completedDurationMs: 60_000,
        runningStartedAt: [],
        runningDurationMs: 0,
        runningReferenceAt: '2026-08-01T00:01:00.000Z',
        costUsd: null,
      },
    ],
    persistent_comments: [
      {
        stage_id: 'build',
        content: 'Keep the mobile path covered.',
        updated_at: '2026-08-01T00:02:00.000Z',
        run_id: null,
      },
    ],
  };
  useStore.setState({
    detailTaskId: task.id,
    reviewRunIntent: null,
    streamingOutput: {},
    liveTaskIds: {},
  });
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

describe('TaskDetailDialog task description integration', () => {
  it('shows eligible destinations in the project tree and moves immediately on selection', async () => {
    renderTaskDetailDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Move to project' }));
    const picker = screen.getByRole('button', { name: 'Move task to project' });
    expect(picker.getAttribute('data-ui')).toBe('move-project-picker');
    fireEvent.pointerDown(picker);

    await waitFor(() =>
      expect(
        screen.getByRole('menuitem', { name: 'Destination parent' }),
      ).toBeTruthy(),
    );
    const child = screen.getByRole('menuitem', { name: 'Destination child' });
    expect(child).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Test project' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Chat only' })).toBeNull();

    fireEvent.click(child);

    expect(moveTask.mutate).toHaveBeenCalledWith({
      task_id: task.id,
      target_project_id: 'destination-child',
    });
  });

  it('keeps a never-started backlog task description out of Chat with duplicated synthesized description messages', async () => {
    const messages = [
      {
        id: 'description-copy-1',
        task_id: task.id,
        role: 'user' as const,
        content: task.description,
        created_at: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'description-copy-2',
        task_id: task.id,
        role: 'user' as const,
        content: task.description,
        created_at: '2026-08-01T00:00:01.000Z',
      },
    ];
    runHistoryData = {
      runs: [],
      total: 0,
      stageDurations: [],
      persistent_comments: [],
    };
    historyState.messages = messages;
    renderTaskDetailDialog();
    fireEvent.click(
      document.querySelector<HTMLButtonElement>(
        '[data-ui="task-detail-tab"][data-tab="details"]',
      )!,
    );
    const description = document.querySelector('[data-ui="task-description"]');
    expect(description?.textContent).toContain('Ship it');
    fireEvent.click(
      document.querySelector<HTMLButtonElement>(
        '[data-ui="task-detail-tab"][data-tab="chat"]',
      )!,
    );
    const chatContent = document.querySelector(
      '[data-ui="task-tab-content"][data-task-tab="chat"]',
    );
    expect(
      chatContent?.querySelectorAll('[data-ui="task-transcript-message"]'),
    ).toHaveLength(0);
    expect(chatContent?.textContent).not.toContain('Ship it');
  });

  it('keeps a matching user message visible after the task has started', async () => {
    task.status = 'in_progress';
    task.started_at = '2026-08-01T00:00:00.000Z';
    historyState.messages = [
      {
        id: 'earlier-assistant',
        task_id: task.id,
        role: 'assistant',
        content: 'Earlier response',
        created_at: '2026-08-01T00:00:30.000Z',
      },
      {
        id: 'matching-follow-up',
        task_id: task.id,
        role: 'user',
        content: task.description,
        created_at: '2026-08-01T00:01:00.000Z',
      },
    ];
    renderTaskDetailDialog();
    await waitFor(() =>
      expect(
        document.querySelector('[data-msg-id="matching-follow-up"]'),
      ).toBeTruthy(),
    );
    expect(
      document.querySelector(
        '[data-ui="task-tab-content"][data-task-tab="chat"]',
      )?.textContent,
    ).toContain('Ship it');
  });

  it('adds a note for another eligible stage while excluding occupied stages', async () => {
    historyState.serverComments = [
      {
        stage_id: 'build',
        content: 'Keep the mobile path covered.',
        updated_at: '2026-08-01T00:02:00.000Z',
        run_id: null,
      },
    ];
    renderTaskDetailDialog();
    fireEvent.click(screen.getByRole('tab', { name: /Run History/ }));

    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-ui="persistent-stage-note"][data-stage-id="build"]',
        ),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    const picker = screen.getByLabelText('Stage for new persistent note');
    fireEvent.keyDown(picker, { key: 'Enter' });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Android Testing',
      'Review',
    ]);
    expect(options.some((option) => option.textContent === 'Build')).toBe(
      false,
    );
    fireEvent.keyDown(options[0]!, { key: 'Escape' });

    await chooseOption(picker, 'Android Testing');
    fireEvent.change(screen.getByLabelText('Persistent stage note'), {
      target: { value: 'Keep Android coverage enabled.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() =>
      expect(historyState.update).toHaveBeenCalledWith(
        'project-1',
        task.id,
        'testing',
        'Keep Android coverage enabled.',
      ),
    );
    await waitFor(() => {
      expect(historyState.fetch.mock.calls.length).toBeGreaterThan(1);
      expect(
        document.querySelector(
          '[data-ui="persistent-stage-note"][data-stage-id="build"]',
        ),
      ).toBeTruthy();
      expect(
        document.querySelector(
          '[data-ui="persistent-stage-note"][data-stage-id="testing"]',
        )?.textContent,
      ).toContain('Keep Android coverage enabled.');
    });
    expect(screen.getByRole('button', { name: 'Add note' })).toBeTruthy();
  });
});
