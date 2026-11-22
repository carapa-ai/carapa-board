/**
 * Restart-when-idle for a managed sandbox instance ("drain mode").
 *
 * While a restart is pending the board stops launching new task runs on the
 * instance (see `isIdleRestartPending`, consulted by the queue drain) and
 * leases a drain on the instance's carapa-brain containers so they stop
 * starting objective runs. Chat messages are NOT blocked; they only delay the
 * restart. Once no task run, chat run or brain objective run is active (and,
 * for sandboxes built on CarapaBrain images, no deploy build is running) the
 * normal restart runs and held work resumes. A restart hold set inside the
 * sandbox (`restart-hold`, see restart-holds.ts) also delays it, for long
 * processes the board does not track as runs. While a hold blocks the pending
 * restart the drain is released and task launches continue (see
 * `isTaskLaunchHeld`); when the holds clear the drain returns and the restart
 * waits for idleness again.
 *
 * Pending restarts live in memory only: a board restart forgets them (the
 * brain drain lease expires on its own).
 */
import {
  getActiveChatRunsForSandboxInstance,
  getActiveTaskRunsForSandboxInstance,
} from '../db/active-runs.js';
import { DEFAULT_SANDBOX_STACK } from '../config.js';
import { withTimeout } from '../lib/async.js';
import { logger } from '../logger.js';
import {
  fetchBrain,
  resolveBrainAuthToken,
  resolveBrainContainer,
  resolveBrainSandboxInstance,
} from '../modules/objectives/brain-client.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import { countActiveServiceBuilds } from './service-builds.js';
import { countSandboxRestartHolds } from './restart-holds.js';
import { getGroupByFolder, registeredGroups } from '../state-manager.js';
import type { RegisteredGroup } from '../types.js';
import {
  lifecycleSandboxInstance,
  resolveEffectiveSandbox,
} from './effective-settings.js';
import {
  performSandboxRestart,
  type SandboxRestartRequest,
} from './restart.js';

export const IDLE_RESTART_POLL_MS = 10_000;
/** Longest a chat launch waits for an executing restart before proceeding. */
export const CHAT_RESTART_WAIT_MS = 180_000;
export const BRAIN_DRAIN_LEASE_MS = 120_000;
export const BRAIN_STATUS_FAILURE_LIMIT = 3;
/** Consecutive unreadable restart-hold checks before the sandbox counts as unheld. */
export const HOLD_CHECK_FAILURE_LIMIT = 3;
/** A pending restart held by restart holds this long is logged once as a warning. */
export const HELD_RESTART_WARN_MS = 4 * 60 * 60_000;
const BRAIN_REQUEST_TIMEOUT_MS = 5_000;

export interface PendingIdleRestartBrain {
  container: string;
  authToken: string;
}

export interface PendingIdleRestart {
  stack: string;
  instance: string;
  service?: string;
  requestedBy: string;
  requestedAt: string;
  /** Audit trail for agent (MCP) requests; absent for HTTP requests. */
  source?: 'mcp';
  reason?: string;
  conversationId?: string;
  runId?: string;
  target: SandboxRestartRequest['target'];
  brainContainers: PendingIdleRestartBrain[];
  /**
   * ISO time restart holds started blocking this restart. While set, the brain
   * drain is released and task launches continue.
   */
  heldSince?: string;
}

export interface IdleRestartWaitingOn {
  taskRuns: number;
  chatRuns: number;
  /** Launches admitted but not yet recorded as active runs. */
  launches: number;
  brainRuns: number;
  /** Deploy builds in progress; restarting now would reuse the old images. */
  builds: number;
  /** Restart holds set inside the sandbox by long-running processes. */
  holds: number;
}

export interface IdleRestartDeps {
  countTaskRuns: (instance: string) => Promise<number>;
  countChatRuns: (instance: string) => Promise<number>;
  /** Deploy builds that must finish before restarting this stack. */
  countBuilds: (stack: string) => number;
  /** Active restart holds in the sandbox; null when they cannot be read. */
  countHolds: (entry: PendingIdleRestart) => Promise<number | null>;
  /** Registered projects, de-duplicated by folder. */
  listGroups: () => RegisteredGroup[];
  instanceOf: (group: RegisteredGroup) => string;
  fetchBrain: typeof fetchBrain;
  resolveBrainContainer: typeof resolveBrainContainer;
  resolveBrainAuthToken: typeof resolveBrainAuthToken;
  /** Sandbox instance a brain container runs in; undefined when unknown. */
  resolveBrainInstance: (container: string) => string | undefined;
  /** Re-resolve the restart target when the restart actually runs. */
  resolveTarget: (
    pending: PendingIdleRestart,
  ) => SandboxRestartRequest['target'];
  restart: (request: SandboxRestartRequest) => Promise<boolean>;
  drainProjectQueue: (project: string, group: RegisteredGroup) => Promise<void>;
  broadcast: typeof broadcast;
  /** Run `tick` repeatedly until the returned canceller is called. */
  schedule: (tick: () => void, intervalMs: number) => () => void;
  now: () => Date;
}

const defaultDeps: IdleRestartDeps = {
  countTaskRuns: async (instance) =>
    (await getActiveTaskRunsForSandboxInstance(instance)).length,
  countChatRuns: async (instance) =>
    (await getActiveChatRunsForSandboxInstance(instance)).length,
  // Plain CarapaBot sandboxes do not run CarapaBrain-derived images, which
  // are what deploy builds replace; every other stack does.
  countBuilds: (stack) =>
    stack === DEFAULT_SANDBOX_STACK ? 0 : countActiveServiceBuilds(),
  countHolds: (entry) =>
    countSandboxRestartHolds(entry.stack, entry.service, entry.instance),
  listGroups: () => [
    ...new Map(
      Object.values(registeredGroups).map((group) => [group.folder, group]),
    ).values(),
  ],
  instanceOf: (group) =>
    lifecycleSandboxInstance(resolveEffectiveSandbox(group)),
  fetchBrain,
  resolveBrainContainer,
  resolveBrainAuthToken,
  resolveBrainInstance: resolveBrainSandboxInstance,
  resolveTarget: (pending) => {
    const folder = pending.target?.group.folder;
    const group = folder ? getGroupByFolder(folder) : undefined;
    return group ? resolveEffectiveSandbox(group) : pending.target;
  },
  restart: performSandboxRestart,
  drainProjectQueue: async (project, group) => {
    // Lazy: the task pipeline imports this module for the launch hold.
    const { drainProjectQueue } =
      await import('../modules/kanban/task/pipeline.js');
    await drainProjectQueue(project, group);
  },
  broadcast,
  schedule: (tick, intervalMs) => {
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },
  now: () => new Date(),
};

export function createIdleRestartManager(
  overrides: Partial<IdleRestartDeps> = {},
) {
  const deps: IdleRestartDeps = { ...defaultDeps, ...overrides };
  const pending = new Map<string, PendingIdleRestart>();
  /** Instances whose idle restart is executing; new task runs stay held. */
  const restarting = new Set<string>();
  /** Completion of every executing restart (also immediate ones with no pending entry). */
  const executing = new Map<string, Promise<void>>();
  /** Instances held for maintenance: launches wait for it without a time limit. */
  const maintenance = new Set<string>();
  /** Launches past admission whose active_runs row is not recorded yet. */
  const launches = new Map<string, Set<Promise<void>>>();
  /** Admission sequence detects launches that start and settle during a count. */
  const launchVersions = new Map<string, number>();
  /** Restarts and maintenance holds queued for an instance, in arrival order. */
  const waiters = new Map<string, Array<() => void>>();
  /**
   * Mark an instance as executing a restart (or, with `isMaintenance`, a
   * maintenance hold); the returned function ends that phase. `holdTasks`
   * additionally keeps new task runs held (idle restarts). Ending hands the
   * instance to the next queued owner in the same synchronous step, before
   * launches waiting on this phase resume, so no launch slips in between.
   */
  const beginRestart = (
    instance: string,
    holdTasks = true,
    isMaintenance = false,
  ): (() => void) => {
    let done!: () => void;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });
    executing.set(instance, completion);
    if (holdTasks) restarting.add(instance);
    if (isMaintenance) maintenance.add(instance);
    return () => {
      if (executing.get(instance) === completion) executing.delete(instance);
      if (holdTasks) restarting.delete(instance);
      if (isMaintenance) maintenance.delete(instance);
      const queue = waiters.get(instance);
      queue?.shift()?.();
      if (queue?.length === 0) waiters.delete(instance);
      done();
    };
  };
  /**
   * Become the executing owner of `instance`: at once when it is free,
   * otherwise queued behind the current owner and the owners already waiting.
   * Ownership starts synchronously when it is granted.
   */
  const acquireRestart = (
    instance: string,
    holdTasks = true,
    isMaintenance = false,
  ): Promise<() => void> => {
    if (!executing.has(instance)) {
      return Promise.resolve(beginRestart(instance, holdTasks, isMaintenance));
    }
    return new Promise((resolve) => {
      const queue = waiters.get(instance) ?? [];
      waiters.set(instance, queue);
      queue.push(() =>
        resolve(beginRestart(instance, holdTasks, isMaintenance)),
      );
    });
  };
  /**
   * Own `instance` for the duration of `body`, then give it back whatever
   * `body` did. Everything done while owning it (re-checks, brain leases, the
   * restart itself) sits inside this boundary: an owner that fails must never
   * leave the instance held.
   */
  async function whileOwning<T>(
    instance: string,
    holdTasks: boolean,
    body: () => Promise<T>,
  ): Promise<T> {
    const end = await acquireRestart(instance, holdTasks);
    try {
      return await body();
    } finally {
      end();
    }
  }
  /** Consecutive failed /status polls per `${instance}\0${container}`. */
  const statusFailures = new Map<string, number>();
  /** Consecutive unreadable restart-hold checks per instance. */
  const holdFailures = new Map<string, number>();
  /** Held entries already logged for exceeding `HELD_RESTART_WARN_MS`. */
  const heldWarned = new WeakSet<PendingIdleRestart>();
  let cancelTimer: (() => void) | undefined;
  /** Poll passes run strictly one after another. */
  let passes: Promise<void> = Promise.resolve();
  let queuedPasses = 0;

  /** Completion time of the last restart per instance (immediate or idle). */
  const lastRestartAt = new Map<string, string>();
  const recordRestart = (instance: string) =>
    lastRestartAt.set(instance, deps.now().toISOString());

  const sandboxStatus = (entry: PendingIdleRestart, action: string) =>
    deps.broadcast({
      type: 'sandbox_status',
      payload: {
        stack: entry.stack,
        instance: entry.instance,
        action,
        ...(action === 'restart_pending' && entry.source
          ? {
              requestedBy: entry.requestedBy,
              reason: entry.reason,
              source: entry.source,
              conversationId: entry.conversationId,
              runId: entry.runId,
            }
          : {}),
      },
    });

  function ensureTimer() {
    if (cancelTimer || pending.size === 0) return;
    cancelTimer = deps.schedule(() => {
      // A slow pass (brain timeouts) must not pile up further ticks.
      if (queuedPasses === 0) void poll();
    }, IDLE_RESTART_POLL_MS);
  }

  function stopTimerIfUnused() {
    if (pending.size > 0) return;
    cancelTimer?.();
    cancelTimer = undefined;
  }

  const brainKey = (
    entry: PendingIdleRestart,
    brain: PendingIdleRestartBrain,
  ) => `${entry.instance}\0${brain.container}`;

  function brainRequest(
    brain: PendingIdleRestartBrain,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ) {
    return deps.fetchBrain(brain.container, path, {
      method,
      headers: {
        Authorization: `Bearer ${brain.authToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(BRAIN_REQUEST_TIMEOUT_MS),
    });
  }

  /** Lease (or renew) the brain drain. A brain that is unreachable or answers without /drain does not block the restart. */
  async function leaseBrains(entry: PendingIdleRestart) {
    await Promise.all(
      entry.brainContainers.map(async (brain) => {
        try {
          const res = await brainRequest(brain, 'POST', '/drain', {
            ttlMs: BRAIN_DRAIN_LEASE_MS,
          });
          if (!res?.ok) {
            logger.debug(
              { container: brain.container, status: res?.status },
              'Brain drain lease unavailable; waiting for active objectives instead',
            );
          }
        } catch (err) {
          logger.debug(
            { container: brain.container, err: String(err) },
            'Brain drain lease request failed',
          );
        }
      }),
    );
  }

  async function releaseBrains(entry: PendingIdleRestart) {
    await Promise.all(
      entry.brainContainers.map((brain) =>
        brainRequest(brain, 'DELETE', '/drain').catch(() => undefined),
      ),
    );
  }

  /**
   * Lease the drain, then report whether the entry is still the pending one.
   * A cancel that ran while the POST was in flight may have sent its DELETE
   * first, so the late lease is released again; a replaced entry or an
   * executing restart releases the drain itself.
   */
  async function leaseWhilePending(entry: PendingIdleRestart) {
    await leaseBrains(entry);
    if (pending.get(entry.instance) === entry) return true;
    if (!pending.has(entry.instance) && !restarting.has(entry.instance)) {
      await releaseBrains(entry);
    }
    return false;
  }

  /**
   * Active objective runs on one brain, or null when its status is unavailable
   * and the failure cap has not been reached (the brain counts as not idle).
   */
  async function brainActiveRuns(
    entry: PendingIdleRestart,
    brain: PendingIdleRestartBrain,
    trackFailures: boolean,
  ): Promise<number | null> {
    const key = brainKey(entry, brain);
    try {
      const res = await brainRequest(brain, 'GET', '/status');
      if (!res?.ok) throw new Error(`status ${res?.status ?? 'unreachable'}`);
      const body = (await res.json()) as {
        processor?: { activeObjectiveIds?: unknown };
      };
      const ids = body.processor?.activeObjectiveIds;
      if (!Array.isArray(ids)) throw new Error('malformed status payload');
      statusFailures.delete(key);
      return ids.length;
    } catch (err) {
      if (!trackFailures) return null;
      const failures = (statusFailures.get(key) ?? 0) + 1;
      statusFailures.set(key, failures);
      if (failures < BRAIN_STATUS_FAILURE_LIMIT) return null;
      logger.warn(
        { container: brain.container, failures, err: String(err) },
        'Brain status unreachable repeatedly; treating it as idle for restart',
      );
      return 0;
    }
  }

  /**
   * Active restart holds, or null while they are unreadable and the failure
   * cap has not been reached (the sandbox counts as held). A stack without
   * the `restart-hold` command reaches the cap and counts as unheld.
   */
  async function activeHolds(
    entry: PendingIdleRestart,
    trackFailures: boolean,
  ): Promise<number | null> {
    const holds = await deps.countHolds(entry).catch(() => null);
    if (holds !== null) {
      holdFailures.delete(entry.instance);
      return holds;
    }
    if (!trackFailures) return null;
    const failures = (holdFailures.get(entry.instance) ?? 0) + 1;
    holdFailures.set(entry.instance, failures);
    if (failures < HOLD_CHECK_FAILURE_LIMIT) return null;
    if (failures === HOLD_CHECK_FAILURE_LIMIT) {
      logger.info(
        { instance: entry.instance, failures },
        'Restart holds unreadable; treating sandbox as unheld for restart',
      );
    }
    return 0;
  }

  async function evaluate(entry: PendingIdleRestart, trackFailures: boolean) {
    // A launch may settle while the database counts are in flight; retain
    // the initial count until the next poll so its row cannot be missed.
    const startingLaunches = launches.get(entry.instance)?.size ?? 0;
    const startVersion = launchVersions.get(entry.instance) ?? 0;
    const [taskRuns, chatRuns, brains, holds] = await Promise.all([
      deps.countTaskRuns(entry.instance),
      deps.countChatRuns(entry.instance),
      Promise.all(
        entry.brainContainers.map((brain) =>
          brainActiveRuns(entry, brain, trackFailures),
        ),
      ),
      activeHolds(entry, trackFailures),
    ]);
    const builds = deps.countBuilds(entry.stack);
    const launchVersion = launchVersions.get(entry.instance) ?? 0;
    const waitingOn: IdleRestartWaitingOn = {
      taskRuns,
      chatRuns,
      launches: Math.max(
        startingLaunches,
        launches.get(entry.instance)?.size ?? 0,
        Number(launchVersion !== startVersion),
      ),
      brainRuns: brains.reduce<number>((sum, runs) => sum + (runs ?? 0), 0),
      builds,
      holds: holds ?? 0,
    };
    const idle =
      taskRuns === 0 &&
      chatRuns === 0 &&
      waitingOn.launches === 0 &&
      builds === 0 &&
      holds === 0 &&
      brains.every((runs) => runs === 0);
    return { idle, waitingOn, holds, launchVersion };
  }

  function groupsOnInstance(instance: string) {
    return deps
      .listGroups()
      .filter((group) => deps.instanceOf(group) === instance);
  }

  async function resumeHeldWork(instance: string) {
    for (const group of groupsOnInstance(instance)) {
      try {
        await deps.drainProjectQueue(group.folder, group);
      } catch (err) {
        logger.warn(
          { project: group.folder, err: String(err) },
          'Failed to resume queued tasks after idle restart',
        );
      }
    }
  }

  function forget(entry: PendingIdleRestart) {
    pending.delete(entry.instance);
    holdFailures.delete(entry.instance);
    for (const brain of entry.brainContainers) {
      statusFailures.delete(brainKey(entry, brain));
    }
    stopTimerIfUnused();
  }

  async function runRestart(entry: PendingIdleRestart) {
    // Maintenance (a parent change) or another restart may be executing.
    const queued = executing.has(entry.instance);
    let ran = false;
    const requeue = () => {
      if (!pending.has(entry.instance)) {
        pending.set(entry.instance, entry);
        ensureTimer();
      }
    };
    try {
      await whileOwning(entry.instance, true, async () => {
        if (queued) {
          // The idle check that led here predates what just ended, and its
          // brain lease may have been released by it: check again first. A
          // check that cannot be made keeps the restart pending.
          try {
            await leaseBrains(entry);
            const result = await evaluate(entry, false);
            if (
              !result.idle ||
              (launchVersions.get(entry.instance) ?? 0) !== result.launchVersion
            )
              return requeue();
          } catch (err) {
            logger.warn(
              { instance: entry.instance, err: String(err) },
              'Idle re-check before a queued restart failed; keeping it pending',
            );
            return requeue();
          }
        }
        ran = true;
        try {
          const restarted = await deps.restart({
            stack: entry.stack,
            instance: entry.instance,
            target: deps.resolveTarget(entry),
          });
          if (restarted) recordRestart(entry.instance);
        } catch (err) {
          logger.error(
            { instance: entry.instance, err: String(err) },
            'Idle sandbox restart threw',
          );
        } finally {
          // The restart reports restarted / restart_failed itself; either way
          // the brain drain ends so objectives resume.
          await releaseBrains(entry);
        }
      });
    } finally {
      // Queued tasks resume once the instance is given back.
      if (ran) await resumeHeldWork(entry.instance);
    }
  }

  /** Poll a restart held by restart holds: watch the holds only. */
  async function pollHeldEntry(entry: PendingIdleRestart, heldSince: string) {
    const holds = await activeHolds(entry, true);
    if (pending.get(entry.instance) !== entry) return;
    const heldForMs = deps.now().getTime() - Date.parse(heldSince);
    if (holds === null) return;
    if (holds > 0) {
      if (heldForMs > HELD_RESTART_WARN_MS && !heldWarned.has(entry)) {
        heldWarned.add(entry);
        logger.warn(
          {
            instance: entry.instance,
            holds,
            heldForMs,
            requestedBy: entry.requestedBy,
            requestedAt: entry.requestedAt,
          },
          'Pending sandbox restart held by restart holds for over 4h',
        );
      }
      return;
    }
    entry.heldSince = undefined;
    heldWarned.delete(entry);
    if (!(await leaseWhilePending(entry))) return;
    logger.info(
      { instance: entry.instance, heldForMs },
      'Pending sandbox restart no longer held; draining again',
    );
    // No idle check this poll: launches that started while held reach
    // active_runs before the next one.
  }

  async function pollEntry(entry: PendingIdleRestart) {
    if (entry.heldSince) return pollHeldEntry(entry, entry.heldSince);
    // Cancelled or replaced while leasing.
    if (!(await leaseWhilePending(entry))) return;
    const { idle, waitingOn, holds, launchVersion } = await evaluate(
      entry,
      true,
    );
    if (pending.get(entry.instance) !== entry) return;
    if (!idle || (launchVersions.get(entry.instance) ?? 0) !== launchVersion) {
      // Only a successful hold read holds the restart; unreadable holds keep
      // draining.
      if (holds !== null && waitingOn.holds > 0) {
        entry.heldSince = deps.now().toISOString();
        await releaseBrains(entry);
        if (pending.get(entry.instance) !== entry) return;
        logger.info(
          { instance: entry.instance, holds: waitingOn.holds },
          'Pending sandbox restart held by restart holds; brain drain released and task launches resumed',
        );
        await resumeHeldWork(entry.instance);
      }
      return;
    }
    forget(entry);
    await runRestart(entry);
  }

  async function runPass() {
    for (const entry of [...pending.values()]) {
      try {
        await pollEntry(entry);
      } catch (err) {
        logger.warn(
          { instance: entry.instance, err: String(err) },
          'Idle restart poll failed',
        );
      }
    }
  }

  /** One poll pass over every pending restart, queued behind any running pass. */
  function poll(): Promise<void> {
    queuedPasses++;
    passes = passes.then(runPass).finally(() => {
      queuedPasses--;
    });
    return passes;
  }

  async function release(entry: PendingIdleRestart) {
    forget(entry);
    await releaseBrains(entry);
  }

  const api = {
    poll,

    /** Register (or replace) a pending restart and check for idleness at once. */
    async requestIdleRestart(input: {
      stack: string;
      instance: string;
      service?: string;
      requestedBy: string;
      target: SandboxRestartRequest['target'];
      source?: PendingIdleRestart['source'];
      reason?: string;
      conversationId?: string;
      runId?: string;
    }): Promise<PendingIdleRestart> {
      const previous = pending.get(input.instance);
      const brains = new Map<string, PendingIdleRestartBrain>();
      for (const group of groupsOnInstance(input.instance)) {
        const container = deps.resolveBrainContainer(group);
        // Only brains running inside the restarting sandbox matter. When the
        // brain's instance is unknown, trust only a brain this project
        // configures itself, not one inherited from its parent.
        const brainInstance = container
          ? deps.resolveBrainInstance(container)
          : undefined;
        if (
          container &&
          (brainInstance
            ? brainInstance !== input.instance
            : container !== group.settings?.brainContainer)
        ) {
          continue;
        }
        const authToken = deps.resolveBrainAuthToken(group);
        // A brain the board cannot authenticate to can be neither leased nor polled.
        if (container && authToken && !brains.has(container)) {
          brains.set(container, { container, authToken });
        }
      }
      const entry: PendingIdleRestart = {
        stack: input.stack,
        instance: input.instance,
        service: input.service,
        requestedBy: input.requestedBy,
        requestedAt: deps.now().toISOString(),
        source: input.source,
        reason: input.reason,
        conversationId: input.conversationId,
        runId: input.runId,
        target: input.target,
        brainContainers: [...brains.values()],
      };
      pending.set(entry.instance, entry);
      if (previous) {
        for (const brain of previous.brainContainers) {
          statusFailures.delete(brainKey(previous, brain));
        }
      }
      ensureTimer();
      sandboxStatus(entry, 'restart_pending');
      // Lease the drain now and restart straight away when already idle.
      void poll().catch(() => undefined);
      return entry;
    },

    /** Drop a pending restart, release its brain leases and resume held work. */
    async cancelIdleRestart(instance: string): Promise<boolean> {
      const entry = pending.get(instance);
      if (!entry) return false;
      await release(entry);
      sandboxStatus(entry, 'restart_pending_cancelled');
      await resumeHeldWork(instance);
      return true;
    },

    /**
     * Run an immediate restart that supersedes a pending one. The pending entry
     * is dropped at once but new task runs stay held through the restart; brain
     * leases are released and held work resumed only afterwards.
     */
    async supersedeIdleRestart(
      instance: string,
      restart: () => Promise<unknown>,
    ): Promise<void> {
      const requested = pending.get(instance);
      let superseded: PendingIdleRestart | undefined;
      try {
        await whileOwning(instance, !!requested, async () => {
          const entry =
            pending.get(instance) === requested ? requested : undefined;
          if (entry) {
            superseded = entry;
            forget(entry);
            sandboxStatus(entry, 'restart_pending_cancelled');
          }
          try {
            if ((await restart()) !== false) recordRestart(instance);
          } finally {
            if (entry) await releaseBrains(entry);
          }
        });
      } finally {
        if (superseded) await resumeHeldWork(instance);
      }
    },

    /**
     * Run `operation` with `instances` held for maintenance that moves what
     * their sandboxes mount. New chat and task launches wait (without a time
     * limit) until it ends, and launches already past admission are awaited
     * first, up to `settleTimeoutMs`, so each has recorded its active_runs row
     * by the time `operation` looks for runs. Rejects, without running
     * `operation`, if one is still starting then. Held work resumes afterwards.
     */
    async holdInstances<T>(
      instances: readonly string[],
      operation: () => Promise<T>,
      settleTimeoutMs = 120_000,
    ): Promise<T> {
      // Sorted, so two holds over overlapping instances cannot wait on each
      // other. Each instance is owned in the same synchronous step it is granted.
      const held = [...new Set(instances.filter(Boolean))].sort();
      const ends: Array<() => void> = [];
      try {
        for (const instance of held) {
          ends.push(await acquireRestart(instance, true, true));
        }
        const starting = held.flatMap((instance) => [
          ...(launches.get(instance) ?? []),
        ]);
        await withTimeout(
          Promise.all(starting),
          settleTimeoutMs,
          'a run on this sandbox is still starting',
        );
        return await operation();
      } finally {
        for (const end of ends) end();
        for (const instance of held) await resumeHeldWork(instance);
      }
    },

    /**
     * Admit a chat or task launch on `instance`. Waits while a restart (chats)
     * or maintenance hold (everything) is executing, then registers the launch
     * in the same synchronous step, so a hold started afterwards sees it. Call
     * `settle()` on the ticket as soon as the run's active_runs row exists, or
     * when the launch ends without one.
     */
    async admitLaunch(
      instance: string | undefined,
      options: { chat: boolean; conversationId?: string },
    ): Promise<{ settle(): void; waited: boolean }> {
      let waitedForRestart = false;
      let waited = false;
      while (instance) {
        const inFlight = executing.get(instance);
        if (!inFlight) break;
        if (maintenance.has(instance)) {
          waited = true;
          await inFlight;
          continue;
        }
        if (!options.chat || waitedForRestart) break;
        waitedForRestart = true;
        waited = true;
        await api.holdChatForSandboxRestart(instance, options.conversationId);
      }
      if (!instance) return { settle() {}, waited };
      let settle!: () => void;
      const done = new Promise<void>((resolve) => (settle = resolve));
      const set = launches.get(instance) ?? new Set();
      launches.set(instance, set);
      set.add(done);
      launchVersions.set(instance, (launchVersions.get(instance) ?? 0) + 1);
      void done.then(() => {
        set.delete(done);
        if (set.size === 0 && launches.get(instance) === set) {
          launches.delete(instance);
        }
      });
      return { settle, waited };
    },

    /**
     * Resolves once an executing restart of this instance has finished (success
     * or failure); immediately when none is executing. A merely pending restart
     * does not hold callers.
     */
    waitForSandboxRestart(instance: string | undefined): Promise<void> {
      return (instance && executing.get(instance)) || Promise.resolve();
    },

    /**
     * Hold a chat launch while its instance is being restarted, bounded by
     * `timeoutMs` (then proceeds with a warning). No-op when none is executing.
     */
    async holdChatForSandboxRestart(
      instance: string | undefined,
      conversationId: string | undefined,
      timeoutMs: number = CHAT_RESTART_WAIT_MS,
    ): Promise<void> {
      const inFlight = instance ? executing.get(instance) : undefined;
      if (!instance || !inFlight) return;
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        inFlight.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      const waitedMs = Date.now() - startedAt;
      if (timedOut) {
        logger.warn(
          { instance, conversationId, waitedMs },
          'Chat waited too long for sandbox restart; launching anyway',
        );
      } else {
        logger.info(
          { instance, conversationId, waitedMs },
          'Chat waited for sandbox restart to finish',
        );
      }
    },

    /**
     * True while new task runs must not start: a restart is executing, or is
     * pending and not held back by restart holds.
     */
    isTaskLaunchHeld(instance: string | undefined): boolean {
      if (!instance) return false;
      if (restarting.has(instance)) return true;
      const entry = pending.get(instance);
      return !!entry && !entry.heldSince;
    },

    /** True while a restart is waiting for idleness or executing. */
    isIdleRestartPending(instance: string | undefined): boolean {
      return !!instance && (pending.has(instance) || restarting.has(instance));
    },

    getPendingIdleRestart(instance: string): PendingIdleRestart | undefined {
      return pending.get(instance);
    },

    /** ISO time the last restart of this instance completed, if any this boot. */
    getLastRestartAt(instance: string): string | undefined {
      return lastRestartAt.get(instance);
    },

    /** Current blockers of a pending restart (read-only; no failure tracking). */
    async getIdleRestartWaitingOn(
      entry: PendingIdleRestart,
    ): Promise<IdleRestartWaitingOn> {
      return (await evaluate(entry, false)).waitingOn;
    },
  };
  return api;
}

const manager = createIdleRestartManager();

export const requestIdleRestart = manager.requestIdleRestart;
export const cancelIdleRestart = manager.cancelIdleRestart;
export const supersedeIdleRestart = manager.supersedeIdleRestart;
export const isIdleRestartPending = manager.isIdleRestartPending;
export const isTaskLaunchHeld = manager.isTaskLaunchHeld;
export const waitForSandboxRestart = manager.waitForSandboxRestart;
export const holdInstances = manager.holdInstances;
export const admitLaunch = manager.admitLaunch;
export const holdChatForSandboxRestart = manager.holdChatForSandboxRestart;
export const getPendingIdleRestart = manager.getPendingIdleRestart;
export const getLastRestartAt = manager.getLastRestartAt;
export const getIdleRestartWaitingOn = manager.getIdleRestartWaitingOn;
