import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { useEffect } from 'react';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from './chat-page';
import {
  ApiError,
  fetchChatTranscript,
  fetchConversations as apiFetchConversations,
} from '@/lib/api';
import { registerPreviewTabLeaveGuard, useStore } from '@/store';
import { publishOpenFileContext } from '@/lib/open-file-context';

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  config: {} as Record<string, unknown>,
  conversations: [] as Array<Record<string, unknown>>,
  transcript: {
    entries: [] as Array<Record<string, unknown>>,
    hasMore: false,
    nextOffset: 0,
  },
  blockerOptions: null as null | { shouldBlockFn: () => boolean },
  liveModeStarts: vi.fn(),
  panelProps: null as null | {
    onDraftEnabledChange: (enabled: boolean) => void;
    onDraftTranscript: (text: string) => Promise<void> | void;
  },
  createConversation: vi.fn(async () => ({ id: 'spoken-conversation' })),
  dictationStart: vi.fn(async () => undefined),
  dictationFinal: null as null | ((text: string) => void),
  dictationOptions: null as null | Record<string, unknown>,
  dictationStartPayload: null as null | Record<string, unknown>,
  dictationCapturing: false,
  dictationStatus: 'idle',
  meetingRecording: false,
  updateConversation: vi.fn(
    async (
      _projectId: string,
      _conversationId: string,
      _fields: { title?: string | null; pinned?: boolean },
    ) => undefined,
  ),
  sendChatMessage: vi.fn(async () => ({ delivery: 'steered' })),
  withdrawQueuedChatMessage: vi.fn(async () => ({
    withdrawn: true,
    released: false,
  })),
  reconcileQueuedChatMessages: vi.fn(async () => ({
    active: true,
    pending: ['restored-queued-1'],
    consumed: [] as string[],
    released: [] as string[],
    withdrawn: [] as string[],
    queueOwners: {
      'restored-queued-1': 'persona',
    } as Record<string, 'persona' | 'direct'>,
  })),
  invitedAiUsers: [] as Array<{ id: string }>,
  mainAiUser: null as null | { id: string },
  toastError: vi.fn(),
  markConversationRead: vi.fn(
    async (_projectId: string, _conversationId: string) => undefined,
  ),
  pendingAttachments: [] as Array<{ file: File; durationSeconds?: number }>,
  uploadAttachment: vi.fn(async (..._args: unknown[]) => ({
    containerPath: '/workspace/uploads/file',
    browserUrl: '/uploads/file',
    originalName: 'file',
    absolutePath: '/uploads/file',
  })),
}));

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
});
vi.mock('@tanstack/react-router', () => ({
  useBlocker: (options: { shouldBlockFn: () => boolean }) => {
    harness.blockerOptions = options;
  },
  useNavigate: () => harness.navigate,
  useRouterState: () => ({ location: { pathname: '/chat/project-1' } }),
}));
vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({
    data: { id: 'project-1', name: 'Project One', settings: {} },
  }),
  useProjects: () => ({
    data: [
      { id: 'project-1', name: 'Project One', settings: {} },
      { id: 'project-2', name: 'Project Two', settings: {} },
      {
        id: 'board-only',
        name: 'Board Only',
        settings: { enabledModes: ['kanban'] },
      },
    ],
  }),
  useMeetingAccess: () => ({ data: true }),
  useUpdateProjectMode: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', username: 'Tester' } }),
}));
vi.mock('@/hooks/use-smart-scroll', () => ({
  useSmartScroll: () => ({
    containerRef: { current: null },
    bottomRef: { current: null },
    isPinned: true,
    scrollToBottom: vi.fn(),
    scrollToBottomIfPinned: vi.fn(),
    scrollToBottomIfPinnedNow: vi.fn(),
    settleToBottom: vi.fn(),
    handleScroll: vi.fn(),
  }),
}));
vi.mock('@/hooks/use-live-voice', () => ({
  useLiveVoice: (
    _enabled: boolean,
    onFinal: (text: string) => void,
    options?: Record<string, unknown>,
  ) => {
    harness.dictationFinal = onFinal;
    harness.dictationOptions = options ?? null;
    harness.dictationStartPayload = {
      type: 'start',
      protocol: 'carapa.live-stt.v2',
      sampleRate: 16_000,
      ...(options?.useAccountDictationLanguage ? { language: 'ro' } : {}),
    };
    return {
      status: harness.dictationStatus,
      capturing: harness.dictationCapturing,
      error: null,
      start: harness.dictationStart,
      finish: vi.fn(),
      stop: vi.fn(),
    };
  },
  useDictationFailureToast: () => undefined,
}));
vi.mock('@/hooks/use-paste-attachments', () => ({
  usePasteAttachments: () => ({
    pending: harness.pendingAttachments,
    addFiles: vi.fn(),
    removeAt: vi.fn(),
    clear: vi.fn(),
    handlePaste: vi.fn(),
  }),
}));
vi.mock('@/hooks/use-meeting-recording', () => ({
  useMeetingRecording: () => ({
    state: {
      isRecording: harness.meetingRecording,
      isStarting: false,
      isStopping: false,
    },
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    resumeRecording: vi.fn(),
    cancelRecording: vi.fn(),
    clearSession: vi.fn(),
  }),
}));

vi.mock('@/components/chat/live-mode-panel', async () => {
  const React = await import('react');
  return {
    LiveModePanel: React.forwardRef(
      (
        props: {
          activeConversationId: string | null;
          allowDraftStart?: boolean;
          draftEnabled?: boolean;
          draftKind?: string;
          onDraftEnabledChange: (enabled: boolean) => void;
          onDraftTranscript: (text: string) => Promise<void> | void;
        },
        ref: React.ForwardedRef<{ start: (kind?: string) => void }>,
      ) => {
        harness.panelProps = props;
        React.useImperativeHandle(ref, () => ({
          start: harness.liveModeStarts,
        }));
        return (
          <section
            data-ui="mounted-live-mode-panel"
            data-conversation-id={props.activeConversationId ?? 'draft'}
            data-draft-start={String(props.allowDraftStart)}
            data-draft-enabled={String(props.draftEnabled)}
            data-draft-kind={props.draftKind}
          />
        );
      },
    ),
  };
});
vi.mock('@/components/chat/chat-message-bubble', () => ({
  ChatMessageBubble: (props: {
    id: string;
    content: string;
    isStreaming?: boolean;
    virtualSenderName?: string;
    senderUserId?: string;
  }) => (
    <article
      data-ui="mounted-chat-message"
      data-message-id={props.id}
      data-streaming={String(Boolean(props.isStreaming))}
      data-sender-name={props.virtualSenderName}
      data-sender-user-id={props.senderUserId}
    >
      {props.content}
    </article>
  ),
}));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({
    children,
    onCloseAutoFocus,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    onCloseAutoFocus?: (event: Event) => void;
  }) => (
    // Selecting an item closes a real menu, which fires onCloseAutoFocus.
    <div
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        onCloseAutoFocus?.(new Event('focus', { cancelable: true }));
      }}
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    onSelect?: () => void;
  }) => (
    <button {...props} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuPortal: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('@/components/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('@/components/chat/preview-pane', () => ({
  PreviewPane: ({ conversation_id }: { conversation_id: string | null }) => {
    useEffect(() => {
      publishOpenFileContext(null);
    }, [conversation_id]);
    return (
      <button
        data-ui="test-open-preview"
        onClick={() =>
          publishOpenFileContext({
            key: `preview:${conversation_id ?? 'new'}`,
            conversationId: conversation_id,
            context: {
              source: 'artifact',
              path: 'plans/context.md',
            },
          })
        }
      >
        Open preview
      </button>
    );
  },
}));
vi.mock('@/components/secure-image', () => ({ SecureImage: () => null }));
vi.mock('@/components/chat/meeting-recording-overlay', () => ({
  default: () => null,
}));
vi.mock('@/components/markdown-content-lazy', () => ({
  MarkdownContent: () => null,
}));
vi.mock('@/components/chat/runtime-harness-icon', () => ({
  RuntimeHarnessIcon: () => null,
}));
vi.mock('@/components/chat/runtime-picker', () => ({
  RuntimePicker: () => null,
}));
vi.mock('@/components/chat/ai-users-menu', () => ({ AiUsersMenu: () => null }));
vi.mock('@/components/attachment-chips', () => ({
  AttachmentChips: () => null,
}));
vi.mock('@/components/chat/scheduled-tasks-sidebar', () => ({
  ScheduledTasksSidebarSection: () => null,
}));
vi.mock('@/lib/native-bridge', () => ({ isNative: () => false }));
vi.mock('@/lib/meeting-languages', () => ({ saveMeetingLanguage: vi.fn() }));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: harness.toastError,
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  const noop = vi.fn(async () => undefined);
  return {
    ApiError,
    fetchConfig: vi.fn(async () => harness.config),
    fetchRuntimeCatalog: vi.fn(async () => ({
      defaults: {},
      models: [],
      harnesses: [],
    })),
    fetchConversations: vi.fn(async () => harness.conversations),
    fetchConversation: vi.fn(async (_projectId: string, id: string) => {
      const conv = harness.conversations.find((c: any) => c.id === id);
      if (!conv) throw new ApiError('Conversation not found', 404);
      return conv;
    }),
    fetchChatTranscript: vi.fn(async () => harness.transcript),
    fetchConversationAiUsers: vi.fn(async () => harness.invitedAiUsers),
    fetchMainConversationAiUser: vi.fn(async () => harness.mainAiUser),
    fetchProjectAvailableAiUsers: vi.fn(async () => []),
    fetchProjectCommands: vi.fn(async () => []),
    fetchProjectWorktrees: vi.fn(async () => []),
    sendChatMessage: harness.sendChatMessage,
    withdrawQueuedChatMessage: harness.withdrawQueuedChatMessage,
    reconcileQueuedChatMessages: harness.reconcileQueuedChatMessages,
    answerCodexUserInput: noop,
    stopChatAgent: noop,
    createConversation: harness.createConversation,
    uploadAttachment: harness.uploadAttachment,
    markConversationRead: harness.markConversationRead,
    markAllConversationsRead: noop,
    deleteConversation: noop,
    updateConversation: harness.updateConversation,
    generateConversationTitle: noop,
    forkConversation: noop,
    extendActiveRun: noop,
    handoffConversation: noop,
    setConversationPersonaLoopApi: noop,
    startConversationPersonaRoundApi: noop,
  };
});

function conversation() {
  return {
    id: 'conversation-1',
    project_id: 'project-1',
    title: 'Live conversation',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    running: false,
    unread_count: 0,
    pinned: false,
  };
}

function conversationWith(id: string, title: string) {
  return { ...conversation(), id, title };
}

function renderPage(objectiveId?: string, routeConversationId?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatPage
        project_id="project-1"
        objective_id={objectiveId}
        route_conversation_id={routeConversationId}
      />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

beforeEach(() => {
  notifyManager.setScheduler(queueMicrotask);
  vi.clearAllMocks();
  harness.blockerOptions = null;
  harness.config = {};
  harness.sendChatMessage.mockImplementation(async () => ({
    delivery: 'steered',
  }));
  harness.withdrawQueuedChatMessage.mockImplementation(async () => ({
    withdrawn: true,
    released: false,
  }));
  harness.reconcileQueuedChatMessages.mockImplementation(async () => ({
    active: true,
    pending: ['restored-queued-1'],
    consumed: [],
    released: [],
    withdrawn: [],
    queueOwners: {
      'restored-queued-1': 'persona',
    } as Record<string, 'persona' | 'direct'>,
  }));
  harness.updateConversation.mockImplementation(async () => undefined);
  harness.markConversationRead.mockImplementation(async () => undefined);
  harness.pendingAttachments = [];
  harness.conversations = [conversation()];
  harness.transcript = { entries: [], hasMore: false, nextOffset: 0 };
  harness.invitedAiUsers = [];
  harness.mainAiUser = null;
  harness.dictationCapturing = false;
  harness.dictationStatus = 'idle';
  harness.dictationOptions = null;
  harness.dictationStartPayload = null;
  harness.meetingRecording = false;
  useStore.setState({
    activeConvByProject: {
      'project-1': 'conversation-1',
      'objective-1': 'conversation-1',
    },
    pinnedConversationsExpandedByProject: {},
    composingNewConversationByProject: {},
    pendingStreamKeyByProject: {},
    activeStreamKeyByConv: {},
    chatStreamingOutput: {},
    chatStreamingCompleted: {},
    chatStreamingTelemetry: {},
    chatStreamPresentation: {},
    chatRunningByConv: {},
    queuedPromptsByConv: {},
    draftByKey: {},
    memoryLevelByComposerKey: {},
    chatModeByComposerKey: {},
    liveModeEnabled: false,
    liveModeFocusedConversationId: null,
    liveModeCurrentProjectId: null,
    liveModeEnabledByConversation: { 'conversation-1': false },
    previewTabsByProject: {},
    // A leaked pending-activation marker would now reveal the panel on the
    // next test, so reset it alongside the tab state.
    pendingPreviewActivationByProject: {},
    workspaceViewByProject: {},
  });
  window.localStorage.clear();
  publishOpenFileContext(null);
});

afterEach(() => {
  cleanup();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
});

describe('ChatPage Live Mode integration', () => {
  it('moves a blank new conversation and its draft to a project picked in the header', async () => {
    harness.config = { enableChat: true, enableKanban: true };
    useStore.setState({
      activeConvByProject: { 'project-1': null },
      composingNewConversationByProject: { 'project-1': true },
      draftByKey: { 'project-1:__new__': 'Draft to carry over' },
    });

    const { container } = renderPage();
    const picker = await waitFor(() => {
      const trigger = container.querySelector<HTMLElement>(
        '[data-ui="chat-new-conversation-project-picker"]',
      );
      expect(trigger).not.toBeNull();
      return trigger!;
    });
    // The dropdown is mocked to render its items inline after the trigger.
    const menu = picker.nextElementSibling as HTMLElement;
    const target = menu.querySelector<HTMLElement>(
      '[data-project-id="project-2"]',
    );
    expect(target).not.toBeNull();
    // Projects without chat mode are not offered as destinations.
    expect(menu.querySelector('[data-project-id="board-only"]')).toBeNull();
    fireEvent.click(target!);

    const state = useStore.getState();
    expect(state.activeConvByProject['project-2']).toBeNull();
    expect(state.composingNewConversationByProject['project-2']).toBe(true);
    expect(state.draftByKey['project-2:__new__']).toBe('Draft to carry over');
    expect(state.draftByKey['project-1:__new__'] ?? '').toBe('');
    expect(harness.navigate).toHaveBeenCalledWith({
      to: '/chat/$projectId',
      params: { projectId: 'project-2' },
    });
  });

  it('focuses the header rename input and refreshes the Now list after a manual rename', async () => {
    const { container, queryClient } = renderPage();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const actions = await waitFor(() => {
      const trigger = container.querySelector<HTMLElement>(
        '[data-ui="chat-header-conversation-actions"]',
      );
      expect(trigger).not.toBeNull();
      return trigger!;
    });
    // The dropdown is mocked to render its items inline after the trigger.
    const renameItem = Array.from(
      actions.nextElementSibling!.querySelectorAll('button'),
    ).find((item) => item.textContent?.includes('Rename conversation'));
    fireEvent.click(renameItem!);

    const input = container.querySelector<HTMLInputElement>(
      '[data-ui="chat-conversation-title-input"]',
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    fireEvent.change(input!, { target: { value: 'Renamed in header' } });
    fireEvent.blur(input!);

    await waitFor(() =>
      expect(harness.updateConversation).toHaveBeenCalledWith(
        'project-1',
        'conversation-1',
        { title: 'Renamed in header' },
      ),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['attention'] }),
    );
  });

  it('shows a plain project label instead of the picker for an existing conversation', async () => {
    const { container } = renderPage();
    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="chat-project-name"]'),
      ).not.toBeNull(),
    );
    expect(
      container.querySelector(
        '[data-ui="chat-new-conversation-project-picker"]',
      ),
    ).toBeNull();
  });

  it('omits the section for public-only pins and regroups rows after pin updates refresh the query', async () => {
    harness.conversations = [
      {
        ...conversationWith('public-only-pin', 'Public pinned conversation'),
        publiclyShared: true,
        pinned: true,
      },
      conversationWith('pin-target', 'Pin target'),
    ];
    harness.updateConversation.mockImplementation(
      async (_projectId, conversationId, fields) => {
        harness.conversations = harness.conversations.map((item) =>
          item.id === conversationId ? { ...item, ...fields } : item,
        );
      },
    );

    const user = userEvent.setup();
    const { container } = renderPage();
    const targetRow = await waitFor(() => {
      const row = container.querySelector<HTMLElement>(
        '[data-conversation-id="pin-target"]',
      );
      expect(row).toBeTruthy();
      return row!;
    });
    expect(
      container.querySelector('[data-ui="pinned-conversations-section"]'),
    ).toBeNull();

    await user.click(
      within(targetRow).getByRole('button', { name: 'Pin conversation' }),
    );
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-ui="pinned-conversations-section"]')
          ?.querySelector('[data-conversation-id="pin-target"]'),
      ).toBeTruthy(),
    );
    expect(harness.updateConversation).toHaveBeenLastCalledWith(
      'project-1',
      'pin-target',
      { pinned: true },
    );

    const regroupedTarget = container.querySelector<HTMLElement>(
      '[data-conversation-id="pin-target"]',
    )!;
    await user.click(
      within(regroupedTarget).getByRole('button', {
        name: 'Unpin conversation',
      }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="pinned-conversations-section"]'),
      ).toBeNull(),
    );
    expect(harness.updateConversation).toHaveBeenLastCalledWith(
      'project-1',
      'pin-target',
      { pinned: false },
    );
  });

  it('focuses the list rename input and keeps it open with the typed title when saving fails', async () => {
    harness.conversations = [
      conversationWith('rename-target', 'Rename target'),
    ];
    harness.updateConversation.mockRejectedValue(new Error('server down'));

    const user = userEvent.setup();
    const { container } = renderPage();
    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '[data-conversation-id="rename-target"]',
      );
      expect(found).toBeTruthy();
      return found!;
    });

    await user.click(
      within(row).getByRole('button', { name: 'Rename conversation' }),
    );
    const input = within(row).getByRole('textbox', {
      name: 'Conversation title',
    });
    expect(document.activeElement).toBe(input);

    await user.clear(input);
    await user.type(input, 'Typed title{Enter}');

    await waitFor(() =>
      expect(harness.toastError).toHaveBeenCalledWith(
        expect.stringContaining('Could not rename conversation'),
      ),
    );
    const stillOpen = within(row).getByRole('textbox', {
      name: 'Conversation title',
    });
    expect((stillOpen as HTMLInputElement).value).toBe('Typed title');
  });

  it('reports a failed pin with a toast', async () => {
    harness.conversations = [conversationWith('pin-fails', 'Pin fails')];
    harness.updateConversation.mockRejectedValue(new Error('server down'));

    const user = userEvent.setup();
    const { container } = renderPage();
    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '[data-conversation-id="pin-fails"]',
      );
      expect(found).toBeTruthy();
      return found!;
    });

    await user.click(
      within(row).getByRole('button', { name: 'Pin conversation' }),
    );
    await waitFor(() =>
      expect(harness.toastError).toHaveBeenCalledWith(
        expect.stringContaining('Could not pin conversation'),
      ),
    );
  });

  it('does not auto-open a plan found in the hydrated historical transcript', async () => {
    harness.transcript = {
      entries: [
        {
          id: 'historical-plan',
          type: 'message',
          role: 'assistant',
          content:
            'Historical answer\n```carapaplan\n{"artifactPath":"artifacts/plans/old.md","planText":"# old"}\n```',
        },
      ],
      hasMore: false,
      nextOffset: 1,
    };
    renderPage();
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="chat-mounted-transcript-window"]'),
      ).toBeTruthy(),
    );
    expect(
      useStore.getState().previewTabsByProject['project-1'],
    ).toBeUndefined();
  });

  it('opens a plan completed after switching to a cached conversation', async () => {
    harness.conversations = [
      conversationWith('conversation-1', 'Conversation A'),
      conversationWith('conversation-2', 'Conversation B'),
    ];
    const oldPlan = {
      id: 'old-plan',
      type: 'message',
      role: 'assistant',
      content:
        'Old plan\n```carapaplan\n{"artifactPath":"artifacts/plans/old.md","planText":"# old"}\n```',
    };
    const newPlan = {
      id: 'new-plan',
      type: 'message',
      role: 'assistant',
      content:
        'New plan\n```carapaplan\n{"artifactPath":"artifacts/plans/new.md","planText":"# new"}\n```',
    };
    const { queryClient } = renderPage();
    queryClient.setQueryData(
      ['chatTranscript', 'project-1', 'conversation-2'],
      {
        pages: [{ entries: [oldPlan], hasMore: false, nextOffset: 1 }],
        pageParams: [0],
      },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText('Conversation B'));
    await waitFor(() =>
      expect(
        useStore.getState().previewTabsByProject['project-1'],
      ).toBeUndefined(),
    );

    useStore.setState({
      activeStreamKeyByConv: { 'conversation-2': 'run-2' },
      chatStreamingOutput: { 'run-2': newPlan.content },
      chatRunningByConv: { 'conversation-2': true },
    });
    queryClient.setQueryData(
      ['chatTranscript', 'project-1', 'conversation-2'],
      {
        pages: [{ entries: [oldPlan, newPlan], hasMore: false, nextOffset: 2 }],
        pageParams: [0],
      },
    );
    await waitFor(() =>
      expect(
        useStore.getState().previewTabsByProject['project-1']?.tabs[0]?.path,
      ).toBe('artifacts/plans/new.md'),
    );

    useStore
      .getState()
      .closePreviewTab('project-1', 'group:artifacts/plans/new.md');
    useStore.setState({
      activeStreamKeyByConv: { 'conversation-2': 'run-2' },
      chatStreamingOutput: { 'run-2': 'working without a plan' },
      chatRunningByConv: { 'conversation-2': true },
    });
    await act(async () => {});
    expect(
      useStore.getState().previewTabsByProject['project-1'],
    ).toBeUndefined();

    queryClient.setQueryData(
      ['chatTranscript', 'project-1', 'conversation-2'],
      {
        pages: [
          {
            entries: [
              oldPlan,
              {
                ...newPlan,
                id: 'persisted-new-plan',
                content: `${newPlan.content}\nCompleted details`,
              },
            ],
            hasMore: false,
            nextOffset: 2,
          },
        ],
        pageParams: [0],
      },
    );
    await act(async () => {});
    expect(
      useStore.getState().previewTabsByProject['project-1'],
    ).toBeUndefined();
  });

  it('treats the first snapshot of an uncached destination as historical', async () => {
    harness.conversations = [
      conversationWith('conversation-1', 'Conversation A'),
      conversationWith('conversation-2', 'Conversation B'),
    ];
    harness.transcript = {
      entries: [
        {
          id: 'uncached-old-plan',
          type: 'message',
          role: 'assistant',
          content:
            'Old plan\n```carapaplan\n{"artifactPath":"artifacts/plans/uncached-old.md","planText":"# old"}\n```',
        },
      ],
      hasMore: false,
      nextOffset: 1,
    };
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('Conversation B'));
    await waitFor(() =>
      expect(useStore.getState().activeConvByProject['project-1']).toBe(
        'conversation-2',
      ),
    );
    await waitFor(() =>
      expect(
        useStore.getState().previewTabsByProject['project-1'],
      ).toBeUndefined(),
    );
  });

  it('re-scopes a mounted preview when switching conversations and allows reopening it', async () => {
    harness.conversations = [
      conversationWith('conversation-1', 'Conversation A'),
      conversationWith('conversation-2', 'Conversation B'),
    ];
    window.localStorage.setItem(
      'artifactsPanelOpenByProject',
      JSON.stringify({ 'project-1': true }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Open preview' }),
    );
    await user.click(screen.getByText('Conversation B'));
    await waitFor(() =>
      expect(useStore.getState().activeConvByProject['project-1']).toBe(
        'conversation-2',
      ),
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'B without context' },
    });
    await user.click(screen.getByTitle('Send (↵)'));
    await waitFor(() => expect(harness.sendChatMessage).toHaveBeenCalledOnce());
    expect(harness.sendChatMessage.mock.calls[0]?.at(-1)).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Open preview' }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'B with context' },
    });
    await user.click(screen.getByTitle('Send (↵)'));
    await waitFor(() =>
      expect(harness.sendChatMessage).toHaveBeenCalledTimes(2),
    );
    expect(harness.sendChatMessage.mock.calls[1]?.at(-1)).toMatchObject({
      path: 'plans/context.md',
    });
    window.localStorage.removeItem('artifactsPanelOpenByProject');
  });

  it('rejects a prior owner before preview cleanup effects run on switch and New', async () => {
    window.localStorage.setItem(
      'artifactsPanelOpenByProject',
      JSON.stringify({ 'project-1': true }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Open preview' }),
    );

    useStore.getState().setActiveConvForProject('project-1', 'conversation-2');
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'switch without waiting' },
    });
    await user.click(screen.getByTitle('Send (↵)'));
    await waitFor(() => expect(harness.sendChatMessage).toHaveBeenCalledOnce());
    expect(harness.sendChatMessage.mock.calls[0]?.at(-1)).toBeUndefined();

    useStore.getState().setActiveConvForProject('project-1', null);
    useStore
      .getState()
      .setComposingNewConversationForProject('project-1', true);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'New without waiting' },
    });
    await user.click(screen.getByTitle('Send (↵)'));
    await waitFor(() =>
      expect(harness.sendChatMessage).toHaveBeenCalledTimes(2),
    );
    expect(harness.sendChatMessage.mock.calls[1]?.at(-1)).toBeUndefined();
    window.localStorage.removeItem('artifactsPanelOpenByProject');
  });

  it('keeps mobile conversation transitions atomic when an unsaved preview rejects leave', async () => {
    harness.conversations = [
      conversationWith('conversation-1', 'Conversation A'),
      conversationWith('conversation-2', 'Conversation B'),
    ];
    const originalMatchMedia = window.matchMedia;
    const removeGuard = registerPreviewTabLeaveGuard(
      'project-1',
      'dirty-preview',
      () => false,
    );
    useStore.setState({
      previewTabsByProject: {
        'project-1': {
          tabs: [
            {
              id: 'dirty-preview',
              title: 'Draft',
              kind: 'text',
              source: 'repo',
              path: 'draft.md',
            },
          ],
          activeTabId: 'dirty-preview',
          activationSequence: 1,
        },
      },
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    try {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByText('Conversation B'));
      expect(useStore.getState().activeConvByProject['project-1']).toBe(
        'conversation-1',
      );
      expect(
        useStore.getState().composingNewConversationByProject['project-1'],
      ).toBeUndefined();

      await user.click(screen.getByRole('button', { name: 'New' }));
      expect(useStore.getState().activeConvByProject['project-1']).toBe(
        'conversation-1',
      );
      expect(
        useStore.getState().composingNewConversationByProject['project-1'],
      ).toBeUndefined();
    } finally {
      removeGuard();
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
  it('blocks route navigation while the active preview has unsaved changes', async () => {
    useStore.setState({
      previewTabsByProject: {
        'project-1': {
          tabs: [
            {
              id: 'dirty-preview',
              title: 'Draft',
              kind: 'text',
              source: 'repo',
              path: 'draft.md',
            },
          ],
          activeTabId: 'dirty-preview',
          activationSequence: 1,
        },
      },
    });
    const removeGuard = registerPreviewTabLeaveGuard(
      'project-1',
      'dirty-preview',
      () => false,
    );
    try {
      renderPage();
      expect(harness.blockerOptions).toBeTruthy();
      expect(await harness.blockerOptions?.shouldBlockFn()).toBe(true);
    } finally {
      removeGuard();
    }
    expect(await harness.blockerOptions?.shouldBlockFn()).toBe(false);
  });

  // Step 1 source: a remembered (localStorage) or deep-linked id the project
  // does not have (deleted, or from another project) must not reach the
  // mark-read endpoint.
  it('never marks read a remembered conversation the project does not have', async () => {
    useStore.setState({
      activeConvByProject: { 'project-1': 'conv-1790000000000-foreign' },
    });

    renderPage();

    await waitFor(() =>
      expect(useStore.getState().activeConvByProject['project-1']).toBeNull(),
    );
    expect(harness.markConversationRead).not.toHaveBeenCalled();
    expect(fetchChatTranscript).not.toHaveBeenCalled();
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  // Opening from Now or a notification deep-links `?conversationId=`.
  it('marks a deep-linked conversation read under the project that has it, and skips one it lacks', async () => {
    harness.conversations = [conversationWith('deep-linked', 'Deep linked')];

    const { unmount } = renderPage(undefined, 'deep-linked');
    await waitFor(() =>
      expect(harness.markConversationRead).toHaveBeenCalledWith(
        'project-1',
        'deep-linked',
      ),
    );
    unmount();
    harness.markConversationRead.mockClear();

    renderPage(undefined, 'conv-1790000000000-foreign');
    await waitFor(() =>
      expect(useStore.getState().activeConvByProject['project-1']).toBeNull(),
    );
    expect(harness.markConversationRead).not.toHaveBeenCalled();
    expect(fetchChatTranscript).not.toHaveBeenCalledWith(
      'project-1',
      'conv-1790000000000-foreign',
      expect.anything(),
      expect.anything(),
    );
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  it('clears the selection without a toast when marking read finds the conversation gone', async () => {
    harness.markConversationRead.mockRejectedValue(
      new ApiError('Conversation not found', 404),
    );
    useStore.setState({
      draftByKey: { 'project-1:__new__': 'kept draft' },
    });

    renderPage();

    await waitFor(() =>
      expect(useStore.getState().activeConvByProject['project-1']).toBeNull(),
    );
    expect(harness.toastError).not.toHaveBeenCalled();
    expect(
      useStore.getState().composingNewConversationByProject['project-1'],
    ).toBe(true);
  });

  it('still reports other mark-read failures with a distinguishable id', async () => {
    harness.conversations = [
      { ...conversation(), id: 'conv-1790000000000-abcdef12', title: '' },
    ];
    useStore.setState({
      activeConvByProject: { 'project-1': 'conv-1790000000000-abcdef12' },
    });
    harness.markConversationRead.mockRejectedValue(
      new ApiError('Forbidden', 403),
    );

    renderPage();

    await waitFor(() =>
      expect(harness.toastError).toHaveBeenCalledWith(
        expect.stringContaining('Conversation abcdef12'),
      ),
    );
    expect(useStore.getState().activeConvByProject['project-1']).toBe(
      'conv-1790000000000-abcdef12',
    );
  });

  it('keeps a typed new-conversation draft selected when an older stream starts', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'New' }));
    const textarea = await screen.findByRole('textbox');
    await user.type(textarea, 'This belongs in a new conversation');

    expect(
      useStore.getState().composingNewConversationByProject['project-1'],
    ).toBe(true);

    useStore.getState().setPendingStreamKey('project-1', 'conversation-1');

    await waitFor(() => {
      expect(useStore.getState().activeConvByProject['project-1']).toBeNull();
    });
    expect((textarea as HTMLTextAreaElement).value).toBe(
      'This belongs in a new conversation',
    );
  });

  it('captures visible context at send without rendering composer context controls', async () => {
    publishOpenFileContext({
      key: 'project-1:group-file',
      conversationId: 'conversation-1',
      context: {
        source: 'group',
        path: '.env',
        line: 2,
        column: 3,
        unsavedChanges: true,
      },
    });
    const user = userEvent.setup();
    renderPage();
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'fix this' },
    });
    await user.click(await screen.findByTitle('Send (↵)'));
    await waitFor(() => expect(harness.sendChatMessage).toHaveBeenCalledOnce());
    expect(harness.sendChatMessage.mock.calls[0]?.at(-1)).toMatchObject({
      path: '.env',
      line: 2,
      column: 3,
    });
  });

  it('captures context in a browser queue and does not recompute it', async () => {
    useStore.setState({ chatRunningByConv: { 'conversation-1': true } });
    publishOpenFileContext({
      key: 'project-1:first',
      conversationId: 'conversation-1',
      context: {
        source: 'artifact',
        path: 'plans/first.md',
        line: 4,
        column: 1,
      },
    });
    const user = userEvent.setup();
    renderPage();
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'queue this' },
    });
    await user.click(await screen.findByTitle('Queue as next turn (↵)'));
    const captured =
      useStore.getState().queuedPromptsByConv['conversation-1']?.[0];
    expect(captured?.openFileContext?.path).toBe('plans/first.md');
    publishOpenFileContext({
      key: 'project-1:second',
      conversationId: 'conversation-1',
      context: { source: 'group', path: 'second.txt', line: 9, column: 2 },
    });
    expect(captured?.openFileContext).toMatchObject({
      path: 'plans/first.md',
      line: 4,
      column: 1,
    });
    expect(harness.sendChatMessage).not.toHaveBeenCalled();
  });

  it('sends the same typed context through objective chat', async () => {
    publishOpenFileContext({
      key: 'project-1:objective-file',
      conversationId: 'conversation-1',
      context: {
        source: 'group',
        path: 'notes/objective.md',
        line: 5,
        column: 6,
      },
    });
    const user = userEvent.setup();
    renderPage('objective-1');
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'objective question' },
    });
    await user.click(await screen.findByTitle('Send (↵)'));
    await waitFor(() => expect(harness.sendChatMessage).toHaveBeenCalledOnce());
    const sendArgs = harness.sendChatMessage.mock.calls[0] as unknown[];
    expect(sendArgs.at(-1)).toMatchObject({
      path: 'notes/objective.md',
      line: 5,
      column: 6,
    });
    expect(sendArgs.at(-2)).toBe('objective-1');
  });

  it('resets a dead conversation selection and restores the typed message', async () => {
    harness.sendChatMessage.mockRejectedValueOnce(
      new ApiError('Conversation not found', 404),
    );
    const user = userEvent.setup();
    renderPage('objective-1');
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'first message' } });
    await user.click(await screen.findByTitle('Send (↵)'));
    await waitFor(() =>
      expect(useStore.getState().activeConvByProject['objective-1']).toBeNull(),
    );
    expect(
      useStore.getState().composingNewConversationByProject['objective-1'],
    ).toBe(true);
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'first message',
      ),
    );
    expect(harness.toastError).toHaveBeenCalledWith(
      expect.stringContaining('your message was restored'),
    );
    expect(harness.toastError).not.toHaveBeenCalledWith(
      'Message not sent: the conversation no longer exists.',
    );
  });

  it('keeps the selection and shows the server error for a missing objective', async () => {
    harness.sendChatMessage.mockRejectedValueOnce(
      new ApiError('Objective not found', 404),
    );
    const user = userEvent.setup();
    renderPage('objective-1');
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'hello' },
    });
    await user.click(await screen.findByTitle('Send (↵)'));
    await waitFor(() =>
      expect(harness.toastError).toHaveBeenCalledWith('Objective not found'),
    );
    expect(useStore.getState().activeConvByProject['objective-1']).toBe(
      'conversation-1',
    );
  });

  it('restores the typed message after an HTTP send failure without overwriting a newer draft', async () => {
    let rejectSend!: (error: Error) => void;
    harness.sendChatMessage.mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectSend = reject;
        }),
    );
    const user = userEvent.setup();
    renderPage('objective-1');
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'failed message' } });
    await user.click(await screen.findByTitle('Send (↵)'));
    await waitFor(() => expect(harness.sendChatMessage).toHaveBeenCalledOnce());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'newer draft' },
    });
    rejectSend(new ApiError('boom', 500));
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'failed message\n\nnewer draft',
      ),
    );
    expect(harness.toastError).toHaveBeenCalledWith('boom');
  });

  it('names each rejected attachment and its server reason in the upload toast', async () => {
    harness.pendingAttachments = ['big.bin', 'ok.txt', 'bad.exe'].map(
      (name) => ({ file: new File(['x'], name) }),
    );
    harness.uploadAttachment.mockImplementation(async (...args: unknown[]) => {
      const name = (args[1] as File).name;
      if (name === 'big.bin') {
        throw new ApiError('File too large (max 25 MB)', 413);
      }
      if (name === 'bad.exe') throw new ApiError('Unsupported file type', 415);
      return {
        containerPath: '/workspace/uploads/ok.txt',
        browserUrl: '/uploads/ok.txt',
        originalName: name,
        absolutePath: '/uploads/ok.txt',
      };
    });
    const user = userEvent.setup();
    renderPage('objective-1');
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'with files' },
    });
    await user.click(await screen.findByTitle('Send (↵)'));
    await waitFor(() =>
      expect(harness.toastError).toHaveBeenCalledWith(
        'Failed to upload attachments: big.bin: File too large (max 25 MB); bad.exe: Unsupported file type',
      ),
    );
    expect(harness.sendChatMessage).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'with files',
      ),
    );
  });

  it('copies Live Mode and participant settings into a blank conversation composer', async () => {
    harness.conversations = [
      {
        ...conversation(),
        mainAiUserMode: 'persona',
        mainAiUserId: 'main-persona',
        continuousPersonaLoop: true,
      },
    ];
    harness.invitedAiUsers = [{ id: 'invited-persona' }];
    useStore.setState({
      liveModeEnabledByConversation: { 'conversation-1': true },
      liveModeKindByConversation: { 'conversation-1': 'personas' },
    });
    const user = userEvent.setup();
    const { container } = renderPage();
    await user.click(
      await screen.findByRole('button', {
        name: /New conversation with same settings/i,
      }),
    );

    await waitFor(() =>
      expect(
        container
          .querySelector('[data-ui="mounted-live-mode-panel"]')
          ?.getAttribute('data-conversation-id'),
      ).toBe('draft'),
    );
    const panel = container.querySelector(
      '[data-ui="mounted-live-mode-panel"]',
    );
    expect(panel?.getAttribute('data-draft-enabled')).toBe('true');
    expect(panel?.getAttribute('data-draft-kind')).toBe('personas');
    expect(
      container.querySelector('[data-ui="composer-dictation"]'),
    ).toBeNull();
  });

  it('exposes the selected mode and keeps it from leaking into the next new chat', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(
      await screen.findByRole('menuitemradio', { name: 'Plan' }),
    );

    const checked = screen
      .getAllByRole('menuitemradio')
      .filter((item) => item.getAttribute('aria-checked') === 'true');
    expect(checked.map((item) => item.textContent)).toEqual(['Plan']);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'plan this' },
    });
    await user.click(await screen.findByTitle('Send (↵)'));
    await waitFor(() => expect(harness.sendChatMessage).toHaveBeenCalledOnce());

    const modeKeys = () =>
      Object.entries(useStore.getState().chatModeByComposerKey);
    await waitFor(() =>
      expect(modeKeys().filter(([, mode]) => mode === 'plan')).toEqual([
        [expect.stringMatching(/:spoken-conversation$/), 'plan'],
      ]),
    );
    expect(modeKeys().some(([key]) => key.endsWith(':__new__'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'New' }));
    expect(screen.queryByTitle('Clear mode')).toBeNull();
  });

  it('creates the conversation from the first spoken phrase of a draft Live Mode chat', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'New' }));
    await screen.findByRole('textbox');
    useStore
      .getState()
      .setLiveModeMicrophoneEnabled('project:project-1:new', true);
    act(() => harness.panelProps?.onDraftEnabledChange(true));

    await act(async () => {
      await harness.panelProps?.onDraftTranscript('hello from voice');
    });

    expect(harness.createConversation).toHaveBeenCalledOnce();
    await waitFor(() => expect(harness.sendChatMessage).toHaveBeenCalledOnce());
    expect(harness.sendChatMessage.mock.calls[0]).toContain('hello from voice');
    const state = useStore.getState();
    expect(state.liveModeEnabledByConversation['spoken-conversation']).toBe(
      true,
    );
    expect(state.liveModeFocusedConversationId).toBe('spoken-conversation');
    expect(
      state.liveModeMicrophoneEnabledByConversation['spoken-conversation'],
    ).toBe(true);
  });

  it('starts Live Mode with the chosen kind from the composer menu and hides the items while it is on', async () => {
    harness.mainAiUser = { id: 'main-persona' };
    const { container } = renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Live Mode · Persona' }),
    );
    expect(harness.liveModeStarts).toHaveBeenLastCalledWith('personas');
    fireEvent.click(screen.getByRole('button', { name: 'Live Mode · Work' }));
    expect(harness.liveModeStarts).toHaveBeenLastCalledWith('work');
    expect(container.querySelector('[data-ui="live-mode-toggle"]')).toBeNull();

    cleanup();
    useStore.setState({
      liveModeEnabled: true,
      liveModeFocusedConversationId: 'conversation-1',
      liveModeCurrentProjectId: 'project-1',
      liveModeEnabledByConversation: { 'conversation-1': true },
    });
    const running = renderPage();
    await screen.findByRole('textbox');
    expect(
      running.container.querySelector('[data-ui="start-live-mode-menu-item"]'),
    ).toBeNull();
    expect(
      running.container.querySelector(
        '[data-ui="start-live-mode-work-menu-item"]',
      ),
    ).toBeNull();
  });

  it('inserts dictation finals at the current composer selection without sending', async () => {
    renderPage();
    const textarea = (await screen.findByRole(
      'textbox',
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Please  now' } });
    textarea.setSelectionRange(7, 7);
    harness.dictationFinal?.('review this');

    expect(textarea.value).toBe('Please review this now');
    expect(harness.sendChatMessage).not.toHaveBeenCalled();
  });

  it('opts the mounted composer dictation into account language propagation and shows the language picker only while dictating', async () => {
    const { container } = renderPage();
    await screen.findByRole('textbox');
    expect(harness.dictationOptions).toEqual({
      useAccountDictationLanguage: true,
      onLevel: expect.any(Function),
      minSpeechMs: 150,
    });
    expect(harness.dictationStartPayload).toMatchObject({ language: 'ro' });
    expect(
      container.querySelector('[data-ui="composer-dictation"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-ui="composer-dictation-language"]'),
    ).toBeNull();
  });

  it('places pre-stream steering after the current prompt', async () => {
    harness.transcript.entries = [
      {
        id: 'previous-prompt',
        type: 'message',
        role: 'user',
        content: 'Previous prompt',
      },
      {
        id: 'previous-answer',
        type: 'message',
        role: 'assistant',
        content: 'Previous answer',
      },
      {
        id: 'current-prompt',
        type: 'message',
        role: 'user',
        content: 'Current prompt',
      },
    ];
    useStore.setState({
      activeStreamKeyByConv: { 'conversation-1': 'stream-1' },
      chatStreamingOutput: { 'stream-1': '' },
      chatStreamingCompleted: { 'stream-1': false },
      chatRunningByConv: { 'conversation-1': true },
      liveModeEnabled: true,
      liveModeFocusedConversationId: 'conversation-1',
      liveModeCurrentProjectId: 'project-1',
      liveModeEnabledByConversation: { 'conversation-1': true },
    });
    const user = userEvent.setup();
    const { container } = renderPage();
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'Steer before streaming' },
    });
    await user.click(await screen.findByTitle('Steer current turn (↵)'));

    const steering = await waitFor(() => {
      const message = container.querySelector(
        '[data-ui="chat-steering-message"]',
      );
      expect(message).toBeTruthy();
      return message!;
    });
    const previousAnswer = screen.getByText('Previous answer');
    const currentPrompt = screen.getByText('Current prompt');
    expect(
      previousAnswer.compareDocumentPosition(steering) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      currentPrompt.compareDocumentPosition(steering) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders a pending steer that ran as a follow-up turn above its reply, once', async () => {
    harness.sendChatMessage.mockImplementation(async () => ({
      delivery: 'pending',
      userMessage: { id: 'steer-pending-1' },
    }));
    const prompt = {
      id: 'current-prompt',
      type: 'message',
      role: 'user',
      content: 'Current prompt',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    harness.transcript.entries = [prompt];
    useStore.setState({
      activeStreamKeyByConv: { 'conversation-1': 'stream-1' },
      chatStreamingOutput: { 'stream-1': 'Working on it' },
      chatStreamingCompleted: { 'stream-1': false },
      chatRunningByConv: { 'conversation-1': true },
      liveModeEnabled: true,
      liveModeFocusedConversationId: 'conversation-1',
      liveModeCurrentProjectId: 'project-1',
      liveModeEnabledByConversation: { 'conversation-1': true },
    });
    const user = userEvent.setup();
    const { container, queryClient } = renderPage();
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'Typed during the run' },
    });
    await user.click(await screen.findByTitle('Steer current turn (↵)'));
    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="chat-steering-message"]'),
      ).toBeTruthy(),
    );

    // The running turn ends; the pending message then runs as its own turn.
    harness.transcript.entries = [
      prompt,
      {
        id: 'first-reply',
        type: 'message',
        role: 'assistant',
        content: 'First reply',
        created_at: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'steer-pending-1',
        type: 'message',
        role: 'user',
        content: 'Typed during the run',
        steeringDelivery: 'pending',
        created_at: '2026-01-01T00:00:02.000Z',
      },
      {
        id: 'follow-up-reply',
        type: 'message',
        role: 'assistant',
        content: 'Follow-up reply',
        created_at: '2026-01-01T00:00:03.000Z',
      },
    ];
    useStore.setState({
      activeStreamKeyByConv: {},
      chatStreamingOutput: {},
      chatStreamingCompleted: {},
      chatRunningByConv: {},
    });
    await queryClient.invalidateQueries();

    await waitFor(() => {
      expect(
        container.querySelector('[data-message-id="follow-up-reply"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-ui="chat-steering-message"]'),
      ).toBeNull();
    });
    expect(screen.getAllByText('Typed during the run')).toHaveLength(1);
    expect(
      screen
        .getByText('Typed during the run')
        .compareDocumentPosition(screen.getByText('Follow-up reply')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  describe('steer whose delivery the browser could not confirm', () => {
    const prompt = {
      id: 'current-prompt',
      type: 'message',
      role: 'user',
      content: 'Current prompt',
      created_at: '2026-01-01T00:00:00.000Z',
    };

    // The mounted bubble is mocked here; "Delivery not confirmed" is rendered
    // exactly for data-steering-status="unconfirmed".
    const steeringStatus = (container: HTMLElement) =>
      container
        .querySelector('[data-ui="chat-steering-message"]')
        ?.getAttribute('data-steering-status') ?? null;

    async function steerDuringRun() {
      harness.transcript.entries = [prompt];
      useStore.setState({
        activeStreamKeyByConv: { 'conversation-1': 'stream-1' },
        chatStreamingOutput: { 'stream-1': 'Working on it' },
        chatStreamingCompleted: { 'stream-1': false },
        chatRunningByConv: { 'conversation-1': true },
        liveModeEnabled: true,
        liveModeFocusedConversationId: 'conversation-1',
        liveModeCurrentProjectId: 'project-1',
        liveModeEnabledByConversation: { 'conversation-1': true },
      });
      const user = userEvent.setup();
      const rendered = renderPage();
      fireEvent.change(await screen.findByRole('textbox'), {
        target: { value: 'Typed during the run' },
      });
      await user.click(await screen.findByTitle('Steer current turn (↵)'));
      return rendered;
    }

    it('drops the label once the transcript shows the steer as delivered', async () => {
      harness.sendChatMessage.mockImplementation(async () => {
        throw new Error('connection reset');
      });
      const { container, queryClient } = await steerDuringRun();
      await waitFor(() =>
        expect(steeringStatus(container)).toBe('unconfirmed'),
      );

      // A fresh object: the query's structural sharing would otherwise reuse
      // the previously returned (and now mutated) transcript.
      harness.transcript = { entries: [], hasMore: false, nextOffset: 0 };
      harness.transcript.entries = [
        prompt,
        {
          id: 'server-steer-1',
          type: 'message',
          role: 'user',
          content: 'Typed during the run',
          steeringDelivery: 'steered',
          created_at: new Date().toISOString(),
        },
      ];
      await queryClient.invalidateQueries();

      await waitFor(() => expect(steeringStatus(container)).toBe('steered'));
    });

    it('keeps the label while the transcript has no matching message', async () => {
      harness.sendChatMessage.mockImplementation(async () => {
        throw new Error('connection reset');
      });
      const { container, queryClient } = await steerDuringRun();
      await waitFor(() =>
        expect(steeringStatus(container)).toBe('unconfirmed'),
      );

      await queryClient.invalidateQueries();

      await waitFor(() => expect(harness.transcript.entries).toHaveLength(1));
      expect(steeringStatus(container)).toBe('unconfirmed');
    });

    it('treats a follow-up response as accepted, not unconfirmed', async () => {
      harness.sendChatMessage.mockImplementation(async () => ({
        delivery: 'followup',
        userMessage: { id: 'steer-followup-1' },
      }));
      const { container } = await steerDuringRun();

      await waitFor(() =>
        expect(
          container.querySelector('[data-ui="chat-steering-message"]'),
        ).toBeTruthy(),
      );
      expect(steeringStatus(container)).toBe('pending');
    });
  });

  it('admits only one unresolved steering submission per conversation', async () => {
    let resolveSend: ((value: { delivery: string }) => void) | undefined;
    harness.sendChatMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    useStore.setState({
      activeStreamKeyByConv: { 'conversation-1': 'stream-1' },
      chatStreamingOutput: { 'stream-1': 'Working on it' },
      chatStreamingCompleted: { 'stream-1': false },
      chatRunningByConv: { 'conversation-1': true },
      liveModeEnabled: true,
      liveModeFocusedConversationId: 'conversation-1',
      liveModeCurrentProjectId: 'project-1',
      liveModeEnabledByConversation: { 'conversation-1': true },
    });
    const user = userEvent.setup();
    const { container } = renderPage();
    const textarea = (await screen.findByRole(
      'textbox',
    )) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'BULA' } });
    await user.click(await screen.findByTitle('Steer current turn (↵)'));
    await waitFor(() => expect(harness.sendChatMessage).toHaveBeenCalledOnce());

    fireEvent.change(textarea, { target: { value: 'BULA' } });
    await user.click(await screen.findByTitle('Steer current turn (↵)'));

    expect(harness.sendChatMessage).toHaveBeenCalledOnce();
    expect(
      container.querySelectorAll('[data-ui="chat-steering-message"]'),
    ).toHaveLength(1);
    expect(textarea.value).toBe('BULA');

    resolveSend?.({ delivery: 'steered' });
  });

  it('suppresses composer dictation while Live Mode owns the microphone', async () => {
    useStore.setState({
      liveModeEnabled: true,
      liveModeFocusedConversationId: 'conversation-1',
      liveModeCurrentProjectId: 'project-1',
      liveModeEnabledByConversation: { 'conversation-1': true },
    });
    const { container } = renderPage();
    await screen.findByRole('textbox');

    expect(
      container.querySelector('[data-ui="composer-dictation"]'),
    ).toBeNull();
  });

  it('suppresses the ordinary composer while meeting recording owns the microphone', async () => {
    harness.meetingRecording = true;
    const { container } = renderPage();
    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="composer-dictation"]'),
      ).toBeNull(),
    );
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('steers a queued prompt while the initial run remains pending', async () => {
    harness.mainAiUser = { id: 'main-persona' };
    useStore.setState({
      activeStreamKeyByConv: { 'conversation-1': 'run-1' },
      chatStreamingOutput: { 'run-1': '' },
      chatStreamingCompleted: { 'run-1': false },
      chatRunningByConv: { 'conversation-1': true },
      queuedPromptsByConv: {
        'conversation-1': [
          {
            contextKey: 'project-1',
            id: 'queued-1',
            content: 'Steer the current answer',
            bubbleContent: 'Steer the current answer',
            memoryContextLevel: 'off',
            openFileContext: {
              source: 'repo',
              path: 'src/queued.ts',
              repoContext: 'main',
              line: 8,
              column: 2,
            },
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderPage();
    const steer = await screen.findByTitle(
      'Use this queued prompt to steer the running turn',
    );
    expect(steer.hasAttribute('disabled')).toBe(false);
    await user.click(steer);

    await waitFor(() =>
      expect(harness.sendChatMessage).toHaveBeenCalledWith(
        'project-1',
        'Steer the current answer',
        'conversation-1',
        undefined,
        '',
        null,
        false,
        undefined,
        'steer',
        undefined,
        { level: 'off' },
        expect.any(String),
        'personas',
        expect.any(String),
        ['queued-1'],
        undefined,
        {
          source: 'repo',
          path: 'src/queued.ts',
          repoContext: 'main',
          line: 8,
          column: 2,
        },
      ),
    );
  });

  it('withdraws a legacy restored server queue before editing it', async () => {
    useStore.setState({
      activeStreamKeyByConv: { 'conversation-1': 'run-1' },
      chatStreamingOutput: { 'run-1': '' },
      chatStreamingCompleted: { 'run-1': false },
      chatRunningByConv: { 'conversation-1': true },
      queuedPromptsByConv: {
        'conversation-1': [
          {
            contextKey: 'project-1',
            id: 'restored-queued-1',
            content: 'Edit this restored prompt',
            bubbleContent: 'Edit this restored prompt',
            draftContent: 'Edit this restored prompt',
            memoryContextLevel: 'off',
            serverOwned: true,
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Send now')).toBeTruthy();
    expect(screen.getByTitle('Delete queued prompt')).toBeTruthy();
    await user.click(screen.getByTitle('Edit this queued prompt'));

    await waitFor(() =>
      expect(harness.withdrawQueuedChatMessage).toHaveBeenCalledWith(
        'project-1',
        'conversation-1',
        'restored-queued-1',
      ),
    );
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Edit this restored prompt',
      ),
    );
    expect(
      useStore.getState().queuedPromptsByConv['conversation-1'],
    ).toBeUndefined();
  });

  it('lets a Direct receipt be deleted while keeping it and background receipts uneditable', async () => {
    harness.reconcileQueuedChatMessages.mockImplementation(async () => ({
      active: true,
      pending: ['legacy-direct-receipt'],
      consumed: [],
      released: [],
      withdrawn: [],
      queueOwners: { 'legacy-direct-receipt': 'direct' },
    }));
    useStore.setState({
      queuedPromptsByConv: {
        'conversation-1': [
          {
            contextKey: 'project-1',
            id: 'legacy-direct-receipt',
            content: 'Direct owns this prompt',
            bubbleContent: 'Direct owns this prompt',
            memoryContextLevel: 'off',
            serverOwned: true,
          },
          {
            contextKey: 'project-1',
            id: 'legacy-background-receipt',
            content: 'Background drain owns this prompt',
            bubbleContent: 'Background drain owns this prompt',
            memoryContextLevel: 'off',
            serverOwned: true,
          },
        ],
      },
    });

    renderPage();

    await waitFor(() =>
      expect(useStore.getState().queuedPromptsByConv['conversation-1']).toEqual(
        [
          expect.objectContaining({
            id: 'legacy-direct-receipt',
            serverQueueOwner: 'direct',
          }),
          expect.objectContaining({
            id: 'legacy-background-receipt',
            serverQueueOwner: 'server',
          }),
        ],
      ),
    );
    expect(screen.queryByText('Send now')).toBeNull();
    expect(screen.queryByTitle('Edit this queued prompt')).toBeNull();
    // Only the Direct follow-up can be withdrawn; the background receipt stays
    // immutable.
    expect(screen.getAllByTitle('Delete queued prompt')).toHaveLength(1);
    expect(harness.withdrawQueuedChatMessage).not.toHaveBeenCalled();
  });

  it('restores a delayed edit only to its source conversation', async () => {
    const withdrawal = Promise.withResolvers<{
      withdrawn: boolean;
      released: boolean;
    }>();
    harness.withdrawQueuedChatMessage.mockImplementationOnce(
      () => withdrawal.promise,
    );
    harness.conversations = [
      conversation(),
      conversationWith('conversation-2', 'Second conversation'),
    ];
    useStore.setState({
      queuedPromptsByConv: {
        'conversation-1': [
          {
            contextKey: 'project-1',
            id: 'delayed-edit',
            content: 'Keep this in the first conversation',
            bubbleContent: 'Keep this in the first conversation',
            draftContent: 'Keep this in the first conversation',
            memoryContextLevel: 'standard',
            serverOwned: true,
            serverQueueOwner: 'persona',
          },
        ],
      },
      draftByKey: {
        'project-1:conversation-2': 'Second conversation draft',
      },
      memoryLevelByComposerKey: {
        'project-1:conversation-2': 'minimal',
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByTitle('Edit this queued prompt'));
    await waitFor(() =>
      expect(harness.withdrawQueuedChatMessage).toHaveBeenCalledTimes(1),
    );

    act(() => {
      useStore
        .getState()
        .setActiveConvForProject('project-1', 'conversation-2');
    });
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Second conversation draft',
      ),
    );

    withdrawal.resolve({ withdrawn: true, released: false });

    await waitFor(() =>
      expect(useStore.getState().draftByKey['project-1:conversation-1']).toBe(
        'Keep this in the first conversation',
      ),
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Second conversation draft',
    );
    expect(useStore.getState().draftByKey['project-1:conversation-2']).toBe(
      'Second conversation draft',
    );
    expect(
      useStore.getState().memoryLevelByComposerKey['project-1:conversation-1'],
    ).toBe('standard');
    expect(
      useStore.getState().memoryLevelByComposerKey['project-1:conversation-2'],
    ).toBe('minimal');
    expect(
      useStore.getState().queuedPromptsByConv['conversation-1'],
    ).toBeUndefined();
  });

  it('edits a restored prompt when refresh reconciliation releases it first', async () => {
    const reconciliation = Promise.withResolvers<{
      active: boolean;
      pending: string[];
      consumed: string[];
      released: string[];
      withdrawn: string[];
      queueOwners: Record<string, 'persona' | 'direct'>;
    }>();
    const withdrawal = Promise.withResolvers<{
      withdrawn: boolean;
      released: boolean;
    }>();
    harness.reconcileQueuedChatMessages.mockImplementationOnce(
      () => reconciliation.promise,
    );
    harness.withdrawQueuedChatMessage.mockImplementationOnce(
      () => withdrawal.promise,
    );
    useStore.setState({
      queuedPromptsByConv: {
        'conversation-1': [
          {
            contextKey: 'project-1',
            id: 'restored-queued-1',
            content: 'Edit after the release race',
            bubbleContent: 'Edit after the release race',
            draftContent: 'Edit after the release race',
            memoryContextLevel: 'off',
            serverOwned: true,
            serverQueueOwner: 'persona',
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(harness.reconcileQueuedChatMessages).toHaveBeenCalledTimes(1),
    );
    await user.click(await screen.findByTitle('Edit this queued prompt'));
    await waitFor(() =>
      expect(harness.withdrawQueuedChatMessage).toHaveBeenCalledTimes(1),
    );

    reconciliation.resolve({
      active: false,
      pending: [],
      consumed: [],
      released: ['restored-queued-1'],
      withdrawn: [],
      queueOwners: {},
    });
    await waitFor(() =>
      expect(
        useStore.getState().queuedPromptsByConv['conversation-1']?.[0],
      ).toMatchObject({
        id: 'restored-queued-1',
        serverReleased: true,
      }),
    );
    expect(harness.sendChatMessage).not.toHaveBeenCalled();

    withdrawal.resolve({ withdrawn: false, released: true });
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Edit after the release race',
      ),
    );
    expect(
      useStore.getState().queuedPromptsByConv['conversation-1'],
    ).toBeUndefined();
    expect(harness.sendChatMessage).not.toHaveBeenCalled();
  });

  it('renders the pending manual-round participant identity before output arrives', async () => {
    useStore.setState({
      activeStreamKeyByConv: { 'conversation-1': 'run-persona' },
      chatStreamingOutput: { 'run-persona': '' },
      chatStreamingCompleted: { 'run-persona': false },
      chatRunningByConv: { 'conversation-1': true },
      chatStreamPresentation: {
        'run-persona': {
          personaDriven: true,
          canonicalPersonaTurns: false,
          virtualSender: {
            id: 'ada',
            name: 'Ada',
            identity: 'Systems thinker',
            avatarUrl: null,
          },
        },
      },
    });
    const { container } = renderPage();
    const pending = await waitFor(() =>
      container.querySelector('[data-message-id="run-persona"]'),
    );
    expect(pending?.getAttribute('data-streaming')).toBe('true');
    expect(pending?.getAttribute('data-sender-name')).toBe('Ada');
  });

  it('hands a completed stream to its canonical transcript message without duplication', async () => {
    harness.transcript = {
      entries: [
        {
          id: 'canonical-1',
          type: 'message',
          role: 'assistant',
          content: 'Canonical response',
          created_at: new Date().toISOString(),
        },
        {
          id: 'newer-user-prompt',
          type: 'message',
          role: 'user',
          content: 'A newer prompt',
          created_at: new Date(Date.now() + 1000).toISOString(),
        },
      ],
      hasMore: false,
      nextOffset: 0,
    };
    useStore.setState({
      activeStreamKeyByConv: { 'conversation-1': 'run-1' },
      chatStreamingOutput: { 'run-1': 'Canonical response' },
      chatStreamingCompleted: { 'run-1': true },
    });
    const { container } = renderPage();

    await waitFor(() =>
      expect(
        container
          .querySelector('[data-ui="mounted-chat-message"]')
          ?.getAttribute('data-message-id'),
      ).toBe('canonical-1'),
    );
    const message = container.querySelector('[data-ui="mounted-chat-message"]');
    expect(message?.textContent).toBe('Canonical response');
    expect(message?.getAttribute('data-message-id')).toBe('canonical-1');
    expect(message?.getAttribute('data-streaming')).toBe('false');
    expect(
      container.querySelectorAll('[data-ui="mounted-chat-message"]'),
    ).toHaveLength(2);
  });

  it('hands off after an autonomous milestone separates consecutive assistant turns', async () => {
    harness.transcript = {
      entries: [
        {
          id: 'previous-response',
          type: 'message',
          role: 'assistant',
          content: 'The board accepted the recovery.',
          created_at: new Date().toISOString(),
        },
        {
          id: 'task-status',
          type: 'system_milestone',
          role: 'system',
          content: 'Task status changed to in_progress',
          taskId: 'task-1',
          taskTitle: 'Repair the task',
          eventId: 'event-1',
          eventType: 'status_changed',
          payload: {},
          created_at: new Date(Date.now() + 1000).toISOString(),
        },
        {
          id: 'canonical-current-response',
          type: 'message',
          role: 'assistant',
          content: 'The resumed worker is now active.',
          created_at: new Date(Date.now() + 2000).toISOString(),
        },
      ],
      hasMore: false,
      nextOffset: 0,
    };
    useStore.setState({
      activeStreamKeyByConv: { 'conversation-1': 'run-1' },
      chatStreamingOutput: { 'run-1': 'The resumed worker is now active.' },
      chatStreamingCompleted: { 'run-1': true },
    });
    const { container } = renderPage();

    await waitFor(() =>
      expect(
        container.querySelectorAll(
          '[data-message-id="canonical-current-response"]',
        ),
      ).toHaveLength(1),
    );
    expect(
      container.querySelector('[data-ui="chat-generic-main-stream"]'),
    ).toBeNull();
    expect(container.textContent).toContain('The board accepted the recovery.');
    expect(container.textContent).toContain(
      'The resumed worker is now active.',
    );
  });
});

describe('Chat failure recovery affordance', () => {
  const liveCapacityBuffer =
    'I updated the first two files.⚠️ **LLM Error**: Responses API stream ended unsuccessfully: Selected model is at capacity. Please try a different model.';

  async function findRecoveryAffordance() {
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="chat-failure-recovery"]'),
      ).toBeTruthy(),
    );
    const recovery = document.querySelector<HTMLElement>(
      '[data-ui="chat-failure-recovery"]',
    )!;
    const action = recovery.querySelector<HTMLElement>(
      '[data-ui="chat-failure-recovery-action"]',
    );
    return { recovery, action };
  }

  it('offers Continue in the live buffer when capacity fails after assistant output', async () => {
    harness.transcript = {
      entries: [
        {
          id: 'u1',
          type: 'message',
          role: 'user',
          content: 'Update the first two files',
          created_at: new Date().toISOString(),
        },
      ],
      hasMore: false,
      nextOffset: 0,
    };
    // The live buffer after the run streamed output and then failed on a
    // capacity diagnostic: chunks concatenate without a separator.
    useStore.setState({
      activeStreamKeyByConv: { 'conversation-1': 'run-1' },
      chatStreamingOutput: { 'run-1': liveCapacityBuffer },
      chatStreamingCompleted: { 'run-1': true },
    });
    renderPage();

    const { recovery, action } = await findRecoveryAffordance();
    expect(recovery.textContent).toContain('stopped after a partial response');
    expect(action?.textContent).toContain('Continue');

    fireEvent.click(action!);
    await waitFor(() => expect(harness.sendChatMessage).toHaveBeenCalled());
    const call = harness.sendChatMessage.mock.calls.at(-1) as unknown[];
    expect(call[0]).toBe('project-1');
    expect(call[1]).toBe(
      'Continue from where you stopped. Do not repeat completed work.',
    );
    expect(call[2]).toBe('conversation-1');
  });

  it('re-shows Continue for a persisted sandbox failure that kept its output', async () => {
    harness.transcript = {
      entries: [
        {
          id: 'u1',
          type: 'message',
          role: 'user',
          content: 'Update the first two files',
          created_at: new Date().toISOString(),
        },
        {
          id: 'a1',
          type: 'message',
          role: 'assistant',
          content:
            'I updated the first two files.\n\n⚠️ **Sandbox Error**: Error: Selected model is at capacity. Please try a different model.',
          created_at: new Date(Date.now() + 1000).toISOString(),
        },
      ],
      hasMore: false,
      nextOffset: 0,
    };
    renderPage();

    const { recovery, action } = await findRecoveryAffordance();
    expect(recovery.textContent).toContain('stopped after a partial response');
    expect(action?.textContent).toContain('Continue');
  });

  it('re-shows Retry last prompt for a persisted immediate capacity failure', async () => {
    harness.transcript = {
      entries: [
        {
          id: 'u1',
          type: 'message',
          role: 'user',
          content: 'Update the first two files',
          created_at: new Date().toISOString(),
        },
        {
          id: 'a1',
          type: 'message',
          role: 'assistant',
          content:
            '⚠️ **LLM Error**: Responses API stream ended unsuccessfully: Selected model is at capacity. Please try a different model.',
          created_at: new Date(Date.now() + 1000).toISOString(),
        },
      ],
      hasMore: false,
      nextOffset: 0,
    };
    renderPage();

    const { recovery, action } = await findRecoveryAffordance();
    expect(recovery.textContent).toContain('Retry the last prompt');
    expect(action?.textContent).toContain('Retry last prompt');
  });

  it('does not offer recovery for a user-stopped response', async () => {
    harness.transcript = {
      entries: [
        {
          id: 'u1',
          type: 'message',
          role: 'user',
          content: 'Update the first two files',
          created_at: new Date().toISOString(),
        },
        {
          id: 'a1',
          type: 'message',
          role: 'assistant',
          content: '⚠️ Run stopped by user.',
          created_at: new Date(Date.now() + 1000).toISOString(),
        },
      ],
      hasMore: false,
      nextOffset: 0,
    };
    const { container } = renderPage();

    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="chat-mounted-transcript-window"]'),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(container.querySelector('[data-message-id="u1"]')).toBeTruthy(),
    );
    expect(
      container.querySelector('[data-ui="chat-failure-recovery"]'),
    ).toBeNull();
  });
});

describe('ChatPage conversation search across unloaded pages', () => {
  function mockPages(matchTitle: string | null) {
    const rows = Array.from({ length: 101 }, (_, i) =>
      conversationWith(
        `page-conv-${i}`,
        i === 100 && matchTitle ? matchTitle : `Topic ${i}`,
      ),
    );
    vi.mocked(apiFetchConversations).mockImplementation((async (
      _projectId: string,
      limit: number,
      offset: number,
    ) => rows.slice(offset, offset + limit)) as never);
  }

  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    harness.config = { enableChat: true };
    useStore.setState({ activeConvByProject: { 'project-1': null } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function typeSearch(container: HTMLElement, text: string) {
    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>(
        '[data-ui="conversation-search"]',
      );
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(screen.getByText('Topic 0')).toBeTruthy());
    fireEvent.change(input, { target: { value: text } });
    return input;
  }

  it('loads pages until a match on the last page appears', async () => {
    mockPages('Quarterly budget planning');
    const { container } = renderPage();
    await typeSearch(container, 'budget');
    await waitFor(() =>
      expect(screen.getByText('Quarterly budget planning')).toBeTruthy(),
    );
    expect(vi.mocked(apiFetchConversations)).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('No matching conversations.')).toBeNull();
  });

  it('shows the empty text only after the last page loaded', async () => {
    mockPages(null);
    const { container } = renderPage();
    await typeSearch(container, 'budget');
    await waitFor(() =>
      expect(screen.getByText('No matching conversations.')).toBeTruthy(),
    );
    expect(vi.mocked(apiFetchConversations)).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Searching...')).toBeNull();
  });

  it('stops loading pages once the search is cleared', async () => {
    mockPages(null);
    const gate: { release: () => void } = { release: () => undefined };
    const rows = Array.from({ length: 101 }, (_, i) =>
      conversationWith(`page-conv-${i}`, `Topic ${i}`),
    );
    vi.mocked(apiFetchConversations).mockImplementation((async (
      _projectId: string,
      limit: number,
      offset: number,
    ) => {
      if (offset === 50)
        await new Promise<void>((resolve) => (gate.release = resolve));
      return rows.slice(offset, offset + limit);
    }) as never);
    const { container } = renderPage();
    const input = await typeSearch(container, 'budget');
    await waitFor(() =>
      expect(vi.mocked(apiFetchConversations)).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByText('Searching...')).toBeTruthy();
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => gate.release());
    await waitFor(() => expect(screen.queryByText('Searching...')).toBeNull());
    expect(vi.mocked(apiFetchConversations)).toHaveBeenCalledTimes(2);
  });
});
