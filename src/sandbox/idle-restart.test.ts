import { beforeEach, describe, expect, test } from 'bun:test';
import type { RegisteredGroup } from '../types.js';
import {
  BRAIN_DRAIN_LEASE_MS,
  createIdleRestartManager,
  type IdleRestartDeps,
} from './idle-restart.js';
import {
  countActiveServiceBuilds,
  holdServiceBuild,
} from './service-builds.js';

const INSTANCE = 'proj-a';
const BRAIN = 'brain-a';

function group(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
  };
}

type BrainCall = { method: string; path: string };

/** Build a manager with controllable runs/brain state and recorded effects. */
function harness(
  options: {
    withBrain?: boolean;
    /** Instance hosting the brain; null when it cannot be determined. */
    brainInstance?: string | null;
    ownBrain?: boolean;
    /** Count builds from the real service-build tracker. */
    realBuilds?: boolean;
  } = {},
) {
  const state = {
    taskRuns: 0,
    chatRuns: 0,
    activeObjectiveIds: [] as string[],
    drainStatus: 200,
    /** Makes reading the run counts reject. */
    failCounts: false,
    statusOk: true,
    holds: 0 as number | null,
    /** Delays the response of POST /drain until resolved. */
    postGate: undefined as Promise<void> | undefined,
    postPending: 0,
  };
  const brainCalls: BrainCall[] = [];
  const restarts: unknown[] = [];
  const drained: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  let ticker: (() => void) | undefined;
  let cancelled = false;
  const groups = [group('proj-a'), group('proj-a-child'), group('other')];
  if (options.ownBrain) groups[0].settings = { brainContainer: BRAIN };
  const deps: Partial<IdleRestartDeps> = {
    countTaskRuns: async () => {
      if (state.failCounts) throw new Error('database unavailable');
      return state.taskRuns;
    },
    countChatRuns: async () => state.chatRuns,
    countHolds: async () => state.holds,
    ...(options.realBuilds
      ? { countBuilds: () => countActiveServiceBuilds() }
      : {}),
    listGroups: () => groups,
    instanceOf: (g) => (g.folder === 'other' ? 'other-instance' : INSTANCE),
    resolveBrainContainer: ((g: RegisteredGroup) =>
      options.withBrain === false || g.folder === 'other'
        ? undefined
        : BRAIN) as IdleRestartDeps['resolveBrainContainer'],
    resolveBrainInstance: () =>
      options.brainInstance === null
        ? undefined
        : (options.brainInstance ?? INSTANCE),
    resolveBrainAuthToken: (() =>
      'token') as IdleRestartDeps['resolveBrainAuthToken'],
    fetchBrain: (async (
      _container: string,
      path: string,
      init?: RequestInit,
    ) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && state.postGate) {
        state.postPending++;
        await state.postGate;
      }
      // Recorded when the brain applies it, so a gated POST lands late.
      brainCalls.push({ method, path });
      if (path === '/status') {
        if (!state.statusOk) throw new Error('unreachable');
        return Response.json({
          processor: { activeObjectiveIds: state.activeObjectiveIds },
        });
      }
      return new Response(null, { status: state.drainStatus });
    }) as IdleRestartDeps['fetchBrain'],
    resolveTarget: (pending) => pending.target,
    restart: async (request) => {
      restarts.push(request);
      return true;
    },
    drainProjectQueue: async (project) => {
      drained.push(project);
    },
    broadcast: ((event: { payload: Record<string, unknown> }) => {
      events.push(event.payload);
    }) as IdleRestartDeps['broadcast'],
    schedule: (tick) => {
      ticker = tick;
      return () => {
        cancelled = true;
      };
    },
  };
  const manager = createIdleRestartManager(deps);
  const request = () =>
    manager.requestIdleRestart({
      stack: 'stack',
      instance: INSTANCE,
      requestedBy: 'tester',
      target: undefined,
    });
  return {
    state,
    brainCalls,
    restarts,
    drained,
    events,
    manager,
    request,
    isCancelled: () => cancelled,
    hasTimer: () => ticker !== undefined,
  };
}

describe('restart when idle', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  test('waits for an active task run, then restarts exactly once', async () => {
    h.state.taskRuns = 1;
    await h.request();
    await h.manager.poll();
    expect(h.restarts).toHaveLength(0);
    expect(h.manager.isIdleRestartPending(INSTANCE)).toBe(true);
    expect(h.events.map((e) => e.action)).toEqual(['restart_pending']);

    h.state.taskRuns = 0;
    await h.manager.poll();
    await h.manager.poll();
    expect(h.restarts).toHaveLength(1);
    expect(h.manager.isIdleRestartPending(INSTANCE)).toBe(false);
    // Queued work for every project on the instance resumes afterwards.
    expect(h.drained.sort()).toEqual(['proj-a', 'proj-a-child']);
  });

  test('a restart hold releases the drain and task launches; a cleared hold drains again before restarting', async () => {
    const hb = harness();
    const drains = (method: string) =>
      hb.brainCalls.filter((c) => c.method === method && c.path === '/drain');
    hb.state.holds = 2;
    await hb.request();
    await hb.manager.poll();
    expect(hb.restarts).toHaveLength(0);
    expect(drains('DELETE')).toHaveLength(1);
    expect(hb.manager.isTaskLaunchHeld(INSTANCE)).toBe(false);
    expect(hb.manager.isIdleRestartPending(INSTANCE)).toBe(true);
    expect(hb.manager.getPendingIdleRestart(INSTANCE)?.heldSince).toBeDefined();
    expect(hb.drained.sort()).toEqual(['proj-a', 'proj-a-child']);

    const leases = drains('POST').length;
    await hb.manager.poll();
    await hb.manager.poll();
    expect(drains('POST')).toHaveLength(leases);
    expect(hb.restarts).toHaveLength(0);

    // Holds clear: drain again, one poll of grace, then the restart.
    hb.state.holds = 0;
    await hb.manager.poll();
    expect(drains('POST')).toHaveLength(leases + 1);
    expect(hb.restarts).toHaveLength(0);
    expect(hb.manager.isTaskLaunchHeld(INSTANCE)).toBe(true);
    expect(
      hb.manager.getPendingIdleRestart(INSTANCE)?.heldSince,
    ).toBeUndefined();
    await hb.manager.poll();
    await hb.manager.poll();
    expect(hb.restarts).toHaveLength(1);
    expect(hb.manager.isIdleRestartPending(INSTANCE)).toBe(false);
  });

  test('unreadable restart holds keep draining and holding task launches', async () => {
    const hb = harness();
    hb.state.holds = null;
    await hb.request();
    // The request's own poll plus this one stay below HOLD_CHECK_FAILURE_LIMIT.
    await hb.manager.poll();
    expect(hb.restarts).toHaveLength(0);
    expect(
      hb.manager.getPendingIdleRestart(INSTANCE)?.heldSince,
    ).toBeUndefined();
    expect(hb.manager.isTaskLaunchHeld(INSTANCE)).toBe(true);
    expect(
      hb.brainCalls.filter((c) => c.method === 'POST' && c.path === '/drain')
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(hb.brainCalls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  test('cancelling a held restart resumes work and never restarts', async () => {
    const hb = harness();
    hb.state.holds = 1;
    await hb.request();
    await hb.manager.poll();
    expect(await hb.manager.cancelIdleRestart(INSTANCE)).toBe(true);
    hb.state.holds = 0;
    await hb.manager.poll();
    expect(hb.restarts).toHaveLength(0);
    expect(hb.manager.isIdleRestartPending(INSTANCE)).toBe(false);
    expect(hb.manager.isTaskLaunchHeld(INSTANCE)).toBe(false);
  });

  test('a cancel racing the hold-clear lease leaves no outstanding drain', async () => {
    const hb = harness();
    hb.state.holds = 1;
    await hb.request();
    await hb.manager.poll();
    let open!: () => void;
    hb.state.postGate = new Promise<void>((resolve) => (open = resolve));
    hb.state.holds = 0;
    const polled = hb.manager.poll();
    while (hb.state.postPending === 0) await Bun.sleep(1);
    // Cancel completes while the lease POST is still in flight.
    await hb.manager.cancelIdleRestart(INSTANCE);
    open();
    await polled;
    const drains = hb.brainCalls.filter((c) => c.path === '/drain');
    expect(drains.at(-1)).toEqual({ method: 'DELETE', path: '/drain' });
    expect(hb.restarts).toHaveLength(0);
  });

  test('a queued deploy that has not started building holds the restart', async () => {
    const rb = harness({ realBuilds: true });
    const release = holdServiceBuild('brain');
    try {
      await rb.request();
      await rb.manager.poll();
      expect(rb.restarts).toHaveLength(0);
      const entry = rb.manager.getPendingIdleRestart(INSTANCE)!;
      const waitingOn = await rb.manager.getIdleRestartWaitingOn(entry);
      expect(waitingOn.builds).toBeGreaterThanOrEqual(1);
    } finally {
      release();
    }
    await rb.manager.poll();
    expect(rb.restarts).toHaveLength(1);
  });

  test('waits for an active chat run', async () => {
    h.state.chatRuns = 1;
    await h.request();
    await h.manager.poll();
    expect(h.restarts).toHaveLength(0);
    h.state.chatRuns = 0;
    await h.manager.poll();
    expect(h.restarts).toHaveLength(1);
  });

  test('keeps holding task runs while the restart executes', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const restartStarted = new Promise<void>((resolve) => (started = resolve));
    const drained: string[] = [];
    const manager = createIdleRestartManager({
      countTaskRuns: async () => 0,
      countChatRuns: async () => 0,
      countHolds: async () => 0,
      listGroups: () => [group('proj-a')],
      instanceOf: () => INSTANCE,
      resolveBrainContainer: (() =>
        undefined) as IdleRestartDeps['resolveBrainContainer'],
      resolveTarget: (pending) => pending.target,
      restart: async () => {
        started();
        await gate;
        return true;
      },
      drainProjectQueue: async (project) => {
        drained.push(project);
      },
      broadcast: (() => {}) as IdleRestartDeps['broadcast'],
      schedule: () => () => {},
    });
    await manager.requestIdleRestart({
      stack: 'stack',
      instance: INSTANCE,
      requestedBy: 'tester',
      target: undefined,
    });
    await restartStarted;
    // The entry is gone once idle, but new launches stay held until it ends.
    expect(manager.getPendingIdleRestart(INSTANCE)).toBeUndefined();
    expect(manager.isIdleRestartPending(INSTANCE)).toBe(true);
    expect(drained).toEqual([]);
    release();
    await manager.poll(); // queued behind the in-flight pass
    expect(manager.isIdleRestartPending(INSTANCE)).toBe(false);
    expect(drained).toEqual(['proj-a']);
  });

  test('brain objective runs block the restart; leases renew and release', async () => {
    h.state.activeObjectiveIds = ['obj-x'];
    await h.request();
    await h.manager.poll();
    expect(h.restarts).toHaveLength(0);
    expect(
      h.brainCalls.filter((c) => c.method === 'POST' && c.path === '/drain')
        .length,
    ).toBeGreaterThanOrEqual(2);

    h.state.activeObjectiveIds = [];
    await h.manager.poll();
    expect(h.restarts).toHaveLength(1);
    expect(h.brainCalls.at(-1)).toEqual({ method: 'DELETE', path: '/drain' });
    expect(BRAIN_DRAIN_LEASE_MS).toBe(120_000);
  });

  test('a brain hosted by another sandbox instance is neither leased nor polled', async () => {
    const other = harness({ brainInstance: 'parent-instance' });
    other.state.activeObjectiveIds = ['obj-x'];
    const entry = await other.request();
    await other.manager.poll();
    expect(entry.brainContainers).toEqual([]);
    expect(other.brainCalls).toEqual([]);
    expect(other.restarts).toHaveLength(1);
  });

  test('with an unknown brain instance only a project-configured brain counts', async () => {
    const inherited = harness({ brainInstance: null });
    expect((await inherited.request()).brainContainers).toEqual([]);
    const own = harness({ brainInstance: null, ownBrain: true });
    expect(
      (await own.request()).brainContainers.map((b) => b.container),
    ).toEqual([BRAIN]);
  });

  test('a brain without /drain does not prevent the restart', async () => {
    h.state.drainStatus = 404;
    await h.request();
    await h.manager.poll();
    expect(h.restarts).toHaveLength(1);
  });

  test('a brain whose /status keeps failing is treated as idle after 3 polls', async () => {
    h.state.statusOk = false;
    await h.request(); // poll 1 (fire-and-forget)
    await h.manager.poll(); // poll 2
    expect(h.restarts).toHaveLength(0);
    await h.manager.poll(); // poll 3
    expect(h.restarts).toHaveLength(1);
  });

  test('an immediate restart supersedes a pending one and resumes work only afterwards', async () => {
    h.state.taskRuns = 1;
    await h.request();
    await h.manager.poll();
    const order: string[] = [];
    await h.manager.supersedeIdleRestart(INSTANCE, async () => {
      order.push(
        h.manager.isIdleRestartPending(INSTANCE) ? 'held' : 'unheld',
        `drained:${h.drained.length}`,
      );
    });
    expect(order).toEqual(['held', 'drained:0']);
    expect(h.events.map((e) => e.action)).toContain(
      'restart_pending_cancelled',
    );
    expect(h.brainCalls.at(-1)).toEqual({ method: 'DELETE', path: '/drain' });
    expect(h.drained.sort()).toEqual(['proj-a', 'proj-a-child']);
    expect(h.manager.isIdleRestartPending(INSTANCE)).toBe(false);
    h.state.taskRuns = 0;
    await h.manager.poll();
    expect(h.restarts).toHaveLength(0);
  });

  test('cancel stops the poller, releases leases, resumes work, and never restarts', async () => {
    h.state.taskRuns = 1;
    await h.request();
    await h.manager.poll();
    expect(h.hasTimer()).toBe(true);

    expect(await h.manager.cancelIdleRestart(INSTANCE)).toBe(true);
    expect(await h.manager.cancelIdleRestart(INSTANCE)).toBe(false);
    expect(h.isCancelled()).toBe(true);
    expect(h.brainCalls.at(-1)).toEqual({ method: 'DELETE', path: '/drain' });
    expect(h.events.map((e) => e.action)).toContain(
      'restart_pending_cancelled',
    );
    expect(h.drained.sort()).toEqual(['proj-a', 'proj-a-child']);

    h.state.taskRuns = 0;
    await h.manager.poll();
    expect(h.restarts).toHaveLength(0);
    expect(h.manager.isIdleRestartPending(INSTANCE)).toBe(false);
  });
});

describe('waiting for an executing restart', () => {
  function gatedManager(outcome: 'ok' | 'throw') {
    let finish!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const restartStarted = new Promise<void>((resolve) => (started = resolve));
    const manager = createIdleRestartManager({
      countTaskRuns: async () => 0,
      countChatRuns: async () => 0,
      countHolds: async () => 0,
      listGroups: () => [group('proj-a')],
      instanceOf: () => INSTANCE,
      resolveBrainContainer: (() =>
        undefined) as IdleRestartDeps['resolveBrainContainer'],
      resolveTarget: (pending) => pending.target,
      restart: async () => {
        started();
        await gate;
        if (outcome === 'throw') throw new Error('boom');
        return true;
      },
      drainProjectQueue: async () => {},
      broadcast: (() => {}) as IdleRestartDeps['broadcast'],
      schedule: () => () => {},
    });
    return { manager, finish, restartStarted };
  }
  const request = (manager: ReturnType<typeof createIdleRestartManager>) =>
    manager.requestIdleRestart({
      stack: 'stack',
      instance: INSTANCE,
      requestedBy: 'tester',
      target: undefined,
    });

  for (const outcome of ['ok', 'throw'] as const) {
    test(`resolves only after the restart finishes (${outcome})`, async () => {
      const { manager, finish, restartStarted } = gatedManager(outcome);
      // Not restarting: immediate.
      await manager.waitForSandboxRestart(INSTANCE);
      await request(manager);
      // Only pending (restart not started): still immediate.
      expect(manager.isIdleRestartPending(INSTANCE)).toBe(true);
      await manager.waitForSandboxRestart(INSTANCE);

      const polling = manager.poll();
      await restartStarted;
      const events: string[] = [];
      const waiter = manager
        .holdChatForSandboxRestart(INSTANCE, 'conv-1')
        .then(() => events.push('chat-launched'));
      await manager.waitForSandboxRestart('other-instance');
      // Release the restart; the chat may launch only afterwards.
      events.push('restart-finished');
      finish();
      await Promise.all([polling, waiter]);
      expect(events).toEqual(['restart-finished', 'chat-launched']);
      await manager.waitForSandboxRestart(INSTANCE);
    });
  }

  test('an immediate restart superseding a pending one is awaited too', async () => {
    const { manager, finish } = gatedManager('ok');
    await request(manager);
    let release!: () => void;
    const restartGate = new Promise<void>((resolve) => (release = resolve));
    const events: string[] = [];
    const superseding = manager.supersedeIdleRestart(INSTANCE, async () => {
      await restartGate;
      events.push('restart-finished');
      return true;
    });
    const waiter = manager
      .holdChatForSandboxRestart(INSTANCE, 'conv-2')
      .then(() => events.push('chat-launched'));
    finish();
    release();
    await Promise.all([superseding, waiter]);
    expect(events).toEqual(['restart-finished', 'chat-launched']);
  });

  test('an immediate restart with no pending entry is awaited without holding tasks', async () => {
    const { manager } = gatedManager('ok');
    let release!: () => void;
    const restartGate = new Promise<void>((resolve) => (release = resolve));
    const events: string[] = [];
    const superseding = manager.supersedeIdleRestart(INSTANCE, async () => {
      await restartGate;
      events.push('restart-finished');
      return true;
    });
    expect(manager.isIdleRestartPending(INSTANCE)).toBe(false);
    const waiter = manager
      .holdChatForSandboxRestart(INSTANCE, 'conv-4')
      .then(() => events.push('chat-launched'));
    release();
    await Promise.all([superseding, waiter]);
    expect(events).toEqual(['restart-finished', 'chat-launched']);
  });

  test('a chat stops waiting after the bound and proceeds', async () => {
    const { manager, finish, restartStarted } = gatedManager('ok');
    await request(manager);
    const polling = manager.poll();
    await restartStarted;
    await manager.holdChatForSandboxRestart(INSTANCE, 'conv-3', 1);
    finish();
    await polling;
  });

  test('maintenance waits for a launch already past admission and holds later ones', async () => {
    const { manager } = gatedManager('ok');
    const events: string[] = [];
    // Past admission, run row not recorded yet.
    const early = await manager.admitLaunch(INSTANCE, { chat: true });
    const maintenance = manager.holdInstances([INSTANCE], async () => {
      events.push('maintenance');
    });
    // Arrives while the hold is installed: must wait for it to end.
    const late = manager
      .admitLaunch(INSTANCE, { chat: true })
      .then((ticket) => {
        events.push('late launch admitted');
        ticket.settle();
      });
    await Promise.resolve();
    expect(events).toEqual([]);
    events.push('early run recorded');
    early.settle();
    await Promise.all([maintenance, late]);
    expect(events).toEqual([
      'early run recorded',
      'maintenance',
      'late launch admitted',
    ]);
  });

  test('task and scheduled launches wait for maintenance too', async () => {
    const { manager } = gatedManager('ok');
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const maintenance = manager.holdInstances([INSTANCE], async () => {
      await gate;
      events.push('maintenance done');
    });
    await Promise.resolve();
    const task = manager
      .admitLaunch(INSTANCE, { chat: false })
      .then((ticket) => {
        events.push('task admitted');
        ticket.settle();
      });
    await Promise.resolve();
    expect(events).toEqual([]);
    release();
    await Promise.all([maintenance, task]);
    expect(events).toEqual(['maintenance done', 'task admitted']);
  });

  test('an immediate restart waits for maintenance instead of overlapping it', async () => {
    const { manager } = gatedManager('ok');
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const maintenance = manager.holdInstances([INSTANCE], async () => {
      await gate;
      events.push('maintenance done');
    });
    await Promise.resolve();
    const restart = manager.supersedeIdleRestart(INSTANCE, async () => {
      events.push('restart ran');
      return true;
    });
    await Promise.resolve();
    expect(events).toEqual([]);
    release();
    await Promise.all([maintenance, restart]);
    expect(events).toEqual(['maintenance done', 'restart ran']);
    // Maintenance ending did not release launches the restart still holds.
    await manager.waitForSandboxRestart(INSTANCE);
  });

  test('a restart queued behind maintenance takes the instance before waiting launches', async () => {
    const { manager } = gatedManager('ok');
    const events: string[] = [];
    let releaseMaintenance!: () => void;
    const maintenanceGate = new Promise<void>(
      (resolve) => (releaseMaintenance = resolve),
    );
    const maintenance = manager.holdInstances(
      [INSTANCE],
      () => maintenanceGate,
    );
    let releaseRestart!: () => void;
    const restartGate = new Promise<void>(
      (resolve) => (releaseRestart = resolve),
    );
    let restartStarted!: () => void;
    const started = new Promise<void>((resolve) => (restartStarted = resolve));
    const restart = manager.supersedeIdleRestart(INSTANCE, async () => {
      events.push('restart started');
      restartStarted();
      await restartGate;
      events.push('restart finished');
      return true;
    });
    const chat = manager
      .admitLaunch(INSTANCE, { chat: true })
      .then((ticket) => {
        events.push('chat admitted');
        ticket.settle();
      });
    releaseMaintenance();
    await maintenance;
    await started;
    releaseRestart();
    await Promise.all([restart, chat]);
    expect(events).toEqual([
      'restart started',
      'restart finished',
      'chat admitted',
    ]);
  });

  test('a restart queued behind maintenance gives the instance back when its re-check fails', async () => {
    const hb = harness();
    let releaseMaintenance!: () => void;
    const maintenanceGate = new Promise<void>(
      (resolve) => (releaseMaintenance = resolve),
    );
    const maintenance = hb.manager.holdInstances(
      [INSTANCE],
      () => maintenanceGate,
    );
    await hb.request();
    // The idle pass has accepted the restart and queued it behind the hold.
    while (hb.manager.getPendingIdleRestart(INSTANCE)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    hb.state.failCounts = true;
    releaseMaintenance();
    await maintenance;
    await hb.manager.poll();

    // Nothing may be left holding the instance, and the restart was not dropped.
    const free = await Promise.race([
      hb.manager.waitForSandboxRestart(INSTANCE).then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    expect(free).toBe(true);
    expect(hb.manager.getPendingIdleRestart(INSTANCE)).toBeDefined();
    expect(hb.restarts).toHaveLength(0);
    hb.state.failCounts = false;
    await hb.manager.poll();
    await hb.manager.poll();
    expect(hb.restarts).toHaveLength(1);
  });
});
