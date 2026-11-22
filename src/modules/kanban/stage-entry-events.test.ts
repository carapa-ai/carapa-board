import { beforeEach, describe, expect, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import {
  claimNextStageEntryEvent,
  claimNormalTaskAdmission,
  commitProjectStageMigration,
  completeActiveRun,
  completeStageEntryEventIfOwned,
  createConversation,
  createTask,
  getBlockingStageEntryEvents,
  getTask,
  getActiveRunById,
  getProjectsWithUnresolvedStageEntryEvents,
  getUnresolvedStageEntryEvents,
  initDatabase,
  insertActiveRun,
  markStageEntryEventFailed,
  markStageEntryEventRunning,
  moveTaskToProject,
  reconcileStageEntryEventRuns,
  releaseStageEntryEventClaim,
  resolveStageEntryEvent,
  resolveStaleStageEntryEvents,
  setRecoveryBudgetExhaustedHandler,
  setStageEntryEventCommittedHandler,
  updateTask,
  updateProjectSettingsWithAdmissionLock,
  releaseTaskAdmission,
  recoverStaleTaskAdmissions,
} from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { projects, stageEntryEvents, tasks } from '../../db/schema.js';
import { runFixture, taskFixture, truncateTestDb } from '../../test-helpers.js';
import type { StageDefinition, StageEntryEvent } from './types.js';

const PROJECT = 'stage-entry-events-project';
const BACKLOG: StageDefinition = {
  id: 'backlog',
  title: 'Backlog',
  type: 'queue',
  color: '#64748b',
};
const AUTOMATIC: StageDefinition = {
  id: 'automatic',
  title: 'Automatic',
  type: 'active',
  color: '#2563eb',
  runOnEntry: true,
};
const DONE: StageDefinition = {
  id: 'done',
  title: 'Done',
  type: 'done',
  color: '#16a34a',
};

let initialized = false;

async function seedProject(
  stages: StageDefinition[],
  projectId = PROJECT,
  settings: Record<string, unknown> = {},
): Promise<void> {
  await drizzleDbRef.current.insert(projects).values({
    id: projectId,
    jid: `${projectId}@board`,
    name: 'Stage entry events',
    folder: projectId,
    trigger: '@entry',
    added_at: new Date().toISOString(),
    settings: JSON.stringify({ ...settings, stages }),
  });
}

async function allEvents(): Promise<(typeof stageEntryEvents.$inferSelect)[]> {
  return drizzleDbRef.current
    .select()
    .from(stageEntryEvents)
    .where(eq(stageEntryEvents.project_id, PROJECT))
    .orderBy(asc(stageEntryEvents.created_at), asc(stageEntryEvents.id));
}

beforeEach(async () => {
  if (!initialized) {
    await initDatabase(':memory:');
    initialized = true;
  }
  await drizzleDbRef.current.delete(stageEntryEvents);
  await truncateTestDb();
  setStageEntryEventCommittedHandler(null);
});

describe('automatic recovery budget', () => {
  test('suppresses the hook after the budget is spent until a user-triggered move opens a new window', async () => {
    const QUESTION: StageDefinition = {
      id: 'question',
      title: 'Question',
      type: 'queue',
      color: '#f59e0b',
      runOnEntry: true,
    };
    const FAILED: StageDefinition = {
      id: 'failed',
      title: 'Failed',
      type: 'queue',
      color: '#ef4444',
      runOnEntry: true,
    };
    const WORK: StageDefinition = {
      id: 'work',
      title: 'Work',
      type: 'active',
      color: '#2563eb',
    };
    await seedProject([BACKLOG, QUESTION, FAILED, WORK, DONE]);
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: WORK.id }),
    );
    const exhausted: unknown[] = [];
    setRecoveryBudgetExhaustedHandler((value) => {
      exhausted.push(value);
    });

    // Two automatic parks (alternating recovery stages) spend the budget.
    for (const stage of [QUESTION.id, FAILED.id]) {
      expect(await updateTask(task.id, { status: stage })).toBeDefined();
      await updateTask(task.id, { status: WORK.id });
    }
    expect(exhausted).toEqual([]);

    expect(await updateTask(task.id, { status: QUESTION.id })).toBeUndefined();
    expect((await getTask(task.id))?.status).toBe(QUESTION.id);
    expect(await allEvents()).toHaveLength(2);
    expect(exhausted).toEqual([
      expect.objectContaining({
        taskId: task.id,
        stageId: QUESTION.id,
        runs: 2,
      }),
    ]);

    // A user-triggered retrigger starts a new window: the next park fires.
    await updateTask(task.id, {
      status: WORK.id,
      lastTriggerSource: 'user',
      lastTriggeredAt: new Date().toISOString(),
    });
    expect(await updateTask(task.id, { status: FAILED.id })).toBeDefined();
    expect(await allEvents()).toHaveLength(3);

    setRecoveryBudgetExhaustedHandler(null);
  });
});

describe('durable stage entry events', () => {
  test('creates an initial receipt only for explicitly enabled active stages', async () => {
    const promptOnly: StageDefinition = {
      id: 'prompt_only',
      title: 'Prompt only',
      type: 'review',
      color: '#a855f7',
      workerPrompt: 'Review this card',
    };
    const inactiveAutomatic: StageDefinition = {
      ...AUTOMATIC,
      id: 'inactive_automatic',
      inactive: true,
    };
    await seedProject([
      BACKLOG,
      AUTOMATIC,
      promptOnly,
      inactiveAutomatic,
      DONE,
    ]);

    const automaticTask = await createTask(
      taskFixture({ project_id: PROJECT, status: AUTOMATIC.id }),
    );
    await createTask(
      taskFixture({ project_id: PROJECT, status: promptOnly.id }),
    );
    await createTask(
      taskFixture({ project_id: PROJECT, status: inactiveAutomatic.id }),
    );

    const events = await allEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      project_id: PROJECT,
      task_id: automaticTask.id,
      stage_id: AUTOMATIC.id,
      state: 'pending',
    });
  });
  test('creates initial receipts for opted-in queue and done stages', async () => {
    const automaticQueue = { ...BACKLOG, runOnEntry: true };
    const automaticDone = { ...DONE, runOnEntry: true };
    await seedProject([automaticQueue, AUTOMATIC, automaticDone]);

    await createTask(
      taskFixture({ project_id: PROJECT, status: automaticQueue.id }),
    );
    await createTask(
      taskFixture({ project_id: PROJECT, status: automaticDone.id }),
    );

    expect((await allEvents()).map((event) => event.stage_id)).toEqual([
      automaticQueue.id,
      automaticDone.id,
    ]);
  });

  test('excludes duplicate status writes, resolves exits, and creates re-entry receipts', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    const committed: StageEntryEvent[] = [];
    setStageEntryEventCommittedHandler((event) => {
      committed.push(event);
    });
    const task = await createTask(taskFixture({ project_id: PROJECT }));

    await updateTask(task.id, { status: AUTOMATIC.id });
    await updateTask(task.id, { status: AUTOMATIC.id });
    await updateTask(task.id, { status: AUTOMATIC.id, title: 'Duplicate' });
    expect(await allEvents()).toHaveLength(1);

    await updateTask(task.id, { status: BACKLOG.id });
    expect((await allEvents())[0]?.state).toBe('resolved');
    await updateTask(task.id, { status: AUTOMATIC.id });

    const afterReentry = await allEvents();
    expect(afterReentry).toHaveLength(2);
    expect(afterReentry.map((event) => event.state).sort()).toEqual([
      'pending',
      'resolved',
    ]);
    expect(committed).toHaveLength(2);
    expect(new Set(committed.map((event) => event.id))).toEqual(
      new Set(afterReentry.map((event) => event.id)),
    );

    await updateTask(task.id, { status: BACKLOG.id });
    await updateTask(
      task.id,
      { status: AUTOMATIC.id },
      { suppressStageEntryEvent: true },
    );
    expect(await allEvents()).toHaveLength(2);
    expect(await getUnresolvedStageEntryEvents(PROJECT)).toEqual([]);
  });

  test('orders a normal claim before a concurrently requested entry commit', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    const entryTask = await createTask(
      taskFixture({ project_id: PROJECT, status: DONE.id }),
    );
    const order: string[] = [];
    let transition: Promise<void> | undefined;

    const admission = await claimNormalTaskAdmission(PROJECT, () => {
      transition = updateTask(entryTask.id, { status: AUTOMATIC.id }).then(
        () => {
          order.push('entry-committed');
        },
      );
      order.push('normal-claimed');
      return 'normal-token';
    });
    await transition;

    expect(admission).toEqual({
      blockedByEntry: false,
      claim: 'normal-token',
      taskCheckoutMode: 'shared',
    });
    expect(order).toEqual(['normal-claimed', 'entry-committed']);
    expect(await getUnresolvedStageEntryEvents(PROJECT)).toEqual([
      expect.objectContaining({ taskId: entryTask.id, state: 'pending' }),
    ]);
  });
  test('blocks nonterminal receipts but admits normal work after failure', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    const entryTask = await createTask(
      taskFixture({ project_id: PROJECT, status: AUTOMATIC.id }),
    );
    expect(
      await claimNormalTaskAdmission(PROJECT, () => 'pending-token'),
    ).toEqual({ blockedByEntry: true, claim: null });

    const event = await claimNextStageEntryEvent(
      PROJECT,
      '1970-01-01T00:00:00.000Z',
    );
    expect(
      await claimNormalTaskAdmission(PROJECT, () => 'claimed-token'),
    ).toEqual({ blockedByEntry: true, claim: null });
    await markStageEntryEventRunning(event!.id);
    expect(
      await claimNormalTaskAdmission(PROJECT, () => 'running-token'),
    ).toEqual({ blockedByEntry: true, claim: null });
    await markStageEntryEventFailed(event!.id, 'entry failed');

    const parkedAdmission = await claimNormalTaskAdmission(
      PROJECT,
      () => 'parked-entry-token',
      false,
      undefined,
      'shared',
      undefined,
      { taskId: entryTask.id, stageId: AUTOMATIC.id },
    );
    expect(parkedAdmission).toEqual({
      blockedByEntry: false,
      claim: null,
      taskCheckoutMode: 'shared',
    });

    const admission = await claimNormalTaskAdmission(
      PROJECT,
      () => 'normal-token',
    );

    expect(admission).toMatchObject({
      blockedByEntry: false,
      claim: 'normal-token',
    });
    expect(await getBlockingStageEntryEvents(PROJECT)).toEqual([]);
    expect(await getUnresolvedStageEntryEvents(PROJECT)).toEqual([
      expect.objectContaining({
        id: event!.id,
        taskId: entryTask.id,
        state: 'failed',
        error: 'entry failed',
      }),
    ]);
  });
  test('durable task admission blocks a concurrent checkout-mode update', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    const admission = await claimNormalTaskAdmission(
      PROJECT,
      () => 'durable-token',
      false,
      'durable-admission-task',
    );
    expect(admission.taskCheckoutMode).toBe('shared');
    await expect(
      updateProjectSettingsWithAdmissionLock(
        PROJECT,
        JSON.stringify({
          taskCheckoutMode: 'branch',
          stages: [BACKLOG, AUTOMATIC, DONE],
        }),
      ),
    ).rejects.toThrow('task execution or admission is active');
    await releaseTaskAdmission(
      PROJECT,
      'durable-admission-task',
      admission.ownerToken,
    );
    await updateProjectSettingsWithAdmissionLock(
      PROJECT,
      JSON.stringify({
        taskCheckoutMode: 'branch',
        stages: [BACKLOG, AUTOMATIC, DONE],
      }),
    );
  });
  test('allows idle and conversation-only mode changes without releasing the conversation', async () => {
    const idleActive = { ...AUTOMATIC, runOnEntry: false };
    const stages = [BACKLOG, idleActive, DONE];
    await seedProject(stages, PROJECT, {
      status: 'paused',
      taskCheckoutMode: 'shared',
    });
    await createTask(
      taskFixture({ project_id: PROJECT, status: idleActive.id }),
    );

    await updateProjectSettingsWithAdmissionLock(
      PROJECT,
      JSON.stringify({
        status: 'paused',
        taskCheckoutMode: 'branch',
        stages,
      }),
    );
    await updateProjectSettingsWithAdmissionLock(
      PROJECT,
      JSON.stringify({
        status: 'running',
        taskCheckoutMode: 'branch',
        stages,
      }),
    );

    const conversation = await createConversation(PROJECT);
    const run = runFixture({
      id: 'active-conversation-mode-change-run',
      group_folder: PROJECT,
      conversation_id: conversation.id,
      task_id: null,
    });
    await insertActiveRun(run);
    const admissionId = `conversation:${conversation.id}`;
    const admission = await claimNormalTaskAdmission(
      PROJECT,
      () => 'conversation-token',
      true,
      admissionId,
      'shared',
    );
    expect(admission.taskCheckoutMode).toBe('branch');

    await updateProjectSettingsWithAdmissionLock(
      PROJECT,
      JSON.stringify({
        status: 'running',
        taskCheckoutMode: 'worktree',
        stages,
      }),
    );

    const [row] = await drizzleDbRef.current
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, PROJECT));
    const persisted = JSON.parse(row!.settings!);
    expect(persisted).toMatchObject({
      status: 'running',
      taskCheckoutMode: 'worktree',
    });
    expect(persisted._checkoutAdmissions[admissionId]).toMatchObject({
      taskCheckoutMode: 'branch',
      ownerToken: admission.ownerToken,
    });
    expect((await getActiveRunById(run.id))?.status).toBe('running');

    await releaseTaskAdmission(PROJECT, admissionId, admission.ownerToken);
    await completeActiveRun(run.id, 'completed');
  });
  test('blocks task-bound stage-entry runs but ignores another project', async () => {
    const otherProject = `${PROJECT}-other`;
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    await seedProject([BACKLOG, AUTOMATIC, DONE], otherProject);
    const otherTask = await createTask(
      taskFixture({ project_id: otherProject, status: BACKLOG.id }),
    );
    const otherRun = runFixture({
      id: 'unrelated-project-task-run',
      group_folder: otherProject,
      task_id: otherTask.id,
    });
    await insertActiveRun(otherRun);

    await updateProjectSettingsWithAdmissionLock(
      PROJECT,
      JSON.stringify({
        taskCheckoutMode: 'branch',
        stages: [BACKLOG, AUTOMATIC, DONE],
      }),
    );

    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: AUTOMATIC.id }),
    );
    const event = await claimNextStageEntryEvent(
      PROJECT,
      '1970-01-01T00:00:00.000Z',
    );
    const run = runFixture({
      id: 'task-bound-stage-entry-run',
      group_folder: PROJECT,
      task_id: task.id,
      stage: AUTOMATIC.id,
    });
    await insertActiveRun(run);
    await markStageEntryEventRunning(event!.id, run.id);

    await expect(
      updateProjectSettingsWithAdmissionLock(
        PROJECT,
        JSON.stringify({
          taskCheckoutMode: 'worktree',
          stages: [BACKLOG, AUTOMATIC, DONE],
        }),
      ),
    ).rejects.toThrow('task execution or admission is active');
    await updateProjectSettingsWithAdmissionLock(
      PROJECT,
      JSON.stringify({
        status: 'paused',
        taskCheckoutMode: 'branch',
        stages: [BACKLOG, AUTOMATIC, DONE],
      }),
    );

    await completeActiveRun(run.id, 'completed');
    await completeActiveRun(otherRun.id, 'completed');
    await completeStageEntryEventIfOwned({
      eventId: event!.id,
      state: 'succeeded',
      output: '',
      error: null,
      lastAgentName: null,
    });
  });
  test('retains active conversation admissions during stale recovery', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    const conversation = await createConversation(PROJECT);
    const run = runFixture({
      id: 'conversation-admission-recovery-run',
      group_folder: PROJECT,
      conversation_id: conversation.id,
      task_id: null,
    });
    await insertActiveRun(run);
    const admissionId = `conversation:${conversation.id}`;
    const admission = await claimNormalTaskAdmission(
      PROJECT,
      () => 'conversation-token',
      true,
      admissionId,
      'shared',
    );
    expect(admission.claim).toBe('conversation-token');
    await recoverStaleTaskAdmissions();
    const row = await drizzleDbRef.current
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, PROJECT));
    expect(
      JSON.parse(row[0]!.settings!)._checkoutAdmissions[admissionId],
    ).toMatchObject({
      taskCheckoutMode: 'shared',
      ownerToken: admission.ownerToken,
    });
    await releaseTaskAdmission(PROJECT, admissionId, admission.ownerToken);
    await completeActiveRun(run.id, 'completed');
  });
  test('reads the new mode when the settings write linearizes before admission', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    await updateProjectSettingsWithAdmissionLock(
      PROJECT,
      JSON.stringify({
        taskCheckoutMode: 'worktree',
        stages: [BACKLOG, AUTOMATIC, DONE],
      }),
    );
    const admission = await claimNormalTaskAdmission(
      PROJECT,
      (mode) => mode,
      false,
      'mode-write-before-claim',
      'shared',
    );
    expect(admission).toMatchObject({
      blockedByEntry: false,
      claim: 'worktree',
      taskCheckoutMode: 'worktree',
    });
    await releaseTaskAdmission(
      PROJECT,
      'mode-write-before-claim',
      admission.ownerToken,
    );
  });

  test('uses an explicitly persisted shared mode over a stale fallback', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    await drizzleDbRef.current
      .update(projects)
      .set({
        settings: JSON.stringify({
          taskCheckoutMode: 'shared',
          stages: [BACKLOG, AUTOMATIC, DONE],
        }),
      })
      .where(eq(projects.id, PROJECT));

    const admission = await claimNormalTaskAdmission(
      PROJECT,
      (mode) => mode,
      false,
      undefined,
      'branch',
    );
    expect(admission).toMatchObject({
      blockedByEntry: false,
      claim: 'shared',
      taskCheckoutMode: 'shared',
    });
  });

  test('keeps administrative stage migrations event-free and resolves invalid receipts', async () => {
    await seedProject([AUTOMATIC, DONE]);
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: AUTOMATIC.id }),
    );

    await commitProjectStageMigration(
      PROJECT,
      JSON.stringify({ stages: [DONE] }),
      [{ sourceStageId: AUTOMATIC.id, destinationStageId: DONE.id }],
    );

    const events = await allEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.state).toBe('resolved');
    const taskRows = await drizzleDbRef.current
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(taskRows[0]?.status).toBe(DONE.id);
  });

  test('configuration disable affects future entries without erasing barriers', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    await createTask(
      taskFixture({ project_id: PROJECT, status: AUTOMATIC.id }),
    );
    const disabled = { ...AUTOMATIC, runOnEntry: false };

    await commitProjectStageMigration(
      PROJECT,
      JSON.stringify({ stages: [BACKLOG, disabled, DONE] }),
      [],
    );
    await createTask(
      taskFixture({
        project_id: PROJECT,
        status: AUTOMATIC.id,
        title: 'Later',
      }),
    );

    const events = await allEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.state).toBe('pending');
  });

  test('claims, releases, recovers, links, and completes receipts durably', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    const firstTask = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: AUTOMATIC.id,
        title: 'First',
      }),
    );
    const first = await claimNextStageEntryEvent(
      PROJECT,
      '1970-01-01T00:00:00.000Z',
    );
    expect(first?.taskId).toBe(firstTask.id);
    expect(
      (await markStageEntryEventFailed(first!.id, 'agent failed'))?.state,
    ).toBe('failed');

    const secondTask = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: AUTOMATIC.id,
        title: 'Second',
      }),
    );
    const second = await claimNextStageEntryEvent(
      PROJECT,
      '1970-01-01T00:00:00.000Z',
    );
    expect(second?.taskId).toBe(secondTask.id);
    expect(await releaseStageEntryEventClaim(second!.id)).toBe(true);
    expect(await releaseStageEntryEventClaim(second!.id)).toBe(false);

    const recovered = await claimNextStageEntryEvent(
      PROJECT,
      '2999-01-01T00:00:00.000Z',
    );
    expect(recovered?.id).toBe(second?.id);
    const run = runFixture({
      id: 'stage-entry-run',
      group_folder: PROJECT,
      task_id: secondTask.id,
      stage: AUTOMATIC.id,
    });
    await insertActiveRun(run);
    expect(
      (await markStageEntryEventRunning(recovered!.id, run.id))?.runId,
    ).toBe(run.id);
    expect(await releaseStageEntryEventClaim(recovered!.id)).toBe(false);
    expect(
      (
        await completeStageEntryEventIfOwned({
          eventId: recovered!.id,
          state: 'succeeded',
          output: '',
          error: null,
          lastAgentName: null,
        })
      )?.event.state,
    ).toBe('succeeded');

    expect(
      (await getUnresolvedStageEntryEvents(PROJECT)).map((event) => event.id),
    ).toEqual([first!.id]);
    expect(await getProjectsWithUnresolvedStageEntryEvents()).toContain(
      PROJECT,
    );
    expect(await resolveStageEntryEvent(first!.id)).toBe(true);
    expect(await getProjectsWithUnresolvedStageEntryEvents()).not.toContain(
      PROJECT,
    );
  });

  test('reconciles missing run links without consuming terminal outcomes', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    const completedTask = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: AUTOMATIC.id,
        title: 'Completed',
      }),
    );
    const completedEvent = await claimNextStageEntryEvent(
      PROJECT,
      '1970-01-01T00:00:00.000Z',
    );
    const completedRun = runFixture({
      id: 'stage-entry-completed-run',
      group_folder: PROJECT,
      task_id: completedTask.id,
      stage: AUTOMATIC.id,
    });
    await insertActiveRun(completedRun);
    await markStageEntryEventRunning(completedEvent!.id, completedRun.id);
    await completeActiveRun(completedRun.id, 'completed');

    const failedTask = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: AUTOMATIC.id,
        title: 'Failed',
      }),
    );
    const failedEvent = await claimNextStageEntryEvent(
      PROJECT,
      '1970-01-01T00:00:00.000Z',
    );
    const failedRun = runFixture({
      id: 'stage-entry-failed-run',
      group_folder: PROJECT,
      task_id: failedTask.id,
      stage: AUTOMATIC.id,
    });
    await insertActiveRun(failedRun);
    await markStageEntryEventRunning(failedEvent!.id, failedRun.id);
    await completeActiveRun(failedRun.id, 'error');

    const launchGapTask = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: AUTOMATIC.id,
        title: 'Launch gap',
      }),
    );
    const launchGapEvent = await claimNextStageEntryEvent(
      PROJECT,
      '1970-01-01T00:00:00.000Z',
    );
    const launchGapRun = runFixture({
      id: 'stage-entry-launch-gap-run',
      group_folder: PROJECT,
      task_id: launchGapTask.id,
      stage: AUTOMATIC.id,
      started_at: new Date(Date.now() + 1_000).toISOString(),
    });
    await insertActiveRun(launchGapRun);
    await completeActiveRun(launchGapRun.id, 'completed');

    await createTask(
      taskFixture({
        project_id: PROJECT,
        status: AUTOMATIC.id,
        title: 'Unlinked',
      }),
    );
    const unlinkedEvent = await claimNextStageEntryEvent(
      PROJECT,
      '1970-01-01T00:00:00.000Z',
    );
    await markStageEntryEventRunning(unlinkedEvent!.id);

    expect(await reconcileStageEntryEventRuns()).toEqual({
      linked: 1,
      released: 1,
    });
    const byId: Record<
      string,
      typeof stageEntryEvents.$inferSelect | undefined
    > = {};
    for (const event of await allEvents()) byId[event.id] = event;
    expect(byId[completedEvent!.id]?.state).toBe('running');
    expect(byId[launchGapEvent!.id]).toMatchObject({
      state: 'running',
      run_id: launchGapRun.id,
    });
    expect(byId[failedEvent!.id]?.state).toBe('running');
    expect(byId[unlinkedEvent!.id]).toMatchObject({
      state: 'pending',
      run_id: null,
      claimed_at: null,
    });
  });

  test('resolves source and creates destination receipts when moving projects', async () => {
    const targetProject = 'stage-entry-events-target';
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    await seedProject([BACKLOG, AUTOMATIC, DONE], targetProject);
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: AUTOMATIC.id }),
    );

    await moveTaskToProject(task.id, targetProject, AUTOMATIC.id, []);

    const rows = await drizzleDbRef.current
      .select()
      .from(stageEntryEvents)
      .where(eq(stageEntryEvents.task_id, task.id));
    expect(rows).toHaveLength(2);
    expect(rows.find((event) => event.project_id === PROJECT)?.state).toBe(
      'resolved',
    );
    expect(
      rows.find((event) => event.project_id === targetProject),
    ).toMatchObject({
      state: 'pending',
      stage_id: AUTOMATIC.id,
    });
  });

  test('resolves receipts made stale by out-of-band task movement', async () => {
    await seedProject([BACKLOG, AUTOMATIC, DONE]);
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: AUTOMATIC.id }),
    );
    await drizzleDbRef.current
      .update(tasks)
      .set({ status: BACKLOG.id })
      .where(eq(tasks.id, task.id));

    expect(await resolveStaleStageEntryEvents(PROJECT)).toBe(1);
    expect((await allEvents())[0]?.state).toBe('resolved');
  });
});
