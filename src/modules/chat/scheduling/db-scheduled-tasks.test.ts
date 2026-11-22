/**
 * Tests for scheduled_tasks CRUD functions in src/db.ts.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  initDatabase,
  createScheduledTask,
  getTaskById,
  getTasksForGroup,
  updateScheduledTask,
  updateScheduledTaskIfIdle,
  deleteScheduledTask,
  getDueTasks,
  completeActiveRun,
  insertActiveRun,
  updateScheduledTaskAfterRun,
  logTaskRun,
  getTaskRunLogs,
  getScheduledTaskRunIds,
  cleanupOldRecords,
  getActiveRunById,
  claimScheduledTaskOccurrence,
  releaseOrphanedScheduledTaskOccurrenceClaims,
  releaseScheduledTaskDeletion,
  reserveScheduledTaskDeletion,
} from '../../../db.js';

import type { ScheduledTask } from './types.js';
import { runFixture, truncateTestDb } from '../../../test-helpers.js';
import { getGroupDir } from '../../../group-dir.js';
import { deleteScheduledTaskWithTranscripts } from './delete-task.js';

const GROUP = 'sched-test-group';

function schedFixture(
  overrides: Partial<ScheduledTask> = {},
): Omit<ScheduledTask, 'last_run' | 'last_result'> {
  const rand = Math.random().toString(36).substring(2, 8);
  return {
    id: `sched-${Date.now()}-${rand}`,
    group_folder: GROUP,
    chat_jid: `${GROUP}@g.us`,
    prompt: 'Run the daily report',
    schedule_type: 'cron',
    schedule_value: '0 8 * * *',
    context_mode: 'isolated',
    next_run: null,
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

let _init = false;
beforeEach(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  await truncateTestDb();
});

// ─── createScheduledTask ──────────────────────────────────────────────────────

describe('createScheduledTask', () => {
  test('stores an optional runtime selection', async () => {
    const runtimeSelection = {
      harnessId: 'direct',
      modelId: 'gpt-5.6-sol',
      reasoning: 'low',
    };
    const fixture = schedFixture({ runtimeSelection });
    await createScheduledTask(fixture);
    expect((await getTaskById(fixture.id))?.runtimeSelection).toEqual(
      runtimeSelection,
    );
  });
});

// ─── getTasksForGroup ─────────────────────────────────────────────────────────

describe('getTasksForGroup', () => {
  test('returns only tasks for the specified group', async () => {
    await createScheduledTask(schedFixture({ group_folder: GROUP }));
    await createScheduledTask(schedFixture({ group_folder: 'other-group' }));
    const tasks = await getTasksForGroup(GROUP);
    expect(tasks.every((t) => t.group_folder === GROUP)).toBe(true);
    expect(tasks).toHaveLength(1);
  });
});

// ─── updateScheduledTask ──────────────────────────────────────────────────────

describe('updateScheduledTask', () => {
  test('updates and clears the runtime override', async () => {
    const fixture = schedFixture();
    await createScheduledTask(fixture);
    const runtimeSelection = {
      harnessId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoning: 'high',
    };

    await updateScheduledTask(fixture.id, { runtimeSelection });
    expect((await getTaskById(fixture.id))?.runtimeSelection).toEqual(
      runtimeSelection,
    );

    await updateScheduledTask(fixture.id, { runtimeSelection: null });
    expect((await getTaskById(fixture.id))?.runtimeSelection).toBeNull();
  });
});

// ─── deleteScheduledTask ──────────────────────────────────────────────────────

describe('deleteScheduledTask', () => {
  test('deletion reservation and due-occurrence claim have a single atomic winner', async () => {
    const deletionWins = schedFixture({
      next_run: new Date(Date.now() - 1_000).toISOString(),
      status: 'active',
    });
    await createScheduledTask(deletionWins);
    const deletionReservation = await reserveScheduledTaskDeletion(
      deletionWins.id,
    );
    expect(deletionReservation).not.toBeNull();
    expect(
      await claimScheduledTaskOccurrence(deletionWins as ScheduledTask),
    ).toBe(false);
    await releaseScheduledTaskDeletion(deletionReservation!);

    const claimWins = schedFixture({
      next_run: new Date(Date.now() - 1_000).toISOString(),
      status: 'active',
    });
    await createScheduledTask(claimWins);
    expect(await claimScheduledTaskOccurrence(claimWins as ScheduledTask)).toBe(
      true,
    );
    expect(await reserveScheduledTaskDeletion(claimWins.id)).toBeNull();
  });

  test('also removes associated task_run_logs', async () => {
    const fixture = schedFixture();
    await createScheduledTask(fixture);
    await logTaskRun({
      task_id: fixture.id,
      run_at: new Date().toISOString(),
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });
    await deleteScheduledTask(fixture.id);
    expect(await getTaskRunLogs(fixture.id)).toEqual([]);
  });

  test('keeps database ownership when transcript removal fails so deletion can retry', async () => {
    const fixture = schedFixture({ status: 'completed', next_run: null });
    await createScheduledTask(fixture);
    const run = runFixture({
      group_folder: fixture.group_folder,
      chat_jid: fixture.chat_jid,
      isScheduledTask: 1,
      scheduled_task_id: fixture.id,
      status: 'completed',
    });
    await insertActiveRun(run);
    await logTaskRun({
      task_id: fixture.id,
      run_id: run.id,
      run_at: new Date().toISOString(),
      duration_ms: 100,
      status: 'success',
      result: 'ok',
      error: null,
    });
    await updateScheduledTaskAfterRun(fixture.id, null, 'Historical result');
    const transcriptDir = path.join(
      getGroupDir(fixture.group_folder),
      'session-transcripts',
    );
    fs.mkdirSync(path.join(transcriptDir, `${run.id}.jsonl`), {
      recursive: true,
    });

    await expect(
      deleteScheduledTaskWithTranscripts(fixture.id, fixture.group_folder),
    ).rejects.toThrow();
    expect(await getTaskById(fixture.id)).toMatchObject({
      status: fixture.status,
      next_run: fixture.next_run,
    });
    expect(await getTaskRunLogs(fixture.id)).toHaveLength(1);

    fs.rmSync(path.join(transcriptDir, `${run.id}.jsonl`), {
      recursive: true,
      force: true,
    });
    const rawAcpPath = path.join(transcriptDir, `${run.id}.acp.raw.jsonl`);
    const runtimeSidecarPaths = [
      rawAcpPath,
      path.join(transcriptDir, `${run.id}.pi.raw.jsonl`),
      path.join(transcriptDir, `${run.id}.v1.jsonl`),
      path.join(transcriptDir, `${run.id}.v1.meta.json`),
      path.join(transcriptDir, `${run.id}.system.txt`),
    ];
    for (const artifactPath of runtimeSidecarPaths) {
      fs.writeFileSync(artifactPath, 'delete with scheduled history');
    }
    await deleteScheduledTaskWithTranscripts(fixture.id, fixture.group_folder);
    expect(await getTaskById(fixture.id)).toBeUndefined();
    expect(
      runtimeSidecarPaths.some((artifactPath) => fs.existsSync(artifactPath)),
    ).toBe(false);
  });

  test.each(['run-id query', 'database deletion'] as const)(
    'restores reservation and transcript artifacts after %s failure',
    async (failurePoint) => {
      const fixture = schedFixture({ status: 'completed', next_run: null });
      await createScheduledTask(fixture);
      const run = runFixture({
        group_folder: fixture.group_folder,
        chat_jid: fixture.chat_jid,
        isScheduledTask: 1,
        scheduled_task_id: fixture.id,
        status: 'completed',
      });
      await insertActiveRun(run);
      await logTaskRun({
        task_id: fixture.id,
        run_id: run.id,
        run_at: run.started_at,
        duration_ms: 100,
        status: 'success',
        result: 'Retain me',
        error: null,
      });
      const transcriptDir = path.join(
        getGroupDir(fixture.group_folder),
        'session-transcripts',
      );
      fs.mkdirSync(transcriptDir, { recursive: true });
      const transcriptPath = path.join(transcriptDir, `${run.id}.jsonl`);
      const promptPath = path.join(transcriptDir, `${run.id}.prompt.txt`);
      const systemPromptPath = path.join(transcriptDir, `${run.id}.system.txt`);
      const rawAcpPath = path.join(transcriptDir, `${run.id}.acp.raw.jsonl`);
      const rawCodexPath = path.join(
        transcriptDir,
        `${run.id}.codex.raw.jsonl`,
      );
      const rawPiPath = path.join(transcriptDir, `${run.id}.pi.raw.jsonl`);
      const v1Path = path.join(transcriptDir, `${run.id}.v1.jsonl`);
      const v1ManifestPath = path.join(transcriptDir, `${run.id}.v1.meta.json`);
      fs.writeFileSync(transcriptPath, 'retained output');
      fs.writeFileSync(promptPath, 'retained prompt');
      fs.writeFileSync(systemPromptPath, 'retained system prompt');
      fs.writeFileSync(rawAcpPath, 'retained ACP');
      fs.writeFileSync(rawCodexPath, 'retained Codex');
      fs.writeFileSync(rawPiPath, 'retained Pi');
      fs.writeFileSync(v1Path, 'retained V1');
      fs.writeFileSync(v1ManifestPath, 'retained V1 manifest');

      await expect(
        deleteScheduledTaskWithTranscripts(fixture.id, fixture.group_folder, {
          getRunIds:
            failurePoint === 'run-id query'
              ? async () => {
                  throw new Error('run-id query failed');
                }
              : getScheduledTaskRunIds,
          deleteTask:
            failurePoint === 'database deletion'
              ? async () => {
                  expect(fs.existsSync(rawAcpPath)).toBe(false);
                  expect(fs.existsSync(rawCodexPath)).toBe(false);
                  expect(fs.existsSync(rawPiPath)).toBe(false);
                  expect(fs.existsSync(v1Path)).toBe(false);
                  expect(fs.existsSync(v1ManifestPath)).toBe(false);
                  expect(fs.existsSync(systemPromptPath)).toBe(false);
                  throw new Error('database deletion failed');
                }
              : deleteScheduledTask,
        }),
      ).rejects.toThrow(`${failurePoint} failed`);

      expect(await getTaskById(fixture.id)).toMatchObject({
        status: fixture.status,
        next_run: fixture.next_run,
      });
      expect(await getTaskRunLogs(fixture.id)).toHaveLength(1);
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe('retained output');
      expect(fs.readFileSync(promptPath, 'utf8')).toBe('retained prompt');
      expect(fs.readFileSync(systemPromptPath, 'utf8')).toBe(
        'retained system prompt',
      );
      expect(fs.readFileSync(rawAcpPath, 'utf8')).toBe('retained ACP');
      expect(fs.readFileSync(rawCodexPath, 'utf8')).toBe('retained Codex');
      expect(fs.readFileSync(rawPiPath, 'utf8')).toBe('retained Pi');
      expect(fs.readFileSync(v1Path, 'utf8')).toBe('retained V1');
      expect(fs.readFileSync(v1ManifestPath, 'utf8')).toBe(
        'retained V1 manifest',
      );
    },
  );
});

describe('scheduled occurrence claim recovery', () => {
  test('releases active and paused null-next-run claims without active run ownership', async () => {
    const orphaned = schedFixture({
      next_run: new Date(Date.now() - 1_000).toISOString(),
      status: 'active',
    });
    await createScheduledTask(orphaned);
    const historicalRun = runFixture({
      group_folder: orphaned.group_folder,
      chat_jid: orphaned.chat_jid,
      isScheduledTask: 1,
      scheduled_task_id: orphaned.id,
      status: 'completed',
      started_at: new Date(Date.now() - 120_000).toISOString(),
    });
    await insertActiveRun(historicalRun);
    await logTaskRun({
      task_id: orphaned.id,
      run_id: historicalRun.id,
      run_at: historicalRun.started_at,
      duration_ms: 1_000,
      status: 'success',
      result: 'Earlier occurrence completed',
      error: null,
    });
    await updateScheduledTaskAfterRun(
      orphaned.id,
      orphaned.next_run,
      'Earlier occurrence completed',
    );
    expect(await claimScheduledTaskOccurrence(orphaned as ScheduledTask)).toBe(
      true,
    );

    const owned = schedFixture({ status: 'active', next_run: null });
    await createScheduledTask(owned);
    await insertActiveRun(
      runFixture({
        group_folder: owned.group_folder,
        chat_jid: owned.chat_jid,
        isScheduledTask: 1,
        scheduled_task_id: owned.id,
      }),
    );
    const completed = schedFixture({ status: 'completed', next_run: null });
    const pausedClaim = schedFixture({ status: 'paused', next_run: null });
    await createScheduledTask(completed);
    await createScheduledTask(pausedClaim);

    const retryAt = new Date().toISOString();
    expect(
      (await releaseOrphanedScheduledTaskOccurrenceClaims(retryAt)).sort(),
    ).toEqual([orphaned.id, pausedClaim.id].sort());
    expect((await getTaskById(orphaned.id))?.next_run).toBe(retryAt);
    expect((await getTaskById(owned.id))?.next_run).toBeNull();
    expect((await getTaskById(completed.id))?.next_run).toBeNull();
    expect(await getTaskById(pausedClaim.id)).toMatchObject({
      status: 'paused',
      next_run: retryAt,
    });
  });
});

describe('updateScheduledTaskIfIdle marker-state guard', () => {
  test('refuses a status-only write on a completed null-next-run row', async () => {
    const completed = schedFixture({
      schedule_type: 'once',
      status: 'completed',
      next_run: null,
    });
    await createScheduledTask(completed);

    expect(
      await updateScheduledTaskIfIdle(completed.id, { status: 'active' }),
    ).toBe(false);
    expect(
      await updateScheduledTaskIfIdle(completed.id, { status: 'paused' }),
    ).toBe(false);
    expect(await getTaskById(completed.id)).toMatchObject({
      status: 'completed',
      next_run: null,
    });
    expect(await releaseOrphanedScheduledTaskOccurrenceClaims()).toEqual([]);

    const nextRun = new Date(Date.now() + 60_000).toISOString();
    expect(
      await updateScheduledTaskIfIdle(completed.id, {
        status: 'active',
        next_run: nextRun,
      }),
    ).toBe(true);
    expect(await getTaskById(completed.id)).toMatchObject({
      status: 'active',
      next_run: nextRun,
    });
  });
});

// ─── getDueTasks ──────────────────────────────────────────────────────────────

describe('getDueTasks', () => {
  test('excludes tasks with future next_run', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const fixture = schedFixture({ next_run: future, status: 'active' });
    await createScheduledTask(fixture);
    const due = await getDueTasks();
    expect(due.some((t) => t.id === fixture.id)).toBe(false);
  });

  test('excludes tasks with null next_run', async () => {
    const fixture = schedFixture({ next_run: null });
    await createScheduledTask(fixture);
    const due = await getDueTasks();
    expect(due.some((t) => t.id === fixture.id)).toBe(false);
  });

  test('excludes paused tasks', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const fixture = schedFixture({ next_run: past, status: 'paused' });
    await createScheduledTask(fixture);
    const due = await getDueTasks();
    expect(due.some((t) => t.id === fixture.id)).toBe(false);
  });

  test('excludes a due task while its current occurrence is running', async () => {
    const fixture = schedFixture({
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });
    await createScheduledTask(fixture);
    await insertActiveRun(
      runFixture({
        group_folder: fixture.group_folder,
        chat_jid: fixture.chat_jid,
        isScheduledTask: 1,
        scheduled_task_id: fixture.id,
      }),
    );

    expect((await getDueTasks()).some((task) => task.id === fixture.id)).toBe(
      false,
    );
  });

  test('excludes a due task after recovery completes its run but before advancing the schedule', async () => {
    const fixture = schedFixture({
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });
    await createScheduledTask(fixture);
    const run = runFixture({
      group_folder: fixture.group_folder,
      chat_jid: fixture.chat_jid,
      isScheduledTask: 1,
      scheduled_task_id: fixture.id,
    });
    await insertActiveRun(run);

    // Recovery currently completes the active run before it advances next_run.
    await completeActiveRun(run.id, 'completed');

    expect((await getDueTasks()).some((task) => task.id === fixture.id)).toBe(
      false,
    );
  });

  test('does not let a completed historical run block the next occurrence', async () => {
    const lastRun = new Date(Date.now() - 120_000);
    const fixture = schedFixture({
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    });
    await createScheduledTask(fixture);
    const run = runFixture({
      group_folder: fixture.group_folder,
      chat_jid: fixture.chat_jid,
      isScheduledTask: 1,
      scheduled_task_id: fixture.id,
      started_at: new Date(lastRun.getTime() - 60_000).toISOString(),
    });
    await insertActiveRun(run);
    await completeActiveRun(run.id, 'completed');
    await updateScheduledTaskAfterRun(
      fixture.id,
      fixture.next_run,
      'Previous occurrence completed',
    );

    const due = await getDueTasks();
    expect(due.some((task) => task.id === fixture.id)).toBe(true);
  });
});

// ─── updateScheduledTaskAfterRun ──────────────────────────────────────────────

describe('updateScheduledTaskAfterRun', () => {
  test('sets status to completed when next_run is null', async () => {
    const fixture = schedFixture({ status: 'active' });
    await createScheduledTask(fixture);
    await updateScheduledTaskAfterRun(fixture.id, null, 'Done');
    expect((await getTaskById(fixture.id))!.status).toBe('completed');
  });

  test('finalizes a claimed occurrence paused during the run and stays paused', async () => {
    const due = new Date(Date.now() - 1000).toISOString();
    const fixture = schedFixture({ status: 'active', next_run: due });
    await createScheduledTask(fixture);
    expect(await claimScheduledTaskOccurrence(fixture as ScheduledTask)).toBe(
      true,
    );
    await updateScheduledTask(fixture.id, { status: 'paused' });

    const nextRun = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      await updateScheduledTaskAfterRun(
        fixture.id,
        nextRun,
        'Done',
        fixture as ScheduledTask,
      ),
    ).toBe(true);
    const row = (await getTaskById(fixture.id))!;
    expect(row.status).toBe('paused');
    expect(row.next_run).toBe(nextRun);
    expect(row.last_run).not.toBeNull();
    expect(
      await updateScheduledTaskIfIdle(fixture.id, { status: 'active' }),
    ).toBeTruthy();
  });

  test('skips finalization of a claimed occurrence after a cadence edit', async () => {
    const due = new Date(Date.now() - 1000).toISOString();
    const fixture = schedFixture({ status: 'active', next_run: due });
    await createScheduledTask(fixture);
    expect(await claimScheduledTaskOccurrence(fixture as ScheduledTask)).toBe(
      true,
    );
    await updateScheduledTask(fixture.id, { schedule_value: '0 9 * * *' });

    expect(
      await updateScheduledTaskAfterRun(
        fixture.id,
        new Date(Date.now() + 86_400_000).toISOString(),
        'Done',
        fixture as ScheduledTask,
      ),
    ).toBe(false);
  });
});

// ─── logTaskRun / getTaskRunLogs ──────────────────────────────────────────────

describe('logTaskRun and getTaskRunLogs', () => {
  test('cleanup removes expired scheduler logs but preserves completed run history', async () => {
    const fixture = schedFixture({ status: 'completed', next_run: null });
    await createScheduledTask(fixture);
    const run = runFixture({
      group_folder: fixture.group_folder,
      chat_jid: fixture.chat_jid,
      isScheduledTask: 1,
      scheduled_task_id: fixture.id,
      started_at: new Date(Date.now() - 31 * 86_400_000).toISOString(),
      status: 'completed',
    });
    await insertActiveRun(run);
    await logTaskRun({
      task_id: fixture.id,
      run_id: run.id,
      run_at: new Date(Date.now() - 31 * 86_400_000).toISOString(),
      duration_ms: 1500,
      status: 'success',
      result: 'Historical result',
      error: null,
    });
    await updateScheduledTaskAfterRun(fixture.id, null, 'Historical result');
    const transcriptDir = path.join(
      getGroupDir(fixture.group_folder),
      'session-transcripts',
    );
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, `${run.id}.jsonl`);
    const promptPath = path.join(transcriptDir, `${run.id}.prompt.txt`);
    fs.writeFileSync(transcriptPath, 'historical output');
    fs.writeFileSync(promptPath, fixture.prompt);

    expect(await cleanupOldRecords()).toEqual({ taskRunLogs: 1 });
    expect(await getTaskRunLogs(fixture.id)).toEqual([]);
    expect(await getActiveRunById(run.id)).toBeDefined();

    await deleteScheduledTaskWithTranscripts(fixture.id, fixture.group_folder);
    expect(fs.existsSync(transcriptPath)).toBe(false);
    expect(fs.existsSync(promptPath)).toBe(false);
  });
});
