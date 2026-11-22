import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  initDatabase,
  getLastRunSessionForStage,
  getActiveRunById,
  getRunCountForTask,
  getTaskRunStageDurations,
  getRunningTaskIdsForGroup,
  updateRunStats,
  insertActiveRun,
  beginDirectFollowupDispatch,
  completeActiveRun,
  insertActiveRunIfAbsent,
  getRunningDirectFollowupRuns,
  persistTaskSessionForActiveRun,
  markRestartRecoveryRunDispatched,
  reserveRestartRecoveryRun,
  createTask,
  getTask,
} from '../db.js';
import { runFixture, truncateTestDb } from '../test-helpers.js';

let initialized = false;

beforeAll(async () => {
  await initDatabase(':memory:');
  initialized = true;
});

beforeEach(async () => {
  if (!initialized) throw new Error('test database was not initialized');
  await truncateTestDb();
});

describe('Direct follow-up ownership', () => {
  test('persists the canonical terminal result for restart finalization', async () => {
    const run = runFixture({ id: 'terminal-result-recovery' });
    await insertActiveRun(run);
    await completeActiveRun(
      run.id,
      'completed',
      { result: 'Durable successful output' },
      'durable-session',
    );

    expect(await getActiveRunById(run.id)).toMatchObject({
      status: 'completed',
      result: 'Durable successful output',
      session_id: 'durable-session',
    });
  });

  test('a later stat-less error write keeps the terminal status, cost and tokens', async () => {
    const completed = runFixture({ id: 'late-error-after-completed' });
    await insertActiveRun(completed);
    await completeActiveRun(completed.id, 'completed', {
      result: 'done',
      total_tokens: 1234,
      cost_usd: 0.42,
    });
    await completeActiveRun(completed.id, 'error');
    expect(await getActiveRunById(completed.id)).toMatchObject({
      status: 'completed',
      result: 'done',
      tok_total: 1234,
      cost_usd: 0.42,
    });

    const stalled = runFixture({ id: 'late-error-after-stalled' });
    await insertActiveRun(stalled);
    await completeActiveRun(stalled.id, 'stalled');
    await completeActiveRun(stalled.id, 'error');
    expect((await getActiveRunById(stalled.id))?.status).toBe('stalled');
  });

  test('allows one deterministic insert and one dispatch winner', async () => {
    const run = runFixture({
      id: 'direct-followup:deterministic',
      stage: 'direct-followup:claimed',
      chat_jid: 'target-project@web',
      conversation_id: 'direct-dispatch-conversation',
    });
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => insertActiveRunIfAbsent(run)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    const dispatches = await Promise.all(
      Array.from({ length: 8 }, () =>
        beginDirectFollowupDispatch(run.id, run.conversation_id!),
      ),
    );
    expect(dispatches.filter(Boolean)).toHaveLength(1);
  });

  test('does not reclaim a terminal deterministic row', async () => {
    const run = runFixture({
      id: 'direct-followup:completed',
      stage: 'direct-followup:claimed',
      conversation_id: 'direct-completed-conversation',
    });
    expect(await insertActiveRunIfAbsent(run)).toBe(true);
    await completeActiveRun(run.id, 'completed');
    expect(await insertActiveRunIfAbsent(run)).toBe(false);
    expect(
      await beginDirectFollowupDispatch(run.id, run.conversation_id!),
    ).toBe(false);
  });

  test('allows one dispatched follow-up per conversation', async () => {
    const conversationId = 'direct-serial-conversation';
    const first = runFixture({
      id: 'direct-followup:first',
      stage: 'direct-followup:claimed',
      conversation_id: conversationId,
    });
    const second = runFixture({
      id: 'direct-followup:second',
      stage: 'direct-followup:claimed',
      conversation_id: conversationId,
    });
    await insertActiveRunIfAbsent(first);
    await insertActiveRunIfAbsent(second);

    const dispatches = await Promise.all([
      beginDirectFollowupDispatch(first.id, conversationId),
      beginDirectFollowupDispatch(second.id, conversationId),
    ]);
    expect(dispatches.filter(Boolean)).toHaveLength(1);
  });

  test('lists every Direct claim beyond the generic active-run cap', async () => {
    const conversationId = 'direct-unbounded-recovery';
    for (let index = 0; index < 501; index++) {
      await insertActiveRun(
        runFixture({
          id: `direct-followup:unbounded-${index}`,
          stage: 'direct-followup:claimed',
          conversation_id: conversationId,
        }),
      );
    }
    expect(await getRunningDirectFollowupRuns(conversationId)).toHaveLength(
      501,
    );
  });
});
describe('getRunningTaskIdsForGroup', () => {
  test('finds a project run beyond the global active-run result cap', async () => {
    for (let i = 0; i < 500; i++) {
      await insertActiveRun(
        runFixture({
          id: `unrelated-run-${i}`,
          group_folder: `unrelated-project-${i}`,
          task_id: `unrelated-task-${i}`,
        }),
      );
    }
    await insertActiveRun(
      runFixture({
        id: 'target-run',
        group_folder: 'target-project',
        task_id: 'target-task',
      }),
    );

    expect(await getRunningTaskIdsForGroup('target-project')).toEqual([
      'target-task',
    ]);
  });
});

describe('getLastRunSessionForStage', () => {
  test('reserves one durable restart continuation before retiring its predecessor', async () => {
    const interrupted = runFixture({
      id: 'restart-interrupted',
      task_id: 'restart-task',
      stage: 'implementation',
      session_id: 'restart-session',
      agent_name: 'codex@relay',
      session_agent_key: 'codex@relay',
      runtime_variant: 'codex-relay-variant',
    });
    const replacement = runFixture({
      id: 'restart-replacement',
      task_id: 'restart-task',
      stage: 'implementation',
      session_id: 'restart-session',
      agent_name: 'codex@relay',
      session_agent_key: 'codex@relay',
      runtime_variant: 'codex-relay-variant',
    });
    await insertActiveRun(interrupted);
    const reserve = (candidate: typeof replacement) =>
      reserveRestartRecoveryRun({
        interruptedRunId: interrupted.id,
        replacement: candidate,
        taskId: 'restart-task',
        stageId: 'implementation',
        sessionId: 'restart-session',
        sessionAgentKey: 'codex@relay',
        model: null,
        runtimeVariant: 'codex-relay-variant',
      });
    const first = await reserve(replacement);

    expect(first).toMatchObject({ created: true, run: { id: replacement.id } });
    expect(await getActiveRunById(interrupted.id)).toMatchObject({
      status: 'error',
      stage: 'implementation',
      session_id: 'restart-session',
    });
    expect(await getActiveRunById(replacement.id)).toMatchObject({
      status: 'running',
      restart_recovery_dispatched_at: null,
    });
    expect(
      await markRestartRecoveryRunDispatched(replacement.id, interrupted.id),
    ).toBe(true);
    expect(await getActiveRunById(replacement.id)).toMatchObject({
      restart_recovery_dispatched_at: expect.any(String),
    });
    expect(
      await markRestartRecoveryRunDispatched(replacement.id, interrupted.id),
    ).toBe(false);
    expect(
      await reserve(
        runFixture({ ...replacement, id: 'duplicate-replacement' }),
      ),
    ).toMatchObject({ created: false, run: { id: replacement.id } });
  });

  test('records an observed session on its exact run and task cursor', async () => {
    const task = await createTask({
      project_id: 'session-owner-project',
      title: 'Own an observed native session',
      description: '',
      status: 'build',
      priority: 0,
    });
    const owned = runFixture({
      id: 'observed-session-owner',
      group_folder: task.project_id,
      task_id: task.id,
      stage: 'build',
      session_agent_key: 'codex@relay',
    });
    const other = runFixture({
      id: 'different-session-owner',
      group_folder: task.project_id,
      task_id: task.id,
      stage: 'build',
      session_agent_key: 'codex@relay',
      status: 'completed',
    });
    await insertActiveRun(owned);
    await insertActiveRun(other);

    expect(
      await persistTaskSessionForActiveRun(
        owned.id,
        task.id,
        'observed-session',
      ),
    ).toBe(true);
    expect(await getActiveRunById(owned.id)).toMatchObject({
      session_id: 'observed-session',
    });
    expect(await getActiveRunById(other.id)).toMatchObject({
      session_id: null,
    });
    expect(await getTask(task.id)).toMatchObject({
      session_id: 'observed-session',
    });
    expect(
      await persistTaskSessionForActiveRun(
        other.id,
        'not-the-owned-task',
        'wrong-session',
      ),
    ).toBe(false);
    expect((await getTask(task.id))?.session_id).toBe('observed-session');
  });

  test('returns the newest session for the exact active stage and runtime', async () => {
    await insertActiveRun(
      runFixture({
        id: 'build-old',
        task_id: 'task-1',
        stage: 'build',
        agent_name: 'codex@relay',
        session_agent_key: 'codex@relay',
        session_id: 'build-session-old',
        started_at: '2026-07-29T18:00:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'polish',
        task_id: 'task-1',
        stage: 'polish',
        agent_name: 'codex@relay',
        session_agent_key: 'codex@relay',
        session_id: 'polish-session',
        started_at: '2026-07-29T18:10:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'testing',
        task_id: 'task-1',
        stage: 'testing',
        agent_name: 'codex@relay',
        session_agent_key: 'codex@relay',
        session_id: 'testing-session',
        started_at: '2026-07-29T18:20:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'build-new',
        task_id: 'task-1',
        stage: 'build',
        agent_name: 'codex@relay',
        session_agent_key: 'codex@relay',
        session_id: 'build-session-new',
        started_at: '2026-07-29T18:15:00.000Z',
      }),
    );

    expect(
      await getLastRunSessionForStage('task-1', 'build', 'codex@relay'),
    ).toBe('build-session-new');
    expect(
      await getLastRunSessionForStage('task-1', 'polish', 'codex@relay'),
    ).toBe('polish-session');
  });

  test('does not resume a session owned by another runtime', async () => {
    await insertActiveRun(
      runFixture({
        id: 'other-runtime',
        task_id: 'task-1',
        stage: 'build',
        agent_name: 'claude@direct',
        session_agent_key: 'claude@direct',
        session_id: 'incompatible-session',
      }),
    );

    expect(
      await getLastRunSessionForStage('task-1', 'build', 'codex@relay'),
    ).toBeUndefined();
  });

  test('does not skip a newer compatible run that owns no session', async () => {
    await insertActiveRun(
      runFixture({
        id: 'older-resumable-run',
        task_id: 'task-1',
        stage: 'build',
        agent_name: 'codex@relay',
        session_agent_key: 'codex@relay',
        session_id: 'older-session',
        started_at: '2026-07-29T18:00:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'newer-unresumable-run',
        task_id: 'task-1',
        stage: 'build',
        agent_name: 'codex@relay',
        session_agent_key: 'codex@relay',
        session_id: null,
        started_at: '2026-07-29T18:10:00.000Z',
      }),
    );

    expect(
      await getLastRunSessionForStage('task-1', 'build', 'codex@relay'),
    ).toBeUndefined();
  });

  test('orders canonical and legacy runtime owners as one compatible history', async () => {
    await insertActiveRun(
      runFixture({
        id: 'older-legacy-resumable-run',
        task_id: 'task-1',
        stage: 'build',
        agent_name: 'codex',
        session_agent_key: 'codex',
        session_id: 'older-legacy-session',
        started_at: '2026-07-29T18:00:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'newer-canonical-sessionless-run',
        task_id: 'task-1',
        stage: 'build',
        agent_name: 'codex@relay',
        session_agent_key: 'codex@relay',
        session_id: null,
        started_at: '2026-07-29T18:10:00.000Z',
      }),
    );

    expect(
      await getLastRunSessionForStage('task-1', 'build', [
        'codex@relay',
        'codex',
      ]),
    ).toBeUndefined();
  });
});

describe('getRunCountForTask', () => {
  test('counts all runs independently of the history payload limit', async () => {
    for (let i = 0; i < 55; i++) {
      await insertActiveRun(
        runFixture({
          id: `counted-run-${i}`,
          task_id: 'counted-task',
          started_at: new Date(Date.UTC(2026, 6, 29, 18, 0, i)).toISOString(),
        }),
      );
    }

    expect(await getRunCountForTask('counted-task')).toBe(55);
  });
});

describe('getTaskRunStageDurations', () => {
  test('sums every completed outcome, including runs beyond the history limit', async () => {
    for (let i = 0; i < 55; i++) {
      await insertActiveRun(
        runFixture({
          id: `aggregate-run-${i}`,
          task_id: 'aggregate-task',
          stage: 'active',
          status: i % 3 === 0 ? 'error' : i % 3 === 1 ? 'timeout' : 'completed',
          started_at: `2026-07-29T18:${String(i).padStart(2, '0')}:00.000Z`,
          completed_at: `2026-07-29T18:${String(i).padStart(2, '0')}:01.000Z`,
        }),
      );
      if (i < 2) await updateRunStats(`aggregate-run-${i}`, { cost_usd: 0.25 });
    }
    await insertActiveRun(
      runFixture({
        id: 'stopped-run',
        task_id: 'aggregate-task',
        stage: 'testing',
        status: 'stalled',
        started_at: '2026-07-29T19:00:00.000Z',
        completed_at: '2026-07-29T19:02:00.000Z',
      }),
    );

    expect(await getTaskRunStageDurations('aggregate-task')).toEqual([
      {
        stageId: 'active',
        completedDurationMs: 55_000,
        runningStartedAt: [],
        runningDurationMs: 0,
        runningReferenceAt: expect.any(String),
        costUsd: 0.5,
      },
      {
        stageId: 'testing',
        completedDurationMs: 120_000,
        runningStartedAt: [],
        runningDurationMs: 0,
        runningReferenceAt: expect.any(String),
        costUsd: null,
      },
    ]);
  });

  test('keeps null stages and calculates running time from the reference timestamp', async () => {
    await insertActiveRun(
      runFixture({
        id: 'running-stage',
        task_id: 'aggregate-task',
        stage: 'active',
        started_at: '2026-07-29T18:00:00.000Z',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'unknown-stage',
        task_id: 'aggregate-task',
        stage: null,
        status: 'stalled',
        started_at: '2026-07-29T18:05:00.000Z',
        completed_at: '2026-07-29T18:04:00.000Z',
      }),
    );

    const result = await getTaskRunStageDurations(
      'aggregate-task',
      '2026-07-29T18:03:00.000Z',
    );
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        {
          stageId: 'active',
          completedDurationMs: 0,
          runningStartedAt: ['2026-07-29T18:00:00.000Z'],
          runningDurationMs: 180_000,
          runningReferenceAt: '2026-07-29T18:03:00.000Z',
          costUsd: null,
        },
        {
          stageId: null,
          completedDurationMs: 0,
          runningStartedAt: [],
          runningDurationMs: 0,
          runningReferenceAt: '2026-07-29T18:03:00.000Z',
          costUsd: null,
        },
      ]),
    );
  });
});
