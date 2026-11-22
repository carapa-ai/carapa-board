import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/query-keys';
import { useStore } from '@/store';
import { TaskDetailDialog } from './task-detail-dialog';

const PROJECT_ID = 'project-tabs';
const TASK = 'task-tabs';
const FORKED_TASK = 'task-tabs-forked';
const OTHER_TASK = 'task-tabs-other';

// A test can replace the runs response for the current test only.
const runsOverride = vi.hoisted(() => ({
  respond: null as null | (() => Promise<unknown>),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchTaskMessages: vi.fn(async () => ({
    messages: [],
    total: 0,
    hasMore: false,
    nextOffset: 0,
  })),
  fetchTaskRuns: vi.fn(async () => {
    if (runsOverride.respond) return runsOverride.respond();
    return {
      runs: [],
      latest_scored_review_run: null,
      total: 0,
      stageDurations: [],
      persistent_comments: [
        {
          stage_id: 'review',
          content: 'Review note',
          updated_at: '2026-08-20T00:00:00.000Z',
        },
      ],
    };
  }),
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

const tasks = [TASK, FORKED_TASK, OTHER_TASK].map((id) => ({
  id,
  title: id,
  description: 'Tab keyboard behavior',
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
  ...(id === FORKED_TASK ? { abForkCommit: 'abc123' } : {}),
}));

vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({ data: tasks }),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: PROJECT_ID,
        name: 'Tabs project',
        settings: { repositoryLocation: '/repo' },
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
    useMoveTaskToProject: mutation,
  };
});
vi.mock('@/components/board/ab-comparison-panel', () => ({
  AbComparisonPanel: () => null,
}));
vi.mock('@/components/chat/chat-message-bubble', () => ({
  ChatMessageBubble: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ projectId: PROJECT_ID }),
}));

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function renderDialog(taskId = TASK) {
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
    expect(document.querySelector('[data-ui="task-detail-tab"]')).toBeTruthy(),
  );
  return queryClient;
}

function tabs() {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-ui="task-detail-tab"]'),
  );
}

function tab(name: string) {
  return document.querySelector<HTMLButtonElement>(`[data-tab="${name}"]`)!;
}

function pressKey(name: string, key: string) {
  fireEvent.keyDown(tab(name), { key });
}

function selectedTab() {
  return tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.dataset
    .tab;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  window.HTMLElement.prototype.scrollTo = () => {};
  useStore.setState({ detailTaskId: null });
});

afterEach(() => {
  cleanup();
  runsOverride.respond = null;
  vi.unstubAllGlobals();
  useStore.getState().setDetailTaskId(null);
});

describe('TaskDetailDialog tab strip keyboard model', () => {
  it('uses a roving tabindex and labels the active tabpanel', async () => {
    await renderDialog();
    expect(selectedTab()).toBe('chat');
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    const panel = document.querySelector('[data-ui="task-tab-content"]')!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('chat').id);
  });

  it('moves focus and selection with arrows, wrapping at the ends', async () => {
    await renderDialog();
    fireEvent.click(tab('details'));
    pressKey('details', 'ArrowRight');
    expect(selectedTab()).toBe('chat');
    expect(document.activeElement).toBe(tab('chat'));

    fireEvent.click(tab('details'));
    pressKey('details', 'ArrowLeft');
    expect(selectedTab()).toBe('recordings');
    expect(document.activeElement).toBe(tab('recordings'));
  });

  it('jumps to the first and last tab with Home and End', async () => {
    await renderDialog();
    pressKey('chat', 'End');
    expect(selectedTab()).toBe('recordings');
    expect(document.activeElement).toBe(tab('recordings'));
    pressKey('recordings', 'Home');
    expect(selectedTab()).toBe('details');
    expect(document.activeElement).toBe(tab('details'));
  });

  it('keeps Details selected for a forked parent', async () => {
    await renderDialog(FORKED_TASK);
    expect(tabs().map((t) => t.dataset.tab)).toEqual(['details']);
    pressKey('details', 'ArrowRight');
    expect(selectedTab()).toBe('details');
  });

  it('ignores keys that are not tab navigation', async () => {
    await renderDialog();
    pressKey('chat', 'a');
    expect(selectedTab()).toBe('chat');
    expect(screen.getAllByRole('tab')).toHaveLength(5);
  });
});

describe('TaskDetailDialog persistent stage notes', () => {
  it('closes an open stage-note editor when switching to another task', async () => {
    const queryClient = await renderDialog();
    // The other task's run history is already cached, so its note renders
    // immediately instead of remounting after a loading state.
    queryClient.setQueryData(queryKeys.runs.all(PROJECT_ID, OTHER_TASK), {
      runs: [],
      latest_scored_review_run: null,
      total: 0,
      stageDurations: [],
      persistent_comments: [
        {
          stage_id: 'review',
          content: 'Other note',
          updated_at: '2026-08-20T00:00:00.000Z',
        },
      ],
    });
    fireEvent.click(tab('history'));
    fireEvent.click(
      await screen.findByLabelText('Edit review persistent stage note'),
    );
    expect(
      document.querySelector('[data-ui="persistent-stage-note-editor"]'),
    ).toBeTruthy();

    act(() => useStore.getState().setDetailTaskId(OTHER_TASK));
    await waitFor(() =>
      expect(
        document.querySelector(
          `[data-ui="persistent-stage-note"][data-task-id="${OTHER_TASK}"]`,
        ),
      ).toBeTruthy(),
    );
    expect(
      document.querySelector('[data-ui="persistent-stage-note-editor"]'),
    ).toBeNull();
  });
});

describe('TaskDetailDialog run history load states', () => {
  const emptyRuns = {
    runs: [],
    latest_scored_review_run: null,
    total: 0,
    stageDurations: [],
    persistent_comments: [],
  };
  const noteRuns = {
    ...emptyRuns,
    persistent_comments: [
      {
        stage_id: 'review',
        content: 'Review note',
        updated_at: '2026-08-20T00:00:00.000Z',
      },
    ],
  };

  // The first `failures` runs requests reject; later ones resolve `body`.
  function stubRuns(
    failures: number,
    body: typeof emptyRuns | typeof noteRuns,
  ) {
    let calls = 0;
    runsOverride.respond = async () => {
      calls += 1;
      if (calls <= failures) throw new Error('runs exploded');
      return body;
    };
  }

  it('shows an error with Retry instead of empty copy, then the data after a successful retry', async () => {
    stubRuns(1, noteRuns);
    await renderDialog();
    fireEvent.click(tab('history'));

    const errorBlock = await waitFor(() => {
      const el = document.querySelector('[data-ui="run-history-error"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(errorBlock.textContent).toContain('runs exploded');
    expect(
      screen.queryByText('No execution logs for this task yet.'),
    ).toBeNull();
    expect(screen.queryByText('No persistent stage notes yet.')).toBeNull();
    expect(screen.queryByText('No measurable run time yet.')).toBeNull();
    expect(
      document.querySelector('[data-ui="persistent-stage-note-add"]'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Review note')).toBeTruthy();
    expect(document.querySelector('[data-ui="run-history-error"]')).toBeNull();
  });

  it('renders the empty-state copy when the request succeeds with zero runs', async () => {
    stubRuns(0, emptyRuns);
    await renderDialog();
    fireEvent.click(tab('history'));

    expect(
      await screen.findByText('No execution logs for this task yet.'),
    ).toBeTruthy();
    expect(screen.getByText('No persistent stage notes yet.')).toBeTruthy();
    expect(document.querySelector('[data-ui="run-history-error"]')).toBeNull();
  });
});
