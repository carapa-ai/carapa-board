/**
 * Extended tests for src/db.ts — updateTask allowlist, initDatabase idempotency,
 * getProjectsStatusSummary, getTasksByProject with ordering, deleteProjectData.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import {
  initDatabase,
  createTask,
  getTask,
  updateTask,
  getTasksByProject,
  getTasksByProjectSummary,
  getProjectsStatusSummary,
  acknowledgeKanbanCompletions,
  upsertConversationMember,
  upsertProjectMember,
  getProjectsForUser,
  removeProjectMember,
  insertActiveRun,
  createScheduledTask,
  completeActiveRun,
  updateRunStats,
  renameProjectFolder,
  CrossProjectDependencyError,
} from '../../db.js';
import {
  countProjectTasksByStatus,
  dismissNowItems,
  getAttentionCompletedTasks,
  getNowDismissals,
} from './db-kanban.js';

import type { Task } from './types.js';
import {
  taskFixture as baseTaskFixture,
  runFixture,
  truncateTestDb,
} from '../../test-helpers.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  conversations,
  memoryAudits,
  memoryPrivacyErasureMarks,
  proposals,
  projectMemberKanbanAcknowledgements,
  projectMembers,
  projects,
  taskBoardEvents,
  users,
} from '../../db/schema.js';

const PROJ = 'ext-test-project';

function taskFixture(
  overrides: Partial<Task> = {},
): Omit<Task, 'id' | 'created_at'> {
  return baseTaskFixture({ project_id: PROJ, description: '', ...overrides });
}

let _init = false;
beforeEach(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  await truncateTestDb();
});

// ─── updateTask allowlist ─────────────────────────────────────────────────────

describe('updateTask allowlist', () => {
  const OTHER_PROJ = 'ext-test-other-project';

  test('rejects creating a task that depends on a task from another project', async () => {
    const foreign = await createTask(
      taskFixture({ project_id: OTHER_PROJ, title: 'Foreign' }),
    );
    await expect(
      createTask(taskFixture({ depends_on_ids: [foreign.id] })),
    ).rejects.toThrow(CrossProjectDependencyError);
    // No partial write: no task row and no board event rows in the
    // dependent task's project.
    expect(await getTasksByProject(PROJ)).toHaveLength(0);
    const events = await drizzleDbRef.current
      .select({ id: taskBoardEvents.id })
      .from(taskBoardEvents)
      .where(eq(taskBoardEvents.project_id, PROJ));
    expect(events).toHaveLength(0);
  });

  test('rejects updating dependencies to another project and preserves the previous list', async () => {
    const task = await createTask(taskFixture());
    const dep = await createTask(taskFixture({ title: 'Dep' }));
    await updateTask(task.id, { depends_on_ids: [dep.id] });
    const foreign = await createTask(
      taskFixture({ project_id: OTHER_PROJ, title: 'Foreign' }),
    );
    await expect(
      updateTask(task.id, { depends_on_ids: [foreign.id] }),
    ).rejects.toThrow(CrossProjectDependencyError);
    const updated = (await getTask(task.id))!;
    expect(updated.depends_on_ids).toEqual([dep.id]);
  });

  test('rejects moving a task to a project that would leave its dependencies behind', async () => {
    const task = await createTask(taskFixture());
    const dep = await createTask(taskFixture({ title: 'Dep' }));
    await updateTask(task.id, { depends_on_ids: [dep.id] });
    await expect(
      updateTask(task.id, { project_id: OTHER_PROJ }),
    ).rejects.toThrow(CrossProjectDependencyError);
    const updated = (await getTask(task.id))!;
    expect(updated.project_id).toBe(PROJ);
    expect(updated.depends_on_ids).toEqual([dep.id]);
  });

  test('still allows same-project dependencies and clearing with an empty array', async () => {
    const task = await createTask(taskFixture());
    const dep = await createTask(taskFixture({ title: 'Dep' }));
    await updateTask(task.id, { depends_on_ids: [dep.id] });
    expect((await getTask(task.id))!.depends_on_ids).toEqual([dep.id]);
    await updateTask(task.id, { depends_on_ids: [] });
    expect((await getTask(task.id))!.depends_on_ids).toEqual([]);
  });

  test('clears skip_stages when updated with null', async () => {
    const task = await createTask(taskFixture());
    await updateTask(task.id, { skip_stages: ['in_progress'] });
    expect((await getTask(task.id))!.skip_stages).toEqual(['in_progress']);
    await updateTask(task.id, { skip_stages: null });
    expect((await getTask(task.id))!.skip_stages).toBeNull();
  });
});

describe('updateTask failure classification', () => {
  const FAIL_PROJ = 'ext-failure-class-project';

  async function failureTask(
    customValues: Record<string, string | number> = {},
  ) {
    await drizzleDbRef.current.insert(projects).values({
      id: FAIL_PROJ,
      jid: 'ext-failure-class-jid',
      name: 'Failure class',
      folder: FAIL_PROJ,
      trigger: '@failure',
      added_at: new Date().toISOString(),
    });
    return createTask(
      taskFixture({
        project_id: FAIL_PROJ,
        status: 'in_progress',
        custom_values: customValues,
      }),
    );
  }

  test('entering the failed stage records class and bounded reason, preserving other keys', async () => {
    const task = await failureTask({ transient_retries: 2 });
    await updateTask(task.id, {
      status: 'failed',
      error: `Deploy failed: ${'x'.repeat(500)}`,
    });
    const failed = (await getTask(task.id))!;
    expect(failed.error).toStartWith('Deploy failed: ');
    expect(failed.custom_values).toMatchObject({
      transient_retries: 2,
      failure_class: 'deploy',
    });
    const reason = failed.custom_values!.failure_reason as string;
    expect(reason.length).toBeLessThanOrEqual(300);

    // Updates that do not touch status leave the keys unchanged.
    await updateTask(task.id, { error: 'Timed out: later' });
    expect((await getTask(task.id))!.custom_values).toMatchObject({
      failure_class: 'deploy',
      failure_reason: reason,
    });

    // The next failure overwrites them; a manual move is classed user.
    await updateTask(task.id, { status: 'backlog' });
    expect((await getTask(task.id))!.custom_values!.failure_class).toBe(
      'deploy',
    );
    await updateTask(task.id, { status: 'failed' }, { failureSource: 'user' });
    expect((await getTask(task.id))!.custom_values).toMatchObject({
      failure_class: 'user',
      transient_retries: 2,
    });
  });

  test('an explicit custom_values update is not resurrected from the locked row', async () => {
    const task = await failureTask({ transient_retries: 2 });
    await updateTask(task.id, {
      status: 'failed',
      error: 'Transient error retries exhausted',
      custom_values: {},
    });
    const values = (await getTask(task.id))!.custom_values!;
    expect(values.transient_retries).toBeUndefined();
    expect(values.failure_class).toBe('infra_transient');
  });
});

describe('renameProjectFolder', () => {
  test('moves the project row, tasks, and conversations to the new key', async () => {
    const oldFolder = 'rename-project-old';
    const newFolder = 'rename-project-new';
    await drizzleDbRef.current.insert(projects).values({
      id: oldFolder,
      jid: 'rename-project-jid',
      name: 'Rename project',
      folder: oldFolder,
      trigger: '@rename',
      added_at: new Date().toISOString(),
    });
    const task = await createTask(taskFixture({ project_id: oldFolder }));
    await drizzleDbRef.current.insert(conversations).values({
      id: 'rename-project-conversation',
      group_folder: oldFolder,
      created_at: new Date().toISOString(),
    });
    const userId = 'rename-project-viewer';
    await drizzleDbRef.current.insert(users).values({
      id: userId,
      username: userId,
      password_hash: 'test-only',
      role: 'user',
      created_at: new Date().toISOString(),
    });
    await upsertProjectMember(userId, oldFolder, 'viewer');
    // Marks outlive project deletion: the unused destination slug may already
    // carry one, and the rename must merge to the latest erasure time.
    await drizzleDbRef.current.insert(memoryPrivacyErasureMarks).values([
      { group_folder: oldFolder, last_erased_at: '2026-02-01T00:00:00.000Z' },
      { group_folder: newFolder, last_erased_at: '2026-01-01T00:00:00.000Z' },
    ]);
    await drizzleDbRef.current.insert(proposals).values({
      id: 'rename-project-proposal',
      project_id: oldFolder,
      conversation_id: 'rename-project-conversation',
      title: 'Tidy',
      rationale: 'Because',
      kind: 'rule',
      name: 'tidy',
      target_layer: 'project',
      approve_action: { type: 'none' },
      base_hash: 'hash',
      created_at: new Date().toISOString(),
    });
    await renameProjectFolder(oldFolder, newFolder);

    expect(
      (
        await drizzleDbRef.current
          .select({ project_id: proposals.project_id })
          .from(proposals)
          .where(eq(proposals.id, 'rename-project-proposal'))
      )[0].project_id,
    ).toBe(newFolder);
    expect(
      await drizzleDbRef.current.select().from(memoryPrivacyErasureMarks),
    ).toEqual([
      { group_folder: newFolder, last_erased_at: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(await getTasksByProject(oldFolder)).toHaveLength(0);
    expect((await getTask(task.id))?.project_id).toBe(newFolder);
    expect(
      await drizzleDbRef.current
        .select()
        .from(conversations)
        .where(eq(conversations.group_folder, newFolder)),
    ).toHaveLength(1);
    expect(
      await drizzleDbRef.current
        .select()
        .from(projects)
        .where(eq(projects.id, oldFolder)),
    ).toHaveLength(0);
    expect(
      await drizzleDbRef.current
        .select()
        .from(projects)
        .where(eq(projects.id, newFolder)),
    ).toHaveLength(1);
    expect(await getProjectsForUser(userId)).toEqual([newFolder]);
  });

  test('keeps share tokens, audits and kanban acknowledgements with FK enforcement on', async () => {
    const oldFolder = 'rename-fk-old';
    const newFolder = 'rename-fk-new';
    const userId = 'rename-fk-user';
    const now = new Date().toISOString();
    const db = drizzleDbRef.current;
    await db.insert(projects).values({
      id: oldFolder,
      jid: 'rename-fk-jid',
      name: 'Rename FK',
      folder: oldFolder,
      trigger: '@rename',
      added_at: now,
    });
    await db.insert(users).values({
      id: userId,
      username: userId,
      password_hash: 'test-only',
      role: 'user',
      created_at: now,
    });
    await upsertProjectMember(userId, oldFolder, 'viewer');
    const task = await createTask(taskFixture({ project_id: oldFolder }));
    const [event] = await db
      .select({ id: taskBoardEvents.id })
      .from(taskBoardEvents)
      .where(eq(taskBoardEvents.task_id, task.id));
    await db.insert(projectMemberKanbanAcknowledgements).values({
      user_id: userId,
      project_id: oldFolder,
      event_id: event!.id,
    });
    await db.insert(memoryAudits).values({
      id: 'rename-fk-audit',
      project_id: oldFolder,
      runtime_id: 'runtime',
      prompt_version: 'v1',
      status: 'ready',
      baseline_fingerprint: 'fp',
      created_at: now,
      updated_at: now,
    });

    // truncateTestDb disables FK enforcement; the rename must hold with it on.
    await db.execute(sql`SET session_replication_role = 'origin'`);
    try {
      await renameProjectFolder(oldFolder, newFolder);
    } finally {
      await db.execute(sql`SET session_replication_role = 'replica'`);
    }

    expect(
      await db
        .select()
        .from(memoryAudits)
        .where(eq(memoryAudits.project_id, newFolder)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(projectMemberKanbanAcknowledgements)
        .where(eq(projectMemberKanbanAcknowledgements.project_id, newFolder)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.project_id, oldFolder)),
    ).toHaveLength(0);
  });

  test('refuses to rename while a foreign-key table still holds rows for the project', async () => {
    const oldFolder = 'rename-guard-old';
    const newFolder = 'rename-guard-new';
    const scratch = 'rename_guard_scratch_' + randomUUID().replaceAll('-', '');
    const db = drizzleDbRef.current;
    await db.insert(projects).values({
      id: oldFolder,
      jid: 'rename-guard-jid',
      name: 'Rename guard',
      folder: oldFolder,
      trigger: '@guard',
      added_at: new Date().toISOString(),
    });
    const task = await createTask(taskFixture({ project_id: oldFolder }));
    // truncateTestDb disables FK enforcement; the cascade guard needs it on.
    await db.execute(sql`SET session_replication_role = 'origin'`);
    try {
      await db.execute(
        sql`CREATE TABLE ${sql.identifier(scratch)} (project_id text REFERENCES projects(id) ON DELETE CASCADE)`,
      );
      await db.execute(
        sql`INSERT INTO ${sql.identifier(scratch)} (project_id) VALUES (${oldFolder})`,
      );

      await expect(renameProjectFolder(oldFolder, newFolder)).rejects.toThrow(
        `${scratch}.project_id`,
      );

      expect(
        await db.select().from(projects).where(eq(projects.id, oldFolder)),
      ).toHaveLength(1);
      expect(
        await db.select().from(projects).where(eq(projects.id, newFolder)),
      ).toHaveLength(0);
      expect((await getTask(task.id))?.project_id).toBe(oldFolder);
      const scratchRows = await db.execute(
        sql`SELECT 1 FROM ${sql.identifier(scratch)} WHERE project_id = ${oldFolder}`,
      );
      expect(scratchRows.rows).toHaveLength(1);
    } finally {
      await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(scratch)}`);
      await db.execute(sql`SET session_replication_role = 'replica'`);
    }
  });
});

// ─── getTasksByProject ────────────────────────────────────────────────────────

describe('getTasksByProject', () => {
  test('counts requested statuses and includes archived cards', async () => {
    await createTask(taskFixture({ status: 'review' }));
    await createTask(taskFixture({ status: 'review', archived: true }));
    await createTask(taskFixture({ status: 'done' }));
    await createTask({
      ...taskFixture({ status: 'review' }),
      project_id: 'other-project',
    });

    expect(
      await countProjectTasksByStatus(PROJ, ['review', 'testing']),
    ).toEqual([{ status: 'review', count: 2 }]);
    expect(await countProjectTasksByStatus(PROJ, [])).toEqual([]);
  });

  test('orders by priority ASC then created_at DESC', async () => {
    await createTask(taskFixture({ title: 'High priority', priority: 1 }));
    await createTask(taskFixture({ title: 'Low priority', priority: 10 }));
    await createTask(taskFixture({ title: 'Default priority', priority: 0 }));
    const tasks = await getTasksByProject(PROJ);
    const priorities = tasks.map((t) => t.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });
});

describe('getTasksByProjectSummary', () => {
  test('returns the model reported by the most recent run', async () => {
    const task = await createTask(taskFixture());
    const olderRun = runFixture({
      id: 'run-older-model',
      task_id: task.id,
      started_at: '2026-07-29T10:00:00.000Z',
    });
    const latestRun = runFixture({
      id: 'run-latest-model',
      task_id: task.id,
      started_at: '2026-07-29T11:00:00.000Z',
    });
    await insertActiveRun(olderRun);
    await updateRunStats(olderRun.id, { model_name: 'gemma-4-12b' });
    await insertActiveRun(latestRun);
    await updateRunStats(latestRun.id, { model_name: 'gpt-5.6-sol' });

    const tasks = await getTasksByProjectSummary(PROJ);

    expect(
      tasks.find((candidate) => candidate.id === task.id)?.latestRunModelName,
    ).toBe('gpt-5.6-sol');
  });
  test('counts every persisted task run and defaults tasks without runs to zero', async () => {
    const task = await createTask(taskFixture({ title: 'Counted task' }));
    const otherTask = await createTask(taskFixture({ title: 'Other task' }));
    const noRunTask = await createTask(taskFixture({ title: 'No run task' }));
    const otherProjectRunTaskId = 'task-other-project';
    const statuses = ['running', 'completed', 'stalled', 'error'] as const;

    for (const [index, status] of statuses.entries()) {
      await insertActiveRun(
        runFixture({
          id: `run-count-${index}`,
          task_id: task.id,
          group_folder: PROJ,
          status,
        }),
      );
    }
    await insertActiveRun(
      runFixture({
        id: 'run-other-task',
        task_id: otherTask.id,
        group_folder: PROJ,
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'run-other-project',
        task_id: otherProjectRunTaskId,
        group_folder: 'another-project',
      }),
    );
    await insertActiveRun(
      runFixture({ id: 'run-unlinked', task_id: null, group_folder: PROJ }),
    );

    const summaries = await getTasksByProjectSummary(PROJ);
    expect(
      summaries.find((candidate) => candidate.id === task.id)?.runCount,
    ).toBe(4);
    expect(
      summaries.find((candidate) => candidate.id === otherTask.id)?.runCount,
    ).toBe(1);
    expect(
      summaries.find((candidate) => candidate.id === noRunTask.id)?.runCount,
    ).toBe(0);
  });
});

describe('getProjectsStatusSummary', () => {
  const USER_A = 'status-user-a';
  const USER_B = 'status-user-b';

  test('does not treat an incomplete native import as active work', async () => {
    await drizzleDbRef.current.insert(conversations).values({
      id: 'conv-cursor-incomplete-native-session',
      group_folder: PROJ,
      created_at: '2026-03-16T09:00:00.000Z',
      last_assistant_at: '2026-03-16T09:30:00.000Z',
      last_user_at: '2026-03-16T10:00:00.000Z',
    });

    const status = await getProjectsStatusSummary(USER_A, [PROJ]);
    expect(status.projects[PROJ]?.chat ?? 'idle').toBe('idle');
  });

  test('reports simultaneous modes and gives working precedence over finished', async () => {
    const activeTask = await createTask(taskFixture());
    await insertActiveRun(
      runFixture({ task_id: activeTask.id, group_folder: PROJ }),
    );
    await createTask(
      taskFixture({
        title: 'Unread Kanban completion',
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );

    await drizzleDbRef.current.insert(conversations).values([
      {
        id: 'ordinary-chat-working',
        group_folder: PROJ,
        created_at: '2026-08-26T09:00:00.000Z',
      },
      {
        id: 'ordinary-chat-unread',
        group_folder: PROJ,
        created_at: '2026-08-26T09:00:00.000Z',
        last_assistant_at: '2026-08-26T09:30:00.000Z',
      },
      {
        id: 'objective-chat-working',
        group_folder: PROJ,
        objective_id: 'objective-a',
        created_at: '2026-08-26T09:00:00.000Z',
      },
      {
        id: 'objective-chat-unread',
        group_folder: PROJ,
        objective_id: 'objective-a',
        created_at: '2026-08-26T09:00:00.000Z',
        last_assistant_at: '2026-08-26T09:30:00.000Z',
      },
    ]);
    await insertActiveRun(
      runFixture({
        id: 'ordinary-chat-run',
        group_folder: PROJ,
        conversation_id: 'ordinary-chat-working',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'objective-chat-run',
        group_folder: PROJ,
        conversation_id: 'objective-chat-working',
      }),
    );

    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ],
    ).toEqual({
      kanban: 'working',
      chat: 'working',
      objectives: 'working',
    });
  });

  test('reports scheduled chat runs as Chat working', async () => {
    const scheduledTaskId = 'status-scheduled-chat';
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: PROJ,
      chat_jid: `${PROJ}@web`,
      prompt: 'Run a scheduled chat report',
      schedule_type: 'once',
      schedule_value: '2026-08-26T10:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-08-26T09:00:00.000Z',
    });
    await insertActiveRun(
      runFixture({
        id: 'scheduled-chat-run',
        group_folder: PROJ,
        isScheduledTask: 1,
        scheduled_task_id: scheduledTaskId,
      }),
    );

    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.chat,
    ).toBe('working');
  });

  test('excludes inaccessible conversations and Kanban work from implicit project status', async () => {
    const privateTask = await createTask(taskFixture());
    await insertActiveRun(
      runFixture({
        id: 'private-task-run',
        group_folder: PROJ,
        task_id: privateTask.id,
      }),
    );
    await createTask(
      taskFixture({
        title: 'Private Kanban completion',
        status: 'completed',
        completed_at: '2026-08-26T09:45:00.000Z',
      }),
    );
    await drizzleDbRef.current.insert(conversations).values([
      {
        id: 'private-chat-unread',
        group_folder: PROJ,
        created_at: '2026-08-26T09:00:00.000Z',
        last_assistant_at: '2026-08-26T09:30:00.000Z',
      },
      {
        id: 'private-objective-working',
        group_folder: PROJ,
        objective_id: 'private-objective',
        created_at: '2026-08-26T09:00:00.000Z',
      },
    ]);
    await insertActiveRun(
      runFixture({
        id: 'private-objective-run',
        group_folder: PROJ,
        conversation_id: 'private-objective-working',
      }),
    );

    expect(
      (await getProjectsStatusSummary(USER_A, [])).projects[PROJ],
    ).toBeUndefined();
  });

  test('includes only conversations shared with an implicit project user', async () => {
    await drizzleDbRef.current.insert(conversations).values([
      {
        id: 'shared-chat-working',
        group_folder: PROJ,
        created_at: '2026-08-26T09:00:00.000Z',
      },
      {
        id: 'shared-objective-unread',
        group_folder: PROJ,
        objective_id: 'shared-objective',
        created_at: '2026-08-26T09:00:00.000Z',
        last_assistant_at: '2026-08-26T09:30:00.000Z',
      },
      {
        id: 'private-objective-working',
        group_folder: PROJ,
        objective_id: 'private-objective',
        created_at: '2026-08-26T09:00:00.000Z',
      },
    ]);
    await upsertConversationMember(USER_A, 'shared-chat-working', 'viewer');
    await upsertConversationMember(USER_A, 'shared-objective-unread', 'viewer');
    await insertActiveRun(
      runFixture({
        id: 'shared-chat-run',
        group_folder: PROJ,
        conversation_id: 'shared-chat-working',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'private-objective-run',
        group_folder: PROJ,
        conversation_id: 'private-objective-working',
      }),
    );

    expect((await getProjectsStatusSummary(USER_A, [])).projects[PROJ]).toEqual(
      {
        kanban: 'idle',
        chat: 'working',
        objectives: 'finished',
      },
    );
  });

  test('explicit project access includes all ordinary and objective conversations', async () => {
    await drizzleDbRef.current.insert(conversations).values([
      {
        id: 'ordinary-unread',
        group_folder: PROJ,
        created_at: '2026-08-26T09:00:00.000Z',
        last_assistant_at: '2026-08-26T09:30:00.000Z',
      },
      {
        id: 'objective-unread',
        group_folder: PROJ,
        objective_id: 'objective-b',
        created_at: '2026-08-26T09:00:00.000Z',
        last_assistant_at: '2026-08-26T09:31:00.000Z',
      },
    ]);

    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ],
    ).toEqual({
      kanban: 'idle',
      chat: 'finished',
      objectives: 'finished',
    });
  });

  test('excludes archived completed tasks from Kanban attention', async () => {
    await createTask(
      taskFixture({
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
        archived: true,
      }),
    );
    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.kanban,
    ).not.toBe('finished');
  });

  test('acknowledges visible completions per user', async () => {
    await Promise.all([
      upsertProjectMember(USER_A, PROJ, 'viewer'),
      upsertProjectMember(USER_B, PROJ, 'viewer'),
    ]);
    const completed = await createTask(
      taskFixture({
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );
    const visible = (await getTasksByProjectSummary(PROJ)).find(
      (task) => task.id === completed.id,
    );
    expect(visible?.completionEventId).toEqual(expect.any(Number));
    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.kanban,
    ).toBe('finished');
    expect(
      (await getProjectsStatusSummary(USER_B, [PROJ])).projects[PROJ]?.kanban,
    ).toBe('finished');

    await acknowledgeKanbanCompletions(USER_A, PROJ, [
      visible!.completionEventId!,
    ]);

    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.kanban,
    ).not.toBe('finished');
    expect(
      (await getProjectsStatusSummary(USER_B, [PROJ])).projects[PROJ]?.kanban,
    ).toBe('finished');
  });

  test('editing an acknowledged completed task does not create new attention', async () => {
    await upsertProjectMember(USER_A, PROJ, 'viewer');
    const completed = await createTask(
      taskFixture({
        title: 'Completed result',
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );
    const visible = (await getTasksByProjectSummary(PROJ)).find(
      (task) => task.id === completed.id,
    );
    await acknowledgeKanbanCompletions(USER_A, PROJ, [
      visible!.completionEventId!,
    ]);

    await updateTask(completed.id, { title: 'Edited completed result' });

    const afterEdit = (await getTasksByProjectSummary(PROJ)).find(
      (task) => task.id === completed.id,
    );
    expect(afterEdit?.completionEventId).toBe(visible?.completionEventId);
    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.kanban,
    ).not.toBe('finished');
  });

  test('concurrent exact acknowledgements remain idempotent', async () => {
    await upsertProjectMember(USER_A, PROJ, 'viewer');
    const older = await createTask(
      taskFixture({
        title: 'Older visible completion',
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );
    const newer = await createTask(
      taskFixture({
        title: 'Newer visible completion',
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );

    const visible = await getTasksByProjectSummary(PROJ);
    const eventByTaskId = new Map(
      visible.map((task) => [task.id, task.completionEventId!]),
    );
    await Promise.all([
      acknowledgeKanbanCompletions(USER_A, PROJ, [
        eventByTaskId.get(newer.id)!,
      ]),
      acknowledgeKanbanCompletions(USER_A, PROJ, [
        eventByTaskId.get(older.id)!,
      ]),
    ]);

    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.kanban,
    ).not.toBe('finished');
  });

  test('a completion after acknowledgement becomes finished again', async () => {
    await upsertProjectMember(USER_A, PROJ, 'viewer');
    const first = await createTask(
      taskFixture({
        title: 'First completion',
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );
    const visible = (await getTasksByProjectSummary(PROJ)).find(
      (task) => task.id === first.id,
    );
    await acknowledgeKanbanCompletions(USER_A, PROJ, [
      visible!.completionEventId!,
    ]);
    await createTask(
      taskFixture({
        title: 'Later completion with the same timestamp',
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );

    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.kanban,
    ).toBe('finished');
  });

  test('an older-ID completion that becomes visible after acknowledgement stays finished', async () => {
    await upsertProjectMember(USER_A, PROJ, 'viewer');
    const delayed = await createTask(
      taskFixture({
        title: 'Completion whose commit is delayed',
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );
    const [delayedEvent] = await drizzleDbRef.current
      .select()
      .from(taskBoardEvents)
      .where(eq(taskBoardEvents.task_id, delayed.id));
    expect(delayedEvent).toBeDefined();

    // PGlite serializes transactions, so stage the same committed state by
    // withholding the lower sequence ID until after the newer event is
    // acknowledged. The production status and acknowledgement queries still
    // execute against the exact ordering that PostgreSQL can expose.
    await drizzleDbRef.current
      .delete(taskBoardEvents)
      .where(eq(taskBoardEvents.id, delayedEvent!.id));
    const newer = await createTask(
      taskFixture({
        title: 'Newer visible completion',
        status: 'completed',
        completed_at: '2026-08-26T10:01:00.000Z',
      }),
    );
    const visibleNewer = (await getTasksByProjectSummary(PROJ)).find(
      (task) => task.id === newer.id,
    );
    expect(visibleNewer!.completionEventId).toBeGreaterThan(delayedEvent!.id);

    await acknowledgeKanbanCompletions(USER_A, PROJ, [
      visibleNewer!.completionEventId!,
    ]);
    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.kanban,
    ).not.toBe('finished');

    await drizzleDbRef.current.insert(taskBoardEvents).values(delayedEvent!);

    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.kanban,
    ).toBe('finished');
  });

  test('a same-task recompletion after the visible snapshot stays finished', async () => {
    await upsertProjectMember(USER_A, PROJ, 'viewer');
    const task = await createTask(
      taskFixture({
        title: 'Completes twice',
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );
    const visible = (await getTasksByProjectSummary(PROJ)).find(
      (candidate) => candidate.id === task.id,
    );
    const visibleEventId = visible!.completionEventId!;

    await updateTask(task.id, { status: 'backlog' });
    await updateTask(task.id, {
      status: 'completed',
      completed_at: '2026-08-26T10:01:00.000Z',
    });
    const recompleted = (await getTasksByProjectSummary(PROJ)).find(
      (candidate) => candidate.id === task.id,
    );
    expect(recompleted!.completionEventId!).toBeGreaterThan(visibleEventId);

    await acknowledgeKanbanCompletions(USER_A, PROJ, [visibleEventId]);

    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.kanban,
    ).toBe('finished');
  });

  test('an acknowledgement after membership revocation cannot recreate access', async () => {
    await upsertProjectMember(USER_A, PROJ, 'viewer');
    const task = await createTask(
      taskFixture({
        title: 'Completion visible before revocation',
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );
    const visible = (await getTasksByProjectSummary(PROJ)).find(
      (candidate) => candidate.id === task.id,
    );
    await removeProjectMember(USER_A, PROJ);

    expect(
      await acknowledgeKanbanCompletions(USER_A, PROJ, [
        visible!.completionEventId!,
      ]),
    ).toBeNull();
    expect(await getProjectsForUser(USER_A)).not.toContain(PROJ);
  });

  test('completed active runs no longer report working', async () => {
    const task = await createTask(taskFixture());
    const run = runFixture({ task_id: task.id, group_folder: PROJ });
    await insertActiveRun(run);
    await completeActiveRun(run.id, 'completed');
    expect(
      (await getProjectsStatusSummary(USER_A, [PROJ])).projects[PROJ]?.kanban,
    ).not.toBe('working');
  });
});

describe('Now dismissals', () => {
  const USER = 'now-dismiss-user';

  test('a dismissed completion stays hidden until the task completes again', async () => {
    const task = await createTask(
      taskFixture({
        status: 'completed',
        completed_at: '2026-08-26T10:00:00.000Z',
      }),
    );
    const first = (await getAttentionCompletedTasks(USER, [PROJ])).find(
      (item) => item.taskId === task.id,
    );
    expect(first).toBeDefined();
    // The board acknowledgement drives only the status badge, not Now.
    await acknowledgeKanbanCompletions(USER, PROJ, [first!.eventId]);
    expect(await getAttentionCompletedTasks(USER, [PROJ])).toHaveLength(1);

    await dismissNowItems(USER, [{ kind: 'task', id: task.id }]);
    const dismissedAt = (await getNowDismissals(USER)).get(`task:${task.id}`)!;
    expect(Date.parse(first!.at)).toBeLessThanOrEqual(dismissedAt);
    expect((await getNowDismissals('someone-else')).size).toBe(0);

    await updateTask(task.id, { status: 'backlog' });
    await updateTask(task.id, {
      status: 'completed',
      completed_at: '2026-08-26T10:01:00.000Z',
    });
    const again = (await getAttentionCompletedTasks(USER, [PROJ])).find(
      (item) => item.taskId === task.id,
    );
    expect(Date.parse(again!.at)).toBeGreaterThan(dismissedAt);
  });
});
