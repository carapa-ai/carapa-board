// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { mock as nodeMock } from 'node:test';
import { afterEach, afterAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { authenticatedApplicationWebSocketUrl } from './websocket-auth';

const invalidations: unknown[][] = [];
const taskCache = new Map<string, unknown>();
const activeTranscriptQueries = new Set<string>();
let ticketRequests = 0;
// When non-null, the mocked /health endpoint reports this process start time.
let healthStartedAt: number | null = null;
let nativeAppStateListener: ((state: { isActive: boolean }) => void) | null =
  null;
const realQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const queryClient = {
  getQueryData: (queryKey: unknown[]) =>
    taskCache.get(JSON.stringify(queryKey)),
  getQueryCache: () => ({
    find: ({ queryKey }: { queryKey: unknown[] }) =>
      activeTranscriptQueries.has(JSON.stringify(queryKey))
        ? { getObserversCount: () => 1, state: { fetchStatus: 'fetching' } }
        : undefined,
  }),
  setQueryData: (queryKey: unknown[], updater: unknown) => {
    const key = JSON.stringify(queryKey);
    const old = taskCache.get(key);
    taskCache.set(key, typeof updater === 'function' ? updater(old) : updater);
  },
  setQueriesData: (
    { predicate }: { predicate: (query: { queryKey: unknown[] }) => boolean },
    updater: (old: unknown) => unknown,
  ) => {
    for (const [key, old] of taskCache) {
      const queryKey = JSON.parse(key);
      if (predicate({ queryKey })) taskCache.set(key, updater(old));
    }
  },
  removeQueries: ({
    predicate,
  }: {
    predicate: (query: { queryKey: unknown[] }) => boolean;
  }) => {
    for (const key of [...taskCache.keys()]) {
      const queryKey = JSON.parse(key);
      if (predicate({ queryKey })) taskCache.delete(key);
    }
  },
  invalidateQueries: ({ queryKey }: { queryKey: unknown[] }) => {
    invalidations.push(queryKey);
    return realQueryClient.invalidateQueries({ queryKey });
  },
  refetchQueries: ({ queryKey }: { queryKey: unknown[] }) => {
    invalidations.push(queryKey);
    return realQueryClient.refetchQueries({ queryKey });
  },
};

class TestWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = TestWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static instances: TestWebSocket[] = [];
  static nextOpened: (() => void) | null = null;
  closed = false;

  constructor(_url: string) {
    TestWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = TestWebSocket.OPEN;
      this.onopen?.();
      TestWebSocket.nextOpened?.();
      TestWebSocket.nextOpened = null;
    });
  }

  close() {
    this.closed = true;
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }

  receive(type: string, payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ type, payload }) });
  }
}

function socketOpened(): Promise<void> {
  return new Promise((resolve) => {
    TestWebSocket.nextOpened = resolve;
  });
}

async function connectAndOpen(options?: { force?: boolean }) {
  const alreadyOpen =
    !options?.force &&
    TestWebSocket.instances.at(-1)?.readyState === TestWebSocket.OPEN;
  const opened = alreadyOpen ? Promise.resolve() : socketOpened();
  connectWebSocket(queryClient, options);
  await opened;
}

function queryReachesStatus(
  observer: QueryObserver,
  status: string,
): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = observer.subscribe((result) => {
      if (result.data?.status === status) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function outputCleared(streamKey: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = actualUseStore.subscribe((state) => {
      if (state.chatStreamingOutput[streamKey] === '') {
        unsubscribe();
        resolve();
      }
    });
  });
}

const storageValues = new Map<string, string>();
const testStorage = {
  get length() {
    return storageValues.size;
  },
  clear: () => storageValues.clear(),
  getItem: (key: string) => storageValues.get(key) ?? null,
  key: (index: number) => [...storageValues.keys()][index] ?? null,
  removeItem: (key: string) => storageValues.delete(key),
  setItem: (key: string, value: string) => storageValues.set(key, value),
};

const testWindow = Object.assign(new EventTarget(), {
  location: {
    protocol: 'https:',
    host: 'board.test',
    hostname: 'board.test',
  },
});
const testDocument = Object.assign(new EventTarget(), {
  visibilityState: 'visible',
});

class TestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

Object.assign(globalThis, {
  WebSocket: TestWebSocket,
  window: testWindow,
  localStorage: testStorage,
});

const { useStore: actualUseStore } = await import('@/store');

mock.module('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
}));
mock.module('@capacitor/app', () => ({
  App: {
    addListener: async (
      _event: string,
      listener: typeof nativeAppStateListener,
    ) => {
      nativeAppStateListener = listener;
      return {
        remove: async () => {
          nativeAppStateListener = null;
        },
      };
    },
  },
}));
mock.module('./api', () => ({
  ApiError: TestApiError,
  apiFetch: async (url: string) => {
    if (url.endsWith('/api/ws-ticket')) ticketRequests += 1;
    if (url.endsWith('/health') && healthStartedAt !== null) {
      return new Response(
        JSON.stringify({ status: 'ok', started_at: healthStartedAt }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ticket: 'ticket' }), { status: 200 });
  },
  sendChatMessage: async () => {},
  startPersonaLiveQueueItem: async () => {},
}));
mock.module('@/store', () => ({
  useStore: actualUseStore,
}));
mock.module('./push-bridge', () => ({
  activateNativeSpeechSession: async () => {},
  attachNativeSpeechPlaybackListener: async () => {},
  dismissNativeNotification: async () => {},
  enqueueNativeSpeech: async () => {},
  stopNativeSpeech: async () => {},
}));
mock.module('./use-tts', () => ({
  cutOffLiveSpeechForServerStop: () => {},
  enqueueLiveReply: () => {},
  enqueueLiveSpeech: () => {},
  getLiveSpeechState: () => ({}),
  prefetchLiveReply: () => {},
  setLiveSpeechFocus: () => {},
  subscribeLiveSpeech: () => () => {},
}));
mock.module('./live-persona-reveal', () => ({
  beginLivePersonaReveal: () => {},
  bufferLivePersonaChunk: () => {},
  clearLivePersonaReveal: () => {},
  getLivePersonaRevealState: () => ({}),
  markLivePersonaPlaybackStarted: () => {},
  markLivePersonaSynthesizing: () => {},
  markLivePersonaThinking: () => {},
  replaceLivePersonaBuffer: () => {},
  releaseLivePersonaReveal: () => {},
}));
mock.module('./live-speech-protocol', () => ({
  speechForLiveActivity: () => '',
}));
mock.module('./session-vault', () => ({ vaultPopulate: () => {} }));
// NOTE: do NOT mock './chat-stream-reconciliation' here. Bun's mock.module is
// process-global and would leak into later files (chat-stream-reconciliation
// .test.ts) in a shared `bun test` run. The real implementation is a pure
// function, so the websocket tests can use it directly.
mock.module('./android-ota', () => ({
  ANDROID_OTA_AVAILABLE_EVENT: 'android-ota-available',
}));

const {
  connectWebSocket,
  disconnectWebSocket,
  handleWebSocketConnected,
  handleWebSocketEvent,
} = await import('./websocket');
const { installWebSocketRecoveryListeners } =
  await import('./websocket-lifecycle');
Object.assign(globalThis, { document: testDocument });

afterEach(() => nodeMock.timers.reset());

afterAll(() => {
  disconnectWebSocket();
  mock.restore();
});

describe('connectWebSocket native origin selection', () => {
  test('reconciles task lists and full-task records when an agent description update arrives', () => {
    disconnectWebSocket();
    connectWebSocket(queryClient);
    invalidations.length = 0;
    taskCache.clear();
    const project_id = 'project-desc-sync';
    const task1 = {
      id: 'task-1',
      project_id,
      description: 'Old agent description',
    };
    const task2 = {
      id: 'task-2',
      project_id,
      description: 'Unrelated description',
    };
    taskCache.set(JSON.stringify(['tasks', project_id]), [task1, task2]);
    taskCache.set(JSON.stringify(['tasks', project_id, 'owner-1', '']), [
      task1,
      task2,
    ]);
    taskCache.set(JSON.stringify(['tasks', 'project-other']), [
      { id: 'task-x', project_id: 'project-other', description: 'Foreign' },
    ]);
    taskCache.set(JSON.stringify(['fullTask', project_id, 'task-1']), {
      id: 'task-1',
      description: 'Old agent description',
    });
    taskCache.set(JSON.stringify(['fullTask', project_id, 'task-2']), {
      id: 'task-2',
      description: 'Unrelated description',
    });

    handleWebSocketEvent({
      type: 'task_updated',
      payload: {
        id: 'task-1',
        project_id,
        description: 'Updated agent description',
      },
    });

    const descriptionOf = (cache: Map<string, unknown>, key: unknown[]) => {
      const list = (cache.get(JSON.stringify(key)) ?? []) as Array<
        Record<string, unknown>
      >;
      const byId = (taskId: string) => list.find((task) => task.id === taskId);
      return {
        task1: byId('task-1')?.description,
        task2: byId('task-2')?.description,
      };
    };

    // Both the plain and the filtered task-list caches show the change...
    for (const listKey of [
      ['tasks', project_id],
      ['tasks', project_id, 'owner-1', ''],
    ]) {
      const { task1, task2 } = descriptionOf(taskCache, listKey);
      expect(task1).toBe('Updated agent description');
      // ...while the sibling task keeps its own description.
      expect(task2).toBe('Unrelated description');
    }
    // Other projects are left untouched.
    expect(taskCache.get(JSON.stringify(['tasks', 'project-other']))).toEqual([
      { id: 'task-x', project_id: 'project-other', description: 'Foreign' },
    ]);
    // The full-task record is reconciled in place; the sibling task's
    // full record is untouched.
    expect(
      taskCache.get(JSON.stringify(['fullTask', project_id, 'task-1'])),
    ).toEqual({ id: 'task-1', description: 'Updated agent description' });
    expect(
      taskCache.get(JSON.stringify(['fullTask', project_id, 'task-2'])),
    ).toEqual({ id: 'task-2', description: 'Unrelated description' });
    // Existing lifecycle invalidation behavior is preserved, and the
    // full-task cache is invalidated so it cannot stay permanently stale.
    expect(invalidations).toContainEqual(['tasks', project_id]);
    expect(invalidations).toContainEqual(['attention']);
    expect(invalidations).toContainEqual(['taskDiff', project_id, 'task-1']);
    expect(invalidations).toContainEqual(['fullTask', project_id, 'task-1']);
  });

  test('refreshes cached chat transcripts after reconnect', () => {
    invalidations.length = 0;
    handleWebSocketConnected();
    expect(invalidations).toContainEqual(['chatTranscript']);
  });
  test('reconnect clears stale live task flags, refetches tasks, and replay re-marks running tasks', () => {
    const taskId = 'task-stale-live';
    const projectId = 'project-stale-live';
    actualUseStore.getState().markTaskLive(taskId);
    invalidations.length = 0;

    handleWebSocketConnected();

    expect(actualUseStore.getState().liveTaskIds[taskId]).toBeUndefined();
    expect(invalidations).toContainEqual(['tasks']);

    handleWebSocketEvent({
      type: 'task_started',
      payload: { project_id: projectId, task_id: taskId, run_id: 'run-1' },
    });
    expect(actualUseStore.getState().liveTaskIds[taskId]).toBe(true);
  });

  test('preserves ready state across same-process reconnects and clears it for a new process', async () => {
    disconnectWebSocket();
    await connectAndOpen();
    let authoritativeStatus = 'ready';
    const observer = new QueryObserver(realQueryClient, {
      queryKey: ['admin', 'server-web-build'],
      queryFn: async () => ({ status: authoritativeStatus }),
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    expect(realQueryClient.getQueryData(['admin', 'server-web-build'])).toEqual(
      { status: 'ready' },
    );
    // Drop the invalidations from the initial connect so the handshake
    // assertions below only observe the server_restarted handling.
    invalidations.length = 0;
    handleWebSocketEvent({
      type: 'server_restarted',
      payload: { started_at: 100 },
    });
    handleWebSocketEvent({
      type: 'server_restarted',
      payload: { started_at: 100 },
    });
    // A handshake that proves the client reconnected to the same server
    // process must not invalidate the cached ready build state.
    expect(invalidations).not.toContainEqual(['admin', 'server-web-build']);
    expect(realQueryClient.getQueryData(['admin', 'server-web-build'])).toEqual(
      { status: 'ready' },
    );

    const idle = queryReachesStatus(observer, 'idle');
    authoritativeStatus = 'idle';
    handleWebSocketEvent({
      type: 'server_restarted',
      payload: { started_at: 200 },
    });
    expect(invalidations).toContainEqual(['admin', 'server-web-build']);
    await idle;
    expect(realQueryClient.getQueryData(['admin', 'server-web-build'])).toEqual(
      { status: 'idle' },
    );
    unsubscribe();
  });

  test('health poll clears the cached ready build state when the process changed', async () => {
    disconnectWebSocket();
    invalidations.length = 0;
    healthStartedAt = 100;
    process.env.VITE_HEALTH_POLL_INTERVAL_MS = '20';
    nodeMock.timers.enable({ apis: ['setInterval'] });
    try {
      await connectAndOpen();
      handleWebSocketEvent({
        type: 'server_restarted',
        payload: { started_at: 100 },
      });

      let authoritativeStatus = 'ready';
      const observer = new QueryObserver(realQueryClient, {
        queryKey: ['admin', 'server-web-build'],
        queryFn: async () => ({ status: authoritativeStatus }),
      });
      const unsubscribe = observer.subscribe(() => {});
      await observer.refetch();
      expect(
        realQueryClient.getQueryData(['admin', 'server-web-build']),
      ).toEqual({ status: 'ready' });

      // The backend restarted while the socket stayed dead — the exact case
      // the health poll exists for. The new process has no ready build.
      const idle = queryReachesStatus(observer, 'idle');
      const reconnected = socketOpened();
      authoritativeStatus = 'idle';
      healthStartedAt = 200;
      nodeMock.timers.tick(20);
      await Promise.all([idle, reconnected]);

      expect(invalidations).toContainEqual(['admin', 'server-web-build']);
      expect(
        realQueryClient.getQueryData(['admin', 'server-web-build']),
      ).toEqual({ status: 'idle' });
      unsubscribe();
    } finally {
      delete process.env.VITE_HEALTH_POLL_INTERVAL_MS;
      healthStartedAt = null;
      disconnectWebSocket();
    }
  });

  test('run-finished clears the live task and refetches its waiting projection', async () => {
    invalidations.length = 0;
    taskCache.clear();
    await connectAndOpen();
    invalidations.length = 0;
    const store = actualUseStore.getState();
    store.markTaskLive('task-stage-handoff');
    const filteredKey = ['tasks', 'project-stage-handoff', '', ''];
    taskCache.set(JSON.stringify(filteredKey), [
      { id: 'task-stage-handoff', running: true, waiting: false },
    ]);

    handleWebSocketEvent({
      type: 'run_finished',
      payload: {
        project_id: 'project-stage-handoff',
        task_id: 'task-stage-handoff',
        run_id: 'run-old',
      },
    });

    expect(actualUseStore.getState().liveTaskIds['task-stage-handoff']).toBe(
      undefined,
    );
    expect(invalidations).toContainEqual(['tasks', 'project-stage-handoff']);
    expect(taskCache.get(JSON.stringify(filteredKey))).toEqual([
      { id: 'task-stage-handoff', running: false, waiting: false },
    ]);

    handleWebSocketEvent({
      type: 'task_started',
      payload: {
        project_id: 'project-stage-handoff',
        task_id: 'task-stage-handoff',
      },
    });
    expect(actualUseStore.getState().liveTaskIds['task-stage-handoff']).toBe(
      true,
    );
    expect(taskCache.get(JSON.stringify(filteredKey))).toEqual([
      {
        id: 'task-stage-handoff',
        running: true,
        phase: 'running',
        waiting: false,
      },
    ]);
  });

  test('ignores an old run-finished after a newer task_started', () => {
    const taskId = 'task-run-ordering';
    const projectId = 'project-run-ordering';
    const filteredKey = ['tasks', projectId, '', ''];
    taskCache.set(JSON.stringify(filteredKey), [
      { id: taskId, running: true, waiting: false },
    ]);
    const store = actualUseStore.getState();
    store.markTaskLive(taskId);

    handleWebSocketEvent({
      type: 'task_started',
      payload: { project_id: projectId, task_id: taskId, run_id: 'new' },
    });
    handleWebSocketEvent({
      type: 'run_finished',
      payload: { project_id: projectId, task_id: taskId, run_id: 'old' },
    });

    expect(actualUseStore.getState().liveTaskIds[taskId]).toBe(true);
    expect(taskCache.get(JSON.stringify(filteredKey))).toEqual([
      { id: taskId, running: true, phase: 'running', waiting: false },
    ]);
  });

  test('foreground lifecycle performs one authenticated replacement and authoritative replay', async () => {
    disconnectWebSocket();
    TestWebSocket.instances.length = 0;
    ticketRequests = 0;
    let unlocked = true;
    await connectAndOpen();
    const staleSocket = TestWebSocket.instances[0];
    const store = actualUseStore.getState();
    store.setActiveStreamKeyForConv('recovery-conv', 'recovery-run');
    store.setChatRunning('recovery-conv', true);
    store.setChatOutput('recovery-run', 'partial');

    nodeMock.timers.enable({ apis: ['setTimeout'] });
    const cleanup = installWebSocketRecoveryListeners(
      () => connectWebSocket(queryClient, { force: true }),
      () => unlocked,
    );
    await Promise.resolve();
    const recovered = socketOpened();
    nativeAppStateListener?.({ isActive: true });
    testWindow.dispatchEvent(new Event('online'));
    nodeMock.timers.tick(0);
    await recovered;

    expect(staleSocket.closed).toBe(true);
    expect(TestWebSocket.instances).toHaveLength(2);
    expect(ticketRequests).toBe(2);
    const recoveredSocket = TestWebSocket.instances[1];
    recoveredSocket.receive('chat_started', {
      folder: 'project',
      conversation_id: 'recovery-conv',
      streamKey: 'recovery-run',
    });
    recoveredSocket.receive('chat_stream_snapshot', {
      folder: 'project',
      conversation_id: 'recovery-conv',
      streamKey: 'recovery-run',
      content: 'complete snapshot',
    });
    recoveredSocket.receive('chat_replay_complete', {
      activeConversationIds: ['recovery-conv'],
    });
    recoveredSocket.receive('chat_output', {
      conversation_id: 'recovery-conv',
      streamKey: 'recovery-run',
      content: ' next',
    });
    recoveredSocket.receive('chat_output', {
      conversation_id: 'recovery-conv',
      streamKey: 'recovery-run',
      content: ' next',
    });

    expect(actualUseStore.getState().chatStreamingOutput['recovery-run']).toBe(
      'complete snapshot next',
    );
    expect(actualUseStore.getState().chatRunningByConv['recovery-conv']).toBe(
      true,
    );

    unlocked = false;
    cleanup();
    const lockedCleanup = installWebSocketRecoveryListeners(
      () => connectWebSocket(queryClient, { force: true }),
      () => unlocked,
    );
    await Promise.resolve();
    nativeAppStateListener?.({ isActive: true });
    nodeMock.timers.tick(0);
    expect(ticketRequests).toBe(2);
    expect(TestWebSocket.instances).toHaveLength(2);
    lockedCleanup();
  });

  test('foreground lifecycle retires a run completed while suspended', async () => {
    disconnectWebSocket();
    TestWebSocket.instances.length = 0;
    ticketRequests = 0;
    invalidations.length = 0;
    await connectAndOpen();
    const store = actualUseStore.getState();
    store.setActiveStreamKeyForConv(
      'completed-away-conv',
      'completed-away-run',
    );
    store.setChatRunning('completed-away-conv', true);
    store.setChatOutput('completed-away-run', 'stale partial');
    // A send acknowledged while disconnected: its run started and completed
    // unobserved, so only the open composer still owns the conversation.
    store.setActiveConvForProject('completed-away-project', 'unobserved-conv');

    nodeMock.timers.enable({ apis: ['setTimeout'] });
    const cleanup = installWebSocketRecoveryListeners(
      () => connectWebSocket(queryClient, { force: true }),
      () => true,
    );
    await Promise.resolve();
    const recovered = socketOpened();
    nativeAppStateListener?.({ isActive: true });
    nodeMock.timers.tick(0);
    await recovered;
    TestWebSocket.instances[1].receive('chat_replay_complete', {
      activeConversationIds: [],
    });

    const reconciled = actualUseStore.getState();
    expect(reconciled.chatRunningByConv['completed-away-conv']).toBeUndefined();
    expect(
      reconciled.activeStreamKeyByConv['completed-away-conv'],
    ).toBeUndefined();
    expect(reconciled.chatStreamRetiredByConv['unobserved-conv']).toBe(true);
    reconciled.setActiveConvForProject('completed-away-project', null);
    expect(invalidations).toContainEqual(['chatTranscript']);
    expect(invalidations).toContainEqual(['conversations']);
    expect(ticketRequests).toBe(2);
    expect(TestWebSocket.instances).toHaveLength(2);
    cleanup();
  });

  test('updates the message row when attribution shares its id and comes first', () => {
    const key = ['chatTranscript', 'persona-project', 'persona-conversation'];
    queryClient.setQueryData(key, {
      pages: [
        {
          entries: [
            {
              id: 'persona-message',
              type: 'ai_user_attribution',
              role: 'assistant',
              content: '',
            },
            {
              id: 'persona-message',
              type: 'message',
              role: 'assistant',
              content: '',
              senderUserId: 'ai:persona',
            },
          ],
        },
      ],
    });

    actualUseStore
      .getState()
      .setActiveStreamKeyForConv('persona-conversation', 'persona-run');
    handleWebSocketEvent({
      type: 'chat_message',
      payload: {
        folder: 'persona-project',
        message: {
          id: 'persona-message',
          conversation_id: 'persona-conversation',
          role: 'assistant',
          content: 'Persona response',
          senderUserId: 'ai:persona',
        },
      },
    });

    const entries = (taskCache.get(JSON.stringify(key)) as any).pages[0]
      .entries;
    expect(entries[0].content).toBe('');
    expect(entries[1].content).toBe('Persona response');
  });

  test('reconciles a live canonical message with its projected V1 transcript row', async () => {
    const folder = 'projected-id-project';
    const conversationId = 'projected-id-conversation';
    const streamKey = 'df6a5b92-3f51-4ad4-9f66-0796c5d7066b';
    const messageId = 'msg_05ce2c21ffadb308016a9734e9fad087d2b8fe87d2a8ae9756';
    const key = ['chatTranscript', folder, conversationId];
    queryClient.setQueryData(key, {
      pages: [
        {
          entries: [
            {
              id: `${streamKey}-v1-4-${messageId}`,
              type: 'message',
              role: 'assistant',
              content: 'da',
              senderUserId: 'ai:angy',
            },
          ],
        },
      ],
    });

    const store = actualUseStore.getState();
    store.setActiveStreamKeyForConv(conversationId, streamKey);
    handleWebSocketEvent({
      type: 'chat_message',
      payload: {
        folder,
        streamKey,
        message: {
          id: messageId,
          conversation_id: conversationId,
          role: 'assistant',
          content: 'da',
          senderUserId: 'ai:angy',
        },
      },
    });
    const cleared = outputCleared(streamKey);
    handleWebSocketEvent({
      type: 'chat_completed',
      payload: { folder, conversation_id: conversationId, streamKey },
    });
    await cleared;

    const entries = (taskCache.get(JSON.stringify(key)) as any).pages[0]
      .entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: 'da',
    });
  });

  test('preserves an aggregated post-steering segment when its terminal message arrives', () => {
    const folder = 'steered-projected-id-project';
    const conversationId = 'steered-projected-id-conversation';
    const streamKey = 'steered-projected-id-stream';
    const messageId = 'msg_terminal';
    const key = ['chatTranscript', folder, conversationId];
    queryClient.setQueryData(key, {
      pages: [
        {
          entries: [
            {
              id: 'run-v1-5-msg_first',
              canonicalMessageId: messageId,
              type: 'message',
              role: 'assistant',
              content: 'TailFinal',
              senderUserId: 'ai:angy',
            },
          ],
        },
      ],
    });

    actualUseStore
      .getState()
      .setActiveStreamKeyForConv(conversationId, streamKey);
    handleWebSocketEvent({
      type: 'chat_message',
      payload: {
        folder,
        streamKey,
        message: {
          id: messageId,
          conversation_id: conversationId,
          role: 'assistant',
          content: 'Final',
          senderUserId: 'ai:angy',
        },
      },
    });

    const entries = (taskCache.get(JSON.stringify(key)) as any).pages[0]
      .entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: messageId,
      canonicalMessageId: messageId,
      content: 'TailFinal',
    });
  });

  test('keeps canonical assistant attachments on the retained stream bubble', () => {
    const conversationId = 'artifact-conversation';
    const streamKey = 'artifact-run';
    const attachments = [
      {
        type: 'image',
        url: '/artifacts/project/images/generated.png',
        mimetype: 'image/png',
        filename: 'generated.png',
      },
    ];
    const store = actualUseStore.getState();
    store.setActiveStreamKeyForConv(conversationId, streamKey);
    store.setChatOutput(streamKey, 'streamed response');

    handleWebSocketEvent({
      type: 'chat_message',
      payload: {
        folder: 'project',
        streamKey,
        message: {
          id: streamKey,
          conversation_id: conversationId,
          role: 'assistant',
          content: 'streamed response',
          attachments,
        },
      },
    });

    expect(
      actualUseStore.getState().chatStreamingAttachments[streamKey],
    ).toEqual(attachments);

    actualUseStore.getState().clearChatOutput(streamKey);
    expect(
      actualUseStore.getState().chatStreamingAttachments[streamKey],
    ).toBeUndefined();
  });

  test('main completion retains commentary and tools until transcript handoff', async () => {
    const conversationId = 'main-commentary-conversation';
    const streamKey = 'main-commentary-run';
    const final = 'The clock returned 06:41:45 UTC.';
    const content = [
      'Here is the text before the tool call.',
      '<!-- carapa-tool:request tool-id="clock-1" -->',
      '```json\n{"tool":"clock"}\n```',
      final,
    ].join('\n\n');
    const store = actualUseStore.getState();
    store.setActiveStreamKeyForConv(conversationId, streamKey);
    store.setChatOutput(streamKey, content);
    handleWebSocketEvent({
      type: 'chat_message',
      payload: {
        folder: 'project',
        streamKey,
        message: {
          id: 'main-commentary-message',
          conversation_id: conversationId,
          role: 'assistant',
          content: final,
          senderUserId: 'ai:angy',
        },
      },
    });
    expect(actualUseStore.getState().chatStreamingOutput[streamKey]).toBe(
      content,
    );
    const cleared = outputCleared(streamKey);
    handleWebSocketEvent({
      type: 'chat_completed',
      payload: {
        folder: 'project',
        conversation_id: conversationId,
        streamKey,
      },
    });
    expect(actualUseStore.getState().chatStreamingOutput[streamKey]).toBe(
      content,
    );
    await cleared;
    expect(actualUseStore.getState().chatStreamingOutput[streamKey]).toBe('');
  });

  test('successful transcript handoff retires repeated completed live text', async () => {
    const conversationId = 'repeated-completion-conversation';
    const streamKey = 'repeated-completion-run';
    const canonical = 'Nothing more right now—don’t rebuild.';
    const store = actualUseStore.getState();
    store.setActiveStreamKeyForConv(conversationId, streamKey);
    store.setChatStreamPresentation(streamKey, {
      canonicalPersonaTurns: false,
      virtualSender: {
        id: 'angy',
        name: 'Angy',
        identity: 'primary personal software engineering copilot',
        avatarUrl: null,
      },
    });
    store.setChatOutput(streamKey, canonical + canonical);

    handleWebSocketEvent({
      type: 'chat_message',
      payload: {
        folder: 'project',
        streamKey,
        message: {
          id: 'canonical-message',
          conversation_id: conversationId,
          role: 'assistant',
          content: canonical,
          senderUserId: 'ai:angy',
        },
      },
    });
    expect(actualUseStore.getState().chatStreamingOutput[streamKey]).toBe(
      canonical,
    );
    handleWebSocketEvent({
      type: 'chat_output',
      payload: {
        folder: 'project',
        conversation_id: conversationId,
        streamKey,
        content: canonical,
        contentOffset: canonical.length,
      },
    });
    expect(actualUseStore.getState().chatStreamingOutput[streamKey]).toBe(
      canonical + canonical,
    );
    const cleared = outputCleared(streamKey);
    handleWebSocketEvent({
      type: 'chat_completed',
      payload: {
        folder: 'project',
        conversation_id: conversationId,
        streamKey,
      },
    });
    expect(actualUseStore.getState().chatStreamingOutput[streamKey]).toBe(
      canonical,
    );
    await cleared;

    expect(actualUseStore.getState().chatStreamingOutput[streamKey]).toBe('');
    expect(actualUseStore.getState().chatStreamingCompleted[streamKey]).toBe(
      true,
    );

    handleWebSocketEvent({
      type: 'chat_output',
      payload: {
        folder: 'project',
        conversation_id: conversationId,
        streamKey,
        content: canonical,
        contentOffset: canonical.length,
      },
    });
    expect(actualUseStore.getState().chatStreamingOutput[streamKey]).toBe('');
  });

  test('scheduled Chat lifecycle refreshes activity and scoped run queries', async () => {
    invalidations.length = 0;
    const { promise: socketOpened, resolve } = Promise.withResolvers<void>();
    TestWebSocket.nextOpened = resolve;
    connectWebSocket(queryClient, { force: true });
    await socketOpened;
    const socket = TestWebSocket.instances.at(-1)!;
    const payload = {
      project_id: 'scheduled-project',
      scheduled_task_id: 'scheduled-task',
    };
    const expectedInvalidations = [
      ['scheduledTaskRuns', 'scheduled-project', 'scheduled-task'],
      ['scheduledTasks', 'scheduled-project', 'scheduled-task'],
      ['scheduledTasks', 'scheduled-project'],
      ['projects', 'status-summary'],
    ];

    invalidations.length = 0;
    socket.receive('scheduled_task_run_started', payload);
    expect(invalidations).toEqual(expectedInvalidations);

    invalidations.length = 0;
    socket.receive('scheduled_task_run_completed', payload);
    expect(invalidations).toEqual(expectedInvalidations);
  });

  test('reconnect refreshes activity and mounted scheduled-task queries after missed events', async () => {
    invalidations.length = 0;
    await connectAndOpen({ force: true });

    expect(invalidations).toContainEqual(['scheduledTaskRuns']);
    expect(invalidations).toContainEqual(['scheduledTasks']);
    expect(invalidations).toContainEqual(['projects', 'status-summary']);
  });
});

describe('application WebSocket native origin selection', () => {
  test('opens LAN WSS in Home mode then reconnects through Remote WSS', async () => {
    // Fixed origins: the build-time defaults are empty without a gitignored .env.
    const HOME_URL = 'https://192.0.2.10:3000';
    const REMOTE_URL = 'https://remote.board.test';
    const requests: string[] = [];
    const transport = {
      apiFetch: async (url: string) => {
        requests.push(url);
        return new Response(JSON.stringify({ ticket: 'ticket' }), {
          status: 200,
        });
      },
      isAndroid: () => true,
      populateVault: () => {},
    };

    const homeUrl = await authenticatedApplicationWebSocketUrl(
      HOME_URL,
      transport,
    );
    const remoteUrl = await authenticatedApplicationWebSocketUrl(
      REMOTE_URL,
      transport,
    );

    expect(requests).toEqual([
      `${HOME_URL}/api/ws-ticket`,
      `${REMOTE_URL}/api/ws-ticket`,
    ]);
    expect(homeUrl).toBe(
      `${HOME_URL.replace(/^http/, 'ws')}/api/ws?ticket=ticket`,
    );
    expect(remoteUrl).toBe(
      `${REMOTE_URL.replace(/^http/, 'ws')}/api/ws?ticket=ticket`,
    );
  });
});
