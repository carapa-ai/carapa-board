import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import type { TaskRunLog } from '@/types';
import { KanbanCard } from './kanban-card';
import { TaskDetailDialog } from './task-detail-dialog';

const scoredTask = {
  id: 'task-score-integration',
  project_id: 'project-1',
  title: 'Scored task',
  description: 'Implementation\n\n## Review notes\nKeep this handoff.',
  status: 'completed',
  priority: 0,
  created_at: '2026-08-01T00:00:00.000Z',
  running: false,
  archived: false,
  error: undefined,
  owner: undefined,
  latestTrigger: undefined,
  depends_on_ids: [],
  skip_stages: [],
  custom_values: { quality_score: 9 },
};

const run = (
  id: string,
  run_at: string,
  reviewScore: number | null,
  stage: string,
): TaskRunLog => ({
  id,
  task_id: scoredTask.id,
  run_at,
  duration_ms: 100,
  status: 'success',
  output: null,
  error: null,
  model: null,
  model_name: null,
  agent_name: null,
  session_id: null,
  tok_total: null,
  tool_usage_count: null,
  reviewScore,
  stage,
});

const runHistory: {
  runs: TaskRunLog[];
  total: number;
  persistent_comments: never[];
  latest_scored_review_run: TaskRunLog | null;
} = {
  runs: [
    run('review-old', '2026-08-01T01:00:00.000Z', 6, 'review'),
    run('review-latest', '2026-08-01T02:00:00.000Z', 9, 'review'),
    run(
      'implementation-newer',
      '2026-08-01T03:00:00.000Z',
      null,
      'in_progress',
    ),
  ],
  total: 3,
  persistent_comments: [],
  latest_scored_review_run: run(
    'review-latest',
    '2026-08-01T02:00:00.000Z',
    9,
    'review',
  ),
};
let currentRunHistory: typeof runHistory & {
  latest_scored_review_run: TaskRunLog | null;
} = runHistory;

const transcript = [
  {
    id: 'message-old-run',
    task_id: scoredTask.id,
    role: 'assistant' as const,
    content: 'Older review transcript.',
    created_at: '2026-08-01T01:01:00.000Z',
    entry_type: 'run_start' as const,
    run_id: 'review-old',
  },
  {
    id: 'message-old-content',
    task_id: scoredTask.id,
    role: 'assistant' as const,
    content: 'Older review content.',
    created_at: '2026-08-01T01:02:00.000Z',
  },
  {
    id: 'message-latest-run',
    task_id: scoredTask.id,
    role: 'assistant' as const,
    content: 'Latest review transcript.',
    created_at: '2026-08-01T02:01:00.000Z',
    entry_type: 'run_start' as const,
    run_id: 'review-latest',
  },
  {
    id: 'message-latest-content',
    task_id: scoredTask.id,
    role: 'assistant' as const,
    content: 'Latest review content.',
    created_at: '2026-08-01T02:02:00.000Z',
  },
  {
    id: 'message-implementation-run',
    task_id: scoredTask.id,
    role: 'assistant' as const,
    content: 'Newer implementation transcript.',
    created_at: '2026-08-01T03:01:00.000Z',
    entry_type: 'run_start' as const,
    run_id: 'implementation-newer',
  },
  {
    id: 'message-implementation-content',
    task_id: scoredTask.id,
    role: 'assistant' as const,
    content: 'Implementation content.',
    created_at: '2026-08-01T03:02:00.000Z',
  },
];
let currentTranscript = transcript;
let currentTranscriptPages = [{ messages: transcript, hasMore: false }];
let currentHasNextPage = false;
let olderTranscriptPage: typeof transcript | null = null;
let fetchOlderPageCount = 0;
let refreshTranscript: (() => void) | null = null;
let deferNextRunHistoryRefetch = false;
let resolveRunHistoryRefetch:
  | ((value: { data?: typeof runHistory; isSuccess: boolean }) => void)
  | null = null;

function TranscriptRefreshHarness({ children }: { children: ReactNode }) {
  const [, setRefresh] = useState(0);
  refreshTranscript = () => setRefresh((value) => value + 1);
  return children;
}

vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({ data: [scoredTask] }),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({ data: [{ id: 'project-1', name: 'Test project' }] }),
}));

vi.mock('@/hooks/use-elapsed-time', () => ({ useElapsedTime: () => 0 }));
vi.mock('@/lib/agents', () => ({
  useResolveModelLabel: () => (value: string | null | undefined) =>
    value ?? null,
  useResolveAgentLabel: () => (value: string) => value,
  useResolveRuntimeSelectionLabel: () => () => '',
}));
vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));
vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => undefined } },
}));
vi.mock('@/hooks/use-task-mutations', () => {
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  });
  return {
    useExecuteTask: mutation,
    useStopTask: mutation,
    useUpdateTask: mutation,
    useDeleteTask: mutation,
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
vi.mock('@/components/chat/chat-message-bubble', () => ({
  ChatMessageBubble: ({ content }: { content: string }) => <div>{content}</div>,
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
      data: { pages: currentTranscriptPages },
      fetchNextPage: vi.fn(() => {
        fetchOlderPageCount += 1;
        if (olderTranscriptPage) {
          currentTranscriptPages = [
            ...currentTranscriptPages,
            { messages: olderTranscriptPage, hasMore: false },
          ];
          olderTranscriptPage = null;
          currentHasNextPage = false;
          refreshTranscript?.();
        }
      }),
      hasNextPage: currentHasNextPage,
      isFetchingNextPage: false,
      isLoading: false,
    }),
    useQuery: ({ queryKey }: { queryKey?: unknown[] }) => ({
      data: queryKey?.[0] === 'runs' ? currentRunHistory : undefined,
      refetch: vi.fn(() => {
        if (deferNextRunHistoryRefetch) {
          deferNextRunHistoryRefetch = false;
          return new Promise<{ data?: typeof runHistory; isSuccess: boolean }>(
            (resolve) => {
              resolveRunHistoryRefetch = resolve;
            },
          );
        }
        return Promise.resolve({ data: currentRunHistory, isSuccess: true });
      }),
      isLoading: false,
    }),
    useQueryClient: () => ({
      invalidateQueries: vi.fn(),
      setQueryData: vi.fn(),
    }),
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  };
});

afterEach(() => {
  cleanup();
  currentRunHistory = runHistory;
  currentTranscript = transcript;
  currentTranscriptPages = [{ messages: transcript, hasMore: false }];
  currentHasNextPage = false;
  olderTranscriptPage = null;
  fetchOlderPageCount = 0;
  refreshTranscript = null;
  deferNextRunHistoryRefetch = false;
  resolveRunHistoryRefetch = null;
  useStore.getState().setReviewRunIntent(null);
  useStore.getState().setDetailTaskId(null);
});

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  globalThis.ResizeObserver = class {
    private callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe() {
      queueMicrotask(() =>
        this.callback([], this as unknown as ResizeObserver),
      );
    }
    disconnect() {}
    unobserve() {}
  } as typeof ResizeObserver;
  useStore.setState({
    detailTaskId: null,
    reviewRunIntent: null,
    liveTaskIds: {},
    streamingOutput: {},
  });
});

describe('KanbanCard review score integration', () => {
  it('opens Chat at the latest scored review and preserves the run handoff', async () => {
    const view = (
      <>
        <KanbanCard task={scoredTask} project_id="project-1" />
        <TaskDetailDialog project_id="project-1" />
      </>
    );
    const { rerender } = render(view);

    const score = screen.getByRole('button', {
      name: 'Open latest review for Scored task',
    });
    fireEvent.click(score);

    await waitFor(() =>
      expect(useStore.getState().detailTaskId).toBe(scoredTask.id),
    );
    rerender(view);
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-ui="task-run-divider"][data-run-id="review-latest"]',
        ),
      ).toBeTruthy(),
    );
    expect(
      document
        .querySelector('[data-ui="task-tab-content"]')
        ?.getAttribute('data-task-tab'),
    ).toBe('chat');
    expect(useStore.getState().reviewRunIntent).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByText('Review polish pass')).toBeNull();
    expect(screen.getByText('Keep this handoff.')).toBeTruthy();
  });

  it('selects the intended review divider when newer and older transcript pages are present', async () => {
    currentTranscriptPages = [
      {
        messages: [transcript[4], transcript[5]],
        hasMore: true,
      },
    ];
    currentHasNextPage = true;
    olderTranscriptPage = [transcript[2], transcript[3]];

    const renderPaginatedView = () => (
      <TranscriptRefreshHarness>
        <KanbanCard task={scoredTask} project_id="project-1" />
        <TaskDetailDialog project_id="project-1" />
      </TranscriptRefreshHarness>
    );
    useStore.getState().setDetailTaskId(scoredTask.id);
    const { rerender } = render(renderPaginatedView());
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="task-tab-content"]'),
      ).toBeTruthy(),
    );
    fireEvent.click(
      document.querySelector('[data-ui="task-review-score"]') as HTMLElement,
    );

    await waitFor(() =>
      expect(useStore.getState().detailTaskId).toBe(scoredTask.id),
    );
    rerender(renderPaginatedView());
    await waitFor(() => expect(fetchOlderPageCount).toBe(1));
    rerender(renderPaginatedView());
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-ui="task-run-divider"][data-run-id="review-latest"]',
        ),
      ).toBeTruthy(),
    );
    expect(
      document.querySelector(
        '[data-ui="task-run-divider"][data-run-id="review-latest"]',
      ),
    ).toBeTruthy();
  });

  it('waits for fresh run history instead of consuming the intent from stale cached history', async () => {
    const freshReview = run(
      'review-fresh',
      '2026-08-01T04:00:00.000Z',
      10,
      'review',
    );
    const staleHistory = {
      ...runHistory,
      latest_scored_review_run: run(
        'review-old',
        '2026-08-01T01:00:00.000Z',
        6,
        'review',
      ),
    };
    currentRunHistory = staleHistory;
    deferNextRunHistoryRefetch = true;
    const view = (
      <TranscriptRefreshHarness>
        <KanbanCard task={scoredTask} project_id="project-1" />
        <TaskDetailDialog project_id="project-1" />
      </TranscriptRefreshHarness>
    );
    render(view);

    fireEvent.click(
      document.querySelector('[data-ui="task-review-score"]') as HTMLElement,
    );
    await waitFor(() => expect(resolveRunHistoryRefetch).not.toBeNull());

    currentRunHistory = {
      ...runHistory,
      runs: [...runHistory.runs, freshReview],
      total: 4,
      latest_scored_review_run: freshReview,
    };
    currentTranscriptPages = [
      {
        messages: [
          ...transcript,
          {
            id: 'message-fresh-run',
            task_id: scoredTask.id,
            role: 'assistant' as const,
            content: 'Fresh review transcript.',
            created_at: '2026-08-01T04:01:00.000Z',
            entry_type: 'run_start' as const,
            run_id: freshReview.id,
          },
        ],
        hasMore: false,
      },
    ];
    refreshTranscript?.();
    resolveRunHistoryRefetch?.({ data: currentRunHistory, isSuccess: true });

    await waitFor(() => expect(useStore.getState().reviewRunIntent).toBeNull());
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-ui="task-run-divider"][data-run-id="review-fresh"]',
        ),
      ).toBeTruthy(),
    );
  });
});
