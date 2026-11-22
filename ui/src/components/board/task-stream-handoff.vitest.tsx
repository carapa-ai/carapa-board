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
import { PAGED_OLDER_CONTENT_LIMIT } from '@/lib/task-message-rendering';
import { useStore } from '@/store';
import type { TaskMessage, TaskRunLog } from '@/types';
import { TaskDetailDialog } from './task-detail-dialog';

const TASK_ID = 'task-stream-handoff';
const PROJECT_ID = 'project-stream-handoff';

const server = vi.hoisted(() => ({
  messages: [] as TaskMessage[],
  runs: [] as TaskRunLog[],
  hasMore: false,
  running: false,
  queued: false,
  messageDelivery: 'steered' as 'steered' | 'queued',
  outputPages: [] as Array<{
    content: string;
    nextCursor: number;
    hasMore: boolean;
    total?: number;
    runId?: string | null;
    entries?: Array<{
      id: string;
      content: string;
      startOffset: number;
      endOffset: number;
    }>;
  }>,
  outputBeforeOffsets: [] as Array<number | undefined>,
  pendingOutputFetch: null as null | {
    promise: Promise<{
      content: string;
      nextCursor: number;
      hasMore: boolean;
      runId?: string | null;
    }>;
    resolve: (page: {
      content: string;
      nextCursor: number;
      hasMore: boolean;
      runId?: string | null;
    }) => void;
  },
  pendingMessagesFetch: null as null | {
    promise: Promise<{
      messages: TaskMessage[];
      total: number;
      hasMore: boolean;
      nextOffset: number;
    }>;
    resolve: () => void;
  },
  taskMessageRequests: [] as Array<{
    url: string;
    method: string | undefined;
    body: unknown;
  }>,
}));

function messagesPage(messages = server.messages) {
  return {
    messages: messages.map((message) => ({ ...message })),
    total: messages.length + (server.hasMore ? 1 : 0),
    hasMore: server.hasMore,
    nextOffset: messages.length ? 1 : 0,
  };
}

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(
    async () =>
      new Response(JSON.stringify({ ticket: 'task-stream-test-ticket' })),
  ),
  fetchTaskMessages: vi.fn(async () => {
    if (server.pendingMessagesFetch) return server.pendingMessagesFetch.promise;
    return messagesPage();
  }),
  fetchTaskOutput: vi.fn(
    async (
      _projectId: string,
      _taskId: string,
      _limit: number,
      _offset: number,
      _runId: string | undefined,
      beforeOffset: number | undefined,
    ) => {
      server.outputBeforeOffsets.push(beforeOffset);
      if (server.pendingOutputFetch) return server.pendingOutputFetch.promise;
      const page = server.outputPages.shift() ?? {
        content: '',
        nextCursor: 0,
        hasMore: false,
      };
      return { ...page, runId: page.runId ?? _runId ?? null };
    },
  ),
  fetchTaskRuns: vi.fn(async () => ({
    runs: server.runs.map((run) => ({ ...run })),
    latest_scored_review_run: null,
    total: server.runs.length,
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
      kanban: {
        fallback: { harnessId: '', modelId: '' },
        stages: {},
      },
    },
  })),
}));

vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({
    data: [
      {
        id: TASK_ID,
        title: 'Stream handoff task',
        description: 'Exercise stream handoff',
        status: 'build',
        priority: 0,
        created_at: '2026-08-20T00:00:00.000Z',
        archived: false,
        error: null,
        owner: null,
        latestTrigger: null,
        running: server.running,
        queued: server.queued,
        phase: server.running ? 'running' : server.queued ? 'queued' : 'idle',
        skip_stages: [],
      },
    ],
  }),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: PROJECT_ID,
        name: 'Stream project',
        effectiveStages: [
          { id: 'build', title: 'Build', type: 'active', color: '#123456' },
          {
            id: 'testing',
            title: 'Testing',
            type: 'testing',
            color: '#654321',
          },
          { id: 'review', title: 'Review', type: 'review', color: '#abcdef' },
        ],
      },
    ],
  }),
}));

vi.mock('@/hooks/use-task-mutations', async (importOriginal) => {
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  });
  return {
    ...(await importOriginal<typeof import('@/hooks/use-task-mutations')>()),
    useUpdateTask: mutation,
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

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ projectId: PROJECT_ID }),
}));

class TestWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = TestWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    queueMicrotask(() => this.onopen?.());
  }

  close() {
    this.onclose?.();
  }
}

const { connectWebSocket, disconnectWebSocket, handleWebSocketEvent } =
  await import('@/lib/websocket');

function message(
  id: string,
  content: string,
  options: Partial<TaskMessage> = {},
): TaskMessage {
  return {
    id,
    task_id: TASK_ID,
    role: 'assistant',
    content,
    created_at: '2026-08-20T00:00:00.000Z',
    ...options,
  };
}

function runStart(runId: string): TaskMessage {
  return message(`start-${runId}`, '', {
    role: 'system',
    entry_type: 'run_start',
    run_id: runId,
  });
}
function run(id: string, stage: string, runAt: string): TaskRunLog {
  return {
    id,
    task_id: TASK_ID,
    run_at: runAt,
    duration_ms: 1000,
    status: 'success',
    output: null,
    error: null,
    model: null,
    model_name: null,
    agent_name: 'tester',
    session_id: null,
    tok_total: null,
    tool_usage_count: null,
    reviewScore: null,
    stage,
  };
}

function liveMarkers() {
  return document.querySelectorAll(
    `[data-ui="task-live-transcript"][data-task-id="${TASK_ID}"]`,
  );
}

function transcriptMarkers(runId: string) {
  return document.querySelectorAll(
    `[data-ui="task-transcript-message"][data-task-id="${TASK_ID}"][data-run-id="${runId}"]`,
  );
}

async function emit(type: string, payload: Record<string, unknown>) {
  await act(async () => {
    handleWebSocketEvent({ type, payload } as never);
    await Promise.resolve();
  });
}

async function startRun(runId: string, output: string) {
  await emit('task_started', {
    project_id: PROJECT_ID,
    task_id: TASK_ID,
    run_id: runId,
  });
  expect(useStore.getState().detailTaskId).toBe(TASK_ID);
  await emit('task_output', {
    project_id: PROJECT_ID,
    task_id: TASK_ID,
    run_id: runId,
    content: output,
  });
  await waitFor(() => expect(liveMarkers()).toHaveLength(1));
}

async function startSemanticRun(
  runId: string,
  entries: Array<{ id: string; content: string }>,
) {
  await act(async () => {
    handleWebSocketEvent({
      type: 'task_started',
      payload: {
        project_id: PROJECT_ID,
        task_id: TASK_ID,
        run_id: runId,
      },
    } as never);
    for (const entry of entries) {
      handleWebSocketEvent({
        type: 'task_output',
        payload: {
          project_id: PROJECT_ID,
          task_id: TASK_ID,
          run_id: runId,
          entry_id: entry.id,
          content: entry.content,
        },
      } as never);
    }
    await Promise.resolve();
  });
  await waitFor(() => expect(liveMarkers()).toHaveLength(1));
}

async function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  connectWebSocket(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <TaskDetailDialog project_id={PROJECT_ID} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      document.querySelector(
        '[data-ui="task-tab-content"][data-task-tab="chat"]',
      ),
    ).toBeTruthy(),
  );
  return queryClient;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', TestWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/output?')) {
        return new Response(
          JSON.stringify(
            server.outputPages.shift() ?? {
              content: '',
              nextCursor: 0,
              hasMore: false,
            },
          ),
        );
      }
      if (
        init?.method === 'POST' &&
        /\/api\/projects\/[^/]+\/tasks\/[^/]+\/messages$/.test(String(input))
      ) {
        const body = JSON.parse(String(init.body));
        server.taskMessageRequests.push({
          url: String(input),
          method: init.method,
          body,
        });
        const sent: TaskMessage = {
          id: 'steered-user',
          task_id: TASK_ID,
          role: 'user' as const,
          content: body.content,
          created_at: '2026-08-20T00:02:00.000Z',
          steering: true,
          steeringDelivery: server.messageDelivery,
          run_id: 'run-active',
        };
        server.messages.push(sent);
        return new Response(
          JSON.stringify({ ...sent, delivery: server.messageDelivery }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return new Response(
        JSON.stringify({ ticket: 'task-stream-test-ticket' }),
      );
    }),
  );
  server.outputPages = [];
  server.outputBeforeOffsets = [];
  server.messages = [];
  server.hasMore = false;
  server.runs = [];
  server.running = false;
  server.queued = false;
  server.messageDelivery = 'steered';
  server.pendingMessagesFetch = null;
  server.pendingOutputFetch = null;
  server.taskMessageRequests = [];
  useStore.setState({
    detailTaskId: TASK_ID,
    streamingOutput: {},
    liveTaskIds: {},
    taskStreamRunIds: {},
    finishedTaskStreamRunIds: {},
    readyTaskTranscriptRunIds: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  disconnectWebSocket();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TaskDetailDialog stream-to-transcript handoff', () => {
  it('places a delayed tester response before its format-repair divider', async () => {
    server.runs = [
      run(
        'run-testing-repair',
        'testing:format-repair-1',
        '2026-08-20T00:01:00.000Z',
      ),
      run('run-testing-original', 'testing', '2026-08-20T00:00:00.000Z'),
    ];
    server.messages = [
      runStart('run-testing-original'),
      runStart('run-testing-repair'),
    ];
    await renderDialog();
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-ui="task-run-divider"][data-run-id="run-testing-original"]',
        ),
      ).toBeTruthy(),
    );

    server.messages = [
      runStart('run-testing-original'),
      runStart('run-testing-repair'),
      message(
        'tester-validation',
        'Focused validation completed successfully.',
        {
          entry_type: 'run_result',
          run_id: 'run-testing-original',
        },
      ),
      message('testing-outcome', '**Testing passed**\n\nAll checks passed.', {
        role: 'system',
        entry_type: 'system_notice',
      }),
    ];
    await emit('task_message', { project_id: PROJECT_ID, task_id: TASK_ID });

    await waitFor(() =>
      expect(
        document.querySelectorAll(
          '[data-ui="task-run-divider"], [data-ui="task-transcript-message"]',
        ),
      ).toHaveLength(4),
    );
    const rendered = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-ui="task-run-divider"], [data-ui="task-transcript-message"]',
      ),
    );
    expect(
      rendered.map((node) => ({
        ui: node.dataset.ui,
        runId: node.dataset.runId,
        messageId: node.dataset.msgId,
      })),
    ).toEqual([
      {
        ui: 'task-run-divider',
        runId: 'run-testing-original',
        messageId: undefined,
      },
      {
        ui: 'task-transcript-message',
        runId: 'run-testing-original',
        messageId: 'tester-validation',
      },
      {
        ui: 'task-run-divider',
        runId: 'run-testing-repair',
        messageId: undefined,
      },
      {
        ui: 'task-transcript-message',
        runId: 'run-testing-repair',
        messageId: 'testing-outcome',
      },
    ]);
  });

  it('merges a throttled live bridge exactly once after a non-full older page', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const runId = 'run-throttled-bridge';
    const entry = (marker: string) =>
      marker + 'x'.repeat(10_000 - marker.length);
    await renderDialog();
    await startSemanticRun(
      runId,
      ['entry-1-', 'entry-2-', 'entry-3-', 'entry-4-'].map((marker) => ({
        id: marker,
        content: entry(marker),
      })),
    );
    await waitFor(() =>
      expect(liveMarkers()[0]?.textContent).toContain('entry-4-'),
    );

    server.outputPages = [
      {
        content: entry('entry-1-'),
        nextCursor: 0,
        hasMore: false,
        runId,
      },
    ];
    await act(async () => {
      screen.getByRole('button', { name: 'Load earlier output' }).click();
    });
    await waitFor(() =>
      expect(liveMarkers()[0]?.textContent).toContain('entry-1-'),
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await emit('task_output', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: runId,
      entry_id: 'entry-5-',
      content: entry('entry-5-'),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    vi.useRealTimers();

    const rendered = liveMarkers()[0]?.textContent ?? '';
    expect(rendered.match(/entry-2-/g)).toHaveLength(1);
    expect(rendered).toContain('entry-1-');
    expect(rendered).toContain('entry-5-');
  });

  it('keeps interleaved live tool calls paired with their own results', async () => {
    const request = (name: string) =>
      `\n\n<!-- carapa-tool:request -->\n> **Bash** \`echo ${name}\`\n\n`;
    const result = (name: string) =>
      `\n\n<!-- carapa-tool:result -->\n> ${name} result\n\n`;

    await renderDialog();
    await startSemanticRun('run-interleaved-tools', [
      { id: 'tool_call:A', content: request('A') },
      { id: 'tool_call:B', content: request('B') },
      { id: 'tool_call:A', content: result('A') },
      { id: 'tool_call:B', content: result('B') },
    ]);

    await waitFor(() =>
      expect(
        liveMarkers()[0]?.querySelectorAll('[data-ui="tool-call"]'),
      ).toHaveLength(2),
    );
    expect(useStore.getState().streamingOutputEntries[TASK_ID]).toHaveLength(2);
  });

  it('keeps an oversized live bridge and advances pagination to its start', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const runId = 'run-oversized-bridge';
    const older = 'older-entry';
    const olderEnd = new TextEncoder().encode(older).byteLength;
    const bridge = `bridge-start-${'B'.repeat(PAGED_OLDER_CONTENT_LIMIT)}-bridge-end`;
    await renderDialog();
    await startSemanticRun(runId, [
      { id: 'older-entry', content: older },
      { id: 'oversized-entry', content: bridge },
    ]);
    await waitFor(
      () => expect(liveMarkers()[0]?.textContent).toContain('bridge-end'),
      { timeout: 10_000 },
    );

    const olderPage = {
      content: older,
      nextCursor: 0,
      hasMore: false,
      runId,
      entries: [
        {
          id: 'older-entry',
          content: older,
          startOffset: 0,
          endOffset: olderEnd,
        },
      ],
    };
    server.outputPages = [olderPage];
    await act(async () => {
      screen.getByRole('button', { name: 'Load earlier output' }).click();
    });
    await waitFor(() => expect(liveMarkers()[0]?.textContent).toContain(older));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await emit('task_output', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: runId,
      entry_id: 'new-tail',
      content: 'new-tail',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    vi.useRealTimers();

    const rendered = liveMarkers()[0]?.textContent ?? '';
    expect(rendered).toContain('bridge-start');
    expect(rendered).toContain('bridge-end');
    expect(rendered).toContain('new-tail');
    expect(rendered).not.toContain(older);
    expect(rendered).toContain('Output omitted from the bounded window');
    expect(
      rendered.indexOf('Output omitted from the bounded window'),
    ).toBeLessThan(rendered.indexOf('bridge-start'));

    server.outputPages = [olderPage];
    await act(async () => {
      screen.getByRole('button', { name: 'Load earlier output' }).click();
    });
    expect(server.outputBeforeOffsets.at(-1)).toBe(olderEnd);
    await waitFor(() => expect(liveMarkers()[0]?.textContent).toContain(older));
    const paged = liveMarkers()[0]?.textContent ?? '';
    expect(paged.indexOf(older)).toBeLessThan(paged.indexOf('bridge-start'));
    expect(paged.indexOf('bridge-start')).toBeLessThan(
      paged.indexOf('new-tail'),
    );
    expect(paged).not.toContain('Output omitted from the bounded window');
  }, 30_000);

  it('keeps an exact pagination path when an older whole entry displaces a retained entry', async () => {
    const runId = 'run-entry-window-path';
    const entry = (marker: string) =>
      marker + 'x'.repeat(600_000 - marker.length);
    const first = entry('first-entry-');
    const second = entry('second-entry-');
    const tail = 'live-tail';
    await renderDialog();
    await act(async () => {
      handleWebSocketEvent({
        type: 'task_started',
        payload: {
          project_id: PROJECT_ID,
          task_id: TASK_ID,
          run_id: runId,
        },
      } as never);
      handleWebSocketEvent({
        type: 'task_stream_snapshot',
        payload: {
          project_id: PROJECT_ID,
          task_id: TASK_ID,
          run_id: runId,
          content: tail,
          content_offset: 1_200_000,
          entries: [
            {
              id: 'tail',
              content: tail,
              startOffset: 1_200_000,
              endOffset: 1_200_000 + tail.length,
            },
          ],
        },
      } as never);
      await Promise.resolve();
    });
    await waitFor(() => expect(liveMarkers()[0]?.textContent).toContain(tail));

    const page = (
      id: string,
      content: string,
      startOffset: number,
      hasMore: boolean,
    ) => ({
      content,
      nextCursor: startOffset,
      hasMore,
      runId,
      entries: [
        {
          id,
          content,
          startOffset,
          endOffset: startOffset + 600_000,
        },
      ],
    });
    server.outputPages = [
      page('second', second, 600_000, true),
      page('first', first, 0, false),
      page('second', second, 600_000, true),
    ];

    await act(async () => {
      screen.getByRole('button', { name: 'Load earlier output' }).click();
    });
    await waitFor(() =>
      expect(liveMarkers()[0]?.textContent).toContain('second-entry-'),
    );
    await act(async () => {
      screen.getByRole('button', { name: 'Load earlier output' }).click();
    });
    await waitFor(() =>
      expect(liveMarkers()[0]?.textContent).toContain('first-entry-'),
    );

    const displaced = liveMarkers()[0]?.textContent ?? '';
    expect(displaced).not.toContain('second-entry-');
    expect(displaced.indexOf('first-entry-')).toBeLessThan(
      displaced.indexOf('Output omitted from the bounded window'),
    );
    expect(
      displaced.indexOf('Output omitted from the bounded window'),
    ).toBeLessThan(displaced.indexOf(tail));

    await act(async () => {
      screen.getByRole('button', { name: 'Load earlier output' }).click();
    });
    expect(server.outputBeforeOffsets).toEqual([1_200_000, 600_000, 1_200_000]);
    await waitFor(() =>
      expect(liveMarkers()[0]?.textContent).toContain('second-entry-'),
    );
    const restored = liveMarkers()[0]?.textContent ?? '';
    expect(
      restored.indexOf('Output omitted from the bounded window'),
    ).toBeLessThan(restored.indexOf('second-entry-'));
    expect(restored.indexOf('second-entry-')).toBeLessThan(
      restored.indexOf(tail),
    );
  }, 30_000);

  it('rejects an older page that resolves after the live range jumps twice', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const runId = 'run-stale-page';
    const entry = (marker: string, size = 10_000) =>
      marker + 'x'.repeat(size - marker.length);
    await renderDialog();
    await startSemanticRun(
      runId,
      ['entry-1-', 'entry-2-', 'entry-3-', 'entry-4-'].map((marker) => ({
        id: marker,
        content: entry(marker),
      })),
    );
    await waitFor(() =>
      expect(liveMarkers()[0]?.textContent).toContain('entry-4-'),
    );

    let resolvePage!: (page: {
      content: string;
      nextCursor: number;
      hasMore: boolean;
      runId?: string | null;
    }) => void;
    const promise = new Promise<{
      content: string;
      nextCursor: number;
      hasMore: boolean;
      runId?: string | null;
    }>((resolve) => {
      resolvePage = resolve;
    });
    server.pendingOutputFetch = { promise, resolve: resolvePage };
    await act(async () => {
      screen.getByRole('button', { name: 'Load earlier output' }).click();
      await Promise.resolve();
    });
    expect(server.outputBeforeOffsets.at(-1)).toBe(10_000);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const marker of ['entry-5-', 'entry-6-']) {
      await emit('task_output', {
        project_id: PROJECT_ID,
        task_id: TASK_ID,
        run_id: runId,
        entry_id: marker,
        content: entry(marker, 40_000),
      });
    }
    await act(async () => {
      resolvePage({
        content: 'stale-page-content',
        nextCursor: 0,
        hasMore: false,
        runId,
      });
      await promise;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    vi.useRealTimers();

    const rendered = liveMarkers()[0]?.textContent ?? '';
    expect(rendered).not.toContain('stale-page-content');
    expect(rendered).toContain('Output omitted from the bounded window');
    expect(rendered).toContain('entry-6-');
  });

  it('rejects an output page owned by a different run', async () => {
    const runId = 'run-page-owner';
    const entry = (marker: string) =>
      marker + 'x'.repeat(10_000 - marker.length);
    await renderDialog();
    await startSemanticRun(
      runId,
      ['entry-1-', 'entry-2-', 'entry-3-', 'entry-4-'].map((marker) => ({
        id: marker,
        content: entry(marker),
      })),
    );
    server.outputPages = [
      {
        content: 'wrong-run-page',
        nextCursor: 0,
        hasMore: false,
        runId: 'run-page-owner-stale',
      },
    ];

    await act(async () => {
      screen.getByRole('button', { name: 'Load earlier output' }).click();
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Load earlier output',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(liveMarkers()[0]?.textContent).not.toContain('wrong-run-page');
  });

  it('bootstraps a completed sidecar page when the assistant record is omitted', async () => {
    server.runs = [
      run('run-reloaded-large', 'build', '2026-08-20T00:02:00.000Z'),
    ];
    server.outputPages = [
      { content: 'reloaded-output-tail', nextCursor: 0, hasMore: false },
    ];
    server.messages = [
      message('follow-up', 'A later follow-up', {
        role: 'user',
        created_at: '2026-08-20T00:03:00.000Z',
      }),
    ];

    await renderDialog();
    await waitFor(() =>
      expect(document.body.textContent).toContain('reloaded-output-tail'),
    );
    expect(liveMarkers()).toHaveLength(0);
    expect(
      document.querySelectorAll(
        '[data-ui="task-transcript-message"][data-msg-id^="sidecar-output:"]',
      ),
    ).toHaveLength(1);
    const renderedMessageIds = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-ui="task-transcript-message"]',
      ),
    ).map((node) => node.dataset.msgId);
    expect(
      renderedMessageIds.indexOf('sidecar-output:run-reloaded-large'),
    ).toBe(0);
  });

  it('bootstraps sidecar output for a loaded historical retry run', async () => {
    const historicalRunId = 'run-transient-history';
    const retryRunId = 'run-after-retry';
    server.runs = [
      run(historicalRunId, 'build', '2026-08-20T00:01:00.000Z'),
      run(retryRunId, 'build', '2026-08-20T00:03:00.000Z'),
    ];
    server.messages = [
      {
        ...runStart(historicalRunId),
        created_at: '2026-08-20T00:01:00.000Z',
      },
      message('retry-notice', 'Will retry automatically.', {
        created_at: '2026-08-20T00:02:00.000Z',
      }),
      { ...runStart(retryRunId), created_at: '2026-08-20T00:03:00.000Z' },
      message('retry-result', 'Retry completed.', {
        entry_type: 'run_result',
        run_id: retryRunId,
        created_at: '2026-08-20T00:04:00.000Z',
      }),
    ];
    server.outputPages = [
      {
        content: 'historical durable tool output',
        nextCursor: 0,
        hasMore: false,
        runId: historicalRunId,
      },
      {
        content: 'Retry completed.',
        nextCursor: 0,
        hasMore: false,
        runId: retryRunId,
      },
    ];

    await renderDialog();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        'historical durable tool output',
      ),
    );
    expect(transcriptMarkers(historicalRunId)).toHaveLength(2);
    expect(
      Array.from(transcriptMarkers(historicalRunId)).some(
        (node) =>
          node.getAttribute('data-msg-id') ===
          `sidecar-output:${historicalRunId}`,
      ),
    ).toBe(true);
    expect(transcriptMarkers(retryRunId)).toHaveLength(1);

    server.outputPages = [
      {
        content: 'historical durable tool output',
        nextCursor: 0,
        hasMore: false,
        runId: historicalRunId,
      },
      {
        content: 'Retry completed.',
        nextCursor: 0,
        hasMore: false,
        runId: retryRunId,
      },
    ];
    await startRun('run-current-retry', 'Current retry is streaming.');
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        'historical durable tool output',
      ),
    );
  });

  it('reloads overlapping tool output and a distinct canonical final answer', async () => {
    const runId = 'run-overlapping-final-answer';
    const tool = 'tool output: final answer';
    const canonical = 'final answer';
    server.runs = [run(runId, 'build', '2026-08-20T00:02:00.000Z')];
    server.messages = [
      runStart(runId),
      message('canonical-overlap', canonical, {
        entry_type: 'run_result',
        run_id: runId,
      }),
    ];
    server.outputPages = [
      {
        content: tool + canonical,
        nextCursor: 0,
        hasMore: false,
        total: tool.length + canonical.length,
        runId,
        entries: [
          {
            id: 'tool:one',
            content: tool,
            startOffset: 0,
            endOffset: tool.length,
          },
          {
            id: 'message:canonical-overlap',
            content: canonical,
            startOffset: tool.length,
            endOffset: tool.length + canonical.length,
          },
        ],
      },
    ];

    await renderDialog();
    await waitFor(() =>
      expect(transcriptMarkers(runId)[0]?.textContent).toContain(tool),
    );
    const rendered = transcriptMarkers(runId)[0]?.textContent ?? '';
    expect(rendered.match(/final answer/g)).toHaveLength(2);
    expect(rendered.indexOf(tool)).toBeLessThan(
      rendered.lastIndexOf(canonical),
    );
  });

  it('loads older output on the first click at the page boundary', async () => {
    const canonical = 'C'.repeat(32 * 1024);
    const older = `tool-entry-start-${'O'.repeat(40_000)}-tool-entry-end`;
    server.runs = [run('run-boundary', 'build', '2026-08-20T00:04:00.000Z')];
    server.outputPages = [
      { content: canonical, nextCursor: 12, hasMore: true },
      { content: older, nextCursor: 0, hasMore: false },
    ];
    server.messages = [
      runStart('run-boundary'),
      message('boundary-result', canonical, {
        entry_type: 'run_result',
        run_id: 'run-boundary',
      }),
    ];

    await renderDialog();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Load earlier output' }),
      ).toBeTruthy(),
    );
    await act(async () => {
      screen.getByRole('button', { name: 'Load earlier output' }).click();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain('tool-entry-end'),
    );
    expect(document.body.textContent).toContain('tool-entry-start');
    expect(document.body.textContent).not.toContain(
      'Output omitted from the bounded window',
    );
  }, 30_000);

  it('replaces one finished live response with one saved assistant renderer', async () => {
    await renderDialog();
    await startRun('run-single', 'The final answer');

    server.messages = [
      runStart('run-single'),
      message('01', 'The final answer'),
    ];
    await emit('task_message', { project_id: PROJECT_ID, task_id: TASK_ID });
    await waitFor(() =>
      expect(transcriptMarkers('run-single')).toHaveLength(1),
    );
    expect(liveMarkers()).toHaveLength(1);

    await emit('run_finished', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-single',
    });

    await waitFor(() => expect(liveMarkers()).toHaveLength(0));
    expect(transcriptMarkers('run-single')).toHaveLength(1);
  });

  it('hands a tool-heavy live stream to a different canonical run result', async () => {
    await renderDialog();
    await startRun(
      'run-canonical',
      'Bash tests\nTool output that does not resemble the final answer',
    );

    server.messages = [
      runStart('run-canonical'),
      message('canonical-answer', 'Implemented and verified the fix.', {
        entry_type: 'run_result',
        run_id: 'run-canonical',
      }),
    ];
    await emit('task_message', { project_id: PROJECT_ID, task_id: TASK_ID });
    await emit('run_finished', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-canonical',
    });

    await waitFor(() => expect(liveMarkers()).toHaveLength(0));
    expect(transcriptMarkers('run-canonical')).toHaveLength(1);
    expect(transcriptMarkers('run-canonical')[0]?.textContent).toContain(
      'Implemented and verified the fix.',
    );
  });

  it('clears the superseded Testing stream before rendering repair evidence', async () => {
    await renderDialog();
    await startRun(
      'run-testing-original',
      'Bash validation output\nFocused validation found one regression.\n{"decision":"fail"}',
    );

    server.messages = [
      runStart('run-testing-original'),
      message(
        'original-evidence',
        'Bash validation output\nFocused validation found one regression.',
        {
          run_id: 'run-testing-original',
        },
      ),
      runStart('run-testing-repair'),
      message('repair-evidence', 'Repair inspection completed.', {
        run_id: 'run-testing-repair',
      }),
      message(
        'testing-outcome',
        '**Testing failed**\n\nvalidation found one regression',
        {
          role: 'system',
          entry_type: 'testing_feedback',
        },
      ),
    ];
    await emit('task_message', { project_id: PROJECT_ID, task_id: TASK_ID });
    expect(liveMarkers()).toHaveLength(1);

    await emit('task_output_clear', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      force: true,
    });

    await waitFor(() => expect(liveMarkers()).toHaveLength(0));
    const transcript = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-ui="task-transcript-message"]',
      ),
    );
    expect(transcript.map((node) => node.dataset.runId)).toEqual([
      'run-testing-original',
      'run-testing-repair',
      'run-testing-repair',
    ]);
    expect(transcript[0]?.textContent).toContain(
      'Focused validation found one regression.',
    );
    expect(transcript[1]?.textContent).toContain(
      'Repair inspection completed.',
    );
    expect(transcript[2]?.textContent).toContain('Testing failed');
    expect(transcript[2]?.textContent).toContain(
      'validation found one regression',
    );
    expect(document.body.textContent).not.toContain('"decision"');

    act(() => useStore.getState().setDetailTaskId(null));
    await waitFor(() =>
      expect(document.querySelector('[data-ui="task-tab-content"]')).toBeNull(),
    );

    act(() => useStore.getState().setDetailTaskId(TASK_ID));
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-ui="task-transcript-message"]'),
      ).toHaveLength(3),
    );
    const reopenedTranscript = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-ui="task-transcript-message"]',
      ),
    );
    expect(reopenedTranscript.map((node) => node.dataset.runId)).toEqual([
      'run-testing-original',
      'run-testing-repair',
      'run-testing-repair',
    ]);
    expect(document.body.textContent).not.toContain('"decision"');
  });

  it('retires the live renderer when a finished run spans text and tool entries', async () => {
    await renderDialog();
    await startRun(
      'run-split',
      'Checked the workspace.\nBash result: tests passed.\nShipped the fix.',
    );

    server.messages = [
      runStart('run-split'),
      message('02', 'Checked the workspace.'),
      message('03', 'Bash result: tests passed.'),
      message('04', 'Shipped the fix.'),
    ];
    await emit('task_message', { project_id: PROJECT_ID, task_id: TASK_ID });
    await waitFor(() => expect(transcriptMarkers('run-split')).toHaveLength(3));
    expect(liveMarkers()).toHaveLength(1);

    await emit('task_output_clear', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
    });
    expect(liveMarkers()).toHaveLength(1);

    await emit('run_finished', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-split',
    });

    await waitFor(() => expect(transcriptMarkers('run-split')).toHaveLength(3));
    expect(liveMarkers()).toHaveLength(0);
  });

  it('retires a finished run when its run-start marker is outside the loaded transcript page', async () => {
    await renderDialog();
    await startRun(
      'run-paginated',
      'Checked the workspace.\nBash result: focused tests passed.\nCompleted the implementation.',
    );

    // The API paginates by conversational turn. Enough question/answer turns
    // within one run can leave its run_start on an older page while the newest
    // page contains only persisted entries from the tail of that exact run.
    server.messages = [
      message('paginated-check', 'Checked the workspace.'),
      message('paginated-tool', 'Bash result: focused tests passed.'),
      message('paginated-answer', 'Completed the implementation.'),
    ];
    server.hasMore = true;

    await emit('run_finished', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-paginated',
    });

    await waitFor(() =>
      expect(
        document.querySelectorAll(
          `[data-ui="task-transcript-message"][data-task-id="${TASK_ID}"]`,
        ),
      ).toHaveLength(3),
    );
    expect(liveMarkers()).toHaveLength(0);
    expect(
      document.querySelector(
        '[data-ui="task-run-divider"][data-run-id="run-paginated"]',
      ),
    ).toBeNull();
  });

  it('keeps a paginated finished stream until a delayed final refetch covers it', async () => {
    await renderDialog();
    await startRun('run-paginated-delayed', 'First checkpoint.');

    // The run_start is on an older page, and this entry is only an
    // intermediate prefix of the response that the live renderer will retain.
    // An older identical answer must not count when it is not the loaded tail.
    server.messages = [
      message('older-run-answer', 'First checkpoint. Later final output.'),
      message('paginated-checkpoint', 'First checkpoint.'),
    ];
    server.hasMore = true;
    await emit('task_message', { project_id: PROJECT_ID, task_id: TASK_ID });
    await waitFor(() =>
      expect(
        document.querySelectorAll(
          `[data-ui="task-transcript-message"][data-task-id="${TASK_ID}"]`,
        ),
      ).toHaveLength(2),
    );

    await emit('task_output', {
      task_id: TASK_ID,
      content: ' Later final output.',
    });
    await waitFor(() =>
      expect(liveMarkers()[0]?.textContent).toContain('Later final output.'),
    );

    let resolveFetch!: () => void;
    const promise = new Promise<ReturnType<typeof messagesPage>>((resolve) => {
      resolveFetch = () => resolve(messagesPage());
    });
    server.pendingMessagesFetch = { promise, resolve: resolveFetch };
    await emit('run_finished', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-paginated-delayed',
    });
    expect(liveMarkers()).toHaveLength(1);

    // The finish-triggered request settles with the same intermediate page.
    // Exact run readiness alone must not retire unpersisted later output.
    server.pendingMessagesFetch = null;
    await act(async () => resolveFetch());
    await waitFor(() =>
      expect(useStore.getState().readyTaskTranscriptRunIds[TASK_ID]).toBe(
        'run-paginated-delayed',
      ),
    );
    expect(liveMarkers()).toHaveLength(1);
    expect(liveMarkers()[0]?.textContent).toContain('Later final output.');

    server.messages = [
      message('older-run-answer', 'First checkpoint. Later final output.'),
      message('paginated-checkpoint', 'First checkpoint.'),
      message('paginated-final', 'Later final output.'),
    ];
    await emit('task_message', { project_id: PROJECT_ID, task_id: TASK_ID });

    await waitFor(() => expect(liveMarkers()).toHaveLength(0));
    expect(
      document.querySelectorAll(
        `[data-ui="task-transcript-message"][data-task-id="${TASK_ID}"]`,
      ),
    ).toHaveLength(3);
  });

  it('survives the production message, output-clear, finish order until the transcript refetch resolves', async () => {
    await renderDialog();
    await startRun('run-production-order', 'Persisted after transport clear');
    server.messages = [
      runStart('run-production-order'),
      message('production-order-answer', 'Persisted after transport clear'),
    ];

    let resolveFetch!: () => void;
    const promise = new Promise<ReturnType<typeof messagesPage>>((resolve) => {
      resolveFetch = () => resolve(messagesPage());
    });
    server.pendingMessagesFetch = { promise, resolve: resolveFetch };

    await emit('task_message', { project_id: PROJECT_ID, task_id: TASK_ID });
    await emit('task_output_clear', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
    });
    expect(liveMarkers()).toHaveLength(1);
    expect(transcriptMarkers('run-production-order')).toHaveLength(0);

    await emit('run_finished', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-production-order',
    });
    expect(liveMarkers()).toHaveLength(1);
    expect(transcriptMarkers('run-production-order')).toHaveLength(0);

    server.pendingMessagesFetch = null;
    await act(async () => resolveFetch());
    await waitFor(() =>
      expect(transcriptMarkers('run-production-order')).toHaveLength(1),
    );
    expect(liveMarkers()).toHaveLength(0);
  });

  it('keeps later live output after finish while an intermediate transcript awaits final refetch', async () => {
    await renderDialog();
    await startRun('run-intermediate-delayed', 'First checkpoint.');

    server.messages = [
      runStart('run-intermediate-delayed'),
      message('07', 'First checkpoint.'),
    ];
    await emit('task_message', { project_id: PROJECT_ID, task_id: TASK_ID });
    await waitFor(() =>
      expect(transcriptMarkers('run-intermediate-delayed')).toHaveLength(1),
    );

    await emit('task_output', {
      task_id: TASK_ID,
      content: ' Later output not persisted yet.',
    });
    await waitFor(() =>
      expect(liveMarkers()[0]?.textContent).toContain(
        'Later output not persisted yet.',
      ),
    );

    let resolveFetch!: () => void;
    const promise = new Promise<ReturnType<typeof messagesPage>>((resolve) => {
      resolveFetch = () => resolve(messagesPage());
    });
    server.pendingMessagesFetch = { promise, resolve: resolveFetch };
    await emit('run_finished', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-intermediate-delayed',
    });

    expect(liveMarkers()).toHaveLength(1);
    expect(liveMarkers()[0]?.textContent).toContain(
      'Later output not persisted yet.',
    );

    server.messages = [
      runStart('run-intermediate-delayed'),
      message('07', 'First checkpoint.'),
      message('08', 'Later output not persisted yet.'),
    ];
    server.pendingMessagesFetch = null;
    await act(async () => resolveFetch());

    await waitFor(() =>
      expect(transcriptMarkers('run-intermediate-delayed')).toHaveLength(2),
    );
    expect(liveMarkers()).toHaveLength(0);
  });

  it('gives a newer run fresh ownership and ignores the older finish', async () => {
    await renderDialog();
    await startRun('run-old', 'Old answer');
    server.messages = [runStart('run-old'), message('09', 'Old answer')];
    await emit('run_finished', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-old',
    });
    await waitFor(() => expect(liveMarkers()).toHaveLength(0));

    await emit('task_started', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-new',
    });
    expect(liveMarkers()).toHaveLength(0);

    await emit('task_output', {
      task_id: TASK_ID,
      run_id: 'run-new',
      content: 'Fresh answer',
    });
    await waitFor(() => expect(liveMarkers()).toHaveLength(1));
    expect(liveMarkers()[0]?.getAttribute('data-run-id')).toBe('run-new');
    expect(liveMarkers()[0]?.textContent).toContain('Fresh answer');

    await emit('run_finished', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-old',
    });
    expect(liveMarkers()).toHaveLength(1);
    expect(liveMarkers()[0]?.getAttribute('data-run-id')).toBe('run-new');
  });

  it('ignores delayed output from a previous run owner', async () => {
    await renderDialog();
    await startRun('run-old-owner', 'old output');
    await emit('task_started', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-new-owner',
    });
    await emit('task_output', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-old-owner',
      content: ' delayed old output',
    });
    await emit('task_output', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-new-owner',
      content: ' fresh new output',
    });
    await waitFor(() =>
      expect(liveMarkers()[0]?.textContent).toContain('fresh new output'),
    );
    expect(liveMarkers()[0]?.textContent).not.toContain('delayed old output');
    await emit('task_output_clear', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
    });
    expect(liveMarkers()).toHaveLength(1);
    expect(liveMarkers()[0]?.getAttribute('data-run-id')).toBe('run-new-owner');
  });
  it('retains consecutive identical chunks from the active run', async () => {
    await renderDialog();
    await startRun('run-repeated-chunks', 'same');
    await emit('task_output', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      run_id: 'run-repeated-chunks',
      content: 'same',
    });
    await waitFor(() =>
      expect(liveMarkers()[0]?.textContent).toContain('samesame'),
    );
  });
  it('keeps the composer beside Stop and reports steering delivery', async () => {
    server.running = true;
    await renderDialog();
    // The header's task-title textarea precedes the composer in the DOM.
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(
      /^(Describe the task|Follow-up message)/,
    );
    expect(composer).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    fireEvent.change(composer!, { target: { value: 'Check this now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-ui="task-steering-delivery"][data-message-id="steered-user"][data-steering-status="steered"]',
        ),
      ).toBeTruthy(),
    );
    expect(server.taskMessageRequests).toEqual([
      {
        url: `/api/projects/${PROJECT_ID}/tasks/${TASK_ID}/messages`,
        method: 'POST',
        body: { content: 'Check this now', steer: true },
      },
    ]);
    expect(screen.getByText('Check this now')).toBeTruthy();
  });

  it('sends an empty-transcript queued claim through task steering', async () => {
    server.queued = true;
    server.messageDelivery = 'queued';
    await renderDialog();
    // The header's task-title textarea precedes the composer in the DOM.
    const composer = screen.getByPlaceholderText<HTMLTextAreaElement>(
      /^(Describe the task|Follow-up message)/,
    );
    expect(composer).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull();

    fireEvent.change(composer!, {
      target: { value: 'Use this before launch' },
    });
    fireEvent.keyDown(composer!, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(server.taskMessageRequests).toHaveLength(1));
    expect(server.taskMessageRequests[0]).toEqual({
      url: `/api/projects/${PROJECT_ID}/tasks/${TASK_ID}/messages`,
      method: 'POST',
      body: { content: 'Use this before launch', steer: true },
    });
    expect(screen.getByText('Use this before launch')).toBeTruthy();
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-ui="task-steering-delivery"][data-message-id="steered-user"][data-steering-status="queued"]',
        ),
      ).toBeTruthy(),
    );
  });

  it('reconstructs delivery from the canonical message and updates its receipt state', async () => {
    server.messages = [
      message('durable-steering', 'Persisted steering prompt', {
        role: 'user',
        steering: true,
        steeringDelivery: 'queued',
      }),
    ];
    await renderDialog();

    const messageSelector =
      '[data-ui="task-transcript-message"][data-msg-id="durable-steering"]';
    await waitFor(() => {
      expect(document.querySelectorAll(messageSelector)).toHaveLength(1);
      expect(
        document.querySelector(
          '[data-ui="task-steering-delivery"][data-message-id="durable-steering"][data-steering-status="queued"]',
        ),
      ).toBeTruthy();
    });

    server.messages = [
      message('durable-steering', 'Persisted steering prompt', {
        role: 'user',
        steering: true,
        steeringDelivery: 'steered',
      }),
    ];
    await emit('task_message', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      message: message('durable-receipt', '', {
        role: 'system',
        entry_type: 'steering_delivery',
        prompt_id: 'durable-steering',
        run_id: 'run-active',
      }),
    });

    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-ui="task-steering-delivery"][data-message-id="durable-steering"][data-steering-status="steered"]',
        ),
      ).toBeTruthy(),
    );
    expect(document.querySelectorAll(messageSelector)).toHaveLength(1);
    expect(
      document.querySelector(
        '[data-ui="task-steering-delivery"][data-message-id="durable-steering"][data-steering-status="queued"]',
      ),
    ).toBeNull();
  });
});
