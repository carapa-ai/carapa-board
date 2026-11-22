import {
  getInFlight,
  pauseBackgroundWork,
  waitForBackgroundWorkIdle,
} from './background-work-gate.js';
import { setServerWebRestartPending } from './server-web-build-status.js';
import { logger } from '../logger.js';

/** A normal restart stops waiting for running work after this long. */
export const RESTART_MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * The pending (non-forced) restart: pauses automatic background work and
 * restarts once no tracked job or direct chat turn is in flight, or once
 * `maxWaitMs` after the request, whichever comes first. Repeated requests
 * share one waiter. Chat turns are never blocked from starting meanwhile.
 */
export function createRestartWaiter(options: {
  restart: (userId: string) => void;
  maxWaitMs?: number;
}) {
  const maxWaitMs = options.maxWaitMs ?? RESTART_MAX_WAIT_MS;
  let current: {
    abort: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  /** Drops the pending wait; false when none was pending. */
  function cancel(): boolean {
    const wait = current;
    current = null;
    setServerWebRestartPending(false);
    if (!wait) return false;
    clearTimeout(wait.timer);
    wait.abort.abort();
    return true;
  }

  function request(userId: string): void {
    if (current) return;
    const abort = new AbortController();
    const finish = () => {
      if (current?.abort !== abort) return;
      cancel();
      options.restart(userId);
    };
    const timer = setTimeout(() => {
      logger.warn(
        { waitingOn: getInFlight(), maxWaitMs },
        'Restart wait deadline reached with work still running',
      );
      finish();
    }, maxWaitMs);
    current = { abort, timer };
    setServerWebRestartPending(true);
    pauseBackgroundWork('restart pending');
    void waitForBackgroundWorkIdle(abort.signal).then((idle) => {
      if (idle) finish();
    });
  }

  return {
    request,
    cancel,
    isPending: () => current !== null,
  };
}
