import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import { chooseOption, selectedLabel } from '@/test-utils/select';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { ComponentType } from 'react';
import { Route } from './memory-review';
import type { HistoryReviewProject } from '@/lib/api';

const fetchProjects = vi.hoisted(() => vi.fn());
const fetchHistoryReviewBatches = vi.hoisted(() => vi.fn());
const fetchHistoryReviewBatch = vi.hoisted(() => vi.fn());
const fetchRuntimeCatalog = vi.hoisted(() => vi.fn());
const fetchExistingMemoriesPage = vi.hoisted(() => vi.fn());
const startHistoryReviewGeneration = vi.hoisted(() => vi.fn());
const acceptPartialHistoryReviewBatch = vi.hoisted(() => vi.fn());
const fetchProjectMemoryAudits = vi.hoisted(() => vi.fn());
const fetchProjectMemoryAudit = vi.hoisted(() => vi.fn());
const fetchProjectMemoryAuditReport = vi.hoisted(() => vi.fn());
const reviewProjectMemoryAuditItem = vi.hoisted(() => vi.fn());
const updateHistoryReviewOperation = vi.hoisted(() => vi.fn());
const routeSearch = vi.hoisted(() => ({
  current: { mode: 'history' } as Record<string, string>,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const fetchUnreadNotifications = vi.hoisted(() =>
  vi.fn(async () => ({ items: [], count: 0 })),
);

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    createFileRoute: () => (options: Record<string, unknown>) => ({
      ...options,
      useSearch: () => routeSearch.current,
    }),
  };
});

vi.mock('@/lib/auth', () => ({
  useAuth: (
    selector?: (state: {
      user: { id: string; role: string } | null;
    }) => unknown,
  ) => {
    const state = { user: { id: 'user-1', role: 'admin' } };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/lib/api', () => ({
  fetchProjects,
  cachedProjects: () => undefined,
  fetchHistoryReviewBatches,
  fetchHistoryReviewBatch,
  fetchRuntimeCatalog,
  fetchExistingMemoriesPage,
  startHistoryReviewGeneration,
  acceptPartialHistoryReviewBatch,
  fetchProjectMemoryAudits,
  fetchProjectMemoryAudit,
  fetchProjectMemoryAuditReport,
  reviewProjectMemoryAuditItem,
  updateHistoryReviewOperation,
  fetchUnreadNotifications,
  fetchAttention: async () => ({ items: [], objectives: [] }),
}));

const batchSummary = {
  id: 'project-history-batch-20260801.json',
  created_at: '2026-08-01T00:00:00.000Z',
  cutoff_at: '2026-08-01T00:00:00.000Z',
  projectId: null,
  since: null,
  until: '2026-08-01T00:00:00.000Z',
  reflectorModel: 'configured-reflector',
  status: 'preview',
  projects: 3,
  ready: 1,
  applied: 0,
  errors: 0,
  pending_operations: 5,
  reviewed_operations: 4,
};

function makeProject(
  overrides: Partial<HistoryReviewProject>,
): HistoryReviewProject {
  return {
    batch_id: batchSummary.id,
    batch_status: 'preview',
    project_id: 'alpha',
    project_status: 'preview',
    created_at: '2026-08-01T00:00:00.000Z',
    cutoff_at: '2026-08-01T00:00:00.000Z',
    progress: {
      conversations_processed: 12,
      conversations_total: 30,
      memory_files_processed: 4,
      memory_files_total: 10,
    },
    counts: {
      operations: 0,
      pending: 0,
      approved: 0,
      eval: 0,
      rejected: 0,
      mandatory: 0,
      skipped_groups: 0,
    },
    operations: [],
    skipped_candidates: [],
    errors: [],
    ignored_errors: [],
    review_revision: 1,
    manifest_fingerprint: null,
    review_stale: false,
    review_enabled: true,
    apply_enabled: true,
    ...overrides,
  };
}

// Zero pending, has reviewed outcomes: no badge, outcome line visible.
const alphaProject = makeProject({
  project_id: 'alpha',
  counts: {
    operations: 2,
    pending: 0,
    approved: 2,
    eval: 0,
    rejected: 0,
    mandatory: 0,
    skipped_groups: 0,
  },
});

// Pending plus reviewed outcomes: badge, outcome line without the pending count.
const betaProject = makeProject({
  project_id: 'beta',
  project_status: 'preview',
  counts: {
    operations: 5,
    pending: 3,
    approved: 2,
    eval: 0,
    rejected: 0,
    mandatory: 0,
    skipped_groups: 0,
  },
});

// All operations pending: badge only, no outcome line.
const gammaProject = makeProject({
  project_id: 'gamma',
  counts: {
    operations: 2,
    pending: 2,
    approved: 0,
    eval: 0,
    rejected: 0,
    mandatory: 0,
    skipped_groups: 0,
  },
});

function mockBatchApi() {
  fetchProjects.mockResolvedValue([
    { id: 'alpha', name: 'Alpha Project', folder: 'alpha' },
    { id: 'beta', name: 'Beta Project', folder: 'beta' },
    { id: 'gamma', name: 'Gamma Project', folder: 'gamma' },
  ]);
  fetchHistoryReviewBatches.mockResolvedValue({ batches: [batchSummary] });
  fetchHistoryReviewBatch.mockResolvedValue({
    batch: batchSummary,
    projects: [alphaProject, betaProject, gammaProject],
  });
  fetchRuntimeCatalog.mockResolvedValue({
    version: 2,
    harnesses: [
      {
        id: 'direct',
        label: 'Direct',
        kind: 'direct',
        sessionFamily: 'direct',
      },
    ],
    models: [
      {
        id: 'configured-reflector',
        label: 'Configured Reflector',
        capabilities: [],
        bindings: [
          {
            harnessId: 'direct',
            runtimeId: 'llm:direct:configured-reflector',
            reasoning: { options: [] },
          },
        ],
      },
      {
        id: 'qwen-3.8',
        label: 'Local Qwen 3.8',
        capabilities: [],
        bindings: [
          {
            harnessId: 'direct',
            runtimeId: 'llm:direct:qwen-3.8',
            reasoning: { options: [] },
          },
        ],
      },
    ],
    presets: [],
    defaults: {
      chat: { harnessId: 'direct', modelId: 'configured-reflector' },
      kanban: {
        fallback: { harnessId: 'direct', modelId: 'configured-reflector' },
        stages: {},
      },
      reflector: { harnessId: 'direct', modelId: 'configured-reflector' },
    },
  });
  startHistoryReviewGeneration.mockResolvedValue({
    batchId: 'project-history-batch-generated.json',
  });
}

// The mocked createFileRoute spreads the route options (including
// `component`) into the returned object; the public Route type does not
// expose the component, so narrow it here.
const Page = (Route as unknown as { component: ComponentType }).component;

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <Page />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  fetchProjects.mockReset();
  fetchHistoryReviewBatches.mockReset();
  fetchHistoryReviewBatch.mockReset();
  fetchRuntimeCatalog.mockReset();
  fetchExistingMemoriesPage.mockReset();
  startHistoryReviewGeneration.mockReset();
  acceptPartialHistoryReviewBatch.mockReset();
  fetchProjectMemoryAudits.mockReset();
  fetchProjectMemoryAudit.mockReset();
  fetchProjectMemoryAuditReport.mockReset();
  reviewProjectMemoryAuditItem.mockReset();
  updateHistoryReviewOperation.mockReset();
  routeSearch.current = { mode: 'history' };
  toast.success.mockReset();
  toast.error.mockReset();
  vi.restoreAllMocks();
});

it('reports failed partial recovery and refreshes controls after successful recovery', async () => {
  mockBatchApi();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const failed = {
    batch: { ...batchSummary, status: 'error', ready: 0, errors: 1 },
    projects: [
      makeProject({
        project_status: 'error',
        batch_status: 'error',
        errors: ['Partial preview cannot be finalized'],
        review_enabled: false,
        apply_enabled: false,
      }),
    ],
  };
  fetchHistoryReviewBatches.mockResolvedValue({ batches: [failed.batch] });
  fetchHistoryReviewBatch.mockResolvedValue(failed);
  acceptPartialHistoryReviewBatch.mockResolvedValueOnce(failed);
  const user = userEvent.setup();
  renderPage();
  await user.click(
    await screen.findByRole('button', { name: 'Ignore errors & continue' }),
  );
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Partial preview cannot be finalized'),
    ),
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole('button', {
        name: 'Apply approved',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  const recovered = { batch: batchSummary, projects: [alphaProject] };
  fetchHistoryReviewBatches.mockResolvedValue({ batches: [batchSummary] });
  fetchHistoryReviewBatch.mockResolvedValue(recovered);
  acceptPartialHistoryReviewBatch.mockResolvedValueOnce(recovered);
  await user.click(
    screen.getByRole('button', { name: 'Ignore errors & continue' }),
  );
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(
    (
      screen.getByRole('button', {
        name: 'Apply approved',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

describe('history proposal generation', () => {
  it('defaults to CarapaBoard and 48 hours while allowing a local Qwen override', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'));
    mockBatchApi();
    fetchProjects.mockResolvedValue([
      { id: 'main', name: 'CarapaBoard', folder: 'main' },
      { id: 'alpha', name: 'Alpha Project', folder: 'alpha' },
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Generate proposals' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('button', {
        name: 'History proposal project',
      }).textContent,
    ).toContain('CarapaBoard');
    expect(
      within(dialog).getByText(/Configured default:/).textContent,
    ).toContain('Configured Reflector');

    const runtimeSelects = dialog.querySelectorAll<HTMLElement>(
      '[data-ui="history-proposal-runtime-picker"] [role="combobox"]',
    );
    expect(runtimeSelects).toHaveLength(3);
    await chooseOption(runtimeSelects[1]!, 'Local Qwen 3.8');
    vi.setSystemTime(new Date('2026-09-12T11:00:00.000Z'));
    await user.click(
      within(dialog).getByRole('button', { name: 'Generate proposals' }),
    );

    await waitFor(() =>
      expect(startHistoryReviewGeneration).toHaveBeenCalledTimes(1),
    );
    const payload = startHistoryReviewGeneration.mock.calls[0]![0];
    expect(payload).toMatchObject({
      projectId: 'main',
      reflectorRuntime: { harnessId: 'direct', modelId: 'qwen-3.8' },
    });
    expect(Date.parse(payload.until) - Date.parse(payload.since)).toBe(
      48 * 60 * 60 * 1000,
    );
    expect(payload.until).toBe('2026-09-12T11:00:00.000Z');
  });

  it('preserves explicitly edited period boundaries', async () => {
    mockBatchApi();
    fetchProjects.mockResolvedValue([
      { id: 'main', name: 'CarapaBoard', folder: 'main' },
    ]);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Generate proposals' }),
    );
    const dialog = await screen.findByRole('dialog');
    const since = dialog.querySelector<HTMLInputElement>(
      '[data-ui="history-proposal-since"]',
    )!;
    const until = dialog.querySelector<HTMLInputElement>(
      '[data-ui="history-proposal-until"]',
    )!;
    await user.clear(since);
    await user.type(since, '2026-09-01T08:30');
    await user.clear(until);
    await user.type(until, '2026-09-02T09:45');
    await user.click(
      within(dialog).getByRole('button', { name: 'Generate proposals' }),
    );

    await waitFor(() =>
      expect(startHistoryReviewGeneration).toHaveBeenCalledTimes(1),
    );
    expect(startHistoryReviewGeneration.mock.calls[0]![0]).toMatchObject({
      since: new Date('2026-09-01T08:30').toISOString(),
      until: new Date('2026-09-02T09:45').toISOString(),
    });
  });
});

describe('memory review history sidebar pending badges', () => {
  it('shows a pending badge only for projects with pending audits', async () => {
    mockBatchApi();
    const { container } = renderPage();

    // The badge only exists once the batch query has resolved.
    const badge = await screen.findByText('3 pending');

    const sidebar = container.querySelector<HTMLElement>(
      '[data-ui="memory-review-project-sidebar"]',
    );
    expect(sidebar).toBeTruthy();
    expect(sidebar!.contains(badge)).toBe(true);

    // One badge per pending project: beta (3) and gamma (2), none for alpha.
    const badges = sidebar!.querySelectorAll('[data-slot="badge"]');
    expect(badges).toHaveLength(2);

    // The badge sits inside the beta project button.
    const betaButton = within(sidebar!).getByRole('button', { name: /beta/ });
    expect(betaButton.contains(badge)).toBe(true);

    // The badge is grouped with the project status in the button's status
    // row. Keep the check order-agnostic: assert both the status label and
    // the badge text are present in the same group, not their exact order.
    const statusRow = badge.parentElement;
    expect(statusRow).toBeTruthy();
    expect(statusRow!.textContent).toContain('preview');
    expect(statusRow!.textContent).toContain('3 pending');

    // The zero-pending project button has no badge.
    const alphaButton = within(sidebar!).getByRole('button', { name: /alpha/ });
    expect(alphaButton.querySelector('[data-slot="badge"]')).toBeNull();
  });
});

describe('memory review accessibility', () => {
  it('names every filter select and renders no landmark inside the app main', async () => {
    mockBatchApi();
    fetchExistingMemoriesPage.mockResolvedValue({
      items: [],
      total: 0,
      offset: 0,
    });
    const user = userEvent.setup();
    const { container } = renderPage();

    for (const name of [
      'Review mode',
      'Proposal batch',
      'Filter proposals by operation',
      'Filter proposals by memory type',
    ]) {
      await screen.findByRole('combobox', { name });
    }
    expect(container.querySelector('main')).toBeNull();

    await chooseOption(
      screen.getByRole('combobox', { name: 'Review mode' }),
      'Existing memories',
    );
    for (const name of [
      'Filter existing memories by type',
      'Filter existing memories by evaluation state',
    ]) {
      await screen.findByRole('combobox', { name });
    }
    expect(container.querySelector('main')).toBeNull();
  });
});

describe('memory review status filter tiles', () => {
  it('exposes the selected filter through aria-pressed', async () => {
    mockBatchApi();
    const user = userEvent.setup();
    const { container } = renderPage();
    const pressed = () =>
      Object.fromEntries(
        Array.from(
          container.querySelectorAll<HTMLElement>(
            '[data-ui="memory-review-status-filter"]',
          ),
        ).map((el) => [
          el.dataset.reviewFilter,
          el.getAttribute('aria-pressed'),
        ]),
      );
    await waitFor(() => expect(Object.keys(pressed())).toHaveLength(5));
    expect(pressed()).toEqual({
      pending: 'false',
      approved: 'false',
      eval: 'false',
      rejected: 'false',
      all: 'true',
    });
    await user.click(
      container.querySelector('[data-review-filter="approved"]')!,
    );
    expect(pressed()).toEqual({
      pending: 'false',
      approved: 'true',
      eval: 'false',
      rejected: 'false',
      all: 'false',
    });
  });
});

describe('memory review forget decisions', () => {
  it('offers keep or erase without edit and eval actions', async () => {
    mockBatchApi();
    fetchHistoryReviewBatch.mockResolvedValue({
      batch: batchSummary,
      projects: [
        makeProject({
          project_id: 'alpha',
          counts: {
            operations: 1,
            pending: 1,
            approved: 0,
            eval: 0,
            rejected: 0,
            mandatory: 0,
            skipped_groups: 0,
          },
          operations: [
            {
              id: 'forget-operation',
              operation: {
                op: 'forget',
                candidate_ids: ['forget-candidate'],
                memory_id: 'memory-to-keep-or-erase',
                target: 'Mistaken erase proposal',
              },
              candidates: [],
              evidence: [],
              mandatory: false,
              decision: 'pending',
              mark_for_eval: false,
              target_project_id: 'alpha',
              target_memory: {
                id: 'memory-to-keep-or-erase',
                content: 'Private contact: Dana Rowe, dana@example.test',
                memory_type: 'contact',
                valid_from: '2026-09-01T10:00:00.000Z',
              },
            },
            {
              id: 'forget-missing-operation',
              operation: {
                op: 'forget',
                candidate_ids: ['forget-missing-candidate'],
                memory_id: 'memory-already-gone',
                target: 'Stale erase proposal',
              },
              candidates: [],
              evidence: [],
              mandatory: false,
              decision: 'pending',
              mark_for_eval: false,
              target_project_id: 'alpha',
              target_memory: null,
            },
          ],
        }),
      ],
    });

    renderPage();

    await screen.findByText('Mistaken erase proposal');
    expect(screen.getByText('memory-to-keep-or-erase')).toBeTruthy();
    expect(
      screen.getByText('Private contact: Dana Rowe, dana@example.test'),
    ).toBeTruthy();
    expect(
      screen.getByText('Target memory not found or no longer current.'),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Keep memory' })).toHaveLength(
      2,
    );
    expect(
      screen.getAllByRole('button', { name: 'Approve erase' }),
    ).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve + eval' })).toBeNull();
  });
});

describe('memory review failed history batches load', () => {
  it('keeps the error on screen without polling until Retry succeeds', async () => {
    vi.useFakeTimers();
    mockBatchApi();
    fetchHistoryReviewBatches.mockRejectedValue(new Error('server 500'));
    renderPage();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('server 500')).toBeTruthy();
    expect(
      selectedLabel(screen.getByRole('combobox', { name: 'Proposal batch' })),
    ).toBe('Could not load history reviews');
    expect(screen.queryByText('No history-review batches found')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(12_000));
    expect(screen.getByText('server 500')).toBeTruthy();
    expect(
      screen.queryByText('Loading history reviews…', { selector: 'div' }),
    ).toBeNull();
    expect(fetchHistoryReviewBatches).toHaveBeenCalledTimes(1);

    let finishRetry!: (value: { batches: (typeof batchSummary)[] }) => void;
    fetchHistoryReviewBatches.mockReturnValue(
      new Promise((resolve) => {
        finishRetry = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchHistoryReviewBatches).toHaveBeenCalledTimes(2);
    expect(screen.getByText('server 500')).toBeTruthy();
    expect(
      screen.queryByText('Loading history reviews…', { selector: 'div' }),
    ).toBeNull();

    finishRetry({ batches: [batchSummary] });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByText('server 500')).toBeNull();
    const batchTrigger = screen.getByRole('combobox', {
      name: 'Proposal batch',
    });
    expect(selectedLabel(batchTrigger)).toMatch(/· preview$/);
    fireEvent.keyDown(batchTrigger, { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    const batchOptions = screen.getAllByRole('option', {
      name: /· preview$/,
    });
    expect(batchOptions).toHaveLength(1);
    fireEvent.keyDown(batchOptions[0]!, { key: 'Escape' });
  });
});

describe('memory review failed existing-memories load', () => {
  it('shows no zero count, and Retry refetches', async () => {
    mockBatchApi();
    fetchExistingMemoriesPage.mockRejectedValueOnce(new Error('server 500'));
    const user = userEvent.setup();
    renderPage();
    await chooseOption(
      await screen.findByRole('combobox', { name: 'Review mode' }),
      'Existing memories',
    );
    expect(await screen.findByText('server 500')).toBeTruthy();
    expect(screen.getByText('Could not load memories')).toBeTruthy();
    expect(screen.queryByText(/active memories in database/)).toBeNull();

    fetchExistingMemoriesPage.mockResolvedValue({
      items: [],
      total: 3,
      offset: 0,
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('3 active memories in database'),
    ).toBeTruthy();
  });
});

describe('memory review failed existing-memories next page', () => {
  const memory = (id: string) => ({
    id,
    group_folder: 'alpha',
    content: `content ${id}`,
    memory_type: 'fact',
    importance: 3,
    source: 'agent',
    tags: [],
    created_at: '2026-10-20T00:00:00.000Z',
    updated_at: '2026-10-20T00:00:00.000Z',
    last_accessed_at: '2026-10-20T00:00:00.000Z',
    access_count: 0,
    marked_for_eval: false,
  });

  it('keeps loaded cards, does not auto-retry, and appends after Retry loading more', async () => {
    mockBatchApi();
    const observers = new Set<() => void>();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private fire: () => void;
        constructor(callback: (entries: unknown[]) => void) {
          this.fire = () => callback([{ isIntersecting: true }]);
          observers.add(this.fire);
        }
        observe() {}
        disconnect() {
          observers.delete(this.fire);
        }
      },
    );
    try {
      fetchExistingMemoriesPage
        .mockResolvedValueOnce({
          items: [memory('m1'), memory('m2')],
          total: 3,
          offset: 0,
          limit: 2,
        })
        .mockRejectedValueOnce(new Error('page2 boom'))
        .mockResolvedValueOnce({
          items: [memory('m3')],
          total: 3,
          offset: 2,
          limit: 2,
        });
      const user = userEvent.setup();
      renderPage();
      await chooseOption(
        await screen.findByRole('combobox', { name: 'Review mode' }),
        'Existing memories',
      );
      await screen.findByText('content m1');
      await waitFor(() => expect(observers.size).toBeGreaterThan(0));
      act(() => observers.forEach((fire) => fire()));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('page2 boom');
      expect(screen.getByText('content m1')).toBeTruthy();
      expect(screen.getByText('content m2')).toBeTruthy();
      expect(screen.getByText('Showing 2 of 3 memories')).toBeTruthy();
      expect(screen.getByText('3 active memories in database')).toBeTruthy();
      const callsAfterFailure = fetchExistingMemoriesPage.mock.calls.length;
      expect(callsAfterFailure).toBe(2);
      // No live observer may remain to fetch again after the failure.
      expect(observers.size).toBe(0);
      act(() => observers.forEach((fire) => fire()));
      expect(fetchExistingMemoriesPage).toHaveBeenCalledTimes(
        callsAfterFailure,
      );

      await user.click(
        screen.getByRole('button', { name: 'Retry loading more' }),
      );
      expect(await screen.findByText('content m3')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Retry loading more' }),
      ).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('memory audit proposal editor valid-from', () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Europe/Bucharest';
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  async function openAuditEditor() {
    mockBatchApi();
    routeSearch.current = {
      mode: 'existing',
      projectId: 'alpha',
      auditId: 'audit-1',
    };
    fetchExistingMemoriesPage.mockResolvedValue({
      items: [],
      total: 0,
      offset: 0,
    });
    fetchProjectMemoryAudits.mockResolvedValue({
      audits: [{ id: 'audit-1' }],
    });
    fetchProjectMemoryAuditReport.mockResolvedValue({
      project_id: 'alpha',
      generated_at: '2026-10-20T00:00:00.000Z',
      total_audits: 0,
      totals: { erased: 0, merged: 0, created: 0, moved: 0 },
      audits: [],
    });
    const audit = {
      id: 'audit-1',
      project_id: 'alpha',
      runtime_id: 'llm:direct:configured-reflector',
      prompt_version: 'v1',
      mode: 'cleanup',
      status: 'ready',
      total_items: 1,
      processed_items: 1,
      proposal_items: 1,
      retry_count: 0,
      created_at: '2026-10-20T00:00:00.000Z',
      updated_at: '2026-10-20T00:00:00.000Z',
      items: [
        {
          id: 'audit-item-1',
          memory_id: 'memory-1',
          memory_fingerprint: 'fp',
          processing_state: 'complete',
          disposition: 'rewrite',
          proposed_content: 'Proposed memory content',
          proposed_memory_type: 'project',
          proposed_importance: 0.8,
          proposed_tags: [],
          proposed_valid_from: '2026-10-20T10:00:00.000Z',
          review_decision: 'pending',
          revision: 3,
          memory: null,
        },
      ],
      related_projects: [],
      counts: {
        pending: 1,
        approved: 0,
        rejected: 0,
        applied: 0,
        applicable: 0,
        skipped: 0,
        delete_memory: 0,
        delete_both: 0,
        dismissed: 0,
      },
      apply_enabled: true,
    };
    fetchProjectMemoryAudit.mockResolvedValue(audit);
    reviewProjectMemoryAuditItem.mockResolvedValue(audit);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    return user;
  }

  it('omits an unchanged valid-from and sends an edited one as the entered local time', async () => {
    const user = await openAuditEditor();
    const dateInput = screen.getByLabelText(
      'Memory valid from',
    ) as HTMLInputElement;
    expect(dateInput.value).toBe('2026-10-20T13:00');

    const content = screen.getByDisplayValue('Proposed memory content');
    await user.clear(content);
    await user.type(content, 'Edited memory content');
    await user.click(screen.getByRole('button', { name: 'Save and approve' }));
    await waitFor(() =>
      expect(reviewProjectMemoryAuditItem).toHaveBeenCalledTimes(1),
    );
    const firstEdits = reviewProjectMemoryAuditItem.mock.calls[0]![3].edits;
    expect(firstEdits.proposed_content).toBe('Edited memory content');
    expect(firstEdits).not.toHaveProperty('proposed_valid_from');

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Memory valid from'), {
      target: { value: '2026-10-21T09:30' },
    });
    await user.click(screen.getByRole('button', { name: 'Save and approve' }));
    await waitFor(() =>
      expect(reviewProjectMemoryAuditItem).toHaveBeenCalledTimes(2),
    );
    expect(
      reviewProjectMemoryAuditItem.mock.calls[1]![3].edits.proposed_valid_from,
    ).toBe('2026-10-21T06:30:00.000Z');
  });
});

describe('history review editor date validation', () => {
  const baseOperation = {
    candidates: [],
    evidence: [],
    mandatory: false,
    decision: 'pending' as const,
    mark_for_eval: false,
    target_project_id: 'alpha',
  };

  function mockOperations(operations: HistoryReviewProject['operations']) {
    mockBatchApi();
    fetchHistoryReviewBatch.mockResolvedValue({
      batch: batchSummary,
      projects: [makeProject({ project_id: 'alpha', operations })],
    });
  }

  it('rejects a cleared valid-from with a toast instead of throwing', async () => {
    mockOperations([
      {
        ...baseOperation,
        id: 'create-operation',
        operation: {
          op: 'create',
          candidate_ids: [],
          new_memory_id: 'new-memory',
          memory_type: 'project',
          content: 'Created memory content',
          valid_from: '2026-10-20T10:00:00.000Z',
          importance: 0.8,
          tags: [],
        },
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Valid from'), {
      target: { value: '' },
    });
    await user.click(screen.getByRole('button', { name: 'Save and approve' }));
    expect(toast.error).toHaveBeenCalledWith('Valid from is required');
    expect(updateHistoryReviewOperation).not.toHaveBeenCalled();
  });

  it('does not open the editor for a forget operation via the edit deep link', async () => {
    routeSearch.current = {
      mode: 'history',
      batchId: batchSummary.id,
      projectId: 'alpha',
      itemId: 'forget-operation',
      action: 'edit',
    };
    mockOperations([
      {
        ...baseOperation,
        id: 'forget-operation',
        operation: {
          op: 'forget',
          candidate_ids: [],
          memory_id: 'memory-1',
          target: 'Erase proposal',
        },
      },
    ]);
    renderPage();
    await screen.findByText('Erase proposal');
    expect(
      screen.queryByRole('button', { name: 'Save and approve' }),
    ).toBeNull();
    expect(screen.queryByLabelText('Memory content')).toBeNull();
  });
});
