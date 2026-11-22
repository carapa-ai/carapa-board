/**
 * Task CRUD, status updates, bulk operations, execution, and stop endpoints.
 */
import { Router } from 'express';
import path from 'path';
import { randomUUID } from 'node:crypto';
import {
  GroupFsError,
  type GroupFsErrorCode,
  type PinnedDir,
  lstatAt,
  openDirAt,
  openFileAt,
  openGroupDir,
  readdirAt,
  removeAt,
  sendPinnedFile,
} from '../lib/group-fs.js';
import {
  createTask,
  getTask,
  getTasksByProject,
  getTasksByProjectSummary,
  updateTask,
  updateTasksArchived,
  deleteTask,
  hasCircularDependency,
  getRunsForTask,
  getLatestScoredReviewRunForTask,
  getRunCountForTask,
  getTaskRunStageDurations,
  getTaskStageComment,
  getTaskStageComments,
  setTaskStageComment,
  clearTaskStageComment,
  moveTaskToProject,
  TaskSourceProjectMismatchError,
  TaskStageWriteConflictError,
  CrossProjectDependencyError,
  validateSameProjectDependencies,
  assertDependenciesExist,
  UnknownDependencyError,
  claimNormalTaskAdmission,
  releaseTaskAdmission,
  ConversationWorktreeInUseError,
  getExternalIssueImportByTaskId,
} from '../db.js';
import {
  getGroupByFolder,
  getGroupEntryByFolder,
  updateGroup,
} from '../state-manager.js';
import type { Task } from '../modules/kanban/types.js';
import {
  executeTask,
  claimTaskExecution,
  claimTaskReset,
  releaseTaskExecutionClaim,
  stopTask,
  isMoveAwayFromRunStage,
  stopAllProjectTasks,
  isTaskRunning,
  drainProjectQueue,
  resetProjectFailures,
  queueDeploy,
  appendTaskSteeringMessage,
  beginTaskSteeringAdmission,
  endTaskSteeringAdmission,
  isTaskExecutionClaimed,
  isTaskExecutionClaimedByOther,
  withStageVariantWriteLock,
} from '../modules/kanban/task-executor.js';
import {
  answerTaskAgentUserInput,
  stopTaskBackgroundTask,
} from '../sandbox/process.js';
import {
  appendTaskIntegrationMessage,
  onDatasetTaskCompleted,
} from '../modules/kanban/task/pipeline.js';
import {
  loadTaskExecutionMarkers,
  presentTaskExecution,
} from '../modules/kanban/task-phase.js';
import { runTaskDefaultBranchOperation } from '../lib/task-default-branch.js';
import type { TaskDefaultBranchMerge } from '../types.js';
import {
  commitBranchOnStageLeave,
  validatedInstance,
  runGitInRepo,
  taskUsesWorktree,
  withProjectGitLock,
  removeWorktreeForTask,
  inspectTaskLinkedRepositories,
  appendUntrackedDiffFromList,
  enrichTrackedDiffSymlinks,
  getDefaultCheckoutBlockers,
  parseGitNumstat,
  type GitStatusEntry,
  type TaskBranchMergeResult,
} from '../lib/git-ops.js';
import {
  readTaskMessages,
  deleteTaskTranscript,
  copyTaskMessages,
  readTaskMessagesAsync,
  readTaskMessagesPageAsync,
  appendTaskMessageDurableAsync,
  readTaskOutputPage,
} from '../modules/transcripts/transcript-store.js';
import { InFlightCoalescer } from '../lib/in-flight-coalescer.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import { logger } from '../logger.js';
import {
  getProjectStages,
  getGroupStages,
  getInitialStage,
  findStage,
  getFirstExecutableStage,
  isActiveStage,
  isFailedStage,
  isQuestionStage,
  isRecoveryHookStage,
  isTestingStage,
  getDeployStageId,
  addedGatedSkipStages,
  gatedSkipStagesDenial,
  validateAbVariants,
  abVariantsCreationStageError,
  validateCoStages,
  validateRuntimeSelectionStage,
  validateStageVariant,
} from '../modules/kanban/stages.js';
import {
  MAX_LEN,
  lenError,
  getUnmetDependencies,
  executionStageError,
  userHasExplicitGroupAccess,
  isAgentCredential,
  callerKind,
} from './_helpers.js';
import { getObjective } from '../modules/objectives/db-objectives.js';
import { validateRuntimeSelection } from '../lib/chat-agents.js';
import { warnOnUncontainedDependencies } from '../modules/kanban/task/dependency-warning.js';
import {
  mergeTaskForManualCompletion,
  waitForManualCompletionCheckout,
} from '../modules/kanban/task/manual-completion.js';
import {
  requestApprovalForHeldMerge,
  type MergeApprovalDetails,
} from '../modules/kanban/task/merge-risk-gate.js';
import {
  AbWinnerError,
  pickAbWinner,
} from '../modules/kanban/task/ab-winner.js';
import { publishTaskQuestion } from '../modules/kanban/task/objective-events.js';
import { publishTaskEventAndNotify } from '../modules/kanban/task/objective-event-holds.js';
import {
  acquireSharedCheckoutLease,
  CheckoutBusyError,
} from '../concurrency/shared-checkout-lease.js';
import {
  agentReviewEntryDenial,
  TESTING_FAILURE_COUNT_KEY,
} from '../modules/kanban/task/testing.js';
import { notifyEntityLifecycle } from '../modules/tools/push-tools.js';
import { findLatestTaskUserPrompt } from '../modules/kanban/task/fresh-session.js';
import { REVIEW_CHAIN_KEY } from '../modules/kanban/task/review-chain.js';
import {
  draftTaskDescription,
  getDescriptionDraftInvoker,
} from '../modules/kanban/description-draft.js';
import type {
  TaskDescriptionDraftHistoryEntry,
  TaskDescriptionDraftRequest,
} from '../types.js';
import {
  getBoardReplay,
  reviewMilestonesFromMessages,
} from '../modules/kanban/board-replay.js';
import type { RegisteredGroup } from '../types.js';
import type { TaskSteeringResult } from '../modules/kanban/task/pipeline.js';
import { syncImportedIssue } from '../modules/kanban/issue-import.js';
import {
  DEPLOY_HANDOFF_VALUE_KEYS,
  pipelineOwnedValuesDenial,
} from '../modules/kanban/pipeline-owned-values.js';
import { MEDIA_TICKET_PARAM, issueMediaTicket } from '../lib/media-tickets.js';
import { adminBypassesProject } from '../lib/project-ownership.js';
import { sleep } from '../lib/async.js';
import { COMMIT_SHA_PATTERN } from '../lib/git-commit.js';
import { isRecord } from '../lib/type-guards.js';

const TASK_EXECUTION_STAGE_TYPES = new Set([
  'active',
  'testing',
  'done',
  'review',
]);

/** Stop the run of a card already moved to another execution stage. */
async function stopTaskForStageMove(taskId: string): Promise<void> {
  await stopTask(taskId, { keepStatus: true }).catch((err) =>
    logger.warn(
      { task_id: taskId, err },
      'Failed to stop task moved to another execution stage',
    ),
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === 'string')
  );
}

function filterStringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function sendTaskWriteError(res: any, error: unknown): boolean {
  if (
    error instanceof CrossProjectDependencyError ||
    error instanceof UnknownDependencyError ||
    error instanceof TaskStageWriteConflictError
  ) {
    res.status(error.statusCode).json({ error: error.message });
    return true;
  }
  if (
    error instanceof Error &&
    (error.message.includes('Cannot change') ||
      error.message.includes('already forked'))
  ) {
    res.status(409).json({ error: error.message });
    return true;
  }
  return false;
}

/**
 * Start over on a worktree-mode task discards the old checkout instead of
 * resetting it in place: remove the worktree, then delete the local branch so
 * the next `worktree add` cannot re-attach the old commits. The next start
 * creates a fresh worktree on the same branch name.
 */
async function discardTaskWorktreeCheckout(
  task: Task & { branch_name: string },
  group: RegisteredGroup,
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(task.branch_name)) {
    throw new Error(`Invalid task branch name: ${task.branch_name}`);
  }
  if (task.worktree_path) {
    await removeWorktreeForTask(task, group, { throwOnError: true });
  }
  await withProjectGitLock(task.project_id, async () => {
    const result = await runGitInRepo(
      group,
      `branch -D ${task.branch_name}`,
      validatedInstance(task, group),
      { waitForCompletion: true },
    );
    // Only git's own missing-branch diagnostic counts as already deleted;
    // any other failure (e.g. stack or container not found) must surface.
    const missingDiagnostic = `branch '${task.branch_name}' not found`;
    const branchMissing = result.output
      .split('\n')
      .some((line) =>
        [missingDiagnostic, `error: ${missingDiagnostic}`].includes(
          line.trim().replace(/\.$/, ''),
        ),
      );
    if (!result.ok && !branchMissing) {
      throw new Error(
        result.output.trim() || 'Unable to delete task branch on start-over',
      );
    }
  });
}

async function resolveTaskResetBase(
  task: Task,
  group: RegisteredGroup,
): Promise<string> {
  const defaultBranch = group.settings?.defaultBranch || 'develop';
  if (!task.depends_on_ids?.length) return defaultBranch;
  const defaultResult = await runGitInRepo(
    group,
    `rev-parse --verify ${defaultBranch}^{commit}`,
  );
  if (!defaultResult.ok)
    throw new Error(`Default branch ${defaultBranch} is unresolved`);
  const defaultCommit = defaultResult.output.trim();
  const requiredCommits: string[] = [];
  const lineages: Array<{ branch: string; commit: string }> = [];
  for (const dependencyId of task.depends_on_ids) {
    const dependency = await getTask(dependencyId);
    if (!dependency)
      throw new Error(`Dependency ${dependencyId} no longer exists`);
    const recorded =
      typeof dependency.custom_values?.testing_head_sha === 'string'
        ? dependency.custom_values.testing_head_sha
        : typeof dependency.custom_values?.completed_commit_sha === 'string'
          ? dependency.custom_values.completed_commit_sha
          : dependency.merge_commit;
    if (dependency.branch_name) {
      const branch = await runGitInRepo(
        group,
        `rev-parse --verify ${dependency.branch_name}^{commit}`,
      );
      if (branch.ok) {
        const head = branch.output.trim();
        requiredCommits.push(recorded ?? head);
        lineages.push({ branch: dependency.branch_name, commit: head });
        continue;
      }
    }
    if (!recorded)
      throw new Error(`Dependency ${dependencyId} has no resolved commit`);
    requiredCommits.push(recorded);
  }
  const defaultContains = await Promise.all(
    requiredCommits.map(
      async (commit) =>
        (
          await runGitInRepo(
            group,
            `merge-base --is-ancestor ${commit} ${defaultCommit}`,
          )
        ).ok,
    ),
  );
  if (defaultContains.every(Boolean)) return defaultCommit;
  for (const lineage of lineages) {
    const containsAll = await Promise.all(
      requiredCommits.map(
        async (commit) =>
          (
            await runGitInRepo(
              group,
              `merge-base --is-ancestor ${commit} ${lineage.commit}`,
            )
          ).ok,
      ),
    );
    if (containsAll.every(Boolean)) return lineage.commit;
  }
  throw new Error(
    'Dependencies have no single verified lineage for start-over',
  );
}

/** Persist a user prompt as the task description and show it in the chat. */
async function persistTaskPrompt(task: Task, prompt: string): Promise<Task> {
  await updateTask(task.id, { description: prompt });
  const updated = (await getTask(task.id)) ?? task;
  // Persist and broadcast the user prompt immediately so it appears in the chat
  // without waiting for slot acquisition/task completion.
  const userMsg = await appendTaskMessageDurableAsync(task.project_id, {
    task_id: task.id,
    role: 'user',
    content: prompt,
    created_at: new Date().toISOString(),
  });
  broadcast({
    type: 'task_message',
    payload: {
      task_id: task.id,
      project_id: task.project_id,
      message: userMsg,
    },
  });
  return updated;
}

type TaskStartOverOutcome =
  | { ok: true; task: Task }
  | {
      ok: false;
      status: 409 | 500 | 502;
      error: string;
      conversationIds?: string[];
    };

/**
 * Start over for one task, shared by `POST …/execute?reset=true` and
 * `POST …/bulk-start-over`: resolve the reset base before any destructive
 * step, discard the worktree checkout (or reset the task branch in branch
 * mode), clear the transcript and run fields, reset the testing loop and set
 * the target stage. It never starts the task: the caller drains the queue.
 */
async function startOverTask(
  initialTask: Task,
  group: RegisteredGroup,
  opts: {
    /** Stage to move the task to; omit to keep the current stage. */
    targetStageId?: string;
    triggeredByUserId: string | null;
    triggerSource: 'user' | 'system';
    /** Replaces the task description and is posted to the chat. */
    prompt?: string;
  },
): Promise<TaskStartOverOutcome> {
  // Recheck durable runs, then claim synchronously so a queue drain cannot
  // start the task while reset awaits git or transcript operations.
  if (await isTaskRunning(initialTask.id)) {
    return { ok: false, status: 409, error: 'Task is already running' };
  }
  const claim = claimTaskReset(initialTask.id, initialTask.project_id);
  if (!claim) {
    return { ok: false, status: 409, error: 'Task is already running' };
  }
  try {
    let task = (await getTask(initialTask.id)) ?? initialTask;
    let resetBase: string;
    try {
      resetBase = await resolveTaskResetBase(task, group);
    } catch (err) {
      return { ok: false, status: 409, error: (err as Error).message };
    }
    if (
      task.branch_name &&
      taskUsesWorktree(group) &&
      (group.settings?.repositoryLocation ||
        group.settings?.repositoryRelativePath)
    ) {
      try {
        await discardTaskWorktreeCheckout(
          { ...task, branch_name: task.branch_name },
          group,
        );
      } catch (err) {
        if (err instanceof ConversationWorktreeInUseError) {
          return {
            ok: false,
            status: 409,
            error: err.message,
            conversationIds: err.conversationIds,
          };
        }
        return { ok: false, status: 502, error: (err as Error).message };
      }
      task = (await getTask(task.id)) ?? task;
    }
    // Branch mode: verify the shared checkout before resetting the task branch.
    // Failures before a successful reset leave the transcript and fields intact.
    const resetTask = task;
    let branchResetCompleted = false;
    let branchResetError: string | undefined;
    if (
      resetTask.branch_name &&
      group.settings?.taskCheckoutMode === 'branch' &&
      (group.settings.repositoryLocation ||
        group.settings.repositoryRelativePath)
    ) {
      const lease = await acquireSharedCheckoutLease(resetTask.project_id, {
        type: 'task',
        id: resetTask.id,
      });
      try {
        await withProjectGitLock(resetTask.project_id, async () => {
          const defaultBranch = group.settings?.defaultBranch || 'develop';
          const currentBranch = await runGitInRepo(
            group,
            'branch --show-current',
            validatedInstance(resetTask, group),
          );
          const status = await runGitInRepo(
            group,
            'status --porcelain=v1',
            validatedInstance(resetTask, group),
          );
          if (
            !currentBranch.ok ||
            currentBranch.output.trim() !== defaultBranch ||
            !status.ok ||
            status.output.trim()
          ) {
            throw new Error(
              'Shared checkout is dirty or on an unexpected branch',
            );
          }
          const checkoutTaskBranch = await runGitInRepo(
            group,
            `checkout ${resetTask.branch_name}`,
            validatedInstance(resetTask, group),
          );
          if (!checkoutTaskBranch.ok)
            throw new Error('Task branch is unavailable');
          try {
            const reset = await runGitInRepo(
              group,
              `reset --hard ${resetBase}`,
              validatedInstance(resetTask, group),
            );
            if (!reset.ok) throw new Error('Unable to reset task branch');
            branchResetCompleted = true;
          } finally {
            const restore = await runGitInRepo(
              group,
              `checkout ${defaultBranch}`,
              validatedInstance(resetTask, group),
            );
            if (!restore.ok)
              throw new Error('Unable to restore default checkout');
          }
        });
      } catch (err) {
        if (!branchResetCompleted) {
          return { ok: false, status: 409, error: (err as Error).message };
        }
        branchResetError = (err as Error).message;
      } finally {
        await lease.release();
      }
    }

    // The checkout has been discarded; clear the old session before attempting
    // the archive scrub, which can fail and leave the old history in place.
    await updateTask(task.id, { output: '', error: '', session_id: '' });
    task = (await getTask(task.id)) ?? task;
    broadcast({ type: 'task_updated', payload: task });
    if (branchResetError) {
      return { ok: false, status: 409, error: branchResetError };
    }
    try {
      await deleteTaskTranscript(task.project_id, task.id);
    } catch (err) {
      return { ok: false, status: 500, error: (err as Error).message };
    }
    broadcast({
      type: 'messages_cleared',
      payload: { task_id: task.id, project_id: task.project_id },
    });

    // Every manual run is a user-directed retry. Reset the testing loop.
    await updateTask(
      task.id,
      { custom_values: { [TESTING_FAILURE_COUNT_KEY]: 0 } },
      { mergeCustomValues: true },
    );
    task = (await getTask(task.id)) ?? task;
    if (opts.prompt) task = await persistTaskPrompt(task, opts.prompt);

    // No admission or executor call: the queue starts the task once nothing
    // holds it.
    await updateTask(
      task.id,
      {
        ...(opts.targetStageId ? { status: opts.targetStageId } : {}),
        // Start over begins a fresh review round, never a stored chain.
        custom_values: { [REVIEW_CHAIN_KEY]: '' },
        lastTriggeredByUserId: opts.triggeredByUserId,
        lastTriggerSource: opts.triggerSource,
        lastTriggeredAt: new Date().toISOString(),
      },
      { suppressStageEntryEvent: true, mergeCustomValues: true },
    );
    task = (await getTask(task.id)) ?? task;
    broadcast({ type: 'task_updated', payload: task });
    return { ok: true, task };
  } finally {
    releaseTaskExecutionClaim(initialTask.id, claim);
  }
}

type ExplicitExecuteTaskRunner = typeof executeTask;
let explicitExecuteTaskRunner: ExplicitExecuteTaskRunner = executeTask;
type TaskQueueDrainRunner = typeof drainProjectQueue;
let taskQueueDrainRunner: TaskQueueDrainRunner = drainProjectQueue;
type TaskMessageRunningCheckHook = (
  taskId: string,
  running: boolean,
) => void | Promise<void>;
let taskMessageRunningCheckHook: TaskMessageRunningCheckHook | undefined;

export function _testOnlySetExplicitExecuteTaskRunner(
  runner: ExplicitExecuteTaskRunner | null,
): void {
  explicitExecuteTaskRunner = runner ?? executeTask;
}

export function _testOnlySetTaskQueueDrainRunner(
  runner: TaskQueueDrainRunner | null,
): void {
  taskQueueDrainRunner = runner ?? drainProjectQueue;
}

export function _testOnlySetTaskMessageRunningCheckHook(
  hook: TaskMessageRunningCheckHook | null,
): void {
  taskMessageRunningCheckHook = hook ?? undefined;
}

const router = Router();
const taskSummaryRequests = new InFlightCoalescer();

// --- Tasks ---

const MAX_REPLAY_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * GET /api/projects/:pid/board-replay?from=<ISO>&to=<ISO>
 * Reconstruct task-card state and execution activity for a bounded period.
 */
router.get('/projects/:pid/board-replay', async (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);

  if (!from || !to || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return res
      .status(400)
      .json({ error: 'from and to must be valid ISO timestamps' });
  }
  if (fromMs >= toMs) {
    return res.status(400).json({ error: 'from must be earlier than to' });
  }
  if (toMs - fromMs > MAX_REPLAY_RANGE_MS) {
    return res
      .status(400)
      .json({ error: 'Replay period cannot exceed 31 days' });
  }

  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  const replay = await getBoardReplay(
    req.params.pid,
    new Date(fromMs).toISOString(),
    new Date(toMs).toISOString(),
  );
  const taskIds = new Set([
    ...replay.initialTasks.map((task) => task.id),
    ...replay.events.map((event) => event.task_id),
    ...replay.runs.map((run) => run.task_id),
  ]);
  const milestoneGroups = await Promise.all(
    [...taskIds].map(async (taskId) =>
      reviewMilestonesFromMessages(
        taskId,
        await readTaskMessagesAsync(req.params.pid, taskId),
      ),
    ),
  );
  replay.reviewMilestones = milestoneGroups
    .flat()
    .filter((milestone) => new Date(milestone.occurred_at).getTime() <= toMs)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  res.json(replay);
});

function isManualDoneTransition(
  status: string | undefined,
  stages: ReturnType<typeof getProjectStages>,
): boolean {
  // Deliberately allow done → same done. This gives users a recovery action
  // for both stranded task branches and shared-checkout changes that were not
  // checkpointed by an older CarapaBoard version.
  if (!status) return false;
  return findStage(stages, status)?.type === 'done';
}

const AGENT_TESTING_READ_ONLY_ERROR =
  'Testing-stage tasks are read-only for agents; CarapaBoard applies the structured verdict programmatically.';

/** Returns the 403 message when an agent may not apply this status change. */
function agentTaskUpdateDenial(
  stages: ReturnType<typeof getProjectStages>,
  task: Task,
  targetStatus: string | undefined,
): string | null {
  const currentStatus = task.status;
  if (isTestingStage(stages, currentStatus))
    return AGENT_TESTING_READ_ONLY_ERROR;
  if (
    targetStatus !== undefined &&
    findStage(stages, targetStatus)?.type === 'done' &&
    findStage(stages, currentStatus)?.type !== 'done'
  ) {
    return `Agents cannot move tasks into done stage "${targetStatus}"; only CarapaBoard's completion pipeline or a human may complete a task.`;
  }
  if (targetStatus !== undefined) {
    return agentReviewEntryDenial(stages, task, targetStatus);
  }
  return null;
}

const ARCHIVE_RUNNING_ERROR = 'Task is running; stop it before archiving';
const AGENT_DELETE_STOP_ERROR = 'Agents cannot delete or stop tasks via HTTP';
const AGENT_START_OVER_ERROR = 'Agents cannot bulk start over tasks via HTTP';
const FORKED_AB_PARENT_ERROR =
  'Forked A/B experiment parent: pick a winner instead of running it';
const isForkedAbParent = (task: Task) =>
  Boolean(task.ab_fork_commit || (task as any).abForkCommit);

function isManualQuestionRetry(
  stages: ReturnType<typeof getProjectStages>,
  currentStatus: string,
  targetStatus: string,
): boolean {
  const targetStage = findStage(stages, targetStatus);
  return (
    currentStatus !== targetStatus &&
    isQuestionStage(stages, currentStatus) &&
    !!targetStage &&
    !targetStage.inactive &&
    (targetStage.type === 'active' ||
      targetStage.type === 'testing' ||
      targetStage.type === 'review')
  );
}

async function appendManualMergeFailure(
  task: Task,
  group: RegisteredGroup,
  result: TaskBranchMergeResult,
): Promise<MergeApprovalDetails | undefined> {
  const held =
    result.failureKind === 'approval_required'
      ? await requestApprovalForHeldMerge(task, group, result, {
          resume: false,
        })
      : undefined;
  const message = await appendTaskMessageDurableAsync(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type: 'system_notice',
    content:
      held?.notice ??
      `**Manual completion merge failed** — the task status was left unchanged because branch \`${task.branch_name}\` could not be merged into the default branch.\n\n\`\`\`\n${result.output}\n\`\`\``,
    created_at: new Date().toISOString(),
  });
  broadcast({
    type: 'task_message',
    payload: {
      task_id: task.id,
      project_id: task.project_id,
      message,
    },
  });
  return held?.approval;
}

function authenticatedUserId(req: unknown): string | undefined {
  if (!req || typeof req !== 'object' || !('authUser' in req)) return undefined;
  const { authUser } = req;
  if (!authUser || typeof authUser !== 'object' || !('id' in authUser)) {
    return undefined;
  }
  return typeof authUser.id === 'string' ? authUser.id : undefined;
}

async function appendPendingIntegrationNotice(task: Task): Promise<void> {
  const message = await appendTaskMessageDurableAsync(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type: 'system_notice',
    content:
      `**Task completed; integration pending** — its changes are safely committed on branch \`${task.branch_name}\`. ` +
      `Unrelated changes in the shared default checkout prevented integration. The task branch and worktree were retained; move the completed card to the same done stage after the default checkout is clean to retry.`,
    created_at: new Date().toISOString(),
  });
  broadcast({
    type: 'task_message',
    payload: {
      task_id: task.id,
      project_id: task.project_id,
      message,
    },
  });
}

async function notifyOtherOwnerOfManualCompletion(
  task: Task,
  moverUserId: string | undefined,
  runId: string,
  stageEntryEventId?: string,
): Promise<void> {
  if (!moverUserId || !task.ownerUserId || task.ownerUserId === moverUserId) {
    return;
  }
  await notifyEntityLifecycle({
    group_folder: task.project_id,
    task_id: task.id,
    run_id: runId,
    event: 'completed',
    title: `Task completed: ${task.title}`,
    recipient_user_ids: [task.ownerUserId],
    defer_stage_entry: true,
    stage_entry_event_id: stageEntryEventId,
  });
}

/**
 * GET /api/projects/:pid/tasks
 * List tasks for a project.
 */
router.get('/projects/:pid/tasks', async (req, res) => {
  let tasks = await taskSummaryRequests.run(req.params.pid, () =>
    getTasksByProjectSummary(req.params.pid),
  );
  const ownerUserId =
    typeof req.query.ownerUserId === 'string' ? req.query.ownerUserId : null;
  const triggeredByUserId =
    typeof req.query.triggeredByUserId === 'string'
      ? req.query.triggeredByUserId
      : null;
  if (ownerUserId)
    tasks = tasks.filter((task) => task.ownerUserId === ownerUserId);
  if (triggeredByUserId)
    tasks = tasks.filter(
      (task) => task.lastTriggeredByUserId === triggeredByUserId,
    );
  const markers = await loadTaskExecutionMarkers([req.params.pid]);
  res.json(tasks.map((f) => ({ ...f, ...presentTaskExecution(f, markers) })));
});

/**
 * Validate that the caller may tag a task in `projectId` with `objectiveId`.
 * Task events are forwarded to the objective owner's brain, so tagging with
 * another project's objective requires write access to that project. Returns an
 * HTTP error (status + message) or null when allowed.
 */
async function objectiveTagError(
  req: any,
  projectId: string,
  objectiveId: unknown,
): Promise<{ status: number; error: string } | null> {
  if (objectiveId === undefined || objectiveId === null) return null;
  const objective =
    typeof objectiveId === 'string' ? await getObjective(objectiveId) : null;
  if (!objective) {
    return { status: 400, error: 'objective_id must identify an objective' };
  }
  if (
    objective.project_id !== projectId &&
    !(await userHasExplicitGroupAccess(req, objective.project_id, {
      write: true,
    }))
  ) {
    return {
      status: 403,
      error: 'Forbidden: no access to the objective project',
    };
  }
  return null;
}

/**
 * POST /api/projects/:pid/tasks
 * Create a new task.
 */
router.post('/projects/:pid/tasks', async (req, res) => {
  const {
    title,
    description,
    runtimeSelection,
    runtimeSelectionStage,
    priority,
    depends_on_ids,
    skip_stages,
    custom_values,
    author,
    objective_id,
  } = req.body || {};
  let abVariants = req.body?.ab_variants ?? req.body?.abVariants;

  if (typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'title is required' });
  }

  const titleErr = lenError(title, MAX_LEN.title, 'title');
  if (titleErr) return res.status(400).json({ error: titleErr });
  if (description !== undefined && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }
  const descErr = lenError(description, MAX_LEN.description, 'description');
  if (descErr) return res.status(400).json({ error: descErr });
  const runtimeError = validateRuntimeSelection(runtimeSelection);
  if (runtimeError) return res.status(400).json({ error: runtimeError });
  if (custom_values !== undefined) {
    const cvJson = JSON.stringify(custom_values);
    if (cvJson.length > MAX_LEN.description) {
      return res.status(400).json({
        error: `custom_values must be at most ${MAX_LEN.description} characters when serialized`,
      });
    }
  }
  const postDenial = pipelineOwnedValuesDenial(
    req.tokenScope,
    custom_values,
    undefined,
  );
  if (postDenial) return res.status(403).json({ error: postDenial });
  if (depends_on_ids !== undefined && !isStringArray(depends_on_ids)) {
    return res
      .status(400)
      .json({ error: 'depends_on_ids must be an array of strings' });
  }
  // Resolve initial stage from project settings
  const group = getGroupByFolder(req.params.pid);
  if (!group) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const stageScopeError = validateRuntimeSelectionStage(
    group,
    runtimeSelectionStage,
  );
  if (stageScopeError) return res.status(400).json({ error: stageScopeError });
  if (abVariants !== undefined) {
    const abResult = validateAbVariants(group, abVariants);
    if (!abResult.valid) return res.status(400).json({ error: abResult.error });
    abVariants = abResult.variants;
  }
  const stageVariantResult = validateStageVariant(
    group,
    req.body?.stage_variant ?? req.body?.stageVariant,
  );
  if (!stageVariantResult.valid) {
    return res.status(400).json({ error: stageVariantResult.error });
  }
  if (stageVariantResult.variant && abVariants) {
    return res
      .status(400)
      .json({ error: 'stage_variant and ab_variants cannot both be set' });
  }
  const coStagesResult = validateCoStages(
    group,
    req.body?.co_stages ?? req.body?.coStages,
  );
  if (!coStagesResult.valid) {
    return res.status(400).json({ error: coStagesResult.error });
  }
  // Reject task creation when kanban mode is disabled (e.g. parent/coordinator
  // projects) — tasks should be created in a child project instead.
  const enabledModes = group.settings?.enabledModes ?? ['kanban', 'chat'];
  if (!enabledModes.includes('kanban')) {
    return res.status(400).json({
      error:
        'Kanban mode is disabled for this project. Create tasks in a child project instead.',
    });
  }
  const stages = getGroupStages(group);
  const initialStage = getInitialStage(stages);

  if (!initialStage) {
    return res.status(500).json({ error: 'No valid stage found for project' });
  }
  if (stageVariantResult.variant && initialStage.type !== 'queue') {
    return res.status(400).json({
      error: `stage_variant can only be set in a queue stage; "${initialStage.id}" is ${initialStage.type}.`,
    });
  }
  if (abVariants) {
    const abStageError = abVariantsCreationStageError(
      group,
      abVariants,
      initialStage.id,
    );
    if (abStageError) return res.status(400).json({ error: abStageError });
  }

  if (isAgentCredential(req) && Array.isArray(skip_stages)) {
    const addedGated = addedGatedSkipStages(
      stages,
      null,
      filterStringValues(skip_stages),
    );
    if (addedGated.length > 0) {
      return res.status(403).json({ error: gatedSkipStagesDenial(addedGated) });
    }
  }

  // Generate a temporary ID to check for circular dependencies
  const depsToCheck = depends_on_ids || [];
  if (depsToCheck.length > 0) {
    try {
      await assertDependenciesExist(depsToCheck);
    } catch (error) {
      if (sendTaskWriteError(res, error)) return;
      throw error;
    }
    const tempId = `__temp_${Date.now()}`;
    if (await hasCircularDependency(req.params.pid, tempId, depsToCheck)) {
      return res.status(400).json({ error: 'Circular dependency detected' });
    }
  }

  if (priority !== undefined && typeof priority !== 'number') {
    return res.status(400).json({ error: 'priority must be a number' });
  }

  const objectiveError = await objectiveTagError(
    req,
    req.params.pid,
    objective_id,
  );
  if (objectiveError) {
    return res
      .status(objectiveError.status)
      .json({ error: objectiveError.error });
  }

  let task;
  try {
    task = await createTask({
      project_id: req.params.pid,
      title,
      description: description || '',
      status: initialStage.id,
      priority,
      runtimeSelection,
      runtimeSelectionStage,
      ab_variants: abVariants,
      stageVariant: stageVariantResult.variant,
      coStages: coStagesResult.coStages,
      depends_on_ids: depsToCheck,
      // `skip_stages` is the per-task auto-advance override. Light validation:
      // accept only arrays of strings. Unknown IDs are tolerated (project
      // stage config can change after a task is created).
      skip_stages: Array.isArray(skip_stages)
        ? filterStringValues(skip_stages)
        : null,
      custom_values,
      author: author || 'user',
      // Tag the task with an objective. `null` and `undefined` are both
      // accepted (the latter is the default — the column stays nullable for
      // existing rows). CarapaBrain uses this to route task events to the
      // matching objective.
      objective_id: objective_id ?? null,
      ownerUserId: (req as any).authUser?.id ?? group?.user_id ?? null,
      lastTriggeredByUserId: (req as any).authUser?.id ?? null,
      lastTriggerSource: (req as any).authUser?.id ? 'user' : 'system',
      lastTriggeredAt: new Date().toISOString(),
    });
  } catch (error) {
    if (sendTaskWriteError(res, error)) return;
    throw error;
  }

  broadcast({ type: 'task_created', payload: task });
  logger.info({ task_id: task.id, project: req.params.pid }, 'Task created');

  res.status(201).json(task);
});

/**
 * GET /api/projects/:pid/tasks/:fid
 * Get a single task.
 */
router.get('/projects/:pid/tasks/:fid', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

/** Return the external issue identity only for imported tasks. */
router.get('/projects/:pid/tasks/:fid/external-issue', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const externalIssue = await getExternalIssueImportByTaskId(req.params.fid);
  res.json(externalIssue ?? null);
});

/** Refresh an imported task and its non-system comments from GitLab or GitHub. */
router.post(
  '/projects/:pid/tasks/:fid/sync-external-issue',
  async (req, res) => {
    const task = await getTask(req.params.fid);
    if (!task || task.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    if (await isTaskRunning(task.id)) {
      return res.status(409).json({
        error: 'Cannot sync an imported issue while the task is running',
      });
    }

    const result = await syncImportedIssue(group, task.id);
    if (!result) {
      return res.status(404).json({ error: 'Task is not an imported issue' });
    }
    broadcast({ type: 'task_updated', payload: result.task });
    for (const message of result.comments) {
      broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message,
        },
      });
    }
    logger.info(
      {
        project: task.project_id,
        task_id: task.id,
        commentsImported: result.comments.length,
      },
      'Imported issue synchronized',
    );
    res.json(result);
  },
);

/**
 * PATCH /api/projects/:pid/tasks/bulk
 * Update multiple tasks at once (status).
 * NOTE: Must be registered before the :fid route to avoid Express matching "bulk" as :fid.
 */
router.patch('/projects/:pid/tasks/bulk', async (req, res) => {
  const { ids: rawIds, status, archived } = req.body || {};

  // Drop non-string entries and duplicates so each task is processed once.
  const ids = [...new Set(filterStringValues(rawIds))];
  if (ids.length === 0) {
    return res.status(400).json({ error: 'ids (array) is required' });
  }
  if (archived !== undefined && typeof archived !== 'boolean') {
    return res.status(400).json({ error: 'archived must be a boolean' });
  }

  const group = getGroupByFolder(req.params.pid);
  if (!group) {
    return res.status(404).json({ error: 'Project not found' });
  }

  // Validate status if provided
  if (status !== undefined) {
    const stages = getGroupStages(group);
    if (!findStage(stages, status)) {
      return res.status(400).json({ error: `Invalid status "${status}"` });
    }
  }

  // Restoring has no worktree lifecycle side effects, so it can use one
  // UPDATE ... RETURNING query. Archiving must remove each worktree before
  // persisting archived=true: an active conversation can reject removal, and
  // that conflict must leave the task eligible for a real cleanup retry.
  if (status === undefined && archived !== undefined) {
    let validIds = ids;
    const archiveDenials: Array<{ task_id: string; error: string }> = [];
    if (isAgentCredential(req)) {
      const archiveStages = getGroupStages(group);
      const allowedIds: string[] = [];
      for (const id of validIds) {
        const task = await getTask(id);
        if (task && task.project_id === req.params.pid) {
          const denial = agentTaskUpdateDenial(archiveStages, task, undefined);
          if (denial) {
            archiveDenials.push({ task_id: task.id, error: denial });
            continue;
          }
        }
        allowedIds.push(id);
      }
      validIds = allowedIds;
    }
    if (!archived) {
      const updatedTasks = await updateTasksArchived(
        req.params.pid,
        validIds,
        false,
      );
      for (const task of updatedTasks) {
        broadcast({ type: 'task_updated', payload: task });
      }
      // Restored cards in an executable stage were skipped while archived.
      const restoreStages = getGroupStages(group);
      if (updatedTasks.some((t) => isActiveStage(restoreStages, t.status))) {
        taskQueueDrainRunner(req.params.pid, group);
      }
      return res.json({ ok: true, mergeFailures: archiveDenials });
    }

    for (const id of validIds) {
      const task = await getTask(id);
      if (!task || task.project_id !== req.params.pid || task.archived)
        continue;
      if (await isTaskRunning(task.id)) {
        archiveDenials.push({ task_id: task.id, error: ARCHIVE_RUNNING_ERROR });
        continue;
      }
      try {
        await removeWorktreeForTask(
          { ...task, branch_name: task.branch_name || `task-${task.id}` },
          group,
        );
      } catch (err) {
        if (err instanceof ConversationWorktreeInUseError) {
          return res.status(409).json({
            error: err.message,
            conversationIds: err.conversationIds,
          });
        }
        throw err;
      }
      const [updated] = await updateTasksArchived(
        req.params.pid,
        [task.id],
        true,
      );
      if (updated) broadcast({ type: 'task_updated', payload: updated });
    }

    return res.json({ ok: true, mergeFailures: archiveDenials });
  }

  let triggerDrain = false;
  let triggerDoneDrain = false;
  const stages = getGroupStages(group);
  const deployStageId = group.settings?.deployService
    ? getDeployStageId(group.settings, stages)
    : undefined;
  const deployTasks: Task[] = []; // Collect tasks moving to deploy for serialized handling
  const deployStageEntryEventIds = new Map<string, string>();
  const mergeFailures: Array<{
    task_id: string;
    error: string;
    blockers?: GitStatusEntry[];
    approval?: MergeApprovalDetails;
  }> = [];
  const lifecycleAttemptId = randomUUID();

  // Refuse the whole request up front so a denied review entry never leaves a
  // partially applied batch behind.
  if (isAgentCredential(req) && typeof status === 'string') {
    for (const id of ids) {
      const task = await getTask(id);
      if (!task || task.project_id !== req.params.pid) continue;
      const denial = agentReviewEntryDenial(stages, task, status);
      if (denial) return res.status(403).json({ error: denial });
    }
  }

  // A stuck lease or git lock must refuse the whole request before any card is
  // merged or saved, not after the cards in front of it were completed.
  if (isManualDoneTransition(status, stages)) {
    const candidates: Task[] = [];
    for (const id of ids) {
      const task = await getTask(id);
      if (!task || task.project_id !== req.params.pid) continue;
      if (isAgentCredential(req) && agentTaskUpdateDenial(stages, task, status))
        continue;
      // A running card is refused in the loop without touching the checkout.
      if (await isTaskRunning(task.id)) continue;
      candidates.push(task);
    }
    try {
      await waitForManualCompletionCheckout(candidates, group);
    } catch (err) {
      if (err instanceof CheckoutBusyError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  }

  // Set once an earlier card may have persisted anything (merge checkpoint,
  // failure notice or approval request, new stage), so the request is no
  // longer all-or-nothing and later failures must be reported per card.
  let earlierCardWroteState = false;
  for (const id of ids) {
    const task = await getTask(id);
    if (!task || task.project_id !== req.params.pid) continue;

    if (isAgentCredential(req)) {
      const denial = agentTaskUpdateDenial(stages, task, status);
      if (denial) {
        mergeFailures.push({ task_id: task.id, error: denial });
        continue;
      }
    }

    if (archived && !task.archived && (await isTaskRunning(task.id))) {
      mergeFailures.push({ task_id: task.id, error: ARCHIVE_RUNNING_ERROR });
      continue;
    }

    const updates: Record<string, unknown> = {};
    let stopRunForStageMove = false;
    let questionRetryRestartCap: boolean | undefined;
    if (status !== undefined) {
      const targetStage = findStage(stages, status);
      const currentStage = findStage(stages, task.status);
      const taskRunning = await isTaskRunning(id);
      let manuallyMergedToDone = false;
      if (isManualDoneTransition(status, stages)) {
        if (taskRunning) {
          const error =
            'Task is still running; stop it before completing and merging';
          mergeFailures.push({ task_id: task.id, error });
          continue;
        }
        let mergeResult: Awaited<
          ReturnType<typeof mergeTaskForManualCompletion>
        >;
        try {
          mergeResult = await mergeTaskForManualCompletion(task, group);
        } catch (err) {
          if (err instanceof CheckoutBusyError) {
            // Nothing is saved yet: refuse the whole request. Otherwise only
            // this card is blocked and the earlier ones stay completed.
            if (!earlierCardWroteState)
              return res.status(409).json({ error: err.message });
            mergeFailures.push({ task_id: task.id, error: err.message });
            continue;
          }
          throw err;
        }
        earlierCardWroteState = true;
        if (!mergeResult.mergeOk) {
          const approval = await appendManualMergeFailure(
            task,
            group,
            mergeResult,
          );
          mergeFailures.push({
            task_id: task.id,
            error: mergeResult.output,
            blockers: mergeResult.blockers,
            ...(approval && callerKind(req) === 'human' ? { approval } : {}),
          });
          continue;
        }
        if (mergeResult.integrationPending) {
          await appendPendingIntegrationNotice(task);
        }
        manuallyMergedToDone = true;
      }
      updates.status = status;
      questionRetryRestartCap = isManualQuestionRetry(
        stages,
        task.status,
        status,
      )
        ? callerKind(req) === 'human'
        : undefined;
      if (task.status !== status) {
        if (targetStage?.type === 'done' && currentStage?.type !== 'done') {
          updates.completed_at = new Date().toISOString();
        } else if (
          currentStage?.type === 'done' &&
          targetStage?.type !== 'done'
        ) {
          updates.completed_at = null;
        }
      }

      // If a running task is moved away from an active stage, stop it
      if (taskRunning) {
        if (!targetStage || !TASK_EXECUTION_STAGE_TYPES.has(targetStage.type)) {
          await stopTask(id);
        } else if (await isMoveAwayFromRunStage(id, task.status, status)) {
          stopRunForStageMove = true;
        }
      }

      // Check if we should trigger queue drain or deploy
      if (
        isActiveStage(stages, status) ||
        status === deployStageId ||
        isRecoveryHookStage(targetStage)
      ) {
        const triggeredByUserId = (req as any).authUser?.id ?? null;
        updates.lastTriggeredByUserId = triggeredByUserId;
        updates.lastTriggerSource = triggeredByUserId ? 'user' : 'system';
        updates.lastTriggeredAt = new Date().toISOString();
      }
      if (targetStage?.type === 'done' && task.status !== status) {
        triggerDoneDrain = true;
      }
      if (isActiveStage(stages, status)) {
        triggerDrain = true;
      } else if (status === deployStageId) {
        // Collect deploy tasks — merges and deploy will be serialized after the loop
        deployTasks.push(task);
      } else if (targetStage && !manuallyMergedToDone) {
        // Only commit branch when leaving an active stage (not inactive→inactive or active→active)
        if (
          currentStage?.type === 'active' ||
          currentStage?.type === 'testing' ||
          currentStage?.type === 'review'
        ) {
          commitBranchOnStageLeave(task, group);
        }
      }
    }

    if (archived !== undefined) {
      updates.archived = archived;
    }

    // When a task transitions to archived, clean up its worktree/preview port
    // before persisting archived=true. If an active conversation rejects the
    // removal, leaving the task unarchived ensures a retry cannot skip cleanup.
    // Key on the branch (not worktree_path, which is unreliable: it is cleared
    // on merge/reject/deploy). The worktree + nginx preview conf are keyed by
    // branch name. Synthesize a fallback so worktrees created without a stored
    // branch_name are still cleaned. Transport failures remain best-effort;
    // an active conversation is surfaced as a conflict.
    if (archived && !task.archived) {
      try {
        await removeWorktreeForTask(
          { ...task, branch_name: task.branch_name || `task-${task.id}` },
          group,
        );
      } catch (err) {
        if (err instanceof ConversationWorktreeInUseError) {
          return res.status(409).json({
            error: err.message,
            conversationIds: err.conversationIds,
          });
        }
        throw err;
      }
    }

    const stageEntryEvent = await updateTask(id, updates, {
      failureSource: 'user',
      ...(questionRetryRestartCap !== undefined
        ? {
            manualQuestionRetry: {
              restartRejectionCap: questionRetryRestartCap,
            },
          }
        : {}),
    });
    // The new execution stage is persisted: stop the old stage's run without
    // returning the card to backlog. Awaited so the drain below can claim it.
    if (stopRunForStageMove) {
      await stopTaskForStageMove(id);
    }
    if (status === deployStageId && stageEntryEvent) {
      deployStageEntryEventIds.set(id, stageEntryEvent.id);
    }

    const updated = await getTask(id);
    if (updated) {
      broadcast({ type: 'task_updated', payload: updated });
      await advanceDatasetAfterManualCompletion(task, updated, stages);
      if (
        status !== undefined &&
        task.status !== status &&
        isQuestionStage(stages, status)
      ) {
        publishTaskQuestion(updated, group, 'bulk_update');
        // Manual moves are user-initiated: no owner push.
      }
      if (
        status !== undefined &&
        task.status !== status &&
        isFailedStage(stages, status)
      ) {
        await publishTaskEventAndNotify(
          updated,
          group,
          { type: 'task_failed', source: 'bulk_update' },
          {
            group_folder: updated.project_id,
            task_id: updated.id,
            run_id: `manual-bulk:${lifecycleAttemptId}:${updated.id}`,
            event: 'failed',
            title: `Task failed: ${updated.title}`,
            defer_stage_entry: true,
            stage_entry_event_id: stageEntryEvent?.id,
          },
        );
      } else if (
        status !== undefined &&
        task.status !== status &&
        findStage(stages, status)?.type === 'done' &&
        status !== deployStageId
      ) {
        await notifyOtherOwnerOfManualCompletion(
          updated,
          authenticatedUserId(req),
          `manual-bulk:${lifecycleAttemptId}:${updated.id}`,
          stageEntryEvent?.id,
        );
      }
    }
  }

  if (triggerDrain) {
    // Moving a card into an executable stage is a user-directed retry, just
    // like the explicit Run action. Let that retry proceed immediately rather
    // than leaving it behind the automatic failure cooldown.
    resetProjectFailures(req.params.pid);
    taskQueueDrainRunner(req.params.pid, group);
  } else if (triggerDoneDrain) {
    // Dependents gated on a task that just entered a done stage can start now.
    taskQueueDrainRunner(req.params.pid, group);
  }

  // Queue all deploy tasks into the debounced deploy pipeline.
  // Tasks arriving within the debounce window are batched: branches merged
  // sequentially, then build_service called once.
  for (const t of deployTasks) {
    queueDeploy(
      t,
      group,
      `manual-bulk:${lifecycleAttemptId}:${t.id}`,
      deployStageEntryEventIds.get(t.id),
    );
  }

  res.json({ ok: mergeFailures.length === 0, mergeFailures });
});

/**
 * A human moving a dataset row's card into a done stage approves the row, so
 * the batch continues. Idempotent: the progress increment claims the exact row,
 * so duplicate moves or a racing executor completion advance the dataset once.
 */
async function advanceDatasetAfterManualCompletion(
  previous: Task,
  updated: Task,
  stages: ReturnType<typeof getGroupStages>,
): Promise<void> {
  if (previous.status === updated.status) return;
  if (!previous.dataset_task_id) return;
  if (findStage(stages, updated.status)?.type !== 'done') return;
  try {
    await onDatasetTaskCompleted(updated);
  } catch (err) {
    logger.error(
      { err, task_id: updated.id, dataset_task_id: previous.dataset_task_id },
      'Failed to advance dataset after manual task completion',
    );
  }
}

/**
 * PATCH /api/projects/:pid/tasks/:fid
 * Update a task (status, title, description, priority, runtime selection).
 */
router.patch('/projects/:pid/tasks/:fid', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (isAgentCredential(req)) {
    const group = getGroupByFolder(req.params.pid);
    const denial = agentTaskUpdateDenial(
      getGroupStages(group),
      task,
      typeof req.body?.status === 'string' ? req.body.status : undefined,
    );
    if (denial) return res.status(403).json({ error: denial });
  }

  const {
    title,
    description,
    status,
    priority,
    runtimeSelection,
    runtimeSelectionStage,
    depends_on_ids,
    execute_in_stage,
    skip_stages,
    archived,
    custom_values,
    objective_id,
  } = req.body || {};

  // Validate lengths
  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'title is required' });
    }
    const e = lenError(title, MAX_LEN.title, 'title');
    if (e) return res.status(400).json({ error: e });
  }
  if (description !== undefined) {
    if (typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be a string' });
    }
    const e = lenError(description, MAX_LEN.description, 'description');
    if (e) return res.status(400).json({ error: e });
  }
  const runtimeError = validateRuntimeSelection(runtimeSelection);
  if (runtimeError) return res.status(400).json({ error: runtimeError });
  if (runtimeSelectionStage !== undefined) {
    const stageScopeError = validateRuntimeSelectionStage(
      getGroupByFolder(req.params.pid),
      runtimeSelectionStage,
    );
    if (stageScopeError) {
      return res.status(400).json({ error: stageScopeError });
    }
  }
  if (depends_on_ids !== undefined && !isStringArray(depends_on_ids)) {
    return res
      .status(400)
      .json({ error: 'depends_on_ids must be an array of strings' });
  }

  // Validate status against project's configured stages
  if (status !== undefined) {
    const group = getGroupByFolder(req.params.pid);
    const stages = getGroupStages(group);
    if (!findStage(stages, status)) {
      const validIds = stages.map((s) => s.id).join(', ');
      return res.status(400).json({
        error: `Invalid status "${status}". Valid stages: ${validIds}`,
      });
    }
  }

  // Validate dependencies for circular references
  if (depends_on_ids !== undefined && depends_on_ids.length > 0) {
    if (depends_on_ids.includes(req.params.fid)) {
      return res.status(400).json({ error: 'A task cannot depend on itself' });
    }
    // IDs already on the task stay tolerated (a UI resend of a stored, even
    // dangling, dependency); only newly added ones must exist.
    const existingDeps = new Set(task.depends_on_ids ?? []);
    try {
      await assertDependenciesExist(
        depends_on_ids.filter((id: string) => !existingDeps.has(id)),
      );
    } catch (error) {
      if (sendTaskWriteError(res, error)) return;
      throw error;
    }
    if (
      await hasCircularDependency(
        req.params.pid,
        req.params.fid,
        depends_on_ids,
      )
    ) {
      return res.status(400).json({ error: 'Circular dependency detected' });
    }
  }

  // Reject cross-project dependency edges before the lifecycle actions below
  // (branch merge on manual completion, worktree removal on archive) run, so
  // a rejected update cannot leave merged branches or removed worktrees
  // behind. updateTask revalidates under the task write lock as the
  // authoritative check.
  if (depends_on_ids !== undefined) {
    try {
      await validateSameProjectDependencies(
        req.params.fid,
        task.project_id,
        depends_on_ids,
      );
    } catch (error) {
      if (error instanceof CrossProjectDependencyError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      throw error;
    }
  }

  // Guard: reject description updates on tasks with an active run
  if (description !== undefined && (await isTaskRunning(req.params.fid))) {
    return res.status(409).json({
      error: `Cannot update description of task ${req.params.fid} — it is currently being executed by an agent. Create a follow-up task instead.`,
    });
  }

  if (priority !== undefined && typeof priority !== 'number') {
    return res.status(400).json({ error: 'priority must be a number' });
  }
  if (
    archived !== undefined &&
    typeof archived !== 'boolean' &&
    archived !== 0 &&
    archived !== 1
  ) {
    return res.status(400).json({ error: 'archived must be a boolean' });
  }
  // Archiving removes the worktree with --force, which would discard the live
  // run's uncommitted work. Refuse before any merge or write.
  if (archived && !task.archived && (await isTaskRunning(req.params.fid))) {
    return res.status(409).json({ error: ARCHIVE_RUNNING_ERROR });
  }
  if (custom_values !== undefined) {
    if (custom_values !== null && !isRecord(custom_values)) {
      return res
        .status(400)
        .json({ error: 'custom_values must be an object or null' });
    }
    const cvJson = JSON.stringify(custom_values);
    if (cvJson.length > MAX_LEN.description) {
      return res.status(400).json({
        error: `custom_values must be at most ${MAX_LEN.description} characters when serialized`,
      });
    }
  }
  const patchDenial =
    custom_values === undefined
      ? null
      : pipelineOwnedValuesDenial(req.tokenScope, custom_values, task.id);
  if (patchDenial) return res.status(403).json({ error: patchDenial });

  const updates: Record<string, unknown> = {};
  let manuallyMergedToDone = false;
  let questionRetryRestartCap: boolean | undefined;
  const lifecycleAttemptId = randomUUID();

  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  if (priority !== undefined) updates.priority = priority;
  if (runtimeSelection !== undefined)
    updates.runtimeSelection = runtimeSelection;
  if (runtimeSelectionStage !== undefined)
    updates.runtimeSelectionStage = runtimeSelectionStage;
  if (depends_on_ids !== undefined) updates.depends_on_ids = depends_on_ids;
  if (execute_in_stage !== undefined)
    updates.execute_in_stage = execute_in_stage;
  if (skip_stages !== undefined) {
    // Light validation: accept null to clear, or an array of strings.
    // Unknown IDs are tolerated (project stage config can change).
    if (skip_stages === null) {
      updates.skip_stages = null;
    } else if (Array.isArray(skip_stages)) {
      updates.skip_stages = filterStringValues(skip_stages);
      if (isAgentCredential(req)) {
        const addedGated = addedGatedSkipStages(
          getGroupStages(getGroupByFolder(req.params.pid)),
          task.skip_stages,
          updates.skip_stages as string[],
        );
        if (addedGated.length > 0) {
          return res
            .status(403)
            .json({ error: gatedSkipStagesDenial(addedGated) });
        }
      }
    } else {
      return res
        .status(400)
        .json({ error: 'skip_stages must be an array of strings or null' });
    }
  }
  if (archived !== undefined) updates.archived = archived ? 1 : 0;
  if (custom_values !== undefined) updates.custom_values = custom_values;
  if (objective_id !== undefined) {
    // An unchanged tag stays editable even if its owner's access has changed.
    if (objective_id !== task.objective_id) {
      const objectiveError = await objectiveTagError(
        req,
        task.project_id,
        objective_id,
      );
      if (objectiveError) {
        return res
          .status(objectiveError.status)
          .json({ error: objectiveError.error });
      }
    }
    updates.objective_id = objective_id ?? null;
  }
  const rawCoStages =
    req.body?.co_stages !== undefined ? req.body.co_stages : req.body?.coStages;
  if (rawCoStages !== undefined) {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const coStagesResult = validateCoStages(group, rawCoStages);
    if (!coStagesResult.valid) {
      return res.status(400).json({ error: coStagesResult.error });
    }
    if (await isTaskRunning(req.params.fid)) {
      return res.status(409).json({
        error: `co_stages cannot be changed while task ${req.params.fid} is claimed for or under execution.`,
      });
    }
    updates.co_stages = coStagesResult.coStages;
  }
  const rawAbVariants =
    req.body?.ab_variants !== undefined
      ? req.body.ab_variants
      : req.body?.abVariants;
  const rawStageVariant =
    req.body?.stage_variant !== undefined
      ? req.body.stage_variant
      : req.body?.stageVariant;
  let taskQueueStageIds: string[] | undefined;
  if (rawStageVariant !== undefined) {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const stages = getGroupStages(group);
    const stageVariantResult = validateStageVariant(group, rawStageVariant);
    if (!stageVariantResult.valid) {
      return res.status(400).json({ error: stageVariantResult.error });
    }
    if (stageVariantResult.variant && rawAbVariants?.length) {
      return res
        .status(400)
        .json({ error: 'stage_variant and ab_variants cannot both be set' });
    }
    if (findStage(stages, task.status)?.type !== 'queue') {
      return res.status(400).json({
        error: `stage_variant can only be changed while task ${req.params.fid} is in a queue stage.`,
      });
    }
    if (await isTaskRunning(req.params.fid)) {
      return res.status(409).json({
        error: `stage_variant cannot be changed while task ${req.params.fid} is claimed for or under execution.`,
      });
    }
    updates.stage_variant = stageVariantResult.variant;
    taskQueueStageIds = stages
      .filter((s) => s.type === 'queue')
      .map((s) => s.id);
  }
  if (rawAbVariants !== undefined) {
    const group = getGroupByFolder(req.params.pid);
    if (!group) return res.status(404).json({ error: 'Project not found' });
    const stages = getGroupStages(group);
    const abResult = validateAbVariants(group, rawAbVariants, task, stages);
    if (!abResult.valid) {
      return res.status(400).json({ error: abResult.error });
    }
    updates.ab_variants = abResult.variants;
    taskQueueStageIds = stages
      .filter((s) => s.type === 'queue')
      .map((s) => s.id);
  }

  // Reserves the card from the running check until the done status is written,
  // so the queue cannot start a run while the merge waits for the checkout.
  let manualCompletionClaim: AbortController | null = null;
  let manualCompletionWritten = false;
  let stageEntryEventId: string | undefined;
  try {
    if (status !== undefined) {
      const group = getGroupByFolder(req.params.pid);
      const stages = getGroupStages(group);
      const deployStageId = group?.settings?.deployService
        ? getDeployStageId(group.settings, stages)
        : undefined;
      const currentStage = findStage(stages, task.status);
      const targetStage = findStage(stages, status);
      if (
        isActiveStage(stages, status) ||
        status === deployStageId ||
        isRecoveryHookStage(targetStage)
      ) {
        const triggeredByUserId = (req as any).authUser?.id ?? null;
        updates.lastTriggeredByUserId = triggeredByUserId;
        updates.lastTriggerSource = triggeredByUserId ? 'user' : 'system';
        updates.lastTriggeredAt = new Date().toISOString();
      }
      if (isManualQuestionRetry(stages, task.status, status)) {
        questionRetryRestartCap = callerKind(req) === 'human';
      }
      if (task.status !== status) {
        if (targetStage?.type === 'done' && currentStage?.type !== 'done') {
          updates.completed_at = new Date().toISOString();
        } else if (
          currentStage?.type === 'done' &&
          targetStage?.type !== 'done'
        ) {
          updates.completed_at = null;
        }
      }
      if (group && isManualDoneTransition(status, stages)) {
        if (await isTaskRunning(task.id)) {
          return res.status(409).json({
            error:
              'Task is still running; stop it before completing and merging',
          });
        }
        manualCompletionClaim = claimTaskReset(task.id, task.project_id);
        if (!manualCompletionClaim) {
          return res.status(409).json({
            error:
              'Task is still running; stop it before completing and merging',
          });
        }
        let mergeResult: Awaited<
          ReturnType<typeof mergeTaskForManualCompletion>
        >;
        try {
          mergeResult = await mergeTaskForManualCompletion(task, group);
        } catch (err) {
          if (err instanceof CheckoutBusyError) {
            return res.status(409).json({ error: err.message });
          }
          throw err;
        }
        if (!mergeResult.mergeOk) {
          const approval = await appendManualMergeFailure(
            task,
            group,
            mergeResult,
          );
          return res.status(409).json({
            error: 'Task branch could not be merged; status was not changed',
            details: mergeResult.output,
            blockers: mergeResult.blockers,
            ...(approval && callerKind(req) === 'human' ? { approval } : {}),
          });
        }
        if (mergeResult.integrationPending) {
          await appendPendingIntegrationNotice(task);
        }
        manuallyMergedToDone = true;
      }
    }

    // When a task transitions to archived, clean up its worktree/preview port
    // before persisting archived=true. If removal is rejected, the task must
    // remain unarchived so the next archive attempt retries the lifecycle step.
    // The worktree + nginx preview conf are keyed by branch name. Synthesize
    // the same fallback used by delete and archive_task for legacy tasks whose
    // branch_name was not persisted. Transport failures remain best-effort;
    // an active conversation is surfaced as a conflict.
    if (archived && !task.archived) {
      const group = getGroupByFolder(task.project_id);
      if (group) {
        try {
          await removeWorktreeForTask(
            { ...task, branch_name: task.branch_name || `task-${task.id}` },
            group,
          );
        } catch (err) {
          if (err instanceof ConversationWorktreeInUseError) {
            return res.status(409).json({
              error: err.message,
              conversationIds: err.conversationIds,
            });
          }
          throw err;
        }
      }
    }

    try {
      const touchesAbVariants =
        rawAbVariants !== undefined || rawStageVariant !== undefined;
      // ab_variants, stage_variant and co_stages commit under the execution-claim
      // guard; only ab_variants and stage_variant also require a queue stage.
      const touchesClaimGuarded =
        touchesAbVariants || rawCoStages !== undefined;
      const doUpdate = () =>
        updateTask(req.params.fid, updates, {
          failureSource: 'user',
          ...(custom_values !== undefined
            ? {
                preservePipelineOwnedValues: !!req.tokenScope?.task_id,
                preserveCustomValueKeys: DEPLOY_HANDOFF_VALUE_KEYS,
              }
            : {}),
          ...(questionRetryRestartCap !== undefined
            ? {
                manualQuestionRetry: {
                  restartRejectionCap: questionRetryRestartCap,
                },
              }
            : {}),
          ...(touchesAbVariants
            ? { requireStageVariantStatuses: taskQueueStageIds }
            : {}),
          ...(touchesClaimGuarded
            ? {
                isExecutionClaimed: () =>
                  manualCompletionClaim
                    ? isTaskExecutionClaimedByOther(
                        req.params.fid,
                        manualCompletionClaim,
                      )
                    : isTaskExecutionClaimed(req.params.fid),
              }
            : {}),
        });
      stageEntryEventId = (
        touchesClaimGuarded
          ? await withStageVariantWriteLock(req.params.fid, doUpdate)
          : await doUpdate()
      )?.id;
      manualCompletionWritten = true;
    } catch (error) {
      if (sendTaskWriteError(res, error)) return;
      throw error;
    }
  } finally {
    if (manualCompletionClaim) {
      releaseTaskExecutionClaim(task.id, manualCompletionClaim);
      if (!manualCompletionWritten) {
        const group = getGroupByFolder(req.params.pid);
        if (group) taskQueueDrainRunner(req.params.pid, group);
      }
    }
  }

  const dependencyWarnings = await warnOnUncontainedDependencies(
    task,
    getGroupByFolder(req.params.pid),
    depends_on_ids,
  );

  const descriptionForMessage =
    typeof description === 'string' ? description.trim() : '';
  if (
    descriptionForMessage &&
    (status !== undefined || description !== task.description)
  ) {
    // If this is the first message and the task had an original description,
    // save it as the initial message so the full conversation history is preserved.
    const existingMessages = await readTaskMessagesAsync(
      req.params.pid,
      req.params.fid,
    );
    if (
      existingMessages.length === 0 &&
      task.description?.trim() &&
      task.description.trim() !== descriptionForMessage
    ) {
      const initialMsg = await appendTaskMessageDurableAsync(req.params.pid, {
        task_id: req.params.fid,
        role: 'user',
        content: task.description.trim(),
        created_at: task.created_at,
      });
      broadcast({
        type: 'task_message',
        payload: {
          task_id: req.params.fid,
          project_id: req.params.pid,
          message: initialMsg,
        },
      });
    }

    const userMsg = await appendTaskMessageDurableAsync(req.params.pid, {
      task_id: req.params.fid,
      role: 'user',
      content: descriptionForMessage,
      created_at: new Date().toISOString(),
    });
    broadcast({
      type: 'task_message',
      payload: {
        task_id: req.params.fid,
        project_id: req.params.pid,
        message: userMsg,
      },
    });
  }

  const updated = await getTask(req.params.fid);
  if (updated) {
    broadcast({ type: 'task_updated', payload: updated });
    const group = getGroupByFolder(req.params.pid);
    if (group && status !== undefined) {
      await advanceDatasetAfterManualCompletion(
        task,
        updated,
        getGroupStages(group),
      );
    }
    if (
      group &&
      status !== undefined &&
      task.status !== status &&
      isQuestionStage(getGroupStages(group), status)
    ) {
      publishTaskQuestion(updated, group, 'manual_update');
      // Manual moves are user-initiated: no owner push.
    }
    if (
      group &&
      status !== undefined &&
      task.status !== status &&
      isFailedStage(getGroupStages(group), status)
    ) {
      await publishTaskEventAndNotify(
        updated,
        group,
        { type: 'task_failed', source: 'manual_update' },
        {
          group_folder: updated.project_id,
          task_id: updated.id,
          run_id: `manual:${lifecycleAttemptId}:${updated.id}`,
          event: 'failed',
          title: `Task failed: ${updated.title}`,
          defer_stage_entry: true,
          stage_entry_event_id: stageEntryEventId,
        },
      );
    } else if (
      group &&
      status !== undefined &&
      task.status !== status &&
      findStage(getGroupStages(group), status)?.type === 'done' &&
      status !==
        (group.settings?.deployService
          ? getDeployStageId(group.settings, getGroupStages(group))
          : undefined)
    ) {
      await notifyOtherOwnerOfManualCompletion(
        updated,
        authenticatedUserId(req),
        `manual:${lifecycleAttemptId}:${updated.id}`,
        stageEntryEventId,
      );
    }
  }

  // If a running task is moved away from an active stage, stop it
  if (status !== undefined && (await isTaskRunning(req.params.fid))) {
    const group = getGroupByFolder(req.params.pid);
    if (group) {
      const stages = getGroupStages(group);
      const targetStage = findStage(stages, status);
      if (targetStage && !TASK_EXECUTION_STAGE_TYPES.has(targetStage.type)) {
        await stopTask(req.params.fid);
      } else if (
        targetStage &&
        (await isMoveAwayFromRunStage(req.params.fid, task.status, status))
      ) {
        // The new execution stage is persisted: stop the old stage's run
        // without returning the card to backlog. Awaited so the drain below
        // claims the task for the new stage.
        await stopTaskForStageMove(req.params.fid);
      }
    }
  }

  // When a task is moved to an active stage, trigger queue drain, otherwise commit
  if (status !== undefined) {
    const group = getGroupByFolder(req.params.pid);
    if (group && task) {
      const stages = getGroupStages(group);
      const targetStage = findStage(stages, status);
      const deployStageId = group.settings?.deployService
        ? getDeployStageId(group.settings, stages)
        : undefined;
      if (isActiveStage(stages, status)) {
        // A manual move back to an executable stage is an explicit retry.
        // Reset the automatic failure circuit breaker before draining it.
        resetProjectFailures(req.params.pid);
        taskQueueDrainRunner(req.params.pid, group);
      } else if (status === deployStageId) {
        // Queue into debounced deploy pipeline (merge + build batched)
        queueDeploy(
          task,
          group,
          `manual:${lifecycleAttemptId}:${task.id}`,
          stageEntryEventId,
        );
      } else if (targetStage && !manuallyMergedToDone) {
        // Only commit branch when leaving an active stage (not inactive→inactive or active→active)
        const currentStage = findStage(stages, task.status);
        if (
          currentStage?.type === 'active' ||
          currentStage?.type === 'testing' ||
          currentStage?.type === 'review'
        ) {
          commitBranchOnStageLeave(task, group);
        }
      }
      // A card entering a done stage releases dependents gated on it; drain
      // so they start now rather than waiting for an unrelated trigger.
      if (targetStage?.type === 'done' && task.status !== status) {
        taskQueueDrainRunner(req.params.pid, group);
      }
    }
  }

  // A restore without a stage move skips the status branch above; wake the
  // queue so a restored executable-stage card starts now.
  if (
    status === undefined &&
    archived !== undefined &&
    !archived &&
    task.archived
  ) {
    const group = getGroupByFolder(req.params.pid);
    if (group && isActiveStage(getGroupStages(group), task.status)) {
      taskQueueDrainRunner(req.params.pid, group);
    }
  }

  res.json(
    updated && dependencyWarnings.length > 0
      ? { ...updated, warnings: dependencyWarnings }
      : updated,
  );
});

/**
 * POST /api/projects/:pid/tasks/:fid/description/draft
 * One-shot LLM draft of a rewritten task description.
 *
 * Takes the task's current description plus a short user instruction (and
 * optional prior refine turns) and returns a full replacement draft as
 * plain markdown. Never writes to the DB — the UI applies the draft
 * through the existing description update route.
 */
const MAX_DRAFT_HISTORY_TURNS = 20;

router.post('/projects/:pid/tasks/:fid/description/draft', async (req, res) => {
  // The project must still be registered: the project-access middleware
  // lets admins through without an existence check, and task rows can
  // outlive project unregistration (retained rows).
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const body = (req.body ?? {}) as Partial<TaskDescriptionDraftRequest>;
  const { instruction, history } = body;

  if (typeof instruction !== 'string' || instruction.trim() === '') {
    return res.status(400).json({
      error: 'instruction is required and must be a non-empty string',
    });
  }
  const instructionError = lenError(
    instruction,
    MAX_LEN.description,
    'instruction',
  );
  if (instructionError)
    return res.status(400).json({ error: instructionError });

  let historyEntries: TaskDescriptionDraftHistoryEntry[] | undefined;
  if (history !== undefined) {
    if (!Array.isArray(history)) {
      return res.status(400).json({
        error: 'history must be an array of { instruction, draft } objects',
      });
    }
    if (history.length > MAX_DRAFT_HISTORY_TURNS) {
      return res.status(400).json({
        error: `history must contain at most ${MAX_DRAFT_HISTORY_TURNS} entries`,
      });
    }
    let totalChars = 0;
    for (const entry of history) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        typeof entry.instruction !== 'string' ||
        entry.instruction.trim() === '' ||
        typeof entry.draft !== 'string' ||
        entry.draft.trim() === ''
      ) {
        return res.status(400).json({
          error:
            'each history entry must be an object with non-empty string instruction and draft fields',
        });
      }
      const entryError =
        lenError(
          entry.instruction,
          MAX_LEN.description,
          'history[].instruction',
        ) || lenError(entry.draft, MAX_LEN.description, 'history[].draft');
      if (entryError) return res.status(400).json({ error: entryError });
      totalChars += entry.instruction.length + entry.draft.length;
    }
    if (totalChars > MAX_LEN.description) {
      return res.status(400).json({
        error: `history must be at most ${MAX_LEN.description} characters in total`,
      });
    }
    historyEntries = history;
  }

  try {
    const { draft } = await draftTaskDescription(
      {
        title: task.title,
        description: task.description,
        instruction,
        history: historyEntries,
        projectId: req.params.pid,
      },
      getDescriptionDraftInvoker(),
    );
    return res.json({ draft });
  } catch (error) {
    logger.warn(
      { fid: req.params.fid, pid: req.params.pid, err: String(error) },
      'Description draft failed',
    );
    const message = error instanceof Error ? error.message : String(error);
    return res.status(502).json({
      error: `Could not generate a description draft: ${message}`,
    });
  }
});

/**
 * POST /api/projects/:pid/tasks/:fid/messages
 * Append a user message to a task's chat without changing its stage.
 */
router.post('/projects/:pid/tasks/:fid/messages', async (req, res) => {
  const admission = beginTaskSteeringAdmission(req.params.fid);
  let task: Task | undefined;
  try {
    task = await getTask(req.params.fid);
  } catch (error) {
    endTaskSteeringAdmission(admission);
    throw error;
  }
  if (!task || task.project_id !== req.params.pid) {
    endTaskSteeringAdmission(admission);
    return res.status(404).json({ error: 'Task not found' });
  }

  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    endTaskSteeringAdmission(admission);
    return res.status(400).json({ error: 'content (string) is required' });
  }
  const msgErr = lenError(content, MAX_LEN.message, 'content');
  if (msgErr) {
    endTaskSteeringAdmission(admission);
    return res.status(400).json({ error: msgErr });
  }

  // Preserve the existing idle follow-up contract. The client always sends
  // steering intent so a claim that appears between render and submission can
  // still receive the prompt, but only a server-observed presented claim/run
  // owns durable steering state and its continuation barrier.
  let taskRunning: boolean;
  try {
    taskRunning = await isTaskRunning(task.id);
  } catch (error) {
    endTaskSteeringAdmission(admission);
    throw error;
  }
  try {
    if (taskMessageRunningCheckHook) {
      await taskMessageRunningCheckHook(task.id, taskRunning);
    }
  } catch (error) {
    endTaskSteeringAdmission(admission);
    throw error;
  }
  if (!taskRunning) {
    try {
      await updateTask(
        task.id,
        { custom_values: { [TESTING_FAILURE_COUNT_KEY]: 0 } },
        { mergeCustomValues: true },
      );
      const userMessage = await appendTaskMessageDurableAsync(req.params.pid, {
        task_id: req.params.fid,
        role: 'user',
        content: content.trim(),
        created_at: new Date().toISOString(),
      });
      broadcast({
        type: 'task_message',
        payload: {
          task_id: req.params.fid,
          project_id: req.params.pid,
          message: userMessage,
        },
      });
      return res.json(userMessage);
    } finally {
      endTaskSteeringAdmission(admission);
    }
  }

  let steering: TaskSteeringResult;
  try {
    steering = await appendTaskSteeringMessage(
      req.params.pid,
      req.params.fid,
      content.trim(),
      async () => {
        await updateTask(
          task.id,
          { custom_values: { [TESTING_FAILURE_COUNT_KEY]: 0 } },
          { mergeCustomValues: true },
        );
      },
      admission,
    );
  } finally {
    endTaskSteeringAdmission(admission);
  }
  broadcast({
    type: 'task_message',
    payload: {
      task_id: req.params.fid,
      project_id: req.params.pid,
      message: steering.message,
    },
  });
  if (steering.receipt) {
    broadcast({
      type: 'task_message',
      payload: {
        task_id: req.params.fid,
        project_id: req.params.pid,
        message: steering.receipt,
      },
    });
  }
  if (steering.continuationDrainRequired) {
    const group = getGroupByFolder(req.params.pid);
    if (group) void drainProjectQueue(req.params.pid, group);
  }
  return res.json({
    ...steering.message,
    delivery: steering.accepted ? 'steered' : 'queued',
    run_id: steering.receipt?.run_id ?? null,
  });
});

/**
 * POST /api/projects/:pid/tasks/:fid/messages/codex-answer
 * Answer an askuserquestion request in the task's active agent run.
 */
router.post(
  '/projects/:pid/tasks/:fid/messages/codex-answer',
  async (req, res) => {
    const task = await getTask(req.params.fid);
    if (!task || task.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const requestId =
      typeof req.body?.requestId === 'string' ? req.body.requestId : '';
    const answers = req.body?.answers;
    const content =
      typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!requestId || !answers || typeof answers !== 'object' || !content) {
      return res.status(400).json({
        error: 'requestId, answers, and content are required',
      });
    }
    const msgErr = lenError(content, MAX_LEN.message, 'content');
    if (msgErr) return res.status(400).json({ error: msgErr });

    const accepted = await answerTaskAgentUserInput(
      req.params.fid,
      requestId,
      answers,
    );
    if (!accepted) return res.status(409).json({ ok: false });

    await updateTask(
      task.id,
      { custom_values: { [TESTING_FAILURE_COUNT_KEY]: 0 } },
      { mergeCustomValues: true },
    );
    const userMsg = await appendTaskMessageDurableAsync(req.params.pid, {
      task_id: req.params.fid,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    });
    broadcast({
      type: 'task_message',
      payload: {
        task_id: req.params.fid,
        project_id: req.params.pid,
        message: userMsg,
      },
    });
    return res.json({ ok: true, message: userMsg });
  },
);

/**
 * POST /api/projects/:pid/tasks/bulk-execute
 * Start execution for multiple tasks.
 */
router.post('/projects/:pid/tasks/bulk-execute', async (req, res) => {
  const { ids } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids (array) is required' });
  }

  const group = getGroupByFolder(req.params.pid);
  if (!group) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const projectStatus = group.settings?.status ?? 'running';
  if (projectStatus === 'stopped' || projectStatus === 'paused') {
    return res.status(409).json({ error: `Project is ${projectStatus}` });
  }

  const stages = getGroupStages(group);
  let startedCount = 0;
  const denied: Array<{ task_id: string; error: string }> = [];

  for (const id of ids) {
    const task = await getTask(id);
    if (!task || task.project_id !== req.params.pid) continue;
    if (isAgentCredential(req)) {
      const denial = agentTaskUpdateDenial(stages, task, undefined);
      if (denial) {
        denied.push({ task_id: task.id, error: denial });
        continue;
      }
    }
    if (await isTaskRunning(id)) continue;

    const stage = findStage(stages, task.status);
    if (stage?.type === 'done') continue;

    // Skip tasks with unmet dependencies
    if ((await getUnmetDependencies(task)).length > 0) continue;

    const triggeredByUserId = (req as any).authUser?.id ?? null;
    const triggerSource = triggeredByUserId ? 'user' : 'system';
    let provisionalClaim: AbortController | null = null;
    const admission = await claimNormalTaskAdmission(
      task.project_id,
      (taskCheckoutMode) => {
        provisionalClaim = claimTaskExecution(
          task.id,
          task.project_id,
          taskCheckoutMode === 'worktree',
        );
        return provisionalClaim;
      },
      false,
      task.id,
      group.settings?.taskCheckoutMode ?? 'shared',
      (claim) => releaseTaskExecutionClaim(task.id, claim),
    );
    if (admission.blockedByEntry || !admission.claim) continue;
    const executionClaim = admission.claim;
    group.settings = {
      ...(group.settings ?? {}),
      taskCheckoutMode: admission.taskCheckoutMode,
    };
    let attributedTask: Task;
    try {
      await updateTask(task.id, {
        lastTriggeredByUserId: triggeredByUserId,
        lastTriggerSource: triggerSource,
        lastTriggeredAt: new Date().toISOString(),
      });
      attributedTask = (await getTask(task.id)) ?? task;
    } catch (err) {
      releaseTaskExecutionClaim(task.id, executionClaim);
      await releaseTaskAdmission(
        task.project_id,
        task.id,
        admission.ownerToken,
      );
      throw err;
    }

    executeTask(attributedTask, group, {
      executionClaim,
      admissionOwnerToken: admission.ownerToken,
      triggerAttribution: { triggeredByUserId, triggerSource },
    }).catch((err) => {
      logger.error(
        { task_id: task.id, error: String(err) },
        'Unhandled bulk execute error',
      );
    });
    startedCount++;
  }

  res.json({ ok: true, startedCount, denied });
});

/**
 * POST /api/projects/:pid/tasks/bulk-stop
 * Stop multiple running tasks.
 */
router.post('/projects/:pid/tasks/bulk-stop', async (req, res) => {
  if (isAgentCredential(req)) {
    return res.status(403).json({ error: AGENT_DELETE_STOP_ERROR });
  }
  const { ids } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids (array) is required' });
  }

  let stoppedCount = 0;
  for (const id of ids) {
    const task = await getTask(id);
    if (!task || task.project_id !== req.params.pid) continue;
    if (await stopTask(id)) {
      stoppedCount++;
    }
  }

  res.json({ ok: true, stoppedCount });
});

/**
 * Order cards so a card comes before the selected cards it depends on: a
 * dependency's branch must still exist when its dependent's reset base is
 * resolved. Unrelated cards keep their order; a cycle falls back to it.
 */
function dependentsFirst(tasks: Task[]): Task[] {
  const remaining = [...tasks];
  const ordered: Task[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex(
      (candidate) =>
        !remaining.some(
          (other) =>
            other !== candidate && other.depends_on_ids?.includes(candidate.id),
        ),
    );
    if (index < 0) return [...ordered, ...remaining];
    ordered.push(...remaining.splice(index, 1));
  }
  return ordered;
}

/**
 * POST /api/projects/:pid/tasks/bulk-start-over
 * Start over several queue-stage cards at once (human only). Every eligible
 * card is reset like `execute?reset=true` and moved to the first executable
 * stage; the queue is drained once afterwards and starts them.
 */
router.post('/projects/:pid/tasks/bulk-start-over', async (req, res) => {
  if (isAgentCredential(req)) {
    return res.status(403).json({ error: AGENT_START_OVER_ERROR });
  }
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids (array) is required' });
  }
  const group = getGroupByFolder(req.params.pid);
  if (!group) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const stages = getGroupStages(group);
  const targetStage = getFirstExecutableStage(stages);
  if (!targetStage) {
    return res
      .status(400)
      .json({ error: 'No active stage available to re-run task.' });
  }

  const skipped: Array<{
    task_id: string;
    reason: 'not_found' | 'not_queue_stage' | 'running';
  }> = [];
  const eligible: Task[] = [];
  for (const id of new Set<unknown>(ids)) {
    const task = typeof id === 'string' ? await getTask(id) : undefined;
    if (!task || task.project_id !== req.params.pid) {
      skipped.push({ task_id: String(id), reason: 'not_found' });
    } else if (findStage(stages, task.status)?.type !== 'queue') {
      skipped.push({ task_id: task.id, reason: 'not_queue_stage' });
    } else if (await isTaskRunning(task.id)) {
      skipped.push({ task_id: task.id, reason: 'running' });
    } else {
      eligible.push(task);
    }
  }

  const triggeredByUserId = (req as any).authUser?.id ?? null;
  const triggerSource = triggeredByUserId ? 'user' : 'system';
  const reset: string[] = [];
  const failed: Array<{
    task_id: string;
    error: string;
    conversationIds?: string[];
  }> = [];
  for (const task of dependentsFirst(eligible)) {
    // Same refusal as the single route: the pipeline drops forked A/B parents.
    if (isForkedAbParent(task)) {
      failed.push({ task_id: task.id, error: FORKED_AB_PARENT_ERROR });
      continue;
    }
    try {
      const outcome = await startOverTask(task, group, {
        targetStageId: targetStage.id,
        triggeredByUserId,
        triggerSource,
      });
      if (outcome.ok) {
        reset.push(task.id);
      } else {
        failed.push({
          task_id: task.id,
          error: outcome.error,
          ...(outcome.conversationIds
            ? { conversationIds: outcome.conversationIds }
            : {}),
        });
      }
    } catch (err) {
      failed.push({ task_id: task.id, error: (err as Error).message });
    }
  }

  if (reset.length > 0) {
    // Start over is a user-directed retry: clear the automatic failure
    // circuit breaker once for the batch, then let the queue start the cards.
    resetProjectFailures(req.params.pid);
    void taskQueueDrainRunner(req.params.pid, group);
  }
  res.json({ ok: true, reset, skipped, failed });
});

/**
 * DELETE /api/projects/:pid/tasks/:fid
 * Delete a task.
 */
router.delete('/projects/:pid/tasks/:fid', async (req, res) => {
  if (isAgentCredential(req)) {
    return res.status(403).json({ error: AGENT_DELETE_STOP_ERROR });
  }
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (await isTaskRunning(req.params.fid)) {
    await stopTask(req.params.fid);
    // Give it a brief moment to cancel/clean up
    await sleep(500);
  }

  // Clean up worktree before deleting the task record.
  // Synthesize a branch name fallback so removal still happens for tasks that
  // never had an explicit branch_name (the helper early-returns without one).
  const group = getGroupByFolder(task.project_id);
  if (group) {
    try {
      await removeWorktreeForTask(
        { ...task, branch_name: task.branch_name || `task-${task.id}` },
        group,
      );
    } catch (err) {
      if (err instanceof ConversationWorktreeInUseError) {
        return res.status(409).json({
          error: err.message,
          conversationIds: err.conversationIds,
        });
      }
      throw err;
    }
  }

  // Erase the transcript first: if an archived copy cannot be scrubbed the
  // task record stays, so the user can retry instead of orphaning the content.
  try {
    await deleteTaskTranscript(req.params.pid, req.params.fid);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
  await deleteTask(req.params.fid);

  // Clean up dangling dependency references in other tasks
  const siblings = await getTasksByProject(req.params.pid);
  let dependenciesReleased = false;
  for (const sibling of siblings) {
    if (
      sibling.depends_on_ids &&
      sibling.depends_on_ids.includes(req.params.fid)
    ) {
      await updateTask(sibling.id, {
        depends_on_ids: sibling.depends_on_ids.filter(
          (id) => id !== req.params.fid,
        ),
      });
      dependenciesReleased = true;
    }
  }
  // A dependent held as dependencies_pending:<id> can start now.
  if (dependenciesReleased && group) {
    taskQueueDrainRunner(req.params.pid, group);
  }

  broadcast({
    type: 'task_deleted',
    payload: { task_id: req.params.fid, project_id: req.params.pid },
  });
  logger.info({ task_id: req.params.fid }, 'Task deleted');

  res.json({ ok: true });
});

/**
 * POST /api/projects/:pid/tasks/:fid/ab/winner  { taskId }
 * Pick the winning variant of an A/B experiment (`:fid` is the experiment
 * parent). Merges only that variant's branch and completes the parent. Picking
 * a winner is a user decision: agent credentials are refused.
 */
router.post('/projects/:pid/tasks/:fid/ab/winner', async (req, res) => {
  if (isAgentCredential(req)) {
    return res
      .status(403)
      .json({ error: 'Agents cannot pick an A/B experiment winner' });
  }
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  const taskId = req.body?.taskId;
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return res.status(400).json({ error: 'taskId is required' });
  }
  try {
    const parent = await pickAbWinner(group, req.params.fid, taskId.trim(), {
      drainQueue: (projectId, g) => taskQueueDrainRunner(projectId, g),
    });
    return res.json(parent);
  } catch (error) {
    if (error instanceof AbWinnerError) {
      return res.status(error.statusCode).json({
        error: error.message,
        ...(error.approval && callerKind(req) === 'human'
          ? { approval: error.approval }
          : {}),
      });
    }
    throw error;
  }
});

/**
 * GET /api/projects/:pid/tasks/:fid/messages
 * List chat messages for a task.
 * Supports optional `limit` and `offset` query params for pagination.
 * When paginating, returns { messages, total, hasMore, nextOffset }.
 * When no pagination params are provided, returns all messages as a plain array.
 */
router.get('/projects/:pid/tasks/:fid/messages', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const { limit: rawLimit, offset: rawOffset } = req.query;
  if (rawLimit !== undefined || rawOffset !== undefined) {
    const parsedLimit = parseInt(String(rawLimit ?? '20'), 10);
    const parsedOffset = parseInt(String(rawOffset ?? '0'), 10);
    // Invalid query values must not turn into NaN pagination arguments. A
    // NaN limit/offset can make the DB query fail instead of returning the
    // first page, which is the useful and consistent fallback here.
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(1, parsedLimit), 200)
      : 20;
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(0, parsedOffset)
      : 0;
    const { messages, total } = await readTaskMessagesPageAsync(
      req.params.pid,
      req.params.fid,
      limit,
      offset,
    );
    const hasMore = offset + limit < total;
    return res.json({
      messages,
      total,
      hasMore,
      nextOffset: hasMore ? offset + limit : total,
    });
  }
  res.json(await readTaskMessagesAsync(req.params.pid, req.params.fid));
});
/**
 * GET /api/projects/:pid/tasks/:fid/output
 * Return a bounded newest-last page of the persisted assistant output.
 * `offset=0` is the newest page; increase it to load older output.
 */
router.get('/projects/:pid/tasks/:fid/output', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const parsedLimit = Number.parseInt(String(req.query.limit ?? '32768'), 10);
  const parsedOffset = Number.parseInt(String(req.query.offset ?? '0'), 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(4, parsedLimit), 65536)
    : 32768;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
  const runId =
    typeof req.query.runId === 'string' ? req.query.runId.trim() : '';
  const messageId =
    typeof req.query.messageId === 'string' ? req.query.messageId : undefined;
  if (!runId && !messageId) {
    return res.status(400).json({ error: 'runId is required' });
  }
  const parsedBefore =
    req.query.beforeOffset !== undefined
      ? Number.parseInt(String(req.query.beforeOffset), 10)
      : Number.NaN;
  const beforeOffset = Number.isFinite(parsedBefore)
    ? Math.max(0, parsedBefore)
    : undefined;
  const page = readTaskOutputPage(
    req.params.pid,
    req.params.fid,
    limit,
    offset,
    runId,
    messageId,
    beforeOffset,
  );
  const hasMore = page.next_offset < page.total;
  return res.json({
    content: page.content,
    entries: page.entries.map((entry) => ({
      id: entry.id,
      content: entry.content,
      startOffset: entry.start_offset,
      endOffset: entry.end_offset,
      runId: entry.run_id,
      messageId: entry.message_id,
    })),
    total: page.total,
    offset,
    limit,
    runId: page.run_id,
    hasMore,
    nextOffset: hasMore ? page.next_offset : page.total,
    nextCursor: page.next_cursor,
  });
});

const REFUSED_CODES: ReadonlySet<GroupFsErrorCode> = new Set([
  'symlink',
  'not_directory',
  'not_regular_file',
  'not_found',
  'invalid_path',
]);

/** A link, non-regular file or missing entry reads as "not there"; other failures propagate. */
function refusedToNull(err: unknown): null {
  if (err instanceof GroupFsError && REFUSED_CODES.has(err.code)) return null;
  throw err;
}

/**
 * Run `fn` with a task's persisted Playwright recordings directory pinned by
 * descriptor (agent-writable: every segment is opened O_NOFOLLOW, so a swapped
 * directory or link is never followed). `removeIfEmpty` drops the directory
 * itself, named through its pinned parent. Null when the directory is missing
 * or is not a real directory.
 */
async function withTaskRecordings<T>(
  pid: string,
  fid: string,
  fn: (dir: PinnedDir, removeIfEmpty: () => Promise<void>) => Promise<T>,
): Promise<T | null> {
  const name = `task-${path.basename(fid)}`;
  let root: PinnedDir | null = null;
  let dir: PinnedDir | null = null;
  try {
    root = await openGroupDir(pid, 'recordings');
    dir = root ? await openDirAt(root, name) : null;
    if (!root || !dir) return null;
    const pinnedRoot = root;
    const pinnedDir = dir;
    return await fn(pinnedDir, async () => {
      if ((await readdirAt(pinnedDir))?.length !== 0) return;
      // Best effort: a run may have persisted a new recording meanwhile.
      await removeAt(pinnedRoot, name).catch(() => {});
    });
  } catch (err) {
    return refusedToNull(err);
  } finally {
    await dir?.close();
    await root?.close();
  }
}

/**
 * GET /api/projects/:pid/tasks/:fid/recordings
 * List the Playwright recordings persisted for a task (0..N .webm files —
 * multiple if the agent used several browser tabs/contexts).
 */
router.get('/projects/:pid/tasks/:fid/recordings', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }
  // Ticketed file URLs let a bare <video src> stream without auth headers.
  const authUserId: string | undefined = (req as any).authUser?.id;
  const withTicket = (url: string) => {
    const ticket = authUserId
      ? issueMediaTicket(url, authUserId, (req as any).authDeviceId ?? null)
      : null;
    return ticket ? `${url}?${MEDIA_TICKET_PARAM}=${ticket}` : url;
  };
  const entries: {
    filename: string;
    url: string;
    size: number;
    mtime: string;
  }[] = [];
  await withTaskRecordings(req.params.pid, req.params.fid, async (dir) => {
    for (const filename of (await readdirAt(dir)) ?? []) {
      if (!filename.toLowerCase().endsWith('.webm')) continue;
      const st = await lstatAt(dir, filename);
      if (!st?.isFile()) continue;
      entries.push({
        filename,
        url: withTicket(
          `/api/projects/${req.params.pid}/tasks/${req.params.fid}/recordings/${encodeURIComponent(filename)}`,
        ),
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
    }
  }).catch(() => {
    /* unreadable dir → no recordings */
  });
  entries.sort(
    (a, b) =>
      b.mtime.localeCompare(a.mtime) || a.filename.localeCompare(b.filename),
  );
  res.json({ recordings: entries });
});

/**
 * DELETE /api/projects/:pid/tasks/:fid/recordings
 * Delete all Playwright recordings persisted for a task.
 */
router.delete('/projects/:pid/tasks/:fid/recordings', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }

  let deletedCount = 0;
  let freedBytes = 0;
  await withTaskRecordings(
    req.params.pid,
    req.params.fid,
    async (dir, removeIfEmpty) => {
      for (const filename of (await readdirAt(dir)) ?? []) {
        if (!filename.toLowerCase().endsWith('.webm')) continue;
        const st = await lstatAt(dir, filename);
        if (!st || st.isDirectory()) continue;
        // A planted link is only unlinked; its target is never touched.
        if (!(await removeAt(dir, filename))) continue;
        if (st.isFile()) freedBytes += st.size;
        deletedCount++;
      }
      await removeIfEmpty();
    },
  );

  logger.info(
    { task_id: task.id, deleted_count: deletedCount, freed_bytes: freedBytes },
    'Task recordings deleted',
  );
  res.json({ ok: true, deletedCount, freedBytes });
});

/**
 * DELETE /api/projects/:pid/tasks/:fid/recordings/:filename
 * Delete one persisted Playwright recording for a task.
 */
router.delete(
  '/projects/:pid/tasks/:fid/recordings/:filename',
  async (req, res) => {
    const task = await getTask(req.params.fid);
    if (!task || task.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const filename = req.params.filename;
    const safe = path.basename(filename);
    if (safe !== filename || !safe.toLowerCase().endsWith('.webm')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const freedBytes = await withTaskRecordings(
      req.params.pid,
      req.params.fid,
      async (dir, removeIfEmpty) => {
        const st = await lstatAt(dir, safe);
        if (!st || st.isDirectory() || !(await removeAt(dir, safe))) {
          return null;
        }
        await removeIfEmpty();
        return st.isFile() ? st.size : 0;
      },
    );
    if (freedBytes === null) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    logger.info(
      { task_id: task.id, filename: safe, freed_bytes: freedBytes },
      'Task recording deleted',
    );
    res.json({ ok: true, deletedCount: 1, freedBytes });
  },
);

/**
 * GET /api/projects/:pid/tasks/:fid/recordings/:filename
 * Stream a single recording from its pinned descriptor; Express still handles
 * HTTP Range, so the player can seek.
 */
router.get(
  '/projects/:pid/tasks/:fid/recordings/:filename',
  async (req, res) => {
    const task = await getTask(req.params.fid);
    if (!task || task.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Task not found' });
    }
    // Path-traversal guard: must be a bare .webm filename.
    const filename = req.params.filename;
    const safe = path.basename(filename);
    if (safe !== filename || !safe.toLowerCase().endsWith('.webm')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    // Pin the directory and the file: a planted link or swapped directory is
    // refused instead of served, and the open handle is what gets sent.
    const opened = await withTaskRecordings(
      req.params.pid,
      req.params.fid,
      (dir) => openFileAt(dir, safe).catch(refusedToNull),
    );
    if (!opened) {
      return res.status(404).json({ error: 'Not found' });
    }
    sendPinnedFile(res, opened, { headers: { 'Content-Type': 'video/webm' } });
  },
);

/**
 * GET /api/projects/:pid/tasks/:fid/runs
 * List run history for a task.
 */
router.get('/projects/:pid/tasks/:fid/runs', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const [runs, total, stageDurations, persistentComments] = await Promise.all([
    getRunsForTask(req.params.fid),
    getRunCountForTask(req.params.fid),
    getTaskRunStageDurations(req.params.fid),
    getTaskStageComments(req.params.fid),
  ]);
  const latestScoredReviewRun = await getLatestScoredReviewRunForTask(
    req.params.fid,
  );
  // Map to the shape the UI expects (TaskRunLog)
  const mapRun = (r: any) => ({
    id: r.id,
    task_id: r.task_id,
    run_at: r.started_at,
    duration_ms: r.completed_at
      ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
      : null,
    status:
      r.status === 'completed'
        ? 'success'
        : r.status === 'error'
          ? 'error'
          : r.status === 'running'
            ? 'running'
            : 'stopped',
    output: null,
    error: r.status === 'error' ? 'Run failed' : null,
    model: r.model ?? null,
    agent_name: r.agent_name ?? null,
    session_id: r.session_id ?? null,
    tok_total: r.tok_total ?? null,
    tok_output: r.tok_output ?? null,
    tok_input: r.tok_input ?? null,
    tok_cache_write: r.tok_cache_write ?? null,
    tok_cache_read: r.tok_cache_read ?? null,
    tok_context_last: r.tok_context_last ?? null,
    model_name: r.model_name ?? null,
    tool_usage_count: r.tool_usage_count ?? null,
    cost_usd: r.cost_usd ?? null,
    stage: r.stage ?? null,
    trigger: r.trigger,
    reviewScore: r.reviewScore ?? null,
    testingDecision: r.testingDecision ?? null,
  });
  res.json({
    total,
    stageDurations,
    persistent_comments: persistentComments.map((comment) => ({
      stage_id: comment.stage_id,
      content: comment.content,
      updated_at: comment.updated_at,
      run_id: comment.run_id,
    })),
    runs: runs.map(mapRun),
    latest_scored_review_run: latestScoredReviewRun
      ? mapRun(latestScoredReviewRun)
      : null,
  });
});

/**
 * PUT /api/projects/:pid/tasks/:fid/stage-comments/:stageId
 * Create, edit, or clear a persistent stage note.
 */
router.put(
  '/projects/:pid/tasks/:fid/stage-comments/:stageId',
  async (req, res) => {
    const task = await getTask(req.params.fid);
    if (!task || task.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const content = req.body?.content;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if (content.length > 4_000) {
      return res
        .status(400)
        .json({ error: 'content must be at most 4000 characters' });
    }

    const trimmedContent = content.trim();
    const existing = await getTaskStageComment(
      req.params.fid,
      req.params.stageId,
    );
    // Existing notes are historical data: keep them editable/clearable even
    // when their stage was later disabled or removed. Only creation is gated
    // by the project's current executable-stage configuration.
    if (!existing) {
      const stages = getGroupStages(getGroupByFolder(req.params.pid));
      if (!isActiveStage(stages, req.params.stageId)) {
        return res.status(400).json({ error: 'Invalid executable stage' });
      }
    }
    if (!trimmedContent) {
      if (!existing) {
        return res
          .status(404)
          .json({ error: 'Persistent stage note not found' });
      }
      await clearTaskStageComment(req.params.fid, req.params.stageId);
      broadcast({ type: 'task_updated', payload: task });
      return res.json({ ok: true, cleared: true });
    }

    const saved = await setTaskStageComment(
      req.params.fid,
      req.params.stageId,
      trimmedContent,
      null,
    );
    broadcast({ type: 'task_updated', payload: task });
    return res.json({
      stageId: saved.stage_id,
      content: saved.content,
      updatedAt: saved.updated_at,
      runId: saved.run_id,
    });
  },
);

router.get('/projects/:pid/tasks/:fid/default-branch', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid)
    return res.status(404).json({ error: 'Task not found' });
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  return res.json(await runTaskDefaultBranchOperation(group, task));
});

router.post(
  '/projects/:pid/tasks/:fid/default-branch/merge',
  async (req, res) => {
    // Reserve before any awaits: completion and overlapping requests use this
    // same admission chain. Acquire the project Git lock only after admission.
    const admission = beginTaskSteeringAdmission(req.params.fid);
    let merge: TaskDefaultBranchMerge | undefined;
    try {
      await admission.ready;
      const task = await getTask(req.params.fid);
      if (!task || task.project_id !== req.params.pid)
        return res.status(404).json({ error: 'Task not found' });
      const group = getGroupByFolder(req.params.pid);
      if (!group) return res.status(404).json({ error: 'Project not found' });
      const { sourceCommit, taskHead } = req.body || {};
      if (
        ![sourceCommit, taskHead].every(
          (value) =>
            typeof value === 'string' &&
            /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value),
        )
      )
        return res.status(400).json({
          error:
            'Refresh integration status before merging (sourceCommit and taskHead are required).',
        });
      return await withProjectGitLock(
        task.project_id,
        async () => {
          const current = await getTask(task.id);
          if (!current || current.project_id !== req.params.pid)
            throw new Error('Task ownership changed before merging.');
          const currentGroup = getGroupByFolder(req.params.pid);
          if (!currentGroup) throw new Error('Project no longer exists.');
          const result = await runTaskDefaultBranchOperation(
            currentGroup,
            current,
            {
              sourceCommit,
              taskHead,
            },
          );
          if ('available' in result)
            return res.status(409).json({
              error: result.available
                ? 'Refresh integration status before merging.'
                : result.reason,
            });
          merge = result;
          if (merge.outcome === 'failed' || merge.outcome === 'up-to-date')
            return res.json(merge);
          const content = [
            merge.outcome === 'interrupted'
              ? `Attempt to merge local default branch ${merge.defaultBranch} at ${merge.sourceCommit} into the task was interrupted. ${merge.error}`
              : merge.outcome === 'uncommitted'
                ? `Merging local default branch ${merge.defaultBranch} at ${merge.sourceCommit} into the task left a merge awaiting a commit. Inspect the staged changes before committing.`
                : merge.outcome === 'conflicted'
                  ? `Merging local default branch ${merge.defaultBranch} at ${merge.sourceCommit} into the task left conflicts requiring resolution.`
                  : `Merged local default branch ${merge.defaultBranch} at ${merge.sourceCommit} into the task worktree.`,
            ...(merge.conflictedPaths.length
              ? [
                  `Conflicted paths:\n${merge.conflictedPaths.map((file) => `- ${JSON.stringify(file)}`).join('\n')}`,
                ]
              : []),
            'Inspect the updated code, resolve every conflict, run relevant checks, and finish/commit the merge when needed before continuing.',
          ].join('\n\n');
          merge.notification = content;
          const notification = await appendTaskIntegrationMessage(
            task.project_id,
            task.id,
            content,
            admission,
          );
          merge.delivery = notification.accepted ? 'steered' : 'queued';
          for (const message of [notification.message, notification.receipt]) {
            if (message)
              broadcast({
                type: 'task_message',
                payload: {
                  task_id: task.id,
                  project_id: task.project_id,
                  message,
                },
              });
          }
          return res.json(merge);
        },
        { waitForCompletion: true },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (
        merge &&
        (merge.outcome === 'merged' ||
          merge.outcome === 'conflicted' ||
          merge.outcome === 'uncommitted' ||
          merge.outcome === 'interrupted')
      ) {
        return res.json({
          ...merge,
          delivery: 'failed',
          error: `Git ${merge.outcome === 'merged' ? 'completed the merge' : merge.outcome === 'conflicted' ? 'left merge conflicts' : merge.outcome === 'uncommitted' ? 'left an uncommitted merge' : 'was interrupted'}, but the agent notification failed: ${detail}. Do not repeat the merge; send the included instruction to the task.`,
        });
      }
      return res.status(500).json({ error: detail });
    } finally {
      endTaskSteeringAdmission(admission);
    }
  },
);

/**
 * GET /api/projects/:pid/tasks/:fid/diff
 * Git diff of the changes a task made. While the task still has a branch this
 * includes its committed changes since divergence plus live working-tree edits
 * when the task owns the current checkout. After deploy the branch is merged and
 * removed, so we fall back to the recorded merge commit and diff its first parent
 * against it (the task's net contribution). Returns { available:false } when there is no branch,
 * no merge commit, or no repo. Git runs inside the sandbox via runGitInRepo —
 * never against the host worktree path.
 */
router.get('/projects/:pid/tasks/:fid/diff', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const group = getGroupByFolder(req.params.pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });
  if (
    !group.settings?.repositoryLocation &&
    !group.settings?.repositoryRelativePath
  ) {
    return res.json({ available: false, reason: 'no-repo' });
  }

  const instance = validatedInstance(task, group) || group.folder;
  const refPattern = /^[\w./-]+$/;

  // Keep numstat parsing shared with conversation/working-tree diffs so path
  // and binary-file handling stay identical across every Changes surface.
  const parseNumstat = parseGitNumstat;

  const storedLinkedRepositories = () => {
    const raw = task.custom_values?.linked_repository_merges;
    if (typeof raw !== 'string' || !raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  // Active task: diff the live branch against base.
  if (task.branch_name) {
    const branch = task.branch_name;
    const base = group.settings?.defaultBranch || 'develop';
    if (!refPattern.test(branch) || !refPattern.test(base)) {
      return res.status(400).json({ error: 'Invalid branch/base ref' });
    }

    // Worktree mode: the worktree is this task's own isolated tree, so it is safe
    // to surface UNCOMMITTED changes too — the agent may still be on an active
    // stage and not yet have committed (commit happens on stage-leave). Diff the
    // working tree against the merge-base (not `base` directly, so commits that
    // landed on base after divergence aren't rendered as reverse diffs), then
    // append untracked files (which `git diff <ref>` omits).
    const wtRel = task.worktree_path ? `.worktrees/${branch}` : null;
    if (wtRel) {
      const gitPrefix = `-C ${wtRel} `;
      try {
        const mbRes = await runGitInRepo(
          group,
          `${gitPrefix}merge-base ${base} ${branch}`,
          instance,
        );
        const mb = mbRes.ok
          ? (mbRes.output.trim().split('\n')[0] || '').trim()
          : '';
        const baseRef = COMMIT_SHA_PATTERN.test(mb) ? mb : base;

        // Tracked changes since divergence: committed on branch + uncommitted edits.
        const patchRes = await runGitInRepo(
          group,
          `${gitPrefix}diff --no-color ${baseRef}`,
          instance,
        );
        if (!patchRes.ok) {
          return res.json({
            available: false,
            reason: 'diff-failed',
            scope: 'worktree',
            base,
            branch,
          });
        }
        const statRes = await runGitInRepo(
          group,
          `${gitPrefix}diff --no-color --numstat ${baseRef}`,
          instance,
        );
        let files = await enrichTrackedDiffSymlinks(
          group,
          instance,
          gitPrefix,
          parseNumstat(statRes.ok ? statRes.output : ''),
        );
        let patch = patchRes.output;

        // Preserve exact path bytes with `-z`, inspect symlinks without following
        // them, and retain metadata-only rows when one visual patch fails.
        const UNTRACKED_LIMIT = 200;
        const untrackedRes = await runGitInRepo(
          group,
          `${gitPrefix}ls-files --others --exclude-standard -z`,
          instance,
        );
        if (untrackedRes.ok) {
          ({ files, patch } = await appendUntrackedDiffFromList(
            group,
            instance,
            gitPrefix,
            patch,
            files,
            untrackedRes.output,
            UNTRACKED_LIMIT,
          ));
        }

        const [linked, blockers] = await Promise.all([
          inspectTaskLinkedRepositories(task, group),
          getDefaultCheckoutBlockers(group, instance),
        ]);
        for (const repository of linked.repositories) {
          files.push(...repository.files);
          if (repository.patch) {
            patch += `${patch && !patch.endsWith('\n') ? '\n' : ''}${repository.patch}`;
          }
        }

        return res.json({
          available: true,
          scope: 'worktree',
          base,
          branch,
          files,
          patch,
          uncommitted: true,
          repositories: linked.repositories,
          blockers,
        });
      } catch (err) {
        logger.warn(
          { err, task_id: req.params.fid },
          'Failed to compute worktree task diff',
        );
        return res.json({
          available: false,
          reason: 'diff-error',
          scope: 'worktree',
          base,
          branch,
        });
      }
    }

    // Branch mode owns the repository-root checkout while the task is running.
    // When its branch is currently checked out, diff the live tree against the
    // divergence base so committed, tracked-uncommitted, and untracked changes
    // are all attributed to the task. If the checkout has already returned to
    // the default branch, keep the branch's committed diff and treat only dirt
    // in that actual default checkout as an integration blocker.
    if (group.settings?.taskCheckoutMode === 'branch') {
      try {
        const [mbRes, currentBranchRes] = await Promise.all([
          runGitInRepo(group, `merge-base ${base} ${branch}`, instance),
          runGitInRepo(group, 'branch --show-current', instance),
        ]);
        const mb = mbRes.ok
          ? (mbRes.output.trim().split('\n')[0] || '').trim()
          : '';
        const baseRef = COMMIT_SHA_PATTERN.test(mb) ? mb : base;
        const currentBranch = currentBranchRes.ok
          ? currentBranchRes.output.trim()
          : '';
        const ownsCurrentCheckout = currentBranch === branch;
        const diffTarget = ownsCurrentCheckout
          ? baseRef
          : `${baseRef} ${branch}`;
        const [patchRes, statRes, untrackedRes, statusRes] = await Promise.all([
          runGitInRepo(group, `diff --no-color ${diffTarget}`, instance),
          runGitInRepo(
            group,
            `diff --no-color --numstat ${diffTarget}`,
            instance,
          ),
          ownsCurrentCheckout
            ? runGitInRepo(
                group,
                'ls-files --others --exclude-standard -z',
                instance,
              )
            : Promise.resolve({ ok: true, output: '' }),
          ownsCurrentCheckout
            ? runGitInRepo(
                group,
                'status --porcelain=v1 -z --untracked-files=all',
                instance,
              )
            : Promise.resolve({ ok: true, output: '' }),
        ]);
        if (!patchRes.ok) {
          return res.json({
            available: false,
            reason: 'diff-failed',
            scope: 'branch',
            base,
            branch,
          });
        }

        let files = await enrichTrackedDiffSymlinks(
          group,
          instance,
          '',
          parseNumstat(statRes.ok ? statRes.output : ''),
        );
        let patch = patchRes.output;
        if (ownsCurrentCheckout) {
          ({ files, patch } = await appendUntrackedDiffFromList(
            group,
            instance,
            '',
            patch,
            files,
            untrackedRes.ok ? untrackedRes.output : '',
            200,
          ));
        }
        files = files.map((file) => ({ ...file, source: 'task' as const }));
        const blockers =
          !ownsCurrentCheckout && currentBranch === base
            ? await getDefaultCheckoutBlockers(group, instance)
            : [];

        return res.json({
          available: true,
          scope: 'branch',
          base,
          branch,
          files,
          patch,
          ...(ownsCurrentCheckout && statusRes.ok
            ? { uncommitted: statusRes.output.length > 0 }
            : {}),
          blockers,
        });
      } catch (err) {
        logger.warn(
          { err, task_id: req.params.fid },
          'Failed to compute branch-mode task diff',
        );
        return res.json({
          available: false,
          reason: 'diff-error',
          scope: 'branch',
          base,
          branch,
        });
      }
    }

    // Remaining non-worktree modes share the checkout across tasks, so only this
    // branch's COMMITTED changes (base...branch) can be attributed safely.
    const range = `${base}...${branch}`;
    try {
      const patchRes = await runGitInRepo(
        group,
        `diff --no-color ${range}`,
        instance,
      );
      if (!patchRes.ok) {
        return res.json({
          available: false,
          scope: 'branch',
          base,
          branch,
        });
      }
      const statRes = await runGitInRepo(
        group,
        `diff --no-color --numstat ${range}`,
        instance,
      );
      const files = parseNumstat(statRes.ok ? statRes.output : '');
      const blockers = await getDefaultCheckoutBlockers(group, instance);
      return res.json({
        available: true,
        scope: 'branch',
        base,
        branch,
        files,
        patch: patchRes.output,
        blockers,
      });
    } catch (err) {
      logger.warn(
        { err, task_id: req.params.fid },
        'Failed to compute task diff',
      );
      return res.json({
        available: false,
        reason: 'diff-error',
        scope: 'branch',
        base,
        branch,
      });
    }
  }

  // Merged/deployed task: preserve the pre-merge divergence base so a
  // fast-forward integration includes every commit contributed by the task.
  if (task.merge_commit && COMMIT_SHA_PATTERN.test(task.merge_commit)) {
    const sha = task.merge_commit;
    const recordedBase = task.custom_values?.task_diff_base_sha;
    const parent =
      typeof recordedBase === 'string' && COMMIT_SHA_PATTERN.test(recordedBase)
        ? recordedBase
        : `${sha}^1`;
    const range = `${parent} ${sha}`;
    try {
      const patchRes = await runGitInRepo(
        group,
        `diff --no-color ${range}`,
        instance,
      );
      if (!patchRes.ok) {
        return res.json({
          available: false,
          reason: 'diff-failed',
          scope: 'merged',
          base: parent,
          branch: sha,
        });
      }
      const statRes = await runGitInRepo(
        group,
        `diff --no-color --numstat ${range}`,
        instance,
      );
      const files = parseNumstat(statRes.ok ? statRes.output : '');
      let patch = patchRes.output;
      const repositories = storedLinkedRepositories();
      for (const repository of repositories) {
        if (Array.isArray(repository?.files)) files.push(...repository.files);
        if (typeof repository?.patch === 'string' && repository.patch) {
          patch += `${patch && !patch.endsWith('\n') ? '\n' : ''}${repository.patch}`;
        }
      }
      return res.json({
        available: true,
        scope: 'merged',
        base: parent,
        branch: sha,
        files,
        patch,
        repositories,
      });
    } catch (err) {
      logger.warn(
        { err, task_id: req.params.fid },
        'Failed to compute merged task diff',
      );
      return res.json({
        available: false,
        reason: 'diff-error',
        scope: 'merged',
        base: parent,
        branch: sha,
      });
    }
  }

  return res.json({ available: false, reason: 'no-worktree' });
});

/**
 * POST /api/projects/:pid/tasks/:fid/fork
 * Fork a task's conversation from a specific message.
 * Creates a new task with copied messages up to the given messageId
 * and injects prior conversation context into the description.
 */
router.post('/projects/:pid/tasks/:fid/fork', async (req, res) => {
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { messageId, prompt } = req.body || {};
  if (
    typeof messageId !== 'string' ||
    typeof prompt !== 'string' ||
    !messageId.trim() ||
    !prompt.trim()
  ) {
    return res.status(400).json({ error: 'messageId and prompt are required' });
  }
  const forkPromptErr = lenError(prompt, MAX_LEN.prompt, 'prompt');
  if (forkPromptErr) return res.status(400).json({ error: forkPromptErr });

  const allMessages = readTaskMessages(req.params.pid, req.params.fid);
  const cutoffIdx = allMessages.findIndex((m) => m.id === messageId);
  if (cutoffIdx === -1) {
    return res.status(404).json({ error: 'Message not found in this task' });
  }

  const slicedMessages = allMessages.slice(0, cutoffIdx + 1);
  const sourceMessage = allMessages[cutoffIdx];

  // Build prior conversation context block
  const contextLines = slicedMessages.map((m) => `[${m.role}]: ${m.content}`);
  const contextBlock = `<prior-conversation>\n${contextLines.join('\n\n')}\n</prior-conversation>`;
  const description = `${contextBlock}\n\n${prompt}`;

  // Resolve initial stage
  const group = getGroupByFolder(req.params.pid);
  const stages = getGroupStages(group);
  const initialStage = getInitialStage(stages);

  if (!initialStage) {
    return res.status(500).json({ error: 'No valid stage found for project' });
  }

  const newTask = await createTask({
    project_id: req.params.pid,
    title: `Fork: ${task.title}`,
    description,
    status: initialStage.id,
    priority: task.priority ?? 0,
    runtimeSelection: task.runtimeSelection ?? undefined,
    runtimeSelectionStage: task.runtimeSelectionStage ?? undefined,
    author: 'user',
    ownerUserId: (req as any).authUser?.id ?? group?.user_id ?? null,
    lastTriggeredByUserId: (req as any).authUser?.id ?? null,
    lastTriggerSource: (req as any).authUser?.id ? 'user' : 'system',
    lastTriggeredAt: new Date().toISOString(),
    sourceRunId: sourceMessage.run_id ?? null,
  });

  // Copy messages up to cutoff into the new task
  copyTaskMessages(req.params.pid, req.params.fid, newTask.id, messageId);

  // Add the fork prompt as a new user message
  await appendTaskMessageDurableAsync(req.params.pid, {
    task_id: newTask.id,
    role: 'user',
    content: prompt,
    created_at: new Date().toISOString(),
  });

  broadcast({ type: 'task_created', payload: newTask });
  logger.info(
    {
      task_id: newTask.id,
      forked_from: task.id,
      messageId,
      project: req.params.pid,
    },
    'Task forked',
  );

  res.status(201).json(newTask);

  // Preserve the legacy immediate fork run unless the initial stage explicitly
  // owns a one-shot entry event. In that case the durable admission barrier
  // must run first; its handoff will wake ordinary executable work afterward.
  if (group) {
    if (initialStage.runOnEntry) {
      drainProjectQueue(newTask.project_id, group);
    } else {
      let provisionalClaim: AbortController | null = null;
      const admission = await claimNormalTaskAdmission(
        newTask.project_id,
        (taskCheckoutMode) => {
          provisionalClaim = claimTaskExecution(
            newTask.id,
            newTask.project_id,
            taskCheckoutMode === 'worktree',
          );
          return provisionalClaim;
        },
        false,
        newTask.id,
        group.settings?.taskCheckoutMode ?? 'shared',
        (claim) => releaseTaskExecutionClaim(newTask.id, claim),
      );
      if (admission.blockedByEntry || !admission.claim) {
        logger.info(
          { task_id: newTask.id },
          'Forked task queued because project admission is unavailable',
        );
        return;
      }
      group.settings = {
        ...(group.settings ?? {}),
        taskCheckoutMode: admission.taskCheckoutMode,
      };
      executeTask(newTask, group, {
        executionClaim: admission.claim,
        admissionOwnerToken: admission.ownerToken,
      }).catch((err) => {
        logger.error(
          { err, task_id: newTask.id },
          'Failed to auto-start forked task',
        );
      });
    }
  }
});

/**
 * POST /api/projects/:pid/tasks/:fid/move
 * Move a task from the source project to another project.
 * Reference-only: the on-disk transcript file stays in the source project's
 * `transcripts/` directory and becomes orphaned. task_messages DB rows follow
 * the task via `task_id` (cascade) but the UI must tolerate a missing/empty
 * transcript on the target. The task's status is reset to the target project's
 * initial stage, branch/worktree/merge_commit fields are cleared, and any
 * depends_on_ids that do not exist in the target project are dropped.
 */
router.post('/projects/:pid/tasks/:fid/move', async (req: any, res) => {
  // Agent tokens carry no authUser, so the owner checks below would compare
  // undefined === undefined for ownerless projects and pass.
  if (isAgentCredential(req) || !req.authUser) {
    return res
      .status(403)
      .json({ error: 'Agents cannot move tasks between projects' });
  }
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { target_project_id: targetProjectIdRaw } = req.body || {};
  if (typeof targetProjectIdRaw !== 'string' || !targetProjectIdRaw.trim()) {
    return res.status(400).json({ error: 'target_project_id is required' });
  }
  const targetProjectId = targetProjectIdRaw.trim();
  if (targetProjectId === req.params.pid) {
    return res
      .status(400)
      .json({ error: 'Target project must be different from source' });
  }

  // Source project must exist and caller must own it (admins bypass, except
  // outside projects owned by another user).
  const sourceGroup = getGroupByFolder(req.params.pid);
  if (!sourceGroup) {
    return res.status(404).json({ error: 'Source project not found' });
  }
  const bypassesSource = adminBypassesProject(req.authUser, req.params.pid);
  if (!bypassesSource && sourceGroup.user_id !== req.authUser?.id) {
    return res
      .status(403)
      .json({ error: 'Only the project owner can move tasks out of it' });
  }

  // Refuse if the task is running (the agent is still active in the sandbox).
  if (await isTaskRunning(req.params.fid)) {
    return res.status(409).json({
      error: 'Cannot move a running task. Stop it first, then move the task.',
    });
  }

  // Refuse if the task has accumulated any source-repo-specific state. The
  // backlog-only constraint should make this impossible, but guard anyway so
  // a task that was incorrectly set to backlog with leftover state is refused
  // rather than silently mis-migrated.
  if (
    task.branch_name ||
    task.worktree_path ||
    task.sandbox_instance ||
    task.merge_commit
  ) {
    return res.status(409).json({
      error:
        'Task has source-repo state (branch/worktree/merge). It cannot be moved.',
    });
  }

  // Source must be in the project owner — if the project's access has changed
  // since the task was created we still enforce ownership on the source.
  // Target project must exist and be accessible to caller.
  const targetGroup = getGroupByFolder(targetProjectId);
  if (!targetGroup) {
    return res.status(404).json({ error: 'Target project not found' });
  }
  if (!adminBypassesProject(req.authUser, targetProjectId)) {
    if (targetGroup.is_main && targetGroup.user_id !== req.authUser?.id) {
      return res.status(403).json({ error: 'No access to the target project' });
    }
    if (!targetGroup.is_main && targetGroup.user_id !== req.authUser?.id) {
      // Non-main target: caller must be the owner. (Project-member/editor
      // levels are intentionally not honored for cross-project moves to keep
      // the rule simple and ownership-based.)
      return res
        .status(403)
        .json({ error: 'Only the project owner can move tasks into it' });
    }
  }

  // Target must have kanban mode enabled.
  const targetEnabledModes = targetGroup.settings?.enabledModes ?? [
    'kanban',
    'chat',
  ];
  if (!targetEnabledModes.includes('kanban')) {
    return res.status(400).json({
      error:
        'Target project has kanban mode disabled. Choose a different project.',
    });
  }

  // Refuse if the source task is not in the project's initial/queue stage.
  // Source-side status check (instead of target's initial stage) is the gate
  // — the user said "backlog only" as the source constraint.
  const sourceStages = getGroupStages(sourceGroup);
  const sourceStage = findStage(sourceStages, task.status);
  if (!sourceStage || sourceStage.type !== 'queue') {
    return res.status(409).json({
      error: 'Only tasks in a queue/backlog stage can be moved.',
    });
  }

  // Resolve target's initial stage.
  const targetStages = getGroupStages(targetGroup);
  const targetInitial = getInitialStage(targetStages);
  if (!targetInitial) {
    return res
      .status(500)
      .json({ error: 'No valid stage found for target project' });
  }

  // Filter depends_on_ids: drop anything that does not exist in the target.
  // A single inArray query is enough — we don't need the row contents.
  let filteredDeps: string[] = [];
  if (task.depends_on_ids && task.depends_on_ids.length > 0) {
    const targetTasks = await getTasksByProjectSummary(targetProjectId);
    const targetTaskIds = new Set(targetTasks.map((t) => t.id));
    filteredDeps = task.depends_on_ids.filter((id) => targetTaskIds.has(id));
  }

  let moveResult;
  try {
    moveResult = await moveTaskToProject(
      req.params.fid,
      targetProjectId,
      targetInitial.id,
      filteredDeps,
      req.params.pid,
    );
  } catch (error) {
    if (
      error instanceof TaskStageWriteConflictError ||
      error instanceof TaskSourceProjectMismatchError
    ) {
      return res
        .status(error.statusCode)
        .json({ error: (error as Error).message });
    }
    throw error;
  }
  if (!moveResult) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const { task: updated, releasedDependentIds } = moveResult;

  broadcast({
    type: 'task_deleted',
    payload: { task_id: req.params.fid, project_id: req.params.pid },
  });
  broadcast({ type: 'task_created', payload: updated });
  for (const dependentId of releasedDependentIds) {
    broadcast({
      type: 'task_updated',
      payload: { task_id: dependentId, project_id: req.params.pid },
    });
  }
  // A source dependent held on this moved task can start now.
  if (releasedDependentIds.length > 0) {
    taskQueueDrainRunner(req.params.pid, sourceGroup);
  }
  logger.info(
    {
      task_id: req.params.fid,
      from: req.params.pid,
      to: targetProjectId,
    },
    'Task moved to project',
  );

  res.json(updated);
});

/**
 * POST /api/projects/:pid/tasks/:fid/execute
 * Start agent execution for a task.
 * Returns 202 immediately; progress streams via WebSocket.
 */
router.post('/projects/:pid/tasks/:fid/execute', async (req, res) => {
  let task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (await isTaskRunning(req.params.fid)) {
    return res.status(409).json({ error: 'Task is already running' });
  }

  // Forked A/B experiment parents are never executed; the pipeline drops them.
  if (isForkedAbParent(task)) {
    return res.status(409).json({ error: FORKED_AB_PARENT_ERROR });
  }

  // Find a registered group for this project
  const group = getGroupByFolder(req.params.pid);
  if (!group) {
    return res
      .status(404)
      .json({ error: 'No registered group for this project' });
  }

  // This endpoint is an explicit per-task action, so it remains available
  // while automatic project processing is paused or stopped. Queue draining
  // continues to enforce the project status in drainProjectQueue().

  // If the task is in a done stage (or a specific target stage is requested), move it to
  // the appropriate active stage before executing.
  const stages = getGroupStages(group);
  if (isAgentCredential(req)) {
    const denial = agentTaskUpdateDenial(
      stages,
      task,
      typeof req.query.stage === 'string' ? req.query.stage : undefined,
    );
    if (denial) return res.status(403).json({ error: denial });
  }
  const requestedStageError = executionStageError(stages, req.query.stage);
  if (requestedStageError) {
    return res.status(400).json({ error: requestedStageError });
  }
  const stage = findStage(stages, task.status);
  const requestedStageId =
    typeof req.query.stage === 'string' ? req.query.stage : undefined;
  const requestedStage = requestedStageId
    ? stages.find(
        (s) =>
          s.id === requestedStageId &&
          (s.type === 'active' ||
            s.type === 'testing' ||
            s.type === 'review') &&
          !s.inactive,
      )
    : undefined;
  const freshSession = req.query.freshSession === 'true';
  const isReset = req.query.reset === 'true';
  if (freshSession && isReset) {
    return res.status(400).json({
      error: 'freshSession and reset cannot be used together',
    });
  }

  // Validate the prompt before any state change (stage move, reset).
  const rawPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
  const execPromptErr = lenError(rawPrompt, MAX_LEN.prompt, 'prompt');
  if (execPromptErr) return res.status(400).json({ error: execPromptErr });
  const promptFromBody = rawPrompt.trim();

  // Start over only resets the task; the queue decides when it may start.
  const triggeredByUserId = (req as any).authUser?.id ?? null;
  const triggerSource = triggeredByUserId ? 'user' : 'system';
  if (isReset) {
    // Move to the requested stage; otherwise keep an executable current stage,
    // else fall back to the first executable stage.
    let resetTargetStageId: string | undefined;
    const keepCurrent =
      !requestedStage &&
      (stage?.type === 'active' ||
        stage?.type === 'testing' ||
        stage?.type === 'review') &&
      !stage.inactive;
    if (!keepCurrent) {
      const targetStage = requestedStage ?? getFirstExecutableStage(stages);
      if (!targetStage) {
        return res
          .status(400)
          .json({ error: 'No active stage available to re-run task.' });
      }
      if (targetStage.id !== task.status) resetTargetStageId = targetStage.id;
    }
    const outcome = await startOverTask(task, group, {
      targetStageId: resetTargetStageId,
      triggeredByUserId,
      triggerSource,
      prompt: promptFromBody || undefined,
    });
    if (!outcome.ok) {
      return res.status(outcome.status).json({
        error: outcome.error,
        ...(outcome.conversationIds
          ? { conversationIds: outcome.conversationIds }
          : {}),
      });
    }
    task = outcome.task;
    // Start over is a user-directed retry: clear the automatic failure
    // circuit breaker, as a manual move to an executable stage does.
    resetProjectFailures(req.params.pid);
    void taskQueueDrainRunner(req.params.pid, group);
    return res.status(202).json({
      message: 'Reset; queued',
      task_id: task.id,
      unmet_dependency_ids: await getUnmetDependencies(task),
    });
  }

  if (
    stage?.type === 'done' ||
    (requestedStage && task.status !== requestedStage.id)
  ) {
    const targetStage =
      requestedStage ?? stages.find((s) => s.type === 'active' && !s.inactive);
    if (!targetStage) {
      return res
        .status(400)
        .json({ error: 'No active stage available to re-run task.' });
    }
    await updateTask(
      task.id,
      { status: targetStage.id },
      { suppressStageEntryEvent: true },
    );
    task = (await getTask(req.params.fid)) ?? task;
    broadcast({ type: 'task_updated', payload: task });
  }

  // Every manual run is a user-directed retry. Reset the testing loop even
  // when Task Detail's "Continue" action has no additional draft text.
  await updateTask(
    task.id,
    { custom_values: { [TESTING_FAILURE_COUNT_KEY]: 0 } },
    { mergeCustomValues: true },
  );
  task = (await getTask(req.params.fid)) ?? task;
  if (promptFromBody && !freshSession) {
    task = await persistTaskPrompt(task, promptFromBody);
  }

  let freshSessionLatestPrompt: string | undefined;
  if (freshSession) {
    if (promptFromBody) {
      freshSessionLatestPrompt = promptFromBody;
      const userMsg = await appendTaskMessageDurableAsync(req.params.pid, {
        task_id: req.params.fid,
        role: 'user',
        content: promptFromBody,
        created_at: new Date().toISOString(),
      });
      broadcast({
        type: 'task_message',
        payload: {
          task_id: req.params.fid,
          project_id: req.params.pid,
          message: userMsg,
        },
      });
    } else {
      const messages = await readTaskMessagesAsync(
        req.params.pid,
        req.params.fid,
      );
      freshSessionLatestPrompt = findLatestTaskUserPrompt(
        messages,
        task.description || '',
      );
    }
    await updateTask(task.id, { session_id: '' });
    task = (await getTask(req.params.fid)) ?? task;
    const notice = await appendTaskMessageDurableAsync(req.params.pid, {
      task_id: req.params.fid,
      role: 'system',
      entry_type: 'system_notice',
      content:
        'Continuing in a fresh agent session. Existing task worktree changes are preserved.',
      created_at: new Date().toISOString(),
    });
    broadcast({
      type: 'task_message',
      payload: {
        task_id: req.params.fid,
        project_id: req.params.pid,
        message: notice,
      },
    });
  }

  // Manual execution resets the consecutive failure counter
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // Block execution if dependencies are not satisfied. The stage move, prompt
  // and fresh-session changes above are kept; the queue starts the task once
  // its dependencies are met, as for a reset.
  const unmet = await getUnmetDependencies(task);
  if (unmet.length > 0) {
    return res.status(202).json({
      message: 'Queued; waiting for dependencies',
      task_id: task.id,
      unmet_dependency_ids: unmet,
    });
  }

  const admittedTask = task;
  let provisionalClaim: AbortController | null = null;
  const admission = await claimNormalTaskAdmission(
    admittedTask.project_id,
    (taskCheckoutMode) => {
      provisionalClaim = claimTaskExecution(
        admittedTask.id,
        admittedTask.project_id,
        taskCheckoutMode === 'worktree',
      );
      return provisionalClaim;
    },
    false,
    admittedTask.id,
    group.settings?.taskCheckoutMode ?? 'shared',
    (claim) => releaseTaskExecutionClaim(admittedTask.id, claim),
  );
  if (admission.blockedByEntry || !admission.claim) {
    return res
      .status(409)
      .json({ error: 'Task is blocked by project admission' });
  }
  const executionClaim = admission.claim;
  group.settings = {
    ...(group.settings ?? {}),
    taskCheckoutMode: admission.taskCheckoutMode,
  };
  try {
    await updateTask(task.id, {
      lastTriggeredByUserId: triggeredByUserId,
      lastTriggerSource: triggerSource,
      lastTriggeredAt: new Date().toISOString(),
    });
    task = (await getTask(task.id)) ?? task;
  } catch (err) {
    releaseTaskExecutionClaim(task.id, executionClaim);
    await releaseTaskAdmission(task.project_id, task.id, admission.ownerToken);
    throw err;
  }

  // Fire and forget — execution is async, progress via WebSocket
  explicitExecuteTaskRunner(task, group, {
    ...(freshSession ? { freshSession: true, freshSessionLatestPrompt } : {}),
    executionClaim,
    admissionOwnerToken: admission.ownerToken,
    manualParallelismOverride: true,
    triggerAttribution: { triggeredByUserId, triggerSource },
  }).catch((err) => {
    logger.error(
      { task_id: task.id, error: String(err) },
      'Unhandled execute error',
    );
  });

  res.status(202).json({ message: 'Execution started', task_id: task.id });
});

/**
 * POST /api/projects/:pid/tasks/:fid/stop
 * Stop a running task execution.
 */
router.post('/projects/:pid/tasks/:fid/stop', async (req, res) => {
  if (isAgentCredential(req)) {
    return res.status(403).json({ error: AGENT_DELETE_STOP_ERROR });
  }
  const task = await getTask(req.params.fid);
  if (!task || task.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const stopped = await stopTask(req.params.fid);
  if (!stopped) {
    return res.status(404).json({ error: 'Task is not running' });
  }
  res.json({ ok: true, message: 'Task execution stopped' });
});

/**
 * POST /api/projects/:pid/tasks/:fid/background-tasks/:bgId/stop
 * Stop one background task a running task agent is waiting on.
 */
router.post(
  '/projects/:pid/tasks/:fid/background-tasks/:bgId/stop',
  async (req, res) => {
    if (isAgentCredential(req)) {
      return res.status(403).json({ error: AGENT_DELETE_STOP_ERROR });
    }
    const task = await getTask(req.params.fid);
    if (!task || task.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const accepted = await stopTaskBackgroundTask(task.id, req.params.bgId);
    return res.status(accepted ? 200 : 409).json({ ok: accepted });
  },
);

/**
 * POST /api/projects/:pid/stop
 * Stop all running agents for a project and mark it as stopped.
 */
router.post('/projects/:pid/stop', async (req, res) => {
  if (isAgentCredential(req)) {
    return res.status(403).json({ error: AGENT_DELETE_STOP_ERROR });
  }
  const entry = getGroupEntryByFolder(req.params.pid);
  if (!entry) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { jid, group } = entry;
  // Update status to 'stopped' BEFORE killing tasks so that drainProjectQueue
  // (called from executeTask's finally block after abort propagates) sees the
  // stopped status and does not start new tasks.
  const merged = { ...(group.settings ?? {}), status: 'stopped' as const };
  await updateGroup(jid, { settings: merged });
  const count = await stopAllProjectTasks(req.params.pid);

  logger.info({ project: req.params.pid, stopped: count }, 'Project stopped');
  res.json({ ok: true, stopped: count });
});

export default router;
