import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KanbanBoard, buildKanbanAnnouncements } from './kanban-board';
import { DEFAULT_STAGES } from '@/lib/stages';
import { fetchObjectives } from '@/lib/api';
import type { Objective } from '@/types';

const testState = vi.hoisted(() => ({
  tasksQuery: {} as Record<string, unknown>,
  mutations: {
    bulkMoveTasks: vi.fn(),
    bulkExecute: vi.fn(),
    bulkStop: vi.fn(),
    bulkUpdate: vi.fn(),
    bulkDeleteTasks: vi.fn(),
  },
}));

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/use-tasks', () => ({ useTasks: () => testState.tasksQuery }));
vi.mock('@/hooks/use-cronjobs', () => ({ useCronjobs: () => ({}) }));
vi.mock('@/hooks/use-dataset-tasks', () => ({ useDatasetTasks: () => ({}) }));
vi.mock('@/hooks/use-scheduled-tasks', () => ({
  useScheduledTasks: () => ({}),
}));
vi.mock('@/hooks/use-projects', () => ({ useProjects: () => ({}) }));
vi.mock('@/hooks/use-task-mutations', () => {
  const mutation = () => ({ mutate: vi.fn() });
  const { bulkMoveTasks, bulkExecute, bulkStop, bulkUpdate, bulkDeleteTasks } =
    testState.mutations;
  return {
    useMoveTask: () => ({ moveTask: vi.fn(), bulkMoveTasks }),
    useUpdateTask: mutation,
    useBulkDeleteTasks: () => ({ mutate: bulkDeleteTasks }),
    useBulkExecuteTasks: () => ({ mutate: bulkExecute }),
    useBulkStopTasks: () => ({ mutate: bulkStop }),
    useBulkStartOverTasks: mutation,
    useBulkUpdateTasks: () => ({ mutate: bulkUpdate }),
    useMergingTasks: () => new Map(),
    applyMergingTasks: <T,>(tasks: T[]) => tasks,
  };
});
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  fetchObjectives: vi.fn().mockResolvedValue([]),
  listProjectMembersForAttribution: vi.fn().mockResolvedValue([]),
}));
vi.mock('./kanban-column', () => ({
  KanbanColumn: ({
    id,
    taskIds,
    onSelectAll,
  }: {
    id: string;
    taskIds: string[];
    onSelectAll: (select: boolean) => void;
  }) => (
    <>
      <div data-testid={`column-${id}`}>{taskIds.join(',')}</div>
      <button type="button" onClick={() => onSelectAll(true)}>
        select-all-{id}
      </button>
    </>
  ),
}));

function renderBoard() {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <KanbanBoard project_id="p1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const fn of Object.values(testState.mutations)) fn.mockClear();
});

describe('KanbanBoard fetch errors', () => {
  it('shows a fetch error with Retry when the first tasks fetch fails', () => {
    const refetch = vi.fn();
    testState.tasksQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      error: new Error('boom'),
      refetch,
    };
    const { container, getByText } = renderBoard();

    expect(
      container.querySelector('[data-ui="query-error-state"]'),
    ).not.toBeNull();
    expect(getByText('boom')).toBeTruthy();
    expect(
      container.querySelector('[data-ui="kanban-board-content"]'),
    ).toBeNull();

    fireEvent.click(getByText('Retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps already-loaded tasks when a later refetch fails', () => {
    testState.tasksQuery = {
      data: [
        {
          id: 'task-1',
          title: 'Loaded task',
          status: 'backlog',
          priority: 0,
        },
      ],
      isLoading: false,
      isError: true,
      isFetching: false,
      error: new Error('later failure'),
      refetch: vi.fn(),
    };
    const { container, getByTestId } = renderBoard();

    expect(container.querySelector('[data-ui="query-error-state"]')).toBeNull();
    expect(
      container.querySelector('[data-ui="kanban-board-content"]'),
    ).not.toBeNull();
    expect(getByTestId('column-backlog').textContent).toBe('task-1');
  });
});

describe('KanbanBoard objectives load', () => {
  const loadedTasks = () => ({
    data: [],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  });
  const errorRow = (c: HTMLElement) =>
    c.querySelector('[data-ui="board-objectives-error"]');

  it('shows an error row with Retry and recovers the strip after a retry', async () => {
    testState.tasksQuery = loadedTasks();
    vi.mocked(fetchObjectives).mockClear();
    const objective = {
      id: 'o1',
      title: 'Ship it',
      status: 'active',
      progress: 5,
    };
    vi.mocked(fetchObjectives)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([objective as unknown as Objective]);
    const { container, findByText, getByText, queryByText } = renderBoard();

    await findByText("Couldn't load objectives");
    expect(queryByText(/^Objectives \(/)).toBeNull();

    fireEvent.click(getByText('Retry'));
    await findByText('Objectives (1)');
    expect(fetchObjectives).toHaveBeenCalledTimes(2);
    expect(errorRow(container)).toBeNull();
  });

  it('shows no error while the first load is pending', () => {
    testState.tasksQuery = loadedTasks();
    vi.mocked(fetchObjectives).mockReturnValue(new Promise(() => {}));
    const { container } = renderBoard();

    expect(errorRow(container)).toBeNull();
  });

  it('shows neither strip nor error for an empty successful list', async () => {
    testState.tasksQuery = loadedTasks();
    vi.mocked(fetchObjectives).mockResolvedValue([]);
    const { container, queryByText } = renderBoard();

    await waitFor(() => expect(fetchObjectives).toHaveBeenCalled());
    await Promise.resolve();
    expect(errorRow(container)).toBeNull();
    expect(queryByText(/^Objectives \(/)).toBeNull();
  });
});

describe('KanbanBoard search', () => {
  it('names the clear-search button and clears the query', () => {
    testState.tasksQuery = {
      data: [],
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    const view = renderBoard();
    const input = view.getByPlaceholderText(
      'Search tasks...',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'needle' } });
    fireEvent.click(view.getByRole('button', { name: /clear search/i }));
    expect(input.value).toBe('');
  });
});

describe('KanbanBoard bulk actions', () => {
  const questionTitle = DEFAULT_STAGES.find((s) => s.id === 'question')!.title;

  function renderWithBacklogTasks(count: number) {
    testState.tasksQuery = {
      data: Array.from({ length: count }, (_, i) => ({
        id: `task-${i + 1}`,
        title: `Task ${i + 1}`,
        status: 'backlog',
        priority: 0,
      })),
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    const view = renderBoard();
    fireEvent.click(view.getByText('select-all-backlog'));
    return view;
  }

  function moveTo(view: ReturnType<typeof renderBoard>, title: string) {
    fireEvent.keyDown(view.getByRole('button', { name: /Move to/ }), {
      key: 'Enter',
    });
    fireEvent.click(view.getByRole('menuitem', { name: title }));
  }

  function expectAnnouncedWithFocus(container: HTMLElement, message: string) {
    const status = container.querySelector(
      '[data-ui="kanban-bulk-action-status"]',
    )!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe(message);
    const region = container.querySelector(
      '[data-ui="kanban-stage-scroll-region"]',
    );
    expect(document.activeElement).toBe(region);
    expect(document.activeElement).not.toBe(document.body);
  }

  it('announces a move and focuses the board container', () => {
    const view = renderWithBacklogTasks(1);
    const { container } = view;
    moveTo(view, questionTitle);

    expect(testState.mutations.bulkMoveTasks).toHaveBeenCalledWith(
      ['task-1'],
      'question',
    );
    expectAnnouncedWithFocus(
      container,
      `Requested move of 1 task to ${questionTitle}`,
    );
  });

  it('re-announces an identical consecutive bulk action', () => {
    const view = renderWithBacklogTasks(1);
    const { container, getByText } = view;
    const message = `Requested move of 1 task to ${questionTitle}`;
    moveTo(view, questionTitle);
    const first = getByText(message);

    fireEvent.click(getByText('select-all-backlog'));
    moveTo(view, questionTitle);
    const second = getByText(message);

    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expectAnnouncedWithFocus(container, message);
  });

  it.each([
    ['Execute', 'bulkExecute', 'Requested start of 2 tasks'],
    ['Stop', 'bulkStop', 'Requested stop of 2 tasks'],
    ['Archive', 'bulkUpdate', 'Requested archive of 2 tasks'],
    ['Restore', 'bulkUpdate', 'Requested restore of 2 tasks'],
  ] as const)(
    'announces %s with plural wording and focuses the board container',
    (label, mutation, message) => {
      const { container, getByRole } = renderWithBacklogTasks(2);
      fireEvent.click(getByRole('button', { name: label }));

      expect(testState.mutations[mutation]).toHaveBeenCalledTimes(1);
      expectAnnouncedWithFocus(container, message);
    },
  );

  it('announces delete only after the confirm is accepted', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container, getByRole } = renderWithBacklogTasks(1);
    fireEvent.click(getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(testState.mutations.bulkDeleteTasks).toHaveBeenCalledWith([
        'task-1',
      ]),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expectAnnouncedWithFocus(container, 'Requested delete of 1 task');
  });

  it('leaves selection, message and focus unchanged when delete is cancelled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container, getByRole, getByText } = renderWithBacklogTasks(1);
    getByRole('button', { name: 'Delete' }).focus();
    fireEvent.click(getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));

    expect(testState.mutations.bulkDeleteTasks).not.toHaveBeenCalled();
    expect(getByText('1 selected')).toBeTruthy();
    expect(
      container.querySelector('[data-ui="kanban-bulk-action-status"]')!
        .textContent,
    ).toBe('');
    expect(document.activeElement).toBe(
      getByRole('button', { name: 'Delete' }),
    );
  });

  it('moves focus to the board container when the selection is cleared', () => {
    const { container, getByRole, queryByText } = renderWithBacklogTasks(1);
    fireEvent.click(getByRole('button', { name: 'Clear' }));

    expect(queryByText('1 selected')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[data-ui="kanban-stage-scroll-region"]'),
    );
  });
});

describe('buildKanbanAnnouncements', () => {
  const tasks = [
    { id: 'ui-task-backlog', title: 'Write docs', status: 'backlog' },
    { id: 'ui-task-question', title: 'Clarify scope', status: 'question' },
  ];
  const a = buildKanbanAnnouncements(tasks, DEFAULT_STAGES);
  const active = { id: 'ui-task-backlog' } as never;
  const overCard = { id: 'ui-task-question' } as never;
  const overStage = { id: 'question' } as never;

  it('names tasks and stages by title, never by id', () => {
    const texts = [
      a.onDragStart({ active }),
      a.onDragOver({ active, over: overCard }),
      a.onDragOver({ active, over: overStage }),
      a.onDragOver({ active, over: null }),
      a.onDragEnd({ active, over: overCard }),
      a.onDragEnd({ active, over: null }),
      a.onDragCancel({ active, over: overCard }),
    ].map(String);
    for (const text of texts) expect(text).not.toContain('ui-task-');
    expect(texts[0]).toBe('Picked up task "Write docs" from stage Backlog.');
    expect(texts[1]).toBe('task "Write docs" is over stage Question.');
    expect(texts[2]).toBe(texts[1]);
    expect(texts[4]).toBe('task "Write docs" moved to stage Question.');
    expect(texts[6]).toBe(
      'Drag cancelled. task "Write docs" returned to stage Backlog.',
    );
  });
});
