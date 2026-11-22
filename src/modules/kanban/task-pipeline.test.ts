import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
  spyOn,
} from 'bun:test';
import type { ModelTier, RoutingDecision } from '../../lib/model-router.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR, MAX_REVIEW_REJECTIONS_CAP } from '../../config.js';
import * as idleRestart from '../../sandbox/idle-restart.js';
import * as wsEvents from '../objectives/ws-events.js';

import type { RegisteredGroup } from '../../types.js';
import type { Task } from './types.js';
import {
  initDatabase,
  insertActiveRun,
  completeActiveRun,
  getActiveRunById,
  createDatasetTask,
  createObjective,
  updateObjective,
  createDatasetRowTask,
  createTask,
  deleteTask,
  getTask,
  getDatasetTask,
  getTasksByProject,
  getTasksByProjectForQueue,
  incrementDatasetTaskProgress,
  updateDatasetTask,
  updateTask,
  insertAiUserRow,
  deleteAiUserRow,
  createUser,
  getUnreadPayloads,
  upsertProjectMember,
  persistTaskSessionForActiveRun,
} from '../../db.js';
import { writeAiUserPrompt } from '../ai-users/storage.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';

import {
  isTaskRunning,
  getRunningTaskIds,
  getQueuedTaskIds,
  getWaitingTaskIds,
  scheduleTransientTaskRetry,
  finishOwnedTaskExecution,
  retireOwnedTaskExecutionPresentation,
  beginSuccessfulTaskFinalization,
  endSuccessfulTaskFinalization,
  cancelQueuedProjectTasks,
  setGroupResolver,
  stopTask,
  isRetryableTaskError,
} from './task-executor.js';
import {
  MAX_TRANSIENT_ATTEMPTS,
  TRANSIENT_RETRIES_KEY,
  planTransientRetry,
} from './task/pipeline.js';

import {
  _testOnlyRegisterRunning,
  _testOnlySetProjectFailureState,
  resetProjectFailures,
  _testOnlyRegisterQueued,
  _testOnlyHandlePreflightFailure,
  _testOnlyIsRetryPending,
  _testOnlyGetRetryReservedCount,
  _testOnlyTryClaimTaskExecution,
  _testOnlyReleaseTaskExecutionClaim,
  _testOnlyFinalizeOwnedActiveRun,
  _testOnlyRunPostExecutionCleanup,
  _testOnlyRunSerializedProjectDrain,
  shouldAdvanceDatasetProgress,
  resumeActiveDatasetTasks,
  _testOnlyCanAutoStartTaskForObjectives,
  spawnNextDatasetRow,
  getPendingStagePrompts,
  getPendingTaskDeliveryPrompts,
  splitFollowUpsFromHistory,
  omitTestingVerdicts,
  recordTaskStreamChunk,
  appendTaskSteeringMessage,
  appendTaskStagePrompt,
  closeTaskSteeringAdmissionWindow,
  findRunRecording,
  registerRecoveredTaskAbort,
  unregisterRecoveredTaskAbort,
  requestTaskStageHandoff,
  scheduleStageHandoffControl,
  interceptAutoDeployExecution,
  executeTask,
  taskSandboxGitRunner,
  prepareTaskBranchForReview,
  readTaskGitContentIdentity,
  RESTART_RECOVERY_PROMPT,
  resolveStagePersonaPrompt,
  formatFoldedHistory,
  // drainProjectQueue is imported from the implementation module, not the
  // task-executor barrel: archive-task.test.ts registers a top-level
  // mock.module on the barrel (sanctioned via isolated_test_files in
  // scripts/test-ci.sh), which leaks into any shared single-process runner
  // and would replace this binding with a no-op mock.
  drainProjectQueue,
} from './task/pipeline.js';
import { updateTaskTool } from './tools.js';
import {
  buildOutput,
  waitForRun,
  type ContainerInput,
  type ContainerOutput,
} from '../../sandbox/process.js';
import {
  persistentVariantTag,
  prepareCanonicalRunCompletion,
} from '../../sandbox/process.js';
import { validatedInstance } from '../../lib/git-ops.js';
import {
  reloadChatAgents,
  resolveKanbanRuntimeSelection,
  runtimeSessionKey,
} from '../../lib/chat-agents.js';
import { TESTING_HEAD_SHA_KEY, TESTING_TREE_SHA_KEY } from './task/testing.js';
import { getGroupHomeDir } from '../../prompt-loader.js';
import {
  appendTaskMessageAsync,
  readTaskMessages,
  withTaskSteeringDeliveryState,
} from '../transcripts/transcript-store.js';

describe('transient error retry budget', () => {
  useCleanPipelineTestDatabase();

  test('fails after the retry cap and resets the budget after a clean run', async () => {
    const projectId = 'transient-retry-e2e';
    const group: RegisteredGroup = {
      name: 'Transient retry e2e',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        taskCheckoutMode: 'worktree',
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const runWith = async (outcome: () => ContainerOutput, id: string) =>
      executeTask((await getTask(id))!, group, {
        testDependencies: {
          runContainerAgent: async (_group, input) => {
            await input.onSlotAcquired?.('transient-run');
            return outcome();
          },
          runPostExecutionGitOps: async () => {},
          mergeBranchForDeploy: async () => true,
          drainProjectQueue: async () => {},
        },
      });
    // Retry delays (>= 2 min) must not leave real timers behind.
    const realSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number,
      ...args: unknown[]
    ) =>
      (ms ?? 0) >= 60_000
        ? { unref() {} }
        : realSetTimeout(
            callback,
            ms,
            ...args,
          )) as unknown as typeof setTimeout);
    try {
      const failing = await createTask({
        project_id: projectId,
        title: 'Always rate limited',
        description: '',
        status: 'implementation',
        priority: 0,
      });
      for (let run = 1; run <= MAX_TRANSIENT_ATTEMPTS; run++) {
        const before = await getTask(failing.id);
        expect(before?.status).toBe('implementation');
        await runWith(
          () => ({
            status: 'error',
            result: null,
            error: 'rate limit exceeded',
          }),
          failing.id,
        );
        if (run < MAX_TRANSIENT_ATTEMPTS) {
          const after = await getTask(failing.id);
          expect(after?.status).toBe('implementation');
          expect(after?.error).toContain('Retry scheduled');
          expect(after?.custom_values?.[TRANSIENT_RETRIES_KEY]).toBe(run);
        }
      }
      const exhausted = await getTask(failing.id);
      expect(exhausted?.status).toBe('failed');
      expect(exhausted?.error).toContain('retries exhausted after 5 attempts');
      expect(exhausted?.custom_values?.[TRANSIENT_RETRIES_KEY]).toBeUndefined();

      const recovering = await createTask({
        project_id: projectId,
        title: 'Single 529',
        description: '',
        status: 'implementation',
        priority: 0,
      });
      await runWith(
        () => ({
          status: 'error',
          result: null,
          error: 'API Error: 529 {"type":"overloaded_error"}',
        }),
        recovering.id,
      );
      expect(
        (await getTask(recovering.id))?.custom_values?.[TRANSIENT_RETRIES_KEY],
      ).toBe(1);
      await runWith(
        () => ({ status: 'success', result: 'done', newSessionId: 's' }),
        recovering.id,
      );
      expect(
        (await getTask(recovering.id))?.custom_values?.[TRANSIENT_RETRIES_KEY],
      ).toBeUndefined();
    } finally {
      timer.mockRestore();
    }
  });
});

describe('run error capping and config classification', () => {
  useCleanPipelineTestDatabase();

  test('bounds an oversized harness dump and does not classify it as config, but still classifies a short 401', async () => {
    const projectId = 'run-error-capping';
    const jid = `${projectId}@web`;
    const group: RegisteredGroup = {
      jid,
      name: projectId,
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        taskCheckoutMode: 'worktree',
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    };
    const runWithError = async (error: string, id: string) =>
      executeTask((await getTask(id))!, group, {
        testDependencies: {
          runContainerAgent: async (_group, input) => {
            await input.onSlotAcquired?.('run-error-capping-run');
            return { status: 'error', result: null, error };
          },
          runPostExecutionGitOps: async () => {},
          mergeBranchForDeploy: async () => true,
          drainProjectQueue: async () => {},
        },
      });

    await loadState();
    await registerGroup(jid, group);
    // archive-task.test.ts mocks state-manager.js process-wide, so registerGroup
    // may not persist the row the stage lookup needs; keep a real one if present.
    await drizzleDbRef.current
      .insert(projects)
      .values({
        id: projectId,
        jid,
        name: projectId,
        folder: projectId,
        trigger: group.trigger,
        added_at: group.added_at,
        settings: JSON.stringify(group.settings),
      })
      .onConflictDoNothing({ target: projects.id });
    try {
      // A protocol-event dump that quotes an invalid-key incident in its body.
      const dump = `{"type":"agent_end","messages":[{"role":"user","content":"401 invalid x-api-key"}],"pad":"${'x'.repeat(1_600_000)}"}`;
      const oversized = await createTask({
        project_id: projectId,
        title: 'Oversized harness dump',
        description: '',
        status: 'implementation',
        priority: 0,
      });
      await runWithError(dump, oversized.id);
      const failed = await getTask(oversized.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.custom_values?.failure_class).toBeDefined();
      expect(failed?.custom_values?.failure_class).not.toBe('config');
      const errorRows = readTaskMessages(projectId, oversized.id).filter(
        (message) =>
          message.role === 'assistant' && message.content.startsWith('Error: '),
      );
      expect(errorRows).toHaveLength(1);
      expect(errorRows[0]!.content.length).toBeLessThanOrEqual(4200);

      const short = await createTask({
        project_id: projectId,
        title: 'Short invalid key',
        description: '',
        status: 'implementation',
        priority: 0,
      });
      await runWithError('401 invalid x-api-key', short.id);
      expect((await getTask(short.id))?.custom_values?.failure_class).toBe(
        'config',
      );
    } finally {
      await unregisterGroup(jid);
    }
  });
});

describe('restart recovery execution intent', () => {
  useCleanPipelineTestDatabase();

  test('replaces the exact interrupted run with one invisible continuation prompt', async () => {
    const projectId = 'restart-recovery-intent';
    const runtime = resolveKanbanRuntimeSelection([], 'implementation').agent;
    const agentCmd = runtime.agentCmd || runtime.id;
    const sessionAgentKey = runtimeSessionKey(runtime);
    const model = runtime.model ?? null;
    const group: RegisteredGroup = {
      name: 'Restart recovery intent',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        taskCheckoutMode: 'worktree',
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    };
    const task = await createTask({
      project_id: projectId,
      title: 'Resume after restart',
      description: 'THIS DESCRIPTION MUST NOT BE REPLAYED',
      status: 'implementation',
      priority: 0,
      session_id: 'owned-restart-session',
      last_agent_name: sessionAgentKey,
    });
    const runtimeVariant = persistentVariantTag(
      agentCmd,
      runtime.model,
      runtime.env,
    );
    const interrupted = runFixture({
      id: 'restart-interrupted-run',
      group_folder: projectId,
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      stage: 'implementation',
      session_id: 'owned-restart-session',
      agent_name: sessionAgentKey,
      session_agent_key: sessionAgentKey,
      model,
      runtime_variant: runtimeVariant,
    });
    await insertActiveRun(interrupted);
    const replacementId = 'restart-replacement-run';
    await insertActiveRun(
      runFixture({
        ...interrupted,
        id: replacementId,
        started_at: new Date(Date.now() + 1_000).toISOString(),
        restart_recovery_of_run_id: interrupted.id,
      }),
    );
    await completeActiveRun(interrupted.id, 'error');
    let capturedInput: ContainerInput | undefined;

    await executeTask(task, group, {
      restartRecovery: {
        interruptedRunId: interrupted.id,
        continuationRunId: replacementId,
        stageId: 'implementation',
        sessionId: 'owned-restart-session',
        sessionAgentKey,
        model,
        runtimeVariant,
        sandboxStack: 'carapa-bot',
        sandboxService: 'agent',
        sandboxInstance: null,
      },
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          capturedInput = input;
          await input.onActiveRunCreated?.(replacementId);
          await input.onSlotAcquired?.(replacementId);
          await input.onRunLaunched?.(replacementId);
          return {
            status: 'success',
            result: 'Recovered continuation completed',
            newSessionId: 'owned-restart-session',
          } satisfies ContainerOutput;
        },
        runPostExecutionGitOps: async () => {},
        mergeBranchForDeploy: async () => true,
        drainProjectQueue: async () => {},
      },
    });

    expect(capturedInput).toMatchObject({
      prompt: RESTART_RECOVERY_PROMPT,
      session_id: 'owned-restart-session',
      stage_id: 'implementation',
      restartRecoveryRunId: interrupted.id,
      precreatedActiveRunId: replacementId,
      session_agent_key: sessionAgentKey,
    });
    expect(capturedInput?.prompt).not.toContain(task.description);
    expect(await getActiveRunById(interrupted.id)).toMatchObject({
      status: 'error',
      stage: 'implementation',
      session_id: 'owned-restart-session',
    });
    expect(await getActiveRunById('restart-replacement-run')).toMatchObject({
      status: 'completed',
      stage: 'implementation',
      session_id: 'owned-restart-session',
      restart_recovery_dispatched_at: expect.any(String),
    });
    const messages = readTaskMessages(projectId, task.id);
    expect(
      messages.some(
        (message) =>
          message.role === 'user' &&
          message.content.includes(RESTART_RECOVERY_PROMPT),
      ),
    ).toBe(false);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'Recovered continuation completed',
        }),
      ]),
    );
    expect((await getTask(task.id))?.status).toBe('done');
  });

  test('rejects an incompatible runtime before producing a second failure artifact', async () => {
    const projectId = 'restart-recovery-runtime-drift';
    const group: RegisteredGroup = {
      name: 'Restart recovery runtime drift',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        taskCheckoutMode: 'worktree',
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    };
    const task = await createTask({
      project_id: projectId,
      title: 'Do not cross runtime ownership',
      description: 'Keep the old runtime isolated',
      status: 'implementation',
      priority: 0,
      session_id: 'codex-owned-session',
      last_agent_name: 'codex',
    });
    const interrupted = runFixture({
      id: 'restart-runtime-drift-run',
      group_folder: projectId,
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      stage: 'implementation',
      session_id: 'codex-owned-session',
      agent_name: 'codex',
      session_agent_key: 'codex',
      runtime_variant: persistentVariantTag('codex'),
    });
    await insertActiveRun(interrupted);
    let launched = false;

    await expect(
      executeTask(task, group, {
        restartRecovery: {
          interruptedRunId: interrupted.id,
          continuationRunId: interrupted.id,
          stageId: 'implementation',
          sessionId: 'codex-owned-session',
          sessionAgentKey: 'codex',
          model: null,
          runtimeVariant: persistentVariantTag('codex'),
          sandboxStack: 'carapa-bot',
          sandboxService: 'agent',
          sandboxInstance: null,
        },
        testDependencies: {
          runContainerAgent: async () => {
            launched = true;
            throw new Error('incompatible runtime launched');
          },
          drainProjectQueue: async () => {},
        },
      }),
    ).rejects.toThrow('stage/runtime');

    expect(launched).toBe(false);
    expect(await getActiveRunById(interrupted.id)).toMatchObject({
      status: 'running',
      session_id: 'codex-owned-session',
    });
    expect(await getTask(task.id)).toMatchObject({
      status: 'implementation',
      error: '',
    });
    expect(readTaskMessages(projectId, task.id)).toHaveLength(0);

    const currentRuntime = resolveKanbanRuntimeSelection(
      [],
      'implementation',
    ).agent;
    const currentAgentCmd = currentRuntime.agentCmd || currentRuntime.id;
    const currentSessionAgentKey = runtimeSessionKey(currentRuntime);
    const currentRuntimeVariant = persistentVariantTag(
      currentAgentCmd,
      currentRuntime.model,
      currentRuntime.env,
    );
    const setupFailureTask = await createTask({
      project_id: projectId,
      title: 'Keep setup failure recovery-owned',
      description: 'Do not create a duplicate failure',
      status: 'implementation',
      priority: 1,
      session_id: 'claude-owned-session',
      last_agent_name: currentSessionAgentKey,
    });
    const setupFailureRun = runFixture({
      id: 'restart-setup-failure-run',
      group_folder: projectId,
      task_id: setupFailureTask.id,
      chat_jid: `task-${setupFailureTask.id}@kanban`,
      stage: 'implementation',
      session_id: 'claude-owned-session',
      agent_name: currentSessionAgentKey,
      session_agent_key: currentSessionAgentKey,
      model: currentRuntime.model ?? null,
      runtime_variant: currentRuntimeVariant,
    });
    await insertActiveRun(setupFailureRun);

    await expect(
      executeTask(setupFailureTask, group, {
        restartRecovery: {
          interruptedRunId: setupFailureRun.id,
          continuationRunId: setupFailureRun.id,
          stageId: 'implementation',
          sessionId: 'claude-owned-session',
          sessionAgentKey: currentSessionAgentKey,
          model: currentRuntime.model ?? null,
          runtimeVariant: currentRuntimeVariant,
          sandboxStack: 'carapa-bot',
          sandboxService: 'agent',
          sandboxInstance: null,
        },
        testDependencies: {
          runContainerAgent: async () => ({
            status: 'error',
            result: null,
            error: 'sandbox unavailable before active-run creation',
          }),
          drainProjectQueue: async () => {},
        },
      }),
    ).rejects.toThrow('sandbox unavailable');

    expect(await getActiveRunById(setupFailureRun.id)).toMatchObject({
      status: 'running',
      session_id: 'claude-owned-session',
    });
    expect(await getTask(setupFailureTask.id)).toMatchObject({
      status: 'implementation',
      error: '',
    });
    expect(readTaskMessages(projectId, setupFailureTask.id)).toHaveLength(0);
  });

  test('rejects model and environment drift under the same session-agent key', async () => {
    const projectId = 'restart-recovery-variant-drift';
    const runtime = resolveKanbanRuntimeSelection([], 'implementation').agent;
    const agentCmd = runtime.agentCmd || runtime.id;
    const sessionAgentKey = runtimeSessionKey(runtime);
    const currentModel = runtime.model ?? null;
    const group: RegisteredGroup = {
      name: 'Restart recovery variant drift',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        taskCheckoutMode: 'worktree',
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    };
    let launched = false;
    for (const [name, model, runtimeVariant] of [
      ['model', 'old-model', persistentVariantTag(agentCmd, 'old-model')],
      [
        'environment',
        currentModel,
        persistentVariantTag(agentCmd, currentModel ?? undefined, {
          PROVIDER_ROUTE: 'old-route',
        }),
      ],
    ] as const) {
      const task = await createTask({
        project_id: projectId,
        title: `Reject ${name} drift`,
        description: 'Do not cross native-session ownership',
        status: 'implementation',
        priority: 0,
        session_id: `${name}-owned-session`,
        last_agent_name: sessionAgentKey,
      });
      const interrupted = runFixture({
        id: `restart-${name}-drift-run`,
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'implementation',
        session_id: `${name}-owned-session`,
        agent_name: sessionAgentKey,
        session_agent_key: sessionAgentKey,
        model,
        runtime_variant: runtimeVariant,
      });
      await insertActiveRun(interrupted);

      await expect(
        executeTask(task, group, {
          restartRecovery: {
            interruptedRunId: interrupted.id,
            continuationRunId: interrupted.id,
            stageId: 'implementation',
            sessionId: `${name}-owned-session`,
            sessionAgentKey,
            model,
            runtimeVariant,
            sandboxStack: 'carapa-bot',
            sandboxService: 'agent',
            sandboxInstance: null,
          },
          testDependencies: {
            runContainerAgent: async () => {
              launched = true;
              throw new Error('drifted runtime launched');
            },
            drainProjectQueue: async () => {},
          },
        }),
      ).rejects.toThrow('model/runtime variant');
      expect(await getActiveRunById(interrupted.id)).toMatchObject({
        status: 'running',
        model,
        runtime_variant: runtimeVariant,
      });
    }
    expect(launched).toBe(false);
  });
});

describe('task steering delivery receipts', () => {
  test('keeps queued prompts and excludes consumed prompts', () => {
    const messages = [
      {
        id: 'pre-terminal',
        role: 'user',
        content: 'arrived before terminal output',
        steering: true,
      },
      {
        id: 'run-result',
        role: 'assistant',
        content: 'done',
        entry_type: 'run_result',
      },
      {
        id: 'queued',
        role: 'user',
        content: 'please also check the edge case',
        steering: true,
      },
      {
        id: 'consumed',
        role: 'user',
        content: 'already sent to the run',
        steering: true,
      },
      {
        id: 'receipt',
        role: 'system',
        content: '',
        entry_type: 'steering_delivery',
        prompt_id: 'consumed',
        run_id: 'run-1',
      },
      {
        id: 'queued-stage',
        role: 'system',
        content: 'queued stage guidance',
        entry_type: 'stage_prompt',
        target_stage: 'testing',
      },
      {
        id: 'consumed-stage',
        role: 'system',
        content: 'consumed stage guidance',
        entry_type: 'stage_prompt',
        target_stage: 'testing',
      },
      {
        id: 'stage-receipt',
        role: 'system',
        content: '',
        entry_type: 'steering_delivery',
        prompt_id: 'consumed-stage',
        run_id: 'run-1',
      },
    ] as const;

    const split = splitFollowUpsFromHistory([...messages]);
    expect(split.newUserMessages).toEqual([messages[0], messages[2]]);
    expect(split.historyForFold).toEqual([messages[1]]);
    const projected = withTaskSteeringDeliveryState(messages as any);
    expect(projected[0]?.steeringDelivery).toBe('queued');
    expect(projected[2]?.steeringDelivery).toBe('queued');
    expect(projected[3]?.steeringDelivery).toBe('steered');
    expect(projected[5]?.steeringDelivery).toBe('queued');
    expect(projected[6]?.steeringDelivery).toBe('steered');
  });
});

describe('fresh-stage conversation folding', () => {
  test('keeps conclusions but removes stale runtime details from mixed assistant turns', () => {
    const history = formatFoldedHistory([
      {
        role: 'assistant',
        agent_name: 'tester',
        content: [
          'Browser verification passed with the required DOM markers.',
          '',
          '> **Bash** `playwright-cli -s=ui-sandbox goto http://127.0.0.1:38767/chat/ui-chat`',
          '',
          '> **Bash failed** `exit 1` · `npm run ui:sandbox`',
          '',
          'The focused tests and changed-files gate also passed.',
        ].join('\n'),
      },
    ]);

    expect(history).toContain(
      'Browser verification passed with the required DOM markers.',
    );
    expect(history).toContain(
      'The focused tests and changed-files gate also passed.',
    );
    expect(history).not.toContain('38767');
    expect(history).not.toContain('playwright-cli');
    expect(history).not.toContain('npm run ui:sandbox');
  });
});

import { runFixture, truncateTestDb } from '../../test-helpers.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { projects, users } from '../../db/schema.js';
import type { ProviderUsageAccount } from '../provider-usage/tools.js';

let _init = false;
async function resetPipelineTestDatabase() {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  await truncateTestDb();
}

function useCleanPipelineTestDatabase() {
  beforeEach(resetPipelineTestDatabase);
}

const reviewLifecycleStages = [
  { id: 'backlog', title: 'Backlog', type: 'queue' as const, color: '#888' },
  { id: 'question', title: 'Question', type: 'queue' as const, color: '#fa0' },
  { id: 'testing', title: 'Testing', type: 'testing' as const, color: '#a3f' },
  { id: 'review', title: 'Review', type: 'review' as const, color: '#f80' },
  { id: 'done', title: 'Done', type: 'done' as const, color: '#3f3' },
  { id: 'failed', title: 'Failed', type: 'queue' as const, color: '#f33' },
];

function reviewLifecycleGroup(projectId: string, status: 'running' | 'paused') {
  return {
    name: 'Review lifecycle',
    folder: projectId,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status,
      taskCheckoutMode: 'worktree' as const,
      defaultBranch: 'develop',
      stages: reviewLifecycleStages,
    },
  };
}

function fakeReviewGit(
  currentHead: () => string,
  currentTree: () => string = currentHead,
  dirty: () => boolean = () => false,
) {
  return async (_group: unknown, command: string) => {
    if (command.includes('status --porcelain')) {
      return { ok: true, output: dirty() ? ' M src/changed.ts' : '' };
    }
    if (command.includes('rev-parse HEAD HEAD^{tree}')) {
      return { ok: true, output: `${currentHead()}\n${currentTree()}` };
    }
    if (
      command.includes('rev-parse HEAD') ||
      command.includes('rev-parse --verify')
    ) {
      return { ok: true, output: `${currentHead()}\n${currentTree()}` };
    }
    if (command.includes('log -1')) {
      return { ok: true, output: `${currentHead()} prepared commit` };
    }
    if (command.includes('merge-base')) {
      return { ok: true, output: '1111111111111111111111111111111111111111' };
    }
    return { ok: true, output: '' };
  };
}

describe('Testing evidence and Review Git preparation ordering', () => {
  useCleanPipelineTestDatabase();

  test('reads branch-mode task identity from the repository root', async () => {
    const commands: string[] = [];
    const identity = await readTaskGitContentIdentity(
      {
        id: 'task-managed-identity',
        project_id: 'managed-identity',
        title: 'Managed identity',
        description: '',
        status: 'testing',
        priority: 0,
        created_at: '2026-08-26T00:00:00.000Z',
        branch_name: 'managed-identity-branch',
        worktree_path: null,
      },
      {
        ...reviewLifecycleGroup('managed-identity', 'running'),
        settings: {
          ...reviewLifecycleGroup('managed-identity', 'running').settings,
          taskCheckoutMode: 'branch',
        },
      },
      async (_group, command) => {
        commands.push(command);
        return command.includes('status --porcelain')
          ? { ok: true, output: '' }
          : {
              ok: true,
              output:
                '1111111111111111111111111111111111111111\n2222222222222222222222222222222222222222',
            };
      },
    );

    expect(identity).toEqual({
      headSha: '1111111111111111111111111111111111111111',
      treeSha: '2222222222222222222222222222222222222222',
    });
    expect(commands).toEqual([
      'rev-parse managed-identity-branch^{commit} managed-identity-branch^{tree}',
    ]);
  });

  test('reads worktree task identity from its managed worktree', async () => {
    const commands: string[] = [];
    await readTaskGitContentIdentity(
      {
        id: 'task-worktree-identity',
        project_id: 'worktree-identity',
        title: 'Worktree identity',
        description: '',
        status: 'testing',
        priority: 0,
        created_at: '2026-08-26T00:00:00.000Z',
        branch_name: 'worktree-identity-branch',
        worktree_path: '/host/repo/.worktrees/worktree-identity-branch',
      },
      reviewLifecycleGroup('worktree-identity', 'running'),
      async (_group, command) => {
        commands.push(command);
        return command.includes('status --porcelain')
          ? { ok: true, output: '' }
          : {
              ok: true,
              output:
                '1111111111111111111111111111111111111111\n2222222222222222222222222222222222222222',
            };
      },
    );

    expect(commands).toEqual([
      '-C .worktrees/worktree-identity-branch status --porcelain=v1 --untracked-files=all',
      '-C .worktrees/worktree-identity-branch rev-parse HEAD HEAD^{tree}',
    ]);
  });

  test('reads worktree identity from checkout mode when path metadata is missing', async () => {
    const commands: string[] = [];
    await readTaskGitContentIdentity(
      {
        id: 'task-recovered-worktree-identity',
        project_id: 'recovered-worktree-identity',
        title: 'Recovered worktree identity',
        description: '',
        status: 'testing',
        priority: 0,
        created_at: '2026-09-01T00:00:00.000Z',
        branch_name: 'recovered-worktree-identity-branch',
        worktree_path: null,
      },
      reviewLifecycleGroup('recovered-worktree-identity', 'running'),
      async (_group, command) => {
        commands.push(command);
        return command.includes('status --porcelain')
          ? { ok: true, output: '' }
          : {
              ok: true,
              output:
                '1111111111111111111111111111111111111111\n2222222222222222222222222222222222222222',
            };
      },
    );

    expect(commands).toEqual([
      '-C .worktrees/recovered-worktree-identity-branch status --porcelain=v1 --untracked-files=all',
      '-C .worktrees/recovered-worktree-identity-branch rev-parse HEAD HEAD^{tree}',
    ]);
  });

  test('prepares the managed worktree when path metadata is missing', async () => {
    const task = {
      id: 'task-recovered-review-worktree',
      project_id: 'recovered-review-worktree',
      title: 'Recovered review worktree',
      description: '',
      status: 'testing',
      priority: 0,
      created_at: '2026-09-01T00:00:00.000Z',
      branch_name: 'recovered-review-worktree-branch',
      worktree_path: null,
    } satisfies Task;
    const prepareCalls: Array<Record<string, unknown>> = [];

    await prepareTaskBranchForReview(
      task,
      reviewLifecycleGroup('recovered-review-worktree', 'running'),
      {
        checkpointTaskBranch: async () => true,
        needsReviewPreparation: async () => true,
        prepareReview: async (_stack, options) => {
          prepareCalls.push(options);
          return { stdout: '', isError: false };
        },
      },
    );

    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]).toMatchObject({
      branch: 'recovered-review-worktree-branch',
      worktree_path: '.worktrees/recovered-review-worktree-branch',
    });
  });

  test('checkpoints a shared checkout before Testing binds Git identity', async () => {
    const task = {
      id: 'task-shared-checkout',
      project_id: 'shared-checkout',
      title: 'Shared checkout task',
      description: '',
      status: 'testing',
      priority: 0,
      created_at: '2026-08-27T00:00:00.000Z',
      branch_name: null,
      worktree_path: null,
      sandbox_instance: 'shared-checkout-instance',
    } satisfies Task;
    const group = {
      ...reviewLifecycleGroup('shared-checkout', 'running'),
      settings: {
        ...reviewLifecycleGroup('shared-checkout', 'running').settings,
        taskCheckoutMode: 'shared' as const,
      },
    };
    const calls: Array<{
      commitMessage: string;
      instance: string | null | undefined;
    }> = [];

    await prepareTaskBranchForReview(task, group, {
      checkpointDefaultCheckout: async (_group, commitMessage, instance) => {
        calls.push({ commitMessage, instance });
        return { ok: true, output: 'committed', noChanges: false };
      },
    });

    expect(calls).toEqual([
      {
        commitMessage: 'feat: Shared checkout task',
        instance: 'shared-checkout-instance',
      },
    ]);
  });

  test('rejects Testing preparation when a shared checkout cannot be checkpointed', async () => {
    const task = {
      id: 'task-shared-checkout-failure',
      project_id: 'shared-checkout-failure',
      title: 'Shared checkout failure',
      description: '',
      status: 'testing',
      priority: 0,
      created_at: '2026-08-27T00:00:00.000Z',
      branch_name: null,
      worktree_path: null,
    } satisfies Task;
    const group = {
      ...reviewLifecycleGroup('shared-checkout-failure', 'running'),
      settings: {
        ...reviewLifecycleGroup('shared-checkout-failure', 'running').settings,
        taskCheckoutMode: 'shared' as const,
      },
    };

    await expect(
      prepareTaskBranchForReview(task, group, {
        checkpointDefaultCheckout: async () => ({
          ok: false,
          output: 'commit failed',
          noChanges: false,
        }),
      }),
    ).rejects.toThrow(
      'Unable to checkpoint shared checkout before review: commit failed',
    );
  });

  test('keeps Testing active when cleanup changes the HEAD after validation', async () => {
    const projectId = 'review-preparation-changed-after-testing';
    const originalHead = '2222222222222222222222222222222222222222';
    const inspectedHead = '3333333333333333333333333333333333333333';
    const observationHead = '4444444444444444444444444444444444444444';
    const finalReviewHead = '5555555555555555555555555555555555555555';
    let currentHead = originalHead;
    let testingWorkerFinished = false;
    let testingCleanupCalls = 0;
    let testingAgentCalls = 0;
    let reviewStarted = false;
    const preparationStages: string[] = [];
    const task = await createTask({
      project_id: projectId,
      title: 'Retest changed prepared state',
      description: '',
      status: 'testing',
      priority: 0,
      branch_name: 'retest-changed-prepared-state',
      worktree_path: '/repo/.worktrees/retest-changed-prepared-state',
      custom_values: {
        [TESTING_HEAD_SHA_KEY]: originalHead,
        owner: 'alice',
      },
    });
    const group = reviewLifecycleGroup(projectId, 'running');

    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async (
          preparedTask: typeof task,
          preparedGroup: RegisteredGroup,
        ) => {
          preparationStages.push((await getTask(task.id))?.status ?? 'missing');
          await prepareTaskBranchForReview(preparedTask, preparedGroup, {
            checkpointTaskBranch: async () => true,
            needsReviewPreparation: async () =>
              currentHead === originalHead || currentHead === observationHead,
            prepareReview: async () => {
              currentHead =
                currentHead === originalHead ? inspectedHead : finalReviewHead;
              return { stdout: 'prepared', isError: false };
            },
          });
        },
        readTaskGitContentIdentity,
        runGitInRepo: fakeReviewGit(() => currentHead),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        afterSuccessfulAgentRun: async () => {
          testingWorkerFinished = true;
        },
        runPostExecutionGitOps: async (completedTask: typeof task) => {
          if (completedTask.status !== 'testing') return;
          testingCleanupCalls++;
          expect(testingWorkerFinished).toBe(true);
          currentHead = observationHead;
        },
        drainProjectQueue: async () => {
          if ((await getTask(task.id))?.status === 'review')
            reviewStarted = true;
        },
        runContainerAgent: async (_group: unknown, input: ContainerInput) => {
          testingAgentCalls++;
          await input.onCheckoutReady?.(input);
          expect(input.env?.CARAPA_VERIFY_BASE_SHA).toBe(
            '1111111111111111111111111111111111111111',
          );
          await input.onSlotAcquired?.(`${input.stage_id}-run`);
          if (testingAgentCalls === 1) {
            return {
              status: 'success',
              result: 'verdict missing its JSON envelope',
              newSessionId: 'testing-session',
            } satisfies ContainerOutput;
          }
          expect(input.stage_id).toBe('testing:format-repair-1');
          expect(input.activeRunStageId).toBe('testing');
          return {
            status: 'success',
            result:
              '{"decision":"pass","issues":[],"summary":"inspected state passed"}',
            newSessionId: 'testing-session',
          } satisfies ContainerOutput;
        },
      },
    });

    const updated = await getTask(task.id);
    expect(updated?.status).toBe('testing');
    expect(updated?.custom_values).toEqual({
      owner: 'alice',
      testing_chain: '',
    });
    expect(currentHead).toBe(finalReviewHead);
    expect(reviewStarted).toBe(false);
    expect(testingCleanupCalls).toBe(1);
    expect(testingAgentCalls).toBe(2);
    expect(preparationStages).toEqual(['testing', 'testing']);
    const retryNotice = readTaskMessages(projectId, task.id).at(-1)?.content;
    expect(retryNotice).toContain('tracked content changed after validation');
    expect(retryNotice).not.toContain(inspectedHead);
    expect(retryNotice).not.toContain(finalReviewHead);
  });
  test('surfaces tester tool activity while hiding the structured verdict', async () => {
    const projectId = 'testing-tool-activity-transcript';
    const task = await createTask({
      project_id: projectId,
      title: 'Keep tester tool activity visible',
      description: '',
      status: 'testing',
      priority: 0,
      branch_name: 'testing-tool-activity-transcript',
      worktree_path: '/repo/.worktrees/testing-tool-activity-transcript',
    });
    const group = reviewLifecycleGroup(projectId, 'paused');

    let calls = 0;
    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async () => {},
        runGitInRepo: fakeReviewGit(
          () => '1111111111111111111111111111111111111111',
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input, onChunk) => {
          calls++;
          await input.onSlotAcquired?.(`${input.stage_id}-run`);
          if (calls === 1) {
            onChunk?.({
              type: 'text',
              content:
                '<!-- carapa-tool:result -->\n' +
                '> {"command":"bun test","result":"166 tests passed"}\n' +
                'Focused tester notes remain visible.\n' +
                '{"decision":"fail","issues":["fixture regression"],"summary":"validation completed"',
            });
            onChunk?.({ type: 'text', content: '}' });
            return {
              status: 'success',
              result: null,
              newSessionId: 'testing-session',
            } satisfies ContainerOutput;
          }
          return {
            status: 'success',
            result:
              '{"decision":"fail","issues":["fixture regression"],"summary":"validation completed"}',
            newSessionId: 'testing-session',
          } satisfies ContainerOutput;
        },
      },
    });

    const assistantMessages = readTaskMessages(projectId, task.id).filter(
      (entry) => entry.role === 'assistant',
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].content).toContain('bun test');
    expect(assistantMessages[0].content).toContain('166 tests passed');
    expect(assistantMessages[0].content).toContain(
      'Focused tester notes remain visible.',
    );
    expect(assistantMessages[0].content).not.toContain('"decision"');
    expect(readTaskMessages(projectId, task.id).at(-1)?.content).toContain(
      '**Testing failed**',
    );
  });
  describe('background tasks of a run that gave its verdict', () => {
    const verdict =
      '{"decision":"fail","issues":["fixture regression"],"summary":"validation completed"}';
    const twoTasks = [
      { id: 'bg-1', description: 'bun verify:changed' },
      { id: 'bg-2', description: 'tail -f gate.log' },
    ];
    const runTester = async (projectId: string, verdictText: string) => {
      const task = await createTask({
        project_id: projectId,
        title: 'Stop background tasks after the verdict',
        description: '',
        status: 'testing',
        priority: 0,
        branch_name: projectId,
        worktree_path: `/repo/.worktrees/${projectId}`,
      });
      const stopped: string[] = [];
      await executeTask(task, reviewLifecycleGroup(projectId, 'paused'), {
        testDependencies: {
          prepareTaskBranchForReview: async () => {},
          runGitInRepo: fakeReviewGit(
            () => '1111111111111111111111111111111111111111',
          ),
          inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
          stopTaskBackgroundTask: async (_taskId, backgroundTaskId) => {
            stopped.push(backgroundTaskId);
            return true;
          },
          runContainerAgent: async (_group, input, onChunk) => {
            await input.onSlotAcquired?.(`${input.stage_id}-run`);
            onChunk?.({ type: 'text', content: verdictText });
            onChunk?.({ type: 'background_tasks', tasks: twoTasks });
            onChunk?.({ type: 'background_tasks', tasks: twoTasks });
            return {
              status: 'success',
              result: verdictText,
              newSessionId: 'testing-session',
            } satisfies ContainerOutput;
          },
        },
      });
      return stopped;
    };

    test('stops each background task once after the verdict', async () => {
      expect(await runTester('testing-bg-stop-verdict', verdict)).toEqual([
        'bg-1',
        'bg-2',
      ]);
    });

    test('stops nothing while the verdict is missing', async () => {
      expect(
        await runTester('testing-bg-stop-no-verdict', 'Still validating.'),
      ).toEqual([]);
    });
  });
  test('persists the original tester response before a format-repair run marker', async () => {
    const projectId = 'testing-format-repair-transcript-order';
    const task = await createTask({
      project_id: projectId,
      title: 'Repair testing verdict format',
      description: '',
      status: 'testing',
      priority: 0,
      branch_name: 'testing-format-repair-transcript-order',
      worktree_path: '/repo/.worktrees/testing-format-repair-transcript-order',
    });
    const group = reviewLifecycleGroup(projectId, 'paused');
    const invalidResponse = [
      'Focused validation found one regression.',
      '{"decision":"pass"}',
      '{"decision":"fail","issues":[],"summary":"draft is missing evidence"}',
    ].join('\n');
    let repairPrompt = '';

    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async () => {},
        runGitInRepo: fakeReviewGit(
          () => '1111111111111111111111111111111111111111',
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input, onChunk) => {
          const runId = `${input.stage_id}-run`;
          await input.onSlotAcquired?.(runId);
          if (input.stage_id === 'testing:format-repair-1') {
            repairPrompt = input.prompt;
            onChunk?.({
              type: 'text',
              content:
                '<!-- carapa-tool:result -->\n' +
                '> {"command":"bun test","result":"focused tests passed"}\n' +
                'Streamed repair progress remains visible.',
            });
            return {
              status: 'success',
              result: [
                'Canonical repair analysis remains visible.',
                '{"decision":"fail","issues":[],"summary":"discarded repair draft"}',
                '{"decision":"fail","issues":["regression"],"summary":"validation found a regression"}',
              ].join('\n'),
              newSessionId: 'testing-session',
            } satisfies ContainerOutput;
          }
          return {
            status: 'success',
            result: invalidResponse,
            newSessionId: 'testing-session',
          } satisfies ContainerOutput;
        },
      },
    });

    const transcript = readTaskMessages(projectId, task.id).filter(
      (entry) =>
        entry.role === 'assistant' ||
        entry.entry_type === 'run_start' ||
        entry.entry_type === 'testing_feedback',
    );
    expect(
      transcript.map((entry) => ({
        type: entry.entry_type,
        runId: entry.run_id ?? null,
        content: entry.content,
      })),
    ).toEqual([
      { type: 'run_start', runId: 'testing-run', content: '' },
      {
        type: 'run_result',
        runId: 'testing-run',
        content: 'Focused validation found one regression.',
      },
      {
        type: 'run_start',
        runId: 'testing:format-repair-1-run',
        content: '',
      },
      {
        type: 'run_result',
        runId: 'testing:format-repair-1-run',
        content: [
          '<!-- carapa-tool:result -->',
          '> {"command":"bun test","result":"focused tests passed"}',
          'Streamed repair progress remains visible.',
          '',
          'Canonical repair analysis remains visible.',
        ].join('\n'),
      },
      {
        type: 'testing_feedback',
        runId: null,
        content:
          '**Testing failed**\n\nvalidation found a regression\n\n**Issues:**\n- regression',
      },
    ]);
    expect(repairPrompt).toContain(invalidResponse);
  });

  test('repairs a verdict from completed tool evidence after tester transport failure', async () => {
    const projectId = 'testing-transport-recovery';
    const task = await createTask({
      project_id: projectId,
      title: 'Recover testing verdict after transport failure',
      description: '',
      status: 'testing',
      priority: 0,
      branch_name: 'testing-transport-recovery',
      worktree_path: '/repo/.worktrees/testing-transport-recovery',
    });
    const group = reviewLifecycleGroup(projectId, 'paused');
    let calls = 0;

    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async () => {},
        runGitInRepo: fakeReviewGit(
          () => '1111111111111111111111111111111111111111',
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input) => {
          calls++;
          await input.onSlotAcquired?.(`${input.stage_id}-run`);
          if (calls === 1) {
            expect(input.captureTranscript).toBe(true);
            return {
              status: 'error',
              result: null,
              error: 'socket connection closed',
              rawTranscript: JSON.stringify({
                type: 'tool_call',
                id: 'call-1',
                status: 'completed',
                name: 'bash',
                input: { command: '.agent/verify.sh' },
                output: 'verify: OK',
              }),
            } satisfies ContainerOutput;
          }
          expect(input.stage_id).toBe('testing:format-repair-1');
          expect(input.activeRunStageId).toBe('testing');
          expect(input.session_id).toBeUndefined();
          expect(input.injectAgentContext).toBe(true);
          expect(input.prompt).toContain('.agent/verify.sh');
          expect(input.prompt).toContain('verify: OK');
          return {
            status: 'success',
            result:
              '{"decision":"fail","issues":["acceptance evidence incomplete"],"summary":"verification ran but required evidence is missing"}',
          } satisfies ContainerOutput;
        },
      },
    });

    expect(calls).toBe(2);
    expect(await getTask(task.id)).toMatchObject({
      status: 'testing',
      custom_values: { testing_failure_count: 1 },
    });
    expect(readTaskMessages(projectId, task.id).at(-1)?.content).toContain(
      'acceptance evidence incomplete',
    );
  });

  test('starts automatic Review when commit changes but tracked content is identical', async () => {
    const projectId = 'review-preparation-auto-same-tree';
    const originalHead = '6666666666666666666666666666666666666666';
    const inspectedHead = '7777777777777777777777777777777777777777';
    const reviewHead = '8888888888888888888888888888888888888888';
    const testedTree = '9999999999999999999999999999999999999999';
    let currentHead = originalHead;
    let testingWorkerFinished = false;
    let cleanupFinished = false;
    const preparationStages: string[] = [];
    const task = await createTask({
      project_id: projectId,
      title: 'Automatically review unchanged tested state',
      description: '',
      status: 'testing',
      priority: 0,
      branch_name: 'auto-review-unchanged-state',
      worktree_path: '/repo/.worktrees/auto-review-unchanged-state',
    });
    const group = reviewLifecycleGroup(projectId, 'running');
    let reviewExecution: Promise<void> | undefined;
    let releaseReview!: () => void;
    const reviewReleased = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    let markReviewStarted!: (input: ContainerInput) => void;
    const reviewStarted = new Promise<ContainerInput>((resolve) => {
      markReviewStarted = resolve;
    });

    const commonDependencies = {
      prepareTaskBranchForReview: async (
        preparedTask: typeof task,
        preparedGroup: RegisteredGroup,
      ) => {
        preparationStages.push((await getTask(task.id))?.status ?? 'missing');
        await prepareTaskBranchForReview(preparedTask, preparedGroup, {
          checkpointTaskBranch: async () => true,
          needsReviewPreparation: async () => currentHead === originalHead,
          prepareReview: async () => {
            currentHead = inspectedHead;
            return { stdout: 'prepared', isError: false };
          },
        });
      },
      readTaskGitContentIdentity,
      runGitInRepo: fakeReviewGit(
        () => currentHead,
        () => testedTree,
      ),
      inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
      afterSuccessfulAgentRun: async () => {
        testingWorkerFinished = true;
      },
      runPostExecutionGitOps: async (completedTask: typeof task) => {
        if (completedTask.status !== 'testing') return;
        expect(testingWorkerFinished).toBe(true);
        currentHead = reviewHead;
        cleanupFinished = true;
      },
      runContainerAgent: async (_group: unknown, input: ContainerInput) => {
        await input.onCheckoutReady?.(input);
        await input.onSlotAcquired?.(`${input.stage_id}-run`);
        if (input.stage_id === 'review') {
          expect(cleanupFinished).toBe(true);
          expect((await getTask(task.id))?.custom_values).toMatchObject({
            [TESTING_HEAD_SHA_KEY]: inspectedHead,
            [TESTING_TREE_SHA_KEY]: testedTree,
          });
          markReviewStarted(input);
          await reviewReleased;
          return {
            status: 'error',
            result: null,
            error: 'review fixture finished',
          } satisfies ContainerOutput;
        }
        return {
          status: 'success',
          result:
            '{"decision":"pass","issues":[],"summary":"prepared state passed"}',
          newSessionId: 'testing-session',
        } satisfies ContainerOutput;
      },
    };

    await executeTask(task, group, {
      testDependencies: {
        ...commonDependencies,
        drainProjectQueue: async () => {
          const reviewTask = await getTask(task.id);
          if (reviewTask?.status !== 'review' || reviewExecution) return;
          reviewExecution = executeTask(reviewTask, group, {
            testDependencies: {
              ...commonDependencies,
              drainProjectQueue: async () => {},
            },
          });
        },
      },
    });

    const reviewInput = await reviewStarted;
    expect(reviewInput.stage_id).toBe('review');
    expect(currentHead).toBe(reviewHead);
    expect(preparationStages).toEqual(['testing', 'testing', 'review']);
    expect((await getTask(task.id))?.status).toBe('review');

    releaseReview();
    await reviewExecution;
  });

  test('manual Review starts despite stale Testing evidence while the board is paused', async () => {
    const projectId = 'review-preparation-paused-manual';
    const testedHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const priorTestingStartedAt = '2026-08-26T10:00:00.000Z';
    const manuallyTriggeredAt = '2026-08-26T10:01:00.000Z';
    const task = await createTask({
      project_id: projectId,
      title: 'Manually review tested state',
      description: '',
      status: 'review',
      priority: 0,
      branch_name: 'manually-review-tested-state',
      worktree_path: '/repo/.worktrees/manually-review-tested-state',
      custom_values: {
        [TESTING_HEAD_SHA_KEY]: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      lastTriggerSource: 'user',
      lastTriggeredAt: manuallyTriggeredAt,
    });
    await insertActiveRun(
      runFixture({
        id: 'manual-review-prior-testing-run',
        group_folder: projectId,
        task_id: task.id,
        stage: 'testing',
        status: 'completed',
        started_at: priorTestingStartedAt,
        completed_at: '2026-08-26T10:00:30.000Z',
      }),
    );
    const group = reviewLifecycleGroup(projectId, 'paused');
    let releaseReview!: () => void;
    const reviewReleased = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    let markReviewStarted!: (input: ContainerInput) => void;
    const reviewStarted = new Promise<ContainerInput>((resolve) => {
      markReviewStarted = resolve;
    });

    const execution = executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async (
          preparedTask: typeof task,
          preparedGroup: RegisteredGroup,
        ) =>
          prepareTaskBranchForReview(preparedTask, preparedGroup, {
            checkpointTaskBranch: async () => true,
            needsReviewPreparation: async () => false,
          }),
        runGitInRepo: fakeReviewGit(() => testedHead),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input) => {
          await input.onCheckoutReady?.(input);
          await input.onSlotAcquired?.('paused-manual-review-run');
          markReviewStarted(input);
          await reviewReleased;
          return {
            status: 'error',
            result: null,
            error: 'review fixture finished',
          } satisfies ContainerOutput;
        },
      },
    });

    const reviewInput = await reviewStarted;
    expect(reviewInput.stage_id).toBe('review');
    expect(getRunningTaskIds()).toContain(task.id);
    expect((await getTask(task.id))?.status).toBe('review');
    expect(group.settings.status).toBe('paused');

    releaseReview();
    await execution;
  });

  test('defers Review when its prepared tracked content differs', async () => {
    const projectId = 'review-preparation-stale';
    const testedHead = '4444444444444444444444444444444444444444';
    const changedHead = '5555555555555555555555555555555555555555';
    const testedTree = '6666666666666666666666666666666666666666';
    const changedTree = '7777777777777777777777777777777777777777';
    let currentHead = testedHead;
    const task = await createTask({
      project_id: projectId,
      title: 'Detect changed review state',
      description: '',
      status: 'review',
      priority: 0,
      branch_name: 'detect-changed-review-state',
      worktree_path: '/repo/.worktrees/detect-changed-review-state',
      custom_values: {
        [TESTING_HEAD_SHA_KEY]: testedHead,
        [TESTING_TREE_SHA_KEY]: testedTree,
      },
      lastTriggerSource: 'user',
      lastTriggeredAt: '2026-08-26T10:00:00.000Z',
    });
    await insertActiveRun(
      runFixture({
        id: 'automatic-review-prior-testing-run',
        group_folder: projectId,
        task_id: task.id,
        stage: 'testing',
        status: 'completed',
        started_at: '2026-08-26T10:01:00.000Z',
        completed_at: '2026-08-26T10:02:00.000Z',
      }),
    );
    const group = reviewLifecycleGroup(projectId, 'paused');
    let workerStarted = false;

    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async (
          preparedTask: typeof task,
          preparedGroup: RegisteredGroup,
        ) =>
          prepareTaskBranchForReview(preparedTask, preparedGroup, {
            checkpointTaskBranch: async () => true,
            needsReviewPreparation: async () => true,
            prepareReview: async () => {
              currentHead = changedHead;
              return { stdout: 'prepared changed HEAD', isError: false };
            },
          }),
        runGitInRepo: fakeReviewGit(
          () => currentHead,
          () => (currentHead === testedHead ? testedTree : changedTree),
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input) => {
          await input.onCheckoutReady?.(input);
          workerStarted = true;
          return { status: 'success', result: '' } satisfies ContainerOutput;
        },
      },
    });

    expect(workerStarted).toBe(false);
    expect((await getTask(task.id))?.status).toBe('testing');
  });

  test('defers Review before worker start when the prepared worktree is dirty', async () => {
    const projectId = 'review-preparation-dirty';
    const head = '8888888888888888888888888888888888888888';
    const tree = '9999999999999999999999999999999999999999';
    const task = await createTask({
      project_id: projectId,
      title: 'Reject dirty review state',
      description: '',
      status: 'review',
      priority: 0,
      branch_name: 'reject-dirty-review-state',
      worktree_path: '/repo/.worktrees/reject-dirty-review-state',
      custom_values: {
        [TESTING_HEAD_SHA_KEY]: head,
        [TESTING_TREE_SHA_KEY]: tree,
      },
    });
    const group = reviewLifecycleGroup(projectId, 'paused');
    let workerStarted = false;

    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async () => {},
        runGitInRepo: fakeReviewGit(
          () => head,
          () => tree,
          () => true,
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input) => {
          await input.onCheckoutReady?.(input);
          workerStarted = true;
          return { status: 'success', result: '' } satisfies ContainerOutput;
        },
      },
    });

    expect(workerStarted).toBe(false);
    expect((await getTask(task.id))?.status).toBe('testing');
    const notice = readTaskMessages(projectId, task.id).at(-1)?.content;
    expect(notice).toContain('current tracked content');
    expect(notice).not.toContain(head);
    expect(notice).not.toContain(tree);
  });

  test.each([
    ['changed tracked content', 'changed', true],
    ['a dirty worktree', 'dirty', false],
    ['an unavailable Git identity', 'unavailable', false],
  ] as const)(
    'defers Review when %s appears while waiting for a sandbox slot',
    async (_label, slotState, runnerConvertsCallbackError) => {
      const projectId = `review-slot-freshness-${slotState}`;
      const testedHead = '1111111111111111111111111111111111111111';
      const testedTree = '2222222222222222222222222222222222222222';
      const changedHead = '3333333333333333333333333333333333333333';
      const changedTree = '4444444444444444444444444444444444444444';
      let slotAcquired = false;
      let workerStarted = false;
      const task = await createTask({
        project_id: projectId,
        title: `Reject slot-time ${slotState} Review state`,
        description: '',
        status: 'review',
        priority: 0,
        branch_name: `reject-slot-time-${slotState}-review-state`,
        worktree_path: `/repo/.worktrees/reject-slot-time-${slotState}-review-state`,
        custom_values: {
          [TESTING_HEAD_SHA_KEY]: testedHead,
          [TESTING_TREE_SHA_KEY]: testedTree,
        },
      });
      const group = reviewLifecycleGroup(projectId, 'paused');
      const runGit = async (_group: unknown, command: string) => {
        if (command.includes('status --porcelain')) {
          return {
            ok: true,
            output:
              slotAcquired && slotState === 'dirty' ? ' M src/changed.ts' : '',
          };
        }
        if (command.includes('rev-parse HEAD HEAD^{tree}')) {
          if (slotAcquired && slotState === 'unavailable') {
            return { ok: false, output: '' };
          }
          return {
            ok: true,
            output:
              slotAcquired && slotState === 'changed'
                ? `${changedHead}\n${changedTree}`
                : `${testedHead}\n${testedTree}`,
          };
        }
        if (command.includes('rev-parse HEAD')) {
          return { ok: true, output: testedHead };
        }
        if (command.includes('log -1')) {
          return { ok: true, output: `${testedHead} prepared commit` };
        }
        if (command.includes('merge-base')) {
          return {
            ok: true,
            output: '5555555555555555555555555555555555555555',
          };
        }
        return { ok: true, output: '' };
      };

      await executeTask(task, group, {
        testDependencies: {
          prepareTaskBranchForReview: async () => {},
          readTaskGitContentIdentity,
          runGitInRepo: runGit,
          inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
          runContainerAgent: async (_group, input) => {
            await input.onCheckoutReady?.(input);
            slotAcquired = true;
            if (runnerConvertsCallbackError) {
              try {
                await input.onSlotAcquired?.('review-slot-freshness-run');
              } catch (error) {
                return {
                  status: 'error',
                  result: null,
                  error: String(error),
                } satisfies ContainerOutput;
              }
            } else {
              await input.onSlotAcquired?.('review-slot-freshness-run');
            }
            workerStarted = true;
            return { status: 'success', result: '' } satisfies ContainerOutput;
          },
        },
      });

      expect(workerStarted).toBe(false);
      expect(getRunningTaskIds()).not.toContain(task.id);
      expect(await getTask(task.id)).toMatchObject({
        status: 'testing',
        started_at: null,
      });
      const notice = readTaskMessages(projectId, task.id).at(-1)?.content;
      expect(notice).toContain('current tracked content');
      expect(notice).not.toContain(testedHead);
      expect(notice).not.toContain(testedTree);
      expect(notice).not.toContain(changedHead);
      expect(notice).not.toContain(changedTree);
    },
  );

  test('parks a pre-Testing checkpoint failure without recording a tester verdict', async () => {
    const projectId = 'testing-checkpoint-preflight-failure';
    const task = await createTask({
      project_id: projectId,
      title: 'Pause an unavailable Testing checkout',
      description: '',
      status: 'testing',
      priority: 0,
      branch_name: 'pause-unavailable-testing-checkout',
      worktree_path: null,
    });
    const group = reviewLifecycleGroup(projectId, 'paused');
    let workerStarted = false;

    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async (
          preparedTask: typeof task,
          preparedGroup: RegisteredGroup,
        ) =>
          prepareTaskBranchForReview(preparedTask, preparedGroup, {
            checkpointTaskBranch: async () => false,
            needsReviewPreparation: async () => false,
          }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input) => {
          await input.onCheckoutReady?.(input);
          workerStarted = true;
          return { status: 'success', result: '' } satisfies ContainerOutput;
        },
      },
    });

    expect(workerStarted).toBe(false);
    expect(await getTask(task.id)).toMatchObject({
      status: 'backlog',
      completed_at: null,
    });
    const messages = readTaskMessages(projectId, task.id);
    expect(
      messages.filter((message) =>
        message.content.includes('Task checkpoint failed'),
      ),
    ).toHaveLength(1);
    expect(
      messages.some((message) => message.content.includes('Testing blocked')),
    ).toBe(false);
  });

  test('parks Testing without evidence when final review preparation fails', async () => {
    const projectId = 'review-preparation-failure';
    const task = await createTask({
      project_id: projectId,
      title: 'Fail final review preparation',
      description: '',
      status: 'testing',
      priority: 0,
      branch_name: 'fail-review-preparation',
      worktree_path: '/repo/.worktrees/fail-review-preparation',
    });
    const group = reviewLifecycleGroup(projectId, 'paused');
    let workerStarted = false;
    let preparationCalls = 0;
    let cleanupCalls = 0;

    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async () => {
          preparationCalls++;
          if (preparationCalls === 2) {
            throw new Error('synthetic final prepare_review failure');
          }
        },
        runPostExecutionGitOps: async () => {
          cleanupCalls++;
        },
        runGitInRepo: fakeReviewGit(
          () => '7777777777777777777777777777777777777777',
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input) => {
          await input.onCheckoutReady?.(input);
          await input.onSlotAcquired?.('testing-final-preparation-failure');
          workerStarted = true;
          return {
            status: 'success',
            result: '{"decision":"pass","issues":[],"summary":"green"}',
          } satisfies ContainerOutput;
        },
      },
    });

    expect(workerStarted).toBe(true);
    expect(preparationCalls).toBe(2);
    expect(cleanupCalls).toBe(1);
    const parked = await getTask(task.id);
    expect(parked).toMatchObject({ status: 'backlog', completed_at: null });
    expect(parked?.custom_values?.[TESTING_TREE_SHA_KEY]).toBeUndefined();
    expect(readTaskMessages(projectId, task.id).at(-1)?.content).toContain(
      'Task checkpoint failed',
    );
  });

  test('fails Review before worker start when checkpoint preparation fails', async () => {
    const projectId = 'review-checkpoint-failure';
    const testedHead = '6666666666666666666666666666666666666666';
    const task = await createTask({
      project_id: projectId,
      title: 'Reject unverifiable review state',
      description: '',
      status: 'review',
      priority: 0,
      branch_name: 'reject-unverifiable-review-state',
      worktree_path: '/repo/.worktrees/reject-unverifiable-review-state',
      custom_values: { [TESTING_HEAD_SHA_KEY]: testedHead },
    });
    const group = reviewLifecycleGroup(projectId, 'paused');
    let workerStarted = false;

    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async (
          preparedTask: typeof task,
          preparedGroup: RegisteredGroup,
        ) =>
          prepareTaskBranchForReview(preparedTask, preparedGroup, {
            checkpointTaskBranch: async () => false,
            needsReviewPreparation: async () => false,
          }),
        runGitInRepo: fakeReviewGit(() => testedHead),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input) => {
          await input.onCheckoutReady?.(input);
          workerStarted = true;
          return { status: 'success', result: '' } satisfies ContainerOutput;
        },
      },
    });

    expect(workerStarted).toBe(false);
    expect(await getTask(task.id)).toMatchObject({
      status: 'failed',
      completed_at: expect.any(String),
      error: 'Unable to checkpoint task branch before review',
    });
  });

  test('retries a tester run that fails with a transient 529 instead of blocking', async () => {
    const projectId = 'testing-transient-529';
    const task = await createTask({
      project_id: projectId,
      title: 'Overloaded tester',
      description: '',
      status: 'testing',
      priority: 0,
      branch_name: 'testing-transient-529',
      worktree_path: '/repo/.worktrees/testing-transient-529',
    });
    const group = reviewLifecycleGroup(projectId, 'paused');
    const runWith = async (error: string) =>
      executeTask((await getTask(task.id))!, group, {
        testDependencies: {
          prepareTaskBranchForReview: async () => {},
          runGitInRepo: fakeReviewGit(
            () => '1111111111111111111111111111111111111111',
          ),
          inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
          runContainerAgent: async (_group, input) => {
            await input.onSlotAcquired?.('testing-transient-run');
            return { status: 'error', result: null, error };
          },
        },
      });
    // Retry delays must not leave real timers behind.
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => ({
      unref() {},
    })) as unknown as typeof setTimeout);
    try {
      await runWith('API Error: 529 {"type":"overloaded_error"}');
      expect(await getTask(task.id)).toMatchObject({
        status: 'testing',
        error: expect.stringContaining('Retry scheduled'),
        custom_values: { [TRANSIENT_RETRIES_KEY]: 1 },
      });
      expect(_testOnlyIsRetryPending(task.id)).toBe(true);
    } finally {
      timer.mockRestore();
    }
  });

  test('still blocks a tester run that fails with a non-retryable error', async () => {
    const projectId = 'testing-non-retryable';
    const task = await createTask({
      project_id: projectId,
      title: 'Broken tester',
      description: '',
      status: 'testing',
      priority: 0,
      branch_name: 'testing-non-retryable',
      worktree_path: '/repo/.worktrees/testing-non-retryable',
    });

    await executeTask(task, reviewLifecycleGroup(projectId, 'paused'), {
      testDependencies: {
        prepareTaskBranchForReview: async () => {},
        runGitInRepo: fakeReviewGit(
          () => '1111111111111111111111111111111111111111',
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input) => {
          await input.onSlotAcquired?.('testing-non-retryable-run');
          return {
            status: 'error',
            result: null,
            error: 'tester crashed: unexpected token',
          } satisfies ContainerOutput;
        },
      },
    });

    expect((await getTask(task.id))?.status).toBe('question');
    expect(_testOnlyIsRetryPending(task.id)).toBe(false);
  });
});

describe('re-review prompt context (prior rejected rounds and delta)', () => {
  useCleanPipelineTestDatabase();

  const head = '1111111111111111111111111111111111111111';
  const tree = '2222222222222222222222222222222222222222';
  const lastCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const approveVerdict =
    '{"decision":"approve","score":9,"issues":[],"summary":"looks good"}';

  const priorHistory = JSON.stringify([
    {
      timestamp: '2026-11-07T09:00:00.000Z',
      commit: lastCommit,
      issues: [{ id: 'old', text: 'Old blocking issue text' }],
      summary: 'earlier rejection summary',
      comparison: {
        decision: 'retry',
        progress: 'persistent_issue',
        reason: 'same issue again',
      },
    },
  ]);

  function reReviewGroup(projectId: string) {
    return {
      name: projectId,
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'review',
            title: 'Review',
            type: 'review' as const,
            color: '#a4f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
  }

  // The first-review change inventory block when the mock git reports no
  // numstat lines: just the "main repository" heading line.
  const firstReviewPrefix = [
    '## Current change inventory',
    '',
    'The block below is a snapshot for orientation only. Re-read the current files',
    'and re-run the content diff before every verdict; never assume this snapshot',
    'or a prior review is still valid. CarapaBoard alone tracks repository identity.',
    'Do not inspect or reason about repository identity or history.',
    '',
    'Change inventory against `develop`:',
    '```',
    'main repository',
    '```',
    '',
    'Do **not** reject with "diff unchanged" or repeat a prior review without',
    're-verifying each issue against the current file contents.',
  ].join('\n');

  test.each<{
    name: string;
    history: string;
    historyCommit: string;
    isAncestor?: { ok: boolean; output: string };
    merges?: { ok: boolean; output: string };
    numstat?: { ok: boolean; output: string };
    numstatThrows?: boolean;
    expect: string[];
    expectAbsent?: string[];
    expectNoDeltaCommands?: boolean;
    firstReviewOnly?: boolean;
  }>([
    {
      name: 'rebase or force-push since the last round',
      history: priorHistory,
      historyCommit: lastCommit,
      isAncestor: { ok: false, output: '' },
      expect: ['(delta unavailable)', 'Old blocking issue text'],
    },
    {
      name: 'base branch merged since the last round',
      history: priorHistory,
      historyCommit: lastCommit,
      merges: { ok: true, output: `${'c'.repeat(40)}\n` },
      expect: ['(delta unavailable)', 'Old blocking issue text'],
    },
    {
      name: 'rev-list fails',
      history: priorHistory,
      historyCommit: lastCommit,
      merges: { ok: false, output: '' },
      expect: ['(delta unavailable)', 'Old blocking issue text'],
    },
    {
      name: 'numstat fails',
      history: priorHistory,
      historyCommit: lastCommit,
      numstat: { ok: false, output: '' },
      expect: ['(delta unavailable)', 'Old blocking issue text'],
    },
    {
      name: 'numstat throws',
      history: priorHistory,
      historyCommit: lastCommit,
      numstatThrows: true,
      expect: ['(delta unavailable)', 'Old blocking issue text'],
    },
    {
      name: 'invalid recorded commit runs no delta git commands',
      history: JSON.stringify([
        {
          timestamp: '2026-11-07T09:00:00.000Z',
          commit: 'not-a-sha',
          issues: [{ id: 'old', text: 'Old blocking issue text' }],
          summary: 's',
        },
      ]),
      historyCommit: 'not-a-sha',
      expect: ['(delta unavailable)', 'Old blocking issue text'],
      expectNoDeltaCommands: true,
    },
    {
      name: 'delta lines since the last rejected round',
      history: priorHistory,
      historyCommit: lastCommit,
      numstat: { ok: true, output: '3\t1\tsrc/changed.ts\n' },
      expect: [
        'Files changed since the last rejected round:',
        ' src/changed.ts | +3 -1',
        'Old blocking issue text',
      ],
    },
    {
      name: 'no changes since the last rejected round',
      history: priorHistory,
      historyCommit: lastCommit,
      numstat: { ok: true, output: '' },
      expect: ['(no changes since the last rejected round)'],
    },
    {
      name: 'approve-only history keeps the first-review prompt',
      history: JSON.stringify([
        {
          timestamp: '2026-11-07T09:00:00.000Z',
          commit: lastCommit,
          issues: [{ id: 'x', text: 'approver note' }],
          summary: 'approved',
          decision: 'approve',
        },
      ]),
      historyCommit: lastCommit,
      expect: [],
      expectAbsent: ['## Earlier rejected review rounds', 'approver note'],
      expectNoDeltaCommands: true,
      firstReviewOnly: true,
    },
  ])('$name', async (tc) => {
    const projectId = `re-review-prompt-${tc.name.replace(/\W+/g, '-')}`;
    const task = await createTask({
      project_id: projectId,
      title: 'Re-review prompt context',
      description: 'Review this implementation.',
      status: 'review',
      priority: 0,
      custom_values: { review_history: tc.history },
    });
    const commands: string[] = [];
    const prompts: string[] = [];

    await executeTask(task, reReviewGroup(projectId), {
      testDependencies: {
        prepareTaskBranchForReview: async () => {},
        readTaskGitContentIdentity: async () => ({
          headSha: head,
          treeSha: tree,
        }),
        runGitInRepo: async (_group, command) => {
          commands.push(command);
          if (command.includes('merge-base --is-ancestor')) {
            return tc.isAncestor ?? { ok: true, output: '' };
          }
          if (command.includes('rev-list --merges')) {
            return tc.merges ?? { ok: true, output: '' };
          }
          if (command.includes(`diff --numstat ${tc.historyCommit} `)) {
            if (tc.numstatThrows) throw new Error('sandbox git exploded');
            return tc.numstat ?? { ok: true, output: '' };
          }
          if (command.includes('merge-base')) {
            return { ok: true, output: tree };
          }
          return { ok: true, output: '' };
        },
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        mergeBranchForDeploy: async () => true,
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input) => {
          await input.onCheckoutReady?.(input);
          const runId = `${projectId}-run`;
          await insertActiveRun(
            runFixture({
              id: runId,
              group_folder: projectId,
              task_id: task.id,
              stage: 'review',
            }),
          );
          await input.onSlotAcquired?.(runId);
          prompts.push(String(input.prompt));
          await completeActiveRun(runId, 'completed');
          return {
            status: 'success',
            result: approveVerdict,
            newSessionId: 're-review-session',
          } satisfies ContainerOutput;
        },
      },
    });

    // The review run always proceeds to a verdict.
    expect(prompts).toHaveLength(1);
    expect((await getTask(task.id))?.status).toBe('done');
    const prompt = prompts[0];
    for (const expected of tc.expect) expect(prompt).toContain(expected);
    for (const absent of tc.expectAbsent ?? []) {
      expect(prompt).not.toContain(absent);
    }

    if (tc.firstReviewOnly) {
      expect(prompt.startsWith(firstReviewPrefix)).toBe(true);
    } else {
      expect(prompt).toContain('## Earlier rejected review rounds');
      // The prior-rounds section never leaks the recorded commit id.
      const section = prompt.slice(
        prompt.indexOf('## Earlier rejected review rounds'),
      );
      expect(section).not.toContain(tc.historyCommit);
      expect(section).not.toContain(tc.historyCommit.slice(0, 7));
    }
    if (tc.expectNoDeltaCommands) {
      expect(commands.some((c) => c.includes(tc.historyCommit))).toBe(false);
      expect(commands.some((c) => c.includes('rev-list --merges'))).toBe(false);
    }
  });
});

describe('queued task attribution projection', () => {
  useCleanPipelineTestDatabase();

  test('preserves immutable owner and latest trigger into execution', async () => {
    await drizzleDbRef.current.insert(users).values([
      {
        id: 'owner-user',
        username: 'queue-owner',
        password_hash: 'x',
        created_at: '2026-08-08T07:00:00.000Z',
      },
      {
        id: 'trigger-user',
        username: 'queue-trigger',
        password_hash: 'x',
        created_at: '2026-08-08T07:00:00.000Z',
      },
    ]);
    await drizzleDbRef.current.insert(projects).values({
      id: 'queue-attribution-project',
      jid: 'queue-attribution@board',
      name: 'Queue attribution',
      folder: 'queue-attribution-project',
      trigger: '@bot',
      added_at: '2026-08-08T07:00:00.000Z',
      user_id: 'owner-user',
    });
    const task = await createTask({
      project_id: 'queue-attribution-project',
      title: 'Queued attribution',
      description: '',
      status: 'in_progress',
      priority: 0,
      ownerUserId: 'owner-user',
      lastTriggeredByUserId: 'trigger-user',
      lastTriggerSource: 'agent',
      lastTriggeredAt: '2026-08-08T08:00:00.000Z',
      runtimeSelection: {
        harnessId: 'codex',
        modelId: 'gpt-5.6-sol',
        reasoning: 'high',
      },
    });

    expect(await getTasksByProjectForQueue(task.project_id)).toEqual([
      expect.objectContaining({
        id: task.id,
        ownerUserId: 'owner-user',
        lastTriggeredByUserId: 'trigger-user',
        lastTriggerSource: 'agent',
        lastTriggeredAt: '2026-08-08T08:00:00.000Z',
        runtimeSelection: {
          harnessId: 'codex',
          modelId: 'gpt-5.6-sol',
          reasoning: 'high',
        },
      }),
    ]);
  });
});

describe('Kanban structured runtime resolution', () => {
  useCleanPipelineTestDatabase();

  test('launches one catalog binding despite stale inherited runtime fields, and a stage variant runs its alternative', async () => {
    const agentsFile = path.join(DATA_DIR, 'board_agents.jsonc');
    const previous = fs.existsSync(agentsFile)
      ? fs.readFileSync(agentsFile, 'utf8')
      : undefined;
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        version: 2,
        harnesses: {
          codex: {
            label: 'Codex',
            kind: 'cli',
            agentCmd: 'codex',
            sessionFamily: 'codex',
          },
        },
        models: {
          supported: {
            label: 'Supported Codex model',
            reasoning: {
              options: ['low', 'high'],
              default: 'high',
              map: { high: 'xhigh' },
            },
            bindings: {
              codex: { model: 'codex-provider-model' },
            },
          },
          explicit: {
            label: 'Explicit Codex model',
            reasoning: {
              options: ['low', 'high'],
              default: 'high',
              map: { high: 'xhigh' },
            },
            bindings: {
              codex: { model: 'explicit-provider-model' },
            },
          },
        },
        defaults: {
          chat: { harnessId: 'codex', modelId: 'supported' },
          kanban: {
            fallback: { harnessId: 'codex', modelId: 'supported' },
            stages: {
              in_progress: {
                harnessId: 'codex',
                modelId: 'supported',
                reasoning: 'low',
              },
            },
          },
        },
      }),
    );
    reloadChatAgents();

    const projectId = 'structured-runtime-stale-inheritance';
    const parentId = `${projectId}-parent`;
    const inheritedStages = [
      {
        id: 'in_progress',
        title: 'In Progress',
        type: 'active' as const,
        color: '#00f',
        workerAgent: 'claude',
        workerModel: 'claude-ollama-m3',
      },
      { id: 'done', title: 'Done', type: 'done' as const, color: '#0a0' },
      { id: 'failed', title: 'Failed', type: 'queue' as const, color: '#f00' },
    ];
    const parent = {
      name: 'Runtime parent',
      folder: parentId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: { stages: inheritedStages },
    } as unknown as RegisteredGroup;
    const group = {
      name: 'Runtime child',
      folder: projectId,
      parentId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        defaultAgent: 'claude',
        defaultModel: 'claude-ollama-m3',
      },
    } as unknown as RegisteredGroup;
    setGroupResolver((id) =>
      id === projectId ? group : id === parentId ? parent : undefined,
    );

    try {
      const task = await createTask({
        project_id: projectId,
        title: 'Use the configured Codex binding',
        description: '',
        status: 'in_progress',
        priority: 0,
        runtimeSelection: null,
      });
      let capturedInput: ContainerInput | undefined;

      await executeTask(task, group, {
        testDependencies: {
          runContainerAgent: async (_group, input) => {
            capturedInput = input;
            return { status: 'success', result: 'done' };
          },
          runPostExecutionGitOps: async () => {},
          mergeBranchForDeploy: async () => true,
          drainProjectQueue: async () => {},
        },
      });

      expect(capturedInput).toMatchObject({
        agent_cmd: 'codex',
        model: 'codex-provider-model',
        reasoning_effort: 'low',
        session_agent_key: 'codex@relay',
      });
      expect(capturedInput?.model).not.toBe('claude-ollama-m3');

      const explicitTask = await createTask({
        project_id: projectId,
        title: 'Use an explicit structured override',
        description: '',
        status: 'in_progress',
        priority: 1,
        runtimeSelection: {
          harnessId: 'codex',
          modelId: 'explicit',
        },
      });
      capturedInput = undefined;
      await executeTask(explicitTask, group, {
        testDependencies: {
          runContainerAgent: async (_group, input) => {
            capturedInput = input;
            return { status: 'success', result: 'done' };
          },
          runPostExecutionGitOps: async () => {},
          mergeBranchForDeploy: async () => true,
          drainProjectQueue: async () => {},
        },
      });
      expect(capturedInput).toMatchObject({
        agent_cmd: 'codex',
        model: 'explicit-provider-model',
        reasoning_effort: 'low',
      });

      // A card with stage_variant 'b' runs `in_progress.b`'s runtime. The project
      // has no `testing.b`, so the same card's testing run uses the base config.
      const variantGroup = {
        name: 'Runtime variant',
        folder: `${projectId}-variant`,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'running',
          stages: [
            {
              id: 'in_progress',
              title: 'In Progress',
              type: 'active',
              color: '#00f',
              runtimeSelection: { harnessId: 'codex', modelId: 'supported' },
            },
            {
              id: 'in_progress.b',
              title: 'In Progress B',
              type: 'active',
              color: '#00f',
              runtimeSelection: { harnessId: 'codex', modelId: 'explicit' },
            },
            {
              id: 'testing',
              title: 'Testing',
              type: 'testing',
              color: '#0af',
              runtimeSelection: { harnessId: 'codex', modelId: 'supported' },
            },
            { id: 'done', title: 'Done', type: 'done', color: '#0a0' },
            { id: 'failed', title: 'Failed', type: 'queue', color: '#f00' },
          ],
        },
      } as unknown as RegisteredGroup;
      const variantTask = await createTask({
        project_id: variantGroup.folder,
        title: 'Run this card on B',
        description: '',
        status: 'in_progress',
        priority: 0,
        runtimeSelection: null,
        stageVariant: 'b',
      });
      const firstLaunchOf = async (taskId: string) => {
        const launches: ContainerInput[] = [];
        await executeTask((await getTask(taskId))!, variantGroup, {
          testDependencies: {
            runContainerAgent: async (_group, input) => {
              launches.push(input);
              return { status: 'success', result: 'done' };
            },
            runPostExecutionGitOps: async () => {},
            mergeBranchForDeploy: async () => true,
            drainProjectQueue: async () => {},
          },
        });
        return launches[0];
      };
      expect(await firstLaunchOf(variantTask.id)).toMatchObject({
        agent_cmd: 'codex',
        model: 'explicit-provider-model',
      });
      await updateTask(variantTask.id, { status: 'testing' });
      expect(await firstLaunchOf(variantTask.id)).toMatchObject({
        agent_cmd: 'codex',
        model: 'codex-provider-model',
      });
    } finally {
      if (previous === undefined) fs.rmSync(agentsFile, { force: true });
      else fs.writeFileSync(agentsFile, previous);
      reloadChatAgents();
    }
  });
});

describe('stage main persona prompt composition', () => {
  test('loads the current enabled persona prompt and safely skips deleted personas', async () => {
    const id = 'pipeline-stage-persona';
    const now = new Date().toISOString();
    const promptPath = await writeAiUserPrompt(id, 'Current persona prompt');
    await insertAiUserRow({
      id,
      name: 'Pipeline persona',
      identity: 'Pipeline persona',
      presetId: 'custom',
      promptPath,
      turn: 'after',
      tools: [],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });

    expect(
      await resolveStagePersonaPrompt(id, {
        taskId: 'task-1',
        stageId: 'implementation',
      }),
    ).toBe('Current persona prompt');

    await deleteAiUserRow(id);
    expect(
      await resolveStagePersonaPrompt(id, {
        taskId: 'task-1',
        stageId: 'implementation',
      }),
    ).toBeUndefined();
    fs.rmSync(path.join(DATA_DIR, 'ai-users', id), {
      recursive: true,
      force: true,
    });
  });
});

test('only finds a recording produced by the specified run', () => {
  const dir = fs.mkdtempSync('/tmp/carapa-testing-recording-');
  try {
    fs.writeFileSync(path.join(dir, 'run-old-session.webm'), 'old');
    fs.writeFileSync(path.join(dir, 'run-latest-session.webm'), 'latest');

    expect(findRunRecording(dir, 'run-latest')).toBe('run-latest-session.webm');
    expect(findRunRecording(dir, 'run-missing')).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('executeTask does not start the stage agent until its fresh-session reset persists', async () => {
  await resetPipelineTestDatabase();
  const task = await createTask({
    project_id: 'project-fresh-session-execution',
    title: 'Fresh session',
    description: '',
    status: 'in_progress',
    priority: 0,
    session_id: 'previous-session',
  });
  const group = {
    name: 'Fresh session',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: { status: 'paused' as const },
  };
  let releaseReset!: () => void;
  const resetPersisted = new Promise<void>((resolve) => {
    releaseReset = resolve;
  });
  let resetCompleted = false;
  let agentStartedAfterReset: boolean | undefined;
  const execution = executeTask(task, group, {
    freshSession: true,
    testDependencies: {
      clearSessionBeforeFreshRun: async () => {
        await resetPersisted;
        resetCompleted = true;
      },
      runContainerAgent: async () => {
        agentStartedAfterReset = resetCompleted;
        return {
          status: 'success',
          result: 'done',
          newSessionId: 'fresh',
        } as any;
      },
    },
  });

  releaseReset();
  await execution;
  expect(agentStartedAfterReset).toBe(true);
});

test('executeTask resumes only the newest same-stage compatible owner', async () => {
  await resetPipelineTestDatabase();
  const projectId = 'project-session-owner-selection';
  const group = {
    name: 'Session owner selection',
    folder: projectId,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      stages: [
        {
          id: 'in_progress',
          title: 'In progress',
          type: 'active' as const,
          color: '#08f',
        },
        {
          id: 'polish',
          title: 'Polish',
          type: 'active' as const,
          color: '#80f',
        },
        { id: 'done', title: 'Done', type: 'done' as const, color: '#0a0' },
      ],
    },
  };
  const scenarios = [
    {
      id: 'ordinary-continue',
      status: 'in_progress',
      lastAgent: 'direct',
      agent_name: 'direct',
      runStage: 'in_progress',
      runSession: 'same-stage-session',
      taskSession: 'same-stage-session',
      expectedSession: 'same-stage-session',
    },
    {
      id: 'explicit-fresh',
      status: 'in_progress',
      lastAgent: 'direct',
      agent_name: 'direct',
      runStage: 'in_progress',
      runSession: 'session-cleared-by-fresh-option',
      taskSession: 'session-cleared-by-fresh-option',
      freshSession: true,
      expectedSession: undefined,
    },
    {
      id: 'cross-stage',
      status: 'polish',
      lastAgent: 'direct',
      agent_name: 'direct',
      runStage: 'in_progress',
      runSession: 'implementation-session',
      taskSession: 'implementation-session',
      expectedSession: undefined,
    },
    {
      id: 'changed-runtime',
      status: 'in_progress',
      lastAgent: 'direct',
      agent_name: 'different-agent',
      runStage: 'in_progress',
      runSession: 'incompatible-runtime-session',
      taskSession: 'incompatible-runtime-session',
      expectedSession: undefined,
    },
    {
      id: 'newest-missing-session',
      status: 'in_progress',
      lastAgent: 'direct',
      agent_name: 'direct',
      runStage: 'in_progress',
      runSession: null,
      taskSession: 'stale-live-cursor',
      expectedSession: undefined,
    },
    {
      id: 'start-over-reset',
      status: 'in_progress',
      lastAgent: 'direct',
      agent_name: 'direct',
      runStage: 'in_progress',
      runSession: 'session-before-reset',
      taskSession: '',
      expectedSession: undefined,
    },
  ] as const;

  for (const scenario of scenarios) {
    const task = await createTask({
      project_id: projectId,
      title: scenario.id,
      description: 'Continue safely',
      status: scenario.status,
      priority: 0,
      session_id: scenario.taskSession,
      last_agent_name: scenario.lastAgent,
    });
    const runSessionKey = scenario.agent_name;
    await insertActiveRun(
      runFixture({
        id: `owner-${scenario.id}`,
        group_folder: projectId,
        task_id: task.id,
        stage: scenario.runStage,
        status: 'completed',
        session_id: scenario.runSession,
        agent_name: runSessionKey,
        session_agent_key: runSessionKey,
      }),
    );
    let selectedSession: string | undefined;
    await executeTask(task, group, {
      ...('freshSession' in scenario
        ? { freshSession: scenario.freshSession }
        : {}),
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          selectedSession = input.session_id;
          return {
            status: 'error',
            result: null,
            error: 'selection captured',
          };
        },
        drainProjectQueue: async () => {},
      },
    });
    expect(selectedSession, scenario.id).toBe(scenario.expectedSession);
  }
});

test('executeTask delegates a cold branch checkout to the sandbox runner', async () => {
  await resetPipelineTestDatabase();
  const dependency = await createTask({
    project_id: 'project-cold-branch-execution',
    title: 'Existing completed dependency',
    description: '',
    status: 'completed',
    priority: 0,
    branch_name: 'dependency-work',
  });
  const task = await createTask({
    project_id: 'project-cold-branch-execution',
    title: 'Resume cold branch task',
    description: '',
    status: 'in_progress',
    priority: 0,
    branch_name: 'task/paged-kv-work',
    depends_on_ids: [dependency.id],
  });
  const group = {
    name: 'Cold branch execution',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      taskCheckoutMode: 'branch' as const,
      defaultBranch: 'paged_kv',
      repositoryLocation: '/host/project',
    },
  };
  let capturedInput: ContainerInput | undefined;
  let checkpointCalls = 0;

  await executeTask(task, group, {
    testDependencies: {
      runContainerAgent: async (_group, input) => {
        capturedInput = input;
        return {
          status: 'error',
          result: null,
          error: 'simulated stop after sandbox handoff',
        };
      },
      runPostExecutionGitOps: async () => {
        checkpointCalls++;
      },
    },
  });

  expect(capturedInput?.branch_name).toBe('task/paged-kv-work');
  expect(capturedInput?.skipSharedCheckoutLease).toBe(true);
  expect(capturedInput?.prepareCheckout).toBeFunction();
  expect(checkpointCalls).toBe(0);
});

test('completed dependency maps its tested commit onto a patch-equivalent rebased default', async () => {
  await resetPipelineTestDatabase();
  const testedCommit = '6'.repeat(40);
  const obsoleteMergeCommit = '1'.repeat(40);
  const defaultCommit = '9'.repeat(40);
  const dependency = await createTask({
    project_id: 'project-completed-dependency-identity',
    title: 'Merged dependency',
    description: '',
    status: 'completed',
    priority: 0,
  });
  await updateTask(dependency.id, {
    branch_name: null,
    merge_commit: obsoleteMergeCommit,
    custom_values: {
      testing_head_sha: testedCommit,
      completed_commit_sha: testedCommit,
    },
  });
  const task = await createTask({
    project_id: 'project-completed-dependency-identity',
    title: 'Dependent task',
    description: '',
    status: 'in_progress',
    priority: 0,
    branch_name: 'task/dependent-work',
    depends_on_ids: [dependency.id],
  });
  const group = {
    name: 'Completed dependency identity',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      taskCheckoutMode: 'branch' as const,
      defaultBranch: 'paged_kv',
      repositoryLocation: '/host/project',
    },
  };
  const commands: string[] = [];
  let prepared:
    | {
        branchBaseName?: string;
        branchBaseCommit?: string;
        requiredDependencyCommits?: string[];
        dependencyByCommit?: Record<string, { id: string; title: string }>;
      }
    | undefined;

  await executeTask(task, group, {
    testDependencies: {
      runGitInRepo: async (_group, command) => {
        commands.push(command);
        if (command === 'rev-parse --verify paged_kv^{commit}') {
          return { ok: true, output: defaultCommit };
        }
        if (command === 'rev-parse --verify task/dependent-work^{commit}') {
          return { ok: false, output: 'missing task branch' };
        }
        if (command === `rev-parse --verify ${testedCommit}^{commit}`) {
          return { ok: true, output: testedCommit };
        }
        if (
          command ===
          `merge-base --is-ancestor ${testedCommit} ${defaultCommit}`
        ) {
          return { ok: false, output: '' };
        }
        if (command === `cherry ${defaultCommit} ${testedCommit}`) {
          return { ok: true, output: `- ${testedCommit}\n` };
        }
        if (
          command ===
          `merge-base --is-ancestor ${defaultCommit} ${defaultCommit}`
        ) {
          return { ok: true, output: '' };
        }
        return { ok: false, output: `unexpected command: ${command}` };
      },
      runContainerAgent: async (_group, input) => {
        prepared = await input.prepareCheckout?.();
        return {
          status: 'error',
          result: null,
          error: 'simulated stop after dependency resolution',
        };
      },
    },
  });

  expect(prepared).toEqual({
    branchBaseCommit: defaultCommit,
    requiredDependencyCommits: [defaultCommit],
    dependencyByCommit: {
      [defaultCommit]: { id: dependency.id, title: 'Merged dependency' },
    },
  });
  expect(commands.join('\n')).toContain(testedCommit);
  expect(commands.join('\n')).not.toContain(obsoleteMergeCommit);
});

test('task Git targets the configured fixed sandbox before a first run persists an instance', async () => {
  const task = {
    id: 'task-fixed-instance-git',
    project_id: 'llama-cpp',
    title: 'Resolve local base',
    description: '',
    status: 'in_progress',
    priority: 0,
    created_at: '2026-09-01T00:00:00.000Z',
  } satisfies Task;
  const group = {
    name: 'llama-cpp',
    folder: 'llama-cpp',
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      defaultSandbox: 'llama-cpp',
      defaultSandboxInstance: 'llama-cpp',
    },
  } satisfies RegisteredGroup;
  let capturedInstance: string | null | undefined;
  const runGit = taskSandboxGitRunner(task, async (_group, _args, instance) => {
    capturedInstance = instance;
    return { ok: true, output: '1'.repeat(40) };
  });

  await runGit(group, 'rev-parse --verify paged_kv^{commit}');

  expect(capturedInstance).toBe('llama-cpp');
});

test('task Git targets the effective sandbox before a first run persists an instance', async () => {
  const task = {
    id: 'task-derived-instance-git',
    project_id: 'carapa-board',
    title: 'Resolve local base',
    description: '',
    status: 'in_progress',
    priority: 0,
    created_at: '2026-09-01T00:00:00.000Z',
  } satisfies Task;
  const group = {
    name: 'carapa-board',
    folder: 'carapa-board',
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      defaultSandbox: 'carapa-bot',
    },
  } satisfies RegisteredGroup;
  let capturedInstance: string | null | undefined;
  const runGit = taskSandboxGitRunner(task, async (_group, _args, instance) => {
    capturedInstance = instance;
    return { ok: true, output: '1'.repeat(40) };
  });

  await runGit(group, 'rev-parse --verify develop^{commit}');

  expect(capturedInstance).toBe('carapa-board');
});

test('executeTask preserves an explicit null causal trigger instead of using the owner', async () => {
  await resetPipelineTestDatabase();
  const task = await createTask({
    project_id: 'project-system-trigger-execution',
    title: 'System-triggered task',
    description: '',
    status: 'in_progress',
    priority: 0,
    ownerUserId: 'project-owner',
    lastTriggeredByUserId: 'later-human-triggerer',
    lastTriggerSource: 'user',
  });
  const group = {
    name: 'System trigger',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: { status: 'paused' as const },
  };
  let capturedInput: any;

  await executeTask(task, group, {
    triggerAttribution: {
      triggeredByUserId: null,
      triggerSource: 'system',
    },
    manualParallelismOverride: true,
    testDependencies: {
      runContainerAgent: async (_group, input) => {
        capturedInput = input;
        return { status: 'success', result: 'done' } as any;
      },
    },
  });

  expect(capturedInput.triggeredByUserId).toBeNull();
  expect(capturedInput.triggerSource).toBe('system');
  expect(capturedInput.manualParallelismOverride).toBe(true);
});

test('executeTask notifies owner and triggerer after a normal active-to-done transition', async () => {
  await resetPipelineTestDatabase();
  const owner = await createUser('completion-owner', 'pw', 'user');
  const triggerer = await createUser('completion-triggerer', 'pw', 'user');
  const task = await createTask({
    project_id: 'project-completion-notification',
    title: 'Notify successful completion',
    description: '',
    status: 'in_progress',
    priority: 0,
    ownerUserId: owner.id,
    lastTriggeredByUserId: triggerer.id,
    lastTriggerSource: 'user',
  });
  await upsertProjectMember(owner.id, task.project_id, 'editor');
  await upsertProjectMember(triggerer.id, task.project_id, 'editor');
  const group = {
    name: 'Completion notification',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      stages: [
        {
          id: 'in_progress',
          title: 'In progress',
          type: 'active' as const,
          color: '#08f',
        },
        {
          id: 'completed',
          title: 'Completed',
          type: 'done' as const,
          color: '#0a0',
        },
      ],
    },
  };

  await executeTask(task, group, {
    testDependencies: {
      runContainerAgent: async () =>
        ({
          status: 'success',
          result: 'completed normally',
          activeRunId: 'normal-completion-run',
        }) as any,
    },
  });

  expect((await getTask(task.id))?.status).toBe('completed');
  expect(await getUnreadPayloads(owner.id)).toEqual([
    expect.objectContaining({
      summary: 'Task completed: Notify successful completion',
    }),
  ]);
  expect(await getUnreadPayloads(triggerer.id)).toEqual([
    expect.objectContaining({
      summary: 'Task completed: Notify successful completion',
    }),
  ]);
});

test('post-processing failure advancing to a nonterminal stage does not notify completion', async () => {
  await resetPipelineTestDatabase();
  const owner = await createUser('postprocess-owner', 'pw', 'user');
  const triggerer = await createUser('postprocess-triggerer', 'pw', 'user');
  const task = await createTask({
    project_id: 'project-postprocess-nonterminal',
    title: 'Advance without false completion',
    description: '',
    status: 'in_progress',
    priority: 0,
    ownerUserId: owner.id,
    lastTriggeredByUserId: triggerer.id,
    lastTriggerSource: 'user',
  });
  await upsertProjectMember(owner.id, task.project_id, 'editor');
  await upsertProjectMember(triggerer.id, task.project_id, 'editor');
  const run = runFixture({
    id: 'postprocess-success-run',
    group_folder: task.project_id,
    task_id: task.id,
    triggeredByUserId: triggerer.id,
    triggerSource: 'user',
  });
  await insertActiveRun(run);
  await completeActiveRun(run.id, 'completed');
  const group = {
    name: 'Post-processing transition',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      stages: [
        {
          id: 'in_progress',
          title: 'In progress',
          type: 'active' as const,
          color: '#08f',
        },
        {
          id: 'testing',
          title: 'Testing',
          type: 'testing' as const,
          color: '#a3f',
        },
        {
          id: 'completed',
          title: 'Completed',
          type: 'done' as const,
          color: '#0a0',
        },
      ],
    },
  };

  await executeTask(task, group, {
    testDependencies: {
      runContainerAgent: async (_group, input) => {
        await input.onSlotAcquired?.(run.id);
        return {
          status: 'success',
          result: 'agent work completed',
          activeRunId: run.id,
        } as any;
      },
      afterSuccessfulAgentRun: async () => {
        throw new Error('synthetic post-processing failure');
      },
    },
  });

  expect(await getTask(task.id)).toMatchObject({
    status: 'testing',
    completed_at: null,
  });
  expect(await getUnreadPayloads(owner.id)).toHaveLength(0);
  expect(await getUnreadPayloads(triggerer.id)).toHaveLength(0);
});

test('review post-processing failure parks the task and keeps the failure breaker', async () => {
  await resetPipelineTestDatabase();
  const projectId = 'project-review-postprocess-failure';
  const task = await createTask({
    project_id: projectId,
    title: 'Park on review post-processing failure',
    description: '',
    status: 'review',
    priority: 0,
    custom_values: {
      [TESTING_HEAD_SHA_KEY]: 'a'.repeat(40),
      [TESTING_TREE_SHA_KEY]: 'a'.repeat(40),
    },
  });
  const run = runFixture({
    id: 'review-postprocess-run',
    group_folder: projectId,
    task_id: task.id,
  });
  await insertActiveRun(run);
  await completeActiveRun(run.id, 'completed');
  // One failure short of the limit: the execFailed path blocks the immediate
  // drain and keeps the breaker, whereas the old keep-in-review path cleared it.
  _testOnlySetProjectFailureState(projectId, { count: 2 });
  let drains = 0;
  try {
    await executeTask(task, reviewLifecycleGroup(projectId, 'paused'), {
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          await input.onSlotAcquired?.(run.id);
          return {
            status: 'success',
            result: 'review finished',
            activeRunId: run.id,
          } as any;
        },
        prepareTaskBranchForReview: async () => {},
        readTaskGitContentIdentity: async () => ({
          headSha: 'a'.repeat(40),
          treeSha: 'a'.repeat(40),
        }),
        runGitInRepo: fakeReviewGit(() => 'a'.repeat(40)),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        mergeBranchForDeploy: async () => true,
        runPostExecutionGitOps: async () => {},
        afterSuccessfulAgentRun: async () => {
          throw new Error('merge timed out waiting for git lock');
        },
        drainProjectQueue: async () => {
          drains++;
        },
      },
    });

    expect(await getTask(task.id)).toMatchObject({
      status: 'backlog',
      completed_at: null,
    });
    expect(drains).toBe(0);
    const notice = readTaskMessages(projectId, task.id).at(-1)?.content ?? '';
    expect(notice).toContain('paused in `backlog`');
    expect(notice).toContain('may already be merged');
    expect(notice).toContain('merge timed out waiting for git lock');
  } finally {
    resetProjectFailures(projectId);
  }
});

test('pre-launch setup failure does not inherit a previous stage completed run and advance the task', async () => {
  await resetPipelineTestDatabase();
  const task = await createTask({
    project_id: 'project-prelaunch-stale-completed-run',
    title: 'Setup failure must not advance',
    description: '',
    status: 'in_progress',
    priority: 0,
  });
  const priorRun = runFixture({
    id: 'prelaunch-prior-completed-run',
    group_folder: task.project_id,
    task_id: task.id,
  });
  await insertActiveRun(priorRun);
  await completeActiveRun(priorRun.id, 'completed');
  const group = {
    name: 'Pre-launch failure',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      stages: [
        {
          id: 'in_progress',
          title: 'In progress',
          type: 'active' as const,
          color: '#08f',
        },
        {
          id: 'testing',
          title: 'Testing',
          type: 'testing' as const,
          color: '#a3f',
        },
        {
          id: 'failed',
          title: 'Failed',
          type: 'queue' as const,
          color: '#f33',
        },
        {
          id: 'completed',
          title: 'Completed',
          type: 'done' as const,
          color: '#0a0',
        },
      ],
    },
  };

  await executeTask(task, group, {
    testDependencies: {
      runContainerAgent: async () => {
        throw new Error('setup failure');
      },
    },
  });

  expect(await getTask(task.id)).toMatchObject({
    status: 'failed',
    error: 'setup failure',
  });
});

test('executeTask stops before the stage agent when deployment intercepts with a false deploy result', async () => {
  await resetPipelineTestDatabase();
  const task = await createTask({
    project_id: 'project-deploy-intercept-execution',
    title: 'Deploy',
    description: '',
    status: 'deploy',
    priority: 0,
  });
  const group = {
    name: 'Deploy',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      deployService: 'carapa-board',
      deployStage: 'deploy',
      stages: [
        { id: 'deploy', title: 'Deploy', type: 'done' as const, color: '#0a0' },
      ],
    },
  };
  let agentStarted = false;
  let deployCalled = false;

  await executeTask(task, group, {
    testDependencies: {
      interceptAutoDeployExecution: async () => {
        deployCalled = true;
        return true;
      },
      runContainerAgent: async () => {
        agentStarted = true;
        throw new Error(
          'the deploy intercept must prevent stage-agent execution',
        );
      },
    },
  });

  expect(deployCalled).toBe(true);
  expect(agentStarted).toBe(false);
});

test('auto-deploy interception restores the originating stage when steering is pending', async () => {
  await resetPipelineTestDatabase();
  const projectId = 'project-deploy-steering-barrier';
  const task = await createTask({
    project_id: projectId,
    title: 'Deploy with pending prompt',
    description: '',
    status: 'implementation',
    priority: 0,
  });
  await appendTaskMessageAsync(projectId, {
    task_id: task.id,
    role: 'user',
    content: 'wait for this prompt',
    steering: true,
    created_at: new Date().toISOString(),
  });
  const group = {
    name: 'Deploy barrier',
    folder: projectId,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      deployService: 'carapa-board',
      deployStage: 'deploy',
      stages: [
        {
          id: 'implementation',
          title: 'Implementation',
          type: 'active' as const,
          color: '#38f',
        },
        { id: 'deploy', title: 'Deploy', type: 'done' as const, color: '#0a0' },
      ],
    },
  };
  let deployCalled = false;
  expect(
    await interceptAutoDeployExecution(
      task,
      group,
      'deploy',
      group.settings.stages,
      async () => {
        deployCalled = true;
        return true;
      },
    ),
  ).toBe(true);
  expect(deployCalled).toBe(false);
  expect((await getTask(task.id))?.status).toBe('implementation');
});

test('update_task defers a live task stage write until run finalization', async () => {
  const task = await createTask({
    project_id: 'project-stage-handoff-tool',
    title: 'Move stage',
    description: '',
    status: 'backlog',
    priority: 0,
  });
  await insertActiveRun(
    runFixture({
      id: 'deferred-stage-handoff-run',
      group_folder: task.project_id,
      task_id: task.id,
      stage: 'backlog',
    }),
  );
  const abort = new AbortController();
  registerRecoveredTaskAbort(task.id, task.project_id, abort);

  const response = await updateTaskTool.handler(
    { task_id: task.id, status: 'in_progress' },
    {} as any,
    {
      group_folder: task.project_id,
      permissions: { '*': ['tasks:write'] },
      run_id: 'deferred-stage-handoff-run',
    } as any,
  );

  expect(response).toContain('current run is ending');
  expect((await getTask(task.id))?.status).toBe('backlog');
  unregisterRecoveredTaskAbort(task.id, abort);
});

test('update_task hands off a running card to a queue stage without caller ids', async () => {
  await resetPipelineTestDatabase();
  const task = await createTask({
    project_id: 'project-stage-handoff-no-caller',
    title: 'Move running card',
    description: '',
    status: 'in_progress',
    priority: 0,
  });
  await insertActiveRun(
    runFixture({
      id: 'card-current-run',
      group_folder: task.project_id,
      task_id: task.id,
      stage: 'in_progress',
    }),
  );
  const abort = new AbortController();
  registerRecoveredTaskAbort(task.id, task.project_id, abort);

  const response = await updateTaskTool.handler(
    { task_id: task.id, status: 'question' },
    {} as any,
    {
      group_folder: task.project_id,
      permissions: { '*': ['tasks:write'] },
    } as any,
  );

  expect(response).toContain('current run is ending');
  expect(abort.signal.aborted).toBe(false);
  const moved = await getTask(task.id);
  expect(moved?.status).toBe('in_progress');
  expect(moved?.error).not.toBe('Stopped by user');
  expect(
    readTaskMessages(task.project_id, task.id).find(
      (message) => message.entry_type === 'stage_handoff_request',
    ),
  ).toMatchObject({ run_id: 'card-current-run', target_stage: 'question' });

  // The newest accepted move stays authoritative: question -> failed ->
  // question must persist a fresh question request after the failed one.
  for (const status of ['failed', 'question']) {
    await updateTaskTool.handler(
      { task_id: task.id, status },
      {} as any,
      {
        group_folder: task.project_id,
        permissions: { '*': ['tasks:write'] },
      } as any,
    );
  }
  expect(
    readTaskMessages(task.project_id, task.id)
      .filter((message) => message.entry_type === 'stage_handoff_request')
      .map((message) => message.target_stage),
  ).toEqual(['question', 'failed', 'question']);
  unregisterRecoveredTaskAbort(task.id, abort);
});

test('update_task cancels a pre-launch claim moved to another execution stage', async () => {
  await resetPipelineTestDatabase();
  const task = await createTask({
    project_id: 'project-stage-move-prelaunch',
    title: 'Move queued claim',
    description: '',
    status: 'backlog',
    priority: 0,
  });
  const abort = new AbortController();
  registerRecoveredTaskAbort(task.id, task.project_id, abort);

  await updateTaskTool.handler(
    { task_id: task.id, status: 'in_progress' },
    {} as any,
    {
      group_folder: task.project_id,
      permissions: { '*': ['tasks:write'] },
      // Stale identity: the card's previous run, not its pending claim.
      task_id: task.id,
      run_id: 'previous-completed-run',
    } as any,
  );

  expect(abort.signal.aborted).toBe(true);
  const moved = await getTask(task.id);
  expect(moved?.status).toBe('in_progress');
  expect(moved?.error).not.toBe('Stopped by user');
  unregisterRecoveredTaskAbort(task.id, abort);
});

// waitForRun pins run dirs below DATA_DIR/ipc, so fixtures must live there.
const ipcTestRoot = () => {
  fs.mkdirSync(path.join(DATA_DIR, 'ipc'), { recursive: true });
  return path.join(DATA_DIR, 'ipc');
};

test('waitForRun waits for canonical metrics after an early exit code', async () => {
  const dir = fs.mkdtempSync(
    path.join(ipcTestRoot(), 'carapa-metrics-contract-'),
  );
  try {
    fs.writeFileSync(path.join(dir, 'args.json'), '{"metricsContract":1}');
    fs.writeFileSync(path.join(dir, 'exit_code'), '0');
    const pending = waitForRun(dir, 1_000);
    fs.writeFileSync(
      path.join(dir, 'metrics.json'),
      JSON.stringify({ version: 1, status: 'success', toolCalls: [] }),
    );
    fs.writeFileSync(path.join(dir, 'metrics_complete'), 'ok');
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(result.metrics?.status).toBe('success');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('waitForRun settles for a pre-aborted signal even when the metrics handshake is incomplete', async () => {
  // Regression: a stop that lands before the active_run row exists (or before
  // stop-agent.sh publishes the contract-v1 handshake) aborts the signal while
  // waitForRun is still starting. The pre-aborted branch must keep its watcher
  // and poll timers alive so the handshake — or the hard deadline — can still
  // finalize the run. Returning without any timers left the promise pending
  // forever, leaking the caller's semaphore slot and stranding the queue.
  const dir = fs.mkdtempSync(path.join(ipcTestRoot(), 'carapa-preaborted-'));
  let hungTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    fs.writeFileSync(path.join(dir, 'args.json'), '{"metricsContract":1}');
    const pending = waitForRun(dir, 100, undefined, AbortSignal.abort());
    const outcome = await Promise.race([
      pending.then(
        (r) => ({ kind: 'resolved' as const, result: r }),
        (err) => ({ kind: 'rejected' as const, error: err }),
      ),
      new Promise<{ kind: 'hung' }>((resolve) => {
        hungTimer = setTimeout(() => resolve({ kind: 'hung' }), 6_000);
      }),
    ]);
    // With no handshake on disk the only settlement path is the hard
    // deadline failing the run — a success resolution here would mean the
    // pre-aborted branch lost its timers or settled on a bogus completion.
    expect(
      outcome.kind,
      'waitForRun never settled or wrongly resolved: pre-aborted signal with incomplete contract-v1 handshake',
    ).toBe('rejected');
    expect(
      outcome.kind === 'rejected' ? outcome.error.message : '',
      'rejection should be the hard-deadline timeout',
    ).toMatch(/timed out/i);
  } finally {
    clearTimeout(hungTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('waitForRun honors a pre-aborted signal once the run already completed', async () => {
  const dir = fs.mkdtempSync(
    path.join(ipcTestRoot(), 'carapa-preaborted-done-'),
  );
  try {
    fs.writeFileSync(path.join(dir, 'args.json'), '{"metricsContract":1}');
    fs.writeFileSync(path.join(dir, 'exit_code'), '0');
    fs.writeFileSync(path.join(dir, 'metrics_complete'), 'ok');
    const result = await waitForRun(dir, 1_000, undefined, AbortSignal.abort());
    expect(result.isError).toBe(false);
    expect(result.events).toBe('');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical completion persists a metrics-bearing handoff run', async () => {
  await resetPipelineTestDatabase();
  const run = runFixture({ task_id: 'task-handoff-metrics' });
  await insertActiveRun(run);
  const completion = prepareCanonicalRunCompletion(run.id, {
    version: 1,
    harness: 'test',
    model: 'test-model',
    sessionId: 'handoff-session',
    durationMs: 10,
    exitCode: 0,
    status: 'success',
    usage: {
      inputTokens: 12,
      outputTokens: 4,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      reasoningOutputTokens: null,
      raw: null,
    },
    cost: null,
    costUsd: null,
    steps: 0,
    toolCalls: [],
  });
  await completion.persist('completed');
  const completed = await getActiveRunById(run.id);
  expect(completed?.status).toBe('completed');
  expect(completed?.tok_total).toBe(16);
});

test('executeTask applies an agent-selected handoff stage after the runner completes', async () => {
  await resetPipelineTestDatabase();
  const task = await createTask({
    project_id: 'project-handoff-completion',
    title: 'Handoff',
    description: '',
    status: 'in_progress',
    priority: 0,
  });
  const group = {
    name: 'Handoff',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      stages: [
        {
          id: 'backlog',
          title: 'Backlog',
          type: 'queue' as const,
          color: '#888',
        },
        {
          id: 'in_progress',
          title: 'In progress',
          type: 'active' as const,
          color: '#08f',
        },
        {
          id: 'question',
          title: 'Question',
          type: 'queue' as const,
          color: '#f90',
        },
        {
          id: 'testing',
          title: 'Testing',
          type: 'testing' as const,
          color: '#a3f',
        },
        {
          id: 'completed',
          title: 'Completed',
          type: 'done' as const,
          color: '#0a0',
        },
      ],
    },
  };
  const broadcasts = spyOn(wsEvents, 'broadcast');
  try {
    await executeTask(task, group, {
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          await insertActiveRun(
            runFixture({
              id: 'handoff-production-run',
              group_folder: task.project_id,
              task_id: task.id,
              stage: 'in_progress',
            }),
          );
          await input.onSlotAcquired?.('handoff-production-run');
          const response = await updateTaskTool.handler(
            { task_id: task.id, status: 'question' },
            {} as any,
            {
              group_folder: task.project_id,
              permissions: { '*': ['tasks:write'] },
              run_id: 'handoff-production-run',
            } as any,
          );
          expect(response).toContain('current run is ending');
          expect((await getTask(task.id))?.status).toBe('in_progress');
          await completeActiveRun('handoff-production-run', 'completed');
          return {
            status: 'success',
            result: 'handoff summary',
            newSessionId: 'question-session',
          } as any;
        },
      },
    });
    const moved = broadcasts.mock.calls
      .map(([event]) => event as any)
      .find(
        (event) =>
          event.type === 'task_updated' &&
          event.payload?.id === task.id &&
          event.payload?.status === 'question',
      );
    expect(
      JSON.parse(moved?.payload.custom_values?.recovery_transition ?? 'null'),
    ).toEqual({
      runId: 'handoff-production-run',
      stage: 'question',
      notice: false,
    });
  } finally {
    broadcasts.mockRestore();
  }
  const updated = await getTask(task.id);
  expect(updated?.status).toBe('question');
  expect(updated?.session_id).toBe('question-session');
  expect(updated?.completed_at).toBeNull();
  expect(updated?.custom_values?.recovery_transition).toBeUndefined();
  const handoffEntries = readTaskMessages(task.project_id, task.id);
  const request = handoffEntries.find(
    (message) => message.entry_type === 'stage_handoff_request',
  );
  expect(request).toMatchObject({
    source_stage: 'in_progress',
    target_stage: 'question',
    run_id: 'handoff-production-run',
  });
  expect(
    handoffEntries.filter(
      (message) =>
        message.entry_type === 'stage_handoff_delivery' &&
        message.prompt_id === request?.id,
    ),
  ).toHaveLength(1);
});

test('executeTask ignores a durable handoff from an unsuccessful prior run', async () => {
  await resetPipelineTestDatabase();
  const projectId = 'project-stale-failed-handoff';
  const task = await createTask({
    project_id: projectId,
    title: 'Failed handoff must not leak',
    description: '',
    status: 'in_progress',
    priority: 0,
  });
  const group = {
    name: 'Failed handoff retirement',
    folder: projectId,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      stages: [
        {
          id: 'in_progress',
          title: 'In progress',
          type: 'active' as const,
          color: '#08f',
        },
        {
          id: 'question',
          title: 'Question',
          type: 'queue' as const,
          color: '#f90',
        },
        {
          id: 'testing',
          title: 'Testing',
          type: 'testing' as const,
          color: '#a3f',
        },
        {
          id: 'completed',
          title: 'Completed',
          type: 'done' as const,
          color: '#0a0',
        },
        {
          id: 'failed',
          title: 'Failed',
          type: 'queue' as const,
          color: '#f00',
        },
      ],
    },
  };
  const failedRunId = 'failed-handoff-origin-run';
  await executeTask(task, group, {
    testDependencies: {
      runContainerAgent: async (_group, input) => {
        await insertActiveRun(
          runFixture({
            id: failedRunId,
            group_folder: projectId,
            task_id: task.id,
            stage: 'in_progress',
          }),
        );
        await input.onSlotAcquired?.(failedRunId);
        const response = await updateTaskTool.handler(
          { task_id: task.id, status: 'question' },
          {} as any,
          {
            group_folder: projectId,
            permissions: { '*': ['tasks:write'] },
            run_id: failedRunId,
          } as any,
        );
        expect(response).toContain('current run is ending');
        await completeActiveRun(failedRunId, 'error');
        return {
          status: 'error',
          result: '',
          error: 'provider failed after requesting handoff',
        } satisfies ContainerOutput;
      },
      runPostExecutionGitOps: async () => {},
      drainProjectQueue: async () => {},
    },
  });
  expect((await getTask(task.id))?.status).toBe('failed');
  const staleRequest = readTaskMessages(projectId, task.id).find(
    (message) => message.entry_type === 'stage_handoff_request',
  );
  expect(staleRequest).toMatchObject({
    run_id: failedRunId,
    source_stage: 'in_progress',
    target_stage: 'question',
  });

  await updateTask(task.id, { status: 'in_progress', error: '' });
  const successfulRunId = 'later-successful-run';
  await executeTask((await getTask(task.id))!, group, {
    testDependencies: {
      runContainerAgent: async (_group, input) => {
        await insertActiveRun(
          runFixture({
            id: successfulRunId,
            group_folder: projectId,
            task_id: task.id,
            stage: 'in_progress',
          }),
        );
        await input.onSlotAcquired?.(successfulRunId);
        await completeActiveRun(successfulRunId, 'completed');
        return {
          status: 'success',
          result: 'later run completed without a handoff',
        } satisfies ContainerOutput;
      },
      runPostExecutionGitOps: async () => {},
      drainProjectQueue: async () => {},
    },
  });

  expect((await getTask(task.id))?.status).toBe('testing');
  expect(
    readTaskMessages(projectId, task.id).some(
      (message) =>
        message.entry_type === 'stage_handoff_delivery' &&
        message.prompt_id === staleRequest?.id,
    ),
  ).toBe(false);
});

test('executeTask moves a zero-exit provider failure to failed instead of Testing', async () => {
  await resetPipelineTestDatabase();
  const task = await createTask({
    project_id: 'project-zero-exit-provider-failure',
    title: 'Provider failure',
    description: '',
    status: 'in_progress',
    priority: 0,
  });
  const group = {
    name: 'Provider failure',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      stages: [
        ...reviewLifecycleStages.slice(0, 2),
        {
          id: 'in_progress',
          title: 'In progress',
          type: 'active' as const,
          color: '#08f',
        },
        ...reviewLifecycleStages.slice(2),
      ],
    },
  };
  const providerError = 'invalid_encrypted_content';
  const events = [
    { type: 'run', status: 'started' },
    { type: 'run', status: 'failed', error: { message: providerError } },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');

  await executeTask(task, group, {
    testDependencies: {
      drainProjectQueue: async () => {},
      runContainerAgent: async () =>
        buildOutput(
          { events, stderr: '', isError: false },
          {
            result: providerError,
            hasAssistantText: false,
            agentSuccess: false,
            agentTerminalFailure: true,
          },
          group.name,
        ),
    },
  });

  expect(await getTask(task.id)).toMatchObject({
    status: 'failed',
    completed_at: expect.any(String),
  });
});

test('executeTask merges a done-stage handoff before persisting completed', async () => {
  await resetPipelineTestDatabase();
  const task = await createTask({
    project_id: 'project-done-handoff',
    title: 'Finalize handoff',
    description: '',
    status: 'in_progress',
    priority: 0,
    branch_name: 'task-finalize-handoff',
    worktree_path: '/repo/.worktrees/task-finalize-handoff',
  });
  const group = {
    name: 'Done handoff',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      taskCheckoutMode: 'worktree' as const,
      stages: [
        {
          id: 'backlog',
          title: 'Backlog',
          type: 'queue' as const,
          color: '#888',
        },
        {
          id: 'in_progress',
          title: 'In progress',
          type: 'active' as const,
          color: '#08f',
        },
        {
          id: 'completed',
          title: 'Completed',
          type: 'done' as const,
          color: '#0a0',
        },
      ],
    },
  };
  await updateTask(task.id, {
    worktree_path: '/repo/.worktrees/task-finalize-handoff',
  });
  const persistedTask = (await getTask(task.id))!;
  const events: string[] = [];

  await executeTask(persistedTask, group, {
    testDependencies: {
      runContainerAgent: async (_group, input) => {
        expect(input).toMatchObject({
          branch_name: 'task-finalize-handoff',
          worktree_path: '/repo/.worktrees/task-finalize-handoff',
        });
        expect(
          requestTaskStageHandoff(task.id, 'in_progress', 'completed'),
        ).toBe(true);
        return {
          status: 'success',
          result: 'handoff summary',
          newSessionId: 'completed-session',
        } as any;
      },
      mergeBranchForDeploy: async () => {
        expect((await getTask(task.id))?.status).toBe('in_progress');
        events.push('merge');
        await updateTask(task.id, {
          branch_name: null,
          worktree_path: null,
          merge_commit: '1234567890abcdef1234567890abcdef12345678',
        });
        return true;
      },
    },
  });

  const completed = await getTask(task.id);
  expect(events).toEqual(['merge']);
  expect(completed?.status).toBe('completed');
  expect(completed?.completed_at).not.toBeNull();
  expect(completed?.branch_name).toBeNull();
});
test('executeTask applies a stage handoff when the run is aborted by the handoff timeout', async () => {
  await resetPipelineTestDatabase();
  const task = await createTask({
    project_id: 'project-handoff-timeout',
    title: 'Handoff timeout',
    description: '',
    status: 'in_progress',
    priority: 0,
  });
  const group = {
    name: 'Handoff timeout',
    folder: task.project_id,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused' as const,
      stages: [
        {
          id: 'backlog',
          title: 'Backlog',
          type: 'queue' as const,
          color: '#888',
        },
        {
          id: 'in_progress',
          title: 'In progress',
          type: 'active' as const,
          color: '#08f',
        },
        {
          id: 'parked',
          title: 'Parked',
          type: 'queue' as const,
          color: '#aaa',
        },
      ],
    },
  };
  const drains: string[] = [];

  await executeTask((await getTask(task.id))!, group, {
    testDependencies: {
      runContainerAgent: async (_group, input) => {
        // The agent requests the move and keeps working: the grace period
        // expires, so the board aborts the run with the timeout reason.
        expect(
          requestTaskStageHandoff(task.id, 'in_progress', 'parked', {
            steerAgentProcess: async () => true,
            interruptAgentTurn: async () => false,
            killAgentProcess: async () => true,
            schedule: ((callback: () => Promise<void>) => {
              void callback();
              return 0 as any;
            }) as typeof setTimeout,
          }),
        ).toBe(true);
        await new Promise<void>((resolve) =>
          input.signal!.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        return { status: 'error', result: null, error: 'aborted' } as any;
      },
      runPostExecutionGitOps: async () => {},
      drainProjectQueue: async () => {
        drains.push(task.project_id);
      },
    },
  });

  expect(await getTask(task.id)).toMatchObject({
    status: 'parked',
    error: '',
  });
  expect(drains).toHaveLength(1);
});

describe('dataset task progress', () => {
  useCleanPipelineTestDatabase();

  test('system-attributed rows inherit the project owner', async () => {
    await drizzleDbRef.current.insert(users).values({
      id: 'dataset-owner',
      username: 'dataset-owner',
      password_hash: 'x',
      created_at: '2026-08-08T07:00:00.000Z',
    });
    await drizzleDbRef.current.insert(projects).values({
      id: 'dataset-owner-project',
      jid: 'dataset-owner@board',
      name: 'Dataset owner',
      folder: 'dataset-owner-project',
      trigger: '@bot',
      added_at: '2026-08-08T07:00:00.000Z',
      user_id: 'dataset-owner',
    });
    const datasetTask = await createDatasetTask({
      project_id: 'dataset-owner-project',
      title: 'Rows',
      description: 'Row',
      dataset: [{}],
      total_rows: 1,
      status: 'active',
    });
    const row = await createDatasetRowTask({
      project_id: datasetTask.project_id,
      title: 'Row 1',
      description: 'Row',
      status: 'in_progress',
      priority: 0,
      dataset_task_id: datasetTask.id,
      dataset_row_index: 0,
      author: 'dataset_task',
    });

    expect(row).toMatchObject({
      ownerUserId: 'dataset-owner',
      lastTriggeredByUserId: null,
      lastTriggerSource: 'system',
      owner: { id: 'dataset-owner', username: 'dataset-owner' },
      latestTrigger: { user: null, source: 'system' },
    });
    expect(row?.lastTriggeredAt).toBeTruthy();
  });

  test('copies the dataset runtime selection to each spawned task', async () => {
    const projectId = 'dataset-runtime-selection';
    const runtimeSelection = {
      harnessId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoning: 'high',
    };
    const datasetTask = await createDatasetTask({
      project_id: projectId,
      title: 'Process {{name}}',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }],
      total_rows: 1,
      model: 'legacy-model',
      agent_name: 'legacy-agent',
      runtimeSelection,
      status: 'active',
    });
    const group = {
      folder: projectId,
      settings: {
        status: 'paused' as const,
        stages: [
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active' as const,
            color: '#888',
          },
        ],
      },
    } as any;

    const task = await spawnNextDatasetRow(datasetTask, group, {
      manual: true,
    });
    expect(task?.runtimeSelection).toEqual(runtimeSelection);
    expect(task && 'model' in task).toBe(false);
    expect(task && 'agent_name' in task).toBe(false);
    expect((await getDatasetTask(datasetTask.id))?.runtimeSelection).toEqual(
      runtimeSelection,
    );
  });

  test('waits for an active objective during automatic spawning but allows manual run', async () => {
    const projectId = 'paused-objective-dataset';
    const objective = await createObjective({
      project_id: projectId,
      title: 'Paused dataset owner',
      description: '',
      status: 'paused',
      priority: 0,
      progress: 0,
      deadline: null,
      metadata: null,
      trigger_config: null,
    });
    const datasetTask = await createDatasetTask({
      project_id: projectId,
      title: 'Process {{name}}',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }],
      total_rows: 1,
      objective_id: objective.id,
      status: 'active',
    });
    const group = {
      folder: projectId,
      settings: {
        status: 'paused' as const,
        stages: [
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active' as const,
            color: '#888',
          },
        ],
      },
    } as any;

    expect(await spawnNextDatasetRow(datasetTask, group)).toBeNull();
    expect(await getTasksByProject(projectId)).toHaveLength(0);
    expect(
      await spawnNextDatasetRow(datasetTask, group, { manual: true }),
    ).toMatchObject({ objective_id: objective.id });
  });

  const activeStage = {
    id: 'in_progress',
    title: 'In progress',
    type: 'active' as const,
    color: '#888',
  };
  const reviewStage = {
    id: 'review',
    title: 'Review',
    type: 'review' as const,
    color: '#888',
  };
  const doneStage = {
    id: 'completed',
    title: 'Completed',
    type: 'done' as const,
    color: '#888',
  };

  test('does not advance after a non-terminal implementation or review turn', () => {
    expect(shouldAdvanceDatasetProgress(false, activeStage)).toBe(false);
    expect(shouldAdvanceDatasetProgress(false, reviewStage)).toBe(false);
  });

  test('advances after completion or a genuine execution failure', () => {
    expect(shouldAdvanceDatasetProgress(false, doneStage)).toBe(true);
    expect(shouldAdvanceDatasetProgress(true, activeStage)).toBe(true);
  });

  test('claims each dataset row once across duplicate or stale completions', async () => {
    const datasetTask = await createDatasetTask({
      project_id: 'dataset-progress-project',
      title: 'Process rows',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }, { name: 'second' }, { name: 'third' }],
      total_rows: 3,
      status: 'active',
    });
    const firstRowTask = await createDatasetRowTask({
      project_id: datasetTask.project_id,
      title: 'Process first [1/3]',
      description: 'Process first',
      status: 'in_progress',
      priority: 0,
      dataset_task_id: datasetTask.id,
      dataset_row_index: 0,
      author: 'dataset_task',
    });
    expect(firstRowTask).toBeTruthy();

    const duplicateResults = await Promise.all([
      incrementDatasetTaskProgress(firstRowTask!.id),
      incrementDatasetTaskProgress(firstRowTask!.id),
    ]);

    expect(duplicateResults.filter(Boolean)).toHaveLength(1);
    expect(await getDatasetTask(datasetTask.id)).toMatchObject({
      completed_rows: 1,
      current_row_index: 1,
      status: 'active',
    });

    // Replaying an older completed card must not claim the current row.
    expect(
      await incrementDatasetTaskProgress(firstRowTask!.id),
    ).toBeUndefined();
    expect(await getDatasetTask(datasetTask.id)).toMatchObject({
      completed_rows: 1,
      current_row_index: 1,
    });

    const secondRowTask = await createDatasetRowTask({
      project_id: datasetTask.project_id,
      title: 'Process second [2/3]',
      description: 'Process second',
      status: 'in_progress',
      priority: 0,
      dataset_task_id: datasetTask.id,
      dataset_row_index: 1,
      author: 'dataset_task',
    });
    expect(secondRowTask).toBeTruthy();
    expect(await incrementDatasetTaskProgress(secondRowTask!.id)).toMatchObject(
      {
        completed_rows: 2,
        current_row_index: 2,
      },
    );
  });

  test('creates one row task when recovery and resume spawn concurrently', async () => {
    const projectId = 'dataset-spawn-race-project';
    const objective = await createObjective({
      project_id: projectId,
      title: 'Active dataset owner',
      description: '',
      status: 'active',
      priority: 0,
      progress: 0,
      deadline: null,
      metadata: null,
      trigger_config: null,
    });
    const datasetTask = await createDatasetTask({
      project_id: projectId,
      title: 'Process rows',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }, { name: 'second' }],
      total_rows: 2,
      objective_id: objective.id,
      status: 'active',
    });
    expect((await getDatasetTask(datasetTask.id))?.objective_id).toBe(
      objective.id,
    );
    const group = {
      folder: projectId,
      name: 'Dataset spawn race project',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active' as const,
            color: '#888',
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done' as const,
            color: '#888',
          },
        ],
      },
    };

    // These are the same two calls recovery and startup resume make after
    // independently observing that the current row needs a task.
    const spawned = await Promise.all([
      spawnNextDatasetRow(datasetTask, group),
      spawnNextDatasetRow(datasetTask, group),
    ]);

    expect(spawned.filter(Boolean)).toHaveLength(1);
    expect(spawned.find(Boolean)?.objective_id).toBe(objective.id);
    expect(await getTasksByProject(projectId)).toHaveLength(1);
    const original = spawned.find(Boolean)!;

    // An explicit restart resets the spawn claim so row 0 can run again.
    await updateDatasetTask(datasetTask.id, {
      current_row_index: 0,
      completed_rows: 0,
      status: 'active',
    });
    const replacement = await spawnNextDatasetRow(datasetTask, group);
    expect(replacement).toBeTruthy();
    expect(await getTasksByProject(projectId)).toHaveLength(2);

    // The pre-restart task carries the older generation and cannot advance the
    // restarted dataset even if it finishes before the replacement.
    expect(await incrementDatasetTaskProgress(original.id)).toBeUndefined();
    expect(await getDatasetTask(datasetTask.id)).toMatchObject({
      completed_rows: 0,
      current_row_index: 0,
    });
    expect(await incrementDatasetTaskProgress(replacement!.id)).toMatchObject({
      completed_rows: 1,
      current_row_index: 1,
    });
  });

  test('does not spawn from a stale snapshot after the dataset is archived', async () => {
    const projectId = 'dataset-archive-race-project';
    const datasetTask = await createDatasetTask({
      project_id: projectId,
      title: 'Archive before spawn',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }],
      total_rows: 1,
      status: 'active',
    });
    const group = {
      folder: projectId,
      name: 'Dataset archive race project',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active' as const,
            color: '#888',
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done' as const,
            color: '#888',
          },
        ],
      },
    };

    // `datasetTask` is the stale object captured before the concurrent PATCH.
    await updateDatasetTask(datasetTask.id, { archived: true });
    expect(await spawnNextDatasetRow(datasetTask, group)).toBeNull();
    expect(await getTasksByProject(projectId)).toHaveLength(0);

    // A rejected archived claim must not consume the row permanently.
    await updateDatasetTask(datasetTask.id, { archived: false });
    expect(await spawnNextDatasetRow(datasetTask, group)).toBeTruthy();
    expect(await getTasksByProject(projectId)).toHaveLength(1);
  });

  test('resume recreates the current row task after it is deleted', async () => {
    const projectId = 'dataset-missing-row-project';
    const datasetTask = await createDatasetTask({
      project_id: projectId,
      title: 'Recover missing row',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }],
      total_rows: 1,
      status: 'active',
    });
    const group = {
      folder: projectId,
      name: 'Dataset missing row project',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active' as const,
            color: '#888',
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done' as const,
            color: '#888',
          },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));

    const original = await spawnNextDatasetRow(datasetTask, group);
    expect(original).toBeTruthy();
    await deleteTask(original!.id);
    expect(await getTasksByProject(projectId)).toHaveLength(0);

    await resumeActiveDatasetTasks();

    const recovered = await getTasksByProject(projectId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].id).not.toBe(original!.id);
    expect(recovered[0]).toMatchObject({
      dataset_task_id: datasetTask.id,
      dataset_row_index: 0,
    });
  });

  const datasetResumeStages = [
    { id: 'backlog', title: 'Backlog', type: 'queue' as const, color: '#888' },
    {
      id: 'in_progress',
      title: 'In progress',
      type: 'active' as const,
      color: '#888',
    },
    {
      id: 'question',
      title: 'Question',
      type: 'queue' as const,
      color: '#888',
    },
    { id: 'failed', title: 'Failed', type: 'queue' as const, color: '#888' },
    {
      id: 'completed',
      title: 'Completed',
      type: 'done' as const,
      color: '#888',
    },
  ];

  test('resume advances the dataset when the current row is stuck in the failed stage', async () => {
    const projectId = 'dataset-failed-row-project';
    const datasetTask = await createDatasetTask({
      project_id: projectId,
      title: 'Process rows',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }, { name: 'second' }],
      total_rows: 2,
      status: 'active',
    });
    const group = {
      folder: projectId,
      name: 'Dataset failed row project',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: { status: 'paused' as const, stages: datasetResumeStages },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));

    const rowTask = await spawnNextDatasetRow(datasetTask, group);
    expect(rowTask).toBeTruthy();

    // Simulate the crash window: the row was moved to the failed stage, but
    // the dataset progress increment never ran before the restart.
    await updateTask(rowTask!.id, { status: 'failed' });

    await resumeActiveDatasetTasks();

    expect(await getDatasetTask(datasetTask.id)).toMatchObject({
      completed_rows: 1,
      current_row_index: 1,
      status: 'active',
    });
    const rows = await getTasksByProject(projectId);
    expect(rows).toHaveLength(2);
    expect(rows.find((t) => t.dataset_row_index === 1)).toMatchObject({
      dataset_task_id: datasetTask.id,
    });
  });

  test('resume advances the dataset when the failed row is parked in the fallback queue stage', async () => {
    const projectId = 'dataset-failed-fallback-project';
    const datasetTask = await createDatasetTask({
      project_id: projectId,
      title: 'Process rows',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }, { name: 'second' }],
      total_rows: 2,
      status: 'active',
    });
    const group = {
      folder: projectId,
      name: 'Dataset failed fallback project',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        // No explicit 'failed' stage: failure parking (getFailedStage)
        // falls back to the first queue stage, 'backlog'.
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active' as const,
            color: '#888',
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done' as const,
            color: '#888',
          },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));

    const rowTask = await spawnNextDatasetRow(datasetTask, group);
    expect(rowTask).toBeTruthy();

    // Simulate the crash window: the failed row was parked in the fallback
    // queue stage (with the failure markers the parking sites always set),
    // but the dataset progress increment never ran before the restart.
    await updateTask(rowTask!.id, {
      status: 'backlog',
      error: 'boom',
      completed_at: new Date().toISOString(),
    });

    await resumeActiveDatasetTasks();

    expect(await getDatasetTask(datasetTask.id)).toMatchObject({
      completed_rows: 1,
      current_row_index: 1,
      status: 'active',
    });
    const rows = await getTasksByProject(projectId);
    expect(rows).toHaveLength(2);
    expect(rows.find((t) => t.dataset_row_index === 1)).toMatchObject({
      dataset_task_id: datasetTask.id,
    });
  });

  test('resume does not advance the dataset while the current row awaits input', async () => {
    const projectId = 'dataset-question-row-project';
    const datasetTask = await createDatasetTask({
      project_id: projectId,
      title: 'Process rows',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }, { name: 'second' }],
      total_rows: 2,
      status: 'active',
    });
    const group = {
      folder: projectId,
      name: 'Dataset question row project',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: { status: 'paused' as const, stages: datasetResumeStages },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));

    const rowTask = await spawnNextDatasetRow(datasetTask, group);
    expect(rowTask).toBeTruthy();
    await updateTask(rowTask!.id, { status: 'question' });

    await resumeActiveDatasetTasks();

    // The row is parked for user input, so the dataset must wait and must not
    // spawn a duplicate row task.
    expect(await getDatasetTask(datasetTask.id)).toMatchObject({
      completed_rows: 0,
      current_row_index: 0,
      status: 'active',
    });
    expect(await getTasksByProject(projectId)).toHaveLength(1);
  });

  test('resume advances the dataset when the current row reached a done stage', async () => {
    const projectId = 'dataset-done-row-project';
    const datasetTask = await createDatasetTask({
      project_id: projectId,
      title: 'Process rows',
      description: 'Process {{name}}',
      dataset: [{ name: 'first' }],
      total_rows: 1,
      status: 'active',
    });
    const group = {
      folder: projectId,
      name: 'Dataset done row project',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: { status: 'paused' as const, stages: datasetResumeStages },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));

    const rowTask = await spawnNextDatasetRow(datasetTask, group);
    expect(rowTask).toBeTruthy();
    await updateTask(rowTask!.id, { status: 'completed' });

    await resumeActiveDatasetTasks();

    expect(await getDatasetTask(datasetTask.id)).toMatchObject({
      completed_rows: 1,
      current_row_index: 1,
      status: 'completed',
    });
    expect(await getTasksByProject(projectId)).toHaveLength(1);
  });
});

describe('project queue drain serialization', () => {
  useCleanPipelineTestDatabase();

  test('only auto-starts objective-linked tasks while their objective is active', () => {
    const statuses = new Map([
      ['obj-active', 'active'],
      ['obj-paused', 'paused'],
    ]);
    expect(
      _testOnlyCanAutoStartTaskForObjectives({ id: 'unowned' }, statuses),
    ).toBe(true);
    expect(
      _testOnlyCanAutoStartTaskForObjectives(
        { id: 'active-task', objective_id: 'obj-active' },
        statuses,
      ),
    ).toBe(true);
    expect(
      _testOnlyCanAutoStartTaskForObjectives(
        { id: 'paused-task', objective_id: 'obj-paused' },
        statuses,
      ),
    ).toBe(false);
    expect(
      _testOnlyCanAutoStartTaskForObjectives(
        { id: 'manual-task', objective_id: 'obj-paused' },
        statuses,
        'manual-task',
      ),
    ).toBe(true);
  });

  test('reruns a drain when another request arrives during the active pass', async () => {
    const projectId = `drain-race-${Date.now()}`;
    let releaseFirstPass!: () => void;
    const firstPassBlocked = new Promise<void>((resolve) => {
      releaseFirstPass = resolve;
    });
    let firstPassStarted!: () => void;
    const firstPassDidStart = new Promise<void>((resolve) => {
      firstPassStarted = resolve;
    });
    let passes = 0;

    const activeDrain = _testOnlyRunSerializedProjectDrain(
      projectId,
      async () => {
        passes += 1;
        if (passes === 1) {
          firstPassStarted();
          await firstPassBlocked;
        }
      },
    );

    await firstPassDidStart;
    await _testOnlyRunSerializedProjectDrain(projectId, async () => {
      throw new Error('the lock owner should perform the follow-up pass');
    });
    releaseFirstPass();
    await activeDrain;

    expect(passes).toBe(2);
  });

  test('honors a pending drain after the active pass rejects', async () => {
    const projectId = `drain-rejection-race-${Date.now()}`;
    let rejectFirstPass!: () => void;
    const firstPassBlocked = new Promise<void>((_resolve, reject) => {
      rejectFirstPass = () => reject(new Error('first drain failed'));
    });
    let firstPassStarted!: () => void;
    const firstPassDidStart = new Promise<void>((resolve) => {
      firstPassStarted = resolve;
    });
    let passes = 0;

    const activeDrain = _testOnlyRunSerializedProjectDrain(
      projectId,
      async () => {
        passes += 1;
        if (passes === 1) {
          firstPassStarted();
          await firstPassBlocked;
        }
      },
    );

    await firstPassDidStart;
    await _testOnlyRunSerializedProjectDrain(projectId, async () => {
      throw new Error('the lock owner should perform the follow-up pass');
    });
    rejectFirstPass();

    await expect(activeDrain).rejects.toThrow('first drain failed');
    expect(passes).toBe(2);
  });
});

describe('getRunningTaskIds', () => {
  test('finishes the exact owned run before a newer run can be affected', () => {
    const events: unknown[] = [];
    const oldAbort = _testOnlyRegisterRunning(
      'task-run-finished-race',
      'proj-a',
    );
    expect(
      finishOwnedTaskExecution(
        'task-run-finished-race',
        'proj-a',
        oldAbort,
        'run-old',
        (event) => events.push(event),
      ),
    ).toBe(true);

    const newAbort = _testOnlyRegisterRunning(
      'task-run-finished-race',
      'proj-a',
    );
    expect(
      finishOwnedTaskExecution(
        'task-run-finished-race',
        'proj-a',
        oldAbort,
        'run-old',
        (event) => events.push(event),
      ),
    ).toBe(false);
    expect(events).toEqual([
      {
        type: 'run_finished',
        payload: {
          project_id: 'proj-a',
          task_id: 'task-run-finished-race',
          run_id: 'run-old',
        },
      },
    ]);
    expect(getRunningTaskIds()).toContain('task-run-finished-race');
    finishOwnedTaskExecution(
      'task-run-finished-race',
      'proj-a',
      newAbort,
      'run-new',
      (event) => events.push(event),
    );
  });
});

describe('authoritative waiting projection', () => {
  useCleanPipelineTestDatabase();

  test('waits behind the only running slot and excludes every ineligible state', async () => {
    const projectId = 'waiting-projection';
    const group = {
      name: 'Waiting projection',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as 'running' | 'paused',
        maxParallelWorktrees: 1,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'testing' as const,
            color: '#f80',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
          {
            id: 'failed',
            title: 'Failed',
            type: 'queue' as const,
            color: '#d33',
          },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));

    const waiting = await createTask({
      project_id: projectId,
      title: 'Advanced A',
      description: '',
      status: 'testing',
      priority: 5,
    });
    const running = await createTask({
      project_id: projectId,
      title: 'Higher priority B',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    const unfinishedDependency = await createTask({
      project_id: projectId,
      title: 'Unfinished dependency',
      description: '',
      status: 'backlog',
      priority: 99,
    });
    await createTask({
      project_id: projectId,
      title: 'Dependency blocked',
      description: '',
      status: 'implementation',
      priority: 1,
      depends_on_ids: [unfinishedDependency.id],
    });
    const objective = await createObjective({
      project_id: projectId,
      title: 'Inactive objective',
      description: '',
      status: 'paused',
      priority: 0,
      progress: 0,
    });
    await createTask({
      project_id: projectId,
      title: 'Inactive objective task',
      description: '',
      status: 'implementation',
      priority: 2,
      objective_id: objective.id,
    });
    const errored = await createTask({
      project_id: projectId,
      title: 'Errored',
      description: '',
      status: 'implementation',
      priority: 3,
      error: 'previous failure',
    });
    await createTask({
      project_id: projectId,
      title: 'Execution gated',
      description: '',
      status: 'implementation',
      priority: 4,
      execute_in_stage: 'testing',
    });

    const runningAbort = _testOnlyRegisterRunning(running.id, projectId);
    const projected = await getWaitingTaskIds(projectId);
    // An error marker must not remove a task from the queue candidate
    // projection: transient-retry tasks keep their "Retry scheduled:"
    // marker in an executable stage until the delayed retry's pre-flight
    // clears it, and the drain must be able to re-select them. Display
    // consumers hide the waiting marker for errored tasks instead.
    expect(projected).toEqual([errored.id, waiting.id]);

    group.settings.status = 'paused';
    expect(await getWaitingTaskIds(projectId)).toEqual([]);
    group.settings.status = 'running';
    finishOwnedTaskExecution(running.id, projectId, runningAbort, 'run-b');
  });

  test('excludes archived cards from the waiting projection and queue drain', async () => {
    const projectId = 'archived-drain';
    const group = {
      name: 'Archived drain',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as 'running' | 'paused',
        maxParallelWorktrees: 1,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));

    // Archived at create time (archived column set on insert).
    const archivedAtCreate = await createTask({
      project_id: projectId,
      title: 'Archived at create',
      description: '',
      status: 'implementation',
      priority: 0,
      archived: true,
    });
    // Archived via the flip path: MCP archive_task / the bulk route only set
    // the boolean; the stage never changes.
    const flipped = await createTask({
      project_id: projectId,
      title: 'Archived after flip',
      description: '',
      status: 'implementation',
      priority: 1,
    });
    await updateTask(flipped.id, { archived: true });
    const live = await createTask({
      project_id: projectId,
      title: 'Live control',
      description: '',
      status: 'implementation',
      priority: 2,
    });

    // Both archived rows must leave the candidate projection while the live
    // control card stays eligible.
    expect(await getWaitingTaskIds(projectId)).toEqual([live.id]);

    const started: string[] = [];
    await drainProjectQueue(projectId, group, {
      testDependencies: {
        executeTask: async (task) => {
          started.push(task.id);
        },
      },
    });
    expect(started).toEqual([live.id]);
    expect(started).not.toContain(archivedAtCreate.id);
    expect(started).not.toContain(flipped.id);
  });

  test('holds new task launches while the sandbox has a pending idle restart', async () => {
    const projectId = 'idle-restart-hold';
    const group = {
      name: 'Idle restart hold',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const task = await createTask({
      project_id: projectId,
      title: 'Held task',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    const started: string[] = [];
    const testDependencies = {
      executeTask: async (queued: { id: string }) => {
        started.push(queued.id);
      },
    };
    const pending = spyOn(idleRestart, 'isTaskLaunchHeld').mockReturnValue(
      true,
    );
    try {
      await drainProjectQueue(projectId, group, { testDependencies });
      expect(pending).toHaveBeenCalledWith(projectId);
      expect(started).toEqual([]);
      expect((await getTask(task.id))?.status).toBe('implementation');
    } finally {
      pending.mockRestore();
    }

    await drainProjectQueue(projectId, group, { testDependencies });
    expect(started).toEqual([task.id]);
  });

  test("gates a task tagged with another project's objective by that objective status", async () => {
    const projectId = `cross-objective-${Date.now()}`;
    const group = {
      name: 'Cross objective',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const objective = await createObjective({
      project_id: `${projectId}-parent`,
      title: 'Parent-owned objective',
      description: '',
      status: 'active',
      priority: 0,
      progress: 0,
    });
    const task = await createTask({
      project_id: projectId,
      title: 'Cross-project objective task',
      description: '',
      status: 'implementation',
      priority: 0,
      objective_id: objective.id,
    });

    expect(await getWaitingTaskIds(projectId)).toEqual([task.id]);
    await updateObjective(objective.id, { status: 'paused' });
    expect(await getWaitingTaskIds(projectId)).toEqual([]);
  });

  test('manual isolated claims do not suppress automatic capacity after an automatic release', async () => {
    const projectId = `manual-capacity-drain-${Date.now()}`;
    const group = {
      name: 'Manual capacity drain',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        maxParallelWorktrees: 1,
        taskCheckoutMode: 'worktree' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const candidate = await createTask({
      project_id: projectId,
      title: 'Automatic candidate',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    const automaticClaim = _testOnlyTryClaimTaskExecution(
      `${projectId}-automatic`,
      projectId,
    )!;
    const manualClaim = _testOnlyTryClaimTaskExecution(
      `${projectId}-manual`,
      projectId,
      true,
    )!;
    const started: string[] = [];
    const drain = () =>
      drainProjectQueue(projectId, group, {
        testDependencies: {
          executeTask: async (task) => {
            started.push(task.id);
          },
        },
      });

    try {
      await drain();
      expect(started).toEqual([]);

      _testOnlyReleaseTaskExecutionClaim(
        `${projectId}-automatic`,
        automaticClaim,
      );
      await drain();
      expect(started).toEqual([candidate.id]);
    } finally {
      _testOnlyReleaseTaskExecutionClaim(
        `${projectId}-automatic`,
        automaticClaim,
      );
      _testOnlyReleaseTaskExecutionClaim(`${projectId}-manual`, manualClaim);
    }
  });

  test('releases an advanced run before the drain selects a higher-priority task', async () => {
    const projectId = 'handoff-priority-drain';
    const group = {
      name: 'Handoff priority drain',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        maxParallelWorktrees: 1,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'active' as const,
            color: '#f80',
          },
          {
            id: 'review',
            title: 'Review',
            type: 'active' as const,
            color: '#c6f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const advanced = await createTask({
      project_id: projectId,
      title: 'Advanced A',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    const higherPriority = await createTask({
      project_id: projectId,
      title: 'Higher priority B',
      description: '',
      status: 'review',
      priority: -99,
    });
    let started = 0;
    let releaseHigherPriority!: () => void;
    const higherPriorityRun = new Promise<void>((resolve) => {
      releaseHigherPriority = resolve;
    });
    let higherPriorityAbort: AbortController | undefined;
    const runAgent = async (_group: unknown, input: ContainerInput) => {
      started++;
      await Promise.resolve(input.onSlotAcquired?.(`priority-run-${started}`));
      if (started === 1) {
        expect(
          requestTaskStageHandoff(advanced.id, 'implementation', 'testing'),
        ).toBe(true);
      }
      return { status: 'success', result: 'advanced' } as any;
    };

    let markStarted!: () => void;
    const higherPriorityStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    await executeTask(advanced, group, {
      testDependencies: {
        runContainerAgent: runAgent,
        drainProjectQueue: (id, drainGroup) => {
          setGroupResolver((candidateId) =>
            candidateId === projectId ? group : undefined,
          );
          return drainProjectQueue(id, drainGroup, {
            testDependencies: {
              executeTask: async () => {
                started++;
                higherPriorityAbort = _testOnlyRegisterRunning(
                  higherPriority.id,
                  projectId,
                );
                markStarted();
                await higherPriorityRun;
              },
            },
          });
        },
      },
    });

    // The release-triggered drain must choose B, while A remains an eligible
    // executable-stage task waiting behind B's newly acquired slot.
    await higherPriorityStarted;
    expect(started).toBe(2);
    expect(getRunningTaskIds()).toContain(higherPriority.id);
    expect(await getWaitingTaskIds(projectId)).toContain(advanced.id);
    releaseHigherPriority();
    if (higherPriorityAbort)
      finishOwnedTaskExecution(
        higherPriority.id,
        projectId,
        higherPriorityAbort,
        'priority-run-2',
      );
  });

  test('keeps an advanced task waiting when reduced parallelism leaves no slot', async () => {
    const projectId = 'handoff-reduced-parallelism';
    const group = {
      name: 'Handoff reduced parallelism',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        maxParallelWorktrees: 2,
        taskCheckoutMode: 'worktree' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'active' as const,
            color: '#f80',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const advanced = await createTask({
      project_id: projectId,
      title: 'Advanced A',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    const other = await createTask({
      project_id: projectId,
      title: 'Other run',
      description: '',
      status: 'testing',
      priority: 0,
    });
    const otherAbort = _testOnlyRegisterRunning(other.id, projectId);
    let agentCalls = 0;
    const runAgent = async (_group: unknown, input: ContainerInput) => {
      agentCalls++;
      await Promise.resolve(
        input.onSlotAcquired?.(`reduced-run-${agentCalls}`),
      );
      expect(
        requestTaskStageHandoff(advanced.id, 'implementation', 'testing'),
      ).toBe(true);
      group.settings.maxParallelWorktrees = 1;
      return { status: 'success', result: 'advanced' } as any;
    };

    await executeTask(advanced, group, {
      testDependencies: {
        runContainerAgent: runAgent,
        drainProjectQueue: (id, drainGroup) =>
          drainProjectQueue(id, drainGroup, {
            testDependencies: { runContainerAgent: runAgent },
          }),
      },
    });

    expect(agentCalls).toBe(1);
    expect(await getWaitingTaskIds(projectId)).toContain(advanced.id);
    finishOwnedTaskExecution(other.id, projectId, otherAbort, 'other-run');
  });

  test('immediate same-task continuation claims a new run and is not projected as waiting', async () => {
    const projectId = 'handoff-immediate-continuation';
    const group = {
      name: 'Handoff immediate continuation',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        maxParallelWorktrees: 1,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'active' as const,
            color: '#f80',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const task = await createTask({
      project_id: projectId,
      title: 'Continue A',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    let calls = 0;
    let continuationAbort: AbortController | undefined;
    let releaseSecond!: () => void;
    const secondRun = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const runAgent = async (_group: unknown, input: ContainerInput) => {
      calls++;
      await Promise.resolve(
        input.onSlotAcquired?.(`continuation-run-${calls}`),
      );
      if (calls === 1) {
        expect(
          requestTaskStageHandoff(task.id, 'implementation', 'testing'),
        ).toBe(true);
        return { status: 'success', result: 'advanced' } as any;
      }
      await secondRun;
      return { status: 'success', result: 'tested' } as any;
    };

    let markStarted!: () => void;
    const continuationStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    await executeTask(task, group, {
      testDependencies: {
        runContainerAgent: runAgent,
        drainProjectQueue: (id, drainGroup) => {
          setGroupResolver((candidateId) =>
            candidateId === projectId ? group : undefined,
          );
          return drainProjectQueue(id, drainGroup, {
            testDependencies: {
              executeTask: async () => {
                calls++;
                continuationAbort = _testOnlyRegisterRunning(
                  task.id,
                  projectId,
                );
                markStarted();
                await secondRun;
              },
            },
          });
        },
      },
    });

    await continuationStarted;
    expect(calls).toBe(2);
    expect(getRunningTaskIds()).toContain(task.id);
    expect(await getWaitingTaskIds(projectId)).not.toContain(task.id);
    releaseSecond();
    if (continuationAbort)
      finishOwnedTaskExecution(
        task.id,
        projectId,
        continuationAbort,
        'continuation-run-2',
      );
  });
  test('delivers a pending prompt through the run boundary and receipts it once', async () => {
    const projectId = 'steering-run-boundary';
    const group = {
      name: 'Steering run boundary',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'active' as const,
            color: '#f80',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    const task = await createTask({
      project_id: projectId,
      title: 'Steering boundary title',
      description: 'Steering boundary original description',
      status: 'implementation',
      priority: 0,
    });
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const executionClaim = _testOnlyTryClaimTaskExecution(task.id, projectId)!;
    const firstDelivery = await appendTaskSteeringMessage(
      projectId,
      task.id,
      'check the pending request',
    );
    const secondDelivery = await appendTaskSteeringMessage(
      projectId,
      task.id,
      'then verify the result',
    );
    expect(firstDelivery.accepted).toBe(false);
    expect(secondDelivery.accepted).toBe(false);
    const prompt = firstDelivery.message;
    const secondPrompt = secondDelivery.message;
    let capturedPrompt = '';
    await executeTask(task, group, {
      executionClaim,
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          capturedPrompt = input.prompt;
          await input.onSlotAcquired?.('steering-boundary-run');
          await input.onPromptRunAssigned?.('steering-boundary-run');
          await input.onPromptRunAccepted?.('steering-boundary-run');
          return {
            status: 'success',
            result: 'completed',
            newSessionId: 'steering-session-1',
          } satisfies ContainerOutput;
        },
        drainProjectQueue: async () => {},
        runPostExecutionGitOps: async () => {},
      },
    });
    expect(capturedPrompt).toContain(task.title);
    expect(capturedPrompt).toContain(task.description);
    expect(capturedPrompt.indexOf(task.description)).toBeLessThan(
      capturedPrompt.indexOf(prompt.content),
    );
    expect(capturedPrompt.indexOf(prompt.content)).toBeLessThan(
      capturedPrompt.indexOf(secondPrompt.content),
    );
    const receipts = readTaskMessages(projectId, task.id).filter(
      (message) =>
        message.entry_type === 'steering_delivery' &&
        (message.prompt_id === prompt.id ||
          message.prompt_id === secondPrompt.id),
    );
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.prompt_id)).toEqual([
      prompt.id,
      secondPrompt.id,
    ]);
    expect(
      receipts.every((receipt) => receipt.run_id === 'steering-boundary-run'),
    ).toBe(true);
    expect(readTaskMessages(projectId, task.id)).toContainEqual(receipts[0]);
    expect((await getTask(task.id))?.session_id).toBe('steering-session-1');
    expect(
      splitFollowUpsFromHistory(readTaskMessages(projectId, task.id))
        .newUserMessages,
    ).not.toEqual(expect.arrayContaining([prompt, secondPrompt]));
  });
  test('holds and continues a queued tool prompt in the shared ordered delivery stream', async () => {
    const projectId = 'stage-tool-steering-run-boundary';
    const group = {
      name: 'Stage tool steering boundary',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    const task = await createTask({
      project_id: projectId,
      title: 'Deliver mixed pending prompts',
      description: 'Initial task description',
      status: 'implementation',
      priority: 0,
    });
    setGroupResolver((id) => (id === projectId ? group : undefined));

    let stagePromptId = '';
    let userPromptId = '';
    let continuationPrompt = '';
    let agentRuns = 0;
    let continuationExecution: Promise<void> | undefined;
    let markContinuationStarted!: () => void;
    const continuationStarted = new Promise<void>((resolve) => {
      markContinuationStarted = resolve;
    });
    const continuationOptions = {
      testDependencies: {
        runContainerAgent: async (_group: unknown, input: ContainerInput) => {
          agentRuns++;
          continuationPrompt = input.prompt;
          await input.onSlotAcquired?.('stage-tool-continuation');
          await input.onPromptRunAssigned?.('stage-tool-continuation');
          await input.onPromptRunAccepted?.('stage-tool-continuation');
          markContinuationStarted();
          return {
            status: 'success',
            result: 'continued once',
          } satisfies ContainerOutput;
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    };
    let drainCalls = 0;

    await executeTask(task, group, {
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          agentRuns++;
          await input.onSlotAcquired?.('stage-tool-original');
          return {
            status: 'success',
            result: 'original run completed before delivery',
          } satisfies ContainerOutput;
        },
        afterSuccessfulAgentRun: async () => {
          const stagePrompt = await appendTaskStagePrompt(
            projectId,
            task.id,
            'first, apply tool guidance',
            'implementation',
          );
          stagePromptId = stagePrompt.message.id;
          expect(stagePrompt.accepted).toBe(false);
          const userPrompt = await appendTaskSteeringMessage(
            projectId,
            task.id,
            'second, apply user guidance',
          );
          userPromptId = userPrompt.message.id;
          expect(userPrompt.accepted).toBe(false);
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {
          drainCalls++;
          if (drainCalls !== 1) return;
          const continuedTask = await getTask(task.id);
          expect(continuedTask?.status).toBe('implementation');
          continuationExecution = executeTask(
            continuedTask!,
            group,
            continuationOptions,
          );
        },
      },
    });

    await continuationStarted;
    await continuationExecution;
    expect(agentRuns).toBe(2);
    expect(
      continuationPrompt.indexOf('first, apply tool guidance'),
    ).toBeLessThan(continuationPrompt.indexOf('second, apply user guidance'));
    const messages = readTaskMessages(projectId, task.id);
    const receipts = messages.filter(
      (message) =>
        message.entry_type === 'steering_delivery' &&
        (message.prompt_id === stagePromptId ||
          message.prompt_id === userPromptId),
    );
    expect(receipts.map((receipt) => receipt.prompt_id)).toEqual([
      stagePromptId,
      userPromptId,
    ]);
    expect(getPendingTaskDeliveryPrompts(messages, 'implementation')).toEqual(
      [],
    );
    expect(
      messages.filter(
        (message) => message.content === 'first, apply tool guidance',
      ),
    ).toHaveLength(1);
  });
  test('keeps Testing format-repair runs steerable without inheriting pending prompt ownership', async () => {
    const projectId = 'steering-testing-format-repair';
    const group = {
      name: 'Steering Testing format repair',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'testing' as const,
            color: '#f80',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    const task = await createTask({
      project_id: projectId,
      title: 'Test pending prompts without auxiliary delivery',
      description: 'Run the full validation path.',
      status: 'testing',
      priority: 0,
    });
    const firstPrompt = await appendTaskMessageAsync(projectId, {
      task_id: task.id,
      role: 'user',
      content: 'first pending Testing instruction',
      steering: true,
      created_at: '2026-09-07T10:00:00.000Z',
    });
    const secondPrompt = await appendTaskMessageAsync(projectId, {
      task_id: task.id,
      role: 'user',
      content: 'second pending Testing instruction',
      steering: true,
      created_at: '2026-09-07T10:00:01.000Z',
    });
    const runIds = [
      'testing-owning-run',
      'testing-format-repair-1-run',
      'testing-format-repair-2-run',
    ];
    const inputs: ContainerInput[] = [];

    await executeTask(task, group, {
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          const call = inputs.length;
          const runId = runIds[call]!;
          inputs.push(input);
          if (call > 0) expect(await isTaskRunning(task.id)).toBe(true);
          await input.onSlotAcquired?.(runId);
          await input.onPromptRunAssigned?.(runId);
          if (call !== 1) await input.onPromptRunAccepted?.(runId);
          return call === 1
            ? ({
                status: 'error',
                result: '',
                error: 'repair launch failed',
              } satisfies ContainerOutput)
            : ({
                status: 'success',
                result: 'still missing a structured verdict',
                newSessionId: 'testing-steering-session',
              } satisfies ContainerOutput);
        },
        runGitInRepo: fakeReviewGit(
          () => '1111111111111111111111111111111111111111',
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    });

    expect(inputs).toHaveLength(3);
    expect(inputs[0]!.prompt.indexOf(firstPrompt.content)).toBeLessThan(
      inputs[0]!.prompt.indexOf(secondPrompt.content),
    );
    for (const input of inputs.slice(1)) {
      expect(input.prompt).not.toContain(firstPrompt.content);
      expect(input.prompt).not.toContain(secondPrompt.content);
      expect(input.onPromptRunAssigned).toBeUndefined();
      expect(input.onPromptRunAccepted).toBeUndefined();
    }
    const reloaded = readTaskMessages(projectId, task.id);
    const promptIds = [firstPrompt.id, secondPrompt.id];
    const steeringEntries = reloaded.filter(
      (message) =>
        (message.entry_type === 'steering_assignment' ||
          message.entry_type === 'steering_delivery') &&
        !!message.prompt_id &&
        promptIds.includes(message.prompt_id),
    );
    expect(
      steeringEntries.map((message) => ({
        type: message.entry_type,
        promptId: message.prompt_id,
        runId: message.run_id,
      })),
    ).toEqual([
      {
        type: 'steering_assignment',
        promptId: firstPrompt.id,
        runId: 'testing-owning-run',
      },
      {
        type: 'steering_assignment',
        promptId: secondPrompt.id,
        runId: 'testing-owning-run',
      },
      {
        type: 'steering_delivery',
        promptId: firstPrompt.id,
        runId: 'testing-owning-run',
      },
      {
        type: 'steering_delivery',
        promptId: secondPrompt.id,
        runId: 'testing-owning-run',
      },
    ]);
    expect(splitFollowUpsFromHistory(reloaded).newUserMessages).not.toEqual(
      expect.arrayContaining([firstPrompt, secondPrompt]),
    );
  });
  test('keeps Review repair and comparison runs steerable without inheriting pending prompt ownership', async () => {
    const projectId = 'steering-review-auxiliary-runs';
    const group = {
      name: 'Steering Review auxiliary runs',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'review',
            title: 'Review',
            type: 'review' as const,
            color: '#a4f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    const task = await createTask({
      project_id: projectId,
      title: 'Review pending prompt ownership',
      description: 'Review this implementation.',
      status: 'review',
      priority: 0,
      // A positive count with no history still requires the comparison run.
      custom_values: { rejection_count: 1 },
      lastTriggerSource: 'user',
      lastTriggeredAt: '2026-09-07T10:00:00.000Z',
    });
    const prompt = await appendTaskMessageAsync(projectId, {
      task_id: task.id,
      role: 'user',
      content: 'pending Review instruction',
      steering: true,
      created_at: '2026-09-07T10:00:01.000Z',
    });
    const runIds = [
      'review-owning-run',
      'review-format-repair-run',
      'review-comparison-run',
    ];
    const inputs: ContainerInput[] = [];

    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async () => {},
        readTaskGitContentIdentity: async () => ({
          headSha: '1111111111111111111111111111111111111111',
          treeSha: '2222222222222222222222222222222222222222',
        }),
        runGitInRepo: fakeReviewGit(
          () => '1111111111111111111111111111111111111111',
          () => '2222222222222222222222222222222222222222',
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input, onChunk) => {
          const call = inputs.length;
          const runId = runIds[call]!;
          const sessionId = `review-auxiliary-session-${call}`;
          inputs.push(input);
          if (call > 0) {
            expect(await isTaskRunning(task.id)).toBe(true);
            expect((await getTask(task.id))?.session_id).toBe(
              `review-auxiliary-session-${call - 1}`,
            );
          }
          await insertActiveRun(
            runFixture({
              id: runId,
              group_folder: projectId,
              task_id: task.id,
              stage: input.activeRunStageId ?? input.stage_id ?? 'review',
              agent_name: input.session_agent_key ?? 'direct',
              session_agent_key: input.session_agent_key ?? 'direct',
              started_at: `2026-09-07T10:00:0${call + 2}.000Z`,
            }),
          );
          await input.onActiveRunCreated?.(runId);
          await input.onSlotAcquired?.(runId);
          await input.onPromptRunAssigned?.(runId);
          await input.onPromptRunAccepted?.(runId);
          onChunk?.({ type: 'session', session_id: sessionId });
          await completeActiveRun(runId, 'completed');
          if (call === 0) {
            return {
              status: 'success',
              result: 'review verdict missing its JSON envelope',
              newSessionId: sessionId,
            } satisfies ContainerOutput;
          }
          if (call === 1) {
            return {
              status: 'success',
              result:
                '{"decision":"reject","score":4,"issues":[{"title":"Fix ownership","description":"Auxiliary runs must not consume the prompt"}],"summary":"ownership is incorrect"}',
              newSessionId: sessionId,
            } satisfies ContainerOutput;
          }
          return {
            status: 'success',
            result:
              '{"decision":"retry","progress":"new_issue","resolved_issue_ids":[],"persistent_issue_ids":[],"new_issue_ids":["fix ownership"],"reason":"new ownership defect"}',
            newSessionId: sessionId,
          } satisfies ContainerOutput;
        },
      },
    });

    expect(inputs).toHaveLength(3);
    expect(inputs[0]!.prompt).toContain(prompt.content);
    expect(inputs[2]!.prompt).not.toContain(prompt.content);
    for (const input of inputs.slice(1)) {
      expect(input.onPromptRunAssigned).toBeUndefined();
      expect(input.onPromptRunAccepted).toBeUndefined();
    }
    expect(
      await Promise.all(runIds.map((runId) => getActiveRunById(runId))),
    ).toEqual(
      runIds.map((runId, index) =>
        expect.objectContaining({
          id: runId,
          session_id: `review-auxiliary-session-${index}`,
        }),
      ),
    );
    const steeringEntries = readTaskMessages(projectId, task.id).filter(
      (message) =>
        (message.entry_type === 'steering_assignment' ||
          message.entry_type === 'steering_delivery') &&
        message.prompt_id === prompt.id,
    );
    expect(
      steeringEntries.map((message) => ({
        type: message.entry_type,
        runId: message.run_id,
      })),
    ).toEqual([
      { type: 'steering_assignment', runId: 'review-owning-run' },
      { type: 'steering_delivery', runId: 'review-owning-run' },
    ]);
  });
  test.each<{
    name: string;
    custom_values: Record<string, string | number>;
    comparisonRuns: number;
  }>([
    {
      name: 'skips the comparison run on a first rejection',
      custom_values: {},
      comparisonRuns: 0,
    },
    {
      name: 'still compares a second rejection',
      custom_values: {
        rejection_count: 1,
        review_history: JSON.stringify([
          {
            timestamp: '2026-09-07T09:00:00.000Z',
            commit: '',
            issues: [{ id: 'earlier', text: 'earlier issue' }],
            summary: 'rejected earlier',
          },
        ]),
      },
      comparisonRuns: 1,
    },
    {
      name: 'still compares a legacy card with a count but no history',
      custom_values: { rejection_count: 1 },
      comparisonRuns: 1,
    },
  ])('$name', async ({ name, custom_values, comparisonRuns }) => {
    const projectId = `review-comparison-gate-${name.replace(/\W+/g, '-')}`;
    const group = {
      name: projectId,
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'review',
            title: 'Review',
            type: 'review' as const,
            color: '#a4f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    const task = await createTask({
      project_id: projectId,
      title: 'Review comparison gate',
      description: 'Review this implementation.',
      status: 'review',
      priority: 0,
      custom_values,
    });
    const inputs: ContainerInput[] = [];

    await executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async () => {},
        readTaskGitContentIdentity: async () => ({
          headSha: '1111111111111111111111111111111111111111',
          treeSha: '2222222222222222222222222222222222222222',
        }),
        runGitInRepo: fakeReviewGit(
          () => '1111111111111111111111111111111111111111',
          () => '2222222222222222222222222222222222222222',
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input) => {
          inputs.push(input);
          return {
            status: 'success',
            result:
              inputs.length === 1
                ? '{"decision":"reject","score":4,"issues":[{"title":"Fix gate","description":"Needs work"}],"summary":"gate is incorrect"}'
                : '{"decision":"retry","progress":"new_issue","resolved_issue_ids":[],"persistent_issue_ids":[],"new_issue_ids":["fix gate needs work"],"reason":"new defect"}',
            newSessionId: `comparison-gate-session-${inputs.length}`,
          } satisfies ContainerOutput;
        },
      },
    });

    expect(inputs).toHaveLength(1 + comparisonRuns);
    const messages = readTaskMessages(projectId, task.id).map(
      (message) => message.content,
    );
    expect(
      messages.some((content) =>
        content.includes('**Review comparison requested**'),
      ),
    ).toBe(comparisonRuns === 1);
    expect(
      messages.some((content) => content.includes('**Review comparison** —')),
    ).toBe(comparisonRuns === 1);
    const updated = await getTask(task.id);
    expect(updated?.status).toBe('implementation');
    const history = JSON.parse(
      String(updated?.custom_values?.review_history),
    ) as { comparison?: { decision: string; reason: string } }[];
    const latest = history[history.length - 1]!;
    expect(latest.comparison?.decision).toBe('retry');
    if (comparisonRuns === 0) {
      expect(latest.comparison?.reason).toBe(
        'First rejection; nothing to compare.',
      );
    }
  });
  test('leaves the prompt pending after launch failure and redelivers on retry', async () => {
    const projectId = 'steering-launch-retry';
    const group = {
      name: 'Steering launch retry',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    const task = await createTask({
      project_id: projectId,
      title: 'Launch retry',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    const prompt = await appendTaskMessageAsync(projectId, {
      task_id: task.id,
      role: 'user',
      content: 'retry this prompt',
      steering: true,
      created_at: new Date().toISOString(),
    });
    let calls = 0;
    const runAgent = async (_group: unknown, input: ContainerInput) => {
      calls++;
      await input.onSlotAcquired?.(`launch-retry-${calls}`);
      await input.onPromptRunAssigned?.(`launch-retry-${calls}`);
      if (calls === 1)
        return { status: 'error', result: '' } as ContainerOutput;
      await input.onPromptRunAccepted?.(`launch-retry-${calls}`);
      return { status: 'success', result: 'recovered' } as ContainerOutput;
    };
    const dependencies = {
      runContainerAgent: runAgent,
      drainProjectQueue: async () => {},
      runPostExecutionGitOps: async () => {},
    };
    await executeTask(task, group, { testDependencies: dependencies });
    expect(
      readTaskMessages(projectId, task.id).filter(
        (message) =>
          message.entry_type === 'steering_delivery' &&
          message.prompt_id === prompt.id,
      ),
    ).toHaveLength(0);
    await updateTask(task.id, { status: 'implementation', error: '' });
    await executeTask(task, group, { testDependencies: dependencies });
    const receipts = readTaskMessages(projectId, task.id).filter(
      (message) =>
        message.entry_type === 'steering_delivery' &&
        message.prompt_id === prompt.id,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.run_id).toBe('launch-retry-2');
  });
  test('waits for an admitted submission before starting completion effects', async () => {
    const projectId = 'steering-after-transition-boundary';
    const group = {
      name: 'Steering after transition boundary',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const task = await createTask({
      project_id: projectId,
      title: 'Late serialized steering',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let drainCalls = 0;
    const releaseLifecycle: string[] = [];
    let mergeCalls = 0;
    let submission!: ReturnType<typeof appendTaskSteeringMessage>;
    const execution = executeTask(task, group, {
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          await input.onSlotAcquired?.('late-steering-run');
          submission = appendTaskSteeringMessage(
            projectId,
            task.id,
            'continue in the same stage',
            async () => {
              markAppendStarted();
              await appendReleased;
            },
          );
          await appendStarted;
          return {
            status: 'success',
            result: 'completed before the late prompt',
          } satisfies ContainerOutput;
        },
        mergeBranchForDeploy: async () => {
          mergeCalls++;
          return true;
        },
        runPostExecutionGitOps: async () => {
          releaseLifecycle.push('checkpoint');
        },
        drainProjectQueue: async () => {
          drainCalls++;
          releaseLifecycle.push('drain');
        },
      },
    });

    await appendStarted;
    await Promise.resolve();
    expect(mergeCalls).toBe(0);
    releaseAppend();
    await execution;
    const result = await submission;

    expect(result.accepted).toBe(false);
    expect(result.continuationDrainRequired).toBeUndefined();
    expect((await getTask(task.id))?.status).toBe('implementation');
    expect(mergeCalls).toBe(0);
    expect(drainCalls).toBe(1);
    expect(releaseLifecycle).toEqual(['checkpoint', 'drain']);
    expect(
      readTaskMessages(projectId, task.id).filter(
        (message) => message.content === 'continue in the same stage',
      ),
    ).toHaveLength(1);
  });
  test('keeps the starting stage when pending steering predates an agent handoff', async () => {
    const projectId = 'steering-before-executable-handoff';
    const group = {
      name: 'Steering before executable handoff',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'question',
            title: 'Question',
            type: 'queue' as const,
            color: '#f90',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'testing' as const,
            color: '#f80',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    const task = await createTask({
      project_id: projectId,
      title: 'Pending before handoff',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    let drainCalls = 0;
    const releaseLifecycle: string[] = [];

    await executeTask(task, group, {
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          await insertActiveRun(
            runFixture({
              id: 'pre-handoff-steering-run',
              group_folder: projectId,
              task_id: task.id,
              stage: 'implementation',
            }),
          );
          await input.onSlotAcquired?.('pre-handoff-steering-run');
          const submission = await appendTaskSteeringMessage(
            projectId,
            task.id,
            'apply this before testing',
          );
          expect(submission.accepted).toBe(false);
          const response = await updateTaskTool.handler(
            { task_id: task.id, status: 'question' },
            {} as any,
            {
              group_folder: task.project_id,
              permissions: { '*': ['tasks:write'] },
              run_id: 'pre-handoff-steering-run',
            } as any,
          );
          expect(response).toContain('current run is ending');
          expect((await getTask(task.id))?.status).toBe('implementation');
          await completeActiveRun('pre-handoff-steering-run', 'completed');
          return {
            status: 'success',
            result: 'handoff requested',
            newSessionId: 'pre-handoff-steering-session',
          } satisfies ContainerOutput;
        },
        runPostExecutionGitOps: async () => {
          releaseLifecycle.push('checkpoint');
        },
        drainProjectQueue: async () => {
          drainCalls++;
          releaseLifecycle.push('drain');
        },
      },
    });

    expect((await getTask(task.id))?.status).toBe('implementation');
    expect(drainCalls).toBe(1);
    expect(releaseLifecycle).toEqual(['checkpoint', 'drain']);
    const messages = readTaskMessages(projectId, task.id);
    expect(
      messages.filter(
        (message) => message.content === 'apply this before testing',
      ),
    ).toHaveLength(1);
    expect(
      messages.some((message) => message.entry_type === 'steering_delivery'),
    ).toBe(false);

    const continuationRunId = 'post-handoff-steering-continuation';
    await executeTask((await getTask(task.id))!, group, {
      testDependencies: {
        runContainerAgent: async (_group, input) => {
          await insertActiveRun(
            runFixture({
              id: continuationRunId,
              group_folder: projectId,
              task_id: task.id,
              stage: 'implementation',
            }),
          );
          await input.onSlotAcquired?.(continuationRunId);
          await input.onPromptRunAssigned?.(continuationRunId);
          await completeActiveRun(continuationRunId, 'completed');
          await input.onPromptRunAccepted?.(continuationRunId);
          return {
            status: 'success',
            result: 'continuation handled the pending prompt',
            newSessionId: 'continued-handoff-session',
          } satisfies ContainerOutput;
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    });
    expect((await getTask(task.id))?.status).toBe('question');
    const continuedMessages = readTaskMessages(projectId, task.id);
    expect(
      continuedMessages.filter(
        (message) =>
          message.entry_type === 'steering_delivery' &&
          message.run_id === continuationRunId,
      ),
    ).toHaveLength(1);
    expect(
      continuedMessages.filter(
        (message) =>
          message.entry_type === 'stage_handoff_delivery' &&
          message.run_id === continuationRunId,
      ),
    ).toHaveLength(1);
  });
  for (const scenario of [
    {
      name: 'ordinary advancement',
      stage: 'implementation',
      output: 'implementation finished',
    },
    {
      name: 'Testing verdict',
      stage: 'testing',
      output: '{"decision":"pass","issues":[],"summary":"green"}',
    },
    {
      name: 'Review verdict',
      stage: 'review',
      output:
        '{"decision":"approve","score":10,"issues":[],"summary":"approved"}',
    },
    {
      name: 'agent handoff to done',
      stage: 'implementation',
      output: 'handoff finished',
      handoff: true,
    },
  ] as const) {
    test(`holds ${scenario.name} when a production run receives a pending submission`, async () => {
      const projectId = `steering-${scenario.name
        .toLowerCase()
        .replaceAll(' ', '-')}`;
      const stages = [
        {
          id: 'backlog',
          title: 'Backlog',
          type: 'queue' as const,
          color: '#888',
        },
        {
          id: 'implementation',
          title: 'Implementation',
          type: 'active' as const,
          color: '#38f',
        },
        {
          id: 'testing',
          title: 'Testing',
          type: 'testing' as const,
          color: '#f80',
        },
        {
          id: 'review',
          title: 'Review',
          type: 'review' as const,
          color: '#a4f',
        },
        { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
      ];
      const identity = '1111111111111111111111111111111111111111';
      const group = {
        name: scenario.name,
        folder: projectId,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'paused' as const,
          taskCheckoutMode: 'shared' as const,
          stages,
        },
      };
      const task = await createTask({
        project_id: projectId,
        title: scenario.name,
        description: '',
        status: scenario.stage,
        priority: 0,
        custom_values:
          scenario.stage === 'review'
            ? {
                [TESTING_HEAD_SHA_KEY]: identity,
                [TESTING_TREE_SHA_KEY]: identity,
              }
            : undefined,
      });
      let markFinalizing!: () => void;
      const finalizing = new Promise<void>((resolve) => {
        markFinalizing = resolve;
      });
      let releaseFinalizing!: () => void;
      const finalizingReleased = new Promise<void>((resolve) => {
        releaseFinalizing = resolve;
      });
      const execution = executeTask(task, group, {
        testDependencies: {
          runContainerAgent: async (_group, input) => {
            await input.onSlotAcquired?.(`${scenario.stage}-race-run`);
            if (scenario.handoff) {
              await updateTask(task.id, { status: 'done' });
              expect(
                requestTaskStageHandoff(task.id, 'implementation', 'done'),
              ).toBe(true);
            }
            return {
              status: 'success',
              result: scenario.output,
              newSessionId: `${scenario.stage}-session`,
            } satisfies ContainerOutput;
          },
          prepareTaskBranchForReview: async () => {},
          readTaskGitContentIdentity: async () => ({
            headSha: identity,
            treeSha: identity,
          }),
          runGitInRepo: fakeReviewGit(() => identity),
          inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
          mergeBranchForDeploy: async () => true,
          runPostExecutionGitOps: async () => {},
          drainProjectQueue: async () => {},
          afterSuccessfulAgentRun: async () => {
            markFinalizing();
            await finalizingReleased;
          },
        },
      });

      await finalizing;
      const submitted = await appendTaskSteeringMessage(
        projectId,
        task.id,
        `prompt during ${scenario.name}`,
      );
      expect(submitted.accepted).toBe(false);
      releaseFinalizing();
      await execution;

      expect((await getTask(task.id))?.status).toBe(scenario.stage);
      const messages = readTaskMessages(projectId, task.id);
      expect(
        messages.filter(
          (message) => message.content === `prompt during ${scenario.name}`,
        ),
      ).toHaveLength(1);
      expect(
        messages.some((message) => message.entry_type === 'steering_delivery'),
      ).toBe(false);
    });
  }
});

describe('post-run sandbox instance persistence', () => {
  useCleanPipelineTestDatabase();

  // The run's sandbox instance must be durable (awaited write) AND present on
  // the in-memory task object before post-run git boundaries run: the
  // testing-stage HEAD read consumes that object directly, so a stale or
  // missing instance sends rev-parse to the wrong (folder-derived) container.
  test('syncs the run sandbox instance to the task object and the DB row', async () => {
    const projectId = 'project-sandbox-instance-sync';
    const task = await createTask({
      project_id: projectId,
      title: 'Sandbox instance sync',
      description: '',
      status: 'in_progress',
      priority: 0,
    });
    const group = {
      name: 'Sandbox instance sync',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: { status: 'paused' as const },
    };
    const instance = 'fixed-sandbox-instance';

    await executeTask(task, group, {
      testDependencies: {
        runContainerAgent: async () =>
          ({
            status: 'success',
            result: 'done',
            newSessionId: 'sess-1',
            sandbox_instance: instance,
          }) as any,
      },
    });

    // In-memory object handed to post-run git consumers carries the instance.
    expect(task.sandbox_instance).toBe(instance);
    expect(validatedInstance(task, group)).toBe(instance);
    // The awaited write has landed before executeTask resolves.
    expect((await getTask(task.id))?.sandbox_instance).toBe(instance);
  });

  test('does not persist an invalid (agent-name-like) sandbox instance', async () => {
    const projectId = 'project-sandbox-instance-invalid';
    const task = await createTask({
      project_id: projectId,
      title: 'Sandbox instance invalid',
      description: '',
      status: 'in_progress',
      priority: 0,
    });
    const group = {
      name: 'Sandbox instance invalid',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: { status: 'paused' as const },
    };

    await executeTask(task, group, {
      testDependencies: {
        runContainerAgent: async () =>
          ({
            status: 'success',
            result: 'done',
            sandbox_instance: 'claude-code.v2',
          }) as any,
      },
    });

    expect(task.sandbox_instance ?? null).toBeNull();
    expect((await getTask(task.id))?.sandbox_instance).toBeNull();
  });
});

describe('transient retry queue reselection', () => {
  useCleanPipelineTestDatabase();

  test('drains the retry-marked task once its backoff elapses', async () => {
    const projectId = 'transient-retry-drain';
    const group = {
      name: 'Transient retry drain',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        maxParallelWorktrees: 2,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const task = await createTask({
      project_id: projectId,
      title: 'Transient retry',
      description: '',
      status: 'implementation',
      priority: 0,
      error: 'Retry scheduled: Overloaded',
    });
    const started: string[] = [];
    let markDrained!: () => void;
    const drained = new Promise<void>((resolve) => {
      markDrained = resolve;
    });
    const retryDrain: typeof drainProjectQueue = (id, drainGroup) =>
      drainProjectQueue(id, drainGroup, {
        testDependencies: {
          executeTask: async (t) => {
            started.push(t.id);
            markDrained();
          },
        },
      });

    let fireRetry!: () => void;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
    ) => {
      fireRetry = callback;
      return { unref() {} };
    }) as unknown as typeof setTimeout);
    try {
      scheduleTransientTaskRetry(task.id, projectId, group, retryDrain, 10);
    } finally {
      timer.mockRestore();
    }
    expect(_testOnlyIsRetryPending(task.id)).toBe(true);
    expect(_testOnlyGetRetryReservedCount(projectId)).toBe(1);

    // The backoff must hold even with a free slot: the retry-pending marker
    // and the reserved slot both block an early re-selection.
    await drainProjectQueue(projectId, group, {
      testDependencies: {
        executeTask: async (t) => {
          started.push(t.id);
        },
      },
    });
    expect(started).toEqual([]);

    // Once the delay elapses, the scheduled drain must re-select the task
    // while it still carries the "Retry scheduled:" error marker; the real
    // execution pre-flight clears that marker when the retry starts.
    fireRetry();
    await drained;
    expect(started).toEqual([task.id]);
    expect(_testOnlyIsRetryPending(task.id)).toBe(false);
    expect(_testOnlyGetRetryReservedCount(projectId)).toBe(0);
  });

  test('releases the reserved retry slot once the card left its executable stage', async () => {
    const projectId = 'transient-retry-moved-away';
    const group = {
      name: 'Transient retry moved away',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const retrying = await createTask({
      project_id: projectId,
      title: 'Retrying card',
      description: '',
      status: 'implementation',
      priority: 0,
      error: 'Retry scheduled: Overloaded',
    });
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
      _callback: () => void,
    ) => ({ unref() {} })) as unknown as typeof setTimeout);
    try {
      scheduleTransientTaskRetry(retrying.id, projectId, group, async () => {});
    } finally {
      timer.mockRestore();
    }
    expect(_testOnlyGetRetryReservedCount(projectId)).toBe(1);

    // The user parks the retrying card; another card then enters execution.
    await updateTask(retrying.id, { status: 'backlog' });
    const next = await createTask({
      project_id: projectId,
      title: 'Next card',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    const started: string[] = [];
    await drainProjectQueue(projectId, group, {
      testDependencies: {
        executeTask: async (t) => {
          started.push(t.id);
        },
      },
    });

    expect(started).toEqual([next.id]);
    expect(_testOnlyGetRetryReservedCount(projectId)).toBe(0);
    expect(_testOnlyIsRetryPending(retrying.id)).toBe(false);
  });

  test('bounds transient retries with persisted backoff and matches only the provider error', async () => {
    expect(
      isRetryableTaskError('API Error: 529 {"type":"overloaded_error"}'),
    ).toBe(true);
    // Earlier agent output mentioning a limit is not a provider error.
    expect(
      isRetryableTaskError(
        ['GitHub API rate limit hit, backing off', 'a', 'b', 'done'].join('\n'),
      ),
    ).toBe(false);

    const task = await createTask({
      project_id: 'transient-retry-budget',
      title: 'Transient retry budget',
      description: '',
      status: 'implementation',
      priority: 0,
    });
    const delays: number[] = [];
    for (let attempt = 1; attempt < MAX_TRANSIENT_ATTEMPTS; attempt++) {
      const plan = await planTransientRetry((await getTask(task.id))!);
      expect(plan.exhausted).toBe(false);
      delays.push(plan.delayMs / 60_000);
      await updateTask(task.id, { custom_values: plan.customValues });
    }
    expect(delays).toEqual([2, 4, 8, 16]);
    expect(
      (await getTask(task.id))!.custom_values?.[TRANSIENT_RETRIES_KEY],
    ).toBe(MAX_TRANSIENT_ATTEMPTS - 1);

    const last = await planTransientRetry((await getTask(task.id))!);
    expect(last.exhausted).toBe(true);
    expect(last.attempts).toBe(MAX_TRANSIENT_ATTEMPTS);
    expect(last.customValues[TRANSIENT_RETRIES_KEY]).toBeUndefined();
  });
});

describe('recovered task claims', () => {
  useCleanPipelineTestDatabase();

  test('recovery watcher finishes its run before draining and leaves an unselected handoff waiting', async () => {
    const { finishRecoveredTaskRun } = await import('../../recovery.js');
    const projectId = 'recovered-stage-handoff';
    const group = {
      name: 'Recovered stage handoff',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        maxParallelWorktrees: 1,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'testing' as const,
            color: '#f80',
          },
          {
            id: 'review',
            title: 'Review',
            type: 'review' as const,
            color: '#c6f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#2c5' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));
    const advanced = await createTask({
      project_id: projectId,
      title: 'Recovered A',
      description: '',
      status: 'testing',
      priority: 0,
    });
    const higherPriority = await createTask({
      project_id: projectId,
      title: 'Higher priority B',
      description: '',
      status: 'review',
      priority: -99,
    });
    const recoveryAbort = new AbortController();
    registerRecoveredTaskAbort(advanced.id, projectId, recoveryAbort);
    const lifecycle: string[] = [];
    let higherPriorityAbort: AbortController | undefined;

    expect(
      await finishRecoveredTaskRun(
        {
          id: 'recovered-run-a',
          group_folder: projectId,
          task_id: advanced.id,
        },
        recoveryAbort,
        {
          getGroupByFolder: () => group,
          emit: (event) => {
            lifecycle.push(`${event.type}:${event.payload.run_id}`);
            expect(getQueuedTaskIds()).not.toContain(advanced.id);
          },
          drainProjectQueue: async () => {
            lifecycle.push('drain');
            expect(lifecycle).toEqual([
              'run_finished:recovered-run-a',
              'drain',
            ]);
            higherPriorityAbort = _testOnlyRegisterRunning(
              higherPriority.id,
              projectId,
            );
          },
        },
      ),
    ).toBe(true);

    expect(lifecycle).toEqual(['run_finished:recovered-run-a', 'drain']);
    expect(getRunningTaskIds()).toContain(higherPriority.id);
    expect(await getWaitingTaskIds(projectId)).toContain(advanced.id);
    if (higherPriorityAbort)
      finishOwnedTaskExecution(
        higherPriority.id,
        projectId,
        higherPriorityAbort,
        'higher-priority-run',
      );
  });

  test('recovery watcher does not finish or release a newer claim', async () => {
    const { finishRecoveredTaskRun } = await import('../../recovery.js');
    const events: unknown[] = [];
    const lifecycle: string[] = [];
    const group = {
      name: 'Recovery ownership race',
      folder: 'proj-a',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        maxParallelWorktrees: 1,
        taskCheckoutMode: 'shared' as const,
      },
    };
    const oldAbort = new AbortController();
    const newAbort = new AbortController();
    registerRecoveredTaskAbort(
      'task-recovered-finish-race',
      'proj-a',
      oldAbort,
    );
    registerRecoveredTaskAbort(
      'task-recovered-finish-race',
      'proj-a',
      newAbort,
    );

    expect(
      await finishRecoveredTaskRun(
        {
          id: 'recovered-old',
          group_folder: 'proj-a',
          task_id: 'task-recovered-finish-race',
        },
        oldAbort,
        {
          getTask: async () => undefined,
          getGroupByFolder: () => group,
          emit: (event) => events.push(event),
          drainProjectQueue: async () => {
            lifecycle.push('drain');
            expect(getQueuedTaskIds()).toContain('task-recovered-finish-race');
          },
        },
      ),
    ).toBe(false);
    expect(events).toEqual([]);
    expect(lifecycle).toEqual(['drain']);
    expect(getQueuedTaskIds()).toContain('task-recovered-finish-race');
    unregisterRecoveredTaskAbort('task-recovered-finish-race', newAbort);
  });

  test('releases the recovered claim when its watcher exits', () => {
    const abort = new AbortController();
    registerRecoveredTaskAbort('task-recovered-release', 'proj-a', abort);

    expect(getQueuedTaskIds()).toContain('task-recovered-release');
    unregisterRecoveredTaskAbort('task-recovered-release', abort);
    expect(getQueuedTaskIds()).not.toContain('task-recovered-release');
  });

  test('does not release a newer claim for the same task', () => {
    const oldAbort = new AbortController();
    const newAbort = new AbortController();
    registerRecoveredTaskAbort('task-recovered-reclaimed', 'proj-a', oldAbort);
    registerRecoveredTaskAbort('task-recovered-reclaimed', 'proj-a', newAbort);

    unregisterRecoveredTaskAbort('task-recovered-reclaimed', oldAbort);
    expect(getQueuedTaskIds()).toContain('task-recovered-reclaimed');

    unregisterRecoveredTaskAbort('task-recovered-reclaimed', newAbort);
  });
});

describe('agent stage handoffs', () => {
  useCleanPipelineTestDatabase();

  test('steers immediately, then interrupts and kills only when the grace timeout is not accepted', async () => {
    const taskId = `task-stage-timeout-${Date.now()}`;
    const abort = new AbortController();
    const timers: Array<() => Promise<void>> = [];
    const delays: number[] = [];
    const calls: string[] = [];
    registerRecoveredTaskAbort(taskId, 'proj-a', abort);

    scheduleStageHandoffControl(taskId, abort, {
      steerAgentProcess: async () => {
        calls.push('steer');
        return true;
      },
      interruptAgentTurn: async () => {
        calls.push('interrupt');
        return false;
      },
      killAgentProcess: async () => {
        calls.push('kill');
        return true;
      },
      schedule: ((callback: () => Promise<void>, delay?: number) => {
        timers.push(callback);
        delays.push(delay ?? 0);
        return 0 as any;
      }) as typeof setTimeout,
      isCurrentClaim: () => true,
      isHandoffActive: () => true,
    });
    await timers.shift()?.();
    await timers.shift()?.();
    expect(delays).toEqual([0, 30_000]);
    expect(calls).toEqual(['steer', 'interrupt', 'kill']);
    expect(abort.signal.aborted).toBe(true);
    unregisterRecoveredTaskAbort(taskId, abort);
  });

  test('does not hand off for a no-op stage update', () => {
    const abort = new AbortController();
    registerRecoveredTaskAbort('task-same-stage', 'proj-a', abort);

    expect(
      requestTaskStageHandoff('task-same-stage', 'in_progress', 'in_progress'),
    ).toBe(false);
    expect(abort.signal.aborted).toBe(false);
    unregisterRecoveredTaskAbort('task-same-stage', abort);
  });
});

describe('execution claims', () => {
  useCleanPipelineTestDatabase();

  test('retires a successful run presentation once while retaining its claim', () => {
    const taskId = 'task-retire-before-effects';
    const runId = 'run-retire-before-effects';
    const abort = _testOnlyRegisterRunning(taskId, 'proj-a');
    const events: string[] = [];
    const emit = (event: {
      type: 'run_finished';
      payload: { run_id: string };
    }) => events.push(`${event.type}:${event.payload.run_id}`);

    expect(
      retireOwnedTaskExecutionPresentation(
        taskId,
        'proj-a',
        abort,
        runId,
        emit,
      ),
    ).toBe(true);
    expect(getRunningTaskIds()).toContain(taskId);
    expect(finishOwnedTaskExecution(taskId, 'proj-a', abort, runId, emit)).toBe(
      true,
    );
    expect(events).toEqual(['run_finished:run-retire-before-effects']);
    expect(getRunningTaskIds()).not.toContain(taskId);
  });

  test('retires the owned presentation when successful finalization closes steering admission', async () => {
    const projectId = 'retire-at-finalization-cutoff';
    const task = await createTask({
      project_id: projectId,
      title: 'Retire at cutoff',
      description: '',
      status: 'in_progress',
      priority: 0,
    });
    const runId = 'run-retire-at-finalization-cutoff';
    const abort = _testOnlyRegisterRunning(task.id, projectId, runId);
    const boundary = await beginSuccessfulTaskFinalization(
      task,
      'in_progress',
      runId,
    );
    const duplicateFinishEvents: unknown[] = [];

    expect(await isTaskRunning(task.id)).toBe(false);
    expect(
      finishOwnedTaskExecution(task.id, projectId, abort, runId, (event) =>
        duplicateFinishEvents.push(event),
      ),
    ).toBe(true);
    expect(duplicateFinishEvents).toEqual([]);

    endSuccessfulTaskFinalization(boundary);
  });

  test('retires a recovered presentation even when pending steering holds the stage', async () => {
    const projectId = 'retire-recovered-held-cutoff';
    const task = await createTask({
      project_id: projectId,
      title: 'Retire recovered held run',
      description: '',
      status: 'in_progress',
      priority: 0,
    });
    await appendTaskMessageAsync(projectId, {
      task_id: task.id,
      role: 'user',
      content: 'pending recovered prompt',
      steering: true,
      created_at: new Date().toISOString(),
    });
    let retireCalls = 0;

    const boundary = await beginSuccessfulTaskFinalization(
      task,
      'in_progress',
      'recovered-held-run',
      () => {
        retireCalls += 1;
      },
    );

    expect(boundary.shouldAdvance).toBe(false);
    expect(retireCalls).toBe(1);
    expect(await isTaskRunning(task.id)).toBe(false);
    endSuccessfulTaskFinalization(boundary);
  });

  test('close waits for an admitted append queued behind the finalizer lock', async () => {
    const projectId = 'close-waits-for-late-admitted-append';
    const task = await createTask({
      project_id: projectId,
      title: 'Wait for admitted append',
      description: '',
      status: 'in_progress',
      priority: 0,
    });
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendFinished = false;

    // beginSuccessfulTaskFinalization installs its lock synchronously before
    // yielding. This submission is therefore admitted before the cutoff but
    // serialized behind the finalizer, matching the route/completion race.
    const finalization = beginSuccessfulTaskFinalization(task, 'in_progress');
    const submission = appendTaskSteeringMessage(
      projectId,
      task.id,
      'persist me before draining',
      async () => {
        markAppendStarted();
        await appendGate;
        appendFinished = true;
      },
    );
    const boundary = await finalization;
    expect(boundary.shouldAdvance).toBe(false);
    await appendStarted;

    let closeSettledAfterAppend: boolean | undefined;
    let held = false;
    const close = closeTaskSteeringAdmissionWindow(
      task,
      'in_progress',
      true,
      boundary.release,
    ).then((result) => {
      closeSettledAfterAppend = appendFinished;
      return result;
    });
    try {
      releaseAppend();
      await submission;
      held = await close;
    } finally {
      endSuccessfulTaskFinalization(boundary);
    }

    expect(closeSettledAfterAppend).toBe(true);
    expect(held).toBe(true);
    expect((await getTask(task.id))?.status).toBe('in_progress');
    expect(
      readTaskMessages(projectId, task.id).filter(
        (message) => message.content === 'persist me before draining',
      ),
    ).toHaveLength(1);
  });

  test('releases an isolated queue slot before slow post-execution cleanup', async () => {
    const events: string[] = [];
    let finishCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });

    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });

    const cleanup = _testOnlyRunPostExecutionCleanup(
      true,
      () => events.push('released'),
      async () => {
        events.push('cleanup-started');
        markCleanupStarted();
        await cleanupGate;
        events.push('cleanup-finished');
      },
    );

    await cleanupStarted;
    expect(events).toEqual(['released', 'cleanup-started']);

    finishCleanup();
    await cleanup;
    expect(events).toEqual(['released', 'cleanup-started', 'cleanup-finished']);
  });

  test('keeps a shared-checkout slot until post-execution cleanup finishes', async () => {
    const events: string[] = [];

    await _testOnlyRunPostExecutionCleanup(
      false,
      () => events.push('released'),
      async () => {
        events.push('cleanup');
      },
    );

    expect(events).toEqual(['cleanup', 'released']);
  });

  test('auto-deploy intercept stops execution even when deploy returns false', async () => {
    const task = await createTask({
      project_id: 'project-auto-deploy',
      title: 'Deploy',
      description: '',
      status: 'deploy',
      priority: 0,
    });
    const group = {
      name: 'Auto deploy',
      folder: task.project_id,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        deployService: 'carapa-board',
        deployStage: 'deploy',
        stages: [
          {
            id: 'deploy',
            title: 'Deploy',
            type: 'done' as const,
            color: '#0a0',
          },
        ],
      },
    };
    const deployed: string[] = [];

    await expect(
      interceptAutoDeployExecution(
        task,
        group,
        'deploy',
        group.settings.stages,
        async (deployTask) => {
          deployed.push(deployTask.id);
          return false;
        },
      ),
    ).resolves.toBe(true);
    expect(deployed).toEqual([task.id]);
  });

  test('allows only one synchronous claim for concurrent execution requests', () => {
    const first = _testOnlyTryClaimTaskExecution('task-claim-once', 'proj-a');
    const duplicate = _testOnlyTryClaimTaskExecution(
      'task-claim-once',
      'proj-a',
    );

    expect(first).toBeInstanceOf(AbortController);
    expect(duplicate).toBeNull();
    expect(
      getQueuedTaskIds().filter((id) => id === 'task-claim-once'),
    ).toHaveLength(1);

    _testOnlyReleaseTaskExecutionClaim('task-claim-once', first!);
  });

  test('an older execution cannot release a newer re-run claim', () => {
    const oldRun = _testOnlyTryClaimTaskExecution('task-fast-rerun', 'proj-a');
    expect(oldRun).toBeInstanceOf(AbortController);
    _testOnlyReleaseTaskExecutionClaim('task-fast-rerun', oldRun!);

    const newRun = _testOnlyTryClaimTaskExecution('task-fast-rerun', 'proj-a');
    expect(newRun).toBeInstanceOf(AbortController);

    _testOnlyReleaseTaskExecutionClaim('task-fast-rerun', oldRun!);
    expect(getQueuedTaskIds()).toContain('task-fast-rerun');

    _testOnlyReleaseTaskExecutionClaim('task-fast-rerun', newRun!);
  });

  test('an older execution cannot finalize a newer re-run DB row', async () => {
    const taskId = 'task-db-fast-rerun';
    const oldRun = runFixture({ id: 'run-old', task_id: taskId });
    const newRun = runFixture({ id: 'run-new', task_id: taskId });
    const oldAbort = _testOnlyTryClaimTaskExecution(taskId, 'proj-a');
    expect(oldAbort).toBeInstanceOf(AbortController);
    await insertActiveRun(oldRun);

    // stopTask completes the old row and releases its claim before a re-run.
    await completeActiveRun(oldRun.id, 'error');
    _testOnlyReleaseTaskExecutionClaim(taskId, oldAbort!);
    const newAbort = _testOnlyTryClaimTaskExecution(taskId, 'proj-a');
    expect(newAbort).toBeInstanceOf(AbortController);
    await insertActiveRun(newRun);

    const finalized = await _testOnlyFinalizeOwnedActiveRun(
      taskId,
      oldAbort!,
      oldRun.id,
      'completed',
    );

    expect(finalized).toBeNull();
    expect((await getActiveRunById(oldRun.id))?.status).toBe('error');
    expect((await getActiveRunById(newRun.id))?.status).toBe('running');

    await completeActiveRun(newRun.id, 'completed');
    _testOnlyReleaseTaskExecutionClaim(taskId, newAbort!);
  });
});

describe('pre-flight task failures', () => {
  useCleanPipelineTestDatabase();

  test('release the failed claim and drain the next eligible task', async () => {
    const failedAbort = new AbortController();
    const project_id = 'proj-preflight-drain';
    const eligible = ['task-failed-preflight', 'task-next-eligible'];
    const started: string[] = [];

    registerRecoveredTaskAbort(eligible[0], project_id, failedAbort);

    await new Promise<void>((resolve, reject) => {
      _testOnlyHandlePreflightFailure(
        eligible[0],
        failedAbort,
        project_id,
        {} as any,
        async () => {
          // With one slot, the failed first claim must be gone before the
          // drain can select the next task.
          if (getQueuedTaskIds().includes(eligible[0])) {
            reject(new Error('failed pre-flight claim was not released'));
            return;
          }
          if (!_testOnlyIsRetryPending(eligible[0])) {
            reject(new Error('failed pre-flight task was not backed off'));
            return;
          }
          started.push(eligible[1]);
          resolve();
        },
        null,
      );
    });

    expect(started).toEqual([eligible[1]]);
    expect(getQueuedTaskIds()).not.toContain(eligible[0]);
    expect(_testOnlyIsRetryPending(eligible[0])).toBe(true);
  });
});

describe('cancelQueuedProjectTasks', () => {
  useCleanPipelineTestDatabase();
  test('removes only queued claims for the paused project', async () => {
    _testOnlyRegisterQueued('task-paused-queued', 'proj-paused');
    _testOnlyRegisterRunning('task-paused-running', 'proj-paused');
    _testOnlyRegisterQueued('task-other-queued', 'proj-other');

    expect(await cancelQueuedProjectTasks('proj-paused')).toBe(1);
    expect(getQueuedTaskIds()).not.toContain('task-paused-queued');
    expect(getRunningTaskIds()).toContain('task-paused-running');
    expect(getQueuedTaskIds()).toContain('task-other-queued');
  });
});

describe('stopTask', () => {
  useCleanPipelineTestDatabase();

  test('waits for the replacement run session before finalizing a stopped fallback', async () => {
    const projectId = 'proj-stop-session-write-race';
    const task = await createTask({
      project_id: projectId,
      title: 'Preserve the interrupted session',
      description: 'Initial task prompt',
      status: 'in_progress',
      priority: 0,
    });
    const group = {
      name: 'Stop session write race',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        stages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue' as const,
            color: '#888',
          },
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active' as const,
            color: '#08f',
          },
          { id: 'done', title: 'Done', type: 'done' as const, color: '#0a0' },
        ],
      },
    };
    setGroupResolver((id) => (id === projectId ? group : undefined));

    let markSessionEmitted!: () => void;
    const sessionEmitted = new Promise<void>((resolve) => {
      markSessionEmitted = resolve;
    });
    let markPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    let releasePersistence!: () => void;
    const persistenceReleased = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const initialRunId = 'unresumable-session-attempt';
    const retryRunId = 'stopped-session-write-race';
    const execution = executeTask(task, group, {
      testDependencies: {
        persistTaskSessionForActiveRun: async (...args) => {
          markPersistenceStarted();
          await persistenceReleased;
          return persistTaskSessionForActiveRun(...args);
        },
        runContainerAgent: async (_group, input, onChunk) => {
          await insertActiveRun(
            runFixture({
              id: initialRunId,
              group_folder: projectId,
              task_id: task.id,
              stage: 'in_progress',
              agent_name: input.session_agent_key ?? 'codex',
              session_agent_key: input.session_agent_key ?? 'codex',
              started_at: '2026-09-09T18:00:00.000Z',
            }),
          );
          await input.onActiveRunCreated?.(initialRunId);
          await input.onSlotAcquired?.(initialRunId);
          await completeActiveRun(initialRunId, 'error');
          await insertActiveRun(
            runFixture({
              id: retryRunId,
              group_folder: projectId,
              task_id: task.id,
              stage: 'in_progress',
              agent_name: input.session_agent_key ?? 'codex',
              session_agent_key: input.session_agent_key ?? 'codex',
              started_at: '2026-09-09T18:01:00.000Z',
            }),
          );
          // The sandbox retry owns the already-acquired slot, so production
          // reports the new row generation without firing onSlotAcquired again.
          await input.onActiveRunCreated?.(retryRunId);
          onChunk?.({ type: 'session', session_id: 'interrupted-session' });
          markSessionEmitted();
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          return {
            status: 'error',
            result: null,
            error: 'aborted by test',
          } satisfies ContainerOutput;
        },
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
      },
    });

    await sessionEmitted;
    await persistenceStarted;
    let stopSettled = false;
    const stopping = stopTask(task.id).then((stopped) => {
      stopSettled = true;
      return stopped;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releasePersistence();
    expect(await stopping).toBe(true);
    await execution;
    expect(await getTask(task.id)).toMatchObject({
      status: 'backlog',
      session_id: 'interrupted-session',
    });
    expect(await getActiveRunById(initialRunId)).toMatchObject({
      status: 'error',
      session_id: null,
    });
    expect(await getActiveRunById(retryRunId)).toMatchObject({
      status: 'error',
      session_id: 'interrupted-session',
    });
  });

  test('filters a stopped testing transcript and clears its visible stream buffer', async () => {
    const projectId = 'proj-stop-testing-buffer';
    const task = await createTask({
      project_id: projectId,
      title: 'Stop a testing run cleanly',
      description: '',
      status: 'testing',
      priority: 0,
      branch_name: 'stop-testing-buffer',
      worktree_path: '/repo/.worktrees/stop-testing-buffer',
    });
    const group = reviewLifecycleGroup(projectId, 'paused');
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const execution = executeTask(task, group, {
      testDependencies: {
        prepareTaskBranchForReview: async () => {},
        runGitInRepo: fakeReviewGit(
          () => '1111111111111111111111111111111111111111',
        ),
        inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
        runPostExecutionGitOps: async () => {},
        drainProjectQueue: async () => {},
        runContainerAgent: async (_group, input, onChunk) => {
          await input.onSlotAcquired?.('stopped-testing-run');
          onChunk?.({
            type: 'text',
            content: [
              'Visible tester progress.',
              '{"decision":"pass","issues":[],"summary":"all checks passed"}',
            ].join('\n'),
          });
          markStarted();
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          return {
            status: 'error',
            result: null,
            error: 'aborted by test',
          } satisfies ContainerOutput;
        },
      },
    });

    await started;
    expect(await stopTask(task.id)).toBe(true);
    await execution;

    const firstStopMessages = readTaskMessages(projectId, task.id).filter(
      (entry) =>
        entry.role === 'assistant' && entry.content !== 'Stopped by user.',
    );
    expect(firstStopMessages.at(-1)?.content).toBe('Visible tester progress.');
    expect(firstStopMessages.at(-1)?.content).not.toContain('"decision"');

    // A later non-testing stop consumes only its own stream. Before the fix,
    // the first run's filtered UI buffer remained and prefixed this output.
    await updateTask(task.id, { status: 'in_progress' });
    await insertActiveRun(
      runFixture({
        id: 'run-after-stopped-testing',
        group_folder: projectId,
        task_id: task.id,
      }),
    );
    recordTaskStreamChunk(task.id, 'Later coding output.');

    expect(await stopTask(task.id)).toBe(true);
    const assistantMessages = readTaskMessages(projectId, task.id).filter(
      (entry) =>
        entry.role === 'assistant' && entry.content !== 'Stopped by user.',
    );
    expect(assistantMessages.at(-1)?.content).toBe('Later coding output.');
  });

  test('keeps a stop reservation when the old execution finally releases its claim', async () => {
    const task = await createTask({
      project_id: 'proj-stop-race',
      title: 'Do not restart during stop',
      description: '',
      status: 'in_progress',
      priority: 0,
    });
    const run = runFixture({
      id: 'run-stop-race',
      group_folder: task.project_id,
      task_id: task.id,
    });
    await insertActiveRun(run);

    const oldAbort = _testOnlyTryClaimTaskExecution(task.id, task.project_id);
    expect(oldAbort).toBeInstanceOf(AbortController);

    const stopping = stopTask(task.id);

    // Simulate the aborted executeTask reaching its finally block while
    // stopTask is still awaiting DB/process cleanup.
    _testOnlyReleaseTaskExecutionClaim(task.id, oldAbort!);
    expect(_testOnlyTryClaimTaskExecution(task.id, task.project_id)).toBeNull();
    expect(await isTaskRunning(task.id)).toBe(true);

    expect(await stopping).toBe(true);
    expect((await getTask(task.id))?.status).toBe('backlog');
    expect((await getActiveRunById(run.id))?.status).toBe('error');

    // Once backlog and the owned run are finalized, an explicit later resume
    // may claim the task normally.
    const resumedAbort = _testOnlyTryClaimTaskExecution(
      task.id,
      task.project_id,
    );
    expect(resumedAbort).toBeInstanceOf(AbortController);
    _testOnlyReleaseTaskExecutionClaim(task.id, resumedAbort!);
  });

  test('returns a stopped task to backlog without completion metadata', async () => {
    const task = await createTask({
      project_id: 'proj-stop',
      title: 'Retry after stop',
      description: '',
      status: 'in_progress',
      priority: 0,
      completed_at: '2026-01-01T00:00:00.000Z',
    });
    await insertActiveRun(
      runFixture({ group_folder: task.project_id, task_id: task.id }),
    );

    expect(await stopTask(task.id)).toBe(true);

    const stopped = await getTask(task.id);
    expect(stopped?.status).toBe('backlog');
    expect(stopped?.error).toBe('Stopped by user');
    expect(stopped?.completed_at).toBeNull();
  });

  test('keeps a non-initial queue stage the card was moved to before stopping', async () => {
    const task = await createTask({
      project_id: 'proj-stop',
      title: 'Moved to question while running',
      description: '',
      status: 'in_progress',
      priority: 0,
    });
    const run = runFixture({
      id: 'run-moved-to-question',
      group_folder: task.project_id,
      task_id: task.id,
    });
    await insertActiveRun(run);
    await updateTask(task.id, { status: 'question' });

    expect(await stopTask(task.id)).toBe(true);

    const stopped = await getTask(task.id);
    expect(stopped?.status).toBe('question');
    expect(stopped?.error).not.toBe('Stopped by user');
    expect((await getActiveRunById(run.id))?.status).toBe('error');
  });
});

describe('splitFollowUpsFromHistory', () => {
  test('a Testing run drops earlier verdicts but keeps stage comments', () => {
    const messages = [
      { role: 'user' as const, content: 'task' },
      { role: 'assistant' as const, content: 'coded', run_id: 'code-1' },
      { role: 'assistant' as const, content: 'blocked 1', run_id: 'test-1' },
      {
        role: 'system' as const,
        entry_type: 'testing_feedback',
        content: 'Testing blocked 1',
      },
      {
        role: 'system' as const,
        entry_type: 'system_notice',
        content: '**Testing passed**\n\nearlier pass',
      },
      { role: 'assistant' as const, content: 'blocked 2', run_id: 'test-2' },
      {
        role: 'system' as const,
        entry_type: 'testing_feedback',
        content: 'Testing blocked 2',
      },
      {
        role: 'user' as const,
        entry_type: 'stage_prompt',
        content: 'skip migrate and rollback',
      },
    ];
    const split = splitFollowUpsFromHistory(messages);
    const testing = omitTestingVerdicts(
      messages,
      new Set(['test-1', 'test-2']),
    ).map((m) => m.content);
    expect(testing).toEqual(['task', 'coded', 'skip migrate and rollback']);
    // Coding runs keep the tester's feedback.
    expect(split.newUserMessages.map((m) => m.content)).toContain(
      'Testing blocked 2',
    );
    expect(split.historyForFold.map((m) => m.content)).toContain(
      'Testing blocked 1',
    );
    expect(split.historyForFold.map((m) => m.content)).toContain(
      '**Testing passed**\n\nearlier pass',
    );
  });

  test('splits at the last assistant turn — follow-ups after are surfaced', () => {
    const messages = [
      { role: 'user' as const, content: 'original question' },
      { role: 'assistant' as const, content: 'first answer' },
      { role: 'user' as const, content: 'follow-up 1' },
      { role: 'user' as const, content: 'follow-up 2' },
    ];
    const result = splitFollowUpsFromHistory(messages);
    expect(result.lastAssistantIdx).toBe(1);
    expect(result.newUserMessages.map((m) => m.content)).toEqual([
      'follow-up 1',
      'follow-up 2',
    ]);
    // History covers the original question + first answer only.
    expect(result.historyForFold.map((m) => m.content)).toEqual([
      'original question',
      'first answer',
    ]);
  });

  test('includes system-role entries in the follow-up window (matches resume path)', () => {
    const messages = [
      { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: 'a' },
      { role: 'system' as const, content: 'run_start marker' },
      { role: 'user' as const, content: 'next question' },
    ];
    const result = splitFollowUpsFromHistory(messages);
    expect(result.lastAssistantIdx).toBe(1);
    expect(result.newUserMessages.map((m) => m.content)).toEqual([
      'run_start marker',
      'next question',
    ]);
  });

  test('does not surface empty lifecycle markers as resume input', () => {
    const messages = [
      { role: 'user' as const, content: 'original task' },
      { role: 'assistant' as const, content: 'partial implementation' },
      {
        role: 'system' as const,
        entry_type: 'run_start',
        content: '',
      },
    ];

    const result = splitFollowUpsFromHistory(messages);

    expect(result.lastAssistantIdx).toBe(1);
    expect(result.newUserMessages).toEqual([]);
  });

  test('excludes system_notice entries from follow-ups (operator-only messages)', () => {
    const messages = [
      { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: 'a' },
      {
        role: 'system' as const,
        entry_type: 'system_notice',
        content:
          'Review loop limit reached — task paused for manual resolution.',
      },
      { role: 'user' as const, content: 'real follow-up' },
    ];
    const result = splitFollowUpsFromHistory(messages);
    expect(result.newUserMessages.map((m) => m.content)).toEqual([
      'real follow-up',
    ]);
  });

  test('surfaces legacy max-rejection system_notice for existing parked tasks', () => {
    const feedback =
      '**Review loop limit reached** (5/5 rejections) — task paused for manual resolution.\n\n**Last issues:**\n- Preserve the parser tail.';
    const messages = [
      { role: 'assistant' as const, content: 'review result' },
      {
        role: 'system' as const,
        entry_type: 'system_notice',
        content: feedback,
      },
    ];

    const result = splitFollowUpsFromHistory(messages);

    expect(result.newUserMessages.map((m) => m.content)).toEqual([feedback]);
  });

  test('surfaces max-rejection feedback when a parked task is manually resumed', () => {
    const feedback =
      '**Review loop limit reached** (5/5 rejections) — task paused for manual resolution.\n\n**Last issues:**\n- Flush the parser tail on errors.';
    const messages = [
      { role: 'user' as const, content: 'implement the feature' },
      { role: 'assistant' as const, content: 'implementation complete' },
      {
        role: 'system' as const,
        entry_type: 'review_feedback',
        content: feedback,
      },
    ];

    const result = splitFollowUpsFromHistory(messages);

    expect(result.newUserMessages.map((m) => m.content)).toEqual([feedback]);
    expect(result.historyForFold.map((m) => m.content)).toEqual([
      'implement the feature',
      'implementation complete',
    ]);
  });

  test('surfaces testing failure feedback to the resumed implementation run', () => {
    const feedback = '**Testing failed**\n\n**Issues:**\n- bun test failed';
    const result = splitFollowUpsFromHistory([
      { role: 'assistant' as const, content: 'structured testing verdict' },
      {
        role: 'system' as const,
        entry_type: 'testing_feedback',
        content: feedback,
      },
    ]);
    expect(result.newUserMessages.map((message) => message.content)).toEqual([
      feedback,
    ]);
  });

  test('does not globally consume stage prompts or their delivery receipts', () => {
    const result = splitFollowUpsFromHistory([
      { id: 'answer', role: 'assistant' as const, content: 'testing result' },
      {
        id: 'prompt',
        role: 'system' as const,
        entry_type: 'stage_prompt',
        target_stage: 'in_progress',
        content: 'Fix the implementation',
      },
      {
        id: 'receipt',
        role: 'system' as const,
        entry_type: 'stage_prompt_delivery',
        prompt_id: 'other-prompt',
        content: '',
      },
    ]);
    expect(result.newUserMessages).toEqual([]);
  });
});

describe('getPendingStagePrompts', () => {
  const messages = [
    {
      id: 'build-1',
      entry_type: 'stage_prompt',
      target_stage: 'in_progress',
      content: 'first build prompt',
    },
    {
      id: 'testing-1',
      entry_type: 'stage_prompt',
      target_stage: 'testing',
      content: 'testing prompt',
    },
    {
      id: 'build-2',
      entry_type: 'stage_prompt',
      target_stage: 'in_progress',
      content: 'second build prompt',
    },
    {
      id: 'delivery',
      entry_type: 'stage_prompt_delivery',
      prompt_id: 'build-1',
      content: '',
    },
  ];

  test('returns only undelivered prompts for the exact stage in transcript order', () => {
    expect(
      getPendingStagePrompts(messages, 'in_progress').map(
        (message) => message.id,
      ),
    ).toEqual(['build-2']);
    expect(
      getPendingStagePrompts(messages, 'testing').map((message) => message.id),
    ).toEqual(['testing-1']);
  });

  test('a later assistant message from another stage does not consume a prompt', () => {
    const withInterveningTesting = [
      {
        id: 'targeted',
        entry_type: 'stage_prompt',
        target_stage: 'in_progress',
      },
      { id: 'tester', entry_type: 'message' },
    ];
    expect(
      getPendingStagePrompts(withInterveningTesting, 'in_progress').map(
        (message) => message.id,
      ),
    ).toEqual(['targeted']);
  });

  test('defers a prompt authored by the current run until a later stage run', () => {
    const selfAuthored = {
      id: 'self-authored',
      role: 'system',
      entry_type: 'stage_prompt',
      target_stage: 'in_progress',
      run_id: 'current-run',
    };
    expect(
      getPendingTaskDeliveryPrompts(
        [selfAuthored],
        'in_progress',
        'current-run',
      ),
    ).toEqual([]);
    expect(
      getPendingTaskDeliveryPrompts([selfAuthored], 'in_progress'),
    ).toEqual([selfAuthored]);
  });
});

describe('Kanban Auto runtime routing', () => {
  useCleanPipelineTestDatabase();

  const AUTO_STAGE = 'in_progress';
  const agentsFile = path.join(DATA_DIR, 'board_agents.jsonc');
  let previousAgents: string | undefined;

  beforeAll(() => {
    previousAgents = fs.existsSync(agentsFile)
      ? fs.readFileSync(agentsFile, 'utf8')
      : undefined;
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        version: 2,
        harnesses: {
          codex: {
            label: 'Codex',
            kind: 'cli',
            agentCmd: 'codex',
            sessionFamily: 'codex',
          },
          claude: {
            label: 'Claude',
            kind: 'cli',
            agentCmd: 'claude',
            sessionFamily: 'claude',
          },
        },
        models: {
          'claude-big': {
            label: 'Claude big',
            bindings: { claude: { model: 'm-claude' } },
          },
          'harness-configured-default': {
            label: 'Harness default',
            bindings: { codex: {} },
          },
          small: { label: 'Small', bindings: { codex: { model: 'm-fast' } } },
          medium: { label: 'Medium', bindings: { codex: { model: 'm-mid' } } },
          large: { label: 'Large', bindings: { codex: { model: 'm-top' } } },
          auto: {
            label: 'Auto',
            auto: true,
            bindings: {
              codex: {
                tiers: { fast: 'small', balanced: 'medium', frontier: 'large' },
              },
              // Claude's Auto routes to Codex candidates.
              claude: {
                tiers: {
                  fast: ['codex:small'],
                  balanced: ['codex:medium'],
                  frontier: ['codex:large', 'claude:claude-big'],
                },
              },
            },
          },
        },
        defaults: {
          chat: { harnessId: 'codex', modelId: 'medium' },
          kanban: {
            fallback: { harnessId: 'codex', modelId: 'medium' },
            stages: {},
          },
        },
      }),
    );
    reloadChatAgents();
  });

  afterAll(() => {
    if (previousAgents === undefined) fs.rmSync(agentsFile, { force: true });
    else fs.writeFileSync(agentsFile, previousAgents);
    reloadChatAgents();
  });

  const group = (projectId: string, minTier?: ModelTier): RegisteredGroup => ({
    name: projectId,
    folder: projectId,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'running',
      taskCheckoutMode: 'worktree',
      stages: [
        {
          id: AUTO_STAGE,
          title: 'In Progress',
          type: 'active',
          color: '#38f',
          ...(minTier ? { minTier } : {}),
        },
        { id: 'done', title: 'Done', type: 'done', color: '#2c5' },
        { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
      ],
    },
  });

  /** Run the task once and return the model the worker was launched with. */
  async function runOnce(
    taskId: string,
    projectId: string,
    deps: {
      routeText: (text: string) => Promise<RoutingDecision | null>;
      engine?: 'jev' | 'off';
      providerUsage?: ProviderUsageAccount[] | null;
      minTier?: ModelTier;
      freshSession?: boolean;
      onLaunch?: (launch: { agent_cmd?: string }) => void;
    },
  ): Promise<string | undefined> {
    await updateTask(taskId, { status: AUTO_STAGE });
    const task = (await getTask(taskId))!;
    let launchedModel: string | undefined;
    await executeTask(task, group(projectId, deps.minTier), {
      freshSession: deps.freshSession,
      testDependencies: {
        modelRoutingEngine: deps.engine ?? 'jev',
        routeText: deps.routeText,
        loadProviderUsage: async () => deps.providerUsage ?? null,
        runContainerAgent: async (_group, input) => {
          launchedModel = input.model;
          deps.onLaunch?.(input);
          await input.onSlotAcquired?.(`${taskId}-run`);
          return { status: 'success', result: 'done' } as ContainerOutput;
        },
        runPostExecutionGitOps: async () => {},
        mergeBranchForDeploy: async () => true,
        drainProjectQueue: async () => {},
      },
    });
    return launchedModel;
  }

  const decision = (tier: ModelTier): RoutingDecision => ({
    tier,
    rawTier: tier,
    confidence: 0.9,
    sensitive: 0.1,
    latencyMs: 12,
    reason: 'clean',
  });

  test('routes a fresh Auto session once, then keeps the recorded model for a continuing session and a transient retry', async () => {
    const projectId = 'auto-routing-fresh-continue';
    const auto = { harnessId: 'codex', modelId: 'auto' };
    const task = await createTask({
      project_id: projectId,
      title: 'Route me',
      description: 'Design the cache layer',
      status: AUTO_STAGE,
      priority: 0,
      runtimeSelection: auto,
      custom_values: { owner: 'alice' },
    });
    const route = mock(async () => decision('frontier'));

    expect(await runOnce(task.id, projectId, { routeText: route })).toBe(
      'm-top',
    );
    expect(route).toHaveBeenCalledTimes(1);
    // The router call is attributed to the task's project for privacy gating.
    expect(route).toHaveBeenCalledWith(expect.any(String), { projectId });
    expect((await getTask(task.id))?.custom_values).toMatchObject({
      owner: 'alice',
      routing: {
        [AUTO_STAGE]: {
          tier: 'frontier',
          modelId: 'large',
          reason: 'clean',
        },
      },
    });

    // The first run's session continues: no router call, same model.
    const sessionKey = runtimeSessionKey(
      resolveKanbanRuntimeSelection([auto], AUTO_STAGE).agent,
    );
    await insertActiveRun(
      runFixture({
        id: 'auto-routing-prior-run',
        group_folder: projectId,
        task_id: task.id,
        stage: AUTO_STAGE,
        session_id: 'auto-session',
        agent_name: sessionKey,
        session_agent_key: sessionKey,
      }),
    );
    await completeActiveRun('auto-routing-prior-run', 'completed');
    await updateTask(task.id, {
      session_id: 'auto-session',
      last_agent_name: sessionKey,
    });
    const unexpected = mock(async () => decision('fast'));
    expect(await runOnce(task.id, projectId, { routeText: unexpected })).toBe(
      'm-top',
    );
    expect(unexpected).not.toHaveBeenCalled();

    // A transient retry that restarts the session still keeps the model.
    await updateTask(task.id, { session_id: '' });
    scheduleTransientTaskRetry(
      task.id,
      projectId,
      group(projectId),
      async () => {},
      null,
    );
    expect(await runOnce(task.id, projectId, { routeText: unexpected })).toBe(
      'm-top',
    );
    expect(unexpected).not.toHaveBeenCalled();
  });

  test('raises the tier one step after a no-progress rejection without calling the router', async () => {
    const projectId = 'auto-routing-escalation';
    const task = await createTask({
      project_id: projectId,
      title: 'Escalate me',
      description: '',
      status: AUTO_STAGE,
      priority: 0,
      runtimeSelection: { harnessId: 'codex', modelId: 'auto' },
      custom_values: {
        rejection_count: 1,
        review_history: JSON.stringify([
          {
            timestamp: new Date().toISOString(),
            commit: '',
            issues: [{ id: 'a', text: 'still broken' }],
            summary: 'rejected',
            comparison: {
              decision: 'retry',
              progress: 'no_progress',
              reason: 'same issue',
            },
          },
        ]),
        // `routing` is a nested object inside the JSON custom values.
        routing: {
          [AUTO_STAGE]: {
            tier: 'fast',
            rawTier: 'fast',
            modelId: 'small',
            confidence: 0.9,
            sensitive: 0,
            latencyMs: 1,
            reason: 'clean',
            at: new Date().toISOString(),
            rejectionCount: 0,
            testingFailureCount: 0,
          },
        },
      } as unknown as Task['custom_values'],
    });
    const route = mock(async () => decision('frontier'));

    expect(await runOnce(task.id, projectId, { routeText: route })).toBe(
      'm-mid',
    );
    expect(route).not.toHaveBeenCalled();
    expect((await getTask(task.id))?.custom_values).toMatchObject({
      routing: {
        [AUTO_STAGE]: { tier: 'balanced', reason: 'escalation-no-progress' },
      },
    });
  });

  test('an Auto tier on another harness runs there, and a continuing session keeps it', async () => {
    const projectId = 'auto-routing-cross-harness';
    const task = await createTask({
      project_id: projectId,
      title: 'Cross harness',
      description: 'Design the cache layer',
      status: AUTO_STAGE,
      priority: 0,
      runtimeSelection: { harnessId: 'claude', modelId: 'auto' },
    });
    const route = mock(async () => decision('frontier'));
    let launchedAgent: string | undefined;
    const onLaunch = (launch: { agent_cmd?: string }) => {
      launchedAgent = launch.agent_cmd;
    };

    expect(
      await runOnce(task.id, projectId, { routeText: route, onLaunch }),
    ).toBe('m-top');
    expect(launchedAgent).toBe('codex');
    expect((await getTask(task.id))?.custom_values).toMatchObject({
      routing: {
        [AUTO_STAGE]: {
          tier: 'frontier',
          harnessId: 'codex',
          modelId: 'large',
        },
      },
    });

    // The continuing session keeps the recorded harness without a router call.
    const sessionKey = runtimeSessionKey(
      resolveKanbanRuntimeSelection(
        [{ harnessId: 'codex', modelId: 'large' }],
        AUTO_STAGE,
      ).agent,
    );
    await insertActiveRun(
      runFixture({
        id: 'auto-routing-cross-prior-run',
        group_folder: projectId,
        task_id: task.id,
        stage: AUTO_STAGE,
        session_id: 'cross-session',
        agent_name: sessionKey,
        session_agent_key: sessionKey,
      }),
    );
    await completeActiveRun('auto-routing-cross-prior-run', 'completed');
    await updateTask(task.id, {
      session_id: 'cross-session',
      last_agent_name: sessionKey,
    });
    const unexpected = mock(async () => decision('fast'));
    expect(
      await runOnce(task.id, projectId, { routeText: unexpected, onLaunch }),
    ).toBe('m-top');
    expect(launchedAgent).toBe('codex');
    expect(unexpected).not.toHaveBeenCalled();
  });

  test('a fresh session starts on the tier candidate with room left, and a continuing session keeps it', async () => {
    const projectId = 'auto-routing-capacity';
    const task = await createTask({
      project_id: projectId,
      title: 'Capacity routing',
      description: 'Design the cache layer',
      status: AUTO_STAGE,
      priority: 0,
      runtimeSelection: { harnessId: 'claude', modelId: 'auto' },
    });
    const usage = (codexUsed: number, claudeUsed: number) => [
      {
        provider: 'codex',
        capacity: 50,
        windows: [
          {
            label: 'Weekly',
            usedPercent: codexUsed,
            remainingCapacity: Math.round((50 * (100 - codexUsed)) / 100),
          },
        ],
      },
      {
        provider: 'anthropic',
        capacity: 100,
        windows: [
          {
            label: 'Weekly',
            usedPercent: claudeUsed,
            remainingCapacity: 100 - claudeUsed,
          },
        ],
      },
    ];
    let launchedAgent: string | undefined;
    const onLaunch = (launch: { agent_cmd?: string }) => {
      launchedAgent = launch.agent_cmd;
    };

    // The frontier lists codex first, but codex has no room left.
    expect(
      await runOnce(task.id, projectId, {
        routeText: async () => decision('frontier'),
        providerUsage: usage(97, 20),
        onLaunch,
      }),
    ).toBe('m-claude');
    expect(launchedAgent).toBe('claude');
    expect((await getTask(task.id))?.custom_values).toMatchObject({
      routing: {
        [AUTO_STAGE]: {
          tier: 'frontier',
          harnessId: 'claude',
          modelId: 'claude-big',
          capacityReason: 'most-remaining',
          remainingCapacity: 80,
        },
      },
    });

    const sessionKey = runtimeSessionKey(
      resolveKanbanRuntimeSelection(
        [{ harnessId: 'claude', modelId: 'claude-big' }],
        AUTO_STAGE,
      ).agent,
    );
    await insertActiveRun(
      runFixture({
        id: 'auto-routing-capacity-prior-run',
        group_folder: projectId,
        task_id: task.id,
        stage: AUTO_STAGE,
        session_id: 'capacity-session',
        agent_name: sessionKey,
        session_agent_key: sessionKey,
      }),
    );
    await completeActiveRun('auto-routing-capacity-prior-run', 'completed');
    await updateTask(task.id, {
      session_id: 'capacity-session',
      last_agent_name: sessionKey,
    });

    // Codex now has the most room, but the continuing session stays put.
    const unexpected = mock(async () => decision('fast'));
    expect(
      await runOnce(task.id, projectId, {
        routeText: unexpected,
        providerUsage: usage(0, 90),
        onLaunch,
      }),
    ).toBe('m-claude');
    expect(launchedAgent).toBe('claude');
    expect(unexpected).not.toHaveBeenCalled();
  });

  test('a fresh run routes past a stored candidate that is no longer enabled', async () => {
    const projectId = 'auto-routing-stored-unavailable';
    const task = await createTask({
      project_id: projectId,
      title: 'Stored candidate gone',
      description: 'Design the cache layer',
      status: AUTO_STAGE,
      priority: 0,
      runtimeSelection: { harnessId: 'claude', modelId: 'auto' },
    });
    let launchedAgent: string | undefined;
    const onLaunch = (launch: { agent_cmd?: string }) => {
      launchedAgent = launch.agent_cmd;
    };
    expect(
      await runOnce(task.id, projectId, {
        routeText: async () => decision('frontier'),
        onLaunch,
      }),
    ).toBe('m-top');
    expect(launchedAgent).toBe('codex');

    // Disable codex:large; the claude candidate of the frontier tier remains.
    const original = fs.readFileSync(agentsFile, 'utf8');
    try {
      const config = JSON.parse(original);
      delete config.models.large;
      fs.writeFileSync(agentsFile, JSON.stringify(config));
      reloadChatAgents();

      const route = mock(async () => decision('frontier'));
      expect(
        await runOnce(task.id, projectId, {
          routeText: route,
          freshSession: true,
          onLaunch,
        }),
      ).toBe('m-claude');
      expect(launchedAgent).toBe('claude');
      expect(route).toHaveBeenCalledTimes(1);
      expect((await getTask(task.id))?.custom_values).toMatchObject({
        routing: {
          [AUTO_STAGE]: { harnessId: 'claude', modelId: 'claude-big' },
        },
      });
    } finally {
      fs.writeFileSync(agentsFile, original);
      reloadChatAgents();
    }

    // A genuine continuation of the stored claude session still fails closed.
    const claudeKey = runtimeSessionKey(
      resolveKanbanRuntimeSelection(
        [{ harnessId: 'claude', modelId: 'claude-big' }],
        AUTO_STAGE,
      ).agent,
    );
    await insertActiveRun(
      runFixture({
        id: 'auto-routing-stored-claude-run',
        group_folder: projectId,
        task_id: task.id,
        stage: AUTO_STAGE,
        session_id: 'claude-session',
        agent_name: claudeKey,
        session_agent_key: claudeKey,
      }),
    );
    await completeActiveRun('auto-routing-stored-claude-run', 'completed');
    await updateTask(task.id, {
      session_id: 'claude-session',
      last_agent_name: claudeKey,
    });
    try {
      const config = JSON.parse(original);
      delete config.models['claude-big'];
      fs.writeFileSync(agentsFile, JSON.stringify(config));
      reloadChatAgents();
      let failedRunLaunched = false;
      await runOnce(task.id, projectId, {
        routeText: async () => decision('frontier'),
        onLaunch: () => {
          failedRunLaunched = true;
        },
      });
      const failed = await getTask(task.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toContain('Incompatible runtime selection');
      expect(failedRunLaunched).toBe(false);
    } finally {
      fs.writeFileSync(agentsFile, original);
      reloadChatAgents();
    }

    // The stored claude record never produced a session, while the coding
    // stage's newest session is codex's: the stored runtime is not owned, so
    // the resumed run reroutes instead of failing closed.
    const unowned = await createTask({
      project_id: 'auto-routing-stored-unowned',
      title: 'Stored runtime never ran',
      description: '',
      status: AUTO_STAGE,
      priority: 0,
      runtimeSelection: { harnessId: 'claude', modelId: 'auto' },
      custom_values: {
        routing: {
          [AUTO_STAGE]: {
            tier: 'frontier',
            rawTier: 'frontier',
            harnessId: 'claude',
            modelId: 'claude-big',
            sessionAgentKey: claudeKey,
            confidence: 0.9,
            sensitive: 0,
            latencyMs: 1,
            reason: 'clean',
            at: new Date().toISOString(),
            rejectionCount: 0,
            testingFailureCount: 0,
          },
        },
      } as unknown as Task['custom_values'],
    });
    const codexSessionKey = runtimeSessionKey(
      resolveKanbanRuntimeSelection(
        [{ harnessId: 'codex', modelId: 'medium' }],
        AUTO_STAGE,
      ).agent,
    );
    await insertActiveRun(
      runFixture({
        id: 'auto-routing-unowned-codex-run',
        group_folder: 'auto-routing-stored-unowned',
        task_id: unowned.id,
        stage: AUTO_STAGE,
        session_id: 'codex-session',
        agent_name: codexSessionKey,
        session_agent_key: codexSessionKey,
      }),
    );
    await completeActiveRun('auto-routing-unowned-codex-run', 'completed');
    await updateTask(unowned.id, {
      session_id: 'testing-session',
      last_agent_name: codexSessionKey,
    });
    try {
      const config = JSON.parse(original);
      delete config.models['claude-big'];
      fs.writeFileSync(agentsFile, JSON.stringify(config));
      reloadChatAgents();
      expect(
        await runOnce(unowned.id, 'auto-routing-stored-unowned', {
          routeText: async () => decision('balanced'),
          onLaunch,
        }),
      ).toBe('m-mid');
      expect(launchedAgent).toBe('codex');
    } finally {
      fs.writeFileSync(agentsFile, original);
      reloadChatAgents();
    }

    // Coding ran on claude, then Testing ran on codex. The newest coding session
    // is claude's, but the task's last agent is codex, so re-entering coding is
    // a new session (agentChanged) and reroutes to the enabled codex candidate.
    const testingReentry = await createTask({
      project_id: 'auto-routing-testing-reentry',
      title: 'Testing ran on codex',
      description: '',
      status: AUTO_STAGE,
      priority: 0,
      runtimeSelection: { harnessId: 'claude', modelId: 'auto' },
      custom_values: {
        routing: {
          [AUTO_STAGE]: {
            tier: 'frontier',
            rawTier: 'frontier',
            harnessId: 'claude',
            modelId: 'claude-big',
            sessionAgentKey: claudeKey,
            confidence: 0.9,
            sensitive: 0,
            latencyMs: 1,
            reason: 'clean',
            at: new Date().toISOString(),
            rejectionCount: 0,
            testingFailureCount: 0,
          },
        },
      } as unknown as Task['custom_values'],
    });
    await insertActiveRun(
      runFixture({
        id: 'auto-routing-testing-reentry-claude-run',
        group_folder: 'auto-routing-testing-reentry',
        task_id: testingReentry.id,
        stage: AUTO_STAGE,
        session_id: 'claude-coding-session',
        agent_name: claudeKey,
        session_agent_key: claudeKey,
      }),
    );
    await completeActiveRun(
      'auto-routing-testing-reentry-claude-run',
      'completed',
    );
    await updateTask(testingReentry.id, {
      session_id: 'testing-session',
      last_agent_name: codexSessionKey,
    });
    try {
      const config = JSON.parse(original);
      delete config.models['claude-big'];
      fs.writeFileSync(agentsFile, JSON.stringify(config));
      reloadChatAgents();
      const reentryLaunch: { agent?: string } = {};
      expect(
        await runOnce(testingReentry.id, 'auto-routing-testing-reentry', {
          routeText: async () => decision('frontier'),
          onLaunch: (launch) => {
            reentryLaunch.agent = launch.agent_cmd;
          },
        }),
      ).toBe('m-top');
      expect(reentryLaunch.agent).toBe('codex');
      expect((await getTask(testingReentry.id))?.status).not.toBe('failed');
    } finally {
      fs.writeFileSync(agentsFile, original);
      reloadChatAgents();
    }
  });

  test('a stage minTier raises the routed tier, also with routing off', async () => {
    const route = mock(async () => decision('fast'));
    const routed = await createTask({
      project_id: 'auto-routing-min-tier',
      title: 'Minimum tier',
      description: '',
      status: AUTO_STAGE,
      priority: 0,
      runtimeSelection: { harnessId: 'codex', modelId: 'auto' },
    });
    expect(
      await runOnce(routed.id, 'auto-routing-min-tier', {
        routeText: route,
        minTier: 'frontier',
      }),
    ).toBe('m-top');
    expect(route).toHaveBeenCalledTimes(1);
    expect((await getTask(routed.id))?.custom_values).toMatchObject({
      routing: {
        [AUTO_STAGE]: {
          tier: 'frontier',
          rawTier: 'fast',
          reason: 'stage-min-tier',
          modelId: 'large',
        },
      },
    });

    // With routing off the stage floor still applies, and the router is not called.
    const off = await createTask({
      project_id: 'auto-routing-min-tier-off',
      title: 'Minimum tier with routing off',
      description: '',
      status: AUTO_STAGE,
      priority: 0,
      runtimeSelection: { harnessId: 'codex', modelId: 'auto' },
    });
    expect(
      await runOnce(off.id, 'auto-routing-min-tier-off', {
        routeText: route,
        engine: 'off',
        minTier: 'frontier',
      }),
    ).toBe('m-top');
    expect(route).toHaveBeenCalledTimes(1);
    expect((await getTask(off.id))?.custom_values).toMatchObject({
      routing: { [AUTO_STAGE]: { tier: 'frontier', reason: 'stage-min-tier' } },
    });

    // Lowering the stage floor: a fresh balanced run drops the frontier record,
    // so its continuation keeps balanced instead of restoring the old pin.
    expect(
      await runOnce(off.id, 'auto-routing-min-tier-off', {
        routeText: route,
        engine: 'off',
        freshSession: true,
      }),
    ).toBe('m-mid');
    const routingAfter = (await getTask(off.id))?.custom_values?.routing as
      | Record<string, unknown>
      | undefined;
    expect(routingAfter?.[AUTO_STAGE]).toBeUndefined();
    const offSessionKey = runtimeSessionKey(
      resolveKanbanRuntimeSelection(
        [{ harnessId: 'codex', modelId: 'auto' }],
        AUTO_STAGE,
      ).agent,
    );
    await insertActiveRun(
      runFixture({
        id: 'auto-routing-min-tier-off-prior-run',
        group_folder: 'auto-routing-min-tier-off',
        task_id: off.id,
        stage: AUTO_STAGE,
        session_id: 'auto-session-off',
        agent_name: offSessionKey,
        session_agent_key: offSessionKey,
      }),
    );
    await completeActiveRun('auto-routing-min-tier-off-prior-run', 'completed');
    await updateTask(off.id, {
      session_id: 'auto-session-off',
      last_agent_name: offSessionKey,
    });
    expect(
      await runOnce(off.id, 'auto-routing-min-tier-off', {
        routeText: route,
        engine: 'off',
      }),
    ).toBe('m-mid');
  });

  test('never routes an explicit model, the harness default, or Auto with routing off', async () => {
    const route = mock(async () => decision('frontier'));
    const run = async (
      projectId: string,
      modelId: string,
      engine: 'jev' | 'off',
    ) => {
      const task = await createTask({
        project_id: projectId,
        title: projectId,
        description: '',
        status: AUTO_STAGE,
        priority: 0,
        runtimeSelection: { harnessId: 'codex', modelId },
      });
      const model = await runOnce(task.id, projectId, {
        routeText: route,
        engine,
      });
      return { model, task: await getTask(task.id) };
    };

    expect((await run('auto-routing-explicit', 'small', 'jev')).model).toBe(
      'm-fast',
    );
    const harnessDefault = await run(
      'auto-routing-harness-default',
      'harness-configured-default',
      'jev',
    );
    expect(harnessDefault.task?.custom_values?.routing).toBeUndefined();
    const off = await run('auto-routing-off', 'auto', 'off');
    expect(off.model).toBe('m-mid');
    expect(off.task?.custom_values?.routing).toBeUndefined();
    expect(route).not.toHaveBeenCalled();
  });
});

describe('shared-checkout preflight failure', () => {
  useCleanPipelineTestDatabase();

  const sharedGroup = (projectId: string): RegisteredGroup => ({
    name: 'Shared preflight',
    folder: projectId,
    trigger: '@Capa',
    added_at: new Date().toISOString(),
    settings: {
      status: 'paused',
      taskCheckoutMode: 'shared',
      stages: [
        { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
        {
          id: 'in_progress',
          title: 'In progress',
          type: 'active',
          color: '#08f',
        },
        { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        { id: 'completed', title: 'Completed', type: 'done', color: '#0a0' },
      ],
    },
  });

  test.each([
    [
      'throws',
      async (): Promise<boolean> => {
        throw new Error('merge exploded');
      },
      'merge exploded',
    ],
  ])(
    'fails the task and drains the queue when the prior-branch merge %s',
    async (_name, merge, expectedError) => {
      const projectId = `shared-preflight-${expectedError.split(' ')[0]}`;
      const task = await createTask({
        project_id: projectId,
        title: 'Shared preflight failure',
        description: '',
        status: 'in_progress',
        priority: 0,
        branch_name: 'prior-task-branch',
        worktree_path: null,
      });
      let drains = 0;
      let workerStarted = false;

      await expect(
        executeTask(task, sharedGroup(projectId), {
          testDependencies: {
            mergeBranchForDeploy: merge,
            drainProjectQueue: async () => {
              drains++;
            },
            runContainerAgent: async () => {
              workerStarted = true;
              return {
                status: 'success',
                result: '',
              } satisfies ContainerOutput;
            },
          },
        }),
      ).rejects.toThrow(expectedError);

      expect(workerStarted).toBe(false);
      const failed = await getTask(task.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toContain(expectedError);
      expect(drains).toBe(1);
      expect(await isTaskRunning(task.id)).toBe(false);
    },
  );

  test('preserves the parked task after a stage-entry merge returns false', async () => {
    const projectId = 'shared-preflight-stage-entry';
    const task = await createTask({
      project_id: projectId,
      title: 'Shared preflight stage entry',
      description: '',
      status: 'in_progress',
      priority: 0,
      branch_name: 'prior-task-branch',
      worktree_path: null,
    });
    let drains = 0;

    await executeTask(task, sharedGroup(projectId), {
      automaticStageEntryEventId: 'missing-stage-entry-event',
      testDependencies: {
        prepareStageEntryEventIfOwned: async () => true,
        mergeBranchForDeploy: async () => {
          await updateTask(task.id, { status: 'backlog' });
          return false;
        },
        drainProjectQueue: async () => {
          drains++;
        },
      },
    });

    expect((await getTask(task.id))?.status).toBe('backlog');
    expect(drains).toBe(1);
    expect(await isTaskRunning(task.id)).toBe(false);
  });
});

describe('per-task cost limit', () => {
  useCleanPipelineTestDatabase();

  test('parks an over-limit automatic dispatch once while user-triggered runs still start', async () => {
    const projectId = 'task-cost-limit';
    const group: RegisteredGroup = {
      name: 'Task cost limit',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused',
        taskCheckoutMode: 'shared',
        kanbanTaskCostLimitUsd: 1,
        stages: [
          { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active',
            color: '#08f',
          },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
          { id: 'completed', title: 'Completed', type: 'done', color: '#0a0' },
        ],
      },
    };
    const task = await createTask({
      project_id: projectId,
      title: 'Expensive card',
      description: '',
      status: 'in_progress',
      priority: 0,
      // A run that passes the cost gate fails in this later preflight step, so
      // no container is needed to observe whether the gate let it through.
      branch_name: 'prior-task-branch',
      worktree_path: null,
    });
    const run = runFixture({
      id: 'cost-limit-prior-run',
      group_folder: projectId,
      task_id: task.id,
      status: 'running',
    });
    await insertActiveRun(run);
    await completeActiveRun(run.id, 'completed', { cost_usd: 1.2 });
    const testDependencies = {
      mergeBranchForDeploy: async (): Promise<boolean> => {
        throw new Error('Unable to reconcile');
      },
      drainProjectQueue: async () => {},
    };

    // Automatic dispatch: blocked and parked in backlog, exactly once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = (await getTask(task.id))!;
      await executeTask(current, group, { testDependencies });
      await updateTask(task.id, { status: 'in_progress' });
    }
    const parkedMessages = readTaskMessages(projectId, task.id).filter(
      (message) => message.content.startsWith('Cost limit reached'),
    );
    expect(parkedMessages).toHaveLength(1);
    expect(
      (await getTask(task.id))?.custom_values?.cost_limit_hit_at,
    ).toBeTruthy();

    // A per-task override above the total lets the automatic run through.
    await updateTask(task.id, {
      status: 'in_progress',
      custom_values: { cost_limit_usd: 5 },
    });
    await expect(
      executeTask((await getTask(task.id))!, group, { testDependencies }),
    ).rejects.toThrow('Unable to reconcile');

    // A human moving the card into an executable stage is dispatched without
    // attribution, but its persisted trigger postdates the last run.
    await updateTask(task.id, {
      status: 'in_progress',
      custom_values: {},
      lastTriggeredByUserId: null,
      lastTriggerSource: 'user',
      lastTriggeredAt: new Date(Date.now() + 1_000).toISOString(),
    });
    await expect(
      executeTask((await getTask(task.id))!, group, { testDependencies }),
    ).rejects.toThrow('Unable to reconcile');

    // A user-triggered run on an over-limit task starts.
    await updateTask(task.id, {
      status: 'in_progress',
      custom_values: {},
    });
    await expect(
      executeTask((await getTask(task.id))!, group, {
        testDependencies,
        triggerAttribution: {
          triggeredByUserId: 'user-1',
          triggerSource: 'user',
        },
      }),
    ).rejects.toThrow('Unable to reconcile');
  });
});

describe('privacy mode kanban runtime gate', () => {
  useCleanPipelineTestDatabase();

  async function runWithPrivacyMode(
    projectId: string,
    privacyMode: 'strict' | undefined,
  ) {
    const jid = `${projectId}@web`;
    const group: RegisteredGroup = {
      jid,
      name: projectId,
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        taskCheckoutMode: 'shared',
        ...(privacyMode ? { privacyMode } : {}),
        stages: [
          { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
          { id: 'question', title: 'Question', type: 'queue', color: '#fa0' },
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active',
            color: '#08f',
          },
          { id: 'completed', title: 'Completed', type: 'done', color: '#0a0' },
        ],
      },
    };
    await loadState();
    await registerGroup(jid, group);
    try {
      const task = await createTask({
        project_id: projectId,
        title: 'Privacy gated card',
        description: '',
        status: 'in_progress',
        priority: 0,
      });
      const inputs: ContainerInput[] = [];
      await executeTask(task, group, {
        testDependencies: {
          runContainerAgent: async (_group, input) => {
            inputs.push(input);
            return { status: 'success', result: 'done' };
          },
          runPostExecutionGitOps: async () => {},
          mergeBranchForDeploy: async () => true,
          drainProjectQueue: async () => {},
        },
      });
      return { task, inputs, after: (await getTask(task.id))! };
    } finally {
      await unregisterGroup(jid);
    }
  }

  test('a strict project parks a remote-runtime task in Question without launching', async () => {
    const { task, inputs, after } = await runWithPrivacyMode(
      'privacy-gate-strict',
      'strict',
    );
    expect(inputs).toHaveLength(0);
    expect(after.status).toBe('question');
    expect(after.error).toContain('Privacy mode "strict"');
    expect(await isTaskRunning(task.id)).toBe(false);
    expect(
      readTaskMessages(task.project_id, task.id).some((message) =>
        message.content.startsWith('Privacy mode "strict" blocks this run'),
      ),
    ).toBe(true);
  });

  test('a project without privacyMode launches once and passes the resolved runtime', async () => {
    const { inputs, after } = await runWithPrivacyMode(
      'privacy-gate-off',
      undefined,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0].privacyRuntime).toBeDefined();
    expect(after.status).not.toBe('question');
  });
});

describe('Review with extra reviewers (co_stages)', () => {
  useCleanPipelineTestDatabase();

  const agentsFile = path.join(DATA_DIR, 'board_agents.jsonc');
  let previousAgents: string | undefined;

  beforeAll(() => {
    previousAgents = fs.existsSync(agentsFile)
      ? fs.readFileSync(agentsFile, 'utf8')
      : undefined;
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        version: 2,
        harnesses: {
          codex: {
            label: 'Codex',
            kind: 'cli',
            agentCmd: 'codex',
            sessionFamily: 'codex',
          },
        },
        models: {
          primary: {
            label: 'Primary',
            bindings: { codex: { model: 'm-primary' } },
          },
          second: {
            label: 'Second',
            bindings: { codex: { model: 'm-second' } },
          },
        },
        defaults: {
          chat: { harnessId: 'codex', modelId: 'primary' },
          kanban: {
            fallback: { harnessId: 'codex', modelId: 'primary' },
            stages: {},
          },
        },
      }),
    );
    reloadChatAgents();
  });

  afterAll(() => {
    if (previousAgents === undefined) fs.rmSync(agentsFile, { force: true });
    else fs.writeFileSync(agentsFile, previousAgents);
    reloadChatAgents();
  });

  const headA = '1111111111111111111111111111111111111111';
  const headB = '2222222222222222222222222222222222222222';
  const verdict = (
    decision: 'approve' | 'reject',
    score: number,
    ...issues: string[]
  ) =>
    JSON.stringify({
      decision,
      score,
      issues: issues.map((title) => ({ title, description: 'detail' })),
      summary: `${decision} summary`,
    });

  async function runReviewChain(
    name: string,
    coStages: string[] | undefined,
    outputs: string[],
    options: {
      moveHeadAfterRun?: number;
      /** 1-based run numbers that end in a terminal error. */
      failRuns?: number[];
      taskRuntime?: boolean;
      /** Manual Review trigger over stale Testing evidence. */
      manual?: boolean;
      /** A rejection already on record, so the next one is compared. */
      priorRejection?: boolean;
      /** Totals already on record, e.g. a card parked by the rejection cap. */
      priorCounts?: { rejection_count: number; rejection_cap_base?: number };
      /** Rejected rounds already on record (replaces the default `priorRejection` entry). */
      reviewHistory?: object[];
      /** 1-based run numbers that end in a transient provider error. */
      retryableRuns?: number[];
      /** 1-based run numbers that fail before an agent run exists. */
      throwRuns?: number[];
      /** A finished Testing run, so the card's latest run is not a review run. */
      priorTestingRun?: boolean;
      /** Runtime selection of the `review.o` alternative (default: codex/second). */
      extraRuntime?: { harnessId: string; modelId: string; reasoning?: string };
    } = {},
  ) {
    const projectId = `review-chain-${name}`;
    const group = {
      name,
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          ...reviewLifecycleStages,
          {
            id: 'review.o',
            title: 'Review O',
            type: 'review' as const,
            color: '#f80',
            runtimeSelection: options.extraRuntime ?? {
              harnessId: 'codex',
              modelId: 'second',
            },
          },
        ],
      },
    };
    let head = headA;
    const task = await createTask({
      project_id: projectId,
      title: name,
      description: '',
      status: 'review',
      priority: 0,
      coStages,
      ...(options.taskRuntime
        ? { runtimeSelection: { harnessId: 'codex', modelId: 'primary' } }
        : {}),
      ...(options.manual
        ? {
            lastTriggerSource: 'user' as const,
            lastTriggeredAt: '2020-01-02T00:00:00.000Z',
          }
        : {}),
      custom_values: {
        [TESTING_HEAD_SHA_KEY]: options.manual ? headB : headA,
        [TESTING_TREE_SHA_KEY]: options.manual ? headB : headA,
        ...(options.priorRejection || options.reviewHistory
          ? {
              rejection_count: 1,
              no_progress_count: 1,
              review_history: JSON.stringify(
                options.reviewHistory ?? [
                  {
                    timestamp: '2020-01-01T00:00:00.000Z',
                    commit: headB,
                    issues: [{ id: 'old issue', text: 'Old issue' }],
                    summary: 'earlier rejection',
                  },
                ],
              ),
            }
          : {}),
        ...(options.priorCounts ?? {}),
      },
    });
    if (options.priorTestingRun) {
      await insertActiveRun(
        runFixture({
          id: `${projectId}-testing`,
          group_folder: projectId,
          task_id: task.id,
          stage: 'testing',
        }),
      );
      await completeActiveRun(`${projectId}-testing`, 'completed');
    }
    await appendTaskMessageAsync(projectId, {
      task_id: task.id,
      role: 'assistant',
      content: 'TESTING-EVIDENCE-MARKER',
      created_at: '2020-01-01T00:00:00.000Z',
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const models: Array<string | undefined> = [];
    const prompts: string[] = [];
    const runOwners: Array<string | undefined> = [];
    const dependencies = {
      prepareTaskBranchForReview: async () => {},
      readTaskGitContentIdentity: async () => ({
        headSha: head,
        treeSha: headA,
      }),
      runGitInRepo: fakeReviewGit(
        () => head,
        () => headA,
      ),
      inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
      mergeBranchForDeploy: async () => true,
      runPostExecutionGitOps: async () => {},
      drainProjectQueue: async () => {},
      runContainerAgent: async (_group: unknown, input: ContainerInput) => {
        calls += 1;
        if (options.throwRuns?.includes(calls)) {
          throw new Error('sandbox failed to start');
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        await input.onCheckoutReady?.(input);
        const runId = `${projectId}-run-${models.length}`;
        await insertActiveRun(
          runFixture({
            id: runId,
            group_folder: projectId,
            task_id: task.id,
            stage: 'review',
          }),
        );
        await input.onSlotAcquired?.(runId);
        const claimed = JSON.parse(
          String(
            (await getTask(task.id))?.custom_values?.review_chain_run ?? 'null',
          ),
        );
        runOwners.push(claimed?.run_id);
        models.push(input.model);
        prompts.push(String(input.prompt));
        const output = outputs[models.length - 1];
        if (options.moveHeadAfterRun === models.length) head = headB;
        await completeActiveRun(runId, 'completed');
        active -= 1;
        if (options.retryableRuns?.includes(models.length)) {
          return {
            status: 'error',
            result: null,
            error: 'API overloaded_error (529)',
          } satisfies ContainerOutput;
        }
        if (options.failRuns?.includes(models.length)) {
          return {
            status: 'error',
            result: null,
            error: 'reviewer crashed',
          } satisfies ContainerOutput;
        }
        return {
          status: 'success',
          result: output,
          newSessionId: `session-${models.length}`,
        } satisfies ContainerOutput;
      },
    };
    // The queue relaunches a task that stays in Review; do the same here.
    for (let i = 0; i < 6; i++) {
      const current = await getTask(task.id);
      if (current?.status !== 'review') break;
      await executeTask(current, group, { testDependencies: dependencies });
    }
    return {
      task: (await getTask(task.id))!,
      models,
      maxActive,
      prompts,
      runOwners,
      runId: (n: number) => `${projectId}-run-${n - 1}`,
    };
  }

  test('without co_stages one reviewer decides and no chain is stored', async () => {
    const { task, models } = await runReviewChain('single', undefined, [
      verdict('approve', 9),
    ]);
    expect(models).toHaveLength(1);
    expect(task.status).toBe('done');
    expect(task.custom_values?.review_chain ?? '').toBe('');
  });

  test('all reviewers must approve, one after the other, before the card advances', async () => {
    const { task, models, maxActive, prompts } = await runReviewChain(
      'both-approve',
      ['review.o'],
      [verdict('approve', 9), verdict('approve', 7)],
      { taskRuntime: true },
    );
    expect(models).toHaveLength(2);
    // A per-task runtime override applies to the primary only.
    expect(models[0]).toContain('m-primary');
    expect(models[1]).toContain('m-second');
    // The extra reviewer gets the Testing-era conversation but not the
    // primary reviewer's verdict.
    expect(prompts[1]).toContain('TESTING-EVIDENCE-MARKER');
    expect(prompts[1]).not.toContain('approve summary');
    const history = JSON.parse(String(task.custom_values?.review_history));
    expect(history).toHaveLength(1);
    expect(history[0].decision).toBe('approve');
    expect(history[0].reviewers).toHaveLength(2);
    expect(maxActive).toBe(1);
    expect(task.status).toBe('done');
    expect(task.custom_values?.quality_score).toBe(7);
  });

  test('a rejection by either reviewer rejects once and the other reviewer still runs', async () => {
    const primaryRejects = await runReviewChain(
      'primary-rejects',
      ['review.o'],
      [
        verdict('reject', 4, 'Missing guard'),
        verdict('approve', 9, 'Rename helper'),
      ],
    );
    expect(primaryRejects.models).toHaveLength(2);
    expect(primaryRejects.task.status).toBe('implementation');
    const history = JSON.parse(
      String(primaryRejects.task.custom_values?.review_history),
    );
    expect(history).toHaveLength(1);
    expect(history[0].issues).toHaveLength(1);
    expect(history[0].issues[0].text).toContain('Missing guard');
    expect(history[0].advisory_issues).toHaveLength(1);
    expect(history[0].advisory_issues[0].text).toMatch(/^\[.+\] Rename helper/);
    expect(history[0].advisory_summary).toContain('approve summary');
    expect(primaryRejects.task.custom_values?.rejection_count).toBe(1);
    expect(history[0].reviewers.map((r: any) => r.decision)).toEqual([
      'reject',
      'approve',
    ]);
    expect(history[0].reviewers.map((r: any) => r.stage_id)).toEqual([
      'review',
      'review.o',
    ]);
    expect(history[0].reviewers[0].issues).toHaveLength(1);
    expect(history[0].reviewers[1].issues).toBeUndefined();

    const bothReject = await runReviewChain(
      'both-reject',
      ['review.o'],
      [
        verdict('reject', 5, 'Missing guard', 'Primary only'),
        verdict('reject', 3, 'Missing guard', 'Second only'),
      ],
    );
    const compounded = JSON.parse(
      String(bothReject.task.custom_values?.review_history),
    );
    expect(compounded).toHaveLength(1);
    expect(bothReject.task.custom_values?.rejection_count).toBe(1);
    expect(bothReject.task.custom_values?.quality_score).toBe(3);
    expect(compounded[0].issues).toHaveLength(3);
    expect(compounded[0].issues[0].text).toMatch(/^\[.+, .+\] Missing guard/);
  });

  test('a re-review shows each reviewer only the issues its own stage raised', async () => {
    const round = (
      reviewers: Array<{ stage_id: string; issues: string[] }>,
    ) => ({
      timestamp: '2020-01-01T00:00:00.000Z',
      commit: headB,
      issues: reviewers.flatMap((r) =>
        r.issues.map((text) => ({ id: text, text: `[m] ${text}` })),
      ),
      summary: 'earlier rejection',
      reviewers: reviewers.map((r) => ({
        reviewer: `model-${r.stage_id}`,
        decision: r.issues.length > 0 ? 'reject' : 'approve',
        score: 5,
        issue_count: r.issues.length,
        stage_id: r.stage_id,
        ...(r.issues.length > 0
          ? { issues: r.issues.map((text) => ({ id: text, text })) }
          : {}),
      })),
    });
    const approve = [verdict('approve', 9), verdict('approve', 9)];

    const oneRejected = await runReviewChain(
      'rereview-one-rejected',
      ['review.o'],
      approve,
      {
        reviewHistory: [
          round([
            { stage_id: 'review', issues: ['ISSUE-A'] },
            { stage_id: 'review.o', issues: [] },
          ]),
        ],
      },
    );
    expect(oneRejected.prompts[0]).toContain('- Round 1: ISSUE-A');
    expect(oneRejected.prompts[1]).not.toContain('ISSUE-A');
    expect(oneRejected.prompts[1]).not.toContain(
      '## Earlier rejected review rounds',
    );
    expect(oneRejected.prompts[1]).toContain(
      'Files changed since the last rejected round:',
    );

    const bothRejected = await runReviewChain(
      'rereview-both-rejected',
      ['review.o'],
      approve,
      {
        reviewHistory: [
          round([
            { stage_id: 'review', issues: ['ISSUE-A'] },
            { stage_id: 'review.o', issues: ['ISSUE-B'] },
          ]),
        ],
      },
    );
    expect(bothRejected.prompts[0]).toContain('ISSUE-A');
    expect(bothRejected.prompts[0]).not.toContain('ISSUE-B');
    expect(bothRejected.prompts[1]).toContain('ISSUE-B');
    expect(bothRejected.prompts[1]).not.toContain('ISSUE-A');

    // Entries from before per-stage attribution reach no reviewer of a chain.
    const legacy = await runReviewChain(
      'rereview-legacy',
      ['review.o'],
      approve,
      { priorRejection: true },
    );
    for (const prompt of legacy.prompts) {
      expect(prompt).not.toContain('## Earlier rejected review rounds');
      expect(prompt).not.toContain('Old issue');
      expect(prompt).toContain('Files changed since the last rejected round:');
    }
  });

  test('terminal reviewer errors are recorded and the remaining reviewers still run', async () => {
    const extraFails = await runReviewChain(
      'extra-fails',
      ['review.o'],
      [verdict('reject', 4, 'Missing guard')],
      { failRuns: [2] },
    );
    expect(extraFails.models).toHaveLength(2);
    expect(extraFails.task.status).toBe('implementation');
    const rejected = JSON.parse(
      String(extraFails.task.custom_values?.review_history),
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reviewers.map((r: any) => r.decision)).toEqual([
      'reject',
      null,
    ]);

    const primaryFails = await runReviewChain(
      'primary-fails',
      ['review.o'],
      ['', verdict('approve', 9)],
      { failRuns: [1] },
    );
    expect(primaryFails.models).toHaveLength(2);
    // No reviewer rejected and one gave no decision: never approved.
    expect(primaryFails.task.status).toBe('backlog');
  });

  test('a manual Review admission covers the whole chain', async () => {
    const { task, models } = await runReviewChain(
      'manual-admission',
      ['review.o'],
      [verdict('approve', 9), verdict('approve', 9)],
      { manual: true },
    );
    expect(models).toHaveLength(2);
    expect(task.status).toBe('done');
  });

  test('the rejection cap counts rejections since the last human retry', async () => {
    const cap = MAX_REVIEW_REJECTIONS_CAP;
    const rejectOutputs = [
      verdict('reject', 4, 'Brand new defect'),
      '{"decision":"retry","progress":"new_issue","resolved_issue_ids":[],"persistent_issue_ids":[],"new_issue_ids":["brand new defect"],"reason":"different defect"}',
    ];
    const parked = await runReviewChain(
      'cap-no-base',
      undefined,
      rejectOutputs,
      {
        priorRejection: true,
        priorCounts: { rejection_count: cap },
      },
    );
    expect(parked.task.status).toBe('question');

    const retried = await runReviewChain(
      'cap-human-base',
      undefined,
      rejectOutputs,
      {
        priorRejection: true,
        priorCounts: { rejection_count: cap, rejection_cap_base: cap },
      },
    );
    expect(retried.task.status).toBe('implementation');
    expect(retried.task.custom_values?.rejection_count).toBe(cap + 1);
    expect(retried.task.custom_values?.rejection_cap_base).toBe(cap);
  });

  test('a rejection settled after a reviewer failure still gets the normal progress comparison', async () => {
    const { task, models } = await runReviewChain(
      'failed-extra-comparison',
      ['review.o'],
      [
        verdict('reject', 4, 'Brand new defect'),
        '',
        '{"decision":"retry","progress":"new_issue","resolved_issue_ids":[],"persistent_issue_ids":[],"new_issue_ids":["brand new defect"],"reason":"different defect"}',
      ],
      { failRuns: [2], priorRejection: true },
    );
    expect(models).toHaveLength(3);
    expect(task.status).toBe('implementation');
    // Not inferred as "no progress" from the missing reviewer decision.
    expect(task.custom_values?.no_progress_count).toBe(0);
    expect(task.custom_values?.rejection_count).toBe(2);
  });

  test('a transient retry of an extra reviewer keeps the recorded primary verdict', async () => {
    const { task, models } = await runReviewChain(
      'transient-extra',
      ['review.o'],
      [verdict('reject', 4, 'Missing guard'), '', verdict('approve', 9)],
      { retryableRuns: [2], priorTestingRun: true },
    );
    // Run 3 retries the extra reviewer; the primary is not started again.
    expect(models).toHaveLength(3);
    expect(models[2]).toContain('m-second');
    expect(task.status).toBe('implementation');
    const history = JSON.parse(String(task.custom_values?.review_history));
    expect(history).toHaveLength(1);
    expect(history[0].reviewers.map((r: any) => r.decision)).toEqual([
      'reject',
      'approve',
    ]);
  });

  test("a format-repair run is recorded as its reviewer's chain run", async () => {
    const { task, models, runOwners, runId } = await runReviewChain(
      'repair-ownership',
      ['review.o'],
      [
        verdict('reject', 4, 'Missing guard'),
        'no structured verdict here',
        verdict('approve', 9),
      ],
    );
    expect(models).toHaveLength(3);
    // Run 3 is the extra reviewer's format repair and owns the chain marker.
    expect(runOwners[2]).toBe(runId(3));
    expect(task.status).toBe('implementation');
  });

  test('a failure before any run exists still lets the remaining reviewers run', async () => {
    const { task, prompts } = await runReviewChain(
      'prelaunch-failure',
      ['review.o'],
      [verdict('approve', 9)],
      { throwRuns: [1], priorTestingRun: true },
    );
    // The round is settled instead of the primary being attempted again, and
    // without a rejection it is never approved.
    expect(prompts).toHaveLength(0);
    expect(task.status).toBe('backlog');
  });

  test('an extra reviewer is not started when the checkout moved, and the card is never approved', async () => {
    const { task, models } = await runReviewChain(
      'head-moved',
      ['review.o'],
      [verdict('approve', 9), verdict('approve', 9)],
      { moveHeadAfterRun: 1 },
    );
    expect(models).toHaveLength(1);
    expect(task.status).not.toBe('done');
    expect(task.status).not.toBe('review');
  });

  test('an extra reviewer with the primary runtime is skipped when the chain starts', async () => {
    const name = 'same-runtime-skipped';
    // The base review stage has no runtime of its own, so the primary runs on
    // the kanban fallback (codex/primary); review.o is configured to the same.
    const { task, models } = await runReviewChain(
      name,
      ['review.o'],
      [verdict('approve', 9)],
      { extraRuntime: { harnessId: 'codex', modelId: 'primary' } },
    );
    // One review run decides the card, exactly like a card without co_stages.
    expect(models).toHaveLength(1);
    expect(models[0]).toContain('m-primary');
    expect(task.status).toBe('done');
    expect(task.custom_values?.review_chain ?? '').toBe('');
    const notices = readTaskMessages(`review-chain-${name}`, task.id)
      .filter((message) => message.entry_type === 'system_notice')
      .map((message) => message.content)
      .join('\n');
    expect(notices).toContain(
      'Skipped extra reviewer review.o: same runtime as the primary reviewer (codex/primary).',
    );
  });

  test('an extra reviewer on a different runtime still runs after the primary', async () => {
    const { task, models } = await runReviewChain(
      'different-runtime-kept',
      ['review.o'],
      [verdict('approve', 9), verdict('approve', 8)],
      { extraRuntime: { harnessId: 'codex', modelId: 'second' } },
    );
    expect(models).toHaveLength(2);
    expect(models[0]).toContain('m-primary');
    expect(models[1]).toContain('m-second');
    expect(task.status).toBe('done');
  });
});

describe('Testing with extra testers (co_stages)', () => {
  useCleanPipelineTestDatabase();

  const agentsFile = path.join(DATA_DIR, 'board_agents.jsonc');
  let previousAgents: string | undefined;

  beforeAll(() => {
    previousAgents = fs.existsSync(agentsFile)
      ? fs.readFileSync(agentsFile, 'utf8')
      : undefined;
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        version: 2,
        harnesses: {
          codex: {
            label: 'Codex',
            kind: 'cli',
            agentCmd: 'codex',
            sessionFamily: 'codex',
          },
        },
        models: {
          primary: {
            label: 'Primary',
            bindings: { codex: { model: 'm-primary' } },
          },
          second: {
            label: 'Second',
            bindings: { codex: { model: 'm-second' } },
          },
        },
        defaults: {
          chat: { harnessId: 'codex', modelId: 'primary' },
          kanban: {
            fallback: { harnessId: 'codex', modelId: 'primary' },
            stages: {},
          },
        },
      }),
    );
    reloadChatAgents();
  });

  afterAll(() => {
    if (previousAgents === undefined) fs.rmSync(agentsFile, { force: true });
    else fs.writeFileSync(agentsFile, previousAgents);
    reloadChatAgents();
  });

  const headA = '1111111111111111111111111111111111111111';
  const headB = '2222222222222222222222222222222222222222';
  const verdict = (decision: 'pass' | 'fail' | 'blocked', note = '') =>
    JSON.stringify({
      decision,
      issues: decision === 'pass' ? [] : [`${decision} issue ${note}`.trim()],
      summary: `${decision} summary ${note}`.trim(),
    });

  async function runTestingChain(
    name: string,
    coStages: string[] | undefined,
    outputs: string[],
    options: {
      moveHeadAfterRun?: number;
      /** Uncommitted edits left behind by this run; commit refs stay unchanged. */
      dirtyAfterRun?: number;
      /** Testing is followed by Done instead of Review. */
      skipReview?: boolean;
      /** Stage prompt files by stage id, e.g. `testing` or `testing.u`. */
      stagePrompts?: Record<string, string>;
    } = {},
  ) {
    const projectId = `testing-chain-${name}`;
    const group = {
      name,
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        taskCheckoutMode: 'shared' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          ...reviewLifecycleStages,
          {
            id: 'testing.u',
            title: 'Testing U',
            type: 'testing' as const,
            color: '#a3f',
            runtimeSelection: { harnessId: 'codex', modelId: 'second' },
          },
        ],
      },
    };
    let head = headA;
    let dirty = false;
    const promptsDir = path.join(
      getGroupHomeDir(projectId, undefined),
      '.agent',
      'prompts',
    );
    for (const [stageId, text] of Object.entries(options.stagePrompts ?? {})) {
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, `stage-${stageId}.md`), text);
    }
    const task = await createTask({
      project_id: projectId,
      title: name,
      description: '',
      status: 'testing',
      priority: 0,
      coStages,
      ...(options.skipReview ? { skip_stages: ['review'] } : {}),
    });
    let active = 0;
    let maxActive = 0;
    const models: Array<string | undefined> = [];
    const prompts: string[] = [];
    const dependencies = {
      prepareTaskBranchForReview: async () => {},
      readTaskGitContentIdentity: async () => ({
        headSha: head,
        treeSha: headA,
      }),
      runGitInRepo: fakeReviewGit(
        () => head,
        () => headA,
        () => dirty,
      ),
      inspectTaskLinkedRepositories: async () => ({ repositories: [] }),
      mergeBranchForDeploy: async () => true,
      runPostExecutionGitOps: async () => {},
      drainProjectQueue: async () => {},
      runContainerAgent: async (_group: unknown, input: ContainerInput) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await input.onCheckoutReady?.(input);
        const runId = `${projectId}-run-${models.length}`;
        await insertActiveRun(
          runFixture({
            id: runId,
            group_folder: projectId,
            task_id: task.id,
            stage: 'testing',
          }),
        );
        await input.onSlotAcquired?.(runId);
        models.push(input.model);
        prompts.push(`${input.systemPrompt ?? ''}\n${input.prompt}`);
        const output = outputs[models.length - 1];
        if (options.moveHeadAfterRun === models.length) head = headB;
        if (options.dirtyAfterRun === models.length) dirty = true;
        await completeActiveRun(runId, 'completed');
        active -= 1;
        return {
          status: 'success',
          result: output,
          newSessionId: `session-${models.length}`,
        } satisfies ContainerOutput;
      },
    };
    // The queue relaunches a task that stays in Testing; do the same here.
    try {
      for (let i = 0; i < 6; i++) {
        const current = await getTask(task.id);
        if (current?.status !== 'testing') break;
        await executeTask(current, group, { testDependencies: dependencies });
      }
    } finally {
      fs.rmSync(promptsDir, { recursive: true, force: true });
    }
    const final = (await getTask(task.id))!;
    return {
      task: final,
      models,
      maxActive,
      prompts,
      verdicts: JSON.parse(
        String(final.custom_values?.testing_verdicts || '[]'),
      ),
      messages: readTaskMessages(projectId, task.id),
    };
  }

  test('without testing entries one tester decides and no chain is stored', async () => {
    const { task, models, verdicts } = await runTestingChain(
      'single',
      undefined,
      [verdict('pass')],
    );
    expect(models).toHaveLength(1);
    expect(task.status).toBe('review');
    expect(task.custom_values?.testing_chain ?? '').toBe('');
    expect(verdicts).toEqual([]);
    expect(task.custom_values?.[TESTING_TREE_SHA_KEY]).toBe(headA);
  });

  test('all testers must pass, one after the other, before the card advances', async () => {
    const { task, models, maxActive, verdicts, prompts } =
      await runTestingChain(
        'both-pass',
        ['testing.u'],
        [verdict('pass', 'primary'), verdict('pass', 'extra')],
        {
          stagePrompts: {
            testing: 'BASE-TESTING-PROMPT',
            'testing.u': 'UI-TESTING-PROMPT',
          },
        },
      );
    // Each tester gets its own stage's prompt.
    expect(prompts[0]).toContain('BASE-TESTING-PROMPT');
    expect(prompts[0]).not.toContain('UI-TESTING-PROMPT');
    expect(prompts[1]).toContain('UI-TESTING-PROMPT');
    expect(models).toHaveLength(2);
    expect(models[0]).toContain('m-primary');
    expect(models[1]).toContain('m-second');
    expect(maxActive).toBe(1);
    expect(task.status).toBe('review');
    expect(task.custom_values?.testing_chain ?? '').toBe('');
    expect(task.custom_values?.[TESTING_HEAD_SHA_KEY]).toBe(headA);
    expect(task.custom_values?.[TESTING_TREE_SHA_KEY]).toBe(headA);
    expect(verdicts.map((v: any) => [v.stage_id, v.decision])).toEqual([
      ['testing', 'pass'],
      ['testing.u', 'pass'],
    ]);
  });

  test('a failing or blocked primary never starts the extra tester', async () => {
    for (const decision of ['fail', 'blocked'] as const) {
      const { task, models } = await runTestingChain(
        `primary-${decision}`,
        ['testing.u'],
        [verdict(decision), verdict('pass')],
      );
      expect(models).toHaveLength(1);
      expect(task.status).toBe(
        decision === 'fail' ? 'implementation' : 'question',
      );
      expect(task.custom_values?.testing_chain ?? '').toBe('');
    }
  });

  test('a failing extra tester is one testing failure with its own feedback', async () => {
    const { task, models, messages } = await runTestingChain(
      'extra-fails',
      ['testing.u'],
      [verdict('pass', 'primary'), verdict('fail', 'ui')],
    );
    expect(models).toHaveLength(2);
    expect(task.status).toBe('implementation');
    expect(task.custom_values?.testing_failure_count).toBe(1);
    expect(task.custom_values?.testing_chain ?? '').toBe('');
    expect(task.custom_values?.[TESTING_HEAD_SHA_KEY]).toBeUndefined();
    const feedback = messages.filter(
      (m) => m.entry_type === 'testing_feedback',
    );
    expect(feedback).toHaveLength(1);
    expect(feedback[0].content).toContain('fail issue ui');
  });

  test('a blocked extra tester ends the chain as a blocked result', async () => {
    const { task, models } = await runTestingChain(
      'extra-blocked',
      ['testing.u'],
      [verdict('pass', 'primary'), verdict('blocked', 'ui')],
    );
    expect(models).toHaveLength(2);
    expect(task.status).toBe('question');
    expect(task.custom_values?.[TESTING_HEAD_SHA_KEY]).toBeUndefined();
  });

  test('an extra tester is not started when the checkout moved, and the card never advances', async () => {
    const { task, models } = await runTestingChain(
      'head-moved',
      ['testing.u'],
      [verdict('pass'), verdict('pass')],
      { moveHeadAfterRun: 1 },
    );
    expect(models).toHaveLength(1);
    expect(task.status).toBe('implementation');
    expect(task.custom_values?.testing_failure_count).toBe(1);
    expect(task.custom_values?.[TESTING_HEAD_SHA_KEY]).toBeUndefined();
  });

  test('an extra tester is not started over uncommitted edits, even when the commit refs are unchanged', async () => {
    // Branch-mode identity reads only refs, so the tree status must decide.
    const { task, models } = await runTestingChain(
      'dirty-tree',
      ['testing.u'],
      [verdict('pass'), verdict('pass')],
      { dirtyAfterRun: 1 },
    );
    expect(models).toHaveLength(1);
    expect(task.status).toBe('implementation');
    expect(task.custom_values?.testing_failure_count).toBe(1);
    expect(task.custom_values?.[TESTING_HEAD_SHA_KEY]).toBeUndefined();
  });

  test('the final pass without a following Review is not accepted over uncommitted edits', async () => {
    const { task, models } = await runTestingChain(
      'dirty-final',
      ['testing.u'],
      [verdict('pass'), verdict('pass')],
      { dirtyAfterRun: 2, skipReview: true },
    );
    expect(models).toHaveLength(2);
    expect(task.status).not.toBe('done');
    expect(task.custom_values?.[TESTING_HEAD_SHA_KEY]).toBeUndefined();
  });
});
