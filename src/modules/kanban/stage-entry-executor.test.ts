import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  claimNextStageEntryEvent,
  createUser,
  completeActiveRun,
  completeStageEntryEventIfOwned,
  createTask,
  getActiveRunById,
  getTask,
  getUnreadPayloads,
  getUnresolvedStageEntryEvents,
  initDatabase,
  insertActiveRun,
  markStageEntryEventFailed,
  markStageEntryEventRunning,
  releaseStageEntryEventClaim,
  setStageEntryEventCommittedHandler,
  updateTask,
  upsertProjectMember,
} from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { projects, stageEntryEvents } from '../../db/schema.js';
import { runFixture, taskFixture, truncateTestDb } from '../../test-helpers.js';
import type { RegisteredGroup } from '../../types.js';
import {
  recoverStalledRuns,
  recoverTerminalAutomaticStageEntryRuns,
} from '../../recovery.js';
import type { StageDefinition } from './types.js';
import {
  drainProjectQueue,
  cancelQueuedProjectTasks,
  executeTask,
  setGroupResolver,
  releaseTaskExecutionClaim,
  requestTaskStageHandoff,
} from './task/pipeline.js';
import { notifyEntityLifecycle } from '../tools/push-tools.js';

const ENTRY: StageDefinition = {
  id: 'question',
  title: 'Question',
  type: 'queue',
  color: '#f59e0b',
  runOnEntry: true,
};
const WORK: StageDefinition = {
  id: 'work',
  title: 'Work',
  type: 'active',
  color: '#2563eb',
};
const ACTIVE_ENTRY: StageDefinition = {
  id: 'automatic_work',
  title: 'Automatic Work',
  type: 'active',
  color: '#1d4ed8',
  runOnEntry: true,
};
const TESTING: StageDefinition = {
  id: 'testing',
  title: 'Testing',
  type: 'testing',
  color: '#7c3aed',
};
const REVIEW: StageDefinition = {
  id: 'review',
  title: 'Review',
  type: 'review',
  color: '#0891b2',
};
const DONE: StageDefinition = {
  id: 'done',
  title: 'Done',
  type: 'done',
  color: '#16a34a',
};
const DEPLOY_ENTRY: StageDefinition = {
  id: 'deploy',
  title: 'Deploy',
  type: 'done',
  color: '#15803d',
  runOnEntry: true,
};

const STAGES = [ENTRY, WORK, TESTING, REVIEW, DONE];

let initialized = false;

async function setupProject(
  projectId: string,
  status: 'running' | 'paused' | 'stopped' = 'running',
  maxParallelWorktrees = 2,
  stages: StageDefinition[] = STAGES,
): Promise<RegisteredGroup> {
  const settings = {
    stages,
    status,
    taskCheckoutMode: 'worktree',
    maxParallelWorktrees,
  } as const;
  await drizzleDbRef.current.insert(projects).values({
    id: projectId,
    jid: `${projectId}@board`,
    name: 'Stage entry executor',
    folder: projectId,
    trigger: '@entry',
    added_at: new Date().toISOString(),
    settings: JSON.stringify(settings),
  });
  const group: RegisteredGroup = {
    jid: `${projectId}@board`,
    name: 'Stage entry executor',
    folder: projectId,
    trigger: '@entry',
    added_at: new Date().toISOString(),
    settings: { ...settings, stages: [...stages] },
  };
  setGroupResolver((candidate) =>
    candidate === projectId ? group : undefined,
  );
  // These tests drive admission explicitly; durability, not this wake hook,
  // remains the source of the event under test.
  setStageEntryEventCommittedHandler(null);
  return group;
}

beforeEach(async () => {
  if (!initialized) {
    await initDatabase(':memory:');
    initialized = true;
  }
  await truncateTestDb();
  setStageEntryEventCommittedHandler(null);
});

describe('automatic stage-entry admission', () => {
  test('starts entry work first and blocks normal candidates until it succeeds', async () => {
    const projectId = 'entry-priority';
    const group = await setupProject(projectId);
    const entryTask = await createTask(
      taskFixture({ project_id: projectId, status: ENTRY.id, title: 'Entry' }),
    );
    const secondEntryTask = await createTask(
      taskFixture({
        project_id: projectId,
        status: ENTRY.id,
        title: 'Second entry',
      }),
    );
    const normalTask = await createTask(
      taskFixture({ project_id: projectId, status: WORK.id, title: 'Normal' }),
    );
    const starts: string[] = [];
    const { promise: entriesFinished, resolve: finishEntries } =
      Promise.withResolvers<void>();
    let finishedEntryCount = 0;

    await drainProjectQueue(projectId, group, {
      testDependencies: {
        executeStageEntryTask: async (task, _group, eventId, claim) => {
          starts.push(`entry:${task.id}`);
          releaseTaskExecutionClaim(task.id, claim);
          await markStageEntryEventRunning(eventId);
          await completeStageEntryEventIfOwned({
            eventId,
            state: 'succeeded',
            output: '',
            error: null,
            lastAgentName: null,
          });
          finishedEntryCount += 1;
          if (finishedEntryCount === 2) finishEntries();
        },
        executeTask: async (task) => {
          starts.push(`normal:${task.id}`);
        },
      },
    });
    await entriesFinished;

    expect(starts).toEqual([
      `entry:${entryTask.id}`,
      `entry:${secondEntryTask.id}`,
    ]);
    await drainProjectQueue(projectId, group, {
      testDependencies: {
        executeTask: async (task) => {
          starts.push(`normal:${task.id}`);
        },
      },
    });
    expect(starts).toContain(`normal:${normalTask.id}`);
  });

  test('stops normal admission when an entry commits after the first barrier snapshot', async () => {
    const projectId = 'entry-late-admission-barrier';
    const group = await setupProject(projectId);
    const normalTask = await createTask(
      taskFixture({ project_id: projectId, status: WORK.id, title: 'Normal' }),
    );
    const entryTask = await createTask(
      taskFixture({
        project_id: projectId,
        status: DONE.id,
        title: 'Late entry',
      }),
    );
    const starts: string[] = [];
    let committed = false;

    const { promise: entryAdmitted, resolve: finishEntryAdmission } =
      Promise.withResolvers<void>();
    await drainProjectQueue(projectId, group, {
      testDependencies: {
        beforeNormalAdmission: async () => {
          if (committed) return;
          committed = true;
          await updateTask(entryTask.id, { status: ENTRY.id });
        },
        executeTask: async (task) => {
          starts.push(task.id);
        },
        executeStageEntryTask: async (task, _group, eventId, claim) => {
          releaseTaskExecutionClaim(task.id, claim);
          await releaseStageEntryEventClaim(eventId);
          finishEntryAdmission();
        },
      },
    });

    await entryAdmitted;
    expect(starts).not.toContain(normalTask.id);
    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([
      expect.objectContaining({ taskId: entryTask.id, state: 'pending' }),
    ]);
  });

  test('keeps failed entry evidence while admitting unrelated work now and after recovery', async () => {
    const projectId = 'entry-failed-nonblocking';
    const group = await setupProject(projectId, 'running', 2, [
      ENTRY,
      WORK,
      ACTIVE_ENTRY,
      TESTING,
      REVIEW,
      DONE,
    ]);
    const entryTask = await createTask(
      taskFixture({
        project_id: projectId,
        status: ACTIVE_ENTRY.id,
        title: 'Entry requiring attention',
      }),
    );
    const normalTask = await createTask(
      taskFixture({ project_id: projectId, status: WORK.id }),
    );
    const event = await claimNextStageEntryEvent(
      projectId,
      '1970-01-01T00:00:00.000Z',
    );
    const starts: string[] = [];
    const { promise: normalStarted, resolve: finishNormalStart } =
      Promise.withResolvers<void>();

    await executeTask(entryTask, group, {
      automaticStageEntryEventId: event!.id,
      testDependencies: {
        runContainerAgent: async (_group, input, onChunk) => {
          const run = runFixture({
            id: 'entry-failed-nonblocking-run',
            group_folder: projectId,
            task_id: entryTask.id,
            stage: ACTIVE_ENTRY.id,
          });
          await insertActiveRun(run);
          await input.onSlotAcquired?.(run.id);
          onChunk?.({ type: 'text', content: 'Collected diagnostics.' });
          return {
            status: 'error',
            result: null,
            error: 'entry failed',
          };
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: (drainProjectId, drainGroup) =>
          drainProjectQueue(drainProjectId, drainGroup, {
            testDependencies: {
              executeTask: async (task) => {
                starts.push(task.id);
                finishNormalStart();
              },
            },
          }),
      },
    });
    await normalStarted;

    expect(starts).toEqual([normalTask.id]);
    expect(await getTask(entryTask.id)).toMatchObject({
      status: ACTIVE_ENTRY.id,
      output: 'Collected diagnostics.',
      error: 'entry failed',
      completed_at: null,
    });
    expect(
      await getActiveRunById('entry-failed-nonblocking-run'),
    ).toMatchObject({
      task_id: entryTask.id,
      status: 'error',
    });
    expect((await getUnresolvedStageEntryEvents(projectId))[0]).toMatchObject({
      id: event!.id,
      state: 'failed',
      error: 'entry failed',
    });
    await updateTask(normalTask.id, { status: DONE.id });

    const recoveredTask = await createTask(
      taskFixture({
        project_id: projectId,
        status: TESTING.id,
        title: 'Eligible after recovery',
      }),
    );
    await drainProjectQueue(projectId, group, {
      recoverStageEntryClaims: true,
      testDependencies: {
        executeTask: async (task) => {
          starts.push(task.id);
        },
      },
    });

    expect(starts).toContain(recoveredTask.id);
    expect(
      await claimNextStageEntryEvent(projectId, new Date().toISOString()),
    ).toBeUndefined();
    expect(await getTask(entryTask.id)).toMatchObject({
      status: ACTIVE_ENTRY.id,
      output: 'Collected diagnostics.',
      error: 'entry failed',
    });
    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([
      expect.objectContaining({ id: event!.id, state: 'failed' }),
    ]);
  });

  test('wakes normal admission after an automatic entry preflight failure', async () => {
    const projectId = 'entry-preflight-failure-wakeup';
    const group = await setupProject(projectId, 'running', 1, [
      ENTRY,
      ACTIVE_ENTRY,
      WORK,
      DONE,
    ]);
    const entryTask = await createTask(
      taskFixture({
        project_id: projectId,
        status: ACTIVE_ENTRY.id,
        title: 'Entry with failed preflight',
      }),
    );
    const normalTask = await createTask(
      taskFixture({ project_id: projectId, status: WORK.id }),
    );
    const starts: string[] = [];
    const { promise: normalStarted, resolve: finishNormalStart } =
      Promise.withResolvers<void>();

    await drainProjectQueue(projectId, group, {
      testDependencies: {
        prepareStageEntryEventIfOwned: async () => {
          throw new Error('entry preflight failed');
        },
        executeTask: async (task) => {
          starts.push(task.id);
          finishNormalStart();
        },
      },
    });
    await normalStarted;

    expect(starts).toEqual([normalTask.id]);
    expect(await getTask(entryTask.id)).toMatchObject({
      status: ACTIVE_ENTRY.id,
      output: 'entry preflight failed',
      error: 'entry preflight failed',
      completed_at: null,
    });
    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([
      expect.objectContaining({
        taskId: entryTask.id,
        stageId: ACTIVE_ENTRY.id,
        state: 'failed',
        error: 'entry preflight failed',
      }),
    ]);
  });

  test('does not preempt an existing run when no automatic slot is free', async () => {
    const projectId = 'entry-no-preempt';
    const group = await setupProject(projectId, 'running', 1);
    const entryTask = await createTask(
      taskFixture({ project_id: projectId, status: ENTRY.id }),
    );
    const runningTask = await createTask(
      taskFixture({ project_id: projectId, status: WORK.id }),
    );
    await insertActiveRun(
      runFixture({
        id: 'entry-no-preempt-run',
        group_folder: projectId,
        task_id: runningTask.id,
      }),
    );
    const starts: string[] = [];

    await drainProjectQueue(projectId, group, {
      testDependencies: {
        executeStageEntryTask: async (task) => {
          starts.push(task.id);
        },
      },
    });

    expect(starts).not.toContain(entryTask.id);
  });
  test('releases a queued entry receipt so pause and resume can re-admit it', async () => {
    const projectId = 'entry-pause-release';
    const group = await setupProject(projectId);
    const task = await createTask(
      taskFixture({ project_id: projectId, status: ENTRY.id }),
    );

    await drainProjectQueue(projectId, group, {
      testDependencies: {
        executeStageEntryTask: async () => {},
      },
    });
    expect(await cancelQueuedProjectTasks(projectId)).toBe(1);

    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([
      expect.objectContaining({ taskId: task.id, state: 'pending' }),
    ]);
  });

  test.each(['paused'] as const)(
    'does not launch entry work while a project is %s',
    async (status) => {
      const projectId = `entry-${status}`;
      const group = await setupProject(projectId, status);
      await createTask(
        taskFixture({ project_id: projectId, status: ENTRY.id }),
      );
      const starts: string[] = [];

      await drainProjectQueue(projectId, group, {
        testDependencies: {
          executeStageEntryTask: async (task) => {
            starts.push(task.id);
          },
        },
      });

      expect(starts).toEqual([]);
      expect(await getUnresolvedStageEntryEvents(projectId)).toHaveLength(1);
    },
  );

  test('recovers a claimed committed-to-launch gap on startup', async () => {
    const projectId = 'entry-startup-recovery';
    const group = await setupProject(projectId);
    const task = await createTask(
      taskFixture({ project_id: projectId, status: ENTRY.id }),
    );
    const event = await claimNextStageEntryEvent(
      projectId,
      '1970-01-01T00:00:00.000Z',
    );
    await drizzleDbRef.current
      .update(stageEntryEvents)
      .set({ claimed_at: '2000-01-01T00:00:00.000Z' })
      .where(eq(stageEntryEvents.id, event!.id));
    const starts: string[] = [];

    await drainProjectQueue(projectId, group, {
      recoverStageEntryClaims: true,
      testDependencies: {
        executeStageEntryTask: async (startedTask, _group, _eventId, claim) => {
          starts.push(startedTask.id);
          releaseTaskExecutionClaim(startedTask.id, claim);
        },
      },
    });

    expect(event?.taskId).toBe(task.id);
    expect(starts).toEqual([task.id]);
  });

  test.each([WORK.id])(
    'resolves the barrier and lets normal ordering pick a handoff into %s',
    async (destination) => {
      const projectId = `entry-handoff-${destination}`;
      const group = await setupProject(projectId);
      const task = await createTask(
        taskFixture({ project_id: projectId, status: ENTRY.id }),
      );
      await updateTask(task.id, { status: destination });
      const starts: string[] = [];

      await drainProjectQueue(projectId, group, {
        testDependencies: {
          executeTask: async (startedTask) => {
            starts.push(startedTask.id);
          },
        },
      });

      expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([]);
      expect(starts).toEqual([task.id]);
    },
  );
  test('runs the configured entry agent instead of deploy interception on deploy entry', async () => {
    const projectId = 'entry-deploy-stage';
    const group = await setupProject(projectId, 'running', 1, [
      WORK,
      DEPLOY_ENTRY,
    ]);
    const task = await createTask(
      taskFixture({ project_id: projectId, status: DEPLOY_ENTRY.id }),
    );
    const event = await claimNextStageEntryEvent(
      projectId,
      '1970-01-01T00:00:00.000Z',
    );
    let deployInterceptCalls = 0;
    let agentRuns = 0;

    await executeTask(task, group, {
      automaticStageEntryEventId: event!.id,
      testDependencies: {
        interceptAutoDeployExecution: async () => {
          deployInterceptCalls += 1;
          return true;
        },
        runContainerAgent: async (_group, input) => {
          agentRuns += 1;
          const run = runFixture({
            id: 'entry-deploy-stage-run',
            group_folder: projectId,
            task_id: task.id,
            stage: DEPLOY_ENTRY.id,
          });
          await insertActiveRun(run);
          await input.onSlotAcquired?.(run.id);
          return {
            status: 'success',
            result: 'Deploy entry inspected without triggering deployment.',
          };
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    });

    expect(deployInterceptCalls).toBe(0);
    expect(agentRuns).toBe(1);
    expect(await getTask(task.id)).toMatchObject({
      status: DEPLOY_ENTRY.id,
      output: 'Deploy entry inspected without triggering deployment.',
    });
    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([]);
  });

  test('keeps the entered stage after a successful one-shot run', async () => {
    const projectId = 'entry-one-shot-success';
    const owner = await createUser('entry-one-shot-owner', 'pw', 'user');
    const group = await setupProject(projectId);
    await upsertProjectMember(owner.id, projectId, 'owner');
    const task = await createTask(
      taskFixture({
        project_id: projectId,
        status: ENTRY.id,
        ownerUserId: owner.id,
      }),
    );
    const event = await claimNextStageEntryEvent(
      projectId,
      '1970-01-01T00:00:00.000Z',
    );

    await notifyEntityLifecycle({
      group_folder: projectId,
      task_id: task.id,
      run_id: 'entry-one-shot-arrival-run',
      event: 'needs_input',
      title: `Task needs input: ${task.title}`,
      defer_stage_entry: true,
    });
    expect(await getUnreadPayloads(owner.id)).toEqual([]);

    await executeTask(task, group, {
      automaticStageEntryEventId: event!.id,
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          const run = runFixture({
            id: 'entry-one-shot-success-run',
            group_folder: projectId,
            task_id: task.id,
            stage: ENTRY.id,
          });
          await insertActiveRun(run);
          await input.onSlotAcquired?.(run.id);
          return {
            status: 'success',
            result: 'Resolved the entry condition; ready for handoff.',
            newSessionId: 'entry-success-session',
          };
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    });

    expect(await getTask(task.id)).toMatchObject({
      status: ENTRY.id,
      output: 'Resolved the entry condition; ready for handoff.',
      error: '',
    });
    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([]);
    expect(await getUnreadPayloads(owner.id)).toEqual([
      expect.objectContaining({
        summary: 'Task needs your attention',
      }),
    ]);
    await notifyEntityLifecycle({
      group_folder: projectId,
      task_id: task.id,
      run_id: 'entry-one-shot-arrival-run',
      event: 'needs_input',
      title: `Task needs input: ${task.title}`,
      defer_stage_entry: true,
    });
    expect(await getUnreadPayloads(owner.id)).toHaveLength(1);
  });

  test('does not launch a claimed entry after the card moves out', async () => {
    const projectId = 'entry-claimed-move-out';
    const group = await setupProject(projectId);
    const task = await createTask(
      taskFixture({ project_id: projectId, status: ENTRY.id }),
    );
    const event = await claimNextStageEntryEvent(
      projectId,
      '1970-01-01T00:00:00.000Z',
    );
    const { promise: waitingForSlot, resolve: reachSlotWait } =
      Promise.withResolvers<void>();
    const { promise: releaseSlot, resolve: acquireSlot } =
      Promise.withResolvers<void>();
    let agentRuns = 0;

    const execution = executeTask(task, group, {
      automaticStageEntryEventId: event!.id,
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          reachSlotWait();
          await releaseSlot;
          const run = runFixture({
            id: 'entry-claimed-move-out-run',
            group_folder: projectId,
            task_id: task.id,
            stage: ENTRY.id,
          });
          await insertActiveRun(run);
          await input.onSlotAcquired?.(run.id);
          agentRuns += 1;
          return { status: 'success', result: 'must not run' };
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    });
    await waitingForSlot;
    await updateTask(task.id, { status: WORK.id });
    acquireSlot();
    await execution;

    expect(agentRuns).toBe(0);
    expect(await getTask(task.id)).toMatchObject({
      status: WORK.id,
      output: '',
      error: '',
    });
    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([]);
  });

  test.each(['success', 'error'] as const)(
    'suppresses stale %s side effects after a running entry moves out',
    async (outcome) => {
      const projectId = `entry-running-move-out-${outcome}`;
      const owner = await createUser(
        `entry-running-move-out-owner-${outcome}`,
        'pw',
        'user',
      );
      const group = await setupProject(projectId);
      await upsertProjectMember(owner.id, projectId, 'owner');
      const task = await createTask(
        taskFixture({
          project_id: projectId,
          status: ENTRY.id,
          title: `Running move ${outcome}`,
          ownerUserId: owner.id,
        }),
      );
      const event = await claimNextStageEntryEvent(
        projectId,
        '1970-01-01T00:00:00.000Z',
      );
      const { promise: agentStarted, resolve: markAgentStarted } =
        Promise.withResolvers<void>();
      const { promise: releaseAgent, resolve: finishAgent } =
        Promise.withResolvers<void>();

      const execution = executeTask(task, group, {
        automaticStageEntryEventId: event!.id,
        testDependencies: {
          runContainerAgent: async (_group, input, onChunk) => {
            const run = runFixture({
              id: `entry-running-move-out-run-${outcome}`,
              group_folder: projectId,
              task_id: task.id,
              stage: ENTRY.id,
            });
            await insertActiveRun(run);
            await input.onSlotAcquired?.(run.id);
            markAgentStarted();
            await releaseAgent;
            if (outcome === 'error') {
              onChunk?.({ type: 'text', content: 'stale failure output' });
              return {
                status: 'error',
                result: null,
                error: 'stale entry failure',
              };
            }
            return { status: 'success', result: 'stale success output' };
          },
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
        },
      });
      await agentStarted;
      await notifyEntityLifecycle({
        group_folder: projectId,
        task_id: task.id,
        run_id: `entry-running-move-out-arrival-${outcome}`,
        event: 'needs_input',
        title: `Task needs input: ${task.title}`,
        defer_stage_entry: true,
      });
      expect(await getUnreadPayloads(owner.id)).toEqual([]);
      await updateTask(task.id, { status: WORK.id });
      finishAgent();
      await execution;

      expect(await getTask(task.id)).toMatchObject({
        status: WORK.id,
        output: '',
        error: '',
      });
      expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([]);
      expect(await getUnreadPayloads(owner.id)).toEqual([]);
    },
  );

  test('preserves the entry handoff message when the agent moves the card', async () => {
    const projectId = 'entry-running-handoff-output';
    const group = await setupProject(projectId);
    const task = await createTask(
      taskFixture({ project_id: projectId, status: ENTRY.id }),
    );
    const event = await claimNextStageEntryEvent(
      projectId,
      '1970-01-01T00:00:00.000Z',
    );
    const handoffMessage =
      'Resolved the question and handed work to implementation.';

    await executeTask(task, group, {
      automaticStageEntryEventId: event!.id,
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          const run = runFixture({
            id: 'entry-running-handoff-output-run',
            group_folder: projectId,
            task_id: task.id,
            stage: ENTRY.id,
          });
          await insertActiveRun(run);
          await input.onSlotAcquired?.(run.id);
          await updateTask(task.id, { status: WORK.id });
          expect(requestTaskStageHandoff(task.id, ENTRY.id, WORK.id)).toBe(
            true,
          );
          return { status: 'success', result: handoffMessage };
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    });

    expect(await getTask(task.id)).toMatchObject({
      status: WORK.id,
      output: handoffMessage,
    });
  });

  test('persists a launch failure without relocating the card', async () => {
    const projectId = 'entry-launch-failure';
    const group = await setupProject(projectId);
    const task = await createTask(
      taskFixture({ project_id: projectId, status: ENTRY.id }),
    );
    const event = await claimNextStageEntryEvent(
      projectId,
      '1970-01-01T00:00:00.000Z',
    );

    await executeTask(task, group, {
      automaticStageEntryEventId: event!.id,
      testDependencies: {
        runContainerAgent: async () => {
          throw new Error('sandbox launch failed');
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    });

    expect(await getTask(task.id)).toMatchObject({
      status: ENTRY.id,
      output: 'sandbox launch failed',
      error: 'sandbox launch failed',
    });
    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([
      expect.objectContaining({ id: event!.id, state: 'failed' }),
    ]);
  });

  test('startup missing-run recovery keeps the entry stage and notifies its owner', async () => {
    const projectId = 'entry-recovery-missing-run';
    const owner = await createUser('entry-recovery-owner', 'pw', 'user');
    await setupProject(projectId);
    await upsertProjectMember(owner.id, projectId, 'owner');
    const task = await createTask(
      taskFixture({
        project_id: projectId,
        status: ENTRY.id,
        title: 'Recover missing entry run',
        ownerUserId: owner.id,
      }),
    );
    const event = await claimNextStageEntryEvent(
      projectId,
      '1970-01-01T00:00:00.000Z',
    );
    const run = runFixture({
      id: 'entry-recovery-missing-run-id',
      group_folder: projectId,
      task_id: task.id,
      stage: ENTRY.id,
      sandbox_instance: 'missing-entry-recovery-instance',
    });
    await insertActiveRun(run);
    await markStageEntryEventRunning(event!.id, run.id);

    await recoverStalledRuns();

    expect(await getTask(task.id)).toMatchObject({
      status: ENTRY.id,
      error: 'Interrupted: server restarted during execution',
      output: 'Interrupted: server restarted during execution',
      completed_at: null,
    });
    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([
      expect.objectContaining({ id: event!.id, state: 'failed' }),
    ]);
    expect(await getUnreadPayloads(owner.id)).toEqual([
      expect.objectContaining({
        summary: 'Stage-entry agent failed: Recover missing entry run',
      }),
    ]);
  });

  test('terminal entry reconciliation persists task-visible failure semantics', async () => {
    const projectId = 'entry-recovery-terminal-run';
    await setupProject(projectId);
    const task = await createTask(
      taskFixture({ project_id: projectId, status: ENTRY.id }),
    );
    const event = await claimNextStageEntryEvent(
      projectId,
      '1970-01-01T00:00:00.000Z',
    );
    const run = runFixture({
      id: 'entry-recovery-terminal-run-id',
      group_folder: projectId,
      task_id: task.id,
      stage: ENTRY.id,
    });
    await insertActiveRun(run);
    await markStageEntryEventRunning(event!.id, run.id);
    await completeActiveRun(run.id, 'error');

    await recoverTerminalAutomaticStageEntryRuns();

    expect(await getTask(task.id)).toMatchObject({
      status: ENTRY.id,
      error: 'Entry run ended with status "error" during restart recovery',
      completed_at: null,
    });
    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([
      expect.objectContaining({ id: event!.id, state: 'failed' }),
    ]);
  });

  test('persists entry failure, keeps its stage and notifies the owner', async () => {
    const projectId = 'entry-one-shot-failure';
    const owner = await createUser('entry-failure-owner', 'pw', 'user');
    const group = await setupProject(projectId);
    await upsertProjectMember(owner.id, projectId, 'owner');
    const task = await createTask(
      taskFixture({
        project_id: projectId,
        status: ENTRY.id,
        title: 'Investigate blocked card',
        ownerUserId: owner.id,
      }),
    );
    const event = await claimNextStageEntryEvent(
      projectId,
      '1970-01-01T00:00:00.000Z',
    );

    await executeTask(task, group, {
      automaticStageEntryEventId: event!.id,
      testDependencies: {
        runContainerAgent: async (_group, input, onChunk) => {
          const run = runFixture({
            id: 'entry-one-shot-failure-run',
            group_folder: projectId,
            task_id: task.id,
            stage: ENTRY.id,
          });
          await insertActiveRun(run);
          await input.onSlotAcquired?.(run.id);
          onChunk?.({
            type: 'text',
            content: 'Collected partial diagnostics.',
          });
          return {
            status: 'error',
            result: null,
            error: 'entry agent exploded',
          };
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    });

    expect(await getTask(task.id)).toMatchObject({
      status: ENTRY.id,
      output: 'Collected partial diagnostics.',
      error: 'entry agent exploded',
    });
    expect(await getUnresolvedStageEntryEvents(projectId)).toEqual([
      expect.objectContaining({ id: event!.id, state: 'failed' }),
    ]);
    expect(await getUnreadPayloads(owner.id)).toEqual([
      expect.objectContaining({
        summary: 'Stage-entry agent failed: Investigate blocked card',
      }),
    ]);
  });
});
