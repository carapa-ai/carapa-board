import { and, asc, eq } from 'drizzle-orm';
import { drizzleDbRef } from './drizzle-client.js';
import { taskStageComments } from './schema.js';

export interface TaskStageComment {
  task_id: string;
  stage_id: string;
  content: string;
  updated_at: string;
  run_id: string | null;
}

export async function getTaskStageComment(
  taskId: string,
  stageId: string,
): Promise<TaskStageComment | undefined> {
  const rows = await drizzleDbRef.current
    .select()
    .from(taskStageComments)
    .where(
      and(
        eq(taskStageComments.task_id, taskId),
        eq(taskStageComments.stage_id, stageId),
      ),
    )
    .limit(1);
  return rows[0] as TaskStageComment | undefined;
}

export async function getTaskStageComments(
  taskId: string,
): Promise<TaskStageComment[]> {
  return (await drizzleDbRef.current
    .select()
    .from(taskStageComments)
    .where(eq(taskStageComments.task_id, taskId))
    .orderBy(asc(taskStageComments.stage_id))) as TaskStageComment[];
}

export async function setTaskStageComment(
  taskId: string,
  stageId: string,
  content: string,
  runId: string | null,
): Promise<TaskStageComment> {
  const updatedAt = new Date().toISOString();
  const rows = await drizzleDbRef.current
    .insert(taskStageComments)
    .values({
      task_id: taskId,
      stage_id: stageId,
      content,
      updated_at: updatedAt,
      run_id: runId,
    })
    .onConflictDoUpdate({
      target: [taskStageComments.task_id, taskStageComments.stage_id],
      set: { content, updated_at: updatedAt, run_id: runId },
    })
    .returning();
  return rows[0] as TaskStageComment;
}

export async function clearTaskStageComment(
  taskId: string,
  stageId: string,
): Promise<void> {
  await drizzleDbRef.current
    .delete(taskStageComments)
    .where(
      and(
        eq(taskStageComments.task_id, taskId),
        eq(taskStageComments.stage_id, stageId),
      ),
    );
}
