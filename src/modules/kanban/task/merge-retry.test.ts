import { describe, expect, mock, test } from 'bun:test';

import type { RegisteredGroup } from '../../../types.js';
import type { Task, TaskMessage } from '../types.js';
import type { ActiveRun } from '../execution/types.js';
import {
  attemptParkedMerge,
  isMergeRetrySweepEnabled,
  sweepParkedApprovedMerges,
  type ApprovalDrift,
  type MergeRetryDependencies,
} from './merge-retry.js';

const PARKED_AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:10:00.000Z';

const group = {
  folder: 'proj',
  settings: { defaultBranch: 'develop' },
} as unknown as RegisteredGroup;

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    project_id: 'proj',
    status: 'backlog',
    branch_name: `branch-${id}`,
    merge_commit: null,
    ...overrides,
  } as Task;
}

function notice(content: string, created_at = PARKED_AT): TaskMessage {
  return {
    id: `m-${Math.random()}`,
    task_id: 't1',
    role: 'system',
    entry_type: 'system_notice',
    content,
    created_at,
  } as TaskMessage;
}

const parked = () =>
  notice('**Review approved, merge pending** — dirty checkout');

function setup(
  tasks: Task[],
  options: {
    messages?: Record<string, TaskMessage[]>;
    runs?: ActiveRun[];
    drift?: ApprovalDrift;
    safe?: boolean;
    merge?: Awaited<
      ReturnType<MergeRetryDependencies['mergeTaskBranchWithResolution']>
    >;
    enabled?: boolean;
    stillParked?: boolean;
  } = {},
) {
  const notices: string[] = [];
  const mergeCalls: string[] = [];
  const completed: string[] = [];
  const drained: string[] = [];
  const deps: MergeRetryDependencies = {
    isEnabled: () => options.enabled ?? true,
    listTasks: async () => tasks,
    getGroup: () => group,
    readMessages: (_project, taskId) =>
      options.messages?.[taskId] ?? [parked()],
    getRuns: async () => options.runs ?? [],
    branchExists: async () => true,
    stillParked: async () => options.stillParked ?? true,
    sharedCheckoutIsSafe: mock(async () => options.safe ?? true),
    inspectDrift: async () =>
      options.drift ?? { ok: true, developFiles: [], taskFiles: ['a.ts'] },
    mergeTaskBranchWithResolution: async (t) => {
      mergeCalls.push(t.id);
      return options.merge ?? { mergeOk: true, output: 'merged' };
    },
    completeApprovedMerge: async (t) => {
      completed.push(t.id);
      return true;
    },
    drainProjectQueue: async (projectId) => {
      drained.push(projectId);
    },
    appendNotice: (_task, content) => notices.push(content),
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
  };
  return { deps, notices, mergeCalls, completed, drained };
}

describe('sweepParkedApprovedMerges', () => {
  test('merges an eligible card once and completes it', async () => {
    const { deps, mergeCalls, completed, notices } = setup([task('t1')]);
    const result = await sweepParkedApprovedMerges(deps);
    expect(result).toEqual({ attempted: 1, merged: 1 });
    expect(mergeCalls).toEqual(['t1']);
    expect(completed).toEqual(['t1']);
    expect(notices).toEqual([]);
  });

  test('drains the project queue once after a merge, not after refusals or conflicts', async () => {
    const merged = setup([task('t1')]);
    await sweepParkedApprovedMerges(merged.deps);
    expect(merged.drained).toEqual(['proj']);

    const conflict = setup([task('t1')], {
      merge: { mergeOk: false, failureKind: 'conflict', output: 'CONFLICT' },
    });
    await sweepParkedApprovedMerges(conflict.deps);
    expect(conflict.drained).toEqual([]);

    const refused = setup([task('t1')]);
    refused.deps.completeApprovedMerge = async () => false;
    await sweepParkedApprovedMerges(refused.deps);
    expect(refused.drained).toEqual([]);
  });

  test('a failing drain is logged and does not change the outcome', async () => {
    const { deps } = setup([task('t1')]);
    const warn = mock(() => {});
    deps.drainProjectQueue = async () => {
      throw new Error('drain boom');
    };
    deps.logger = { ...deps.logger, warn };
    expect(await attemptParkedMerge(task('t1'), group, [], deps)).toBe(
      'merged',
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('dirty checkout: no merge, no notice', async () => {
    const { deps, mergeCalls, notices } = setup([task('t1')], { safe: false });
    await sweepParkedApprovedMerges(deps);
    expect(mergeCalls).toEqual([]);
    expect(notices).toEqual([]);
  });

  test('overlapping develop drift: no merge, exactly one notice across passes', async () => {
    const { deps, mergeCalls, notices } = setup([task('t1')], {
      drift: { ok: true, developFiles: ['a.ts'], taskFiles: ['a.ts', 'b.ts'] },
    });
    await sweepParkedApprovedMerges(deps);
    expect(mergeCalls).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(
      'develop changed overlapping files; move to review',
    );

    // The notice is persisted on the card; a later pass must not repeat it.
    const second = setup([task('t1')], {
      messages: {
        t1: [parked(), notice(notices[0], LATER)],
      },
      drift: { ok: true, developFiles: ['a.ts'], taskFiles: ['a.ts'] },
    });
    await sweepParkedApprovedMerges(second.deps);
    expect(second.notices).toEqual([]);
    expect(second.mergeCalls).toEqual([]);
  });

  test('non-overlapping develop drift still merges', async () => {
    const { deps, mergeCalls } = setup([task('t1')], {
      drift: { ok: true, developFiles: ['x.ts'], taskFiles: ['a.ts'] },
    });
    await sweepParkedApprovedMerges(deps);
    expect(mergeCalls).toEqual(['t1']);
  });

  test('git error during the drift check fails closed', async () => {
    const { deps, mergeCalls } = setup([task('t1')], {
      drift: { ok: false, error: 'merge-base failed' },
    });
    await sweepParkedApprovedMerges(deps);
    expect(mergeCalls).toEqual([]);
  });

  test('conflict keeps the card parked with a notice and no rework', async () => {
    const { deps, notices, completed } = setup([task('t1')], {
      merge: {
        mergeOk: false,
        failureKind: 'conflict',
        output: 'CONFLICT (content): Merge conflict in a.ts',
      },
    });
    const result = await sweepParkedApprovedMerges(deps);
    expect(result.merged).toBe(0);
    expect(completed).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('move to review');
  });

  test('environment failure lists blocking paths even when output is long', async () => {
    const { deps, notices, completed } = setup([task('t1')], {
      merge: {
        mergeOk: false,
        failureKind: 'environment',
        output: `[env] dirty ${'x'.repeat(5000)}\n\nBlocking default checkout entries:\n?? "dup.ts"`,
        blockers: [{ path: 'src/a.ts', status: ' M' }] as never,
      },
    });
    await sweepParkedApprovedMerges(deps);
    expect(completed).toEqual([]);
    expect(notices[0]).toContain('Merge retry failed');
    expect(notices[0]).toContain('M "src/a.ts"');
    expect(notices[0]).not.toContain('dup.ts');
  });

  test('checkpoint-pending notices and cards with a later run are not eligible', async () => {
    const checkpoint = setup([task('t1')], {
      messages: { t1: [notice('**Task checkpoint pending** — dirty')] },
    });
    await sweepParkedApprovedMerges(checkpoint.deps);
    expect(checkpoint.mergeCalls).toEqual([]);

    const ran = setup([task('t1')], {
      runs: [{ id: 'r1', started_at: LATER } as ActiveRun],
    });
    await sweepParkedApprovedMerges(ran.deps);
    expect(ran.mergeCalls).toEqual([]);
  });

  test('at most one attempt per project per pass', async () => {
    const { deps, mergeCalls } = setup([task('t1'), task('t2')]);
    await sweepParkedApprovedMerges(deps);
    expect(mergeCalls).toEqual(['t1']);
  });

  test('stops after three prior merge-retry notices', async () => {
    const retries = [1, 2, 3].map((n) =>
      notice(
        '**Merge retry failed** — still dirty',
        `2026-01-01T00:0${n}:00.000Z`,
      ),
    );
    const exhausted = setup([task('t1')], {
      messages: { t1: [parked(), ...retries] },
    });
    await sweepParkedApprovedMerges(exhausted.deps);
    expect(exhausted.mergeCalls).toEqual([]);

    const remaining = setup([task('t1')], {
      messages: { t1: [parked(), ...retries.slice(0, 2)] },
    });
    await sweepParkedApprovedMerges(remaining.deps);
    expect(remaining.mergeCalls).toEqual(['t1']);
  });

  test('at most five attempts per pass across projects', async () => {
    const tasks = Array.from({ length: 7 }, (_, i) =>
      task(`t${i}`, { project_id: `proj-${i}` }),
    );
    const { deps, mergeCalls } = setup(tasks);
    await sweepParkedApprovedMerges(deps);
    expect(mergeCalls).toHaveLength(5);
  });

  test('card moved or running since the pass began is not merged', async () => {
    const { deps, mergeCalls, notices } = setup([task('t1')], {
      stillParked: false,
    });
    expect(await sweepParkedApprovedMerges(deps)).toEqual({
      attempted: 0,
      merged: 0,
    });
    expect(mergeCalls).toEqual([]);
    expect(notices).toEqual([]);
  });

  test('kill switch disables the sweep', async () => {
    const { deps, mergeCalls } = setup([task('t1')], { enabled: false });
    expect(await sweepParkedApprovedMerges(deps)).toEqual({
      attempted: 0,
      merged: 0,
    });
    expect(mergeCalls).toEqual([]);
    expect(isMergeRetrySweepEnabled({ TASK_MERGE_RETRY_SWEEP: '0' })).toBe(
      false,
    );
    expect(isMergeRetrySweepEnabled({})).toBe(true);
  });
});
