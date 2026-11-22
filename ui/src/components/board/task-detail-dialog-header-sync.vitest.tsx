import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/query-keys';
import { useStore } from '@/store';
import type { Task } from '@/types';
import { TaskDetailDialog } from './task-detail-dialog';
import { ApiError } from '@/lib/api';
import { chooseOption, selectedLabel } from '@/test-utils/select';

const PROJECT_ID = 'project-header-sync';
const TASK_ID = 'task-header-sync';

const server = vi.hoisted(() => ({
  tasks: [] as unknown[],
  updateTask: vi.fn(),
  executeTask: vi.fn(),
  sendTaskMessage: vi.fn(),
  fetchTask: vi.fn(),
  syncExternalIssue: vi.fn(),
  draftDescription: vi.fn(),
  runLocation: vi.fn(),
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
  getActiveRunLocation: vi.fn(async () => server.runLocation()),
  draftTaskDescription: vi.fn(async () => server.draftDescription()),
  fetchTaskExternalIssue: vi.fn(async () => ({ provider: 'gitlab' })),
  syncTaskExternalIssue: vi.fn(async (_projectId: string, taskId: string) =>
    server.syncExternalIssue(taskId),
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
        name: 'Header sync project',
        settings: { repositoryLocation: '/repo' },
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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let queryClient: QueryClient;

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
    expect(screen.getByPlaceholderText('Title')).toHaveProperty('value', 'Old'),
  );
  await screen.findByText('Earlier answer');
}

/** Simulates a WS task_updated event rewriting the tasks list cache. */
function externalUpdate(overrides: Partial<Task>) {
  server.tasks = [makeTask(overrides)];
  act(() =>
    queryClient.setQueryData(queryKeys.tasks.list(PROJECT_ID), server.tasks),
  );
}

const titleInput = () => screen.getByPlaceholderText<HTMLInputElement>('Title');
const chatInput = () =>
  screen.getByPlaceholderText<HTMLTextAreaElement>('Follow-up message…');
const clickSave = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

async function clickRerunContinue() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Re-run/ }));
  fireEvent.click(
    await screen.findByRole('menuitem', { name: /^Continue\s*Keep chat/ }),
  );
}

// useUpdateTask/useExecuteTask reach the API module through a namespace import
// that `vi.mock('@/lib/api')` does not replace, so intercept their HTTP calls.
function stubTaskRequests() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === 'PATCH' && path.endsWith(`/tasks/${TASK_ID}`)) {
        await server.updateTask(TASK_ID, body);
        server.tasks = server.tasks.map((t) =>
          (t as Task).id === TASK_ID ? { ...(t as Task), ...body } : t,
        );
        return Response.json(server.tasks[0]);
      }
      if (method === 'POST' && path.includes(`/tasks/${TASK_ID}/execute`)) {
        await server.executeTask(TASK_ID, body?.prompt);
        return new Response(null, { status: 200 });
      }
      return Response.json({ error: 'not stubbed' }, { status: 404 });
    }),
  );
}

beforeEach(() => {
  server.tasks = [makeTask()];
  server.updateTask.mockReset().mockResolvedValue(undefined);
  server.executeTask.mockReset().mockResolvedValue(undefined);
  server.sendTaskMessage.mockReset().mockResolvedValue(undefined);
  server.fetchTask.mockReset();
  server.syncExternalIssue.mockReset();
  server.runLocation.mockReset();
  server.draftDescription.mockReset().mockResolvedValue({ draft: 'AI draft' });
  server.messagesNotFound = false;
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  stubTaskRequests();
  useStore.setState({ detailTaskId: null, draftByKey: {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useStore.getState().setDetailTaskId(null);
});

describe('TaskDetailDialog header field sync', () => {
  it('follows external edits to untouched header fields and does not write them back', async () => {
    await renderDialog();

    externalUpdate({ title: 'New', depends_on_ids: ['task-x'] });
    await waitFor(() => expect(titleInput().value).toBe('New'));

    clickSave();
    await clickRerunContinue();
    await waitFor(() => expect(server.executeTask).toHaveBeenCalledTimes(1));
    expect(server.updateTask).not.toHaveBeenCalled();
  });

  it('keeps a locally edited title when the task is updated externally', async () => {
    await renderDialog();

    fireEvent.change(titleInput(), { target: { value: 'Mine' } });
    // The untouched skip-stages field proves the external update was applied.
    externalUpdate({ title: 'New', skip_stages: ['in_progress'] });
    await screen.findByText('Skip 1');
    expect(titleInput().value).toBe('Mine');

    clickSave();
    await waitFor(() =>
      expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, {
        title: 'Mine',
      }),
    );
    expect(titleInput().value).toBe('Mine');
  });

  it('keeps an unsaved title edit after a failed header save and resends it', async () => {
    await renderDialog();
    const failed = deferred();
    server.updateTask.mockReturnValueOnce(failed.promise);

    fireEvent.change(titleInput(), { target: { value: 'Mine' } });
    clickSave();
    await waitFor(() => expect(server.updateTask).toHaveBeenCalledTimes(1));
    failed.reject(new Error('boom'));
    // The optimistic update is rolled back once the rejection settles.
    await waitFor(() =>
      expect(
        queryClient.getQueryData<Task[]>(queryKeys.tasks.list(PROJECT_ID))?.[0]
          .title,
      ).toBe('Old'),
    );
    expect(titleInput().value).toBe('Mine');

    clickSave();
    await waitFor(() => expect(server.updateTask).toHaveBeenCalledTimes(2));
    expect(server.updateTask).toHaveBeenLastCalledWith(TASK_ID, {
      title: 'Mine',
    });
  });
});

describe('TaskDetailDialog close', () => {
  const closers: Array<[string, () => void]> = [
    ['Escape', () => fireEvent.keyDown(titleInput(), { key: 'Escape' })],
    [
      'the Close button',
      () => fireEvent.click(screen.getByRole('button', { name: 'Close' })),
    ],
  ];

  it.each(closers)(
    'saves a dirty title before closing with %s',
    async (_n, close) => {
      await renderDialog();
      fireEvent.change(titleInput(), { target: { value: 'Mine' } });
      close();

      await waitFor(() =>
        expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, {
          title: 'Mine',
        }),
      );
      await waitFor(() => expect(useStore.getState().detailTaskId).toBeNull());
    },
  );

  it.each(closers)(
    'sends nothing when closing clean with %s',
    async (_n, close) => {
      await renderDialog();
      close();

      await waitFor(() => expect(useStore.getState().detailTaskId).toBeNull());
      expect(server.updateTask).not.toHaveBeenCalled();
    },
  );

  it('saves a description draft before closing with Close', async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Edit desc' }));
    fireEvent.change(screen.getByPlaceholderText('Describe the task…'), {
      target: { value: 'Drafted description' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() =>
      expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, {
        description: 'Drafted description',
      }),
    );
    await waitFor(() => expect(useStore.getState().detailTaskId).toBeNull());
  });

  it('cancels the description edit on Escape without closing the dialog', async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Edit desc' }));
    const editor = screen.getByPlaceholderText('Describe the task…');
    fireEvent.change(editor, { target: { value: 'Drafted description' } });
    fireEvent.keyDown(editor, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Describe the task…')).toBeNull(),
    );
    expect(useStore.getState().detailTaskId).toBe(TASK_ID);
    expect(server.updateTask).not.toHaveBeenCalled();
  });

  it('stays open with the typed title when the save fails', async () => {
    await renderDialog();
    const failed = deferred();
    server.updateTask.mockReturnValueOnce(failed.promise);

    fireEvent.change(titleInput(), { target: { value: 'Mine' } });
    fireEvent.keyDown(titleInput(), { key: 'Escape' });
    await waitFor(() => expect(server.updateTask).toHaveBeenCalledTimes(1));
    failed.reject(new Error('boom'));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));

    expect(useStore.getState().detailTaskId).toBe(TASK_ID);
    expect(titleInput().value).toBe('Mine');
  });
});

describe('TaskDetailDialog extra stages', () => {
  it('saves the chosen co-stages in pipeline order and clears them with an empty list', async () => {
    await renderDialog();
    const option = (id: string) =>
      screen.getByRole('checkbox', { name: `Also run ${id}` });

    fireEvent.click(option('testing.u'));
    fireEvent.click(option('review.o'));
    clickSave();
    await waitFor(() =>
      expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, {
        coStages: ['review.o', 'testing.u'],
      }),
    );
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(option('review.o').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(option('review.o'));
    fireEvent.click(option('testing.u'));
    clickSave();
    await waitFor(() =>
      expect(server.updateTask).toHaveBeenLastCalledWith(TASK_ID, {
        coStages: [],
      }),
    );
  });
});

describe('TaskDetailDialog tabs', () => {
  const tabs = () =>
    Array.from(document.querySelectorAll('[data-ui="task-detail-tab"]')).map(
      (el) => el.getAttribute('data-tab'),
    );

  it('exposes a tablist with the selected tab marked', async () => {
    await renderDialog();
    const tabButtons = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabButtons).toHaveLength(5);
    expect(
      tabButtons.filter((t) => t.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(1);
  });

  it('shows only Details for a forked A/B parent and all tabs otherwise', async () => {
    await renderDialog();
    expect(tabs()).toEqual([
      'details',
      'chat',
      'history',
      'changes',
      'recordings',
    ]);

    externalUpdate({ ab_variants: ['a', 'b', 'o'], ab_fork_commit: 'abc123' });
    await waitFor(() => expect(tabs()).toEqual(['details']));
    expect(
      document
        .querySelector('[data-tab="details"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });
});

describe('TaskDetailDialog re-run prompt draft', () => {
  it('clears the textarea and the persisted draft once the run is accepted', async () => {
    await renderDialog();
    const run = deferred();
    server.executeTask.mockReturnValueOnce(run.promise);

    fireEvent.input(chatInput(), { target: { value: 'p' } });
    expect(useStore.getState().draftByKey[TASK_ID]).toBe('p');
    await clickRerunContinue();
    await waitFor(() =>
      expect(server.executeTask).toHaveBeenCalledWith(TASK_ID, 'p'),
    );
    run.resolve();

    await waitFor(() => expect(chatInput().value).toBe(''));
    expect(useStore.getState().draftByKey[TASK_ID] ?? '').toBe('');

    act(() => useStore.getState().setDetailTaskId(null));
    act(() => useStore.getState().setDetailTaskId(TASK_ID));
    await waitFor(() => expect(chatInput().value).toBe(''));
  });

  it('keeps the textarea and the persisted draft when the run is rejected', async () => {
    await renderDialog();
    const run = deferred();
    server.executeTask.mockReturnValueOnce(run.promise);

    fireEvent.input(chatInput(), { target: { value: 'p' } });
    await clickRerunContinue();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Re-run/ })).toHaveProperty(
        'disabled',
        true,
      ),
    );
    run.reject(new Error('409'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Re-run/ })).toHaveProperty(
        'disabled',
        false,
      ),
    );

    expect(chatInput().value).toBe('p');
    expect(useStore.getState().draftByKey[TASK_ID]).toBe('p');
  });
});

describe('TaskDetailDialog follow-up send', () => {
  it('sends once when Enter is pressed twice before the first send settles', async () => {
    await renderDialog();
    const sent = deferred();
    server.sendTaskMessage.mockReturnValueOnce(sent.promise);

    fireEvent.input(chatInput(), { target: { value: 'hello' } });
    fireEvent.keyDown(chatInput(), { key: 'Enter' });
    fireEvent.keyDown(chatInput(), { key: 'Enter' });

    await waitFor(() => expect(server.sendTaskMessage).toHaveBeenCalled());
    sent.resolve();
    await waitFor(() => expect(chatInput().value).toBe(''));
    expect(server.sendTaskMessage).toHaveBeenCalledTimes(1);
  });
});

describe('TaskDetailDialog task switching', () => {
  const OTHER_ID = 'task-other';
  const titleOf = () => titleInput().value;
  const switchTo = (id: string) =>
    act(() => useStore.getState().setDetailTaskId(id));

  it('saves a dirty title before following the A/B parent link', async () => {
    server.tasks = [
      makeTask({ abParentTaskId: OTHER_ID, stageVariant: 'a' }),
      makeTask({ id: OTHER_ID, title: 'Parent' }),
    ];
    await renderDialog();

    fireEvent.change(titleInput(), { target: { value: 'Mine' } });
    fireEvent.click(
      document.querySelector('[data-ui="task-ab-parent-link"]') as Element,
    );

    await waitFor(() =>
      expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, {
        title: 'Mine',
      }),
    );
    await waitFor(() =>
      expect(useStore.getState().detailTaskId).toBe(OTHER_ID),
    );
  });

  it('ignores a GitLab sync that returns after switching to another task', async () => {
    server.tasks = [makeTask(), makeTask({ id: OTHER_ID, title: 'Other' })];
    await renderDialog();
    const sync = deferred<unknown>();
    server.syncExternalIssue.mockReturnValueOnce(sync.promise);

    fireEvent.click(await screen.findByRole('button', { name: /Sync GitLab/ }));
    await waitFor(() => expect(server.syncExternalIssue).toHaveBeenCalled());
    switchTo(OTHER_ID);
    await waitFor(() => expect(titleOf()).toBe('Other'));
    sync.resolve({
      task: makeTask({ title: 'Synced A', description: 'Synced desc' }),
      comments: [],
      externalIssue: {},
    });
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));

    expect(titleOf()).toBe('Other');
  });

  it.each([
    [
      'Escape in the editor',
      () => {
        fireEvent.keyDown(screen.getByPlaceholderText('Describe the task…'), {
          key: 'Escape',
        });
      },
    ],
    [
      'the toggle button',
      () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
      },
    ],
  ])(
    'shows the saved description, not a draft cancelled with %s, in the AI edit panel',
    async (_name, cancel) => {
      await renderDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Edit desc' }));
      fireEvent.change(screen.getByPlaceholderText('Describe the task…'), {
        target: { value: 'Junk draft' },
      });
      cancel();
      fireEvent.click(screen.getByRole('button', { name: 'AI edit' }));
      const instruction = screen.getByPlaceholderText(
        /add acceptance criteria/,
      );
      fireEvent.change(instruction, { target: { value: 'tighten' } });
      fireEvent.keyDown(instruction, { key: 'Enter' });

      await screen.findByText('Current description');
      expect(screen.queryByText('Junk draft')).toBeNull();
      expect(
        document.querySelector('[data-ui="task-ai-description-current"]')
          ?.textContent,
      ).toContain('Header sync');
    },
  );

  it('saves a title typed while the source-run lookup is pending', async () => {
    server.tasks = [makeTask({ sourceRunId: 'run-1' })];
    await renderDialog();
    const lookup = deferred<unknown>();
    server.runLocation.mockReturnValueOnce(lookup.promise);

    fireEvent.click(document.querySelector('[data-run-id="run-1"]') as Element);
    await waitFor(() => expect(server.runLocation).toHaveBeenCalled());
    fireEvent.change(titleInput(), { target: { value: 'Mine' } });
    lookup.resolve({ projectId: PROJECT_ID, taskId: 'task-elsewhere' });

    await waitFor(() =>
      expect(server.updateTask).toHaveBeenCalledWith(TASK_ID, {
        title: 'Mine',
      }),
    );
    await waitFor(() =>
      expect(useStore.getState().detailTaskId).toBe('task-elsewhere'),
    );
  });

  it('resets the priority select when switching tasks', async () => {
    // The other task leads the queue, so the first task opens as "Next in
    // line" and picking "Top priority" is a real change (Radix does not fire
    // on re-selecting the current value, unlike a native select).
    server.tasks = [
      makeTask(),
      makeTask({ id: OTHER_ID, title: 'Other', priority: -500 }),
    ];
    await renderDialog();
    const select = () => screen.getByTitle('Priority');
    expect(selectedLabel(select())).toBe('Next in line');

    await chooseOption(select(), 'Top priority');
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(selectedLabel(select())).toBe('Top priority');
    switchTo(OTHER_ID);
    await waitFor(() => expect(titleOf()).toBe('Other'));

    expect(selectedLabel(select())).toBe('Next in line');
  });
});

describe('TaskDetailDialog unresolved task id', () => {
  const MISSING_ID = 'task-does-not-exist';

  function renderMissing() {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    useStore.setState({ detailTaskId: MISSING_ID });
    render(
      <QueryClientProvider client={queryClient}>
        <TaskDetailDialog project_id={PROJECT_ID} />
      </QueryClientProvider>,
    );
  }

  it('shows a not-found state without editor or actions once the list and fetch resolve, and Close clears the id', async () => {
    server.fetchTask.mockRejectedValue(new ApiError('Task not found', 404));
    renderMissing();

    await screen.findByText('Task not found');
    expect(screen.queryByPlaceholderText('Title')).toBeNull();
    expect(screen.queryByPlaceholderText('Follow-up message…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Backlog' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(useStore.getState().detailTaskId).toBeNull());
  });

  it('shows not-found for an id absent from the list even when cached messages exist', async () => {
    server.fetchTask.mockRejectedValue(new ApiError('Task not found', 404));
    // The cached messages survive a refetch that fails for the deleted task.
    server.messagesNotFound = true;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    queryClient.setQueryData(queryKeys.messages.all(PROJECT_ID, MISSING_ID), {
      pages: [
        {
          messages: [
            {
              id: 'm-cached',
              task_id: MISSING_ID,
              role: 'assistant',
              content: 'Cached answer',
              created_at: '2026-08-20T00:10:00.000Z',
            },
          ],
          total: 1,
          hasMore: false,
          nextOffset: 1,
        },
      ],
      pageParams: [0],
    });
    useStore.setState({ detailTaskId: MISSING_ID });
    render(
      <QueryClientProvider client={queryClient}>
        <TaskDetailDialog project_id={PROJECT_ID} />
      </QueryClientProvider>,
    );

    await screen.findByText('Task not found');
    expect(server.fetchTask).toHaveBeenCalledWith(MISSING_ID);
    expect(screen.queryByPlaceholderText('Title')).toBeNull();
  });

  it('keeps the normal dialog while the fetch is pending or fails with a non-404 error', async () => {
    const pending = deferred<Task>();
    server.fetchTask.mockReturnValueOnce(pending.promise);
    renderMissing();

    await waitFor(() => expect(server.fetchTask).toHaveBeenCalled());
    expect(screen.queryByText('Task not found')).toBeNull();
    expect(screen.getByPlaceholderText('Title')).toBeTruthy();

    pending.reject(new ApiError('boom', 500));
    await waitFor(() =>
      expect(
        queryClient.getQueryState(
          queryKeys.fullTask.all(PROJECT_ID, MISSING_ID),
        )?.status,
      ).toBe('error'),
    );
    expect(screen.queryByText('Task not found')).toBeNull();
    expect(screen.getByPlaceholderText('Title')).toBeTruthy();
  });

  it('opens a task that is in the board list normally', async () => {
    await renderDialog();
    expect(screen.queryByText('Task not found')).toBeNull();
    expect(server.fetchTask).not.toHaveBeenCalled();
  });
});
