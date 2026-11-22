import {
  afterAll,
  beforeAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import fs from 'fs';
import * as reviewModule from './review.js';
import * as transcriptModule from '../transcripts/transcript-store.js';
import * as brainClient from '../objectives/brain-client.js';
import path from 'path';

// Load the tool registry first: kanban/tools.js and the registry import each
// other, and evaluating kanban/tools.js first leaves its exports uninitialized.
import '../tools/registry.js';
import {
  enrichRecentRuns,
  findBlockingContext,
  findLatestBlockingReason,
  findLatestReviewRejection,
  findTestingFailures,
  getTaskTool,
  listTasksTool,
  createTaskTool,
  updateTaskTool,
  _testOnlySetTaskQueueDrainRunner,
  addTaskCommentTool,
  archiveTaskTool,
  updateValuesTool,
  requireStagePromptTarget,
  resultsByRun,
} from './tools.js';
import type { StageDefinition, TaskMessage } from './types.js';
import {
  createTask,
  getTask,
  getTasksByProject,
  getTaskStageComment,
  initDatabase,
  completeActiveRun,
  insertActiveRun,
  updateTask,
} from '../../db.js';
import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import {
  appendTaskMessageAsync,
  readTaskMessages,
} from '../transcripts/transcript-store.js';
import { runFixture, taskFixture, truncateTestDb } from '../../test-helpers.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
  updateGroup,
} from '../../state-manager.js';
import { waitForFileState } from '../../test-file-events.js';
import { createObjective } from '../objectives/db-objectives.js';
import {
  _testOnlySetProjectFailureState,
  claimTaskExecution,
  finalizeTaskStageHandoff,
  getPendingTaskStageHandoff,
  releaseTaskExecutionClaim,
  setGroupResolver,
} from './task/pipeline.js';
import { eq } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { objectiveTaskEventHolds } from '../../db/schema.js';

const PROJECT = 'get-task-tool-test';

const PROJECT_JID = `${PROJECT}@test`;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  await registerGroup(PROJECT_JID, {
    id: PROJECT,
    jid: PROJECT_JID,
    name: 'Task tool test',
    folder: PROJECT,
    trigger: '',
    added_at: new Date().toISOString(),
    settings: { status: 'paused', stages },
  } as any);
});
beforeEach(async () => {
  await truncateTestDb();
  fs.rmSync(path.join(GROUPS_DIR, PROJECT), { recursive: true, force: true });
});
afterAll(async () => {
  fs.rmSync(path.join(GROUPS_DIR, PROJECT), { recursive: true, force: true });
  await unregisterGroup(PROJECT_JID);
});

function message(overrides: Partial<TaskMessage>): TaskMessage {
  return {
    id: crypto.randomUUID(),
    task_id: 'task',
    role: 'system',
    content: '',
    created_at: '2026-08-08T10:00:00.000Z',
    ...overrides,
  };
}

const stages: StageDefinition[] = [
  { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
  { id: 'question', title: 'Question', type: 'queue', color: '#fa0' },
  { id: 'build', title: 'Build', type: 'active', color: '#00f' },
  { id: 'testing', title: 'Testing', type: 'testing', color: '#ff0' },
  { id: 'review', title: 'Review', type: 'review', color: '#f0f' },
  {
    id: 'disabled',
    title: 'Disabled',
    type: 'active',
    color: '#aaa',
    inactive: true,
  },
  { id: 'done', title: 'Done', type: 'done', color: '#0f0' },
];

describe('requireStagePromptTarget', () => {
  test.each(['build'])('accepts executable stage %s', (stageId) => {
    expect(requireStagePromptTarget(stages, stageId).id).toBe(stageId);
  });

  test.each(['backlog', 'disabled', 'done', 'missing'])(
    'rejects non-executable stage %s',
    (stageId) => {
      expect(() => requireStagePromptTarget(stages, stageId)).toThrow(
        'is not an enabled active, testing, or review stage',
      );
    },
  );
});

function taskToolContext(overrides: Record<string, unknown> = {}) {
  return {
    group_folder: PROJECT,
    permissions: { [PROJECT]: ['tasks:write'] },
    ...overrides,
  } as any;
}

function nextControlRequest(runDir: string): Promise<string> {
  const requestDir = path.join(runDir, 'control-requests');
  fs.mkdirSync(requestDir, { recursive: true });
  return waitForFileState(requestDir, () =>
    fs.readdirSync(requestDir).find((entry) => entry.endsWith('.json')),
  );
}

describe('add_task_comment delivery', () => {
  test('steers an external same-stage prompt and records one durable receipt', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    const runId = `tool-steer-${task.id}`;
    const instance = `tool-steer-${task.id}`;
    const runDir = path.join(
      DATA_DIR,
      'ipc',
      `carapa-bot-${instance}`,
      'runs',
      runId,
    );
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'agent-control.json'),
      JSON.stringify({ version: 1, harness: 'codex' }),
    );
    await insertActiveRun(
      runFixture({
        id: runId,
        task_id: task.id,
        group_folder: PROJECT,
        sandbox_instance: instance,
        stage: 'build',
      }),
    );

    try {
      const controlRequest = nextControlRequest(runDir);
      const responsePromise = addTaskCommentTool.handler(
        {
          task_id: task.id,
          stage_id: 'build',
          comment: 'Apply the live tool guidance',
          persistent: false,
        },
        {} as any,
        taskToolContext(),
      );
      const requestFile = await controlRequest;
      const responseDir = path.join(runDir, 'control-responses');
      fs.mkdirSync(responseDir, { recursive: true });
      fs.writeFileSync(
        path.join(responseDir, requestFile),
        JSON.stringify({ ok: true }),
      );

      const response = JSON.parse(await responsePromise);
      expect(response).toMatchObject({
        delivery: 'steered',
        stage_id: 'build',
        run_id: runId,
      });
      const messages = readTaskMessages(PROJECT, task.id);
      const prompts = messages.filter(
        (entry) => entry.entry_type === 'stage_prompt',
      );
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        role: 'system',
        content: 'Apply the live tool guidance',
        target_stage: 'build',
        steeringDelivery: 'steered',
      });
      expect(
        messages.filter(
          (entry) =>
            entry.entry_type === 'steering_delivery' &&
            entry.prompt_id === prompts[0]?.id &&
            entry.run_id === runId,
        ),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${instance}`), {
        recursive: true,
        force: true,
      });
    }
  });

  test('queues unsupported, cross-stage, and idle prompts without steering', async () => {
    const scenarios = [
      {
        name: 'unsupported',
        activeStage: 'build',
        targetStage: 'build',
      },
      { name: 'cross-stage', activeStage: 'build', targetStage: 'review' },
      { name: 'idle', activeStage: null, targetStage: 'build' },
      {
        name: 'own-run-other-stage',
        activeStage: 'build',
        targetStage: 'review',
        selfAuthored: true,
      },
    ] as const;

    for (const scenario of scenarios) {
      const task = await createTask(
        taskFixture({ project_id: PROJECT, status: 'build' }),
      );
      const runId = `tool-queue-${scenario.name}-${task.id}`;
      const instance = `tool-queue-${scenario.name}-${task.id}`;
      const runDir = path.join(
        DATA_DIR,
        'ipc',
        `carapa-bot-${instance}`,
        'runs',
        runId,
      );
      if (scenario.activeStage) {
        fs.mkdirSync(runDir, { recursive: true });
        await insertActiveRun(
          runFixture({
            id: runId,
            task_id: task.id,
            group_folder: PROJECT,
            sandbox_instance: instance,
            stage: scenario.activeStage,
          }),
        );
      }

      const response = JSON.parse(
        await addTaskCommentTool.handler(
          {
            task_id: task.id,
            stage_id: scenario.targetStage,
            comment: `${scenario.name} guidance`,
            persistent: false,
          },
          {} as any,
          taskToolContext(
            'selfAuthored' in scenario && scenario.selfAuthored
              ? { task_id: task.id, run_id: runId }
              : {},
          ),
        ),
      );
      expect(response.delivery).toBe('queued');
      const messages = readTaskMessages(PROJECT, task.id);
      const prompts = messages.filter(
        (entry) => entry.entry_type === 'stage_prompt',
      );
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        entry_type: 'stage_prompt',
        target_stage: scenario.targetStage,
        steeringDelivery: 'queued',
      });
      if ('selfAuthored' in scenario && scenario.selfAuthored)
        expect(prompts[0]?.run_id).toBe(runId);
      expect(
        messages.some((entry) => entry.entry_type === 'steering_delivery'),
      ).toBe(false);
      expect(fs.existsSync(path.join(runDir, 'control-requests'))).toBe(false);
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${instance}`), {
        recursive: true,
        force: true,
      });
    }
  });

  test('rejects an own-run one-shot prompt to its running stage and persists nothing', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    const earlierRunId = `tool-own-earlier-${task.id}`;
    const runId = `tool-own-${task.id}`;
    for (const id of [earlierRunId, runId]) {
      await insertActiveRun(
        runFixture({
          id,
          task_id: task.id,
          group_folder: PROJECT,
          sandbox_instance: id,
          stage: 'build',
          ...(id === earlierRunId ? { status: 'completed' } : {}),
        }),
      );
    }
    const callers = [
      { task_id: task.id, run_id: runId },
      { task_id: task.id.replace(/^task-/, '') },
      { run_id: earlierRunId },
    ];
    for (const caller of callers) {
      await expect(
        addTaskCommentTool.handler(
          {
            task_id: task.id,
            stage_id: 'build',
            comment: 'talking to myself',
            persistent: false,
          },
          {} as any,
          taskToolContext(caller),
        ),
      ).rejects.toThrow('cannot send a one-shot prompt to your own running');
    }
    expect(
      readTaskMessages(PROJECT, task.id).some(
        (entry) => entry.entry_type === 'stage_prompt',
      ),
    ).toBe(false);
  });

  test('queues a same-stage prompt when the harness rejects steering', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    const runId = `tool-reject-${task.id}`;
    const instance = `tool-reject-${task.id}`;
    const runDir = path.join(
      DATA_DIR,
      'ipc',
      `carapa-bot-${instance}`,
      'runs',
      runId,
    );
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'agent-control.json'),
      JSON.stringify({ version: 1, harness: 'codex' }),
    );
    await insertActiveRun(
      runFixture({
        id: runId,
        task_id: task.id,
        group_folder: PROJECT,
        sandbox_instance: instance,
        stage: 'build',
      }),
    );

    try {
      const controlRequest = nextControlRequest(runDir);
      const responsePromise = addTaskCommentTool.handler(
        {
          task_id: task.id,
          stage_id: 'build',
          comment: 'Queue rejected guidance',
          persistent: false,
        },
        {} as any,
        taskToolContext(),
      );
      const requestFile = await controlRequest;
      const responseDir = path.join(runDir, 'control-responses');
      fs.mkdirSync(responseDir, { recursive: true });
      fs.writeFileSync(
        path.join(responseDir, requestFile),
        JSON.stringify({ ok: false }),
      );

      expect(JSON.parse(await responsePromise)).toMatchObject({
        delivery: 'queued',
        run_id: null,
      });
      const messages = readTaskMessages(PROJECT, task.id);
      expect(
        messages.filter((entry) => entry.entry_type === 'stage_prompt'),
      ).toHaveLength(1);
      expect(
        messages.some((entry) => entry.entry_type === 'steering_delivery'),
      ).toBe(false);
    } finally {
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${instance}`), {
        recursive: true,
        force: true,
      });
    }
  });

  test('keeps persistent save and clear outside the delivery transcript', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    const save = JSON.parse(
      await addTaskCommentTool.handler(
        {
          task_id: task.id,
          stage_id: 'review',
          comment: 'Review every future run',
          persistent: true,
        },
        {} as any,
        taskToolContext(),
      ),
    );
    expect(save.message).toBe('Persistent stage comment saved');
    expect(await getTaskStageComment(task.id, 'review')).toMatchObject({
      content: 'Review every future run',
    });
    expect(readTaskMessages(PROJECT, task.id)).toEqual([]);

    const clear = JSON.parse(
      await addTaskCommentTool.handler(
        {
          task_id: task.id,
          stage_id: 'review',
          comment: '',
          persistent: true,
        },
        {} as any,
        taskToolContext(),
      ),
    );
    expect(clear.message).toBe('Persistent stage comment cleared');
    expect(await getTaskStageComment(task.id, 'review')).toBeUndefined();
    expect(readTaskMessages(PROJECT, task.id)).toEqual([]);
  });
});

describe('get_task context', () => {
  describe('queueHoldReason', () => {
    const runningGroup = {
      id: PROJECT,
      jid: PROJECT_JID,
      name: 'Task tool test',
      folder: PROJECT,
      trigger: '',
      added_at: new Date().toISOString(),
      settings: { status: 'running', stages },
    } as any;

    beforeAll(() => {
      setGroupResolver((id) => (id === PROJECT ? runningGroup : undefined));
    });
    afterAll(() => {
      _testOnlySetProjectFailureState(PROJECT, null);
      setGroupResolver(() => undefined);
    });

    async function queueHoldReason(taskId: string) {
      const value = JSON.parse(
        await getTaskTool.handler({ task_id: taskId }, {} as any, {
          group_folder: PROJECT,
          permissions: { [PROJECT]: ['tasks:read'] },
        }),
      );
      return value.queueHoldReason;
    }

    test('reports why an executable-stage card is held', async () => {
      const backlog = await createTask(
        taskFixture({ project_id: PROJECT, status: 'backlog' }),
      );
      const done = await createTask(
        taskFixture({ project_id: PROJECT, status: 'done' }),
      );
      const free = await createTask(
        taskFixture({ project_id: PROJECT, status: 'build' }),
      );
      const dependency = await createTask(
        taskFixture({ project_id: PROJECT, status: 'backlog' }),
      );
      const dependent = await createTask(
        taskFixture({
          project_id: PROJECT,
          status: 'build',
          depends_on_ids: [dependency.id],
        }),
      );
      const mismatched = await createTask(
        taskFixture({
          project_id: PROJECT,
          status: 'build',
          execute_in_stage: 'testing',
        }),
      );
      const objective = await createObjective({
        project_id: PROJECT,
        title: 'Paused objective',
        description: '',
        status: 'paused',
        priority: 0,
        progress: 0,
        deadline: null,
        metadata: null,
        trigger_config: null,
      });
      const tagged = await createTask(
        taskFixture({
          project_id: PROJECT,
          status: 'build',
          objective_id: objective.id,
        }),
      );

      expect(await queueHoldReason(backlog.id)).toBeNull();
      expect(await queueHoldReason(done.id)).toBeNull();
      expect(await queueHoldReason(free.id)).toBe('waiting_for_slot');
      expect(await queueHoldReason(dependent.id)).toBe(
        `dependencies_pending:${dependency.id}`,
      );
      expect(await queueHoldReason(mismatched.id)).toBe(
        'execute_in_stage_mismatch:testing',
      );
      expect(await queueHoldReason(tagged.id)).toBe(
        'objective_inactive:paused',
      );

      _testOnlySetProjectFailureState(PROJECT, {
        count: 3,
        blockedAt: Date.now(),
      });
      expect(await queueHoldReason(free.id)).toBe('failure_cooldown');
      _testOnlySetProjectFailureState(PROJECT, null);
      expect(await queueHoldReason(free.id)).toBe('waiting_for_slot');
    });
  });

  test('reports per-stage/per-model runStats over every run, not only the newest', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'review' }),
    );
    const base = Date.parse('2026-10-20T00:00:00.000Z');
    const runs = [
      {
        stage: 'coding',
        model_name: 'opus',
        model: 'opus',
        cost_usd: 1,
        tok_total: 100,
      },
      {
        stage: 'testing',
        model_name: 'opus',
        model: 'opus',
        cost_usd: 0.5,
        tok_total: 50,
      },
      {
        stage: 'review',
        model_name: 'opus',
        model: 'opus',
        cost_usd: 2,
        tok_total: 200,
      },
      {
        stage: 'review',
        model_name: 'opus',
        model: 'opus',
        cost_usd: 1,
        tok_total: 100,
      },
      {
        stage: 'review',
        model_name: 'gpt-6.1-sol',
        model: 'sol',
        cost_usd: 3,
        tok_total: 300,
      },
      {
        stage: 'review',
        model_name: 'gpt-6.1-sol',
        model: 'sol',
        cost_usd: null,
        tok_total: 400,
      },
      {
        stage: 'review',
        model_name: null,
        model: 'sol-unnamed',
        cost_usd: null,
        tok_total: null,
      },
    ];
    for (const [i, run] of runs.entries()) {
      await insertActiveRun({
        ...runFixture({
          id: `run-stats-${task.id}-${i}`,
          task_id: task.id,
          group_folder: PROJECT,
          status: 'completed',
          started_at: new Date(base + i * 60_000).toISOString(),
        }),
        ...run,
      } as any);
    }

    const value = JSON.parse(
      await getTaskTool.handler({ task_id: task.id }, {} as any, {
        group_folder: PROJECT,
        permissions: { [PROJECT]: ['tasks:read'] },
      }),
    );

    expect(value.recentRuns).toHaveLength(3);
    expect(value.totalRunCount).toBe(7);
    expect(value.runStats).toEqual([
      {
        stage: 'coding',
        model: 'opus',
        modelName: 'opus',
        runs: 1,
        pricedRuns: 1,
        costUsd: 1,
        tokTotal: 100,
      },
      {
        stage: 'review',
        model: 'gpt-6.1-sol',
        modelName: 'gpt-6.1-sol',
        runs: 2,
        pricedRuns: 1,
        costUsd: 3,
        tokTotal: 700,
      },
      {
        stage: 'review',
        model: 'opus',
        modelName: 'opus',
        runs: 2,
        pricedRuns: 2,
        costUsd: 3,
        tokTotal: 300,
      },
      {
        stage: 'review',
        model: 'sol-unnamed',
        modelName: null,
        runs: 1,
        pricedRuns: 0,
        costUsd: null,
        tokTotal: null,
      },
      {
        stage: 'testing',
        model: 'opus',
        modelName: 'opus',
        runs: 1,
        pricedRuns: 1,
        costUsd: 0.5,
        tokTotal: 50,
      },
    ]);
  });

  test('retains the latest blocking prompt after the task leaves question', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content: 'Choose whether to preserve the legacy behavior',
      entry_type: 'stage_prompt',
      target_stage: 'build',
      created_at: '2026-08-08T10:00:00.000Z',
    });

    const value = JSON.parse(
      await getTaskTool.handler({ task_id: task.id }, {} as any, {
        group_folder: PROJECT,
        permissions: { [PROJECT]: ['tasks:read'] },
      }),
    );

    expect(value.blockingContext).toBeNull();
    expect(value.latestBlockingReason).toMatchObject({
      source: 'stagePrompt',
      content: 'Choose whether to preserve the legacy behavior',
      targetStage: 'build',
      createdAt: '2026-08-08T10:00:00.000Z',
      truncated: false,
    });
  });

  test('exposes mergePending only while an approved merge is outstanding', async () => {
    const context = {
      group_folder: PROJECT,
      permissions: { [PROJECT]: ['tasks:read'] },
    };
    const mergePendingOf = async (taskId: string) =>
      JSON.parse(
        await getTaskTool.handler({ task_id: taskId }, {} as any, context),
      ).mergePending;
    const notice = (taskId: string) =>
      appendTaskMessageAsync(PROJECT, {
        task_id: taskId,
        role: 'system',
        entry_type: 'system_notice',
        content: `**Review approved, merge pending** — dirty checkout\n\n${'x'.repeat(2000)}`,
        created_at: '2026-10-13T05:07:00.000Z',
      });

    const parked = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );
    await notice(parked.id);
    const pending = await mergePendingOf(parked.id);
    expect(pending.at).toBe('2026-10-13T05:07:00.000Z');
    expect(
      pending.reason.startsWith('**Review approved, merge pending**'),
    ).toBe(true);
    expect(pending.reason.length).toBeLessThanOrEqual(800);

    const merged = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );
    await updateTask(merged.id, { merge_commit: 'abc123' });
    await notice(merged.id);
    expect(await mergePendingOf(merged.id)).toBeNull();

    const rerun = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    await notice(rerun.id);
    await insertActiveRun(
      runFixture({
        id: 'merge-pending-later-run',
        task_id: rerun.id,
        group_folder: PROJECT,
        stage: 'build',
        status: 'completed',
        started_at: '2026-10-13T06:00:00.000Z',
        completed_at: '2026-10-13T06:01:00.000Z',
      }),
    );
    expect(await mergePendingOf(rerun.id)).toBeNull();
  });

  test('exposes mergePending for a completion checkpoint park', async () => {
    const context = {
      group_folder: PROJECT,
      permissions: { [PROJECT]: ['tasks:read'] },
    };
    const mergePendingOf = async (taskId: string) =>
      JSON.parse(
        await getTaskTool.handler({ task_id: taskId }, {} as any, context),
      ).mergePending;
    const notice = (taskId: string, prefix: string, createdAt: string) =>
      appendTaskMessageAsync(PROJECT, {
        task_id: taskId,
        role: 'system',
        entry_type: 'system_notice',
        content: `${prefix} — changes could not be committed to the configured default branch.\n\ncommit failed: could not resolve repository path inside service`,
        created_at: createdAt,
      });
    const checkpoint = '**Task checkpoint pending**';
    const noticeAt = '2026-10-15T12:25:38.000Z';

    const parked = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );
    await notice(parked.id, checkpoint, noticeAt);
    const pending = await mergePendingOf(parked.id);
    expect(pending.at).toBe(noticeAt);
    expect(pending.reason.startsWith(checkpoint)).toBe(true);
    expect(pending.reason).toContain(
      'could not resolve repository path inside service',
    );

    const merged = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );
    await updateTask(merged.id, { merge_commit: 'abc123' });
    await notice(merged.id, checkpoint, noticeAt);
    expect(await mergePendingOf(merged.id)).toBeNull();

    const rerun = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    await notice(rerun.id, checkpoint, noticeAt);
    await insertActiveRun(
      runFixture({
        id: 'checkpoint-pending-later-run',
        task_id: rerun.id,
        group_folder: PROJECT,
        stage: 'build',
        status: 'completed',
        started_at: '2026-10-15T13:00:00.000Z',
        completed_at: '2026-10-15T13:01:00.000Z',
      }),
    );
    expect(await mergePendingOf(rerun.id)).toBeNull();

    const both = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );
    await notice(
      both.id,
      '**Review approved, merge pending**',
      '2026-10-15T12:00:00.000Z',
    );
    await notice(both.id, checkpoint, noticeAt);
    expect((await mergePendingOf(both.id)).reason.startsWith(checkpoint)).toBe(
      true,
    );
  });

  test('does not classify ordinary successful history as a blocking reason', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    await insertActiveRun(
      runFixture({
        id: 'successful-run',
        task_id: task.id,
        group_folder: PROJECT,
        stage: 'testing',
        status: 'completed',
        started_at: '2026-08-08T10:00:00.000Z',
        completed_at: '2026-08-08T10:01:00.000Z',
      }),
    );
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content: '',
      entry_type: 'run_start',
      run_id: 'successful-run',
      created_at: '2026-08-08T10:00:00.000Z',
    });
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'assistant',
      content: 'Implementation completed successfully',
      created_at: '2026-08-08T10:00:30.000Z',
    });

    const value = JSON.parse(
      await getTaskTool.handler({ task_id: task.id }, {} as any, {
        group_folder: PROJECT,
        permissions: { [PROJECT]: ['tasks:read'] },
      }),
    );

    expect(value.blockingContext).toBeNull();
    expect(value.latestBlockingReason).toBeNull();
  });

  test('retains a blocked testing run beyond the three-run window after leaving question', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    await insertActiveRun(
      runFixture({
        id: 'historical-blocked-run',
        task_id: task.id,
        group_folder: PROJECT,
        stage: 'testing',
        status: 'completed',
        started_at: '2026-08-08T09:00:00.000Z',
        completed_at: '2026-08-08T09:01:00.000Z',
      }),
    );
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content: '',
      entry_type: 'run_start',
      run_id: 'historical-blocked-run',
      created_at: '2026-08-08T09:00:00.000Z',
    });
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'assistant',
      content: 'Testing needs credentials that are not available',
      entry_type: 'run_result',
      run_id: 'historical-blocked-run',
      created_at: '2026-08-08T09:00:30.000Z',
    });
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content:
        '**Testing blocked**\n\nTesting could not reach a verdict.\n\n**Issues:**\n- Missing credentials',
      entry_type: 'testing_feedback',
      created_at: '2026-08-08T09:00:40.000Z',
    });

    for (let index = 0; index < 4; index++) {
      const runId = `newer-successful-run-${index}`;
      await insertActiveRun(
        runFixture({
          id: runId,
          task_id: task.id,
          group_folder: PROJECT,
          stage: 'build',
          status: 'completed',
          started_at: `2026-08-08T10:0${index}:00.000Z`,
          completed_at: `2026-08-08T10:0${index}:30.000Z`,
        }),
      );
      await appendTaskMessageAsync(PROJECT, {
        task_id: task.id,
        role: 'system',
        content: '',
        entry_type: 'run_start',
        run_id: runId,
        created_at: `2026-08-08T10:0${index}:00.000Z`,
      });
      await appendTaskMessageAsync(PROJECT, {
        task_id: task.id,
        role: 'assistant',
        content: `Successful follow-up ${index}`,
        entry_type: 'run_result',
        run_id: runId,
        created_at: `2026-08-08T10:0${index}:20.000Z`,
      });
    }

    const value = JSON.parse(
      await getTaskTool.handler({ task_id: task.id }, {} as any, {
        group_folder: PROJECT,
        permissions: { [PROJECT]: ['tasks:read'] },
      }),
    );

    expect(value.blockingContext).toBeNull();
    expect(
      value.recentRuns.some(
        (run: any) => run.runId === 'historical-blocked-run',
      ),
    ).toBe(false);
    expect(value.latestBlockingReason).toMatchObject({
      source: 'latestRunResult',
      content: 'Testing needs credentials that are not available',
      targetStage: 'testing',
      runId: 'historical-blocked-run',
      createdAt: '2026-08-08T09:01:00.000Z',
      truncated: false,
    });
  });

  test('prefers a newer blocked run over an old delivered prompt', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'question' }),
    );
    await insertActiveRun(
      runFixture({
        id: 'blocked-testing-run',
        task_id: task.id,
        group_folder: PROJECT,
        stage: 'testing',
        status: 'completed',
        started_at: '2026-08-08T10:00:00.000Z',
        completed_at: '2026-08-08T10:01:00.000Z',
      }),
    );
    const answeredPrompt = await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content: 'Choose the old approach',
      entry_type: 'stage_prompt',
      target_stage: 'build',
      created_at: '2026-08-08T09:00:00.000Z',
    });
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content: '',
      entry_type: 'stage_prompt_delivery',
      prompt_id: answeredPrompt.id,
      created_at: '2026-08-08T09:01:00.000Z',
    });
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content: '',
      entry_type: 'run_start',
      run_id: 'blocked-testing-run',
      created_at: '2026-08-08T10:00:00.000Z',
    });
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'assistant',
      content: 'Tests cannot proceed without the missing fixture',
      created_at: '2026-08-08T10:00:30.000Z',
    });
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content:
        '**Testing blocked**\n\nTesting could not reach a verdict.\n\n**Issues:**\n- Missing fixture',
      entry_type: 'testing_feedback',
      created_at: '2026-08-08T10:00:40.000Z',
    });

    const value = JSON.parse(
      await getTaskTool.handler({ task_id: task.id }, {} as any, {
        group_folder: PROJECT,
        permissions: { [PROJECT]: ['tasks:read'] },
      }),
    );

    expect(value.blockingContext).toMatchObject({
      source: 'latestRunResult',
      content: 'Tests cannot proceed without the missing fixture',
    });
    expect(value.latestBlockingReason).toMatchObject({
      source: 'latestRunResult',
      content: 'Tests cannot proceed without the missing fixture',
      targetStage: 'testing',
      runId: 'blocked-testing-run',
      createdAt: '2026-08-08T10:01:00.000Z',
      truncated: false,
    });
  });

  test('returns only three newest runs with independently segmented results', async () => {
    const task = await createTask(taskFixture({ project_id: PROJECT }));
    for (let index = 0; index < 4; index++) {
      const id = `run-${index}`;
      await insertActiveRun(
        runFixture({
          id,
          task_id: task.id,
          group_folder: PROJECT,
          started_at: `2026-08-08T10:0${index}:00.000Z`,
          stage: index % 2 ? 'review' : 'in_progress',
          status: 'completed',
          completed_at: `2026-08-08T10:0${index}:30.000Z`,
          agent_name: `agent-${index}`,
          model_name: `model-${index}`,
        }),
      );
      await appendTaskMessageAsync(PROJECT, {
        task_id: task.id,
        role: 'system',
        content: '',
        entry_type: 'run_start',
        run_id: id,
        created_at: `2026-08-08T10:0${index}:00.000Z`,
      });
      await appendTaskMessageAsync(PROJECT, {
        task_id: task.id,
        role: 'assistant',
        content: `result ${index}`,
        created_at: `2026-08-08T10:0${index}:20.000Z`,
      });
    }
    const value = JSON.parse(
      await getTaskTool.handler({ task_id: task.id }, {} as any, {
        group_folder: PROJECT,
        permissions: { [PROJECT]: ['tasks:read'] },
      }),
    );
    expect(value.totalRunCount).toBe(4);
    expect(value.recentRuns.map((run: any) => run.runId)).toEqual([
      'run-3',
      'run-2',
      'run-1',
    ]);
    expect(value.recentRuns.map((run: any) => run.result?.content)).toEqual([
      'result 3',
      'result 2',
      'result 1',
    ]);
  });

  test('rejects unauthorized callers before reading transcript context', async () => {
    const task = await createTask(taskFixture({ project_id: PROJECT }));
    await expect(
      getTaskTool.handler({ task_id: task.id }, {} as any, {
        group_folder: PROJECT,
        permissions: {},
      }),
    ).rejects.toThrow('Unauthorized');
  });

  test('finds canonical recovery rejection feedback without run metadata', async () => {
    const task = await createTask(taskFixture({ project_id: PROJECT }));
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content:
        '**Review rejected** (score: 4/10, rejection 2)\n\nRecovery rejection summary\n\n**Issues:**\n- Preserve this feedback',
      created_at: '2026-08-08T10:00:00.000Z',
    });

    const value = JSON.parse(
      await getTaskTool.handler({ task_id: task.id }, {} as any, {
        group_folder: PROJECT,
        permissions: { [PROJECT]: ['tasks:read'] },
      }),
    );

    expect(value.latestReviewRejection).toMatchObject({
      source: 'reviewFeedback',
      content: expect.stringContaining('Recovery rejection summary'),
      createdAt: '2026-08-08T10:00:00.000Z',
      runId: null,
      stage: null,
      truncated: false,
    });
  });

  test('scans a huge unfenced assistant message once and stays fast', async () => {
    const task = await createTask(taskFixture({ project_id: PROJECT }));
    // Run 0 is a historical review run (outside the three newest) holding the
    // rejection; runs 1-3 are completed Testing runs.
    for (let index = 0; index < 4; index++) {
      const id = `scan-run-${index}`;
      await insertActiveRun(
        runFixture({
          id,
          task_id: task.id,
          group_folder: PROJECT,
          started_at: `2026-08-08T10:0${index}:00.000Z`,
          completed_at: `2026-08-08T10:0${index}:30.000Z`,
          stage: index === 0 ? 'review' : 'testing',
          status: 'completed',
        }),
      );
      await appendTaskMessageAsync(PROJECT, {
        task_id: task.id,
        role: 'system',
        content: '',
        entry_type: 'run_start',
        run_id: id,
        created_at: `2026-08-08T10:0${index}:00.000Z`,
      });
    }
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content: '**Review rejected** (score: 4/10, rejection 1)\n\nKept',
      entry_type: 'review_feedback',
      run_id: 'scan-run-0',
      created_at: '2026-08-08T10:00:20.000Z',
    });
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'assistant',
      content: 'unclosed { brace and "decision" text\n'.repeat(120_000),
      created_at: '2026-08-08T10:03:20.000Z',
    });
    // Each get_task pass iterates the transcript once, so counting iterations
    // counts passes: resultsByRun, collectTestingFailures,
    // testingBlockingCandidates and reviewRejectionCandidates. Re-running any
    // of them adds one.
    const messages = readTaskMessages(PROJECT, task.id);
    let passes = 0;
    const iterate = messages[Symbol.iterator].bind(messages);
    Object.defineProperty(messages, Symbol.iterator, {
      value: () => {
        passes++;
        return iterate();
      },
    });
    const read = spyOn(transcriptModule, 'readTaskMessages').mockReturnValue(
      messages,
    );
    const parse = spyOn(reviewModule, 'parseReviewDecision');
    try {
      const started = performance.now();
      const value = JSON.parse(
        await getTaskTool.handler({ task_id: task.id }, {} as any, {
          group_folder: PROJECT,
          permissions: { [PROJECT]: ['tasks:read'] },
        }),
      );
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(passes).toBe(4);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(value.recentRuns).toHaveLength(3);
      expect(value.latestReviewRejection).toMatchObject({
        source: 'reviewFeedback',
        content: expect.stringContaining('Kept'),
        runId: 'scan-run-0',
      });
    } finally {
      parse.mockRestore();
      read.mockRestore();
    }
  });

  test('finds the latest rejection beyond the three-run result window', async () => {
    const task = await createTask(taskFixture({ project_id: PROJECT }));
    for (let index = 0; index < 5; index++) {
      const runId = `review-run-${index}`;
      await insertActiveRun(
        runFixture({
          id: runId,
          task_id: task.id,
          group_folder: PROJECT,
          started_at: `2026-08-08T10:0${index}:00.000Z`,
          completed_at: `2026-08-08T10:0${index}:30.000Z`,
          stage: 'review',
          status: 'completed',
        }),
      );
      await appendTaskMessageAsync(PROJECT, {
        task_id: task.id,
        role: 'system',
        content: '',
        entry_type: 'run_start',
        run_id: runId,
        created_at: `2026-08-08T10:0${index}:00.000Z`,
      });
      if (index < 2) {
        await appendTaskMessageAsync(PROJECT, {
          task_id: task.id,
          role: 'system',
          content: `**Review rejected** (score: ${index + 2}/10, rejection ${index + 1})\n\nRejection ${index}`,
          entry_type: index === 0 ? 'review_feedback' : undefined,
          created_at: `2026-08-08T10:0${index}:20.000Z`,
        });
      }
    }
    await insertActiveRun(
      runFixture({
        id: 'implementation-run',
        task_id: task.id,
        group_folder: PROJECT,
        started_at: '2026-08-08T10:05:00.000Z',
        completed_at: '2026-08-08T10:05:30.000Z',
        stage: 'build',
        status: 'completed',
      }),
    );
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content: '',
      entry_type: 'run_start',
      run_id: 'implementation-run',
      created_at: '2026-08-08T10:05:00.000Z',
    });
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'assistant',
      content:
        'Implementation summary:\n\n**Review rejected** (score: 3/10)\n\nThis verdict-shaped example is now handled.',
      created_at: '2026-08-08T10:05:20.000Z',
    });

    const value = JSON.parse(
      await getTaskTool.handler({ task_id: task.id }, {} as any, {
        group_folder: PROJECT,
        permissions: { [PROJECT]: ['tasks:read'] },
      }),
    );

    expect(value.recentRuns.map((run: any) => run.runId)).toEqual([
      'implementation-run',
      'review-run-4',
      'review-run-3',
    ]);
    expect(value.latestReviewRejection).toMatchObject({
      source: 'reviewFeedback',
      content: expect.stringContaining('Rejection 1'),
      createdAt: '2026-08-08T10:01:20.000Z',
      runId: 'review-run-1',
      stage: 'review',
      truncated: false,
    });
  });

  test('get_task testingFailures lists a failed Testing verdict outside the three newest runs', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    const runIds = ['fail-run-a', 'pass-run-1', 'pass-run-2', 'pass-run-3'];
    for (const [index, id] of runIds.entries()) {
      const startedAt = `2026-08-08T1${index}:00:00.000Z`;
      await insertActiveRun(
        runFixture({
          id,
          task_id: task.id,
          group_folder: PROJECT,
          stage: 'testing',
          status: 'completed',
          started_at: startedAt,
          completed_at: `2026-08-08T1${index}:01:00.000Z`,
        }),
      );
      await appendTaskMessageAsync(PROJECT, {
        task_id: task.id,
        role: 'system',
        content: '',
        entry_type: 'run_start',
        run_id: id,
        created_at: startedAt,
      });
    }
    await appendTaskMessageAsync(PROJECT, {
      task_id: task.id,
      role: 'system',
      content: '**Testing failed**\n\nSummary: login form rejects valid input',
      entry_type: 'testing_feedback',
      run_id: 'fail-run-a',
      created_at: '2026-08-08T10:00:30.000Z',
    });

    const value = JSON.parse(
      await getTaskTool.handler({ task_id: task.id }, {} as any, {
        group_folder: PROJECT,
        permissions: { [PROJECT]: ['tasks:read'] },
      }),
    );

    expect(value.recentRuns.map((run: any) => run.runId)).not.toContain(
      'fail-run-a',
    );
    expect(value.testingFailures.total).toBe(1);
    expect(value.testingFailures.items[0]).toMatchObject({
      runId: 'fail-run-a',
      decision: 'fail',
      excerpt: expect.stringContaining('login form rejects valid input'),
    });
    expect(value.latestBlockingReason).toBeNull();
  });
});

describe('findTestingFailures', () => {
  const runStart = (runId: string, createdAt: string) =>
    message({
      entry_type: 'run_start',
      run_id: runId,
      created_at: createdAt,
    });

  test('keeps blocked verdicts and retry-limit notices', () => {
    const result = findTestingFailures([
      runStart('run-blocked', '2026-08-08T10:00:00.000Z'),
      message({ role: 'assistant', content: '**Testing blocked**\nNo DB' }),
      runStart('run-limit', '2026-08-08T11:00:00.000Z'),
      message({
        entry_type: 'testing_feedback',
        content: '**Automatic retry limit reached**\nGiving up',
      }),
    ]);

    expect(result.total).toBe(2);
    expect(result.items.map((item) => [item.runId, item.decision])).toEqual([
      ['run-blocked', 'blocked'],
      ['run-limit', 'blocked'],
    ]);
  });

  test('de-duplicates per run, preferring testing_feedback', () => {
    const result = findTestingFailures([
      runStart('run-a', '2026-08-08T10:00:00.000Z'),
      message({ role: 'assistant', content: '**Testing failed**\nassistant' }),
      message({
        entry_type: 'testing_feedback',
        content: '**Testing failed**\npersisted',
      }),
    ]);

    expect(result.total).toBe(1);
    expect(result.items[0].excerpt).toContain('persisted');
  });

  test('ignores passing verdicts and user messages', () => {
    const result = findTestingFailures([
      runStart('run-a', '2026-08-08T10:00:00.000Z'),
      message({
        entry_type: 'system_notice',
        content: '**Testing passed**\nAll good',
      }),
      message({ role: 'user', content: '**Testing failed**\nquoted' }),
    ]);

    expect(result).toEqual({ total: 0, items: [] });
  });

  test('caps items at 10 newest and 300-char excerpts', () => {
    const messages: TaskMessage[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(runStart(`run-${i}`, `2026-08-08T10:${10 + i}:00.000Z`));
      messages.push(
        message({
          entry_type: 'testing_feedback',
          content: `**Testing failed**\n${i === 11 ? 'x'.repeat(1000) : `failure ${i}`}`,
        }),
      );
    }
    const result = findTestingFailures(messages);

    expect(result.total).toBe(12);
    expect(result.items).toHaveLength(10);
    const last = result.items[9];
    expect(last.runId).toBe('run-11');
    expect(last.excerpt.length).toBeLessThanOrEqual(300);
    expect(last.truncated).toBe(true);
  });
});

describe('create_task / update_task dependencies', () => {
  const runningGroup = {
    id: PROJECT,
    jid: PROJECT_JID,
    name: 'Task tool test',
    folder: PROJECT,
    trigger: '',
    added_at: new Date().toISOString(),
    settings: { status: 'running', stages },
  } as any;
  const context = {
    group_folder: PROJECT,
    permissions: { [PROJECT]: ['tasks:read', 'tasks:write'] },
  };

  beforeAll(() => {
    setGroupResolver((id) => (id === PROJECT ? runningGroup : undefined));
  });
  afterAll(() => {
    setGroupResolver(() => undefined);
  });

  const create = async (args: Record<string, unknown>) =>
    JSON.parse(
      await createTaskTool.handler({ title: 'Dependent', ...args }, {} as any, {
        ...context,
      }),
    );
  const update = (args: Record<string, unknown>) =>
    updateTaskTool.handler(args, {} as any, { ...context });

  test('update_task drains the queue once when a card moves between done stages', async () => {
    const drained: string[] = [];
    const doneStages = [
      ...stages,
      { id: 'shipped', title: 'Shipped', type: 'done', color: '#0a0' },
    ] as StageDefinition[];
    await updateGroup(PROJECT_JID, {
      settings: { status: 'paused', stages: doneStages },
    });
    _testOnlySetTaskQueueDrainRunner(((projectId: string) => {
      drained.push(projectId);
    }) as any);
    try {
      const task = await createTask(
        taskFixture({ project_id: PROJECT, status: 'done' }),
      );
      await update({ task_id: task.id, title: 'Renamed' });
      expect(drained).toEqual([]);
      await update({ task_id: task.id, status: 'shipped' });
      expect(drained).toEqual([PROJECT]);
    } finally {
      _testOnlySetTaskQueueDrainRunner(null);
      await updateGroup(PROJECT_JID, {
        settings: { status: 'paused', stages },
      });
    }
  });

  test('update_task rejects agents adding review/testing to skip_stages but allows unchanged, active and cleared lists', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: 'build',
        skip_stages: ['review'],
      }),
    );
    await expect(
      update({ task_id: task.id, skip_stages: ['review', 'testing'] }),
    ).rejects.toThrow(
      /Agents cannot skip review or testing stages \(testing\)/,
    );
    expect((await getTask(task.id))?.skip_stages).toEqual(['review']);

    await update({ task_id: task.id, skip_stages: ['review'] });
    await update({ task_id: task.id, skip_stages: ['review', 'build'] });
    expect((await getTask(task.id))?.skip_stages).toEqual(['review', 'build']);
    await update({ task_id: task.id, skip_stages: null });
    expect((await getTask(task.id))?.skip_stages ?? null).toBeNull();
  });

  test('update_task refuses agent moves into review without stored Testing evidence', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );
    await expect(
      update({ task_id: task.id, status: 'review' }),
    ).rejects.toThrow(
      /Agents cannot move this task into review stage "review": the required Testing stage "testing" has no passing verdict/,
    );
    expect((await getTask(task.id))?.status).toBe('build');

    await updateTask(task.id, {
      custom_values: { testing_tree_sha: 'a'.repeat(40) },
    });
    await update({ task_id: task.id, status: 'review' });
    expect((await getTask(task.id))?.status).toBe('review');
  });

  test('create_task and update_task enforce objective project ownership', async () => {
    const newObjective = (project_id: string) =>
      createObjective({
        project_id,
        title: 'Objective',
        description: '',
        status: 'active',
        priority: 0,
        progress: 0,
        deadline: null,
        metadata: null,
        trigger_config: null,
      });
    const foreign = await newObjective('other-objective-project');
    const own = await newObjective(PROJECT);
    const task = await createTask(
      taskFixture({ project_id: PROJECT, status: 'build' }),
    );

    await expect(create({ objective_id: foreign.id })).rejects.toThrow(
      /Unauthorized/,
    );
    await expect(create({ objective_id: 'missing' })).rejects.toThrow(
      /Unknown objective/,
    );
    await expect(
      update({ task_id: task.id, objective_id: foreign.id }),
    ).rejects.toThrow(/Unauthorized/);
    expect((await create({ objective_id: own.id })).id).toBeTruthy();

    // A caller holding write access to the objective's project may tag it.
    const parentContext = {
      ...context,
      permissions: {
        [PROJECT]: ['tasks:write'],
        'other-objective-project': ['tasks:write'],
      },
    };
    const created = JSON.parse(
      await createTaskTool.handler(
        { title: 'Child card', objective_id: foreign.id },
        {} as any,
        parentContext,
      ),
    );
    expect((await getTask(created.id))?.objective_id).toBe(foreign.id);
  });

  test('create_task and update_task persist co_stages and reject invalid entries', async () => {
    await updateGroup(PROJECT_JID, {
      settings: {
        status: 'paused',
        stages: [
          ...stages,
          {
            id: 'review.o',
            title: 'Review O',
            type: 'review',
            color: '#f0f',
          },
        ] as StageDefinition[],
      },
    });
    try {
      const created = await create({
        status: 'backlog',
        co_stages: ['review.o', 'review.o'],
      });
      expect((await getTask(created.id))?.coStages).toEqual(['review.o']);

      await expect(
        update({ task_id: created.id, co_stages: ['nope.x'] }),
      ).rejects.toThrow(/Unknown co-stage/);
      // An execution claim blocks the edit at the database write.
      await expect(
        updateTask(
          created.id,
          { co_stages: [] },
          { isExecutionClaimed: () => true },
        ),
      ).rejects.toThrow(/claimed for execution/);
      expect((await getTask(created.id))?.coStages).toEqual(['review.o']);
      await update({ task_id: created.id, co_stages: null });
      expect((await getTask(created.id))?.coStages).toBeNull();
    } finally {
      await updateGroup(PROJECT_JID, {
        settings: { status: 'paused', stages },
      });
    }
  });

  test('create_task stores dependencies atomically so the queue holds the card', async () => {
    const dependency = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );
    const created = await create({
      status: 'build',
      depends_on_ids: [dependency.id],
    });
    expect(created.depends_on_ids).toEqual([dependency.id]);
    expect((await getTask(created.id))?.depends_on_ids).toEqual([
      dependency.id,
    ]);
    const held = JSON.parse(
      await getTaskTool.handler({ task_id: created.id }, {} as any, context),
    );
    expect(held.queueHoldReason).toBe(`dependencies_pending:${dependency.id}`);
  });

  test('create_task without depends_on_ids returns an empty list', async () => {
    const created = await create({ status: 'backlog' });
    expect(created.depends_on_ids).toEqual([]);
  });

  test('create_task rejects unknown and cross-project dependencies without creating a task', async () => {
    const foreign = await createTask(
      taskFixture({ project_id: 'some-other-project', status: 'backlog' }),
    );
    await expect(
      create({ status: 'backlog', depends_on_ids: ['task-0-missing'] }),
    ).rejects.toThrow('task-0-missing');
    await expect(
      create({ status: 'backlog', depends_on_ids: [foreign.id] }),
    ).rejects.toThrow();
    expect(await getTasksByProject(PROJECT)).toHaveLength(0);
  });

  test('create_task rejects a done-type initial status', async () => {
    await expect(create({ status: 'done' })).rejects.toThrow(
      'Agents cannot create tasks directly in done stage "done"; create it in an active or queue stage.',
    );
    expect(await getTasksByProject(PROJECT)).toHaveLength(0);
  });

  test('archive_task rejects a testing-stage task and keeps its worktree', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: 'testing',
        branch_name: 'task/keep-me',
      }),
    );
    await expect(
      archiveTaskTool.handler({ task_id: task.id }, {} as any, context),
    ).rejects.toThrow(/Testing-stage tasks are read-only for agents/);
    const after = await getTask(task.id);
    expect(after?.archived).toBeFalsy();
    expect(after?.branch_name).toBe('task/keep-me');
  });

  test('update_task rejects self and circular dependencies', async () => {
    const a = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );
    const b = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );
    await expect(
      update({ task_id: a.id, depends_on_ids: [a.id] }),
    ).rejects.toThrow('A task cannot depend on itself');
    await update({ task_id: a.id, depends_on_ids: [b.id] });
    await expect(
      update({ task_id: b.id, status: 'build', depends_on_ids: [a.id] }),
    ).rejects.toThrow('Circular dependency detected');
    expect((await getTask(b.id))?.status).toBe('backlog');
    expect((await getTask(b.id))?.depends_on_ids ?? []).toEqual([]);
  });

  test('update_task rejects description edit on a running task', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: 'build',
        description: 'orig',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: `run-${task.id}`,
        task_id: task.id,
        group_folder: PROJECT,
        stage: 'build',
      }),
    );
    await expect(
      update({ task_id: task.id, description: 'changed' }),
    ).rejects.toThrow(
      `Cannot update description of task ${task.id} — it is currently being executed by an agent. Create a follow-up task instead.`,
    );
    expect((await getTask(task.id))?.description).toBe('orig');
  });

  test('update_task clears completed_at when moving out of a done stage', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: 'done',
        completed_at: '2026-10-13T06:01:00.000Z',
      }),
    );
    await update({ task_id: task.id, status: 'backlog' });
    const after = await getTask(task.id);
    expect(after?.status).toBe('backlog');
    expect(after?.completed_at).toBeFalsy();
  });

  describe('adding a dependency to a started task', () => {
    // The launch guard only applies to projects that use task branches.
    beforeAll(async () => {
      await updateGroup(PROJECT_JID, {
        settings: { status: 'paused', stages, taskCheckoutMode: 'worktree' },
      });
    });
    afterAll(async () => {
      await updateGroup(PROJECT_JID, {
        settings: { status: 'paused', stages },
      });
    });

    const DEP_COMMIT = 'd'.repeat(40);
    const HEAD_COMMIT = 'a'.repeat(40);
    const BRANCH = 'task/started-work';

    async function updateWithBranchGit(
      contained: boolean,
      started = true,
      dependencyStatus = 'done',
    ) {
      const dependency = await createTask(
        taskFixture({
          project_id: PROJECT,
          title: 'Paged KV base',
          status: dependencyStatus,
          custom_values: { completed_commit_sha: DEP_COMMIT },
        }),
      );
      const task = await createTask(
        taskFixture({
          project_id: PROJECT,
          status: 'backlog',
          ...(started ? { branch_name: BRANCH } : {}),
        }),
      );
      // Replace the whole module: other test files stub it process-wide with a
      // client factory that cannot be spied on.
      const mcpClientPath = '../../lib/mcp-client.js';
      const previousMcpClient = { ...(await import(mcpClientPath)) };
      mock.module(mcpClientPath, () => ({
        ...previousMcpClient,
        getSandboxClient: () => ({
          sandboxGit: async (_stack: string, command: string) => {
            if (command === `rev-parse --verify ${DEP_COMMIT}^{commit}`)
              return { stdout: DEP_COMMIT, isError: false };
            if (command === `rev-parse --verify ${BRANCH}^{commit}`)
              return { stdout: HEAD_COMMIT, isError: false };
            if (command === `rev-list --count ${HEAD_COMMIT}..${DEP_COMMIT}`)
              return { stdout: contained ? '0\n' : '2\n', isError: false };
            return { stdout: '', isError: true };
          },
        }),
      }));
      try {
        const result = await update({
          task_id: task.id,
          depends_on_ids: [dependency.id],
        });
        return { result, dependency, task };
      } finally {
        mock.module(mcpClientPath, () => previousMcpClient);
      }
    }

    test('update_task returns a warning and posts a notice when the branch lacks the dependency commit', async () => {
      const { result, dependency, task } = await updateWithBranchGit(false);

      expect(result.message).toBe('Task updated');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(`Dependency ${dependency.id}`);
      expect(result.warnings[0]).toContain('"Paged KV base"');
      expect(result.warnings[0]).toContain('Start over');
      expect((await getTask(task.id))?.depends_on_ids).toEqual([dependency.id]);
      const notices = readTaskMessages(PROJECT, task.id).filter(
        (message) => message.entry_type === 'system_notice',
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]!.content).toContain(result.warnings[0]);
    });

    test('update_task warns for an unfinished dependency when the task branch already exists', async () => {
      const { result, dependency } = await updateWithBranchGit(
        false,
        true,
        'build',
      );

      expect(result.message).toBe('Task updated');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(`Dependency ${dependency.id}`);
      expect(result.warnings[0]).toContain('not finished');
      expect(result.warnings[0]).toContain('Start over');
    });

    test('update_task keeps its plain result when the commit is contained or the task has not started', async () => {
      expect((await updateWithBranchGit(true)).result).toBe('Task updated');
      const notStarted = await updateWithBranchGit(false, false);
      expect(notStarted.result).toBe('Task updated');
      expect(readTaskMessages(PROJECT, notStarted.task.id)).toEqual([]);
    });
  });

  test('update_task rejects newly added unknown IDs but tolerates existing ones', async () => {
    const orphan = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: 'backlog',
        depends_on_ids: ['task-0-gone'],
      }),
    );
    const other = await createTask(
      taskFixture({ project_id: PROJECT, status: 'backlog' }),
    );
    await expect(
      update({
        task_id: orphan.id,
        depends_on_ids: ['task-0-gone', 'task-0-new'],
      }),
    ).rejects.toThrow('task-0-new');
    await update({
      task_id: orphan.id,
      depends_on_ids: ['task-0-gone', other.id],
    });
    expect((await getTask(orphan.id))?.depends_on_ids).toEqual([
      'task-0-gone',
      other.id,
    ]);
  });
});

describe('task_question for a card parked in the fallback stage', () => {
  const fallbackStages: StageDefinition[] = [
    { id: 'ideas', title: 'Ideas', type: 'queue', color: '#999' },
    ...stages.filter((stage) => stage.id !== 'question'),
  ];
  const noQuestionGroup = {
    id: PROJECT,
    jid: PROJECT_JID,
    name: 'Task tool test',
    folder: PROJECT,
    trigger: '',
    added_at: new Date().toISOString(),
    settings: { status: 'paused', stages: fallbackStages },
  } as any;
  const context = {
    group_folder: PROJECT,
    permissions: { [PROJECT]: ['tasks:read', 'tasks:write'] },
  };
  let published: Array<Record<string, any>> = [];
  let publish: ReturnType<typeof spyOn>;
  beforeEach(() => {
    published = [];
    publish = spyOn(brainClient, 'publishEventWithResult').mockImplementation(((
      _url: string,
      event: Record<string, any>,
    ) => {
      published.push(event);
      return Promise.resolve({ outcome: 'queued' });
    }) as any);
  });
  afterEach(() => publish.mockRestore());
  const holdTypes = async (taskId: string) =>
    (
      await drizzleDbRef.current
        .select()
        .from(objectiveTaskEventHolds)
        .where(eq(objectiveTaskEventHolds.task_id, taskId))
    ).map((hold) => hold.event_type);
  const taggedTask = async (status: string) => {
    const objective = await createObjective({
      project_id: PROJECT,
      title: 'Objective',
      description: '',
      status: 'active',
      priority: 0,
      progress: 0,
      deadline: null,
      metadata: null,
      trigger_config: null,
    });
    return createTask(
      taskFixture({ project_id: PROJECT, status, objective_id: objective.id }),
    );
  };
  const move = (taskId: string, status: string, ownRun: boolean) =>
    updateTaskTool.handler({ task_id: taskId, status }, {} as any, {
      ...context,
      ...(ownRun ? { task_id: taskId } : {}),
    });

  beforeAll(async () => {
    await updateGroup(PROJECT_JID, {
      settings: { status: 'paused', stages: fallbackStages },
    });
    setGroupResolver((id) => (id === PROJECT ? noQuestionGroup : undefined));
  });
  afterAll(async () => {
    setGroupResolver(() => undefined);
    await updateGroup(PROJECT_JID, { settings: { status: 'paused', stages } });
  });

  test('publishes only for the own run leaving an executable stage', async () => {
    const own = await taggedTask('build');
    await move(own.id, 'backlog', true);
    expect(await holdTypes(own.id)).toEqual(['task_question']);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'task_question',
      task_id: own.id,
      data: { status: 'backlog', source: 'agent_update' },
    });

    const other = await taggedTask('build');
    await move(other.id, 'backlog', false);
    expect(await holdTypes(other.id)).toEqual([]);

    const queued = await taggedTask('ideas');
    await move(queued.id, 'backlog', true);
    expect(await holdTypes(queued.id)).toEqual([]);

    // A card already in the fallback stage publishes nothing when updated again.
    await move(own.id, 'backlog', true);
    expect(await holdTypes(own.id)).toEqual(['task_question']);
    expect(published).toHaveLength(1);
  });

  test('publishes nothing when the project has a Question stage', async () => {
    await updateGroup(PROJECT_JID, { settings: { status: 'paused', stages } });
    try {
      const task = await taggedTask('build');
      await move(task.id, 'backlog', true);
      expect(await holdTypes(task.id)).toEqual([]);
    } finally {
      await updateGroup(PROJECT_JID, {
        settings: { status: 'paused', stages: fallbackStages },
      });
    }
  });

  test('an own-run move into a fallback that is a Failed stage publishes only task_failed', async () => {
    const failedStages: StageDefinition[] = [
      { id: 'failed', title: 'Failed', type: 'queue', color: '#f00' },
      { id: 'build', title: 'Build', type: 'active', color: '#00f' },
      { id: 'done', title: 'Done', type: 'done', color: '#0f0' },
    ];
    await updateGroup(PROJECT_JID, {
      settings: { status: 'paused', stages: failedStages },
    });
    noQuestionGroup.settings.stages = failedStages;
    try {
      const task = await taggedTask('build');
      await move(task.id, 'failed', true);
      expect(await holdTypes(task.id)).toEqual(['task_failed']);
      expect(published.map((event) => event.type)).toEqual(['task_failed']);
    } finally {
      noQuestionGroup.settings.stages = fallbackStages;
      await updateGroup(PROJECT_JID, {
        settings: { status: 'paused', stages: fallbackStages },
      });
    }
  });

  test('a claimed card finalizes the event through its persisted handoff only for its own run', async () => {
    const handoffFor = async (ownRun: boolean) => {
      const task = await taggedTask('build');
      const run = runFixture({
        task_id: task.id,
        group_folder: PROJECT,
        stage: 'build',
      });
      await insertActiveRun(run);
      const claim = claimTaskExecution(task.id, PROJECT);
      expect(claim).not.toBeNull();
      const before = published.length;
      await move(task.id, 'backlog', ownRun);
      releaseTaskExecutionClaim(task.id, claim!);
      // The move is deferred to finalization: nothing is published yet.
      expect((await getTask(task.id))?.status).toBe('build');
      expect(published).toHaveLength(before);
      // Recovery reads the handoff back from the transcript after a restart.
      await completeActiveRun(run.id, 'completed');
      const pending = await getPendingTaskStageHandoff(task, 'build');
      expect(pending?.toStage).toBe('backlog');
      await updateTask(task.id, { status: 'backlog' });
      await finalizeTaskStageHandoff(task, pending!, run.id);
      return { task, pending };
    };

    const own = await handoffFor(true);
    expect(own.pending?.ownRunFallbackQuestion).toBe(true);
    expect(await holdTypes(own.task.id)).toEqual(['task_question']);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'task_question',
      task_id: own.task.id,
      data: { status: 'backlog', source: 'agent_update' },
    });

    // A handoff requested by another caller, or a record without the field,
    // publishes nothing.
    const other = await handoffFor(false);
    expect(other.pending?.ownRunFallbackQuestion).toBeUndefined();
    expect(await holdTypes(other.task.id)).toEqual([]);
    expect(published).toHaveLength(1);
  });
});

describe('get_task result extraction', () => {
  test('filters structural entries, prefers the final assistant, and truncates', () => {
    const long = 'x'.repeat(4_001);
    const results = resultsByRun([
      message({ entry_type: 'run_start', run_id: 'one' }),
      message({ entry_type: 'stage_prompt_delivery', content: 'not a result' }),
      message({ role: 'assistant', content: 'first' }),
      message({ role: 'assistant', content: long }),
      message({ entry_type: 'run_start', run_id: 'two' }),
      message({ entry_type: 'testing_feedback', content: 'Tests failed' }),
      message({ entry_type: 'run_start' }),
      message({ role: 'assistant', content: 'unsafe legacy result' }),
    ]);
    expect(results.get('one')).toEqual({
      content: 'x'.repeat(4_000),
      truncated: true,
    });
    expect(results.get('two')).toEqual({
      content: 'Tests failed',
      truncated: false,
    });
    expect(results.has('unsafe legacy result')).toBe(false);
  });

  test('does not let a trailing deploy log replace the review verdict', () => {
    const results = resultsByRun([
      message({ entry_type: 'run_start', run_id: 'review' }),
      message({ role: 'assistant', content: 'Review: approved' }),
      message({
        role: 'system',
        entry_type: 'system_notice',
        agent_name: 'deploy',
        content: '**Deploy x:** FAILED\n\nerror log',
      }),
    ]);
    expect(results.get('review')).toEqual({
      content: 'Review: approved',
      truncated: false,
    });
  });

  test('surfaces an assistant run_result written from a JSON-only testing verdict', () => {
    const results = resultsByRun([
      message({ entry_type: 'run_start', run_id: 'testing' }),
      message({
        role: 'assistant',
        entry_type: 'run_result',
        run_id: 'testing',
        content: '**Testing passed**\n\nAll checks green.',
      }),
      message({ entry_type: 'system_notice', content: '**Testing passed**' }),
    ]);
    expect(results.get('testing')).toEqual({
      content: '**Testing passed**\n\nAll checks green.',
      truncated: false,
    });
  });

  test('uses only an undelivered prompt, then falls back to latest run result', () => {
    const runs = enrichRecentRuns(
      [runFixture({ id: 'latest', stage: 'in_progress' })],
      [
        message({ entry_type: 'run_start', run_id: 'latest' }),
        message({ role: 'assistant', content: 'Need a decision' }),
      ],
    );
    const promptMessages = [
      message({
        id: 'old',
        entry_type: 'stage_prompt',
        target_stage: 'in_progress',
        content: 'Already answered',
      }),
      message({ entry_type: 'stage_prompt_delivery', prompt_id: 'old' }),
      message({
        id: 'new',
        entry_type: 'stage_prompt',
        target_stage: 'review',
        content: 'Choose an option',
      }),
    ];
    expect(findBlockingContext(promptMessages, runs)).toMatchObject({
      source: 'stagePrompt',
      content: 'Choose an option',
      targetStage: 'review',
      promptId: 'new',
    });
    expect(findBlockingContext(promptMessages.slice(0, 2), runs)).toMatchObject(
      {
        source: 'latestRunResult',
        content: 'Need a decision',
        targetStage: 'in_progress',
      },
    );
  });

  test('recognizes current and legacy persisted rejection formats', () => {
    const current = findLatestReviewRejection([
      message({ entry_type: 'run_start', run_id: 'current-run' }),
      message({
        entry_type: 'review_feedback',
        content:
          '**Review rejected** (score: 3/10, rejection 2)\n\nCurrent feedback',
        created_at: '2026-08-08T10:01:00.000Z',
      }),
    ]);
    const legacyCompact = findLatestReviewRejection(
      [
        message({ entry_type: 'run_start', run_id: 'legacy-compact-run' }),
        message({
          role: 'assistant',
          content:
            'Review completed.\n\n**Review rejected** (score: 4/10, rejection 1)\n\nLegacy compact feedback',
          created_at: '2026-08-08T10:00:30.000Z',
        }),
      ],
      new Set(['legacy-compact-run']),
    );
    const legacy = findLatestReviewRejection(
      [
        message({ entry_type: 'run_start', run_id: 'legacy-run' }),
        message({
          role: 'assistant',
          content:
            '```json\n{"decision":"reject","score":2,"issues":["Legacy defect"],"summary":"Legacy feedback"}\n```',
          created_at: '2026-08-08T10:00:00.000Z',
        }),
      ],
      new Set(['legacy-run']),
    );

    expect(current).toMatchObject({
      source: 'reviewFeedback',
      runId: 'current-run',
    });
    expect(legacyCompact).toMatchObject({
      source: 'reviewFeedback',
      runId: 'legacy-compact-run',
      content: expect.stringContaining('Legacy compact feedback'),
    });
    expect(legacy).toMatchObject({
      source: 'reviewDecision',
      runId: 'legacy-run',
    });
  });

  test('finds a legacy rejection whose decision key is JSON-escaped', () => {
    const rejection = findLatestReviewRejection(
      [
        message({ entry_type: 'run_start', run_id: 'escaped-run' }),
        message({
          role: 'assistant',
          content:
            '{"dec\\u0069sion":"reject","score":2,"issues":["Escaped defect"],"summary":"Escaped feedback"}',
          created_at: '2026-08-08T10:00:00.000Z',
        }),
      ],
      new Set(['escaped-run']),
    );

    expect(rejection).toMatchObject({
      source: 'reviewDecision',
      runId: 'escaped-run',
    });
  });

  test('bounds historical blocking and rejection content to 4,000 characters', () => {
    const blocking = findLatestBlockingReason(
      [
        message({
          entry_type: 'stage_prompt',
          content: 'b'.repeat(4_001),
        }),
      ],
      [],
    );
    const rejection = findLatestReviewRejection([
      message({
        entry_type: 'review_feedback',
        content: `**Review rejected** (score: 2/10)\n\n${'r'.repeat(4_001)}`,
      }),
    ]);

    expect(blocking).toMatchObject({
      content: 'b'.repeat(4_000),
      truncated: true,
    });
    expect(rejection?.content).toHaveLength(4_000);
    expect(rejection?.truncated).toBe(true);
  });
});

describe('task not found suggestions', () => {
  const wrongTimestamp = (id: string) =>
    id.replace(/^task-\d+-/, 'task-1000000000000-');

  test('suggests readable tasks sharing the ID suffix, never acts on them', async () => {
    const mine = await createTask(
      taskFixture({ project_id: PROJECT, title: 'Real one' }),
    );
    const hidden = await createTask(
      taskFixture({ project_id: 'other-project', title: 'Hidden one' }),
    );
    const ctx = {
      group_folder: PROJECT,
      permissions: { [PROJECT]: ['tasks:read', 'tasks:write'] },
    };
    const wrongId = wrongTimestamp(mine.id);

    await expect(
      getTaskTool.handler({ task_id: wrongId }, {} as any, ctx),
    ).rejects.toThrow(
      `Task not found: ${wrongId}. Did you mean: ${mine.id} (${PROJECT}, "Real one")?`,
    );
    // Candidate in a project without tasks:read is not listed.
    await expect(
      getTaskTool.handler(
        { task_id: wrongTimestamp(hidden.id) },
        {} as any,
        ctx,
      ),
    ).rejects.toThrow(/^Task not found$/);
    // Unknown suffix.
    await expect(
      getTaskTool.handler(
        { task_id: 'task-1000000000000-zzzzzz' },
        {} as any,
        ctx,
      ),
    ).rejects.toThrow(/^Task not found$/);

    // Mutating tools surface the hint and never touch the candidate.
    await expect(
      updateTaskTool.handler({ task_id: wrongId, title: 'x' }, {} as any, ctx),
    ).rejects.toThrow(mine.id);
    await expect(
      archiveTaskTool.handler({ task_id: wrongId }, {} as any, ctx),
    ).rejects.toThrow(mine.id);
    await expect(
      updateValuesTool.handler(
        { task_id: wrongId, values: { a: 1 } },
        {} as any,
        ctx,
      ),
    ).rejects.toThrow(mine.id);
    const after = await getTask(mine.id);
    expect(after?.title).toBe('Real one');
    expect(after?.archived).toBeFalsy();
  });
});

describe('update_values pipeline-owned keys', () => {
  const runCtx = (task_id: string) => ({
    group_folder: PROJECT,
    task_id,
    permissions: { [PROJECT]: ['tasks:read', 'tasks:write'] },
  });

  test('task-run credentials are rejected for pipeline-owned keys without a partial write', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJECT,
        status: 'testing',
        custom_values: { rejection_count: 2, summary: 'old' },
      }),
    );

    await expect(
      updateValuesTool.handler(
        {
          task_id: task.id,
          values: {
            summary: 'new',
            rejection_count: 0,
            nit_round_count: 0,
            cost_limit_usd: 9999,
            testing_failure_count: 0,
          },
        },
        {} as any,
        runCtx(task.id),
      ),
    ).rejects.toThrow(
      /rejection_count, nit_round_count, cost_limit_usd, testing_failure_count/,
    );
    expect((await getTask(task.id))?.custom_values).toEqual({
      rejection_count: 2,
      summary: 'old',
    });

    // Project-declared keys stay writable, including in the testing stage.
    await updateValuesTool.handler(
      { task_id: task.id, values: { summary: 'new' } },
      {} as any,
      runCtx(task.id),
    );
    expect((await getTask(task.id))?.custom_values).toEqual({
      rejection_count: 2,
      summary: 'new',
    });
  });

  test('credentials without a task_id can still write any key', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJECT,
        custom_values: { rejection_count: 2 },
      }),
    );

    await updateValuesTool.handler(
      { task_id: task.id, values: { rejection_count: 0, cost_limit_usd: 5 } },
      {} as any,
      {
        group_folder: PROJECT,
        permissions: { [PROJECT]: ['tasks:read', 'tasks:write'] },
      },
    );
    expect((await getTask(task.id))?.custom_values).toEqual({
      rejection_count: 0,
      cost_limit_usd: 5,
    });
  });
});

describe('list_tasks without project_id', () => {
  const MAIN = 'list-tasks-user-main';
  const PARENT = 'list-tasks-parent';
  const folders = [MAIN, PARENT];

  beforeAll(async () => {
    for (const [folder, extra] of [
      [MAIN, { is_main: true, user_id: 'user-1' }],
      [PARENT, {}],
    ] as const) {
      await registerGroup(`${folder}@test`, {
        id: folder,
        jid: `${folder}@test`,
        name: folder,
        folder,
        trigger: '',
        added_at: new Date().toISOString(),
        settings: { status: 'paused', stages },
        ...extra,
      } as any);
    }
  });
  afterAll(async () => {
    for (const folder of folders) await unregisterGroup(`${folder}@test`);
  });

  async function seed(project: string, title: string, status = 'backlog') {
    return createTask(taskFixture({ project_id: project, title, status }));
  }
  async function list(
    group_folder: string,
    permissions: Record<string, string[]>,
    args: Record<string, unknown> = {},
  ): Promise<string[]> {
    const out = await listTasksTool.handler(
      { limit: 50, include_archived: false, ...args },
      {} as any,
      { group_folder, permissions } as any,
    );
    return (JSON.parse(out as string) as { title: string }[])
      .map((t) => t.title)
      .sort();
  }

  test('per-user main lists own and granted projects, never a foreign one', async () => {
    await seed(MAIN, 'own');
    await seed('shared-a', 'a');
    await seed('foreign-c', 'c');
    const perms = {
      [MAIN]: ['tasks:*'],
      'shared-a': ['tasks:read'],
      'no-read-b': ['groups:read'],
    };
    expect(await list(MAIN, perms)).toEqual(['a', 'own']);
  });

  test('non-main parent with child grants lists only its own folder', async () => {
    await seed(PARENT, 'parent');
    await seed('child-a', 'child');
    const perms = { [PARENT]: ['tasks:*'], 'child-a': ['tasks:*'] };
    expect(await list(PARENT, perms)).toEqual(['parent']);
  });

  test("legacy '*' main still lists all projects", async () => {
    await seed(MAIN, 'own');
    await seed('other-x', 'x');
    expect(await list(MAIN, { '*': ['*:*'] })).toEqual(['own', 'x']);
  });

  test('stage and limit filters apply after the union', async () => {
    await seed(MAIN, 'own-build', 'build');
    await seed(MAIN, 'own-backlog');
    await seed('shared-a', 'a-build', 'build');
    await seed('shared-a', 'a-backlog');
    const perms = { [MAIN]: ['tasks:*'], 'shared-a': ['tasks:read'] };
    expect(await list(MAIN, perms, { stage: 'build' })).toEqual([
      'a-build',
      'own-build',
    ]);
    expect(await list(MAIN, perms, { limit: 3 })).toHaveLength(3);
  });
});
