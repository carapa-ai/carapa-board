import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

import {
  initDatabase,
  createCronjob,
  createScheduledTask,
  createTask,
  createObjective,
  getDueTasks,
  getCronjob,
  getTaskById,
  getTaskRunLogs,
  getTasksByProject,
  completeActiveRun,
  hasRunningScheduledTask,
  insertActiveRun,
  updateScheduledTask,
  updateScheduledTaskIfIdle,
} from '../../../db.js';
import { getGroupDir } from '../../../group-dir.js';
import { runFixture, truncateTestDb } from '../../../test-helpers.js';
import {
  calcNextRun,
  processDueCronjobs,
  runSelectedDueTask,
  runTask,
  createSchedulerPoll,
} from './task-scheduler.js';
import { getDefaultRuntimeSelection } from '../../../lib/chat-agents.js';

let initialized = false;

beforeAll(async () => {
  await initDatabase(':memory:');
  initialized = true;
});

beforeEach(async () => {
  if (!initialized) throw new Error('test database was not initialized');
  await truncateTestDb();
});

describe('runTask', () => {
  test('does not launch a stale due selection after its cadence is moved to the future', async () => {
    const projectId = 'scheduled-stale-claim';
    const selected = {
      id: `${projectId}-task`,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Original occurrence prompt',
      schedule_type: 'interval' as const,
      schedule_value: '60000',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1_000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    await createScheduledTask(selected);
    const editedNextRun = new Date(Date.now() + 3_600_000).toISOString();
    await updateScheduledTask(selected.id, {
      prompt: 'Future occurrence prompt',
      schedule_value: '120000',
      next_run: editedNextRun,
    });
    let executions = 0;

    const launched = await runSelectedDueTask(selected, {
      registeredGroups: () => ({
        [projectId]: { folder: projectId, settings: {} } as any,
      }),
      sendMessage: async () => {},
      getSessions: () => ({}),
      runChatAgent: (async () => {
        executions += 1;
        return { result: 'must not run' };
      }) as any,
    });

    expect(launched).toBe(false);
    expect(executions).toBe(0);
    expect(await getTaskById(selected.id)).toMatchObject({
      prompt: 'Future occurrence prompt',
      schedule_value: '120000',
      next_run: editedNextRun,
      last_run: null,
    });
  });

  test('does not finalize over a cadence edit made after the due task was selected', async () => {
    const projectId = 'scheduled-stale-finalization';
    const originalNextRun = new Date(Date.now() - 1_000).toISOString();
    const task = {
      id: `${projectId}-task`,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Selected occurrence',
      schedule_type: 'interval' as const,
      schedule_value: '60000',
      context_mode: 'isolated' as const,
      next_run: originalNextRun,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    await createScheduledTask(task);
    let release!: () => void;
    let started!: () => void;
    const activeRun = runFixture({
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      isScheduledTask: 1,
      scheduled_task_id: task.id,
    });
    const selected = new Promise<void>((resolve) => (started = resolve));
    const execution = runTask(task, {
      registeredGroups: () => ({
        [projectId]: { folder: projectId, settings: {} } as any,
      }),
      sendMessage: async () => {},
      getSessions: () => ({}),
      runChatAgent: (async () => {
        await insertActiveRun(activeRun);
        started();
        await new Promise<void>((resolve) => (release = resolve));
        await completeActiveRun(activeRun.id, 'completed');
        return {
          result: 'old occurrence finished',
          activeRunId: activeRun.id,
        };
      }) as any,
    });
    await selected;
    const editedNextRun = new Date(Date.now() + 3_600_000).toISOString();
    await updateScheduledTask(task.id, {
      schedule_type: 'interval',
      schedule_value: '120000',
      next_run: editedNextRun,
    });
    release();
    await execution;

    expect(await getTaskById(task.id)).toMatchObject({
      schedule_value: '120000',
      next_run: editedNextRun,
      last_run: null,
    });
    expect(await getTaskRunLogs(task.id)).toMatchObject([
      { run_id: activeRun.id, status: 'success' },
    ]);
    expect(await hasRunningScheduledTask(task.id)).toBe(false);
    expect(
      await updateScheduledTaskIfIdle(task.id, {
        prompt: 'Future occurrence remains editable',
      }),
    ).toBe(true);
  });

  test.each([
    ['group', 'existing-session'],
    ['isolated', undefined],
  ] as const)(
    'keeps %s context independent from runtime inheritance',
    async (contextMode, expectedSession) => {
      const projectId = `scheduled-runtime-${contextMode}`;
      const runtimeSelection = getDefaultRuntimeSelection('chat');
      const task = {
        id: `${projectId}-task`,
        group_folder: projectId,
        chat_jid: `${projectId}@web`,
        prompt: 'Inspect blocked tasks',
        schedule_type: 'interval' as const,
        schedule_value: '1800000',
        context_mode: contextMode,
        runtimeSelection,
        next_run: new Date(Date.now() - 60_000).toISOString(),
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: new Date().toISOString(),
      };
      await createScheduledTask(task);
      let call: any;

      await runTask(task, {
        registeredGroups: () => ({
          [projectId]: {
            folder: projectId,
            settings: {},
          } as any,
        }),
        sendMessage: async () => {},
        getSessions: () => ({ [projectId]: 'existing-session' }),
        runChatAgent: (async (...args: any[]) => {
          call = args;
          return {
            result: 'Audit complete',
            telemetry: undefined,
            isLlm: true,
          };
        }) as any,
      });

      expect(call[4]).toBe(expectedSession);
      expect(call[8].agentConfig.harnessId).toBe(runtimeSelection.harnessId);
      expect(call[8].agentConfig.modelId).toBe(runtimeSelection.modelId);
      expect(call[8].agent_cmd).toBe(call[8].agentConfig.id);
      expect(call[8]).toMatchObject({
        ephemeral: true,
        scheduledTaskId: task.id,
        isScheduledTask: true,
        triggeredByUserId: null,
        triggerSource: 'schedule',
      });
    },
  );

  test('delegates project and global fallback resolution when no task override exists', async () => {
    const projectId = 'scheduled-inherited-runtime';
    const projectRuntime = getDefaultRuntimeSelection('chat');
    const task = {
      id: `${projectId}-task`,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Inspect blocked tasks',
      schedule_type: 'interval' as const,
      schedule_value: '1800000',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 60_000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    await createScheduledTask(task);
    let call: any;

    await runTask(task, {
      registeredGroups: () => ({
        [projectId]: {
          folder: projectId,
          settings: { chatRuntimeSelection: projectRuntime },
        } as any,
      }),
      sendMessage: async () => {},
      getSessions: () => ({}),
      runChatAgent: (async (...args: any[]) => {
        call = args;
        return {
          result: 'Audit complete',
          telemetry: undefined,
          isLlm: true,
        };
      }) as any,
    });

    expect(call[0].settings.chatRuntimeSelection).toEqual(projectRuntime);
    expect(call[8].agent_cmd).toBeUndefined();
    expect(call[8].agentConfig).toBeUndefined();
  });

  test('links a failed scheduled run when the sandbox throws after creating it', async () => {
    const projectId = 'scheduled-failed-run-link';
    const task = {
      id: `${projectId}-task`,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Fail',
      schedule_type: 'interval' as const,
      schedule_value: '60000',
      context_mode: 'isolated' as const,
      next_run: new Date().toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    await createScheduledTask(task);
    let run!: ReturnType<typeof runFixture>;
    await runTask(task, {
      registeredGroups: () => ({
        [projectId]: { folder: projectId, settings: {} } as any,
      }),
      sendMessage: async () => {},
      getSessions: () => ({}),
      runChatAgent: (async () => {
        run = runFixture({
          group_folder: projectId,
          chat_jid: task.chat_jid,
          scheduled_task_id: task.id,
          isScheduledTask: 1,
          status: 'error',
        });
        await insertActiveRun(run);
        throw new Error('sandbox lost');
      }) as any,
    });
    expect((await getTaskRunLogs(task.id))[0].run_id).toBe(run.id);
  });

  test('links a failed wrapper result that omits its active-run uuid', async () => {
    const projectId = 'scheduled-failed-wrapper-link';
    const task = {
      id: `${projectId}-task`,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Fail',
      schedule_type: 'interval' as const,
      schedule_value: '60000',
      context_mode: 'isolated' as const,
      next_run: new Date().toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    await createScheduledTask(task);
    let run!: ReturnType<typeof runFixture>;
    await runTask(task, {
      registeredGroups: () => ({
        [projectId]: { folder: projectId, settings: {} } as any,
      }),
      sendMessage: async () => {},
      getSessions: () => ({}),
      runChatAgent: (async () => {
        run = runFixture({
          group_folder: projectId,
          chat_jid: task.chat_jid,
          scheduled_task_id: task.id,
          isScheduledTask: 1,
          status: 'error',
        });
        await insertActiveRun(run);
        return { failed: true, result: 'sandbox wrapper failed' };
      }) as any,
    });
    expect((await getTaskRunLogs(task.id))[0].run_id).toBe(run.id);
  });

  test('links history by active run instead of a provider transcript uuid', async () => {
    const projectId = 'scheduled-provider-uuid-link';
    const task = {
      id: `${projectId}-task`,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Succeed',
      schedule_type: 'interval' as const,
      schedule_value: '60000',
      context_mode: 'isolated' as const,
      next_run: new Date().toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    await createScheduledTask(task);
    const run = runFixture({
      group_folder: projectId,
      chat_jid: task.chat_jid,
      scheduled_task_id: task.id,
      isScheduledTask: 1,
      status: 'completed',
    });
    await runTask(task, {
      registeredGroups: () => ({
        [projectId]: { folder: projectId, settings: {} } as any,
      }),
      sendMessage: async () => {},
      getSessions: () => ({}),
      runChatAgent: (async () => {
        await insertActiveRun(run);
        return {
          result: 'ok',
          uuid: 'provider-transcript-uuid',
          activeRunId: run.id,
        };
      }) as any,
    });
    expect((await getTaskRunLogs(task.id))[0].run_id).toBe(run.id);
  });

  test('does not link a preflight failure to an older occurrence', async () => {
    const projectId = 'scheduled-preflight-boundary';
    const task = {
      id: `${projectId}-task`,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'Fail before creating a run',
      schedule_type: 'interval' as const,
      schedule_value: '60000',
      context_mode: 'isolated' as const,
      next_run: new Date().toISOString(),
      last_run: new Date(Date.now() - 30_000).toISOString(),
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    await createScheduledTask(task);
    await insertActiveRun(
      runFixture({
        group_folder: projectId,
        chat_jid: task.chat_jid,
        scheduled_task_id: task.id,
        isScheduledTask: 1,
        started_at: new Date(Date.now() - 60_000).toISOString(),
        status: 'error',
      }),
    );

    await runTask(task, {
      registeredGroups: () => ({
        [projectId]: { folder: projectId, settings: {} } as any,
      }),
      sendMessage: async () => {},
      getSessions: () => ({}),
      runChatAgent: (async () => {
        throw new Error('preflight failed');
      }) as any,
    });

    expect((await getTaskRunLogs(task.id))[0].run_id).toBeNull();
  });

  test.each(['paused'] as const)(
    'does not launch scheduled work while the project is %s',
    async (status) => {
      const task = {
        id: `inactive-project-${status}`,
        group_folder: `scheduled-${status}`,
        chat_jid: 'chat-1',
        prompt: 'must not run',
        schedule_type: 'interval' as const,
        schedule_value: '60000',
        context_mode: 'isolated' as const,
        next_run: new Date(Date.now() - 60_000).toISOString(),
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: new Date().toISOString(),
      };
      await createScheduledTask(task);

      await runTask(task, {
        registeredGroups: () =>
          ({
            [task.group_folder]: {
              folder: task.group_folder,
              settings: { status },
            },
          }) as any,
        sendMessage: async () => {},
        getSessions: () => ({}),
      });

      const updated = await getTaskById(task.id);
      expect(updated?.last_run).toBeNull();
      expect(new Date(updated!.next_run!).getTime()).toBeGreaterThan(
        Date.now(),
      );
    },
  );

  test.each(['paused', 'stopped'] as const)(
    'keeps a due once task active with its next_run while the project is %s',
    async (status) => {
      const nextRun = new Date(Date.now() - 60_000).toISOString();
      const task = {
        id: `inactive-project-once-${status}`,
        group_folder: `scheduled-once-${status}`,
        chat_jid: 'chat-1',
        prompt: 'must run after resume',
        schedule_type: 'once' as const,
        schedule_value: nextRun,
        context_mode: 'isolated' as const,
        next_run: nextRun,
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: new Date().toISOString(),
      };
      await createScheduledTask(task);

      await runSelectedDueTask(task, {
        registeredGroups: () =>
          ({
            [task.group_folder]: {
              folder: task.group_folder,
              settings: { status },
            },
          }) as any,
        sendMessage: async () => {},
        getSessions: () => ({}),
      });

      const updated = await getTaskById(task.id);
      expect(updated?.status).toBe('active');
      expect(updated?.next_run).toBe(nextRun);
      expect(updated?.last_run).toBeNull();
      expect(await getTaskRunLogs(task.id)).toHaveLength(0);
      expect((await getDueTasks()).map((t) => t.id)).toContain(task.id);
    },
  );
});

describe('processDueCronjobs', () => {
  test('does not spawn scheduled work for an inactive objective', async () => {
    const projectId = 'paused-objective-cron';
    const objective = await createObjective({
      project_id: projectId,
      title: 'Paused owner',
      description: '',
      status: 'paused',
      priority: 0,
      progress: 0,
      deadline: null,
      metadata: null,
      trigger_config: null,
    });
    const cronjob = await createCronjob({
      project_id: projectId,
      title: 'Wait for objective',
      description: '',
      cron_expression: '* * * * *',
      queue_mode: 'always',
      objective_id: objective.id,
      status: 'active',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    await processDueCronjobs({
      registeredGroups: () =>
        ({
          [projectId]: {
            folder: projectId,
            settings: {
              stages: [
                {
                  id: 'in_progress',
                  title: 'In progress',
                  type: 'active',
                  color: '#888',
                },
              ],
            },
          },
        }) as any,
      sendMessage: async () => {},
      getSessions: () => ({}),
    });

    expect(await getTasksByProject(projectId)).toHaveLength(0);
    expect((await getCronjob(cronjob.id))?.status).toBe('paused');
  });

  test('creates only one task when due-cron sweeps overlap', async () => {
    const projectId = 'overlapping-cron-sweeps';
    const objective = await createObjective({
      project_id: projectId,
      title: 'Active cron owner',
      description: '',
      status: 'active',
      priority: 0,
      progress: 0,
      deadline: null,
      metadata: null,
      trigger_config: null,
    });
    const cronjob = await createCronjob({
      project_id: projectId,
      title: 'Run once per occurrence',
      description: '',
      cron_expression: '* * * * *',
      queue_mode: 'always',
      model: 'legacy-model',
      agent_name: 'legacy-agent',
      runtimeSelection: {
        harnessId: 'codex',
        modelId: 'gpt-5.6-sol',
        reasoning: 'high',
      },
      objective_id: objective.id,
      status: 'active',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    // Occupy the sole worker slot so the asynchronously triggered queue drain
    // cannot launch an agent while this scheduler-only regression runs.
    await insertActiveRun(
      runFixture({
        group_folder: projectId,
        task_id: 'existing-running-task',
      }),
    );
    const deps = {
      registeredGroups: () =>
        ({
          [projectId]: {
            folder: projectId,
            settings: {
              stages: [
                {
                  id: 'backlog',
                  title: 'Backlog',
                  type: 'queue',
                  color: '#888',
                },
                {
                  id: 'in_progress',
                  title: 'In Progress',
                  type: 'active',
                  color: '#888',
                },
                {
                  id: 'completed',
                  title: 'Completed',
                  type: 'done',
                  color: '#888',
                },
              ],
            },
          },
        }) as any,
      sendMessage: async () => {},
      getSessions: () => ({}),
    };

    // Both sweeps can read the same due snapshot before either one advances it.
    await Promise.all([processDueCronjobs(deps), processDueCronjobs(deps)]);

    const spawnedTasks = await getTasksByProject(projectId);
    expect(spawnedTasks).toHaveLength(1);
    expect(spawnedTasks[0]?.objective_id).toBe(objective.id);
    expect(spawnedTasks[0]?.runtimeSelection).toEqual(cronjob.runtimeSelection);
    const updated = await getCronjob(cronjob.id);
    expect(updated?.last_run).toBeTruthy();
    expect(new Date(updated!.next_run!).getTime()).toBeGreaterThan(Date.now());
  });

  test('advances a due cronjob when its project group is missing', async () => {
    const cronjob = await createCronjob({
      project_id: 'deleted-project',
      title: 'Orphaned cronjob',
      description: '',
      cron_expression: '* * * * *',
      queue_mode: 'always',
      status: 'active',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    await processDueCronjobs({
      registeredGroups: () => ({}),
      sendMessage: async () => {},
      getSessions: () => ({}),
    });

    const updated = await getCronjob(cronjob.id);
    expect(updated?.next_run).toBeTruthy();
    expect(new Date(updated!.next_run!).getTime()).toBeGreaterThan(Date.now());
    expect(updated?.last_run).toBeNull();
  });

  test('pauses a malformed cronjob when its project group is missing', async () => {
    const projectId = 'deleted-project-with-invalid-cron';
    const cronjob = await createCronjob({
      project_id: projectId,
      title: 'Invalid orphaned cronjob',
      description: '',
      cron_expression: 'not a cron expression',
      queue_mode: 'always',
      status: 'active',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    await processDueCronjobs({
      registeredGroups: () => ({}),
      sendMessage: async () => {},
      getSessions: () => ({}),
    });
    await processDueCronjobs({
      registeredGroups: () => ({}),
      sendMessage: async () => {},
      getSessions: () => ({}),
    });

    const updated = await getCronjob(cronjob.id);
    expect(updated?.status).toBe('paused');
  });

  test.each(['paused'] as const)(
    'does not create cronjob tasks while the project is %s',
    async (status) => {
      const projectId = `${status}-cron-project`;
      const cronjob = await createCronjob({
        project_id: projectId,
        title: 'Do not queue while inactive',
        description: '',
        cron_expression: '* * * * *',
        queue_mode: 'always',
        status: 'active',
        next_run: new Date(Date.now() - 60_000).toISOString(),
      });

      await processDueCronjobs({
        registeredGroups: () =>
          ({
            [projectId]: {
              folder: projectId,
              settings: {
                status,
                stages: [
                  {
                    id: 'backlog',
                    title: 'Backlog',
                    type: 'queue',
                    color: '#888',
                  },
                  {
                    id: 'in_progress',
                    title: 'In Progress',
                    type: 'active',
                    color: '#888',
                  },
                  {
                    id: 'completed',
                    title: 'Completed',
                    type: 'done',
                    color: '#888',
                  },
                ],
              },
            },
          }) as any,
        sendMessage: async () => {},
        getSessions: () => ({}),
      });

      expect(await getTasksByProject(projectId)).toHaveLength(0);
      const updated = await getCronjob(cronjob.id);
      expect(updated?.last_run).toBeNull();
      expect(new Date(updated!.next_run!).getTime()).toBeGreaterThan(
        Date.now(),
      );
    },
  );

  test('does not spawn when an active-stage task is queued without a running worker', async () => {
    const projectId = 'busy-project';
    const cronjob = await createCronjob({
      project_id: projectId,
      title: 'Busy project job',
      description: '',
      cron_expression: '* * * * *',
      queue_mode: 'if_empty',
      status: 'active',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    await createTask({
      project_id: projectId,
      title: 'Already running',
      description: '',
      status: 'in_progress',
      priority: 0,
    });

    await processDueCronjobs({
      registeredGroups: () =>
        ({
          [projectId]: {
            folder: projectId,
            settings: {
              stages: [
                {
                  id: 'backlog',
                  title: 'Backlog',
                  type: 'queue',
                  color: '#888',
                },
                {
                  id: 'in_progress',
                  title: 'In Progress',
                  type: 'active',
                  color: '#888',
                },
                {
                  id: 'completed',
                  title: 'Completed',
                  type: 'done',
                  color: '#888',
                },
              ],
            },
          },
        }) as any,
      sendMessage: async () => {},
      getSessions: () => ({}),
    });

    const updated = await getCronjob(cronjob.id);
    expect(new Date(updated!.next_run!).getTime()).toBeGreaterThan(Date.now());
    expect(updated?.last_run).toBeNull();
    expect(await getTasksByProject(projectId)).toHaveLength(1);
  });

  test('does not pin if_empty when the only active-stage task is archived', async () => {
    const projectId = 'archived-if-empty-project';
    const cronjob = await createCronjob({
      project_id: projectId,
      title: 'Archived card job',
      description: '',
      cron_expression: '* * * * *',
      queue_mode: 'if_empty',
      status: 'active',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    // Archiving has no stage-transition side effects: this card stays in an
    // active stage but can never run — the drain and list_tasks both exclude
    // archived cards — so it must not pin the cronjob in skip-forever.
    await createTask({
      project_id: projectId,
      title: 'Archived mid-stage',
      description: '',
      status: 'in_progress',
      priority: 0,
      archived: true,
    });
    // Occupy the sole worker slot so the asynchronously triggered queue drain
    // cannot launch an agent while this scheduler-only regression runs.
    await insertActiveRun(
      runFixture({
        group_folder: projectId,
        task_id: 'existing-running-task',
      }),
    );

    await processDueCronjobs({
      registeredGroups: () =>
        ({
          [projectId]: {
            folder: projectId,
            settings: {
              stages: [
                {
                  id: 'backlog',
                  title: 'Backlog',
                  type: 'queue',
                  color: '#888',
                },
                {
                  id: 'in_progress',
                  title: 'In Progress',
                  type: 'active',
                  color: '#888',
                },
                {
                  id: 'completed',
                  title: 'Completed',
                  type: 'done',
                  color: '#888',
                },
              ],
            },
          },
        }) as any,
      sendMessage: async () => {},
      getSessions: () => ({}),
    });

    // The archived card must not block the cronjob from firing.
    const updated = await getCronjob(cronjob.id);
    expect(updated?.last_run).toBeTruthy();
    expect(new Date(updated!.next_run!).getTime()).toBeGreaterThan(Date.now());
    expect((await getTasksByProject(projectId)).length).toBe(2);
  });

  test('pauses a malformed cron when if_empty skips a project with an active run', async () => {
    const projectId = 'running-project-with-invalid-cron';
    const cronjob = await createCronjob({
      project_id: projectId,
      title: 'Invalid busy project job',
      description: '',
      cron_expression: 'not a cron expression',
      queue_mode: 'if_empty',
      status: 'active',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    const runningTask = await createTask({
      project_id: projectId,
      title: 'Already running',
      description: '',
      status: 'in_progress',
      priority: 0,
    });
    await insertActiveRun(
      runFixture({
        group_folder: projectId,
        task_id: runningTask.id,
      }),
    );

    const deps = {
      registeredGroups: () =>
        ({
          [projectId]: {
            folder: projectId,
            settings: {
              stages: [
                {
                  id: 'backlog',
                  title: 'Backlog',
                  type: 'queue',
                  color: '#888',
                },
                {
                  id: 'in_progress',
                  title: 'In Progress',
                  type: 'active',
                  color: '#888',
                },
                {
                  id: 'completed',
                  title: 'Completed',
                  type: 'done',
                  color: '#888',
                },
              ],
            },
          },
        }) as any,
      sendMessage: async () => {},
      getSessions: () => ({}),
    };

    await processDueCronjobs(deps);
    await processDueCronjobs(deps);

    expect((await getCronjob(cronjob.id))?.status).toBe('paused');
    expect(await getTasksByProject(projectId)).toHaveLength(1);
  });

  test('pauses an invalid due cron without creating a task', async () => {
    const projectId = 'invalid-due-cron-project';
    const cronjob = await createCronjob({
      project_id: projectId,
      title: 'Invalid schedule must not run',
      description: '',
      // Legacy/imported rows can bypass route validation and still be due.
      cron_expression: 'not a cron expression',
      queue_mode: 'always',
      status: 'active',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    const deps = {
      registeredGroups: () =>
        ({
          [projectId]: {
            folder: projectId,
            settings: {
              stages: [
                {
                  id: 'backlog',
                  title: 'Backlog',
                  type: 'queue',
                  color: '#888',
                },
                {
                  id: 'in_progress',
                  title: 'In Progress',
                  type: 'active',
                  color: '#888',
                },
                {
                  id: 'completed',
                  title: 'Completed',
                  type: 'done',
                  color: '#888',
                },
              ],
            },
          },
        }) as any,
      sendMessage: async () => {},
      getSessions: () => ({}),
    };

    await processDueCronjobs(deps);
    await processDueCronjobs(deps);

    expect(await getTasksByProject(projectId)).toHaveLength(0);
    expect((await getCronjob(cronjob.id))?.status).toBe('paused');
  });

  test('does not strand a task when the project has no active worker stage', async () => {
    const projectId = 'no-active-stage-project';
    const cronjob = await createCronjob({
      project_id: projectId,
      title: 'Cannot execute yet',
      description: '',
      cron_expression: '* * * * *',
      queue_mode: 'always',
      status: 'active',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    await processDueCronjobs({
      registeredGroups: () =>
        ({
          [projectId]: {
            folder: projectId,
            settings: {
              stages: [
                {
                  id: 'backlog',
                  title: 'Backlog',
                  type: 'queue',
                  color: '#888',
                },
                {
                  id: 'completed',
                  title: 'Completed',
                  type: 'done',
                  color: '#888',
                },
              ],
            },
          },
        }) as any,
      sendMessage: async () => {},
      getSessions: () => ({}),
    });

    expect(await getTasksByProject(projectId)).toHaveLength(0);
    const updated = await getCronjob(cronjob.id);
    expect(new Date(updated!.next_run!).getTime()).toBeGreaterThan(Date.now());
    expect(updated?.last_run).toBeNull();
  });
});

describe('calcNextRun', () => {
  const baseTask = {
    id: 'invalid-cron-task',
    group_folder: 'project',
    chat_jid: 'project@web',
    prompt: 'run check',
    context_mode: 'isolated' as const,
    next_run: new Date().toISOString(),
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: new Date().toISOString(),
  };

  test('returns null for an invalid cron instead of leaving it due forever', () => {
    expect(
      calcNextRun({
        ...baseTask,
        schedule_type: 'cron',
        schedule_value: 'not a cron expression',
      }),
    ).toBeNull();
  });

  test('returns null for an interval with trailing garbage', () => {
    expect(
      calcNextRun({
        ...baseTask,
        schedule_type: 'interval',
        schedule_value: '60000oops',
      }),
    ).toBeNull();
  });
});

describe('createSchedulerPoll', () => {
  test('retries transcript archival after a failed maintenance pass', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
import { mock } from 'bun:test';
import fs from 'node:fs';
const root = process.cwd();
const dataDir = fs.mkdtempSync('/tmp/carapa-archive-retry-');
process.env.CARAPA_DATA_DIR = dataDir;
let archiveCalls = 0;
const replace = (file, exports) => {
  mock.module(root + '/src/' + file + '.ts', () => exports);
  mock.module(root + '/src/' + file + '.js', () => exports);
};
replace('db', {
  cleanupOldRecords: async () => ({ taskRunLogs: 0 }),
  getDueTasks: async () => [],
  getTaskById: async () => null,
  logTaskRun: async () => {},
  getLatestScheduledRunId: async () => null,
  updateScheduledTaskAfterRun: async () => true,
  skipScheduledTaskOccurrence: async () => {},
  getDueCronjobs: async () => [],
  getCronjob: async () => null,
  getObjective: async () => null,
  updateCronjob: async () => null,
  createTaskForDueCronjob: async () => null,
  getTasksByProjectForQueue: async () => [],
  claimScheduledTaskOccurrence: async () => true,
  releaseScheduledTaskOccurrenceClaim: async () => {},
});
replace('agent-runner', { runChatAgent: async () => ({}) });
replace('modules/kanban/task-executor', { drainProjectQueue: async () => {} });
replace('modules/objectives/ws-events', { broadcast: () => {} });
replace('modules/kanban/stages', { getGroupStages: () => [] });
replace('modules/transcripts/transcript-store', {
  archiveOldTranscripts: async () => {
    archiveCalls++;
    if (archiveCalls === 1) throw new Error('archive unavailable');
    return 1;
  },
});
replace('sandbox/ipc-maintenance', { maintainIpc: async () => ({}) });
replace('modules/memory/maintenance', { maintainMemories: async () => {} });
replace('logger', { logger: {
  debug() {},
  error() {},
  info() {},
  warn() {},
} });
try {
  const { createSchedulerPoll } = await import(
    root + '/src/modules/chat/scheduling/task-scheduler.ts'
  );
  const poll = createSchedulerPoll({
    registeredGroups: () => ({}),
    sendMessage: async () => {},
    getSessions: () => ({}),
    runChatAgent: async () => ({}),
  });
  await poll();
  await poll();
  if (archiveCalls !== 2)
    throw new Error('expected archival to retry after the failed pass');
  if (!fs.existsSync(dataDir + '/data/transcript-archive.last-run'))
    throw new Error('expected a successful archival watermark');
  console.log('archive retry checks passed');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
`,
      ],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('archive retry checks passed');
  });

  test('an empty project cron and later chat occurrence proceed while another chat waits', async () => {
    const projectId = `independent-schedules-${Date.now()}`;
    const selected = {
      id: `${projectId}-slow`,
      group_folder: projectId,
      chat_jid: `${projectId}@web`,
      prompt: 'slow',
      schedule_type: 'interval' as const,
      schedule_value: '60000',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1_000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    await createScheduledTask(selected);
    const cronjob = await createCronjob({
      project_id: projectId,
      title: 'Empty project cron',
      description: '',
      cron_expression: '* * * * *',
      queue_mode: 'if_empty',
      status: 'active',
      next_run: selected.next_run,
    });
    // Occupy execution capacity without putting a card in an active stage.
    // This keeps the real queue drain from launching a sandbox in this test.
    await insertActiveRun(
      runFixture({
        group_folder: projectId,
        task_id: 'capacity-reservation',
      }),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: string[] = [];
    const poll = createSchedulerPoll({
      registeredGroups: () => ({
        [projectId]: { folder: projectId, settings: {} } as any,
      }),
      sendMessage: async () => {},
      getSessions: () => ({}),
      runChatAgent: (async (_group: unknown, prompt: string) => {
        starts.push(prompt);
        if (prompt === 'slow') await held;
        return { result: 'completed' };
      }) as any,
    });
    const waitForFinalization = async (id: string) => {
      const deadline = Date.now() + 5_000;
      while (!(await getTaskById(id))?.last_run) {
        if (Date.now() >= deadline)
          throw new Error('Scheduled run did not finalize');
        await Bun.sleep(1);
      }
    };
    try {
      await poll();
      expect(starts).toEqual(['slow']);
      expect(await hasRunningScheduledTask(selected.id)).toBe(true);
      expect(
        (await getTasksByProject(projectId)).map((task) => task.cronjob_id),
      ).toEqual([cronjob.id]);
      expect((await getCronjob(cronjob.id))?.last_run).toBeTruthy();

      const later = { ...selected, id: `${projectId}-later`, prompt: 'later' };
      await createScheduledTask(later);
      await poll();
      await waitForFinalization(later.id);
      expect(starts).toEqual(['slow', 'later']);
      expect(await getTaskRunLogs(selected.id)).toHaveLength(0);
      expect(await getTasksByProject(projectId)).toHaveLength(1);
    } finally {
      release();
      await waitForFinalization(selected.id);
    }
  });

  test('keeps later due tasks and cronjobs running after one task fails', async () => {
    const suffix = Date.now();
    const failingFolder = `poll-isolation-fail-${suffix}`;
    const okFolder = `poll-isolation-ok-${suffix}`;

    // A regular file at the failing task's group dir makes runTask's mkdir
    // preflight throw before the agent launches — a per-task failure that
    // happens outside runTask's internal agent error handling.
    const failingDir = getGroupDir(failingFolder);
    fs.mkdirSync(path.dirname(failingDir), { recursive: true });
    fs.writeFileSync(failingDir, 'blocks the group dir');
    try {
      const failingNextRun = new Date(Date.now() - 2_000).toISOString();
      const okNextRun = new Date(Date.now() - 1_000).toISOString();
      const failingTask = {
        id: `${failingFolder}-task`,
        group_folder: failingFolder,
        chat_jid: `${failingFolder}@web`,
        prompt: 'Must not block the rest of the poll',
        schedule_type: 'interval' as const,
        schedule_value: '60000',
        context_mode: 'isolated' as const,
        next_run: failingNextRun,
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: new Date().toISOString(),
      };
      const okTask = {
        id: `${okFolder}-task`,
        group_folder: okFolder,
        chat_jid: `${okFolder}@web`,
        prompt: 'Survivor occurrence',
        schedule_type: 'interval' as const,
        schedule_value: '60000',
        context_mode: 'isolated' as const,
        next_run: okNextRun,
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: new Date().toISOString(),
      };
      await createScheduledTask(failingTask);
      await createScheduledTask(okTask);

      const cronjob = await createCronjob({
        project_id: okFolder,
        title: 'Survivor cron job',
        description: '',
        cron_expression: '* * * * *',
        queue_mode: 'always',
        status: 'active',
        next_run: new Date(Date.now() - 60_000).toISOString(),
      });

      // Occupy the worker slot so the cronjob's asynchronously triggered
      // queue drain cannot launch an agent while this test runs.
      await insertActiveRun(
        runFixture({
          group_folder: okFolder,
          task_id: 'existing-running-task',
        }),
      );

      let executions = 0;
      const deps = {
        registeredGroups: () =>
          ({
            [failingFolder]: { folder: failingFolder, settings: {} },
            [okFolder]: { folder: okFolder, settings: {} },
          }) as any,
        sendMessage: async () => {},
        getSessions: () => ({}),
        runChatAgent: (async () => {
          executions += 1;
          return { result: 'survivor ran' };
        }) as any,
      };

      await createSchedulerPoll(deps)();

      // Dispatch now returns without awaiting agent runs. Wait for durable
      // finalization before asserting history and occurrence-claim release.
      const deadline = Date.now() + 5_000;
      while (!(await getTaskById(okTask.id))?.last_run) {
        if (Date.now() >= deadline)
          throw new Error('Scheduled run did not finalize');
        await Bun.sleep(1);
      }

      // The failed occurrence stays due for the next poll: its claim was
      // released and no run log was recorded.
      expect(await getTaskRunLogs(failingTask.id)).toHaveLength(0);
      expect(await getTaskById(failingTask.id)).toMatchObject({
        next_run: failingNextRun,
        last_run: null,
      });

      // The later due task still ran and finalized.
      const okLogs = await getTaskRunLogs(okTask.id);
      expect(okLogs).toHaveLength(1);
      expect(okLogs[0]?.status).toBe('success');
      expect(executions).toBe(1);
      const finalized = await getTaskById(okTask.id);
      expect(finalized?.last_run).toBeTruthy();
      expect(new Date(finalized!.next_run!).getTime()).toBeGreaterThan(
        Date.now(),
      );

      // Kanban cronjob processing survived the earlier task failure.
      const spawned = await getTasksByProject(okFolder);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.status).toBe('in_progress');
      const updated = await getCronjob(cronjob.id);
      expect(updated?.last_run).toBeTruthy();
      expect(new Date(updated!.next_run!).getTime()).toBeGreaterThan(
        Date.now(),
      );
    } finally {
      fs.rmSync(failingDir, { force: true });
    }
  });
});
