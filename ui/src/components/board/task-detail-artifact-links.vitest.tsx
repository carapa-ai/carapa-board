import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as BoardRoute } from '@/routes/board.$projectId';
import { useStore } from '@/store';
import { publishOpenFileContext } from '@/lib/open-file-context';
import type { TaskMessage } from '@/types';

const PROJECT_ID = 'project-1';
const TASK_ID = 'task-artifact-link';
const REPORT_HREF = '/workspace/group/artifacts/reports/report.md';
const FOREIGN_HREF = '/artifacts/other-project/review.md';

const transcript: TaskMessage[] = [
  {
    id: 'message-artifact-link',
    task_id: TASK_ID,
    role: 'assistant',
    content: `Phase 1 complete. [Report](${REPORT_HREF}) has the details, while [foreign](${FOREIGN_HREF}) points to another project.`,
    created_at: '2026-09-13T00:00:00.000Z',
  },
];

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchConfig: vi.fn(async () => ({ enableKanban: true, enableChat: true })),
  apiFetch: vi.fn(
    async (_url: string, init?: RequestInit) =>
      new Response(init?.method === 'HEAD' ? null : 'content', {
        status: 200,
        headers: { 'Content-Length': '7', 'Content-Type': 'text/plain' },
      }),
  ),
  fetchTaskMessages: vi.fn(async () => ({
    messages: transcript,
    total: transcript.length,
    hasMore: false,
    nextOffset: transcript.length,
  })),
  fetchTaskRuns: vi.fn(async () => ({
    runs: [],
    latest_scored_review_run: null,
    total: 0,
    stageDurations: [],
    persistent_comments: [],
  })),
  fetchTaskRecordings: vi.fn(async () => []),
  EditableFileConflictError: class extends Error {},
  loadEditableFile: vi.fn(async () => ({
    content: 'saved content',
    revision: 'a'.repeat(64),
    sensitive: false,
  })),
  parseFileContentResponse: vi.fn(async () => 'content'),
  readGroupFileContent: vi.fn(async () => ({ content: 'content' })),
  readRepoFileContent: vi.fn(async () => ({ content: 'content' })),
  saveEditableFile: vi.fn(),
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

vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({
    data: [
      {
        id: TASK_ID,
        project_id: PROJECT_ID,
        title: 'Artifact link task',
        description: 'Writes a sandbox-root report link.',
        status: 'backlog',
        priority: 0,
        created_at: '2026-09-13T00:00:00.000Z',
        running: false,
        archived: false,
        error: null,
        owner: null,
        latestTrigger: null,
        depends_on_ids: [],
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
        name: 'Artifact project',
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
  useProject: () => ({
    data: { id: PROJECT_ID, userId: 'owner', accessLevel: 'owner' },
  }),
  useAcknowledgeVisibleKanbanCompletions: () => undefined,
}));

vi.mock('@/components/layout/header', () => ({ Header: () => null }));
vi.mock('@/components/board/kanban-board', () => ({ KanbanBoard: () => null }));
vi.mock('@/components/layout/project-dialogs', async () => {
  const { TaskDetailDialog } = await vi.importActual<
    typeof import('@/components/board/task-detail-dialog')
  >('@/components/board/task-detail-dialog');
  return {
    ProjectDialogs: ({ project_id }: { project_id: string }) => (
      <TaskDetailDialog project_id={project_id} />
    ),
  };
});
vi.mock('@/components/chat/conversation-explorer', () => ({
  ConversationExplorer: ({
    previewStrip,
    previewBody,
    tabValue,
    onClose,
    onTabValueChange,
  }: {
    previewStrip?: React.ReactNode;
    previewBody?: React.ReactNode;
    tabValue?: string;
    onClose?: () => void;
    onTabValueChange?: (value: string) => void;
  }) => (
    <div
      data-ui="test-conversation-explorer"
      data-selected-view={tabValue ?? 'files'}
    >
      {previewStrip}
      {tabValue === 'preview' && previewBody}
      <button
        data-ui="test-files-tab"
        onClick={() => onTabValueChange?.('files')}
      >
        Files
      </button>
      <button data-ui="test-panel-close" onClick={onClose}>
        Close panel
      </button>
    </div>
  ),
}));
vi.mock('@/hooks/use-secure-media', () => ({
  useSecureMedia: (url: string) => url,
}));
vi.mock('@/lib/auth', () => {
  const state = { user: { id: 'owner', role: 'admin', username: 'owner' } };
  return {
    useAuth: (selector?: (s: typeof state) => unknown) =>
      typeof selector === 'function' ? selector(state) : state,
  };
});
vi.mock('@/hooks/use-live-voice', () => ({
  useLiveVoice: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    finish: vi.fn(),
    status: 'idle',
    capturing: false,
  }),
  useDictationFailureToast: () => undefined,
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
vi.mock('@/lib/use-tts', () => ({
  useTts: () => ({
    activeId: null,
    loading: false,
    toggle: vi.fn(),
    stop: vi.fn(),
  }),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
    convertFileSrc: (value: string) => value,
  },
  registerPlugin: () => ({
    notify: vi.fn(),
    listen: vi.fn(async () => vi.fn()),
  }),
}));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: {
    writeFile: vi.fn(),
    read: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
    deleteFile: vi.fn(),
  },
  Directory: {
    Cache: 'CACHE',
    Documents: 'DOCUMENTS',
    External: 'EXTERNAL',
    ExternalDocs: 'EXTERNAL_DOCUMENTS',
  },
}));
vi.mock('@capacitor-community/file-opener', () => ({
  FileOpener: { open: vi.fn() },
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

/**
 * Mount the real board route (BoardPage + ProjectDialogs) under a memory
 * router at /board/<PROJECT_ID> so the test exercises the production
 * boundary end to end: link click -> openPreviewTab -> pending-activation
 * marker -> useWorkspacePaneReveal -> ProjectWorkspacePane mount.
 */
function renderBoard() {
  const rootRoute = createRootRoute({ component: Outlet });
  const boardRoute = BoardRoute.update({
    id: '/board/$projectId',
    path: '/board/$projectId',
    getParentRoute: () => rootRoute,
  } as any);
  const routeTree = rootRoute.addChildren([boardRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/board/${PROJECT_ID}`] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

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
  } as unknown as typeof ResizeObserver;
  // jsdom does not implement window.matchMedia; the preview pane's markdown
  // editor probes it directly.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  // The pane's open state persists per project; start each test closed.
  window.localStorage.clear();
  publishOpenFileContext(null);
  useStore.setState({
    detailTaskId: TASK_ID,
    detailTaskTab: 'chat',
    reviewRunIntent: null,
    streamingOutput: {},
    liveTaskIds: {},
    previewTabsByProject: {},
    pendingPreviewActivationByProject: {},
    workspaceViewByProject: {},
  });
});

afterEach(() => {
  window.localStorage.clear();
  publishOpenFileContext(null);
  useStore.getState().setDetailTaskId(null);
  useStore.setState({
    previewTabsByProject: {},
    pendingPreviewActivationByProject: {},
    workspaceViewByProject: {},
  });
});

describe('TaskDetailDialog artifact links on the board', () => {
  it('reveals the hidden workspace pane for a sandbox-root artifact link', async () => {
    const href = REPORT_HREF;
    const path = 'artifacts/reports/report.md';
    transcript[0].content = `[Report](${href}) [foreign](${FOREIGN_HREF})`;
    renderBoard();

    // The pane starts hidden (no persisted open state, no preview tabs).
    expect(
      document.querySelector('[data-ui="kanban-workspace-pane"]'),
    ).toBeNull();

    const link = await screen.findByRole('link', { name: 'Report' });
    // The rendered anchor keeps the raw sandbox-root href; only the click
    // is intercepted.
    expect(link.getAttribute('href')).toBe(href);
    fireEvent.click(link);

    // The pending-activation marker must actually mount the pane, not just
    // sit in the store: the pane element appears after the click.
    await waitFor(() => {
      expect(
        document.querySelector('[data-ui="kanban-workspace-pane"]'),
      ).not.toBeNull();
    });

    // The revealed pane lands on the activated file preview. The open
    // dialog keeps the board subtree aria-hidden, so query the strip and
    // body directly instead of using role queries.
    const tab = await waitFor(() => {
      const candidate = document.querySelector(
        '[role="tab"][title="report.md"]',
      );
      if (!candidate) throw new Error('preview tab not found');
      return candidate;
    });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(
      document.querySelector('[data-ui="open-file-preview-body"]'),
    ).not.toBeNull();

    const state = useStore.getState();
    const preview = state.previewTabsByProject[PROJECT_ID];
    expect(preview?.tabs).toHaveLength(1);
    expect(preview?.activeTabId).toBe(`group:${path}`);
    expect(preview?.tabs[0]?.path).toBe(path);
    expect(preview?.tabs[0]?.source).toBe('group');
    // ... with the project-scoped explorer view on Preview, so the
    // Files explorer stays available above the file tab.
    expect(state.workspaceViewByProject[PROJECT_ID]).toBe('preview');
    // The mounted pane consumed the pending-activation marker.
    expect(state.pendingPreviewActivationByProject[PROJECT_ID]).toBeUndefined();
    // The anchor's href is never rewritten.
    expect(link.getAttribute('href')).toBe(href);
  });
});
