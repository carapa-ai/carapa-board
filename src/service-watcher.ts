/**
 * Service health watcher.
 *
 * Polls brain health endpoints for projects that have `gracefulDeploy` enabled
 * and a `brainContainer` configured. Uses the board's existing brain port cache
 * (from brain-client.ts) to resolve health URLs dynamically.
 *
 * Restart rule: only the group's own effective sandbox is ever restarted, and
 * only when it verifiably hosts the watched brain (the group's own
 * `brainContainer` runs in that sandbox instance). A brain inherited from the
 * parent group, or one in a different/unknown instance, is never watched,
 * because restarting an unrelated sandbox cannot heal it.
 *
 * When a service transitions from healthy to unhealthy, triggers a restart
 * through `performSandboxRestart` (the same path as the sidebar restart
 * button), which interrupts the instance's chat and task runs and handles env
 * vars, networking, and volumes correctly. The restart is skipped while an
 * idle restart or maintenance hold owns the instance, or the instance is
 * fenced; the next poll retries.
 */

import { logger } from './logger.js';
import {
  ENABLE_SERVICE_WATCHER,
  SERVICE_WATCHER_INTERVAL,
  SERVICE_WATCHER_INTERVAL_ADJUSTED,
  SERVICE_WATCHER_INTERVAL_RAW,
  SERVICE_WATCHER_FAILURE_THRESHOLD,
} from './config.js';
import { revokeGroupTokens, wasRecentlyMinted } from './mcp/auth-tokens.js';
import { rescopeAllMainTokens } from './mcp/main-reach-sync.js';
import { getSandboxClient } from './lib/mcp-client.js';
import { isSandboxInstanceFenced } from './lib/sandbox-start-fence.js';
import {
  resolveBrainUrl,
  refreshBrainPortCache,
  reconcilePendingObjectiveStateEvents,
  resolveBrainContainer,
  resolveBrainSandboxInstance,
} from './modules/objectives/brain-client.js';
import { registeredGroups, getGroupByFolder } from './state-manager.js';
import type { RegisteredGroup } from './types.js';
import {
  isIdleRestartPending,
  supersedeIdleRestart,
} from './sandbox/idle-restart.js';
import { performSandboxRestart } from './sandbox/restart.js';
import { sweepDeadAgentRuns } from './recovery.js';
import {
  resolveEffectiveSandbox,
  uniqueEffectiveSandboxes,
} from './sandbox/effective-settings.js';
import { isSandboxStopped } from './sandbox/status.js';

const HEALTH_CHECK_TIMEOUT_MS = 5000;

export interface ServiceState {
  healthy: boolean;
  /** ISO timestamp of last successful health check */
  lastHealthy: string | null;
  /** Restart in progress — skip duplicate restart attempts */
  restarting: boolean;
  /** Consecutive failed health checks since the last success */
  consecutiveFailures: number;
}

// Internal state: project folder → health state
const serviceStates = new Map<string, ServiceState>();

/**
 * Check whether a health endpoint is responding with 2xx.
 */
async function checkHealth(healthUrl: string): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface WatchTarget {
  /** Managed deploy service name */
  name: string;
  healthUrl: string;
  /** Sandbox stack name (e.g. 'carapa-bot') */
  stack: string;
  /** Sandbox instance name (group folder) */
  instance: string;
  /** Group folder for env resolution */
  group_folder: string;
}

/**
 * Restart a service through the shared sandbox restart used by the sidebar
 * button (`performSandboxRestart`, run under idle-restart instance ownership): it interrupts the instance's chat and task
 * runs, rebuilds env/token/IPC state and treats a failed or fenced start as a
 * failure. Resolves false on failure (the helper broadcasts `restart_failed`).
 */
export async function restartService(target: WatchTarget): Promise<boolean> {
  const { stack, instance, group_folder } = target;

  // If the target is the board itself, we can't restart via sandbox —
  // just exit and let Docker restart policy / pm2 bring us back.
  if (stack === 'carapa-board') {
    logger.info('Board service needs restart — exiting for automatic restart');
    process.exit(0);
  }

  const group = getGroupByFolder(group_folder);
  if (!group) {
    logger.error(
      { stack, instance, group_folder },
      'Cannot restart sandbox via watcher: group not found',
    );
    return false;
  }

  // Own the instance like the sidebar restart: chat launches are held for the
  // restart's duration and a maintenance hold cannot start mid-restart.
  let ok = false;
  await supersedeIdleRestart(instance, async () => {
    ok = await performSandboxRestart({
      stack,
      instance,
      target: resolveEffectiveSandbox(group),
    });
    return ok;
  });
  if (ok) await reconcilePendingObjectiveStateEvents();
  return ok;
}

/**
 * True while the sandbox restart must be left to someone else: an idle
 * restart is pending or executing, a maintenance hold owns the instance, or
 * the instance is fenced against starts (project archive).
 */
function isRestartBlocked(target: WatchTarget): boolean {
  return (
    isIdleRestartPending(target.instance) ||
    isSandboxInstanceFenced(target.instance)
  );
}

interface WatchTargetDeps {
  resolveBrainContainer: (group: RegisteredGroup) => string | undefined;
  resolveBrainUrl: (brainContainer?: string) => string | null;
  resolveBrainSandboxInstance: (brainContainer: string) => string | undefined;
  resolveEffectiveSandbox: (
    group: RegisteredGroup,
  ) => Pick<
    ReturnType<typeof resolveEffectiveSandbox>,
    'inherited' | 'stack' | 'instance' | 'owner'
  >;
}

const defaultWatchTargetDeps: WatchTargetDeps = {
  resolveBrainContainer,
  resolveBrainUrl,
  resolveBrainSandboxInstance,
  resolveEffectiveSandbox,
};

/**
 * Select the groups the watcher may restart.
 *
 * Needs `gracefulDeploy`, a `deployService`, and a brain container that has a
 * resolvable health URL. The sandbox that gets restarted is the group's own
 * effective sandbox, so a group is only watched when that sandbox verifiably
 * hosts the watched brain: the group's own `settings.brainContainer` (not one
 * inherited from its parent) must run in the group's effective sandbox
 * instance. Unknown or different instance → skipped (fail closed), since
 * restarting an unrelated sandbox cannot heal the brain.
 */
export function selectWatchTargets(
  groups: Iterable<RegisteredGroup>,
  deps: WatchTargetDeps = defaultWatchTargetDeps,
): WatchTarget[] {
  const watchTargets: WatchTarget[] = [];

  for (const group of groups) {
    const settings = group.settings;
    if (!settings?.gracefulDeploy || !settings.deployService) continue;

    const brainContainer = deps.resolveBrainContainer(group);
    if (!brainContainer) continue;

    const brainUrl = deps.resolveBrainUrl(brainContainer);
    if (!brainUrl) continue;

    // deployService is the managed service name (for building images).
    // The actual sandbox stack is defaultSandbox (or the global default).
    const effective = deps.resolveEffectiveSandbox(group);
    if (effective.inherited) {
      logger.debug(
        {
          group: group.folder,
          sandboxOwner: effective.owner.folder,
        },
        'Skipping child service lifecycle watcher for parent-owned sandbox',
      );
      continue;
    }
    const stack = effective.stack;
    const instance = effective.instance;

    const brainInstance = deps.resolveBrainSandboxInstance(brainContainer);
    if (
      !settings.brainContainer ||
      brainInstance === undefined ||
      brainInstance !== instance
    ) {
      logger.debug(
        {
          group: group.folder,
          brainContainer,
          brainInstance,
          instance,
          ownBrainContainer: !!settings.brainContainer,
        },
        'Skipping service watcher: group sandbox does not host the watched brain',
      );
      continue;
    }

    watchTargets.push({
      name: settings.deployService,
      healthUrl: `${brainUrl}/health`,
      stack,
      instance,
      group_folder: group.folder,
    });
  }

  return watchTargets;
}

/**
 * Injected collaborators for a single watch cycle, so the decision logic can
 * be exercised without touching Docker, the network or the sandbox client.
 */
export interface PollTargetDeps {
  /** Probe the service health endpoint. */
  checkHealth: (healthUrl: string) => Promise<boolean>;
  /** Restart the watched service. Resolves true on success, false on failure. */
  restartService: (target: WatchTarget) => Promise<boolean>;
  /** True while the restart must be left to another owner; retried next poll. */
  isRestartBlocked?: (target: WatchTarget) => boolean;
  /** Consecutive failures required before a restart is triggered. */
  failureThreshold?: number;
}

/**
 * Run one health-check cycle for a single watch target and update its state.
 *
 * Restart semantics:
 * - A single failed check is often transient (a 5s probe timeout during the
 *   busy boot window, a brief GC pause, the brain momentarily busy), so
 *   several consecutive failures are required before restarting.
 * - `state.restarting` is only true while a restart is actually being
 *   awaited. It guards against overlapping restarts for the same target and
 *   is owned exclusively by the restart attempt itself: a concurrent health
 *   probe (even a healthy one) must not clear it, otherwise an overlapping
 *   restart could start while the first one is still in flight.
 * - After a restart attempt finishes — successfully or not — the failure
 *   counter is reset, so the restarted service gets the same boot grace as
 *   the first attempt. If it still does not come up, another threshold of
 *   consecutive failures triggers a retry.
 */
export async function pollTarget(
  target: WatchTarget,
  state: ServiceState,
  deps: PollTargetDeps,
): Promise<void> {
  const { name, healthUrl } = target;
  const threshold = deps.failureThreshold ?? SERVICE_WATCHER_FAILURE_THRESHOLD;

  const isHealthy = await deps.checkHealth(healthUrl);

  if (isHealthy) {
    const wasUnhealthy = !state.healthy;
    state.healthy = true;
    state.lastHealthy = new Date().toISOString();
    state.consecutiveFailures = 0;
    // NOTE: `state.restarting` is deliberately not cleared here. It marks an
    // in-flight restart attempt and is owned exclusively by that attempt's
    // try/finally. Clearing it from a concurrent healthy probe would let a
    // later threshold start an overlapping restart while the first one is
    // still running.

    if (wasUnhealthy) {
      logger.info({ service: name }, 'Service recovered — now healthy');
    }
    return;
  }

  // Service health check failed — require several consecutive failures
  // before restarting.
  state.consecutiveFailures += 1;

  // A restart is in flight (the previous cycle is still awaiting it) — wait
  // for the next cycle to re-check.
  if (state.restarting) return;

  if (state.consecutiveFailures < threshold) {
    logger.debug(
      {
        service: name,
        consecutiveFailures: state.consecutiveFailures,
        threshold,
      },
      'Service health check failed — below restart threshold',
    );
    return;
  }

  // A pending/executing restart, maintenance hold or start fence owns the
  // instance. Leave the failure count at the threshold so the next poll
  // retries as soon as it is released.
  if (deps.isRestartBlocked?.(target)) {
    logger.info(
      { service: name, instance: target.instance },
      'Service unhealthy — restart skipped while a sandbox restart, maintenance hold or start fence is active',
    );
    return;
  }

  if (state.healthy) {
    // Transition: healthy → unhealthy — trigger restart
    logger.warn(
      {
        service: name,
        lastHealthy: state.lastHealthy,
        consecutiveFailures: state.consecutiveFailures,
      },
      'Service became unhealthy — triggering restart',
    );
  } else {
    // Still unhealthy after a previous restart attempt — retry
    logger.warn(
      { service: name },
      'Service still unhealthy — retrying restart',
    );
  }
  state.healthy = false;
  state.restarting = true;
  try {
    await deps.restartService(target);
  } finally {
    // The restart attempt has finished (successfully or not). Clear the
    // in-flight flag and the failure counter so the next threshold of
    // consecutive failures can trigger a retry.
    state.restarting = false;
    state.consecutiveFailures = 0;
  }
}

/**
 * Run one health-check cycle for the targets chosen by selectWatchTargets.
 */
async function pollServices(): Promise<void> {
  const watchTargets = selectWatchTargets(Object.values(registeredGroups));

  if (watchTargets.length === 0) return;

  await Promise.allSettled(
    watchTargets.map(async (target) => {
      const { group_folder } = target;
      const state = serviceStates.get(group_folder) ?? {
        healthy: true, // assume healthy on first check — don't restart cold
        lastHealthy: null,
        restarting: false,
        consecutiveFailures: 0,
      };
      if (!serviceStates.has(group_folder)) {
        serviceStates.set(group_folder, state);
      }

      await pollTarget(target, state, {
        checkHealth,
        restartService,
        isRestartBlocked,
      });
    }),
  );
}

// Grace window after a mint during which the sweep won't revoke a group's
// tokens even if its sandbox doesn't yet report "running" — comfortably
// larger than worst-case sandbox boot (image pull + runsc + app init) so a
// slow-booting always-on sandbox isn't bricked by its own fresh token being
// swept before it comes up.
const TOKEN_MINT_GRACE_MS = 3 * 60 * 1000;

/**
 * Liveness sweep: revoke agent tokens for any registered group whose sandbox
 * is not running. This is what binds a no-expiry (ttlMs=null) token's validity
 * to the sandbox's life when a stop happened out-of-band (e.g. docker, crash)
 * and didn't go through the board's stop endpoint. Stop-path revocation
 * handles the normal case; this is the safety net. Groups minted within
 * TOKEN_MINT_GRACE_MS are skipped so a still-booting sandbox keeps its token.
 */
async function sweepStaleTokens(): Promise<void> {
  const client = getSandboxClient();
  for (const effective of uniqueEffectiveSandboxes(
    Object.values(registeredGroups),
  )) {
    const { stack, instance, owner } = effective;
    try {
      const st = await client.sandboxStatus(stack, instance);
      // Only a successful listing proves the sandbox stopped. An error reply
      // (e.g. CarapaBox refusing calls while it restarts) proves nothing, and
      // revoking then strands a running sandbox the boot refresh skips.
      if (
        isSandboxStopped(st) &&
        !wasRecentlyMinted(owner.folder, TOKEN_MINT_GRACE_MS)
      ) {
        await revokeGroupTokens(owner.folder);
      }
    } catch {
      // Transient status-check failure — skip this group this cycle rather
      // than revoke a token for a sandbox that may actually be up.
    }
  }
  // Backstop for the debounced project-change listener: a missed or failed
  // re-scope still converges here within one sweep.
  await rescopeAllMainTokens(() => registeredGroups);
}

let watcherTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Wrap a periodic job so at most one invocation runs at a time. A call while
 * the previous one is still pending is skipped; the flag is released in
 * `finally`, so a rejected job never blocks later ticks. Rejections are logged
 * with `errorMessage` and never propagate.
 */
export function singleFlight(
  name: string,
  errorMessage: string,
  job: () => Promise<unknown>,
): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      logger.debug(
        { job: name },
        'Service watcher job still running, skipping tick',
      );
      return;
    }
    inFlight = true;
    try {
      await job();
    } catch (err) {
      logger.error({ err }, errorMessage);
    } finally {
      inFlight = false;
    }
  };
}

/**
 * Start the service health watcher loop.
 * Polls managed services on a configurable interval (default 15s, min 5s).
 * Each job is single-flight: a slow job never overlaps itself.
 */
export function startServiceWatcher(): void {
  if (watcherTimer) return; // already running

  if (!ENABLE_SERVICE_WATCHER) {
    logger.warn(
      'ENABLE_SERVICE_WATCHER=false — service watcher disabled (pollServices, sweepStaleTokens, sweepDeadAgentRuns)',
    );
    return;
  }

  if (SERVICE_WATCHER_INTERVAL_ADJUSTED) {
    logger.warn(
      {
        configured: SERVICE_WATCHER_INTERVAL_RAW,
        effectiveMs: SERVICE_WATCHER_INTERVAL,
      },
      'SERVICE_WATCHER_INTERVAL is invalid or below the 5000 ms minimum — using the effective value',
    );
  }

  logger.info(
    { intervalMs: SERVICE_WATCHER_INTERVAL },
    'Starting service health watcher',
  );

  const brainState = singleFlight(
    'brainState',
    'Brain state reconciliation failed',
    () =>
      refreshBrainPortCache().then(() =>
        reconcilePendingObjectiveStateEvents(),
      ),
  );
  const poll = singleFlight(
    'pollServices',
    'Service watcher poll error',
    pollServices,
  );
  const tokens = singleFlight(
    'sweepStaleTokens',
    'Stale token sweep error',
    sweepStaleTokens,
  );
  const deadRuns = singleFlight(
    'sweepDeadAgentRuns',
    'Dead agent run sweep error',
    sweepDeadAgentRuns,
  );
  const tick = () => {
    void brainState();
    void poll();
    void tokens();
    void deadRuns();
  };

  // Run first check after a short delay to let services boot
  setTimeout(tick, 5000);

  watcherTimer = setInterval(tick, SERVICE_WATCHER_INTERVAL);
}

/**
 * Stop the service health watcher loop.
 */
export function stopServiceWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
    logger.info('Service health watcher stopped');
  }
}
