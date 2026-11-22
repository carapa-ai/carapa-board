/**
 * Restart project sandboxes onto rebuilt images.
 *
 * Periodically asks CarapaBox which running project sandboxes use an older
 * image than their tag now points to, and requests a restart-when-idle for
 * ONE of them. The next sandbox is considered only after that restart has
 * finished, so a large rebuild never restarts every sandbox at once.
 *
 * A sandbox is not requested twice for the same running images: if a restart
 * leaves it outdated (for example the stack pins another image), it waits for
 * a different image instead of restarting in a loop.
 *
 * A sandbox with an active restart hold (`restart-hold`) is skipped until the
 * hold ends; requesting its restart would hold new task runs meanwhile.
 */
import { logger } from '../logger.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { registeredGroups } from '../state-manager.js';
import {
  lifecycleSandboxInstance,
  resolveEffectiveSandbox,
} from './effective-settings.js';
import { isIdleRestartPending, requestIdleRestart } from './idle-restart.js';
import { countSandboxRestartHolds } from './restart-holds.js';
import type { SandboxRestartRequest } from './restart.js';

const OUTDATED_CHECK_INTERVAL_MS = 60_000;

type Target = NonNullable<SandboxRestartRequest['target']>;

interface OutdatedSandbox {
  stack: string;
  instance: string;
  service?: string;
  target: Target;
}

interface OutdatedRestartDeps {
  /** Project sandboxes the board manages, one per lifecycle instance. */
  listSandboxes: () => OutdatedSandbox[];
  /** Image IDs of the sandbox's running services that are behind their tag. */
  outdatedImages: (stack: string, instance: string) => Promise<string[]>;
  /** Active restart holds; null when they cannot be read. */
  countHolds: (sandbox: OutdatedSandbox) => Promise<number | null>;
  isRestartPending: (instance: string) => boolean;
  requestRestart: (sandbox: OutdatedSandbox) => Promise<unknown>;
  schedule: (tick: () => void, intervalMs: number) => () => void;
}

const defaultDeps: OutdatedRestartDeps = {
  listSandboxes: () => {
    const sandboxes = new Map<string, OutdatedSandbox>();
    for (const group of Object.values(registeredGroups)) {
      let target: Target;
      try {
        target = resolveEffectiveSandbox(group);
      } catch {
        continue;
      }
      // Externally managed instances are not the board's to restart.
      if (target.fixedInstance) continue;
      const instance = lifecycleSandboxInstance(target);
      if (sandboxes.has(instance)) continue;
      sandboxes.set(instance, {
        stack: target.stack,
        instance,
        service: target.service,
        target,
      });
    }
    return [...sandboxes.values()];
  },
  outdatedImages: async (stack, instance) => {
    const result = await getSandboxClient().callTool('sandbox_status', {
      name: stack,
      instance,
      checkUpdates: true,
    });
    if (result.isError) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return []; // "No running containers" and similar plain-text replies
    }
    const entries = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
      UpToDate?: boolean;
      ImageID?: string;
    }>;
    return entries
      .filter((entry) => entry.UpToDate === false)
      .map((entry) => entry.ImageID ?? '');
  },
  countHolds: (sandbox) =>
    countSandboxRestartHolds(sandbox.stack, sandbox.service, sandbox.instance),
  isRestartPending: isIdleRestartPending,
  requestRestart: (sandbox) =>
    requestIdleRestart({
      stack: sandbox.stack,
      instance: sandbox.instance,
      service: sandbox.service,
      requestedBy: 'system:outdated-image',
      reason: 'Newer image available',
      target: sandbox.target,
    }),
  schedule: (tick, intervalMs) => {
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

function createOutdatedRestarter(overrides: Partial<OutdatedRestartDeps> = {}) {
  const deps: OutdatedRestartDeps = { ...defaultDeps, ...overrides };
  /** Running images each instance was last restarted for. */
  const requestedFor = new Map<string, string>();
  /** The instance whose restart this restarter requested and is waiting on. */
  let active: string | undefined;
  let running = false;

  /** One pass: request at most one restart, and none while one is in flight. */
  async function check(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (active && deps.isRestartPending(active)) return;
      active = undefined;
      for (const sandbox of deps.listSandboxes()) {
        // A restart someone else requested already covers this sandbox.
        if (deps.isRestartPending(sandbox.instance)) continue;
        let images: string[];
        try {
          images = await deps.outdatedImages(sandbox.stack, sandbox.instance);
        } catch (err) {
          logger.debug(
            {
              stack: sandbox.stack,
              instance: sandbox.instance,
              err: String(err),
            },
            'Outdated-image check failed',
          );
          continue;
        }
        if (images.length === 0) continue;
        const key = [...images].sort().join(',');
        if (requestedFor.get(sandbox.instance) === key) continue;
        // Retried on a later pass; requestedFor stays unset until requested.
        if (((await deps.countHolds(sandbox)) ?? 0) > 0) continue;
        requestedFor.set(sandbox.instance, key);
        active = sandbox.instance;
        logger.info(
          { stack: sandbox.stack, instance: sandbox.instance },
          'Newer image available; restarting sandbox when idle',
        );
        await deps.requestRestart(sandbox);
        return;
      }
    } finally {
      running = false;
    }
  }

  return {
    check,
    start(): () => void {
      return deps.schedule(() => void check(), OUTDATED_CHECK_INTERVAL_MS);
    },
  };
}

const restarter = createOutdatedRestarter();

export const startOutdatedSandboxRestarts = restarter.start;
