import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import type { Task } from '@/types';
import { TaskDetailDialog } from './task-detail-dialog';

const PROJECT_ID = 'project-send-target';
const TASK_A = 'task-send-a';
const TASK_B = 'task-send-b';

const server = vi.hoisted(() => ({
  sendTaskMessage: vi.fn(),
  uploadAttachment: vi.fn(),
  updateTask: vi.fn(),
  noMessages: false,
}));

const toastSpy = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>();
  return {
    ...actual,
    toast: Object.assign(
      (...args: Parameters<typeof actual.toast>) => actual.toast(...args),
      actual.toast,
      { error: toastSpy.error },
    ),
  };
});

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchTasks: vi.fn(async () => [
    makeTask(TASK_A, 'Task A'),
    makeTask(TASK_B, 'Task B'),
  ]),
  sendTaskMessage: vi.fn(
    async (_projectId: string, taskId: string, content: string) =>
      server.sendTaskMessage(taskId, content),
  ),
  uploadAttachment: vi.fn(async (_projectId: string, file: File) =>
    server.uploadAttachment(file),
  ),
  fetchTaskMessages: vi.fn(async () =>
    server.noMessages
      ? { messages: [], total: 0, hasMore: false, nextOffset: 0 }
      : {
          messages: [
            {
              id: 'm1',
              task_id: TASK_A,
              role: 'assistant',
              content: 'Earlier answer',
              created_at: '2026-08-20T00:10:00.000Z',
            },
          ],
          total: 1,
          hasMore: false,
          nextOffset: 1,
        },
  ),
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

function makeTask(id: string, title: string): Task {
  return {
    id,
    project_id: PROJECT_ID,
    title,
    description: title,
    status: 'completed',
    priority: 0,
    created_at: '2026-08-20T00:00:00.000Z',
    running: false,
    archived: false,
    depends_on_ids: [],
    skip_stages: [],
  } as Task;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const chatInput = () =>
  screen.getByPlaceholderText<HTMLTextAreaElement>('Follow-up message…');

// useUpdateTask reaches the API module through a namespace import that
// `vi.mock('@/lib/api')` does not replace, so intercept its HTTP call.
function stubTaskRequests() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'PATCH' && path.includes('/tasks/')) {
        const taskId = path.split('/tasks/')[1];
        await server.updateTask(taskId, JSON.parse(String(init.body)));
        return Response.json(makeTask(taskId, 'Task'));
      }
      return Response.json({ error: 'not stubbed' }, { status: 404 });
    }),
  );
}

const firstPrompt = () =>
  screen.getByPlaceholderText<HTMLTextAreaElement>(/paste screenshots/);

function pasteScreenshot(target: HTMLElement) {
  fireEvent.paste(target, {
    clipboardData: {
      files: [new File(['x'], 'shot.png', { type: 'image/png' })],
    },
  });
}

async function renderDialogOnA() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  useStore.setState({ detailTaskId: TASK_A });
  render(
    <QueryClientProvider client={queryClient}>
      <TaskDetailDialog project_id={PROJECT_ID} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByPlaceholderText('Title')).toHaveProperty(
      'value',
      'Task A',
    ),
  );
  if (!server.noMessages) await screen.findByText('Earlier answer');
}

/** Opens the neighbouring task in the stage (Next or Prev, whichever exists). */
async function navigateToB() {
  fireEvent.click(
    await screen.findByRole('button', { name: /Open (next|previous) task/ }),
  );
  await waitFor(() => expect(useStore.getState().detailTaskId).toBe(TASK_B));
}

beforeEach(() => {
  server.sendTaskMessage.mockReset().mockResolvedValue(undefined);
  server.uploadAttachment.mockReset();
  server.updateTask.mockReset().mockResolvedValue(undefined);
  server.noMessages = false;
  toastSpy.error.mockReset();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  stubTaskRequests();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:attachment',
    revokeObjectURL: () => undefined,
  });
  useStore.setState({ detailTaskId: null, draftByKey: {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useStore.getState().setDetailTaskId(null);
});

describe('TaskDetailDialog follow-up send target', () => {
  it('attaches files picked with the Attach files button as chips, including the same file twice', async () => {
    await renderDialogOnA();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
    const input = document.querySelector<HTMLInputElement>(
      '[data-ui="task-detail-file-input"]',
    )!;
    const pick = () =>
      fireEvent.change(input, {
        target: {
          files: [new File(['x'], 'picked.png', { type: 'image/png' })],
        },
      });

    pick();
    await waitFor(() =>
      expect(screen.getAllByAltText('picked.png')).toHaveLength(1),
    );
    pick();
    await waitFor(() =>
      expect(screen.getAllByAltText('picked.png')).toHaveLength(2),
    );
  });

  it('posts to the task the send started on when the user navigates during the attachment upload', async () => {
    await renderDialogOnA();
    const upload = deferred<{ containerPath: string }>();
    server.uploadAttachment.mockReturnValueOnce(upload.promise);

    fireEvent.paste(chatInput(), {
      clipboardData: {
        files: [new File(['x'], 'shot.png', { type: 'image/png' })],
      },
    });
    fireEvent.input(chatInput(), { target: { value: 'instruction for A' } });
    fireEvent.keyDown(chatInput(), { key: 'Enter' });
    await waitFor(() => expect(server.uploadAttachment).toHaveBeenCalled());

    await navigateToB();
    await act(async () => upload.resolve({ containerPath: '/tmp/shot.png' }));

    await waitFor(() =>
      expect(server.sendTaskMessage).toHaveBeenCalledTimes(1),
    );
    expect(server.sendTaskMessage).toHaveBeenCalledWith(
      TASK_A,
      expect.stringContaining('instruction for A'),
    );
  });

  it('keeps the other task draft and clears the sent task draft when the send settles after navigating', async () => {
    await renderDialogOnA();
    const sent = deferred();
    server.sendTaskMessage.mockReturnValueOnce(sent.promise);
    useStore.setState({ draftByKey: { [TASK_B]: 'draft for B' } });

    fireEvent.input(chatInput(), { target: { value: 'instruction for A' } });
    expect(useStore.getState().draftByKey[TASK_A]).toBe('instruction for A');
    fireEvent.keyDown(chatInput(), { key: 'Enter' });
    await waitFor(() =>
      expect(server.sendTaskMessage).toHaveBeenCalledWith(
        TASK_A,
        'instruction for A',
      ),
    );

    await navigateToB();
    await waitFor(() => expect(chatInput().value).toBe('draft for B'));
    await act(async () => sent.resolve());

    await waitFor(() =>
      expect(useStore.getState().draftByKey[TASK_A] ?? '').toBe(''),
    );
    expect(chatInput().value).toBe('draft for B');
    expect(useStore.getState().draftByKey[TASK_B]).toBe('draft for B');
  });

  it('keeps the follow-up and chips and sends nothing when an attachment upload is rejected', async () => {
    await renderDialogOnA();
    server.uploadAttachment.mockRejectedValueOnce(new Error('413'));

    pasteScreenshot(chatInput());
    fireEvent.input(chatInput(), { target: { value: 'instruction for A' } });
    fireEvent.keyDown(chatInput(), { key: 'Enter' });

    await waitFor(() =>
      expect(toastSpy.error).toHaveBeenCalledWith(
        expect.stringContaining('shot.png'),
      ),
    );
    expect(server.sendTaskMessage).not.toHaveBeenCalled();
    expect(chatInput().value).toBe('instruction for A');
    expect(useStore.getState().draftByKey[TASK_A]).toBe('instruction for A');
    expect(document.querySelector('img[src="blob:attachment"]')).not.toBeNull();
  });

  it('shows the server reason and keeps the draft when the follow-up send is rejected', async () => {
    await renderDialogOnA();
    server.sendTaskMessage.mockRejectedValueOnce(
      new Error('Task is already running'),
    );

    fireEvent.input(chatInput(), { target: { value: 'instruction for A' } });
    fireEvent.keyDown(chatInput(), { key: 'Enter' });

    await waitFor(() =>
      expect(toastSpy.error).toHaveBeenCalledWith(
        expect.stringContaining('Task is already running'),
      ),
    );
    expect(chatInput().value).toBe('instruction for A');
    expect(useStore.getState().draftByKey[TASK_A]).toBe('instruction for A');
  });

  it('keeps the prompt, chips and dialog when queueing fails, then closes once it succeeds', async () => {
    server.noMessages = true;
    await renderDialogOnA();
    server.updateTask.mockRejectedValueOnce(new Error('409'));
    server.uploadAttachment.mockResolvedValue({
      containerPath: '/tmp/shot.png',
    });

    pasteScreenshot(firstPrompt());
    fireEvent.input(firstPrompt(), { target: { value: 'run this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));

    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    expect(useStore.getState().detailTaskId).toBe(TASK_A);
    expect(firstPrompt().value).toBe('run this');
    expect(useStore.getState().draftByKey[TASK_A]).toBe('run this');
    expect(document.querySelector('img[src="blob:attachment"]')).not.toBeNull();

    const retry = screen.getByRole('button', { name: 'Queue' });
    await waitFor(() => expect(retry).toHaveProperty('disabled', false));
    fireEvent.click(retry);
    await waitFor(() => expect(useStore.getState().detailTaskId).toBeNull());
    expect(server.updateTask).toHaveBeenLastCalledWith(
      TASK_A,
      expect.objectContaining({
        description: expect.stringContaining('run this'),
      }),
    );
    expect(useStore.getState().draftByKey[TASK_A] ?? '').toBe('');
  });

  it('keeps the description editor open with the typed text when saving is rejected', async () => {
    await renderDialogOnA();
    server.updateTask.mockRejectedValueOnce(new Error('409'));

    fireEvent.click(screen.getByTitle('Edit description'));
    const editor =
      await screen.findByPlaceholderText<HTMLTextAreaElement>(
        'Describe the task…',
      );
    fireEvent.change(editor, { target: { value: 'new description' } });
    fireEvent.click(screen.getByRole('button', { name: /Save description/ }));

    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>('Describe the task…')
        .value,
    ).toBe('new description');

    const retry = screen.getByRole('button', { name: /Save description/ });
    await waitFor(() => expect(retry).toHaveProperty('disabled', false));
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Describe the task…')).toBeNull(),
    );
  });
});

describe('TaskDetailDialog composer draft restore', () => {
  const tabButton = (name: string) =>
    document.querySelector<HTMLButtonElement>(`[data-tab="${name}"]`)!;
  const closeDialog = async () => {
    act(() => useStore.getState().setDetailTaskId(null));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Follow-up message…')).toBeNull(),
    );
  };
  const reopen = async (taskId: string) => {
    act(() => useStore.getState().setDetailTaskId(taskId));
    await screen.findByPlaceholderText('Follow-up message…');
  };

  it('restores the typed draft after a close/reopen and a Details -> Chat switch', async () => {
    const user = userEvent.setup();
    await renderDialogOnA();
    await user.type(chatInput(), 'alpha');

    await closeDialog();
    await reopen(TASK_A);
    expect(chatInput().value).toBe('alpha');

    fireEvent.click(tabButton('details'));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Follow-up message…')).toBeNull(),
    );
    fireEvent.click(tabButton('chat'));
    await waitFor(() => expect(chatInput().value).toBe('alpha'));
  });

  it('keeps a sent draft cleared across a tab switch and reopen', async () => {
    const user = userEvent.setup();
    await renderDialogOnA();
    await user.type(chatInput(), 'alpha');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(chatInput().value).toBe(''));

    fireEvent.click(tabButton('details'));
    fireEvent.click(tabButton('chat'));
    await waitFor(() => expect(chatInput().value).toBe(''));
    await closeDialog();
    await reopen(TASK_A);
    expect(chatInput().value).toBe('');
  });

  it("shows the other card's draft, never the previous card's text, after switching cards", async () => {
    const user = userEvent.setup();
    await renderDialogOnA();
    await user.type(chatInput(), 'alpha');

    await closeDialog();
    await reopen(TASK_B);
    expect(chatInput().value).toBe('');
    await user.type(chatInput(), 'beta');

    fireEvent.click(tabButton('details'));
    fireEvent.click(tabButton('chat'));
    await waitFor(() => expect(chatInput().value).toBe('beta'));
    await closeDialog();
    await reopen(TASK_A);
    expect(chatInput().value).toBe('alpha');
  });
});
