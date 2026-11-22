import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageDefinition, TaskSummary } from '@/types';
import { AbComparisonPanel } from './ab-comparison-panel';

const api = vi.hoisted(() => ({ pickAbWinner: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  pickAbWinner: api.pickAbWinner,
  fetchChatAgents: vi.fn(async () => []),
  fetchRuntimeCatalog: vi.fn(async () => ({
    version: 2,
    harnesses: [],
    models: [],
    presets: [],
  })),
  fetchTaskRuns: vi.fn(async (_project: string, taskId: string) => ({
    runs: [
      {
        id: `${taskId}-review`,
        task_id: taskId,
        stage: 'review',
        agent_name: 'claude',
        model_name: 'opus',
        model: null,
      },
      {
        id: `${taskId}-coding`,
        task_id: taskId,
        stage: 'coding',
        agent_name: taskId === 'child-a' ? 'codex' : 'claude',
        model_name: taskId === 'child-a' ? 'gpt' : 'sonnet',
        model: null,
      },
    ],
    latest_scored_review_run: null,
    total: 2,
    stageDurations: [],
    persistent_comments: [],
  })),
  getTaskDiff: vi.fn(async () => ({
    available: true,
    files: [
      { path: 'a.ts', additions: 10, deletions: 2 },
      { path: 'b.ts', additions: 5, deletions: 0 },
    ],
  })),
}));

const stages: StageDefinition[] = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
  { id: 'coding', title: 'Coding', type: 'active', color: '#00f' },
  { id: 'testing', title: 'Testing', type: 'testing', color: '#80f' },
  { id: 'review', title: 'Review', type: 'review', color: '#f0a' },
  { id: 'completed', title: 'Completed', type: 'done', color: '#0a0' },
];

function task(overrides: Record<string, unknown>): TaskSummary {
  return {
    id: 'task',
    project_id: 'p',
    title: 'Task',
    description: '',
    status: 'completed',
    priority: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as TaskSummary;
}

const parent = task({
  id: 'parent',
  status: 'coding',
  abVariants: ['a', 'b'],
  abForkCommit: 'abcdef1234567890',
});
const childA = task({
  id: 'child-a',
  stageVariant: 'a',
  abParentTaskId: 'parent',
  costUsd: 0.31,
  totalRunDurationMs: 540_000,
  custom_values: { quality_score: 8, rejection_count: 0 },
});
const childB = task({
  id: 'child-b',
  status: 'review',
  stageVariant: 'b',
  abParentTaskId: 'parent',
});

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof AbComparisonPanel>> = {},
) {
  const onOpenTask = vi.fn();
  const client = new QueryClient();
  const panel = (extra: typeof overrides) => (
    <QueryClientProvider client={client}>
      <AbComparisonPanel
        projectId="p"
        parent={parent}
        variants={[childA, childB]}
        stages={stages}
        onOpenTask={onOpenTask}
        {...overrides}
        {...extra}
      />
    </QueryClientProvider>
  );
  const view = render(panel({}));
  return {
    onOpenTask,
    rerender: (extra: typeof overrides) => view.rerender(panel(extra)),
  };
}

const ui = (name: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLElement>(`[data-ui="${name}"]`);
const row = (taskId: string) =>
  document.querySelector<HTMLElement>(
    `[data-ui="ab-comparison-row"][data-task-id="${taskId}"]`,
  )!;

describe('AbComparisonPanel', () => {
  beforeEach(() => api.pickAbWinner.mockReset());
  afterEach(() => cleanup());

  it('compares variants and offers a merge only on done ones', async () => {
    const { onOpenTask } = renderPanel();
    expect(ui('ab-comparison-progress')?.textContent).toBe('1/2 done');
    await waitFor(() =>
      expect(ui('ab-metric-coder', row('child-a'))?.textContent).toContain(
        'codex',
      ),
    );
    expect(ui('ab-metric-reviewer', row('child-a'))?.textContent).toContain(
      'claude',
    );
    expect(ui('ab-metric-review', row('child-a'))?.textContent).toContain('8');
    expect(ui('ab-metric-cost', row('child-a'))?.textContent).toContain(
      '$0.3100',
    );
    expect(ui('ab-metric-fork-commit', row('child-a'))?.textContent).toContain(
      'abcdef1',
    );
    await waitFor(() =>
      expect(ui('ab-metric-diff', row('child-a'))?.textContent).toContain(
        '+15',
      ),
    );
    expect(ui('ab-merge-variant', row('child-a'))).not.toBeNull();
    expect(ui('ab-merge-variant', row('child-b'))).toBeNull();

    fireEvent.click(ui('ab-open-variant', row('child-b'))!);
    expect(onOpenTask).toHaveBeenCalledWith('child-b');
  });

  it('confirms before merging and shows the server error on a conflict', async () => {
    api.pickAbWinner.mockRejectedValueOnce(
      new Error('The variant could not be merged'),
    );
    renderPanel();
    fireEvent.click(ui('ab-merge-variant', row('child-a'))!);
    expect(api.pickAbWinner).not.toHaveBeenCalled();
    fireEvent.click(ui('ab-merge-confirm')!);
    await waitFor(() =>
      expect(ui('ab-winner-error')?.textContent).toContain(
        'could not be merged',
      ),
    );
    expect(api.pickAbWinner).toHaveBeenCalledWith('p', 'parent', 'child-a');
  });

  it('shows the winner and disables every merge button once one is picked', () => {
    renderPanel({
      parent: task({ ...parent, abWinnerTaskId: 'child-a' }),
      variants: [childA, { ...childB, status: 'completed' } as TaskSummary],
    });
    expect(ui('ab-comparison-winner')?.textContent).toContain('Winner: A');
    expect(ui('ab-winner-badge', row('child-a'))).not.toBeNull();
    for (const id of ['child-a', 'child-b']) {
      expect(
        (ui('ab-merge-variant', row(id)) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect(screen.queryByText('Merge variant A?')).toBeNull();
  });

  it('clears a stale merge error once the variants change', async () => {
    api.pickAbWinner.mockRejectedValueOnce(
      new Error('The variant could not be merged'),
    );
    const panel = (variants: TaskSummary[]) => (
      <QueryClientProvider client={client}>
        <AbComparisonPanel
          projectId="p"
          parent={parent}
          variants={variants}
          stages={stages}
          onOpenTask={vi.fn()}
        />
      </QueryClientProvider>
    );
    const client = new QueryClient();
    const view = render(panel([childA, childB]));
    fireEvent.click(ui('ab-merge-variant', row('child-a'))!);
    fireEvent.click(ui('ab-merge-confirm')!);
    await waitFor(() => expect(ui('ab-winner-error')).not.toBeNull());

    view.rerender(panel([childA, { ...childB, status: 'completed' }] as never));
    await waitFor(() => expect(ui('ab-winner-error')).toBeNull());
    expect(ui('ab-comparison-progress')?.textContent).toBe('2/2 done');
  });

  it('keeps an in-flight merge attached when the variants change', async () => {
    let settle: (value: unknown) => void = () => {};
    api.pickAbWinner.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const client = new QueryClient();
    const panel = (variants: TaskSummary[]) => (
      <QueryClientProvider client={client}>
        <AbComparisonPanel
          projectId="p"
          parent={parent}
          variants={variants}
          stages={stages}
          onOpenTask={vi.fn()}
        />
      </QueryClientProvider>
    );
    const view = render(panel([childA, childB]));
    fireEvent.click(ui('ab-merge-variant', row('child-a'))!);
    fireEvent.click(ui('ab-merge-confirm')!);
    await waitFor(() => expect(api.pickAbWinner).toHaveBeenCalledTimes(1));

    view.rerender(panel([childA, { ...childB, status: 'completed' }] as never));
    // Still merging: confirmation stays disabled until the request settles.
    expect((ui('ab-merge-confirm') as HTMLButtonElement).disabled).toBe(true);
    settle({});
    // The original per-call onSettled still closes the dialog.
    await waitFor(() =>
      expect(ui('ab-merge-confirm-dialog')?.dataset.state ?? 'closed').toBe(
        'closed',
      ),
    );
  });

  it('lets the merge dialog close while the pick is pending', async () => {
    let settle: (value: unknown) => void = () => {};
    api.pickAbWinner.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const { rerender } = renderPanel();
    fireEvent.click(ui('ab-merge-variant', row('child-a'))!);
    fireEvent.click(ui('ab-merge-confirm')!);
    await waitFor(() => expect(api.pickAbWinner).toHaveBeenCalledTimes(1));
    expect((ui('ab-merge-cancel') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(ui('ab-merge-cancel')!);
    await waitFor(() => expect(ui('ab-merge-confirm-dialog')).toBeNull());
    expect(ui('ab-merge-pending')).not.toBeNull();
    // The in-flight candidate cannot be dismissed.
    expect(
      (ui('ab-dismiss-variant', row('child-a')) as HTMLButtonElement).disabled,
    ).toBe(true);
    // The backend persists the winner claim before the pick settles; the next
    // refresh delivers it while the request is still pending.
    rerender({ parent: task({ ...parent, abWinnerTaskId: 'child-a' }) });
    // The pending candidate's dialog reopens despite the winner claim.
    fireEvent.click(ui('ab-merge-variant', row('child-a'))!);
    expect(ui('ab-merge-confirm-dialog')).not.toBeNull();
    expect((ui('ab-merge-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(api.pickAbWinner).toHaveBeenCalledTimes(1);
    fireEvent.click(ui('ab-merge-cancel')!);
    await waitFor(() => expect(ui('ab-merge-confirm-dialog')).toBeNull());
    settle({});
    await waitFor(() => expect(ui('ab-merge-pending')).toBeNull());
  });

  it('offers Dismiss on non-winner variants only', () => {
    renderPanel({
      parent: task({ ...parent, abWinnerTaskId: 'child-a' }),
    });
    expect(ui('ab-dismiss-variant', row('child-a'))).toBeNull();
    const dismiss = ui('ab-dismiss-variant', row('child-b'));
    expect((dismiss as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(dismiss!);
    expect(ui('ab-dismiss-confirm-dialog')).not.toBeNull();
  });
});
