import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationDiff,
  TaskDefaultBranchMerge,
  TaskDefaultBranchStatus,
} from '@/types';
import { queryKeys } from '@/lib/query-keys';
import { TaskChangesPanel } from './task-detail-dialog';

const { getTaskDefaultBranch, getTaskDiff, mergeTaskDefaultBranch } =
  vi.hoisted(() => ({
    getTaskDefaultBranch:
      vi.fn<(...args: string[]) => Promise<TaskDefaultBranchStatus>>(),
    getTaskDiff: vi.fn<(...args: string[]) => Promise<ConversationDiff>>(),
    mergeTaskDefaultBranch:
      vi.fn<(...args: unknown[]) => Promise<TaskDefaultBranchMerge>>(),
  }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  getTaskDefaultBranch,
  getTaskDiff,
  mergeTaskDefaultBranch,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const status: TaskDefaultBranchStatus = {
  available: true,
  defaultBranch: 'develop',
  sourceCommit: 'a'.repeat(40),
  taskHead: 'b'.repeat(40),
  commitsBehind: 2,
  state: 'ready',
  conflictedPaths: [],
};
const diff: ConversationDiff = {
  available: true,
  base: 'develop',
  branch: 'task',
  scope: 'worktree',
  files: [{ path: 'before.txt', additions: 1, deletions: 0 }],
  patch:
    'diff --git a/before.txt b/before.txt\n--- a/before.txt\n+++ b/before.txt\n@@ -0,0 +1 @@\n+before\n',
};

function Harness({
  mode = 'worktree',
  taskId = 'task',
}: {
  mode?: 'shared' | 'branch' | 'worktree';
  taskId?: string;
}) {
  const query = useQuery({
    queryKey: queryKeys.taskDiff.all('project', taskId),
    queryFn: () => getTaskDiff('project', taskId),
  });
  return (
    <TaskChangesPanel
      projectId="project"
      taskId={taskId}
      checkoutMode={mode}
      diff={query.data}
      isLoading={query.isLoading}
    />
  );
}
function mount(mode: 'shared' | 'branch' | 'worktree' = 'worktree') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(getTaskDiff).mockResolvedValue(diff);
  const view = render(
    <QueryClientProvider client={client}>
      <Harness mode={mode} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    switchTask: (taskId: string) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Harness mode={mode} taskId={taskId} />
        </QueryClientProvider>,
      ),
  };
}

describe('Task Changes local default branch integration', () => {
  it('limits integration to worktrees and refreshes unavailable/loading status explicitly and on reopening', async () => {
    const branch = mount('branch');
    await branch.findByText('before.txt');
    expect(
      branch.container.querySelector('[data-ui="task-default-branch"]'),
    ).toBeNull();
    expect(getTaskDefaultBranch).not.toHaveBeenCalled();
    branch.unmount();
    let resolve!: (value: TaskDefaultBranchStatus) => void;
    vi.mocked(getTaskDefaultBranch).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const panel = mount();
    expect(panel.getByText('Loading default-branch status…')).toBeTruthy();
    resolve({
      available: false,
      defaultBranch: 'develop',
      reason: 'Task worktree is missing.',
    });
    await panel.findByText('Task worktree is missing.');
    expect(
      panel.queryByRole('button', { name: 'Merge develop into task' }),
    ).toBeNull();
    vi.mocked(getTaskDefaultBranch).mockResolvedValue({
      ...status,
      commitsBehind: 0,
    });
    fireEvent.click(panel.getByRole('button', { name: 'Refresh' }));
    await panel.findByText('Up to date.');
    panel.unmount();
    vi.mocked(getTaskDefaultBranch).mockResolvedValue(status);
    const reopened = mount();
    await reopened.findByText('2 commits from develop missing from this task.');
    expect(getTaskDefaultBranch).toHaveBeenCalledTimes(3);
  });

  it('merges once while pending and refreshes both the integration state and rendered task diff', async () => {
    vi.mocked(getTaskDefaultBranch).mockResolvedValue(status);
    let resolve!: (value: TaskDefaultBranchMerge) => void;
    vi.mocked(mergeTaskDefaultBranch).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const panel = mount();
    const button = await panel.findByRole('button', {
      name: 'Merge develop into task',
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await panel.findByText('Merging and notifying the agent…');
    expect(mergeTaskDefaultBranch).toHaveBeenCalledTimes(1);
    expect(mergeTaskDefaultBranch).toHaveBeenCalledWith('project', 'task', {
      sourceCommit: status.sourceCommit,
      taskHead: status.taskHead,
    });
    vi.mocked(getTaskDefaultBranch).mockResolvedValue({
      ...status,
      commitsBehind: 0,
    });
    vi.mocked(getTaskDiff).mockResolvedValue({
      ...diff,
      files: [{ path: 'after.txt', additions: 2, deletions: 0 }],
      patch:
        'diff --git a/after.txt b/after.txt\n--- a/after.txt\n+++ b/after.txt\n@@ -0,0 +1 @@\n+after\n',
    });
    resolve({
      defaultBranch: 'develop',
      sourceCommit: status.sourceCommit,
      taskHead: status.taskHead,
      outcome: 'merged',
      conflictedPaths: [],
      delivery: 'steered',
    });
    await panel.findByText('Agent notified through steering.');
    await panel.findByText('Up to date.');
    await panel.findByText('after.txt');
    expect(panel.queryByText('before.txt')).toBeNull();
    expect(getTaskDiff).toHaveBeenCalledTimes(2);
  });

  it('shows retained merge state and queued delivery, and blocks another merge', async () => {
    for (const outcome of ['conflicted', 'uncommitted'] as const) {
      const conflictedPaths =
        outcome === 'conflicted' ? ['src/conflict.ts'] : [];
      vi.mocked(getTaskDefaultBranch).mockResolvedValue(status);
      vi.mocked(mergeTaskDefaultBranch).mockImplementation(async () => {
        vi.mocked(getTaskDefaultBranch).mockResolvedValue({
          ...status,
          state: 'unresolved',
          conflictedPaths,
        });
        return {
          defaultBranch: 'develop',
          sourceCommit: status.sourceCommit,
          taskHead: status.taskHead,
          outcome,
          conflictedPaths,
          delivery: 'queued',
        };
      });
      const panel = mount();
      fireEvent.click(
        await panel.findByRole('button', { name: 'Merge develop into task' }),
      );
      await panel.findByText(
        outcome === 'conflicted'
          ? 'Merge conflicts require resolution.'
          : 'Merge requires inspection and a merge commit.',
      );
      await panel.findByText(
        'Agent instruction queued for the next execution.',
      );
      if (outcome === 'conflicted') await panel.findByText('src/conflict.ts');
      else
        expect(
          panel.queryByText('Merge conflicts require resolution.'),
        ).toBeNull();
      expect(panel.getByText(/An unresolved merge\/rebase/)).toBeTruthy();
      expect(
        (
          panel.getByRole('button', {
            name: 'Merge develop into task',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      panel.unmount();
    }
  });

  it('keeps errors and interrupted-merge notification failure explicit without retrying the mutation', async () => {
    vi.mocked(getTaskDefaultBranch).mockRejectedValueOnce(
      new Error('Sandbox unavailable'),
    );
    const panel = mount();
    await panel.findByText('Status unavailable: Sandbox unavailable');
    expect(
      panel.queryByRole('button', { name: 'Merge develop into task' }),
    ).toBeNull();
    vi.mocked(getTaskDefaultBranch).mockResolvedValue({
      ...status,
      state: 'dirty',
    });
    fireEvent.click(panel.getByRole('button', { name: 'Refresh' }));
    const dirtyButton = await panel.findByRole('button', {
      name: 'Merge develop into task',
    });
    expect((dirtyButton as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(getTaskDefaultBranch).mockResolvedValue(status);
    fireEvent.click(panel.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(
        (
          panel.getByRole('button', {
            name: 'Merge develop into task',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    vi.mocked(mergeTaskDefaultBranch).mockResolvedValue({
      defaultBranch: 'develop',
      sourceCommit: status.sourceCommit,
      taskHead: status.taskHead,
      outcome: 'interrupted',
      conflictedPaths: [],
      delivery: 'failed',
      error:
        'Git was interrupted, but notification failed. Do not repeat the merge.',
      notification: 'Inspect updated code and finish/commit the merge.',
    });
    fireEvent.click(
      panel.getByRole('button', { name: 'Merge develop into task' }),
    );
    await panel.findByText(
      'Git was interrupted, but notification failed. Do not repeat the merge.',
    );
    expect(
      panel.getByText(
        'Merge interrupted; inspect the task worktree before retrying.',
      ),
    ).toBeTruthy();
    expect(
      panel.getByText('Inspect updated code and finish/commit the merge.'),
    ).toBeTruthy();
    expect(
      (
        panel.getByRole('button', {
          name: 'Merge develop into task',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(mergeTaskDefaultBranch).toHaveBeenCalledTimes(1);
    panel.switchTask('another-task');
    await waitFor(() =>
      expect(
        (
          panel.getByRole('button', {
            name: 'Merge develop into task',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      panel.queryByText('Inspect updated code and finish/commit the merge.'),
    ).toBeNull();
  });
});
