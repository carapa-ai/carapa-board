import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { TASK_OUTPUT_TAIL_PAGE_BYTES } from '@/lib/task-message-rendering';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import type { TaskMessage } from '@/types';
import { TaskDetailDialog } from './task-detail-dialog';

const PROJECT_ID = 'project-bigmsg';
const TASK_ID = 'task-bigmsg';

interface TranscriptPage {
  messages: TaskMessage[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
}

const server = vi.hoisted(() => ({
  page: null as null | TranscriptPage,
  // The incident row content, shared with the output-page mock below.
  // A trailing newline is kept in the raw stored content (the server's paging
  // coordinates) but stripped from the display text.
  bigContent: '`x`'.repeat(550_000) + '\n',
  outputCalls: [] as string[],
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  // Faithful to the real `/output?messageId=` response for a run-less row:
  // the whole message as a single entry, whatever `limit` was requested.
  apiFetch: vi.fn(async (url: string) => {
    server.outputCalls.push(url);
    const totalBytes = new TextEncoder().encode(server.bigContent).byteLength;
    return {
      ok: true,
      json: async () => ({
        content: server.bigContent,
        nextCursor: 0,
        hasMore: true,
        total: totalBytes,
        runId: null,
        entries: [
          {
            id: 'message:msg-big',
            content: server.bigContent,
            startOffset: 0,
            endOffset: totalBytes,
          },
        ],
      }),
    };
  }),
  fetchConfig: vi.fn(async () => ({ ttsEnabled: false })),
  fetchTaskMessages: vi.fn(async () => {
    if (!server.page) throw new Error('Missing transcript page');
    return server.page;
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
  uploadAttachment: vi.fn(),
  sendTaskMessage: vi.fn(),
}));

// Render the bubble's Markdown through a passthrough so the test measures
// exactly how much text the paging window hands to the renderer.
vi.mock('@/components/markdown-content-lazy', () => ({
  MarkdownContent: ({ children }: { children: string }) => <>{children}</>,
}));
vi.mock('@/hooks/use-secure-media', () => ({
  useSecureMedia: (url: string) => ({
    secureUrl: url,
    loading: false,
    error: null,
  }),
}));
vi.mock('@/components/secure-image', () => ({
  SecureImage: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <img {...props} />
  ),
}));
vi.mock('@/lib/live-persona-reveal', () => ({
  clearLivePersonaReveal: vi.fn(),
  useLivePersonaReveal: () => null,
}));
vi.mock('@/lib/use-tts', () => ({
  useTts: () => ({
    status: 'idle',
    activeId: null,
    play: vi.fn(),
    stop: vi.fn(),
  }),
}));

const tasks = [
  {
    id: TASK_ID,
    title: 'Big message task',
    description: 'Run-less oversized assistant row',
    status: 'completed',
    priority: 0,
    created_at: '2026-10-21T00:00:00.000Z',
    running: false,
    archived: false,
    error: null,
    owner: null,
    latestTrigger: null,
    depends_on_ids: [],
    skip_stages: [],
  },
];

vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({ data: tasks }),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: PROJECT_ID,
        name: 'Big message project',
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
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ projectId: PROJECT_ID }),
}));
// Cut the `@/lib/api -> auth -> router -> routeTree.gen -> chat-page`
// import cycle for the `@/lib/api` mock's `importOriginal` above. Without
// this, evaluating the real `api.ts` reaches `chat-message-bubble`, whose
// re-entrant `@/lib/api` import then binds the real `apiFetch` instead of
// the mock (one click would fetch the whole message for real). Nothing in
// this dialog graph uses the router object (only auth-gate/main do).
vi.mock('@/lib/router', () => ({ router: undefined }));

beforeEach(() => {
  // One run-less assistant row: 1.6 MB on a single line with many backticks,
  // mirroring the incident transcript row (no run_id, no entry_type).
  server.outputCalls = [];
  const message: TaskMessage = {
    id: 'msg-big',
    task_id: TASK_ID,
    role: 'assistant',
    content: server.bigContent,
    created_at: '2026-10-21T00:10:00.000Z',
  };
  server.page = {
    messages: [message],
    total: 1,
    hasMore: false,
    nextOffset: 1,
  };
  useStore.setState({
    detailTaskId: null,
    reviewRunIntent: null,
    liveTaskIds: {},
    streamingOutput: {},
    taskStreamRunIds: {},
  });
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
  cleanup();
  useStore.getState().setDetailTaskId(null);
});

describe('TaskDetailDialog run-less oversized assistant message', () => {
  it('renders only the newest tail and offers loading earlier output', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    useStore.setState({ detailTaskId: TASK_ID });
    render(
      <QueryClientProvider client={queryClient}>
        <TaskDetailDialog project_id={PROJECT_ID} />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        document.querySelector('[data-ui="task-output-gap-loader"]'),
      ).toBeTruthy();
    });

    let beforeClick = 0;
    await waitFor(() => {
      const bubble = document.querySelector(
        '[data-ui="chat-message-content"][data-message-id="msg-big"]',
      );
      expect(bubble).toBeTruthy();
      // Newest 32 KiB tail plus the short "output omitted" marker.
      expect(bubble!.textContent!.length).toBeLessThanOrEqual(36 * 1024);
      beforeClick = bubble!.textContent!.length;
    });
    // Gap offsets are raw stored bytes, so the gap ends at the raw tail start.
    const totalBytes = new TextEncoder().encode(server.bigContent).byteLength;
    const loader = () =>
      document.querySelector('[data-ui="task-output-gap-loader"]')!;
    expect(loader().getAttribute('data-gap-end')).toBe(
      String(totalBytes - TASK_OUTPUT_TAIL_PAGE_BYTES),
    );

    // One click must add at most about one more page even though the server
    // answers with the whole message as a single entry.
    fireEvent.click(
      document.querySelector('[data-ui="task-output-gap-loader"]')!,
    );
    // The page merges asynchronously. The bubble text also contains the loader
    // label, which grows while the request is pending, so wait for the merge
    // itself: the gap moves back by exactly one page, with no phantom gap at
    // the end from a mismatched total.
    await waitFor(() => {
      expect(loader().getAttribute('data-gap-end')).toBe(
        String(totalBytes - 2 * TASK_OUTPUT_TAIL_PAGE_BYTES),
      );
    });
    const bubble = document.querySelector(
      '[data-ui="chat-message-content"][data-message-id="msg-big"]',
    );
    expect(bubble).toBeTruthy();
    const afterClick = bubble!.textContent!.length;
    expect(afterClick).toBeGreaterThan(beforeClick);
    expect(afterClick - beforeClick).toBeLessThanOrEqual(36 * 1024);
    expect(
      server.outputCalls.some(
        (url) =>
          url.includes('messageId=msg-big') && url.includes('beforeOffset='),
      ),
    ).toBe(true);
    // Older content remains, so the loader stays for the next page.
    expect(
      document.querySelector('[data-ui="task-output-gap-loader"]'),
    ).toBeTruthy();
  });
});
