import { and, asc, eq, gt, gte, isNotNull, lte, or, sql } from 'drizzle-orm';
import { activeRuns, taskBoardEvents } from '../../db/schema.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import type { ReplayTaskSnapshot, Task, TaskBoardEvent } from './types.js';

export const REPLAY_VISIBLE_FIELDS = [
  'project_id',
  'title',
  'description',
  'status',
  'priority',
  'runtimeSelection',
  'runtimeSelectionStage',
  'last_agent_name',
  'error',
  'cronjob_id',
  'dataset_task_id',
  'dataset_row_index',
  'depends_on_ids',
  'skip_stages',
  'objective_id',
  'archived',
  'custom_values',
  'branch_name',
  'author',
  'started_at',
  'completed_at',
] as const;

export function replayTaskSnapshot(task: Task): ReplayTaskSnapshot {
  return {
    id: task.id,
    project_id: task.project_id,
    title: task.title,
    description: task.description || '',
    status: task.status,
    priority: task.priority ?? 0,
    runtimeSelection: task.runtimeSelection ?? null,
    runtimeSelectionStage: task.runtimeSelectionStage ?? null,
    last_agent_name: task.last_agent_name,
    error: task.error,
    cronjob_id: task.cronjob_id,
    dataset_task_id: task.dataset_task_id,
    dataset_row_index: task.dataset_row_index,
    depends_on_ids: task.depends_on_ids,
    skip_stages: task.skip_stages ?? null,
    objective_id: task.objective_id ?? null,
    archived: !!task.archived,
    custom_values: task.custom_values,
    branch_name: task.branch_name ?? null,
    author: task.author,
    created_at: task.created_at,
    started_at: task.started_at,
    completed_at: task.completed_at ?? null,
  };
}

export function replaySnapshotChanged(before: Task, after: Task): boolean {
  return (
    JSON.stringify(replayTaskSnapshot(before)) !==
    JSON.stringify(replayTaskSnapshot(after))
  );
}

interface BoardReplayRun {
  id: string;
  task_id: string;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'error' | 'timeout' | 'stalled';
  stage: string | null;
  agent_name: string | null;
  model: string | null;
  model_name: string | null;
}

export interface BoardReplayData {
  initialTasks: ReplayTaskSnapshot[];
  events: TaskBoardEvent[];
  runs: BoardReplayRun[];
  reviewMilestones: BoardReplayReviewMilestone[];
  exactHistoryAvailableFrom: string | null;
  runHistoryAvailableFrom: string | null;
}

export interface BoardReplayReviewMilestone {
  task_id: string;
  occurred_at: string;
  score: number;
  rejection_count: number | null;
}

const COMPACT_REVIEW_VERDICT_PATTERN =
  /\*\*Review (approved|rejected|accepted with nits)[^*]*\*\*[^\n]*?\(score:\s*(\d+(?:\.\d+)?)\/10(?:,\s*rejection\s*(\d+))?\)/i;

export function reviewMilestonesFromMessages(
  taskId: string,
  messages: Array<{ content: string; created_at: string }>,
): BoardReplayReviewMilestone[] {
  const milestones: BoardReplayReviewMilestone[] = [];
  for (const message of messages) {
    const match = message.content.match(COMPACT_REVIEW_VERDICT_PATTERN);
    if (!match) continue;
    milestones.push({
      task_id: taskId,
      occurred_at: message.created_at,
      score: Number(match[2]),
      rejection_count:
        match[1].toLowerCase() === 'rejected' ? Number(match[3] ?? 1) : null,
    });
  }
  return milestones.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}

export async function getBoardReplay(
  projectId: string,
  from: string,
  to: string,
): Promise<BoardReplayData> {
  const [priorRows, eventRows, runRows, exactBoundary, runBoundary] =
    await Promise.all([
      drizzleDbRef.current.execute(sql`
      SELECT DISTINCT ON (task_id)
        id, project_id, task_id, event_type, occurred_at, snapshot
      FROM task_board_events
      WHERE project_id = ${projectId}
        AND (
          occurred_at <= ${from}
          OR (
            event_type = 'seed'
            AND snapshot->>'created_at' <= ${from}
          )
        )
      ORDER BY task_id, occurred_at DESC, id DESC
    `),
      drizzleDbRef.current
        .select()
        .from(taskBoardEvents)
        .where(
          and(
            eq(taskBoardEvents.project_id, projectId),
            gt(taskBoardEvents.occurred_at, from),
            lte(taskBoardEvents.occurred_at, to),
          ),
        )
        .orderBy(asc(taskBoardEvents.occurred_at), asc(taskBoardEvents.id)),
      drizzleDbRef.current
        .select({
          id: activeRuns.id,
          task_id: activeRuns.task_id,
          started_at: activeRuns.started_at,
          completed_at: activeRuns.completed_at,
          status: activeRuns.status,
          stage: activeRuns.stage,
          agent_name: activeRuns.agent_name,
          model: activeRuns.model,
          model_name: activeRuns.model_name,
        })
        .from(activeRuns)
        .where(
          and(
            eq(activeRuns.group_folder, projectId),
            isNotNull(activeRuns.task_id),
            lte(activeRuns.started_at, to),
            or(
              gte(activeRuns.completed_at, from),
              eq(activeRuns.status, 'running'),
              gte(activeRuns.started_at, from),
            ),
          ),
        )
        .orderBy(asc(activeRuns.started_at)),
      drizzleDbRef.current
        .select({
          value: sql<string | null>`min(${taskBoardEvents.occurred_at})`,
        })
        .from(taskBoardEvents)
        .where(eq(taskBoardEvents.project_id, projectId)),
      drizzleDbRef.current
        .select({ value: sql<string | null>`min(${activeRuns.started_at})` })
        .from(activeRuns)
        .where(
          and(
            eq(activeRuns.group_folder, projectId),
            isNotNull(activeRuns.task_id),
          ),
        ),
    ]);

  const rawPrior =
    (priorRows as unknown as { rows?: unknown[] }).rows ?? priorRows;
  const initialTasks = (rawPrior as any[])
    .filter((row) => row.event_type !== 'deleted')
    .map((row) => row.snapshot as ReplayTaskSnapshot);

  return {
    initialTasks,
    events: eventRows as TaskBoardEvent[],
    runs: runRows
      .filter((run): run is typeof run & { task_id: string } => !!run.task_id)
      .map((run) => ({
        ...run,
        task_id: run.task_id,
        status: run.status ?? 'error',
      })),
    reviewMilestones: [],
    exactHistoryAvailableFrom: exactBoundary[0]?.value ?? null,
    runHistoryAvailableFrom: runBoundary[0]?.value ?? null,
  };
}
