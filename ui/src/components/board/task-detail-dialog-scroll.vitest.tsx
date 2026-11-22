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
import { useStore } from '@/store';
import type { TaskMessage, TaskRunLog } from '@/types';
import { TaskDetailDialog } from './task-detail-dialog';

const PROJECT_ID = 'project-scroll';
const TASK_A = 'task-scroll-a';
const TASK_B = 'task-scroll-b';

interface TranscriptPage {
  messages: TaskMessage[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
}

const server = vi.hoisted(() => ({
  pagesByTask: new Map<string, Map<number, TranscriptPage>>(),
  runsByTask: new Map<string, TaskRunLog[]>(),
  fetchMessageCalls: [] as Array<{ taskId: string; offset: number }>,
  sendMessage: vi.fn(),
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
  fetchTaskMessages: vi.fn(
    async (
      _projectId: string,
      taskId: string,
      _limit: number,
      offset: number,
    ) => {
      server.fetchMessageCalls.push({ taskId, offset });
      const page = server.pagesByTask.get(taskId)?.get(offset);
      if (!page) throw new Error(`Missing transcript page ${taskId}:${offset}`);
      return page;
    },
  ),
  fetchTaskRuns: vi.fn(async (_projectId: string, taskId: string) => ({
    runs: server.runsByTask.get(taskId) ?? [],
    latest_scored_review_run: null,
    total: server.runsByTask.get(taskId)?.length ?? 0,
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
  uploadAttachment: vi.fn(async (_projectId: string, file: File) => ({
    containerPath: `/uploads/${file.name}`,
  })),
  sendTaskMessage: vi.fn(
    async (_projectId: string, taskId: string, content: string) =>
      server.sendMessage(taskId, content),
  ),
}));

const tasks = [TASK_A, TASK_B].map((id) => ({
  id,
  title: id === TASK_A ? 'Scroll task A' : 'Scroll task B',
  description: 'Mounted scroll behavior',
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
}));

vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({ data: tasks }),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: PROJECT_ID,
        name: 'Scroll project',
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
vi.mock('@/components/chat/chat-message-bubble', () => ({
  ChatMessageBubble: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ projectId: PROJECT_ID }),
}));

function message(
  id: string,
  content: string,
  createdAt: string,
  options: Partial<TaskMessage> = {},
): TaskMessage {
  return {
    id,
    task_id: TASK_A,
    role: 'assistant',
    content,
    created_at: createdAt,
    ...options,
  };
}

function run(id: string, runAt: string, taskId = TASK_A): TaskRunLog {
  return {
    id,
    task_id: taskId,
    run_at: runAt,
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
    reviewScore: null,
    stage: 'completed',
  };
}

function page(
  messages: TaskMessage[],
  {
    hasMore = false,
    nextOffset = messages.length,
  }: Partial<TranscriptPage> = {},
): TranscriptPage {
  return { messages, total: messages.length, hasMore, nextOffset };
}

let chatScrollHeight = 1000;
const anchorOffsets = new Map<string, number>();
let resizeObservers: TestResizeObserver[] = [];
let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrame = 1;

class TestResizeObserver {
  private active = true;
  private observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(element: Element) {
    this.observed.add(element);
  }

  disconnect() {
    this.active = false;
    this.observed.clear();
  }

  unobserve(element: Element) {
    this.observed.delete(element);
  }

  trigger() {
    if (this.active && this.observed.size > 0) {
      this.callback([], this as unknown as ResizeObserver);
    }
  }
}

function anchorKey(element: HTMLElement) {
  if (element.dataset.runId) return `run:${element.dataset.runId}`;
  if (element.dataset.msgId) return `msg:${element.dataset.msgId}`;
  return null;
}

function chatContainer() {
  return document.querySelector<HTMLElement>(
    '[data-ui="task-tab-content"][data-task-tab="chat"]',
  );
}

function triggerResize() {
  for (const observer of [...resizeObservers]) observer.trigger();
}

function flushAnimationFrames() {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  callbacks.forEach((callback) => callback(performance.now()));
}

function installScrollGeometry() {
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.taskTab === 'chat' ? 200 : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.taskTab === 'chat'
          ? chatScrollHeight
          : 0;
      },
    },
  });
  HTMLElement.prototype.scrollTo = function scrollTo(
    optionsOrX?: ScrollToOptions | number,
    y?: number,
  ) {
    this.scrollTop =
      typeof optionsOrX === 'number'
        ? (y ?? 0)
        : (optionsOrX?.top ?? this.scrollTop);
  };
  HTMLElement.prototype.getBoundingClientRect =
    function getBoundingClientRect() {
      const element = this as HTMLElement;
      if (element.dataset.taskTab === 'chat') {
        return DOMRect.fromRect({ x: 0, y: 0, width: 500, height: 200 });
      }
      const key = anchorKey(element);
      const offset = key ? anchorOffsets.get(key) : undefined;
      if (offset !== undefined) {
        return DOMRect.fromRect({
          x: 0,
          y: offset - (chatContainer()?.scrollTop ?? 0),
          width: 500,
          height: 20,
        });
      }
      return DOMRect.fromRect();
    };
}

function setTaskPage(taskId: string, transcriptPage: TranscriptPage) {
  server.pagesByTask.set(taskId, new Map([[0, transcriptPage]]));
}

async function renderDialog(taskId = TASK_A) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  useStore.setState({ detailTaskId: taskId });
  render(
    <QueryClientProvider client={queryClient}>
      <TaskDetailDialog project_id={PROJECT_ID} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(chatContainer()).toBeTruthy());
  await waitFor(() =>
    expect(server.fetchMessageCalls).toContainEqual({ taskId, offset: 0 }),
  );
}

function switchTask(taskId: string | null) {
  act(() => useStore.getState().setDetailTaskId(taskId));
}

beforeEach(() => {
  chatScrollHeight = 1000;
  anchorOffsets.clear();
  resizeObservers = [];
  animationFrames = new Map();
  nextAnimationFrame = 1;
  server.pagesByTask.clear();
  server.runsByTask.clear();
  server.fetchMessageCalls = [];
  server.sendMessage.mockReset();
  setTaskPage(
    TASK_A,
    page([
      message(
        'initial-a',
        'Newest answer for task A',
        '2026-08-20T00:10:00.000Z',
      ),
    ]),
  );
  setTaskPage(
    TASK_B,
    page([
      message(
        'initial-b',
        'Newest answer for task B',
        '2026-08-20T00:20:00.000Z',
        { task_id: TASK_B },
      ),
    ]),
  );
  server.runsByTask.set(TASK_A, []);
  server.runsByTask.set(TASK_B, []);
  installScrollGeometry();
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextAnimationFrame++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    animationFrames.delete(id);
  });
  useStore.setState({
    detailTaskId: null,
    reviewRunIntent: null,
    liveTaskIds: {},
    streamingOutput: {},
    taskStreamRunIds: {},
  });
  // Deep-link tests push a `?taskId=&runId=` URL; jsdom keeps it for the
  // rest of the file, so every test starts from a clean location.
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState({}, '', '/');
  cleanup();
  vi.unstubAllGlobals();
  useStore.getState().setDetailTaskId(null);
});

describe('TaskDetailDialog follow-up send failure', () => {
  it('shows an error toast and keeps the draft and attachment chips', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => {},
    });
    server.sendMessage.mockRejectedValue(new Error('boom'));
    toastSpy.error.mockClear();
    await renderDialog();

    const input = screen.getByPlaceholderText(
      'Follow-up message…',
    ) as HTMLTextAreaElement;
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(['x'], 'shot.txt', { type: 'text/plain' })],
      },
    });
    await screen.findByText('shot.txt');
    fireEvent.input(input, { target: { value: 'Please continue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(toastSpy.error).toHaveBeenCalledWith(
        'Could not send the message: boom',
      ),
    );
    expect(server.sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByText('shot.txt')).toBeTruthy();
    expect(input.value).toBe('Please continue');
  });
});

describe('TaskDetailDialog mounted chat scrolling', () => {
  it('re-pins a follow-up send and follows the resulting transcript growth', async () => {
    await renderDialog();
    const container = chatContainer()!;
    expect(container.scrollTop).toBe(chatScrollHeight);

    container.scrollTop = 100;
    fireEvent.scroll(container);
    server.sendMessage.mockImplementation(
      async (taskId: string, content: string) => {
        chatScrollHeight = 1400;
        const sent = message('follow-up', content, '2026-08-20T00:11:00.000Z', {
          task_id: taskId,
          role: 'user',
        });
        setTaskPage(
          taskId,
          page([server.pagesByTask.get(taskId)!.get(0)!.messages[0], sent]),
        );
        return sent;
      },
    );

    fireEvent.input(screen.getByPlaceholderText('Follow-up message…'), {
      target: { value: 'Please continue' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(server.sendMessage).toHaveBeenCalledWith(
        TASK_A,
        'Please continue',
      ),
    );
    await waitFor(() => expect(container.scrollTop).toBe(1400));
    expect(screen.getByText('Please continue')).toBeTruthy();
  });

  it('suspends ordinary auto-follow until the selected run anchor settles', async () => {
    const selectedRun = run('run-selected', '2026-08-20T00:00:00.000Z');
    server.runsByTask.set(TASK_A, [selectedRun]);
    setTaskPage(
      TASK_A,
      page([
        message('run-start', '', '2026-08-20T00:00:00.000Z', {
          entry_type: 'run_start',
          run_id: selectedRun.id,
        }),
        message(
          'run-answer',
          'Selected run answer',
          '2026-08-20T00:01:00.000Z',
        ),
      ]),
    );
    anchorOffsets.set(`run:${selectedRun.id}`, 320);
    await renderDialog();

    fireEvent.click(screen.getByRole('tab', { name: /Run History/ }));
    const runEntry = await screen.findByTitle('Jump to this run in chat');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(runEntry);
    const container = chatContainer()!;
    expect(container.scrollTop).toBe(315);

    chatScrollHeight = 1600;
    act(() => triggerResize());
    act(() => flushAnimationFrames());
    expect(container.scrollTop).toBe(315);

    act(() => vi.advanceTimersByTime(300));
    expect(container.scrollTop).toBe(315);

    // Settlement resumes ordinary smart-scroll without forcing a jump. Mimic
    // the user returning to the bottom, then prove later transcript growth is
    // followed again through the mounted content observer.
    container.scrollTop = chatScrollHeight - container.clientHeight;
    fireEvent.scroll(container);
    chatScrollHeight = 1900;
    act(() => triggerResize());
    act(() => flushAnimationFrames());
    expect(container.scrollTop).toBe(1900);
  });

  it('cancels an in-flight run jump when leaving Chat', async () => {
    const staleRun = run('run-stale', '2026-08-20T00:00:00.000Z');
    server.runsByTask.set(TASK_A, [staleRun]);
    setTaskPage(
      TASK_A,
      page([
        message('stale-start', '', '2026-08-20T00:00:00.000Z', {
          entry_type: 'run_start',
          run_id: staleRun.id,
        }),
      ]),
    );
    anchorOffsets.set(`run:${staleRun.id}`, 260);
    await renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: /Run History/ }));
    fireEvent.click(await screen.findByTitle('Jump to this run in chat'));
    const container = chatContainer()!;
    expect(container.scrollTop).toBe(255);

    fireEvent.click(screen.getByRole('tab', { name: /Run History/ }));
    fireEvent.click(
      document.querySelector<HTMLButtonElement>(
        '[data-ui="task-detail-tab"][data-tab="chat"]',
      )!,
    );
    await waitFor(() => expect(chatContainer()).toBeTruthy());
    const returnedContainer = chatContainer()!;
    expect(returnedContainer).not.toBe(container);
    expect(returnedContainer.scrollTop).toBe(255);

    // A delayed layout notification from the abandoned jump must not realign
    // the viewport after returning through the ordinary Chat tab control.
    anchorOffsets.set(`run:${staleRun.id}`, 800);
    chatScrollHeight = 1700;
    act(() => triggerResize());
    act(() => flushAnimationFrames());
    expect(returnedContainer.scrollTop).toBe(255);
  });

  it('settles a reopened deep-linked Chat dialog at the latest transcript content', async () => {
    // A (task, run) deep link opens the dialog before its chat viewport
    // exists in the browser; the jump is one-shot per page session, so a
    // close/reopen must settle at the latest content instead of re-jumping
    // the transcript to the mid-scroll divider.
    window.history.pushState({}, '', '/?taskId=task-scroll-a&runId=run-deep');
    const deepMessage = (id: string, content: string, createdAt: string) =>
      message(id, content, createdAt);
    server.pagesByTask.set(
      TASK_A,
      new Map<number, TranscriptPage>([
        [
          0,
          page(
            [
              deepMessage(
                'deep-n3',
                'Deep early answer',
                '2026-08-20T00:06:00.000Z',
              ),
              deepMessage(
                'deep-n2',
                'Deep middle answer',
                '2026-08-20T00:08:00.000Z',
              ),
              deepMessage(
                'deep-n1',
                'Deep newest answer',
                '2026-08-20T00:09:00.000Z',
              ),
            ],
            { hasMore: true, nextOffset: 1 },
          ),
        ],
        [
          1,
          page(
            [
              deepMessage(
                'deep-n4',
                'Deep run line four',
                '2026-08-20T00:03:00.000Z',
              ),
              deepMessage(
                'deep-n5',
                'Deep run line five',
                '2026-08-20T00:04:00.000Z',
              ),
              deepMessage(
                'deep-n6',
                'Deep run line six',
                '2026-08-20T00:05:00.000Z',
              ),
            ],
            { hasMore: true, nextOffset: 2 },
          ),
        ],
        [
          2,
          page([
            message('deep-run-start', '', '2026-08-20T00:00:00.000Z', {
              entry_type: 'run_start',
              run_id: 'run-deep',
            }),
            deepMessage(
              'deep-o1',
              'Deep run first line',
              '2026-08-20T00:01:00.000Z',
            ),
            deepMessage(
              'deep-o2',
              'Deep run second line',
              '2026-08-20T00:02:00.000Z',
            ),
          ]),
        ],
      ]),
    );
    anchorOffsets.set('run:run-deep', 320);
    await renderDialog();

    // First open: the deep link arms the run jump, older pages load until
    // the divider appears, and it aligns just below the viewport top.
    await waitFor(() => expect(chatContainer()!.scrollTop).toBe(315));
    expect(server.fetchMessageCalls.map(({ offset }) => offset)).toEqual([
      0, 1, 2,
    ]);
    expect(
      document.querySelectorAll('[data-ui="task-transcript-message"]').length,
    ).toBeGreaterThan(3);

    // Close and reopen the same deep-linked dialog within the page session
    // (the URL keeps its parameters); cached pages make the divider
    // available immediately on reopen.
    switchTask(null);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    chatScrollHeight = 2400;
    switchTask(TASK_A);

    await waitFor(() => expect(chatContainer()!.scrollTop).toBe(2400));
    // The deep link is one-shot: the reopened transcript settles at the
    // latest content instead of jumping back to the run divider.
    expect(screen.getByText('Deep newest answer')).toBeTruthy();
  });
});
