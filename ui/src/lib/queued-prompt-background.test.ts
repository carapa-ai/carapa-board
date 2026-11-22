// @ts-nocheck
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { completionOwnsConversationLifecycle } from './chat-completion-ownership';
import { useStore } from '@/store';
import { ApiError } from './api';
import type {
  flushQueuedPromptsAfterCompletion as FlushQueuedPromptsAfterCompletion,
  handleWebSocketEvent as HandleWebSocketEvent,
  setWebSocketQueryClientForTest as SetWebSocketQueryClientForTest,
} from './websocket';

let flushQueuedPromptsAfterCompletion: typeof FlushQueuedPromptsAfterCompletion;
let handleWebSocketEvent: typeof HandleWebSocketEvent;
let setWebSocketQueryClientForTest: typeof SetWebSocketQueryClientForTest;
const toastError = mock(() => {});

beforeAll(async () => {
  mock.module('sonner', () => ({
    Toaster() {},
    toast: { error: toastError, success() {}, info() {}, warning() {} },
  }));
  Object.assign(globalThis, {
    window: {
      location: { hostname: 'localhost', protocol: 'http:' },
      addEventListener() {},
      removeEventListener() {},
    },
    document: { addEventListener() {}, removeEventListener() {} },
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
  });
  // Delay websocket loading until the module-scoped toast replacement exists.
  ({
    flushQueuedPromptsAfterCompletion,
    handleWebSocketEvent,
    setWebSocketQueryClientForTest,
  } = await import('./websocket'));
  setWebSocketQueryClientForTest({
    invalidateQueries: async () => undefined,
    refetchQueries: async () => undefined,
    getQueryData: () => undefined,
    setQueryData: () => undefined,
  } as never);
});

afterEach(() => {
  useStore.setState({ queuedPromptsByConv: {} });
  mock.restore();
  toastError.mockClear();
});

describe('background queued prompts', () => {
  test('lets a completion release queued work when chat_started was missed', () => {
    expect(
      completionOwnsConversationLifecycle({
        eventStreamKey: 'backend-run-2',
        currentStreamKey: 'stale-run-1',
        currentStreamCompleted: true,
        hasQueuedPrompts: true,
      }),
    ).toBe(true);
  });

  test('does not let an older completion clear a genuinely newer run', () => {
    expect(
      completionOwnsConversationLifecycle({
        eventStreamKey: 'older-run',
        currentStreamKey: 'newer-run',
        currentStreamCompleted: false,
        hasQueuedPrompts: true,
      }),
    ).toBe(false);
  });

  test('completion cannot resend a released prompt before its retry acknowledgement', async () => {
    const conversationId = 'provisional-normal-send';
    useStore.setState({
      queuedPromptsByConv: {
        [conversationId]: [
          {
            id: 'stable-normal-send',
            contextKey: 'project-a',
            content: 'still awaiting the original response',
            bubbleContent: 'still awaiting the original response',
            memoryContextLevel: 'off',
            awaitingAcknowledgement: true,
            serverReleased: true,
          },
        ],
      },
    });
    const sendChatMessage = mock(async () => ({
      conversation_id: conversationId,
    }));

    await flushQueuedPromptsAfterCompletion(
      { conversation_id: conversationId, project_id: 'project-a' },
      {
        sendChatMessage,
      },
    );

    expect(sendChatMessage).toHaveBeenCalledTimes(0);
    expect(
      useStore.getState().queuedPromptsByConv[conversationId],
    ).toHaveLength(1);
  });
  test('completion cannot resend a consumed browser receipt', async () => {
    const conversationId = 'consumed-browser-receipt';
    useStore.setState({
      queuedPromptsByConv: {
        [conversationId]: [
          {
            id: 'consumed-browser-receipt-id',
            contextKey: 'project-a',
            content: 'already consumed',
            bubbleContent: 'already consumed',
            memoryContextLevel: 'off',
            consumedByServer: true,
          },
        ],
      },
    });
    const sendChatMessage = mock(async () => ({
      conversation_id: conversationId,
    }));

    await flushQueuedPromptsAfterCompletion(
      { conversation_id: conversationId, project_id: 'project-a' },
      {
        sendChatMessage,
      },
    );

    expect(sendChatMessage).toHaveBeenCalledTimes(0);
    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      expect.objectContaining({ consumedByServer: true }),
    ]);
  });

  test('keeps an acknowledged background retry visible until transcript ownership renders', () => {
    const conversationId = 'acknowledged-background-retry';
    useStore.setState({
      queuedPromptsByConv: {
        [conversationId]: [
          {
            id: 'stable-background-retry',
            contextKey: 'project-a',
            content: 'keep one visible owner',
            bubbleContent: 'keep one visible owner',
            memoryContextLevel: 'off',
            awaitingAcknowledgement: true,
            serverReleased: true,
          },
        ],
      },
    });

    handleWebSocketEvent({
      type: 'chat_message',
      payload: {
        folder: 'project-a',
        message: {
          id: 'stable-background-retry',
          conversation_id: conversationId,
          role: 'user',
          content: 'keep one visible owner',
        },
      },
    } as never);

    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      expect.objectContaining({
        id: 'stable-background-retry',
        serverOwned: true,
      }),
    ]);
    expect(
      useStore.getState().queuedPromptsByConv[conversationId]?.[0],
    ).not.toHaveProperty('awaitingAcknowledgement');
    expect(
      useStore.getState().queuedPromptsByConv[conversationId]?.[0],
    ).not.toHaveProperty('serverReleased');
  });

  test('late chat_message preserves server-owned and consumed receipts', () => {
    const conversationId = 'retained-receipt-acknowledgement';
    const serverOwned = {
      id: 'server-owned-receipt',
      contextKey: 'project-a',
      content: 'server-owned receipt',
      bubbleContent: 'server-owned receipt',
      memoryContextLevel: 'off' as const,
      serverOwned: true,
    };
    const consumed = {
      id: 'consumed-receipt',
      contextKey: 'project-a',
      content: 'consumed receipt',
      bubbleContent: 'consumed receipt',
      memoryContextLevel: 'off' as const,
      serverOwned: true,
      consumedByServer: true,
    };
    useStore.setState({
      queuedPromptsByConv: { [conversationId]: [serverOwned, consumed] },
    });

    handleWebSocketEvent({
      type: 'chat_message',
      payload: {
        folder: 'project-a',
        message: {
          id: serverOwned.id,
          clientSubmissionIds: [consumed.id],
          conversation_id: conversationId,
          role: 'user',
        },
      },
    } as never);

    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      serverOwned,
      consumed,
    ]);
  });

  test('consumed completion retains a Direct receipt until transcript handoff', async () => {
    const conversationId = 'server-claimed-direct';
    useStore.setState({
      activeStreamKeyByConv: { [conversationId]: 'initial-direct-run' },
      chatStreamingCompleted: {},
      chatRunningByConv: { [conversationId]: true },
      queuedPromptsByConv: {
        [conversationId]: [
          {
            id: 'claimed-followup-message',
            contextKey: 'project-a',
            content: 'durably claimed',
            bubbleContent: 'durably claimed',
            memoryContextLevel: 'off',
            serverOwned: true,
          },
        ],
      },
    });
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      throw new Error('unexpected queued prompt POST');
    }) as never;

    try {
      handleWebSocketEvent({
        type: 'chat_started',
        payload: {
          folder: 'project-a',
          project_id: 'project-a',
          conversation_id: conversationId,
          streamKey: 'direct-followup-run',
        },
      } as never);
      handleWebSocketEvent({
        type: 'chat_completed',
        payload: {
          folder: 'project-a',
          project_id: 'project-a',
          conversation_id: conversationId,
          streamKey: 'initial-direct-run',
          consumedQueuedMessageIds: ['claimed-followup-message'],
        },
      } as never);
      const output = {
        folder: 'project-a',
        conversation_id: conversationId,
        streamKey: 'direct-followup-run',
        content: 'one canonical follow-up',
      };
      handleWebSocketEvent({ type: 'chat_output', payload: output } as never);
      handleWebSocketEvent({ type: 'chat_output', payload: output } as never);
      handleWebSocketEvent({
        type: 'chat_completed',
        payload: {
          folder: 'project-a',
          project_id: 'project-a',
          conversation_id: conversationId,
          streamKey: 'direct-followup-run',
        },
      } as never);

      const state = useStore.getState();
      expect(state.queuedPromptsByConv[conversationId]).toEqual([
        expect.objectContaining({
          id: 'claimed-followup-message',
          consumedByServer: true,
        }),
      ]);
      expect(state.activeStreamKeyByConv[conversationId]).toBe(
        'direct-followup-run',
      );
      expect(state.chatStreamingOutput['direct-followup-run']).toBe(
        'one canonical follow-up',
      );
      expect(state.chatRunningByConv[conversationId]).toBeUndefined();
      expect(requests).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('draining an older prompt preserves a newer awaiting acknowledgement', async () => {
    const conversationId = 'mixed-background-queue';
    const eligible = {
      id: 'eligible-older',
      contextKey: 'project-a',
      content: 'send this completed-boundary follow-up',
      bubbleContent: 'send this completed-boundary follow-up',
      memoryContextLevel: 'off' as const,
    };
    const awaiting = {
      id: 'awaiting-newer',
      contextKey: 'project-a',
      content: 'still owned by its original POST',
      bubbleContent: 'still owned by its original POST',
      memoryContextLevel: 'standard' as const,
      awaitingAcknowledgement: true,
    };
    useStore.setState({
      queuedPromptsByConv: { [conversationId]: [eligible, awaiting] },
    });
    let releaseRequest: (() => void) | undefined;
    const sendChatMessage = mock(async () => {
      await new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      return { conversation_id: conversationId };
    });

    const flush = flushQueuedPromptsAfterCompletion(
      { conversation_id: conversationId, project_id: 'project-a' },
      {
        sendChatMessage,
      },
    );
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      { ...eligible, awaitingAcknowledgement: true },
      awaiting,
    ]);

    releaseRequest?.();
    await flush;
    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      expect.objectContaining({
        id: 'eligible-older',
        serverOwned: true,
      }),
      awaiting,
    ]);
  });

  test('two completion observers launch one batched follow-up with all execution metadata', async () => {
    const conversationId = 'background-conversation';
    useStore.setState({
      queuedPromptsByConv: {
        [conversationId]: [
          {
            id: 'queued-1',
            contextKey: 'project-a',
            content: 'first queued prompt',
            bubbleContent: 'first queued prompt',
            conversation_id: conversationId,
            attachments: [
              { type: 'file', path: 'notes.txt', name: 'notes.txt' },
            ],
            deepLinks: [{ type: 'task', id: 'task-1', label: 'Task one' }],
            agent_cmd: 'codex',
            chat_mode: 'plan',
            runtimeSelection: { harnessId: 'direct', modelId: 'model-a' },
            memoryContextLevel: 'minimal',
            liveMode: true,
            liveModeSessionId: 'live-session-1',
            liveModeKind: 'work',
          },
          {
            id: 'queued-2',
            contextKey: 'project-a',
            content: 'second queued prompt',
            bubbleContent: 'second queued prompt',
            conversation_id: conversationId,
            memoryContextLevel: 'deep',
          },
        ],
      },
    });

    const requests: Array<Record<string, unknown>> = [];
    let releaseRequest: (() => void) | undefined;
    const sendChatMessage = mock(
      async (
        projectId,
        content,
        sentConversationId,
        attachments,
        agent_cmd,
        chat_mode,
        _liveMode,
        runtimeSelection,
        _delivery,
        deepLinks,
        memoryContext,
        liveModeSessionId,
        liveModeKind,
        clientSubmissionId,
        clientSubmissionIds,
      ) => {
        requests.push({
          projectId,
          content,
          conversation_id: sentConversationId,
          attachments,
          agent_cmd,
          chat_mode,
          runtimeSelection,
          deepLinks,
          memoryContext,
          liveMode: _liveMode,
          liveModeSessionId,
          liveModeKind,
          clientSubmissionId,
          clientSubmissionIds,
        });
        await new Promise<void>((resolve) => {
          releaseRequest = resolve;
        });
        return { conversation_id: conversationId };
      },
    );
    const senders = {
      sendChatMessage,
    };

    const completion = {
      conversation_id: conversationId,
      project_id: 'project-a',
      folder: 'project-a',
    };
    const pageObserver = flushQueuedPromptsAfterCompletion(completion, senders);
    const appObserver = flushQueuedPromptsAfterCompletion(completion, senders);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      content: 'first queued prompt\n\nsecond queued prompt',
      conversation_id: conversationId,
      agent_cmd: 'codex',
      chat_mode: 'plan',
      runtimeSelection: { harnessId: 'direct', modelId: 'model-a' },
      memoryContext: { level: 'deep' },
      liveMode: true,
      liveModeSessionId: 'live-session-1',
      liveModeKind: 'work',
      clientSubmissionId: 'queued-1',
      clientSubmissionIds: ['queued-1', 'queued-2'],
      attachments: [{ type: 'file', path: 'notes.txt', name: 'notes.txt' }],
      deepLinks: [{ type: 'task', id: 'task-1', label: 'Task one' }],
    });
    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      expect.objectContaining({
        id: 'queued-1',
        awaitingAcknowledgement: true,
      }),
      expect.objectContaining({
        id: 'queued-2',
        awaitingAcknowledgement: true,
      }),
    ]);

    releaseRequest?.();
    await Promise.all([pageObserver, appObserver]);
    expect(requests).toHaveLength(1);
  });

  test('restores the exact batch when a completion follow-up loses ownership', async () => {
    const conversationId = 'raced-conversation';
    const prompt = {
      id: 'queued-race',
      contextKey: 'project-a',
      content: 'retry me after the newer run',
      bubbleContent: 'retry me after the newer run',
      conversation_id: conversationId,
      memoryContextLevel: 'standard' as const,
    };
    useStore.setState({ queuedPromptsByConv: { [conversationId]: [prompt] } });
    const senders = {
      sendChatMessage: mock(async () => ({
        conversation_id: conversationId,
        delivery: 'queued' as const,
        queueOwner: 'browser' as const,
      })),
    };

    await flushQueuedPromptsAfterCompletion(
      {
        conversation_id: conversationId,
        project_id: 'project-a',
      },
      senders,
    );

    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      prompt,
    ]);
  });

  test('retries a lost accepted acknowledgement with the same batch IDs', async () => {
    const conversationId = 'lost-background-ack';
    const prompts = [
      {
        id: 'stable-background-1',
        contextKey: 'project-a',
        content: 'first stable prompt',
        bubbleContent: 'first stable prompt',
        conversation_id: conversationId,
        memoryContextLevel: 'off' as const,
      },
      {
        id: 'stable-background-2',
        contextKey: 'project-a',
        content: 'second stable prompt',
        bubbleContent: 'second stable prompt',
        conversation_id: conversationId,
        memoryContextLevel: 'standard' as const,
      },
    ];
    useStore.setState({ queuedPromptsByConv: { [conversationId]: prompts } });
    const submissions: Array<{ id?: string; ids?: string[] }> = [];
    const sendChatMessage = mock(async (...args: any[]) => {
      submissions.push({ id: args[13], ids: args[14] });
      if (submissions.length === 1) throw new TypeError('response lost');
      return { conversation_id: conversationId };
    });
    const senders = {
      sendChatMessage,
    };
    const completion = {
      conversation_id: conversationId,
      project_id: 'project-a',
    };

    await flushQueuedPromptsAfterCompletion(completion, senders);
    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual(
      prompts,
    );
    await flushQueuedPromptsAfterCompletion(completion, senders);

    expect(submissions).toEqual([
      {
        id: 'stable-background-1',
        ids: ['stable-background-1', 'stable-background-2'],
      },
      {
        id: 'stable-background-1',
        ids: ['stable-background-1', 'stable-background-2'],
      },
    ]);
    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      expect.objectContaining({
        id: 'stable-background-1',
        serverOwned: true,
      }),
    ]);
  });

  test('discards a missing-conversation batch and does not retry it', async () => {
    const conversationId = 'missing-background-conversation';
    const prompts = [
      {
        id: 'stale-background-1',
        contextKey: 'project-a',
        content: 'first stale prompt',
        bubbleContent: 'first stale prompt',
      },
      {
        id: 'stale-background-2',
        contextKey: 'project-a',
        content: 'second stale prompt',
        bubbleContent: 'second stale prompt',
      },
    ];
    useStore.setState({ queuedPromptsByConv: { [conversationId]: prompts } });
    const sendChatMessage = mock(async () => {
      throw new ApiError('Conversation not found', 404);
    });
    const completion = {
      conversation_id: conversationId,
      project_id: 'project-a',
    };
    const senders = {
      sendChatMessage,
    };

    await flushQueuedPromptsAfterCompletion(completion, senders);
    await flushQueuedPromptsAfterCompletion(completion, senders);

    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(
      useStore.getState().queuedPromptsByConv[conversationId],
    ).toBeUndefined();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      'Removed 2 queued messages: the conversation no longer exists.',
    );
  });

  test('restores a queued batch after an HTTP 500 failure', async () => {
    const conversationId = 'transient-http-500';
    const prompt = {
      id: 'transient-500',
      contextKey: 'project-a',
      content: 'retry this prompt',
      bubbleContent: 'retry this prompt',
    };
    useStore.setState({
      queuedPromptsByConv: { [conversationId]: [prompt] },
    });

    await flushQueuedPromptsAfterCompletion(
      { conversation_id: conversationId, project_id: 'project-a' },
      {
        sendChatMessage: mock(async () => {
          throw new ApiError('Temporary send failure', 500);
        }),
      },
    );

    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      prompt,
    ]);
    expect(toastError).toHaveBeenCalledWith(
      'Failed to send queued prompt: Temporary send failure',
    );
  });

  test('restores a network-failed batch without showing a toast', async () => {
    const conversationId = 'network-failed-background-conversation';
    const prompt = {
      id: 'network-failed-prompt',
      contextKey: 'project-a',
      content: 'retry after reconnect',
      bubbleContent: 'retry after reconnect',
    };
    useStore.setState({ queuedPromptsByConv: { [conversationId]: [prompt] } });

    await flushQueuedPromptsAfterCompletion(
      { conversation_id: conversationId, project_id: 'project-a' },
      {
        sendChatMessage: mock(async () => {
          throw new TypeError('Network connection lost');
        }),
      },
    );

    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      prompt,
    ]);
    expect(toastError).toHaveBeenCalledTimes(0);
  });

  test('keeps one visible server-owned item when persona takes a background batch', async () => {
    const conversationId = 'persona-owned-conversation';
    useStore.setState({
      queuedPromptsByConv: {
        [conversationId]: [
          {
            id: 'browser-1',
            contextKey: 'project-a',
            content: 'first',
            bubbleContent: 'first visible',
            conversation_id: conversationId,
            memoryContextLevel: 'minimal',
          },
          {
            id: 'browser-2',
            contextKey: 'project-a',
            content: 'second',
            bubbleContent: 'second visible',
            conversation_id: conversationId,
            memoryContextLevel: 'standard',
          },
        ],
      },
    });
    const senders = {
      sendChatMessage: mock(async () => ({
        conversation_id: conversationId,
        delivery: 'queued' as const,
        queueOwner: 'persona' as const,
        queuedMessageId: 'durable-persona-record',
      })),
    };

    await flushQueuedPromptsAfterCompletion(
      {
        conversation_id: conversationId,
        project_id: 'project-a',
      },
      senders,
    );

    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      expect.objectContaining({
        id: 'durable-persona-record',
        content: 'first\n\nsecond',
        bubbleContent: 'first visible\n\nsecond visible',
        memoryContextLevel: 'standard',
        serverOwned: true,
        serverQueueOwner: 'persona',
      }),
    ]);
  });

  test('keeps a project receipt until the server-owned follow-up is renderable', async () => {
    const conversationId = 'direct-project-race';
    useStore.setState({
      queuedPromptsByConv: {
        [conversationId]: [
          {
            id: 'browser-direct-project',
            contextKey: 'project-a',
            content: 'apply after completion race',
            bubbleContent: 'apply after completion race',
            conversation_id: conversationId,
            memoryContextLevel: 'off',
          },
        ],
      },
    });
    const sendChatMessage = mock(async () => ({
      conversation_id: conversationId,
      delivery: 'followup' as const,
      queueOwner: 'server' as const,
      runId: 'direct-followup-run',
    }));
    const senders = {
      sendChatMessage,
    };

    const completion = {
      conversation_id: conversationId,
      project_id: 'project-a',
    };
    await flushQueuedPromptsAfterCompletion(completion, senders);
    await flushQueuedPromptsAfterCompletion(completion, senders);

    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      expect.objectContaining({
        id: 'browser-direct-project',
        serverOwned: true,
        serverQueueOwner: 'server',
      }),
    ]);
  });

  test('keeps an objective receipt until the server-owned follow-up is renderable', async () => {
    const conversationId = 'objective-direct-race';
    useStore.setState({
      queuedPromptsByConv: {
        [conversationId]: [
          {
            id: 'objective-browser-direct',
            contextKey: 'objective-a',
            content: 'apply to objective direct run',
            bubbleContent: 'apply to objective direct run',
            conversation_id: conversationId,
            memoryContextLevel: 'minimal',
          },
        ],
      },
    });
    const sendChatMessage = mock(async () => ({
      conversation_id: conversationId,
      delivery: 'followup' as const,
      queueOwner: 'server' as const,
      runId: 'objective-followup-run',
    }));
    const senders = { sendChatMessage };

    const completion = {
      conversation_id: conversationId,
      project_id: 'project-a',
      objective_id: 'objective-a',
    };
    await flushQueuedPromptsAfterCompletion(completion, senders);
    await flushQueuedPromptsAfterCompletion(completion, senders);

    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(sendChatMessage.mock.calls[0]?.at(-2)).toBe('objective-a');
    expect(useStore.getState().queuedPromptsByConv[conversationId]).toEqual([
      expect.objectContaining({
        id: 'objective-browser-direct',
        serverOwned: true,
        serverQueueOwner: 'server',
      }),
    ]);
  });
});
