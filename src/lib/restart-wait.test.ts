import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import {
  beginBackgroundWork,
  DIRECT_CHAT_WORK_LABEL,
  getInFlight,
  resumeBackgroundWork,
  trackBackgroundWork,
} from './background-work-gate.js';
import { createRestartWaiter, RESTART_MAX_WAIT_MS } from './restart-wait.js';
import { getServerWebBuildStatus } from './server-web-build-status.js';

describe('restart waiter', () => {
  const restart = jest.fn();
  const waiter = createRestartWaiter({ restart });

  beforeEach(() => {
    jest.useFakeTimers();
    restart.mockClear();
  });

  afterEach(() => {
    waiter.cancel();
    resumeBackgroundWork();
    jest.useRealTimers();
  });

  it('waits for a running direct chat turn, which stays visible', async () => {
    const release = beginBackgroundWork(DIRECT_CHAT_WORK_LABEL);
    waiter.request('admin');
    waiter.request('admin');
    await Promise.resolve();
    expect(restart).not.toHaveBeenCalled();
    expect(getServerWebBuildStatus().waitingOn).toEqual({
      [DIRECT_CHAT_WORK_LABEL]: 1,
    });

    release();
    await Promise.resolve();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith('admin');
    expect(getServerWebBuildStatus().restartPending).toBe(false);
  });

  it('restarts at the deadline with a turn still running', async () => {
    const release = beginBackgroundWork(DIRECT_CHAT_WORK_LABEL);
    waiter.request('admin');
    jest.advanceTimersByTime(RESTART_MAX_WAIT_MS - 1);
    expect(restart).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(restart).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('releases the count of a turn that throws', async () => {
    const turn = trackBackgroundWork(DIRECT_CHAT_WORK_LABEL, async () => {
      throw new Error('boom');
    });
    waiter.request('admin');
    await expect(turn).rejects.toThrow('boom');
    expect(getInFlight()).toEqual({});
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('does not restart after the wait is cancelled', () => {
    const release = beginBackgroundWork(DIRECT_CHAT_WORK_LABEL);
    waiter.request('admin');
    expect(waiter.cancel()).toBe(true);
    jest.advanceTimersByTime(RESTART_MAX_WAIT_MS);
    release();
    expect(restart).not.toHaveBeenCalled();
  });
});
