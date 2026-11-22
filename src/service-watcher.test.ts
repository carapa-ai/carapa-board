import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { RegisteredGroup } from './types.js';
import {
  pollTarget,
  restartService,
  selectWatchTargets,
  singleFlight,
  type ServiceState,
  type WatchTarget,
} from './service-watcher.js';
import { logger } from './logger.js';
import * as idleRestart from './sandbox/idle-restart.js';
import * as restartModule from './sandbox/restart.js';
import * as stateManager from './state-manager.js';
import * as objectivesBrainClient from './modules/objectives/brain-client.js';

afterEach(() => mock.restore());

function group(
  folder: string,
  settings: RegisteredGroup['settings'] = {},
): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      gracefulDeploy: true,
      deployService: 'carapa-brain',
      brainContainer: 'brain-1',
      ...settings,
    },
  };
}

function select(
  g: RegisteredGroup,
  overrides: {
    brainContainer?: string | undefined;
    brainUrl?: string | null;
    brainInstance?: string | undefined;
    inherited?: boolean;
  } = {},
) {
  const has = (k: string) => k in overrides;
  return selectWatchTargets([g], {
    resolveBrainContainer: () =>
      has('brainContainer') ? overrides.brainContainer : 'brain-1',
    resolveBrainUrl: () =>
      has('brainUrl') ? (overrides.brainUrl ?? null) : 'http://brain:3111',
    resolveBrainSandboxInstance: () =>
      has('brainInstance') ? overrides.brainInstance : 'inst-a',
    resolveEffectiveSandbox: () => ({
      inherited: overrides.inherited ?? false,
      stack: 'carapa-bot',
      instance: 'inst-a',
      owner: g,
    }),
  });
}

describe('selectWatchTargets', () => {
  test('watches a group whose own sandbox hosts its own brain', () => {
    expect(select(group('proj'))).toEqual([
      {
        name: 'carapa-brain',
        healthUrl: 'http://brain:3111/health',
        stack: 'carapa-bot',
        instance: 'inst-a',
        group_folder: 'proj',
      },
    ]);
  });

  test('skips a brain container inherited from the parent group', () => {
    const g = group('child', { brainContainer: undefined });
    expect(select(g)).toEqual([]);
  });

  test('skips when the brain runs in a different sandbox instance', () => {
    expect(select(group('proj'), { brainInstance: 'carapa' })).toEqual([]);
  });

  test('skips when the brain instance is unknown (fail closed)', () => {
    expect(select(group('proj'), { brainInstance: undefined })).toEqual([]);
  });

  test('skips a parent-owned (inherited) sandbox', () => {
    expect(select(group('proj'), { inherited: true })).toEqual([]);
  });

  test('skips without gracefulDeploy, deployService, or a brain URL', () => {
    expect(select(group('p', { gracefulDeploy: false }))).toEqual([]);
    expect(select(group('p', { deployService: undefined }))).toEqual([]);
    expect(select(group('p'), { brainUrl: null })).toEqual([]);
  });
});

function state(): ServiceState {
  return {
    healthy: true,
    lastHealthy: null,
    restarting: false,
    consecutiveFailures: 0,
  };
}

const target: WatchTarget = {
  name: 'carapa-brain',
  healthUrl: 'http://brain:3111/health',
  stack: 'carapa-bot',
  instance: 'inst-a',
  group_folder: 'proj',
};

describe('pollTarget', () => {
  test('restarts once after the threshold, then retries after another threshold of failures', async () => {
    const s = state();
    let restarts = 0;
    const deps = {
      checkHealth: async () => false,
      restartService: async () => {
        restarts += 1;
        return false; // the restart attempt failed
      },
      failureThreshold: 3,
    };

    await pollTarget(target, s, deps);
    await pollTarget(target, s, deps);
    expect(restarts).toBe(0);

    await pollTarget(target, s, deps);
    expect(restarts).toBe(1);
    expect(s.healthy).toBe(false);
    expect(s.restarting).toBe(false);

    // The counter was reset by the finished restart attempt, so the retry
    // needs another full threshold of consecutive failures.
    await pollTarget(target, s, deps);
    await pollTarget(target, s, deps);
    expect(restarts).toBe(1);

    await pollTarget(target, s, deps);
    expect(restarts).toBe(2);
  });

  test('retries after the threshold when the restart succeeds but the service stays down', async () => {
    const s = state();
    let restarts = 0;
    const deps = {
      checkHealth: async () => false,
      restartService: async () => {
        restarts += 1;
        return true;
      },
      failureThreshold: 3,
    };

    for (let i = 0; i < 3; i++) await pollTarget(target, s, deps);
    expect(restarts).toBe(1);

    for (let i = 0; i < 3; i++) await pollTarget(target, s, deps);
    expect(restarts).toBe(2);
    expect(s.healthy).toBe(false);
    expect(s.restarting).toBe(false);
  });

  test('logs the retry branch when a restarted service stays unhealthy', async () => {
    const s = state();
    const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    const deps = {
      checkHealth: async () => false,
      restartService: async () => true,
      failureThreshold: 3,
    };

    for (let i = 0; i < 3; i++) await pollTarget(target, s, deps);
    for (let i = 0; i < 3; i++) await pollTarget(target, s, deps);

    const messages = warn.mock.calls.map((call) => call[1]);
    expect(messages).toContain('Service became unhealthy — triggering restart');
    expect(messages).toContain('Service still unhealthy — retrying restart');
  });

  test('a healthy check in between resets the failure counter', async () => {
    const s = state();
    let restarts = 0;
    const results = [false, false, true, false, false];
    let index = 0;
    const deps = {
      checkHealth: async () => results[index++] ?? true,
      restartService: async () => {
        restarts += 1;
        return true;
      },
      failureThreshold: 3,
    };

    for (let i = 0; i < results.length; i++) await pollTarget(target, s, deps);

    expect(restarts).toBe(0);
    expect(s.healthy).toBe(true);
    expect(s.consecutiveFailures).toBe(2);
  });

  test('does not start a second restart while one is still in flight', async () => {
    const s = state();
    let restarts = 0;
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    // Observable signal: the fake restart has actually been entered and is
    // now waiting on the controlled gate.
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let probeHealthy = false;
    const deps = {
      checkHealth: async () => probeHealthy,
      restartService: async () => {
        restarts += 1;
        markStarted();
        await inFlight;
        return true;
      },
      failureThreshold: 3,
    };

    try {
      await pollTarget(target, s, deps);
      await pollTarget(target, s, deps);
      const pending = pollTarget(target, s, deps);
      await started;
      expect(restarts).toBe(1);
      expect(s.restarting).toBe(true);

      // A cycle that lands while the restart is in flight must not start
      // another one.
      await pollTarget(target, s, deps);
      expect(restarts).toBe(1);

      // A healthy probe while the restart is still in flight must not clear
      // the in-flight flag — otherwise the following failures could start an
      // overlapping restart.
      probeHealthy = true;
      await pollTarget(target, s, deps);
      expect(s.restarting).toBe(true);

      probeHealthy = false;
      for (let i = 0; i < 3; i++) await pollTarget(target, s, deps);
      expect(restarts).toBe(1);

      release();
      await pending;
    } finally {
      // Always release the gate so the pending restart cannot outlive the
      // test, even if an assertion above failed.
      release();
    }
    expect(s.restarting).toBe(false);
  });

  test('clears the in-flight flag when the restart throws and retries later', async () => {
    const s = state();
    let restarts = 0;
    const deps = {
      checkHealth: async () => false,
      restartService: async () => {
        restarts += 1;
        throw new Error('restart failed');
      },
      failureThreshold: 3,
    };

    await pollTarget(target, s, deps);
    await pollTarget(target, s, deps);
    await expect(pollTarget(target, s, deps)).rejects.toThrow('restart failed');

    expect(restarts).toBe(1);
    expect(s.restarting).toBe(false);
    expect(s.healthy).toBe(false);

    // The next threshold of failures triggers a retry.
    await pollTarget(target, s, deps);
    await pollTarget(target, s, deps);
    expect(restarts).toBe(1);
    await expect(pollTarget(target, s, deps)).rejects.toThrow('restart failed');
    expect(restarts).toBe(2);
  });
});

describe('singleFlight', () => {
  test('skips ticks while pending and runs again after settle or rejection', async () => {
    spyOn(logger, 'error').mockImplementation(() => {});
    let release!: () => void;
    let calls = 0;
    let fail = false;
    const run = singleFlight('job', 'job failed', () => {
      calls++;
      if (fail) return Promise.reject(new Error('boom'));
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const first = run();
    await run();
    await run();
    expect(calls).toBe(1);

    release();
    await first;
    fail = true;
    await run();
    expect(calls).toBe(2);

    await run();
    expect(calls).toBe(3);
  });
});

describe('restartService', () => {
  function stubRestart(result: boolean) {
    spyOn(stateManager, 'getGroupByFolder').mockReturnValue(group('proj'));
    spyOn(
      objectivesBrainClient,
      'reconcilePendingObjectiveStateEvents',
    ).mockResolvedValue(undefined as never);
    return spyOn(restartModule, 'performSandboxRestart').mockResolvedValue(
      result,
    );
  }

  test('restarts through the shared sidebar restart for the target instance', async () => {
    const restart = stubRestart(true);
    const owned = spyOn(idleRestart, 'supersedeIdleRestart');

    expect(await restartService(target)).toBe(true);
    expect(owned).toHaveBeenCalledTimes(1);
    expect(owned.mock.calls[0][0]).toBe('inst-a');
    expect(restart).toHaveBeenCalledTimes(1);
    const request = restart.mock.calls[0][0];
    expect(request.stack).toBe('carapa-bot');
    expect(request.instance).toBe('inst-a');
    expect(request.target?.owner.folder).toBe('proj');
  });

  test('reports a failed or fenced start as a failure', async () => {
    stubRestart(false);

    expect(await restartService(target)).toBe(false);
  });
});

describe('pollTarget restart blocking', () => {
  test('skips the restart while blocked and retries on the next poll', async () => {
    const s = state();
    let blocked = true;
    let restarts = 0;
    const deps = {
      checkHealth: async () => false,
      restartService: async () => {
        restarts += 1;
        return true;
      },
      isRestartBlocked: () => blocked,
      failureThreshold: 2,
    };

    await pollTarget(target, s, deps);
    await pollTarget(target, s, deps);
    await pollTarget(target, s, deps);
    expect(restarts).toBe(0);
    expect(s.restarting).toBe(false);

    blocked = false;
    await pollTarget(target, s, deps);
    expect(restarts).toBe(1);
  });
});
