import { describe, expect, test } from 'bun:test';

import { computeObjectiveWorkDir } from '../modules/objectives/work-dir.js';
import type { RegisteredGroup } from '../types.js';
import {
  createIdleRestartManager,
  type IdleRestartDeps,
} from './idle-restart.js';
import { admitRun, type RunAdmissionDeps } from './run-admission.js';

const base = { name: 'kid', folder: 'kid', trigger: '!', added_at: 'x' };
const attached = { ...base, parentId: 'owner' } as RegisteredGroup;
const detached = { ...base } as RegisteredGroup;

function deps(overrides: Partial<RunAdmissionDeps> = {}) {
  const settled: string[] = [];
  const admitted: Array<string | undefined> = [];
  // The detach has been saved by the time the launch is admitted again.
  const registry = { current: detached };
  const result: RunAdmissionDeps = {
    // The first admission waits for the parent change; the re-admission to
    // the instance the project uses now finds nothing to wait for.
    admit: async (instance) => {
      admitted.push(instance);
      return {
        waited: admitted.length === 1,
        settle: () => void settled.push('settled'),
      };
    },
    resolveInstance: (g) => (g.parentId ? 'owner' : g.folder),
    getGroup: () => registry.current,
    getObjective: async (id) => ({
      id,
      work_dir: computeObjectiveWorkDir('kid', id, undefined),
    }),
    ...overrides,
  };
  return { deps: result, settled, admitted };
}

describe('admitRun', () => {
  test('after waiting for a parent change, uses the project and objective directory as they are now', async () => {
    const { deps: d, admitted } = deps();
    const stale = computeObjectiveWorkDir('kid', 'obj-1', 'owner');

    const run = await admitRun(
      attached,
      {
        group_folder: 'kid',
        conversation_id: 'conv-1',
        work_dir: stale,
        objective_work_dir_of: 'obj-1',
      },
      d,
    );

    expect(run.group.parentId).toBeUndefined();
    expect(run.input.work_dir).toBe('/workspace/group/objectives/obj-1');
    // Admitted to the old instance first, then to the one it uses now.
    expect(admitted).toEqual(['owner', 'kid']);
  });

  test('a launch that did not wait keeps what its caller resolved', async () => {
    const { deps: d } = deps({
      admit: async () => ({ waited: false, settle() {} }),
    });
    const input = {
      group_folder: 'kid',
      work_dir: '/custom',
      objective_work_dir_of: 'obj-1',
    };

    const run = await admitRun(attached, input, d);

    expect(run.group).toBe(attached);
    expect(run.input).toBe(input);
  });

  test('a failed refresh after the wait leaves no ticket behind for the next maintenance', async () => {
    // The real admission: a hold in progress, a launch that waits for it, and
    // an objective read that fails once it is admitted.
    const manager = createIdleRestartManager({
      listGroups: () => [],
      drainProjectQueue: async () => {},
      broadcast: (() => {}) as IdleRestartDeps['broadcast'],
      schedule: () => () => {},
    });
    let releaseHold!: () => void;
    const holding = new Promise<void>((resolve) => (releaseHold = resolve));
    const first = manager.holdInstances(['kid'], () => holding);
    const { deps: d } = deps({
      admit: manager.admitLaunch,
      resolveInstance: () => 'kid',
      getObjective: async () => {
        throw new Error('db down');
      },
    });
    const launch = admitRun(
      attached,
      { group_folder: 'kid', objective_work_dir_of: 'obj-1' },
      d,
    );
    const outcome = launch.then(
      () => undefined,
      (err: unknown) => err,
    );
    releaseHold();
    await first;
    expect((await outcome) as Error).toMatchObject({ message: 'db down' });

    // A leaked ticket would make this wait for a launch that never records a
    // run; the bound only keeps a failure from hanging.
    expect(await manager.holdInstances(['kid'], async () => 'held', 200)).toBe(
      'held',
    );
  });
});
