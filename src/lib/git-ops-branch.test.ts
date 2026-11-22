import { describe, expect, test } from 'bun:test';
import {
  commitTaskBranch,
  getBranchNameForTask,
  removeWorktreeForTask,
  taskBranchNeedsReviewPreparation,
} from './git-ops.js';
import type { RegisteredGroup } from '../types.js';
import type { Task } from '../modules/kanban/types.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1785261600000-abc123',
    project_id: 'demo-site',
    title: 'Verify and deliver demo-site editor workflows',
    description: '',
    status: 'development',
    priority: 0,
    author: 'cronjob',
    created_at: '2026-07-28T19:00:00.000Z',
    ...overrides,
  };
}

describe('getBranchNameForTask', () => {
  test('gives separate occurrences of one cronjob unique stable branches', () => {
    const first = task({ id: 'task-1785261600000-abc123' });
    const second = task({ id: 'task-1785261600001-def456' });

    expect(getBranchNameForTask(first)).toBe(
      'verify-and-deliver-demo-site-editor-workflows-abc123',
    );
    expect(getBranchNameForTask(second)).toBe(
      'verify-and-deliver-demo-site-editor-workflows-def456',
    );
    expect(getBranchNameForTask(first)).not.toBe(getBranchNameForTask(second));
  });

  test('strips leading and trailing separators from the title slug', () => {
    expect(getBranchNameForTask(task({ title: '- fix login bug' }))).toBe(
      'fix-login-bug-abc123',
    );
    const name = getBranchNameForTask(task({ title: '-- x_ yy --' }));
    expect(name).toBe('x_-yy-abc123');
  });

  test('caps oversized titles to a valid branch length', () => {
    const name = getBranchNameForTask(
      task({ title: `- ${'word '.repeat(60)}` }),
    );
    expect(name.length).toBeLessThanOrEqual(67);
    expect(name.startsWith('-')).toBe(false);
    expect(name.endsWith('-abc123')).toBe(true);
    expect(name.endsWith('--abc123')).toBe(false);
  });

  test('falls back to the task id when the sanitized slug is too short', () => {
    expect(getBranchNameForTask(task({ title: '- !!' }))).toBe(
      'task-1785261600000-abc123',
    );
  });

  test('returns a persisted branch name verbatim', () => {
    expect(
      getBranchNameForTask(task({ branch_name: '-Weird Name', title: 'x' })),
    ).toBe('-Weird Name');
  });
});
test('branch mode never invokes worktree cleanup even with stale path metadata', async () => {
  await expect(
    removeWorktreeForTask(
      task({
        branch_name: 'task-branch',
        worktree_path: '/host/repo/.worktrees/task-branch',
      }),
      {
        folder: 'project',
        settings: { taskCheckoutMode: 'branch' },
      } as RegisteredGroup,
    ),
  ).resolves.toBeUndefined();
});

describe('taskBranchNeedsReviewPreparation', () => {
  const branchTask = task({
    branch_name: 'task-branch',
    worktree_path: '/host/repo/.worktrees/task-branch',
  });
  const group = {
    folder: 'project',
    settings: {},
  } as RegisteredGroup;

  test('skips preparation when HEAD already contains the base tip', async () => {
    const calls: string[] = [];
    const needed = await taskBranchNeedsReviewPreparation(
      branchTask,
      group,
      'develop',
      async (_group, args) => {
        calls.push(args);
        return { ok: true, output: '0\n' };
      },
    );

    expect(needed).toBe(false);
    expect(calls).toEqual([
      '-C .worktrees/task-branch rev-list --count HEAD..develop',
    ]);
  });

  test('uses the repository root when branch metadata has no worktree path', async () => {
    const calls: string[] = [];
    const needed = await taskBranchNeedsReviewPreparation(
      task({ branch_name: 'new-task-branch', worktree_path: null }),
      group,
      'develop',
      async (_group, args) => {
        calls.push(args);
        return { ok: true, output: '0\n' };
      },
    );

    expect(needed).toBe(false);
    expect(calls).toEqual(['rev-list --count new-task-branch..develop']);
  });

  test('prepares when the base has commits missing from HEAD', async () => {
    expect(
      await taskBranchNeedsReviewPreparation(
        branchTask,
        group,
        'develop',
        async () => ({ ok: true, output: '2\n' }),
      ),
    ).toBe(true);
  });

  test('fails safe when the base inspection is unavailable', async () => {
    expect(
      await taskBranchNeedsReviewPreparation(
        branchTask,
        group,
        'develop',
        async () => ({ ok: false, output: 'fatal: bad revision' }),
      ),
    ).toBe(true);
  });
});

describe('commitTaskBranch worktree recovery', () => {
  test('recreates a missing managed worktree and retries the checkpoint', async () => {
    const branch = 'recovered-task-branch';
    const branchCalls: Array<Record<string, unknown>> = [];
    const worktreeCalls: Array<Record<string, unknown>> = [];
    const persisted: Array<Record<string, unknown>> = [];
    let checkpointAttempts = 0;

    const committed = await commitTaskBranch(
      task({ branch_name: branch, worktree_path: null }),
      {
        folder: 'project',
        settings: {
          taskCheckoutMode: 'worktree',
          defaultBranch: 'develop',
          repositoryLocation: '/host/repo',
          worktreeFiles: ['.env'],
        },
      } as RegisteredGroup,
      {
        sandboxClient: {
          sandboxBranch: async (_stack, _action, options) => {
            branchCalls.push(options);
            checkpointAttempts++;
            return checkpointAttempts === 1
              ? { stdout: 'missing worktree', isError: true }
              : { stdout: 'no changes', isError: false };
          },
          sandboxWorktree: async (_stack, _action, options) => {
            worktreeCalls.push(options ?? {});
            return {
              stdout: `worktree_path=/host/repo/.worktrees/${branch}\nWorktree created`,
              isError: false,
            };
          },
        },
        runGit: async () => ({ ok: true, output: 'a'.repeat(40) }),
        persistTask: async (_taskId, changes) => {
          persisted.push(changes);
          return undefined;
        },
      },
    );

    expect(committed).toBe(true);
    expect(branchCalls).toHaveLength(2);
    expect(branchCalls[0]).toMatchObject({
      branch,
      worktree_path: `.worktrees/${branch}`,
    });
    expect(worktreeCalls).toEqual([
      expect.objectContaining({
        branch,
        base: 'develop',
        localRepo: '/host/repo',
        symlinkFiles: ['.env'],
      }),
    ]);
    expect(persisted[0]).toEqual({
      worktree_path: `/host/repo/.worktrees/${branch}`,
    });
    expect(persisted[1]).toMatchObject({
      custom_values: { completed_commit_sha: 'a'.repeat(40) },
    });
  });
});
