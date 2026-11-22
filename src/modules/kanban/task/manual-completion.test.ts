import { describe, expect, test } from 'bun:test';
import type { Task } from '../types.js';
import { mergeTaskForManualCompletion } from './manual-completion.js';

function task(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'task-manual-done',
    project_id: 'project-a',
    title: 'Manual completion',
    branch_name: 'manual-completion-abc123',
    ...overrides,
  };
}

function group(createBranchPerTask = true): any {
  return {
    folder: 'project-a',
    settings: { createBranchPerTask },
  };
}

// Branch-mode groups reach the merge risk gate; a project without a rules file
// on its default branch is the ungated case these tests are about.
const noRiskRules = {
  runGit: async () => ({ ok: true, output: '' }),
  isMergeApproved: async () => false,
};

describe('mergeTaskForManualCompletion', () => {
  test('commits and merges a task branch under the project lock', async () => {
    const calls: string[] = [];
    const result = await mergeTaskForManualCompletion(task(), group(), {
      commitTaskBranch: async () => {
        calls.push('commit');
        return true;
      },
      mergeTaskBranchToDefault: async () => {
        calls.push('merge');
        return { mergeOk: true, output: 'merged' };
      },
      withProjectGitLock: async (_projectId, fn) => {
        calls.push('lock');
        return fn();
      },
    });

    expect(result).toEqual({ mergeOk: true, output: 'merged' });
    expect(calls).toEqual(['lock', 'commit', 'merge']);
  });

  test('does not merge when the task worktree commit fails', async () => {
    let merged = false;
    const result = await mergeTaskForManualCompletion(task(), group(), {
      commitTaskBranch: async () => false,
      mergeTaskBranchToDefault: async () => {
        merged = true;
        return { mergeOk: true, output: '' };
      },
      withProjectGitLock: async (_projectId, fn) => fn(),
    });

    expect(result).toEqual({
      mergeOk: false,
      output: 'Task worktree changes could not be committed',
    });
    expect(merged).toBe(false);
  });

  test('allows completion with integration pending when only the shared default checkout is dirty', async () => {
    const result = await mergeTaskForManualCompletion(task(), group(), {
      commitTaskBranch: async () => true,
      mergeTaskBranchToDefault: async () => ({
        mergeOk: false,
        output: '[env] default checkout is dirty',
        failureKind: 'environment',
        blockers: [
          {
            path: 'unrelated.txt',
            status: ' M',
            source: 'default-checkout-blocker',
            additions: 0,
            deletions: 0,
          },
        ],
      }),
      withProjectGitLock: async (_projectId, fn) => fn(),
    });

    expect(result).toEqual(
      expect.objectContaining({
        mergeOk: true,
        integrationPending: true,
        failureKind: 'environment',
      }),
    );
  });

  test('keeps other merge environment failures blocking', async () => {
    const result = await mergeTaskForManualCompletion(task(), group(), {
      commitTaskBranch: async () => true,
      mergeTaskBranchToDefault: async () => ({
        mergeOk: false,
        output: '[env] sandbox unavailable',
        failureKind: 'environment',
      }),
      withProjectGitLock: async (_projectId, fn) => fn(),
    });

    expect(result.mergeOk).toBe(false);
    expect(result.integrationPending).toBeUndefined();
  });

  test('checkpoints a configured shared checkout without committing a task branch', async () => {
    const calls: string[] = [];
    const result = await mergeTaskForManualCompletion(
      task({ branch_name: null }),
      {
        ...group(false),
        settings: {
          taskCheckoutMode: 'shared',
          repositoryLocation: '/host/project',
        },
      },
      {
        commitTaskBranch: async () => {
          calls.push('task-branch-commit');
          return true;
        },
        mergeTaskBranchToDefault: async () => {
          calls.push('default-checkpoint');
          return { mergeOk: true, output: 'committed on develop' };
        },
        withProjectGitLock: async (_projectId, fn) => {
          calls.push('lock');
          return fn();
        },
        sharedCheckoutIsSafe: async () => true,
      },
    );

    expect(result).toEqual({
      mergeOk: true,
      output: 'committed on develop',
    });
    expect(calls).toEqual(['lock', 'default-checkpoint']);
  });

  test('skips repositories without a persisted task branch', async () => {
    let called = false;
    const dependencies = {
      commitTaskBranch: async () => {
        called = true;
        return true;
      },
      mergeTaskBranchToDefault: async () => {
        called = true;
        return { mergeOk: true, output: '' };
      },
      withProjectGitLock: async (_projectId: string, fn: () => any) => fn(),
    };

    expect(
      await mergeTaskForManualCompletion(
        task({ branch_name: null }),
        group(),
        dependencies,
      ),
    ).toEqual({ mergeOk: true, output: '' });
    expect(
      await mergeTaskForManualCompletion(
        task({ branch_name: null }),
        group(false),
        dependencies,
      ),
    ).toEqual({ mergeOk: true, output: '' });
    expect(called).toBe(false);
  });
  test('completes an already-merged branch without trying to checkpoint it again', async () => {
    let checkedTask: Task | undefined;
    let alternativeExpectedBranches: string[] | undefined;
    let mergedTask: Task | undefined;
    let commitAttempted = false;
    const result = await mergeTaskForManualCompletion(
      task(),
      {
        ...group(),
        settings: {
          taskCheckoutMode: 'branch',
          repositoryLocation: '/host/project',
          defaultBranch: 'kvu',
        },
      },
      {
        commitTaskBranch: async () => {
          commitAttempted = true;
          return false;
        },
        mergeTaskBranchToDefault: async (value) => {
          mergedTask = value;
          return { mergeOk: true, output: 'Branch already merged' };
        },
        withProjectGitLock: async (_projectId, fn) => fn(),
        riskGate: noRiskRules,
        sharedCheckoutIsSafe: async (
          value,
          _group,
          requireClean,
          alternatives,
        ) => {
          checkedTask = value;
          expect(requireClean).toBe(true);
          alternativeExpectedBranches = alternatives;
          return true;
        },
      },
    );
    expect(result.mergeOk).toBe(true);
    expect(commitAttempted).toBe(false);
    expect(checkedTask?.branch_name).toBe('manual-completion-abc123');
    expect(alternativeExpectedBranches).toEqual(['kvu']);
    expect(mergedTask?.branch_name).toBe('manual-completion-abc123');
  });

  test('branch completion still blocks unsafe checkouts and failed merges, releasing its lease', async () => {
    for (const safe of [false, true]) {
      let merged = false;
      let released = false;
      const result = await mergeTaskForManualCompletion(
        task(),
        { ...group(), settings: { taskCheckoutMode: 'branch' } },
        {
          commitTaskBranch: async () => {
            throw new Error('Clean branch checkout must not be checkpointed');
          },
          mergeTaskBranchToDefault: async () => {
            merged = true;
            return {
              mergeOk: false,
              output: 'CONFLICT',
              failureKind: 'conflict',
            };
          },
          withProjectGitLock: async (_projectId, fn) => fn(),
          riskGate: noRiskRules,
          sharedCheckoutIsSafe: async () => safe,
          acquireSharedCheckoutLease: async (projectId, owner) => ({
            projectId,
            owner,
            heartbeat: async () => true,
            release: async () => {
              released = true;
            },
          }),
        },
      );
      expect(result.mergeOk).toBe(false);
      expect(merged).toBe(safe);
      expect(released).toBe(true);
    }
  });
});
