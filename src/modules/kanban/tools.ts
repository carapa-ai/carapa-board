import { z } from 'zod';
import { ToolDefinition } from '../tools/types.js';
import {
  getTask,
  findTasksByIdSuffix,
  getAllTasks,
  getTasksByProject,
  createTask,
  updateTask,
  clearTaskStageComment,
  getTaskStageComments,
  getActiveRunForTask,
  setTaskStageComment,
  getActiveRunById,
  getStageEntryEventByRunId,
  getConversation,
  getRunsForTask,
  getRunCountForTask,
  getTaskStageRunStats,
  validateSameProjectDependencies,
  assertDependenciesExist,
  hasCircularDependency,
} from '../../db.js';
import { hasPermission } from '../../mcp/auth.js';
import type { RegisteredGroup } from '../../types.js';
import { getObjective } from '../objectives/db-objectives.js';
import { getGroupByFolder } from '../../state-manager.js';
import {
  getGroupStages,
  findStage,
  isActiveStage,
  isFailedStage,
  isQuestionStage,
  isFallbackQuestionMove,
  isReviewStage,
  isTestingStage,
  getInitialStage,
  getDeployStageId,
  addedGatedSkipStages,
  gatedSkipStagesDenial,
  validateAbVariants,
  abVariantsCreationStageError,
  validateCoStages,
  validateStageVariant,
} from './stages.js';
import {
  appendTaskStagePrompt,
  beginTaskSteeringAdmission,
  drainProjectQueue,
  endTaskSteeringAdmission,
  getTaskExecutionStartingStage,
  getTaskQueueHoldReason,
  queueDeploy,
  requestDurableTaskStageHandoff,
  isTaskExecutionClaimed,
  isTaskRunning,
  stopTask,
  withStageVariantWriteLock,
} from './task-executor.js';
import { broadcast } from '../objectives/ws-events.js';
import {
  loadTaskExecutionMarkers,
  presentTaskExecution,
} from './task-phase.js';
import { readTaskMessages } from '../transcripts/transcript-store.js';
import type { TaskMessage } from './types.js';
import type { ActiveRun } from './execution/types.js';
import { logger } from '../../logger.js';
import { normalizeTaskId } from '../tools/utils.js';
import { removeWorktreeForTask } from '../../lib/git-ops.js';
import { publishTaskEventAndNotify } from './task/objective-event-holds.js';
import { notifyEntityLifecycle } from '../tools/push-tools.js';
import { mayContainDecisionKey, parseReviewDecision } from './review.js';
import {
  DEPLOY_HANDOFF_VALUE_KEYS,
  pipelineOwnedValuesDenial,
} from './pipeline-owned-values.js';
import { MERGE_APPROVAL_REQUIRED_PREFIX } from './task/merge-risk-gate.js';
import { warnOnUncontainedDependencies } from './task/dependency-warning.js';
import { agentReviewEntryDenial } from './task/testing.js';

/**
 * Build the "task not found" error. Lists tasks sharing the ID's random suffix
 * (agents often get the timestamp wrong) that the caller may read. This is a
 * hint only: callers must never act on a candidate.
 */
async function taskNotFoundError(
  taskId: string,
  permissions: Parameters<typeof hasPermission>[0],
): Promise<Error> {
  const suffix = typeof taskId === 'string' ? taskId.split('-').pop() : '';
  const candidates = (await findTasksByIdSuffix(suffix ?? '')).filter(
    (candidate) =>
      hasPermission(permissions, candidate.project_id, 'tasks:read'),
  );
  if (candidates.length === 0) return new Error('Task not found');
  const hints = candidates
    .map((c) => `${c.id} (${c.project_id}, "${c.title}")`)
    .join(', ');
  return new Error(`Task not found: ${taskId}. Did you mean: ${hints}?`);
}

export const listTasksTool: ToolDefinition = {
  name: 'list_tasks',
  description:
    'List kanban task cards on a project board. Each entry has the execution `phase` (running, preparing, queued, waiting, stalled or idle).',
  inputSchema: {
    project_id: z
      .string()
      .optional()
      .describe('Project folder name (defaults to current context)'),
    stage: z
      .string()
      .optional()
      .describe(
        'Filter by kanban stage ID (e.g. backlog, in_progress, completed)',
      ),
    limit: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(50)
      .describe('Maximum number of tasks to return (default 50)'),
    include_archived: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include archived tasks (default false)'),
  },
  requiredPermissions: ['tasks:read'],
  handler: async (
    { project_id, stage, limit, include_archived },
    deps,
    context,
  ) => {
    const { group_folder, permissions } = context;
    const targetProject = project_id || group_folder;
    if (!hasPermission(permissions, targetProject, 'tasks:read')) {
      throw new Error(
        `Unauthorized: missing tasks:read permission for project "${targetProject}"`,
      );
    }
    let tasks: Awaited<ReturnType<typeof getAllTasks>>;
    if (!project_id && hasPermission(permissions, '*', '*:*')) {
      tasks = await getAllTasks();
    } else if (!project_id && getGroupByFolder(group_folder)?.is_main) {
      // A per-user main has no '*' grant: aggregate every project in its
      // explicit permission map that it may read.
      const folders = Object.keys(permissions ?? {}).filter(
        (f) => f !== '*' && hasPermission(permissions, f, 'tasks:read'),
      );
      tasks = (
        await Promise.all(folders.map((f) => getTasksByProject(f)))
      ).flat();
    } else {
      tasks = await getTasksByProject(targetProject);
    }

    // Filter by stage if provided
    if (stage) tasks = tasks.filter((t) => t.status === stage);
    // By default, exclude archived tasks. Pass include_archived=true to see them
    // (e.g. when restoring via restore_task).
    if (!include_archived) tasks = tasks.filter((t) => !t.archived);

    // Intelligent sorting: prioritize active/queue tasks over done tasks
    // Each task sorts by its own project's stages: a cross-project listing
    // would otherwise weigh custom stage ids against the caller's stages.
    const stagesByProject = new Map<
      string,
      ReturnType<typeof getGroupStages>
    >();
    const stagesFor = (projectId: string) => {
      let projectStages = stagesByProject.get(projectId);
      if (!projectStages) {
        projectStages = getGroupStages(getGroupByFolder(projectId));
        stagesByProject.set(projectId, projectStages);
      }
      return projectStages;
    };
    const typeWeights: Record<string, number> = {
      active: 0,
      testing: 1,
      queue: 2,
      review: 3,
      done: 4,
    };

    tasks.sort((a, b) => {
      const sA = findStage(stagesFor(a.project_id), a.status);
      const sB = findStage(stagesFor(b.project_id), b.status);
      const wA = sA ? (typeWeights[sA.type] ?? 99) : 99;
      const wB = sB ? (typeWeights[sB.type] ?? 99) : 99;
      if (wA !== wB) return wA - wB;
      // Done-type stages: newest completion first, so recent completions are
      // not hidden behind old tasks that were appended with lower priorities.
      if (wA === typeWeights.done) {
        const tA = a.completed_at ?? a.created_at;
        const tB = b.completed_at ?? b.created_at;
        return tB.localeCompare(tA);
      }
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.created_at.localeCompare(a.created_at);
    });

    // Apply limit and map to identify-only fields
    // Keep an explicit limit of zero meaningful; using `limit || 50` would
    // silently turn it into the default page size.
    const limited = tasks.slice(0, limit === undefined ? 50 : limit);
    const markers = await loadTaskExecutionMarkers([
      ...new Set(limited.map((t) => t.project_id)),
    ]);
    return JSON.stringify(
      limited.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        phase: presentTaskExecution(t, markers).phase,
      })),
      null,
      2,
    );
  },
};

export const getTaskTool: ToolDefinition = {
  name: 'get_task',
  description:
    'Get a kanban task, its `persistentStageComments`, latest blocking and rejected-review context, all failed/blocked Testing verdicts (compact), and results from its three newest execution runs, plus `runStats` (per-stage/per-model run counts, priced-run count, cost and tokens over all runs; `costUsd` is null when no run in the group was priced), and the execution `phase` (running, preparing, queued, waiting, stalled or idle). Use `get_transcript` only when content is truncated or missing, or detailed tool-call history is required.',
  inputSchema: {
    task_id: z.string().describe('Full task ID (e.g. task-177...-abc)'),
  },
  requiredPermissions: ['tasks:read'],
  handler: async ({ task_id: raw_id }, deps, context) => {
    const task_id = normalizeTaskId(raw_id);
    const { permissions } = context;
    const task = await getTask(task_id);
    if (!task) throw await taskNotFoundError(task_id, permissions);
    if (!hasPermission(permissions, task.project_id, 'tasks:read')) {
      throw new Error(
        `Unauthorized: missing tasks:read permission for project "${task.project_id}"`,
      );
    }
    const [messages, runs, totalRunCount, stageRunStats, stageComments] =
      await Promise.all([
        Promise.resolve(readTaskMessages(task.project_id, task.id)),
        getRunsForTask(task.id, 3),
        getRunCountForTask(task.id),
        getTaskStageRunStats(task.id),
        getTaskStageComments(task.id),
      ]);
    const { phase } = presentTaskExecution(
      task,
      await loadTaskExecutionMarkers([task.project_id]),
    );
    const runStats = stageRunStats.sort(
      (a, b) =>
        (a.stage ?? '').localeCompare(b.stage ?? '') ||
        (a.model ?? '').localeCompare(b.model ?? ''),
    );
    const stages = getGroupStages(getGroupByFolder(task.project_id));
    // The message scans are linear in the transcript: run each once per call.
    const runResults = resultsByRun(messages);
    const testingFailures = collectTestingFailures(messages);
    const blockingCandidates = testingBlockingCandidates(messages);
    const rejectionCandidates = reviewRejectionCandidates(messages);
    const recentRuns = enrichRecentRuns(runs, messages, runResults);
    const blockingContext = isQuestionStage(stages, task.status)
      ? findBlockingContext(messages, recentRuns)
      : null;
    const historyCandidateRunIds = [
      ...new Set(
        [...blockingCandidates, ...rejectionCandidates]
          .map((candidate) => candidate.runId)
          .filter((runId): runId is string => runId !== null),
      ),
    ];
    const historyCandidateRuns = await Promise.all(
      historyCandidateRunIds.map(
        async (runId) =>
          runs.find((run) => run.id === runId) ??
          (await getActiveRunById(runId)),
      ),
    );
    const taskHistoryRuns = historyCandidateRuns.filter(
      (run): run is ActiveRun => run?.task_id === task.id,
    );
    const testingRunIds = new Set(
      taskHistoryRuns
        .filter((run) => isTestingStage(stages, run.stage ?? ''))
        .map((run) => run.id),
    );
    const blockingRunIds = new Set(
      blockingCandidates
        .map((candidate) => candidate.runId)
        .filter((runId): runId is string => runId !== null),
    );
    const latestBlockingReason = findLatestBlockingReason(
      messages,
      recentRuns,
      isQuestionStage(stages, task.status),
      testingRunIds,
      enrichRecentRuns(
        taskHistoryRuns.filter(
          (run) =>
            blockingRunIds.has(run.id) &&
            !runs.some((recentRun) => recentRun.id === run.id),
        ),
        messages,
        runResults,
      ),
      blockingCandidates,
    );
    const reviewRunIds = new Set(
      taskHistoryRuns
        .filter((run) => isReviewStage(stages, run.stage ?? ''))
        .map((run) => run.id),
    );
    const reviewRejection = findLatestReviewRejection(
      messages,
      reviewRunIds,
      rejectionCandidates,
    );
    const rejectionRun = reviewRejection?.runId
      ? taskHistoryRuns.find((run) => run.id === reviewRejection.runId)
      : undefined;
    const latestReviewRejection = reviewRejection
      ? {
          ...reviewRejection,
          stage: rejectionRun?.task_id === task.id ? rejectionRun.stage : null,
        }
      : null;
    return JSON.stringify(
      {
        ...task,
        persistentStageComments: stageComments.map(
          ({ stage_id, content, updated_at, run_id }) => ({
            stage_id,
            content,
            updated_at,
            run_id,
          }),
        ),
        blockingContext,
        latestBlockingReason,
        testingFailures: findTestingFailures(messages, testingFailures),
        latestReviewRejection,
        recentRuns,
        totalRunCount,
        runStats,
        queueHoldReason: await getTaskQueueHoldReason(task),
        phase,
        mergePending: findMergePending(task, messages, runs),
      },
      null,
      2,
    );
  },
};

export const REVIEW_APPROVED_MERGE_PENDING_PREFIX =
  '**Review approved, merge pending**'; // task/review.ts

const MERGE_PENDING_NOTICE_PREFIXES = [
  REVIEW_APPROVED_MERGE_PENDING_PREFIX,
  '**Task checkpoint pending**', // task/deploy.ts mergeBranchForDeploy
];
const MAX_MERGE_PENDING_REASON_CHARS = 800;

/**
 * The reason a card was parked after an environment merge failure: either the
 * review-approved merge park (task/review.ts) or the completion/deploy
 * checkpoint park (task/deploy.ts `mergeBranchForDeploy`). Only reported while
 * the merge is still outstanding: no merge commit and no run started after the
 * notice.
 */
export function findMergePending(
  task: { merge_commit?: string | null },
  messages: TaskMessage[],
  runs: ActiveRun[],
): { at: string; reason: string } | null {
  if (task.merge_commit) return null;
  let noticeIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.entry_type !== 'system_notice') continue;
    // A later approval-required park supersedes an earlier merge-pending one:
    // the card waits for a person, so no retry may pick it up.
    if (message.content.startsWith(MERGE_APPROVAL_REQUIRED_PREFIX)) return null;
    if (
      MERGE_PENDING_NOTICE_PREFIXES.some((prefix) =>
        message.content.startsWith(prefix),
      )
    ) {
      noticeIndex = i;
      break;
    }
  }
  if (noticeIndex < 0) return null;
  const notice = messages[noticeIndex];
  const runStartedLater =
    messages.slice(noticeIndex + 1).some((m) => m.entry_type === 'run_start') ||
    runs.some((run) => run.started_at > notice.created_at);
  if (runStartedLater) return null;
  return {
    at: notice.created_at,
    reason: notice.content.slice(0, MAX_MERGE_PENDING_REASON_CHARS),
  };
}

const MAX_RUN_RESULT_CHARS = 4_000;

type VisibleRunResult = { content: string; truncated: boolean };

function boundedResult(content: string): VisibleRunResult {
  return {
    content: content.slice(0, MAX_RUN_RESULT_CHARS),
    truncated: content.length > MAX_RUN_RESULT_CHARS,
  };
}

function visibleResult(messages: TaskMessage[]): VisibleRunResult | null {
  const assistant = messages
    .filter(
      (message) =>
        message.role === 'assistant' && message.content.trim().length > 0,
    )
    .at(-1);
  if (assistant) return boundedResult(assistant.content);

  const system = messages
    .filter((message) => {
      if (message.role !== 'system' || !message.content.trim()) return false;
      // Deploy logs are build output, not the run's verdict.
      if (message.agent_name === 'deploy') return false;
      if (
        message.entry_type === 'run_start' ||
        message.entry_type === 'stage_prompt_delivery' ||
        message.entry_type === 'stage_prompt'
      ) {
        return false;
      }
      return (
        message.entry_type === 'review_feedback' ||
        message.entry_type === 'testing_feedback' ||
        /\b(error|failed|failure|timed? out|timeout|stalled)\b/i.test(
          message.content,
        )
      );
    })
    .at(-1);
  return system ? boundedResult(system.content) : null;
}

export function resultsByRun(
  messages: TaskMessage[],
): Map<string, VisibleRunResult | null> {
  const results = new Map<string, VisibleRunResult | null>();
  let runId: string | null = null;
  let segment: TaskMessage[] = [];
  const finish = () => {
    if (runId) results.set(runId, visibleResult(segment));
  };
  for (const message of messages) {
    if (message.entry_type === 'run_start') {
      finish();
      runId = message.run_id ?? null;
      segment = [];
    } else if (runId) {
      segment.push(message);
    }
  }
  finish();
  return results;
}

export function enrichRecentRuns(
  runs: ActiveRun[],
  messages: TaskMessage[],
  results: Map<string, VisibleRunResult | null> = resultsByRun(messages),
) {
  return runs.map((run) => ({
    runId: run.id,
    stage: run.stage,
    status: run.status,
    startedAt: run.started_at,
    completedAt: run.completed_at ?? null,
    lastEventAt: run.last_event_at ?? null,
    agentName: run.agent_name,
    model: run.model,
    modelName: run.model_name,
    testingDecision: run.testingDecision ?? null,
    result: results.get(run.id) ?? null,
  }));
}

export function findBlockingContext(
  messages: TaskMessage[],
  recentRuns: ReturnType<typeof enrichRecentRuns>,
) {
  const prompt = findLatestUndeliveredStagePrompt(messages);
  if (prompt) {
    return {
      source: 'stagePrompt',
      content: prompt.content,
      targetStage: prompt.target_stage ?? null,
      promptId: prompt.id,
      createdAt: prompt.created_at,
    };
  }
  const latest = recentRuns.find((run) => run.result !== null);
  return latest
    ? {
        source: 'latestRunResult',
        content: latest.result!.content,
        targetStage: latest.stage,
        promptId: null,
        createdAt: latest.completedAt ?? latest.startedAt,
        truncated: latest.result!.truncated,
      }
    : null;
}

function findLatestUndeliveredStagePrompt(messages: TaskMessage[]) {
  const delivered = new Set(
    messages
      .filter(
        (message) =>
          (message.entry_type === 'stage_prompt_delivery' ||
            message.entry_type === 'steering_delivery') &&
          message.prompt_id,
      )
      .map((message) => message.prompt_id!),
  );
  const prompt = messages
    .filter(
      (message) =>
        message.entry_type === 'stage_prompt' &&
        !delivered.has(message.id) &&
        message.content.trim().length > 0,
    )
    .at(-1);
  return prompt;
}

export function findLatestBlockingReason(
  messages: TaskMessage[],
  recentRuns: ReturnType<typeof enrichRecentRuns>,
  isCurrentlyQuestion = false,
  testingRunIds: ReadonlySet<string> = new Set(),
  historicalBlockingRuns: ReturnType<typeof enrichRecentRuns> = [],
  candidates: TestingBlockingCandidate[] = testingBlockingCandidates(messages),
) {
  const prompt = findLatestUndeliveredStagePrompt(messages);
  if (prompt) {
    return {
      source: 'stagePrompt',
      ...boundedResult(prompt.content),
      targetStage: prompt.target_stage ?? null,
      promptId: prompt.id,
      runId: prompt.run_id ?? null,
      createdAt: prompt.created_at,
    };
  }

  const blocked = [...candidates]
    .reverse()
    .find(
      (candidate) =>
        candidate.isPersistedFeedback ||
        (candidate.runId !== null && testingRunIds.has(candidate.runId)),
    );
  if (blocked) {
    const run = blocked.runId
      ? [...recentRuns, ...historicalBlockingRuns].find(
          (candidate) => candidate.runId === blocked.runId,
        )
      : undefined;
    if (run?.result) {
      return {
        source: 'latestRunResult',
        content: run.result.content,
        truncated: run.result.truncated,
        targetStage: run.stage,
        promptId: null,
        runId: run.runId,
        createdAt: run.completedAt ?? run.startedAt,
      };
    }
    return {
      source: 'testingFeedback',
      content: blocked.content,
      truncated: blocked.truncated,
      targetStage: run?.stage ?? null,
      promptId: null,
      runId: blocked.runId,
      createdAt: blocked.createdAt,
    };
  }
  if (!isCurrentlyQuestion) return null;

  const latest = recentRuns.find((run) => run.result !== null);
  return latest
    ? {
        source: 'latestRunResult',
        content: latest.result!.content,
        truncated: latest.result!.truncated,
        targetStage: latest.stage,
        promptId: null,
        runId: latest.runId,
        createdAt: latest.completedAt ?? latest.startedAt,
      }
    : null;
}

const TESTING_BLOCKED_PATTERN = /^[\t ]*\*\*Testing blocked\*\*[\t ]*$/im;
const TESTING_RETRY_LIMIT_PATTERN =
  /^[\t ]*\*\*Automatic retry limit reached\*\*/im;

type TestingBlockingCandidate = VisibleRunResult & {
  createdAt: string;
  runId: string | null;
  isPersistedFeedback: boolean;
};

function testingBlockingCandidates(
  messages: TaskMessage[],
): TestingBlockingCandidate[] {
  let runId: string | null = null;
  const candidates: TestingBlockingCandidate[] = [];

  for (const message of messages) {
    if (message.entry_type === 'run_start') {
      runId = message.run_id ?? null;
      continue;
    }
    if (
      message.role === 'user' ||
      !message.content.trim() ||
      (!TESTING_BLOCKED_PATTERN.test(message.content) &&
        !TESTING_RETRY_LIMIT_PATTERN.test(message.content))
    ) {
      continue;
    }
    candidates.push({
      ...boundedResult(message.content),
      createdAt: message.created_at,
      runId: message.run_id ?? runId,
      isPersistedFeedback: message.entry_type === 'testing_feedback',
    });
  }
  return candidates;
}

const TESTING_FEEDBACK_VERDICT_PATTERN =
  /^[\t ]*\*\*Testing (failed|blocked)\*\*[\t ]*$/im;
const MAX_TESTING_FAILURES = 10;
const MAX_TESTING_FAILURE_EXCERPT_CHARS = 300;

export type TestingFailure = {
  runId: string | null;
  decision: 'fail' | 'blocked';
  createdAt: string;
  excerpt: string;
  truncated: boolean;
};

/**
 * Compact list of every failed/blocked Testing verdict in the task history,
 * independent of the three-run window. One entry per run (a persisted
 * `testing_feedback` message wins over other matches in the same run).
 */
export function findTestingFailures(
  messages: TaskMessage[],
  failures: TestingFailure[] = collectTestingFailures(messages),
): {
  total: number;
  items: TestingFailure[];
} {
  return {
    total: failures.length,
    items: failures.slice(-MAX_TESTING_FAILURES),
  };
}

function collectTestingFailures(messages: TaskMessage[]): TestingFailure[] {
  let runId: string | null = null;
  const entries: Array<{ failure: TestingFailure; isFeedback: boolean }> = [];
  const indexByRun = new Map<string, number>();

  for (const message of messages) {
    if (message.entry_type === 'run_start') {
      runId = message.run_id ?? null;
      continue;
    }
    const isFeedback =
      message.entry_type === 'testing_feedback' &&
      TESTING_FEEDBACK_VERDICT_PATTERN.test(message.content);
    if (
      !isFeedback &&
      (message.role === 'user' ||
        (!TESTING_BLOCKED_PATTERN.test(message.content) &&
          !TESTING_RETRY_LIMIT_PATTERN.test(message.content)))
    ) {
      continue;
    }
    const collapsed = message.content.replace(/\s+/g, ' ').trim();
    const failure: TestingFailure = {
      runId: message.run_id ?? runId,
      decision: /^[\t ]*\*\*Testing failed\*\*/im.test(message.content)
        ? 'fail'
        : 'blocked',
      createdAt: message.created_at,
      excerpt: collapsed.slice(0, MAX_TESTING_FAILURE_EXCERPT_CHARS),
      truncated: collapsed.length > MAX_TESTING_FAILURE_EXCERPT_CHARS,
    };
    const existing =
      failure.runId === null ? undefined : indexByRun.get(failure.runId);
    if (existing === undefined) {
      if (failure.runId !== null) indexByRun.set(failure.runId, entries.length);
      entries.push({ failure, isFeedback });
    } else if (isFeedback && !entries[existing].isFeedback) {
      entries[existing] = { failure, isFeedback };
    }
  }
  return entries.map((entry) => entry.failure);
}

const COMPACT_REVIEW_REJECTION_PATTERN =
  /^[\t ]*\*\*Review rejected\*\*[\t ]*\([\t ]*score:[\t ]*(?:10(?:\.0+)?|[1-9](?:\.\d+)?)\/10(?:,[\t ]*rejection[\t ]+\d+)?[\t ]*\)[\t ]*$/im;

type ReviewRejectionCandidate = VisibleRunResult & {
  source: 'reviewFeedback' | 'reviewDecision';
  createdAt: string;
  runId: string | null;
  isPersistedFeedback: boolean;
  isCanonicalSystemFeedback: boolean;
};

function reviewRejectionCandidates(
  messages: TaskMessage[],
): ReviewRejectionCandidate[] {
  let runId: string | null = null;
  const candidates: ReviewRejectionCandidate[] = [];

  for (const message of messages) {
    if (message.entry_type === 'run_start') {
      runId = message.run_id ?? null;
      continue;
    }
    if (!message.content.trim()) continue;

    const compactMatch = message.content.match(
      COMPACT_REVIEW_REJECTION_PATTERN,
    );
    const compactFormat = message.role !== 'user' && compactMatch !== null;
    const legacyFormat =
      !compactFormat &&
      (message.role === 'assistant' || message.entry_type === 'run_result') &&
      // A valid decision always carries a "decision" key; skip the JSON scan.
      mayContainDecisionKey(message.content) &&
      parseReviewDecision(message.content)?.decision === 'reject';
    if (!compactFormat && !legacyFormat) continue;

    candidates.push({
      source: compactFormat ? 'reviewFeedback' : 'reviewDecision',
      ...boundedResult(message.content),
      createdAt: message.created_at,
      runId: message.run_id ?? runId,
      isPersistedFeedback: message.entry_type === 'review_feedback',
      isCanonicalSystemFeedback:
        compactFormat &&
        message.role === 'system' &&
        message.content.slice(0, compactMatch.index).trim().length === 0,
    });
  }
  return candidates;
}

export function findLatestReviewRejection(
  messages: TaskMessage[],
  reviewRunIds: ReadonlySet<string> = new Set(),
  candidates: ReviewRejectionCandidate[] = reviewRejectionCandidates(messages),
) {
  const candidate = [...candidates]
    .reverse()
    .find(
      (entry) =>
        entry.isPersistedFeedback ||
        entry.isCanonicalSystemFeedback ||
        (entry.runId !== null && reviewRunIds.has(entry.runId)),
    );
  if (!candidate) return null;
  return {
    source: candidate.source,
    content: candidate.content,
    truncated: candidate.truncated,
    createdAt: candidate.createdAt,
    runId: candidate.runId,
  };
}

/**
 * Task events are forwarded to the objective owner's brain, so tagging a task
 * with another project's objective requires write access to that project.
 */
async function assertObjectiveTaggable(
  permissions: Parameters<typeof hasPermission>[0],
  taskProjectId: string,
  objectiveId: string | null | undefined,
): Promise<void> {
  if (objectiveId === undefined || objectiveId === null) return;
  const objective = await getObjective(objectiveId);
  if (!objective) {
    throw new Error(`Unknown objective "${objectiveId}"`);
  }
  if (
    objective.project_id !== taskProjectId &&
    !hasPermission(permissions, objective.project_id, 'tasks:write')
  ) {
    throw new Error(
      `Unauthorized: missing tasks:write permission for objective project "${objective.project_id}"`,
    );
  }
}

/**
 * Validate an agent-supplied stage variant against the project's configured
 * suffixes. Unset, '' and 'a' all mean the base stages, stored as null.
 */
function resolveRequestedStageVariant(
  group: RegisteredGroup | undefined,
  requested: string | null | undefined,
): string | null {
  const result = validateStageVariant(group, requested);
  if (!result.valid) throw new Error(result.error);
  return result.variant;
}

/** Validate agent-supplied `co_stages`; throws the validation error message. */
function resolveRequestedCoStages(
  group: RegisteredGroup | undefined,
  requested: string[] | null | undefined,
): string[] | null {
  const result = validateCoStages(group, requested);
  if (!result.valid) throw new Error(result.error);
  return result.coStages;
}

const CO_STAGES_SCHEMA = z
  .array(z.string())
  .nullable()
  .optional()
  .describe(
    'Extra stage alternatives that also run for this card, in order, e.g. ["review.o"] has the review.o runtime judge the same implementation after the review stage\'s own runtime (all must approve). Each entry must be an existing alternative of a review or testing stage. null/[] clears it. Only settable while the task is not running; a chain already in progress finishes with the list it started with.',
  );

const STAGE_VARIANT_SCHEMA = z
  .string()
  .nullable()
  .optional()
  .describe(
    'Stage alternative suffix this card runs as (e.g. "b" runs the coding.b and testing.b stages where configured). null clears it to the base stages. Only settable while the task is in a queue stage.',
  );

const AB_VARIANTS_SCHEMA = z
  .array(z.string())
  .optional()
  .describe(
    'A/B experiment variant list (e.g. ["A", "B"]): at least 2 distinct variants including at least one non-A. The card forks into one child per variant at the first active (coding) stage that has an alternative for a selected variant, so every non-A variant needs a coding-stage alternative (e.g. coding.b). Use co_stages for review/testing alternatives. Only settable while the task is in a queue stage and before it has forked (create_task also allows creating directly in the fork stage itself); requires worktree checkout mode and a configured repository. A human picks the winner in the UI.',
  );

export const createTaskTool: ToolDefinition = {
  name: 'create_task',
  description: 'Create a new kanban task card.',
  inputSchema: {
    target_project: z
      .string()
      .optional()
      .describe('Target project ID (optional)'),
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Task description'),
    status: z.string().optional().describe('Stage ID (optional)'),
    priority: z
      .number()
      .optional()
      .describe('Numeric priority (lower = higher priority; omit to append)'),
    objective_id: z
      .string()
      .optional()
      .describe(
        'Objective ID to tag this task with — CarapaBrain uses this to route task events to the matching objective',
      ),
    depends_on_ids: z
      .array(z.string())
      .optional()
      .describe(
        'IDs of existing tasks in the target project that must finish before this task starts. Set atomically with creation, so the card is never claimable before its prerequisites are recorded.',
      ),
    stage_variant: STAGE_VARIANT_SCHEMA,
    co_stages: CO_STAGES_SCHEMA,
    ab_variants: AB_VARIANTS_SCHEMA,
  },
  requiredPermissions: ['tasks:write'],
  authorizesTargetProject: true,
  handler: async (args, deps, context) => {
    const {
      target_project,
      title,
      description,
      status,
      priority,
      objective_id,
      stage_variant,
      co_stages,
      ab_variants,
    } = args;
    const dependsOnIds: string[] = [
      ...new Set<string>((args.depends_on_ids ?? []).map(normalizeTaskId)),
    ];
    const { group_folder, permissions } = context;
    const targetProject = target_project || group_folder;
    if (!hasPermission(permissions, targetProject, 'tasks:write')) {
      throw new Error(
        `Unauthorized: missing tasks:write permission for project "${targetProject}"`,
      );
    }
    const group = getGroupByFolder(targetProject);
    if (!group) throw new Error(`Project "${targetProject}" not found`);
    await assertObjectiveTaggable(permissions, targetProject, objective_id);
    // Reject task creation when kanban mode is disabled (e.g. parent/coordinator
    // projects) — tasks should be created in a child project instead.
    const enabledModes = group.settings?.enabledModes ?? ['kanban', 'chat'];
    if (!enabledModes.includes('kanban')) {
      throw new Error(
        `Kanban mode is disabled for project "${targetProject}". Create tasks in a child project instead.`,
      );
    }

    const stages = getGroupStages(group);
    const initialStatus = status || getInitialStage(stages)?.id;
    if (!initialStatus) throw new Error('No valid stage found');
    const initialStage = findStage(
      stages.filter((s) => !s.inactive),
      initialStatus,
    );
    if (!initialStage) {
      throw new Error(`Invalid stage "${initialStatus}"`);
    }
    if (initialStage.type === 'done') {
      throw new Error(
        `Agents cannot create tasks directly in done stage "${initialStatus}"; create it in an active or queue stage.`,
      );
    }
    const stageVariant = resolveRequestedStageVariant(group, stage_variant);
    if (stageVariant && initialStage.type !== 'queue') {
      throw new Error(
        `stage_variant can only be set in a queue stage; "${initialStatus}" is ${initialStage.type}.`,
      );
    }
    const coStages = resolveRequestedCoStages(group, co_stages);
    let abVariants: string[] | null | undefined;
    if (ab_variants !== undefined) {
      const abRes = validateAbVariants(group, ab_variants);
      if (!abRes.valid) throw new Error(abRes.error);
      const abStageError = abVariantsCreationStageError(
        group,
        abRes.variants,
        initialStatus,
      );
      if (abStageError) throw new Error(abStageError);
      abVariants = abRes.variants;
    }

    if (dependsOnIds.length > 0) {
      await assertDependenciesExist(dependsOnIds);
      await validateSameProjectDependencies(
        'new task',
        targetProject,
        dependsOnIds,
      );
      if (
        await hasCircularDependency(
          targetProject,
          `__temp_${Date.now()}`,
          dependsOnIds,
        )
      ) {
        throw new Error('Circular dependency detected');
      }
    }

    const sourceRun = context.run_id
      ? await getActiveRunById(context.run_id)
      : undefined;
    const sourceTask = context.task_id
      ? await getTask(context.task_id)
      : undefined;
    const sourceConversation = context.conversation_id
      ? await getConversation(context.conversation_id)
      : undefined;
    const inheritedTriggerer = sourceRun?.triggeredByUserId ?? null;
    const ownerUserId =
      inheritedTriggerer ??
      sourceTask?.ownerUserId ??
      sourceConversation?.ownerUserId ??
      group.user_id ??
      null;

    const task = await createTask({
      project_id: targetProject,
      title,
      description: description || '',
      status: initialStatus,
      priority,
      author: 'agent',
      objective_id: objective_id ?? null,
      depends_on_ids: dependsOnIds,
      stageVariant,
      coStages,
      ab_variants: abVariants,
      ownerUserId,
      lastTriggeredByUserId: inheritedTriggerer,
      lastTriggerSource: 'agent',
      lastTriggeredAt: new Date().toISOString(),
      sourceConversationId: context.conversation_id ?? null,
      sourceRunId: sourceRun?.id ?? context.run_id ?? null,
    });
    broadcast({ type: 'task_created', payload: task });
    if (isActiveStage(stages, initialStatus)) {
      drainProjectQueue(targetProject, group);
    }
    return JSON.stringify({
      id: task.id,
      title: task.title,
      status: task.status,
      depends_on_ids: task.depends_on_ids ?? [],
    });
  },
};

let taskQueueDrainRunner: typeof drainProjectQueue = drainProjectQueue;

export function _testOnlySetTaskQueueDrainRunner(
  runner: typeof drainProjectQueue | null,
): void {
  taskQueueDrainRunner = runner ?? drainProjectQueue;
}

export const updateTaskTool: ToolDefinition = {
  name: 'update_task',
  description:
    'Update a kanban task (stage, title, description, etc). Agents cannot complete tasks: they may move a task into a done stage only from another done stage (e.g. completed -> deploy stage, which starts the deploy).',
  inputSchema: {
    task_id: z.string().describe('Full task ID (e.g. task-177...-abc)'),
    status: z.string().optional().describe('New kanban stage ID'),
    title: z.string().optional().describe('New task title'),
    description: z.string().optional().describe('New task description'),
    priority: z
      .number()
      .optional()
      .describe('New numeric priority (lower = higher priority)'),
    depends_on_ids: z
      .array(z.string())
      .optional()
      .describe(
        'IDs of tasks this task depends on. Adding a dependency to a task that already has a branch requires Start over after the dependency finishes.',
      ),
    skip_stages: z
      .array(z.string())
      .nullable()
      .optional()
      .describe(
        'Stage IDs to skip during auto-advance. null/[] clears the list. Only affects auto-advance; manual stage moves are not blocked.',
      ),
    execute_in_stage: z
      .string()
      .nullable()
      .optional()
      .describe('Specific pipeline stage for execution'),
    objective_id: z
      .string()
      .nullable()
      .optional()
      .describe('Objective ID to tag this task with (set to null to clear)'),
    stage_variant: STAGE_VARIANT_SCHEMA,
    co_stages: CO_STAGES_SCHEMA,
    ab_variants: AB_VARIANTS_SCHEMA,
  },
  requiredPermissions: ['tasks:write'],
  authorizesTargetProject: true,
  handler: async (args, deps, context) => {
    const { task_id: raw_id, status, ...rest } = args;
    let automaticStageEntryTaskId: string | undefined;
    if (context.task_id && context.run_id) {
      const sourceTask = await getTask(normalizeTaskId(context.task_id));
      const entryEvent = await getStageEntryEventByRunId(context.run_id);
      if (
        sourceTask &&
        entryEvent?.state === 'running' &&
        entryEvent.taskId === sourceTask.id
      ) {
        automaticStageEntryTaskId = sourceTask.id;
      }
      const sourceGroup = sourceTask
        ? getGroupByFolder(sourceTask.project_id)
        : undefined;
      if (
        sourceTask &&
        sourceGroup &&
        isTestingStage(getGroupStages(sourceGroup), sourceTask.status) &&
        automaticStageEntryTaskId !== sourceTask.id
      ) {
        throw new Error(
          'Testing-stage tasks are read-only for agents; CarapaBoard applies the structured verdict programmatically.',
        );
      }
    } else if (context.task_id) {
      const sourceTask = await getTask(normalizeTaskId(context.task_id));
      const sourceGroup = sourceTask
        ? getGroupByFolder(sourceTask.project_id)
        : undefined;
      if (
        sourceTask &&
        sourceGroup &&
        isTestingStage(getGroupStages(sourceGroup), sourceTask.status)
      ) {
        throw new Error(
          'Testing-stage tasks are read-only for agents; CarapaBoard applies the structured verdict programmatically.',
        );
      }
    }
    const task_id = normalizeTaskId(raw_id || context.task_id);
    const { permissions } = context;
    const task = await getTask(task_id);
    if (!task) throw await taskNotFoundError(task_id, permissions);
    if (!hasPermission(permissions, task.project_id, 'tasks:write')) {
      throw new Error(
        `Unauthorized: missing tasks:write permission for project "${task.project_id}"`,
      );
    }

    if (rest.objective_id !== task.objective_id) {
      await assertObjectiveTaggable(
        permissions,
        task.project_id,
        rest.objective_id,
      );
    }

    const targetProjectId = task.project_id;
    const taskGroup = getGroupByFolder(targetProjectId);
    if (
      taskGroup &&
      isTestingStage(getGroupStages(taskGroup), task.status) &&
      task.id !== automaticStageEntryTaskId
    ) {
      throw new Error(
        'Testing-stage tasks are read-only for agents; CarapaBoard applies the structured verdict programmatically.',
      );
    }
    if (rest.description !== undefined && (await isTaskRunning(task_id))) {
      throw new Error(
        `Cannot update description of task ${task_id} — it is currently being executed by an agent. Create a follow-up task instead.`,
      );
    }
    const updates: any = { ...rest };
    if (updates.depends_on_ids !== undefined) {
      updates.depends_on_ids = [
        ...new Set<string>(updates.depends_on_ids.map(normalizeTaskId)),
      ];
    }
    const queueStageIds = getGroupStages(taskGroup)
      .filter((stage) => stage.type === 'queue')
      .map((stage) => stage.id);
    if (rest.stage_variant !== undefined) {
      if (findStage(getGroupStages(taskGroup), task.status)?.type !== 'queue') {
        throw new Error(
          `stage_variant can only be changed while task ${task_id} is in a queue stage.`,
        );
      }
      // An execution claim (queued-for-start or running) freezes the variant:
      // executeTask re-reads the variant once after claiming, so an edit
      // committed mid-start could otherwise race the run's stage resolution.
      if (await isTaskRunning(task_id)) {
        throw new Error(
          `stage_variant cannot be changed while task ${task_id} is claimed for or under execution.`,
        );
      }
      updates.stage_variant = resolveRequestedStageVariant(
        taskGroup,
        rest.stage_variant,
      );
    }
    if (rest.co_stages !== undefined) {
      if (await isTaskRunning(task_id)) {
        throw new Error(
          `co_stages cannot be changed while task ${task_id} is claimed for or under execution.`,
        );
      }
      updates.co_stages = resolveRequestedCoStages(taskGroup, rest.co_stages);
    }
    if (rest.ab_variants !== undefined) {
      const abRes = validateAbVariants(
        taskGroup,
        rest.ab_variants,
        task,
        getGroupStages(taskGroup),
      );
      if (!abRes.valid) throw new Error(abRes.error);
      updates.ab_variants = abRes.variants;
    }
    let effectiveStatus = status;
    let targetStage: ReturnType<typeof findStage> = undefined;
    if (status !== undefined) {
      const group = getGroupByFolder(targetProjectId);
      const stages = getGroupStages(group).filter((s) => !s.inactive);
      targetStage = findStage(stages, status);
      if (!targetStage) throw new Error(`Invalid stage "${status}"`);
      // Completion belongs to the pipeline or a human. A task that is already
      // done may move between done stages, e.g. into the deploy stage.
      if (
        targetStage.type === 'done' &&
        findStage(stages, task.status)?.type !== 'done'
      ) {
        throw new Error(
          `Agents cannot move tasks into done stage "${status}"; only CarapaBoard's completion pipeline or a human may complete a task.`,
        );
      }
      const reviewDenial = agentReviewEntryDenial(stages, task, status);
      if (reviewDenial) throw new Error(reviewDenial);
      if (
        task.status !== status &&
        targetStage.type !== 'done' &&
        findStage(stages, task.status)?.type === 'done'
      ) {
        updates.completed_at = null;
      }
      if (isActiveStage(stages, effectiveStatus)) {
        const sourceRun = context.run_id
          ? await getActiveRunById(context.run_id)
          : undefined;
        updates.lastTriggeredByUserId = sourceRun?.triggeredByUserId ?? null;
        updates.lastTriggerSource = 'agent';
        updates.lastTriggeredAt = new Date().toISOString();
      }
    }
    // Light validation: skip_stages must be null or an array of strings.
    // The agent can clear the list by passing null or []; unknown IDs are
    // tolerated because project stage config can change after the task
    // was created.
    if (
      updates.skip_stages !== undefined &&
      updates.skip_stages !== null &&
      !Array.isArray(updates.skip_stages)
    ) {
      throw new Error('skip_stages must be an array of strings or null');
    }
    if (Array.isArray(updates.skip_stages)) {
      updates.skip_stages = updates.skip_stages.filter(
        (s: unknown) => typeof s === 'string',
      );
    }
    {
      const addedGated = addedGatedSkipStages(
        getGroupStages(taskGroup),
        task.skip_stages,
        updates.skip_stages,
      );
      if (addedGated.length > 0) {
        throw new Error(gatedSkipStagesDenial(addedGated));
      }
    }

    // Reject cross-project dependency edges before the durable stage handoff
    // (and its stop controls) is persisted, so a rejected update leaves no
    // pending handoff behind. updateTask revalidates under the task write
    // lock as the authoritative check.
    if (updates.depends_on_ids !== undefined) {
      const nextDeps: string[] = updates.depends_on_ids;
      if (nextDeps.includes(task_id)) {
        throw new Error('A task cannot depend on itself');
      }
      // IDs already on the task stay tolerated; only newly added ones must exist.
      const existingDeps = new Set(task.depends_on_ids ?? []);
      await assertDependenciesExist(
        nextDeps.filter((id) => !existingDeps.has(id)),
      );
      await validateSameProjectDependencies(task_id, task.project_id, nextDeps);
      if (await hasCircularDependency(task.project_id, task_id, nextDeps)) {
        throw new Error('Circular dependency detected');
      }
    }

    // Any agent move of a card with a live execution claim is a graceful
    // handoff bound to the card's own execution: the run finishes its turn
    // with a short summary and the card then lands on the requested stage.
    // The caller's identity only selects the steer wording. Without a
    // handoff-capable claim (an orphaned run row after a restart, or a claim
    // that has not launched yet), a move to a queue stage or away from the
    // run's stage stops the run like the Stop button. A move to the run's own
    // stage leaves the run going.
    const changesStage =
      effectiveStatus !== undefined && task.status !== effectiveStatus;
    const cardRun = changesStage
      ? await getActiveRunForTask(task_id)
      : undefined;
    const isOwnRun = await isCardOwnRun(context, task_id);
    // Without a Question stage, the card's own run parking it in the
    // needs-input fallback stage stands in for entering a Question stage.
    // Decided here, where the caller is known; the durable handoff carries it.
    const fallbackGroup = getGroupByFolder(targetProjectId);
    const ownRunFallbackQuestion =
      isOwnRun &&
      !!fallbackGroup &&
      effectiveStatus !== undefined &&
      isFallbackQuestionMove(
        getGroupStages(fallbackGroup),
        task.status,
        effectiveStatus,
      );

    let handoffRequested = false;
    // Bound to the card's current run only: a caller-supplied run id may name
    // an older run of the card, and a claim without a run row falls back to
    // the stop below.
    if (
      cardRun &&
      cardRun.stage !== effectiveStatus &&
      !!targetStage &&
      isTaskExecutionClaimed(task_id)
    ) {
      handoffRequested = await requestDurableTaskStageHandoff(
        task,
        task.status,
        effectiveStatus!,
        cardRun.id,
        undefined,
        isOwnRun
          ? undefined
          : `Task moved to ${targetStage.title} by another agent. Stop working now and do not call more tools. Provide only a short handoff summary of what you did and where you stopped.`,
        ownRunFallbackQuestion,
      );
    }
    // A claim whose run row does not exist yet has no stage to stay in, so any
    // real stage change cancels it instead of letting it launch its old stage.
    let stopsRunningTask = false;
    if (changesStage && !!targetStage && !handoffRequested) {
      if (await isTaskRunning(task_id)) {
        const currentRun = await getActiveRunForTask(task_id);
        stopsRunningTask =
          targetStage.type === 'queue' ||
          !currentRun ||
          currentRun.stage !== effectiveStatus;
      }
    }

    // A live execution owns its starting stage until successful finalization.
    // Persist the handoff intent in the task transcript, but leave the
    // authoritative status unchanged so queued steering can still hold the
    // run in place without rewinding broadcasts or stage-entry side effects.
    if (effectiveStatus !== undefined && !handoffRequested) {
      updates.status = effectiveStatus;
    }

    const writeUpdates = () =>
      updateTask(task_id, updates, {
        failureSource: 'user',
        // The queue precondition is re-checked atomically in updateTask so a
        // concurrently started run cannot receive a variant or experiment
        // change.
        requireStageVariantStatuses: queueStageIds,
        // Synchronous, evaluated in the same tick as the write (inside the
        // row-locked transaction): a claim installed after the earlier
        // isTaskRunning check rejects the edit here, and a claim installed
        // after the write re-reads the committed values post-claim. This closes
        // the deferTaskActivation window where the persisted status stays
        // queued.
        isExecutionClaimed: () => isTaskExecutionClaimed(task_id),
      });
    // Serialize stage_variant, ab_variants and co_stages commits against the execution
    // claim's post-claim re-read: the write holds the per-task chain from its
    // guard check through commit, so the run either reads the committed value
    // or the guard rejects the edit.
    const stageEntryEvent =
      updates.stage_variant !== undefined ||
      updates.ab_variants !== undefined ||
      updates.co_stages !== undefined
        ? await withStageVariantWriteLock(task_id, writeUpdates)
        : await writeUpdates();
    // The status is already persisted, so stopTask keeps the chosen stage.
    // Await it so a follow-up edit (e.g. the description) is no longer
    // rejected as "currently being executed" and the drain below can claim
    // the task for a new execution stage.
    if (stopsRunningTask) {
      await stopTask(task_id, { keepStatus: true }).catch((err) =>
        logger.warn(
          { task_id, err },
          'Failed to stop task moved away from its running stage',
        ),
      );
    }
    const dependencyWarnings = await warnOnUncontainedDependencies(
      task,
      taskGroup,
      updates.depends_on_ids,
    );
    const updated = await getTask(task_id);
    // With a handoff the status stays unchanged, but the other persisted
    // fields (title, priority, deps, skip_stages...) emit no event of their
    // own, so broadcast them whenever the write carried more than status.
    if (
      updated &&
      (!handoffRequested ||
        Object.values(updates).some((value) => value !== undefined))
    ) {
      broadcast({ type: 'task_updated', payload: updated });
    }
    if (updated && !handoffRequested) {
      const group = getGroupByFolder(targetProjectId);
      if (
        group &&
        effectiveStatus !== undefined &&
        task.status !== effectiveStatus &&
        (isQuestionStage(getGroupStages(group), effectiveStatus) ||
          ownRunFallbackQuestion)
      ) {
        await publishTaskEventAndNotify(
          updated,
          group,
          { type: 'task_question', source: 'agent_update' },
          {
            group_folder: updated.project_id,
            task_id: updated.id,
            run_id: context.run_id ?? updated.id,
            event: 'needs_input',
            title: `Task needs input: ${updated.title}`,
            defer_stage_entry: true,
            stage_entry_event_id: stageEntryEvent?.id,
          },
        );
      }
      if (
        group &&
        effectiveStatus !== undefined &&
        task.status !== effectiveStatus &&
        isFailedStage(getGroupStages(group), effectiveStatus)
      ) {
        await publishTaskEventAndNotify(
          updated,
          group,
          { type: 'task_failed', source: 'agent_update' },
          {
            group_folder: updated.project_id,
            task_id: updated.id,
            run_id: context.run_id ?? updated.id,
            event: 'failed',
            title: `Task failed: ${updated.title}`,
            defer_stage_entry: true,
            stage_entry_event_id: stageEntryEvent?.id,
          },
        );
      } else if (
        group &&
        effectiveStatus !== undefined &&
        task.status !== effectiveStatus &&
        targetStage?.type === 'done' &&
        findStage(getGroupStages(group), task.status)?.type !== 'done'
      ) {
        await notifyEntityLifecycle({
          group_folder: updated.project_id,
          task_id: updated.id,
          run_id: context.run_id ?? updated.id,
          event: 'completed',
          title: `Task completed: ${updated.title}`,
          defer_stage_entry: true,
          stage_entry_event_id: stageEntryEvent?.id,
        });
      }
    }
    if (effectiveStatus !== undefined && !handoffRequested) {
      const group = getGroupByFolder(targetProjectId);
      if (group && isActiveStage(getGroupStages(group), effectiveStatus)) {
        taskQueueDrainRunner(targetProjectId, group);
      } else if (
        group?.settings?.deployService &&
        updated &&
        task.status !== effectiveStatus &&
        effectiveStatus ===
          getDeployStageId(group.settings, getGroupStages(group))
      ) {
        // Same as a manual move: merge and build; the deploy reports the outcome.
        queueDeploy(updated, group, undefined, stageEntryEvent?.id);
      }
      if (
        group &&
        task.status !== effectiveStatus &&
        findStage(getGroupStages(group), effectiveStatus)?.type === 'done'
      ) {
        // Entering a done stage releases dependents gated on this task.
        taskQueueDrainRunner(targetProjectId, group);
      }
    }
    const redirected =
      status !== undefined &&
      effectiveStatus !== undefined &&
      status !== effectiveStatus;
    const message = handoffRequested
      ? redirected
        ? `Task redirected to required stage "${effectiveStatus}". The current run is ending so that stage can start.`
        : 'Task updated. The current run is ending so the new stage can start.'
      : 'Task updated';
    return dependencyWarnings.length > 0
      ? { message, warnings: dependencyWarnings }
      : message;
  },
};

/**
 * Shared handler for archive_task / restore_task. Both flip the same boolean
 * column and only the cleanup side-effect differs (archive triggers
 * removeWorktreeForTask on the false→true transition; restore is a no-op for
 * worktree cleanup since the worktree has already been removed).
 *
 * Mirrors the existing PATCH /projects/:pid/tasks/:fid handler in
 * src/routes/tasks.ts: the idempotency of the cleanup hook (`archived &&
 * !task.archived`) is preserved here so calling archive_task twice in a row
 * does not re-run removeWorktreeForTask the second time. The fallback branch
 * name is also required because older tasks may have a worktree without a
 * persisted branch_name.
 */
async function flipArchived(
  raw_id: string,
  context: any,
  archived: boolean,
): Promise<{ archived: boolean; task: any }> {
  const task_id = normalizeTaskId(raw_id);
  const { permissions } = context;
  const task = await getTask(task_id);
  if (!task) throw await taskNotFoundError(task_id, permissions);
  if (!hasPermission(permissions, task.project_id, 'tasks:write')) {
    throw new Error(
      `Unauthorized: missing tasks:write permission for project "${task.project_id}"`,
    );
  }

  const taskGroup = getGroupByFolder(task.project_id);
  if (taskGroup && isTestingStage(getGroupStages(taskGroup), task.status)) {
    throw new Error(
      'Testing-stage tasks are read-only for agents; CarapaBoard applies the structured verdict programmatically.',
    );
  }

  // Archiving force-removes the worktree, which would discard a live run's
  // uncommitted work. Refuse; the user stops the task first.
  if (archived && !task.archived && (await isTaskRunning(task_id))) {
    throw new Error('Task is running; stop it before archiving');
  }

  // Cleanup hook (mirrors the HTTP archive paths). It must run before the
  // archive write so an active-conversation conflict leaves the task
  // unarchived and a later retry cannot skip worktree removal. The guard
  // `archived && !task.archived` makes this idempotent: re-archiving an
  // already-archived task is a no-op, and restore never triggers it.
  // Worktrees created before branch_name was persisted are keyed by the task
  // id, so use the same fallback as the HTTP archive/delete paths.
  if (archived && !task.archived) {
    const group = getGroupByFolder(task.project_id);
    if (group) {
      await removeWorktreeForTask(
        { ...task, branch_name: task.branch_name || `task-${task.id}` },
        group,
      );
    }
  }

  await updateTask(task_id, { archived });

  const updated = await getTask(task_id);
  if (updated) broadcast({ type: 'task_updated', payload: updated });
  // The queue skips archived cards and nothing drains periodically, so a
  // restored card in an executable stage would otherwise wait for an
  // unrelated event.
  if (
    !archived &&
    task.archived &&
    taskGroup &&
    isActiveStage(getGroupStages(taskGroup), task.status)
  ) {
    taskQueueDrainRunner(task.project_id, taskGroup);
  }
  return { archived, task: updated };
}

export const archiveTaskTool: ToolDefinition = {
  name: 'archive_task',
  description:
    'Archive a kanban task (hidden from default list_tasks output; worktree/preview port cleaned up on first archive). Idempotent — archiving an already-archived task returns success without re-running the cleanup hook. Refused while the task is running; stop it first.',
  inputSchema: {
    task_id: z.string().describe('Full task ID (e.g. task-177...-abc)'),
  },
  requiredPermissions: ['tasks:write'],
  authorizesTargetProject: true,
  handler: async ({ task_id }, _deps, context) => {
    const result = await flipArchived(task_id, context, true);
    return JSON.stringify(result, null, 2);
  },
};

export const restoreTaskTool: ToolDefinition = {
  name: 'restore_task',
  description:
    'Restore an archived kanban task (sets archived=false) and wake the queue if it is in an executable stage.',
  inputSchema: {
    task_id: z.string().describe('Full task ID (e.g. task-177...-abc)'),
  },
  requiredPermissions: ['tasks:write'],
  authorizesTargetProject: true,
  handler: async ({ task_id }, _deps, context) => {
    const result = await flipArchived(task_id, context, false);
    return JSON.stringify(result, null, 2);
  },
};

export const listStagesTool: ToolDefinition = {
  name: 'list_stages',
  description:
    'List pipeline stages (board columns) for a project. Stage alternatives (<base>.<suffix>, e.g. coding.b, review.o) are not included; use get_project_setup to list them when choosing co_stages, stage_variant or ab_variants.',
  inputSchema: {
    project_id: z
      .string()
      .optional()
      .describe('Project folder name (defaults to current context)'),
  },
  requiredPermissions: ['tasks:read'],
  handler: async ({ project_id }, deps, context) => {
    const { group_folder, permissions } = context;
    const targetProject = project_id || group_folder;
    if (!hasPermission(permissions, targetProject, 'tasks:read')) {
      throw new Error(
        `Unauthorized: missing tasks:read permission for project "${targetProject}"`,
      );
    }
    const group = getGroupByFolder(targetProject);
    if (!group) throw new Error('Project not found');
    return JSON.stringify(getGroupStages(group), null, 2);
  },
};

export function requireStagePromptTarget(
  stages: ReturnType<typeof getGroupStages>,
  stageId: string,
) {
  const stage = findStage(stages, stageId);
  if (
    !stage ||
    stage.inactive ||
    !['active', 'testing', 'review'].includes(stage.type)
  ) {
    throw new Error(
      `Stage "${stageId}" is not an enabled active, testing, or review stage`,
    );
  }
  return stage;
}

/**
 * Whether the caller is a run of this card: its token names the card, or its
 * run id resolves to any run (not only the active one) of the card.
 */
async function isCardOwnRun(
  context: { task_id?: string; run_id?: string },
  taskId: string,
): Promise<boolean> {
  if (context.task_id && normalizeTaskId(context.task_id) === taskId)
    return true;
  if (!context.run_id) return false;
  return (await getActiveRunById(context.run_id))?.task_id === taskId;
}

export const addTaskCommentTool: ToolDefinition = {
  name: 'add_task_comment',
  description:
    'Add a prompt for one exact executable kanban stage. By default it is delivered once on the next run; persistent mode replaces that stage’s note for every future run. A task’s own running agent cannot send a one-shot prompt to the stage it is running (it would be delivered back into its current turn); it must use persistent: true for a later run of that stage, or address a different stage_id.',
  inputSchema: {
    task_id: z.string().describe('Task ID'),
    stage_id: z
      .string()
      .describe(
        'Exact active, testing, or review stage ID that should receive the prompt',
      ),
    comment: z
      .string()
      .max(4000)
      .describe(
        'Comment text (maximum 4,000 characters; empty clears a persistent note)',
      ),
    persistent: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Replace the stage’s persistent note instead of delivering this comment once',
      ),
  },
  requiredPermissions: ['tasks:write'],
  authorizesTargetProject: true,
  handler: async (
    { task_id: raw_id, stage_id, comment, persistent },
    deps,
    context,
  ) => {
    const task_id = normalizeTaskId(raw_id || context.task_id);
    // Reserve the admission before any await so a concurrent successful
    // finalization cannot slip in while the caller's identity resolves. The
    // caller's run id is passed as-is: only a run of this card can equal the
    // presented run id, so a foreign run id never suppresses the barrier.
    const admission = persistent
      ? undefined
      : beginTaskSteeringAdmission(task_id, {
          targetStage: stage_id,
          originatingRunId: context.run_id,
        });
    try {
      const isOwnRun = await isCardOwnRun(context, task_id);
      const originatingRunId = isOwnRun ? context.run_id : undefined;
      const { permissions } = context;
      const task = await getTask(task_id);
      if (!task) throw await taskNotFoundError(task_id, permissions);
      if (!hasPermission(permissions, task.project_id, 'tasks:write')) {
        throw new Error(
          `Unauthorized: missing tasks:write permission for project "${task.project_id}"`,
        );
      }
      const group = getGroupByFolder(task.project_id);
      if (!group) throw new Error('Project not found');
      const stage = requireStagePromptTarget(getGroupStages(group), stage_id);
      if (!persistent && isOwnRun) {
        const runningStages = [
          (await getActiveRunForTask(task_id))?.stage,
          getTaskExecutionStartingStage(task_id),
        ];
        if (runningStages.includes(stage.id)) {
          throw new Error(
            'You cannot send a one-shot prompt to your own running stage; it would be delivered back into your current turn. To leave instructions for a later run of this stage use `persistent: true`; to address another stage pass that `stage_id`.',
          );
        }
      }
      if (persistent) {
        const content = comment.trim();
        if (!content) {
          await clearTaskStageComment(task_id, stage.id);
          broadcast({ type: 'task_updated', payload: task });
          return JSON.stringify({
            message: 'Persistent stage comment cleared',
            stage_id: stage.id,
          });
        }

        const activeRun = await getActiveRunForTask(task_id);
        const persistentOriginatingRunId =
          isOwnRun && activeRun?.stage === stage.id ? activeRun.id : null;
        const saved = await setTaskStageComment(
          task_id,
          stage.id,
          content,
          persistentOriginatingRunId,
        );
        broadcast({ type: 'task_updated', payload: task });
        return JSON.stringify({
          message: 'Persistent stage comment saved',
          stage_id: stage.id,
          updated_at: saved.updated_at,
          run_id: saved.run_id,
        });
      }

      const delivery = await appendTaskStagePrompt(
        task.project_id,
        task_id,
        comment,
        stage.id,
        originatingRunId,
        admission,
      );
      broadcast({
        type: 'task_message',
        payload: {
          task_id,
          project_id: task.project_id,
          message: delivery.message,
        },
      });
      if (delivery.receipt) {
        broadcast({
          type: 'task_message',
          payload: {
            task_id,
            project_id: task.project_id,
            message: delivery.receipt,
          },
        });
      }
      if (delivery.continuationDrainRequired) {
        void drainProjectQueue(task.project_id, group);
      }
      return JSON.stringify({
        message: 'Stage prompt added',
        prompt_id: delivery.message.id,
        stage_id: stage.id,
        delivery: delivery.accepted ? 'steered' : 'queued',
        run_id: delivery.receipt?.run_id ?? null,
      });
    } finally {
      if (admission) endTaskSteeringAdmission(admission);
    }
  },
};

export const updateValuesTool: ToolDefinition = {
  name: 'update_values',
  description: `Update custom values on a kanban task.`,
  inputSchema: {
    task_id: z.string().describe('Task ID'),
    values: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .describe('Key-value pairs to set'),
  },
  requiredPermissions: ['tasks:write'],
  authorizesTargetProject: true,
  handler: async ({ task_id: raw_id, values }, deps, context) => {
    const task_id = normalizeTaskId(raw_id || context.task_id);
    const { permissions } = context;
    const task = await getTask(task_id);
    if (!task) throw await taskNotFoundError(task_id, permissions);
    if (!hasPermission(permissions, task.project_id, 'tasks:write')) {
      throw new Error(
        `Unauthorized: missing tasks:write permission for project "${task.project_id}"`,
      );
    }
    let parsedValues = values;
    if (typeof values === 'string') {
      try {
        parsedValues = JSON.parse(values);
      } catch (e) {
        throw new Error('values must be a valid JSON object');
      }
    }
    const denial = pipelineOwnedValuesDenial(context, parsedValues, task_id);
    if (denial) throw new Error(denial);
    await updateTask(
      task_id,
      { custom_values: parsedValues },
      {
        mergeCustomValues: true,
        preserveCustomValueKeys: DEPLOY_HANDOFF_VALUE_KEYS,
      },
    );
    const updated = await getTask(task_id);
    broadcast({ type: 'task_updated', payload: updated });
    return `Values updated: ${Object.keys(parsedValues).join(', ')}`;
  },
};

export * from './dataset-tools.js';
export * from './cron-tools.js';
