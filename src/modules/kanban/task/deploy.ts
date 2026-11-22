/**
 * Deploy triggering and validation.
 *
 * Handles the "deploy" stage: merges the task branch, builds/deploys the
 * service via CarapaBox, and records the outcome.
 */
import { RegisteredGroup } from '../../../types.js';
import { Task, type StageDefinition } from '../types.js';
import {
  getTask,
  getTasksByProjectAndStatuses,
  onTaskStatusChanged,
  updateTask,
} from '../../../db.js';
import { appendTaskMessage } from '../../transcripts/transcript-store.js';
import { broadcast } from '../../objectives/ws-events.js';
import { logger } from '../../../logger.js';
import {
  findStage,
  getGroupStages,
  getFirstExecutableStage,
  getInitialStage,
  getFailedStage,
  getDeployStageId,
  isAbExperimentTask,
} from '../stages.js';
import {
  BUILD_SERVICE_CALL_OPTIONS,
  getSandboxClient,
} from '../../../lib/mcp-client.js';
import {
  publishEvent,
  publishEventWithResult,
  resolveBrainUrl,
  resolveBrainContainer,
} from '../../objectives/brain-client.js';
import {
  publishEventAndNotify,
  type ObjectiveEventPublisher,
} from './objective-event-holds.js';
import {
  appendMergeConflictReworkPrompt,
  mergeTaskBranchWithResolution,
  type MergeDependencies,
  type MergeWithResolutionResult,
} from './merge-conflict-resolution.js';
import {
  requestApprovalForHeldMerge,
  type MergeApprovalDetails,
} from './merge-risk-gate.js';
import { registeredGroups } from '../../../state-manager.js';
import { commitTaskBranch } from '../../../lib/git-ops.js';
import { acquireSharedCheckoutLease } from '../../../concurrency/shared-checkout-lease.js';
import { taskEventHeaders } from './objective-events.js';
import { withTimeout } from '../../../lib/async.js';
import { notifyEntityLifecycle } from '../../tools/push-tools.js';
import {
  holdServiceBuild,
  trackServiceBuild,
} from '../../../sandbox/service-builds.js';
import {
  DEPLOY_HOST_BUILD_KEY,
  DEPLOY_PENDING_DISPATCH_KEY,
} from '../pipeline-owned-values.js';

export { DEPLOY_HOST_BUILD_KEY, DEPLOY_PENDING_DISPATCH_KEY };

/**
 * `deploy_pending_dispatch` value written by finished-run recovery. It tells a
 * handoff recovery owns apart from the plain timestamp a live run leaves
 * before calling `triggerDeploy` itself.
 */
const RECOVERED_DISPATCH_PREFIX = 'recovered:';

export function recoveredDeployDispatchValue(
  at: string = new Date().toISOString(),
): string {
  return `${RECOVERED_DISPATCH_PREFIX}${at}`;
}

/* ------------------------------------------------------------------ */
/*  Per-project deploy debounce                                       */
/*  When multiple tasks land in the deploy stage within a short window */
/*  (e.g. bulk drag), we merge all branches first, then build once.   */
/* ------------------------------------------------------------------ */

const DEPLOY_DEBOUNCE_MS = 2000;

interface PendingDeploy {
  tasks: Array<{
    task: Task;
    lifecycleRunId: string;
    stageEntryEventId?: string;
  }>;
  group: RegisteredGroup;
  timer: ReturnType<typeof setTimeout>;
  dependencies: DeployBatchDependencies;
  /**
   * Counts the batch as a build in progress from the moment it is queued, so
   * a restart-when-idle requested during the debounce/merge window waits for
   * the build instead of restarting onto the old image.
   */
  releaseBuildHold?: () => void;
}

const pendingDeploys = new Map<string, PendingDeploy>();

function requiresSharedCheckoutLease(
  task: Task,
  group: RegisteredGroup,
): boolean {
  return (
    !!task.branch_name ||
    !!group.settings?.repositoryLocation ||
    !!group.settings?.repositoryUrl ||
    !!group.settings?.repositoryRelativePath
  );
}

const DEPLOY_SUCCESS_LOG_TAIL_CHARS = 4_000;

/**
 * Format the deploy outcome message. Failures keep the full log for
 * diagnosis; successes keep only the tail so build output does not bloat
 * the task transcript.
 */
export function formatDeployLog(
  serviceName: string,
  stdout: string,
  isError: boolean,
): string {
  const header = `**Deploy ${serviceName}:** ${isError ? 'FAILED' : 'SUCCESS'}`;
  let log = stdout;
  if (!isError && stdout.length > DEPLOY_SUCCESS_LOG_TAIL_CHARS) {
    const cut = stdout.length - DEPLOY_SUCCESS_LOG_TAIL_CHARS;
    log = `... [truncated ${cut} chars]\n${stdout.slice(cut)}`;
  }
  return `${header}\n\n\`\`\`\n${log}\n\`\`\``;
}

const DEPLOY_FAILURE_ERROR_TAIL_CHARS = 1_500;

/**
 * Short failure reason for the task error field and the task_failed event.
 * Build tools print the failing step and error last, so keep the tail.
 */
export function deployFailureExcerpt(stdout: string): string {
  if (stdout.length <= DEPLOY_FAILURE_ERROR_TAIL_CHARS) return stdout;
  const cut = stdout.length - DEPLOY_FAILURE_ERROR_TAIL_CHARS;
  return `... [truncated ${cut} chars]\n${stdout.slice(cut)}`;
}

export interface DeployBatchDependencies {
  getTask: typeof getTask;
  mergeBranchForDeploy: typeof mergeBranchForDeploy;
  triggerDeploy: typeof triggerDeploy;
  acquireSharedCheckoutLease?: typeof acquireSharedCheckoutLease;
}

const defaultDeployBatchDependencies: DeployBatchDependencies = {
  getTask,
  mergeBranchForDeploy,
  triggerDeploy,
  acquireSharedCheckoutLease,
};

export interface DeployMergeDependencies {
  getTask: typeof getTask;
  updateTask: typeof updateTask;
  commitTaskBranch: typeof commitTaskBranch;
  appendTaskMessage: typeof appendTaskMessage;
  broadcast: typeof broadcast;
  mergeTaskBranchWithResolution: (
    task: Task,
    group: RegisteredGroup,
    source: 'review' | 'completion' | 'deploy' | 'deploy_batch' | 'recovery',
    dependencies?: MergeDependencies,
    options?: {
      leaseAlreadyHeld?: boolean;
      bypassAbExperimentGate?: boolean;
      deferToOtherOwner?: boolean;
      propagateStateErrors?: boolean;
    },
  ) => Promise<MergeWithResolutionResult>;
}

const defaultDeployMergeDependencies: DeployMergeDependencies = {
  getTask,
  updateTask,
  commitTaskBranch,
  appendTaskMessage,
  broadcast,
  mergeTaskBranchWithResolution,
};

/** Shared direct/batched deploy merge gate. */
export async function mergeBranchForDeploy(
  task: Task,
  group: RegisteredGroup,
  source: 'completion' | 'deploy' | 'deploy_batch' | 'recovery',
  dependencies: DeployMergeDependencies = defaultDeployMergeDependencies,
  options: {
    leaseAlreadyHeld?: boolean;
    /** Merge an A/B experiment card despite the experiment merge gate. */
    bypassAbExperimentGate?: boolean;
    /** Receives the approval a person can decide when the risk gate holds the merge. */
    onApprovalRequired?: (approval: MergeApprovalDetails) => void;
    /** Throw SharedCheckoutBusyError instead of waiting for another owner's lease. */
    deferToOtherOwner?: boolean;
    /** The caller's fresh read of the task, reused instead of reading it again. */
    currentTask?: Task;
    /** Restart recovery: a failed task-state write of the checkpoint is not a Git failure. */
    propagateStateErrors?: boolean;
  } = {},
): Promise<boolean> {
  const fresh =
    options.currentTask ?? (await dependencies.getTask(task.id)) ?? task;
  const usesTaskBranch = !!fresh.branch_name;

  // The automatic active → done path reaches this merge before the pipeline's
  // finally block performs its normal post-run commit. Commit the worktree
  // first so the merge includes the agent's latest changes rather than only
  // the branch tip that existed before the run.
  if (usesTaskBranch) {
    const committed = await dependencies.commitTaskBranch(fresh, group, {
      propagateStateErrors: options.propagateStateErrors,
    });
    if (!committed) {
      const stages = getGroupStages(group);
      const retryStageId = getInitialStage(stages)?.id ?? fresh.status;
      await dependencies.updateTask(task.id, {
        status: retryStageId,
        completed_at: null,
      });
      const notice = dependencies.appendTaskMessage(task.project_id, {
        task_id: task.id,
        role: 'system',
        entry_type: 'system_notice',
        content:
          `**Task checkpoint pending** — changes in the task worktree could not be committed, so its branch was not merged. ` +
          `The task was paused in \`${retryStageId}\` and was not finalized. Retry after correcting the Git environment.`,
        created_at: new Date().toISOString(),
      });
      if (notice) {
        dependencies.broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            message: notice,
          },
        });
      }
      const pending = await dependencies.getTask(task.id);
      if (pending) {
        dependencies.broadcast({ type: 'task_updated', payload: pending });
      }
      return false;
    }
  }

  const result = await dependencies.mergeTaskBranchWithResolution(
    fresh,
    group,
    source,
    undefined,
    {
      leaseAlreadyHeld: options.leaseAlreadyHeld,
      bypassAbExperimentGate: options.bypassAbExperimentGate,
      deferToOtherOwner: options.deferToOtherOwner,
      propagateStateErrors: options.propagateStateErrors,
    },
  );
  if (result.mergeOk) {
    const merged = await dependencies.getTask(task.id);
    if (merged)
      dependencies.broadcast({ type: 'task_updated', payload: merged });
    return true;
  }

  // Completion and integration are separate lifecycle outcomes. Once the
  // task worktree is committed, unrelated edits in the shared default
  // checkout must not keep a non-deploy task open. Preserve the branch and
  // worktree so a later done -> same-done action can retry integration.
  // Deploy paths remain strict because they must build the integrated tip.
  if (
    source === 'completion' &&
    usesTaskBranch &&
    result.failureKind === 'environment' &&
    (result.blockers?.length ?? 0) > 0
  ) {
    const notice = dependencies.appendTaskMessage(task.project_id, {
      task_id: task.id,
      role: 'system',
      entry_type: 'system_notice',
      content:
        `**Task completed; integration pending** — its changes are safely committed on branch \`${fresh.branch_name}\`. ` +
        `Unrelated changes in the shared default checkout prevented integration. The task branch and worktree were retained; move the completed card to the same done stage after the default checkout is clean to retry.`,
      created_at: new Date().toISOString(),
    });
    if (notice) {
      dependencies.broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: notice,
        },
      });
    }
    logger.info(
      { task_id: task.id, blockers: result.blockers?.length ?? 0 },
      'Task completion allowed with default-branch integration pending',
    );
    return true;
  }

  if (result.failureKind !== 'conflict') {
    const stages = getGroupStages(group);
    const retryStageId = getInitialStage(stages)?.id ?? fresh.status;
    await dependencies.updateTask(task.id, {
      status: retryStageId,
      completed_at: null,
    });
    const held =
      result.failureKind === 'approval_required'
        ? await requestApprovalForHeldMerge(task, group, result, {
            parkedStageId: retryStageId,
            resume: false,
          })
        : undefined;
    if (held?.approval) options.onApprovalRequired?.(held.approval);
    const notice = dependencies.appendTaskMessage(task.project_id, {
      task_id: task.id,
      role: 'system',
      entry_type: 'system_notice',
      content:
        held?.notice ??
        `**Task checkpoint pending** — changes could not be committed to the configured default branch. ` +
          `The task was paused in \`${retryStageId}\` and was not finalized. Retry after correcting the Git environment.\n\n${result.output}`,
      created_at: new Date().toISOString(),
    });
    if (notice) {
      dependencies.broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: notice,
        },
      });
    }
    const pending = await dependencies.getTask(task.id);
    if (pending) {
      dependencies.broadcast({ type: 'task_updated', payload: pending });
    }
    logger.warn(
      { task_id: task.id, toStage: retryStageId, output: result.output },
      result.failureKind === 'approval_required'
        ? 'Task merge needs human approval — parking without completion'
        : 'Task checkpoint environment error — parking without completion',
    );
    return false;
  }

  const stages = getGroupStages(group);
  const reworkStage = getFirstExecutableStage(stages);
  if (reworkStage) {
    appendMergeConflictReworkPrompt(
      fresh,
      reworkStage.id,
      group.settings?.defaultBranch || 'develop',
      result.output,
      dependencies,
    );
    await dependencies.updateTask(task.id, {
      status: reworkStage.id,
      completed_at: null,
    });
    const updated = await dependencies.getTask(task.id);
    if (updated)
      dependencies.broadcast({ type: 'task_updated', payload: updated });
  }
  logger.warn(
    { task_id: task.id, toStage: reworkStage?.id, output: result.output },
    'Merge conflict on deploy — returning task to implementation',
  );
  return false;
}

/**
 * Queue a task for deploy.  All tasks that arrive within the debounce
 * window for the same project are batched: branches merged sequentially,
 * then `build_service` called once.
 */
export function queueDeploy(
  task: Task,
  group: RegisteredGroup,
  lifecycleRunId = `deploy:${task.id}:${Date.now()}`,
  stageEntryEventId?: string,
  dependencies: DeployBatchDependencies = defaultDeployBatchDependencies,
): void {
  const project_id = task.project_id;
  const existing = pendingDeploys.get(project_id);

  if (existing) {
    // Re-queueing a task replaces its entry so it merges and deploys once.
    const entry = { task, lifecycleRunId, stageEntryEventId };
    const index = existing.tasks.findIndex((item) => item.task.id === task.id);
    if (index >= 0) existing.tasks[index] = entry;
    else existing.tasks.push(entry);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(
      () => flushDeploy(project_id),
      DEPLOY_DEBOUNCE_MS,
    );
  } else {
    const timer = setTimeout(() => flushDeploy(project_id), DEPLOY_DEBOUNCE_MS);
    pendingDeploys.set(project_id, {
      tasks: [{ task, lifecycleRunId, stageEntryEventId }],
      group,
      timer,
      dependencies,
      releaseBuildHold: group.settings?.deployService
        ? holdServiceBuild(group.settings.deployService)
        : undefined,
    });
  }
}

export async function flushDeploy(project_id: string): Promise<void> {
  const pending = pendingDeploys.get(project_id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingDeploys.delete(project_id);

  try {
    await flushDeployBatch(
      pending.tasks.map((item) => item.task),
      pending.group,
      pending.dependencies,
      new Map(pending.tasks.map((item) => [item.task.id, item.lifecycleRunId])),
      new Map(
        pending.tasks
          .filter((item) => item.stageEntryEventId)
          .map((item) => [item.task.id, item.stageEntryEventId!]),
      ),
    );
  } finally {
    pending.releaseBuildHold?.();
  }
}

async function taskStillInDeploy(
  task: Task,
  deployStageId: string,
  readTask: typeof getTask = getTask,
): Promise<Task | undefined> {
  const fresh = await readTask(task.id);
  if (!fresh || fresh.archived || fresh.status !== deployStageId) {
    logger.info(
      { task_id: task.id, status: fresh?.status, archived: fresh?.archived },
      'Skipping task no longer in deploy',
    );
    return undefined;
  }
  return fresh;
}

/** Merge a queued batch and deploy every task whose merge succeeded. */
export async function flushDeployBatch(
  tasks: Task[],
  group: RegisteredGroup,
  dependencies: DeployBatchDependencies = defaultDeployBatchDependencies,
  lifecycleRunIds?: ReadonlyMap<string, string>,
  stageEntryEventIds?: ReadonlyMap<string, string>,
): Promise<void> {
  const readyTasks: Task[] = [];
  const needsLease = tasks.some((item) =>
    requiresSharedCheckoutLease(item, group),
  );
  const acquireLease =
    dependencies.acquireSharedCheckoutLease ?? acquireSharedCheckoutLease;
  const lease = needsLease
    ? await acquireLease(group.folder, {
        type: 'task',
        id: `deploy-batch:${Date.now()}`,
      })
    : undefined;
  try {
    // Merge all task branches sequentially while holding the project lease.
    // Re-read each task here, after the debounce and lease wait: a card that
    // was deleted, archived or moved out of deploy meanwhile is dropped.
    const deployStageId =
      getDeployStageId(group.settings, getGroupStages(group)) ?? 'deploy';
    const seen = new Set<string>();
    for (const t of tasks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const fresh = await taskStillInDeploy(
        t,
        deployStageId,
        dependencies.getTask,
      );
      if (!fresh) continue;
      let ready = true;
      if (requiresSharedCheckoutLease(fresh, group)) {
        try {
          ready = await dependencies.mergeBranchForDeploy(
            fresh,
            group,
            'deploy_batch',
            undefined,
            { leaseAlreadyHeld: true },
          );
        } catch (err) {
          ready = false;
          logger.warn(
            { err, task_id: t.id },
            'merge/worktree cleanup failed on deploy stage',
          );
        }
      }
      if (ready) readyTasks.push((await dependencies.getTask(t.id)) ?? fresh);
    }
  } finally {
    await lease?.release();
  }

  // Build once for the successful subset after all Git mutations finish.
  // Experiment cards stay in the batch for their deploy transition and
  // completion bookkeeping; runDeploy skips the build for them.
  if (readyTasks.length > 0 && group.settings?.deployService) {
    try {
      await dependencies.triggerDeploy(readyTasks[0], group, {
        skipMerge: true,
        batchTasks: readyTasks,
        lifecycleRunIds,
        stageEntryEventIds,
      });
    } catch (err) {
      logger.error(
        { error: String(err) },
        'Deploy trigger failed after batch merge',
      );
    }
  }
}

const HOST_BUILD_POLL_MS = 15_000;
/** One status call must not be able to stall the pickup/run timeout checks. */
const HOST_BUILD_STATUS_CALL_TIMEOUT_MS = 30_000;
/** A queued request nobody claims means the host runner is not installed. */
const HOST_BUILD_PICKUP_TIMEOUT_MS = 10 * 60_000;
const HOST_BUILD_RUN_TIMEOUT_MS = 3 * 60 * 60_000;
const HOST_BUILD_RUN_TIMEOUT_RESULT =
  'The host build did not finish within 3 hours.';

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface ServiceBuildResult {
  isError: boolean;
  stdout: string;
  /** Built by the host runner (CarapaBox `build: host-request`). */
  hostBuild?: boolean;
}

/** A host build request accepted by CarapaBox and awaiting its result. */
export interface HostBuildRequest {
  service: string;
  requestedAt: string | number;
  /** Epoch ms when the request was queued. */
  queuedAt: number;
}

type BuildToolCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ isError: boolean; stdout: string }>;

const defaultCallTool: BuildToolCaller = (name, args) =>
  getSandboxClient().callTool(
    name,
    args,
    name === 'build_service' ? BUILD_SERVICE_CALL_OPTIONS : undefined,
  );

/**
 * Poll the host runner until the request settles or a timeout elapses. Each
 * status call has its own timeout so a hung call cannot stall the checks.
 */
async function pollHostBuild(
  request: HostBuildRequest,
  callTool: BuildToolCaller = defaultCallTool,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  now: () => number = Date.now,
  statusTimeoutMs: number = HOST_BUILD_STATUS_CALL_TIMEOUT_MS,
): Promise<ServiceBuildResult> {
  let runningSince: number | null = null;
  for (;;) {
    await sleep(HOST_BUILD_POLL_MS);
    let status: any = null;
    try {
      const reply = await withTimeout(
        callTool('build_service_status', {
          name: request.service,
          requestedAt: request.requestedAt,
        }),
        statusTimeoutMs,
        `timed out after ${statusTimeoutMs}ms`,
      );
      if (reply.isError) {
        return { isError: true, stdout: reply.stdout, hostBuild: true };
      }
      status = parseJson(reply.stdout);
    } catch (err) {
      // CarapaBox may be restarting; the request file survives it.
      logger.warn(
        { service: request.service, error: String(err) },
        'Host build status check failed — retrying',
      );
    }
    if (status?.state === 'succeeded' || status?.state === 'failed') {
      return {
        isError: status.state === 'failed',
        stdout:
          `Host build ${status.state} (exit ${status.exitCode}). Log: ${status.logPath}\n\n` +
          (status.logTail ?? ''),
        hostBuild: true,
      };
    }
    if (status?.state === 'running') runningSince ??= now();
    if (
      runningSince === null &&
      now() - request.queuedAt > HOST_BUILD_PICKUP_TIMEOUT_MS
    ) {
      return {
        isError: true,
        stdout:
          'The host build runner did not pick up the request within 10 minutes. ' +
          'Check that its cron job (my-stacks/scripts/host-build-runner.py) is installed.',
        hostBuild: true,
      };
    }
    if (
      runningSince !== null &&
      now() - runningSince > HOST_BUILD_RUN_TIMEOUT_MS
    ) {
      return {
        isError: true,
        stdout: HOST_BUILD_RUN_TIMEOUT_RESULT,
        hostBuild: true,
      };
    }
  }
}

/**
 * Build a managed service through CarapaBox. A `build: host-request` service
 * returns a queued request; wait for the host runner's result so the task
 * outcome reflects the real build.
 */
export async function buildManagedService(
  serviceName: string,
  callTool: BuildToolCaller = defaultCallTool,
  onQueued?: (request: HostBuildRequest) => void | Promise<void>,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  now: () => number = Date.now,
  statusTimeoutMs: number = HOST_BUILD_STATUS_CALL_TIMEOUT_MS,
): Promise<ServiceBuildResult> {
  const result = await callTool('build_service', { name: serviceName });
  const queued = result.isError ? null : parseJson(result.stdout);
  if (queued?.status !== 'queued') return result;

  const request: HostBuildRequest = {
    service: serviceName,
    requestedAt: queued.requestedAt,
    queuedAt: now(),
  };
  await onQueued?.(request);
  return pollHostBuild(request, callTool, sleep, now, statusTimeoutMs);
}

export async function triggerDeploy(
  task: Task,
  group: RegisteredGroup,
  opts?: TriggerDeployOptions,
): Promise<boolean> {
  const deployService = group.settings?.deployService;
  if (!deployService) return false;
  // Count the merge and stage updates before the tracked build call too.
  const release = holdServiceBuild(deployService);
  try {
    return await runDeploy(task, group, opts);
  } finally {
    release();
  }
}

interface TriggerDeployOptions {
  skipMerge?: boolean;
  /** Build an A/B experiment card (the picked winner) like an ordinary task. */
  bypassAbExperimentGate?: boolean;
  batchTasks?: Task[];
  lifecycleRunId?: string;
  lifecycleRunIds?: ReadonlyMap<string, string>;
  /** Receipt created before deploy was invoked (for same-status updates). */
  stageEntryEventId?: string;
  stageEntryEventIds?: ReadonlyMap<string, string>;
  buildService?: (serviceName: string) => Promise<ServiceBuildResult>;
  /** Overrides for the default managed-service build (tool calls, timers). */
  hostBuild?: Pick<
    ResumeHostBuildDependencies,
    'callTool' | 'sleep' | 'now' | 'statusTimeoutMs'
  >;
  notifyLifecycle?: typeof notifyEntityLifecycle;
}

/** Store (or, with null, clear) the queued host build request on tasks. */
async function setPendingHostBuild(
  deployTasks: Task[],
  request: HostBuildRequest | null,
): Promise<void> {
  for (const deployTask of deployTasks) {
    try {
      if (request) {
        await updateTask(
          deployTask.id,
          {
            custom_values: {
              [DEPLOY_HOST_BUILD_KEY]: JSON.stringify(request),
            },
          },
          { mergeCustomValues: true },
        );
      } else {
        await updateTask(
          deployTask.id,
          {},
          { omitCustomValueKeys: [DEPLOY_HOST_BUILD_KEY] },
        );
      }
    } catch (err) {
      logger.warn(
        { err, task_id: deployTask.id },
        'Could not update pending host build marker',
      );
    }
  }
}

function clearPendingHostBuild(deployTasks: Task[]): Promise<void> {
  return setPendingHostBuild(deployTasks, null);
}

/** Atomically clear `deploy_pending_dispatch` from tasks that carry it. */
export async function clearPendingDeployDispatch(
  deployTasks: Task[],
  { bestEffort = false }: { bestEffort?: boolean } = {},
): Promise<void> {
  for (const deployTask of deployTasks) {
    try {
      await updateTask(
        deployTask.id,
        {},
        { omitCustomValueKeys: [DEPLOY_PENDING_DISPATCH_KEY] },
      );
    } catch (err) {
      if (!bestEffort) throw err;
      logger.warn(
        { err, task_id: deployTask.id },
        'Could not clear pending deploy dispatch marker',
      );
    }
  }
}

function parseHostBuildRequest(value: unknown): HostBuildRequest | null {
  const parsed = typeof value === 'string' ? parseJson(value) : null;
  if (
    !parsed ||
    typeof parsed.service !== 'string' ||
    !(
      typeof parsed.requestedAt === 'string' ||
      typeof parsed.requestedAt === 'number'
    ) ||
    typeof parsed.queuedAt !== 'number'
  ) {
    return null;
  }
  return {
    service: parsed.service,
    requestedAt: parsed.requestedAt,
    queuedAt: parsed.queuedAt,
  };
}

/**
 * Cards this process deployed from a boot dispatch, so the boot queue resume
 * does not deploy them again when the deploy stage is an executable one: they
 * stay in the stage after the build. The hold lasts for that stage visit: any
 * later move of the card ends it.
 */
const bootDispatchedDeploys = new Map<string, string>();

onTaskStatusChanged((taskId) => bootDispatchedDeploys.delete(taskId));

/** True while the queue must leave a card its boot dispatch already deployed. */
export function isHeldByBootDeployDispatch(task: Task): boolean {
  return bootDispatchedDeploys.get(task.id) === task.status;
}

export interface RecoverPendingDeployDispatchesDependencies {
  groups?: () => Iterable<RegisteredGroup>;
  /** Only dispatch handoffs written by finished-run recovery. */
  recoveredOnly?: boolean;
  triggerDeploy?: typeof triggerDeploy;
  buildService?: TriggerDeployOptions['buildService'];
  hostBuild?: TriggerDeployOptions['hostBuild'];
  notifyLifecycle?: typeof notifyEntityLifecycle;
}

/**
 * Dispatch deploy handoffs that persisted the `deploy` stage transition and
 * `deploy_pending_dispatch` marker just before a board restart, before
 * `runDeploy` reached the build call. Cards without the marker, archived cards,
 * cards in non-deploy done stages, projects without `deployService`, and cards
 * already carrying `deploy_host_build` are left alone.
 */
export async function recoverPendingDeployDispatches(
  deps: RecoverPendingDeployDispatchesDependencies = {},
): Promise<Array<Promise<void>>> {
  const dispatch = deps.triggerDeploy ?? triggerDeploy;
  const dispatched: Array<Promise<void>> = [];
  const overrideOpts: Partial<TriggerDeployOptions> = {
    ...(deps.buildService ? { buildService: deps.buildService } : {}),
    ...(deps.hostBuild ? { hostBuild: deps.hostBuild } : {}),
    ...(deps.notifyLifecycle ? { notifyLifecycle: deps.notifyLifecycle } : {}),
  };
  for (const group of deps.groups?.() ?? Object.values(registeredGroups)) {
    if (!group.settings?.deployService) continue;
    const stages = getGroupStages(group);
    const deployStageId = getDeployStageId(group.settings, stages);
    if (!deployStageId) continue;
    for (const task of await getTasksByProjectAndStatuses(group.folder, [
      deployStageId,
    ])) {
      if (task.archived) continue;
      const pending = task.custom_values?.[DEPLOY_PENDING_DISPATCH_KEY];
      if (!pending) continue;
      if (
        deps.recoveredOnly &&
        !String(pending).startsWith(RECOVERED_DISPATCH_PREFIX)
      )
        continue;
      if (task.custom_values?.[DEPLOY_HOST_BUILD_KEY] != null) continue;
      logger.info(
        {
          task_id: task.id,
          project_id: group.folder,
          service: group.settings.deployService,
        },
        'Dispatching pending deploy handoff interrupted by restart',
      );
      bootDispatchedDeploys.set(task.id, deployStageId);
      dispatched.push(
        dispatch(task, group, {
          skipMerge: true,
          ...overrideOpts,
        }).then(() => undefined),
      );
    }
  }
  return dispatched;
}

export interface ResumeHostBuildDependencies {
  groups?: () => Iterable<RegisteredGroup>;
  callTool?: BuildToolCaller;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  statusTimeoutMs?: number;
  notifyLifecycle?: typeof notifyEntityLifecycle;
}

/**
 * Resume waiting for host builds that were queued before a board restart.
 * Finds deploy-stage tasks carrying `deploy_host_build`, groups them by
 * request, and polls each request to its outcome. Returns one promise per
 * resumed request; callers must not block startup on them. Each resumed
 * service build is held before this function returns.
 */
export async function recoverPendingHostBuilds(
  deps: ResumeHostBuildDependencies = {},
): Promise<Array<Promise<void>>> {
  const now = deps.now ?? Date.now;
  const resumed: Array<Promise<void>> = [];
  for (const group of deps.groups?.() ?? Object.values(registeredGroups)) {
    if (!group.settings?.deployService) continue;
    const stages = getGroupStages(group);
    const stageIds = [
      ...new Set([
        getDeployStageId(group.settings, stages),
        ...stages
          .filter((stage) => stage.type === 'done' && !stage.inactive)
          .map((stage) => stage.id),
      ]),
    ].filter((id): id is string => !!id);
    const deployStageId = getDeployStageId(group.settings, stages);
    const pending = new Map<
      string,
      { request: HostBuildRequest; tasks: Task[] }
    >();
    for (const task of await getTasksByProjectAndStatuses(
      group.folder,
      stageIds,
    )) {
      const request = parseHostBuildRequest(
        task.custom_values?.[DEPLOY_HOST_BUILD_KEY],
      );
      if (!request) continue;
      const key = `${request.service}\0${request.requestedAt}`;
      const entry = pending.get(key) ?? { request, tasks: [] };
      entry.tasks.push(task);
      pending.set(key, entry);
      // An active deploy stage keeps the card after the build, so the queue
      // must neither start it while the resumed build runs nor after it.
      if (
        task.status === deployStageId &&
        findStage(stages, task.status)?.type !== 'done'
      ) {
        bootDispatchedDeploys.set(task.id, task.status);
      }
    }
    for (const { request, tasks: batch } of pending.values()) {
      logger.info(
        { service: request.service, task_ids: batch.map((t) => t.id) },
        'Resuming host build queued before restart',
      );
      const release = holdServiceBuild(request.service);
      resumed.push(
        (async () => {
          try {
            const result =
              now() - request.queuedAt > HOST_BUILD_RUN_TIMEOUT_MS
                ? {
                    isError: true,
                    stdout: HOST_BUILD_RUN_TIMEOUT_RESULT,
                    hostBuild: true,
                  }
                : await pollHostBuild(
                    request,
                    deps.callTool,
                    deps.sleep,
                    deps.now,
                    deps.statusTimeoutMs,
                  );
            await writeDeployOutcome({
              task: batch[0]!,
              group,
              stages,
              deployStageId: deployStageId ?? 'deploy',
              serviceName: request.service,
              graceful: group.settings?.gracefulDeploy === true,
              deployTasks: batch,
              result,
              deployStageEntryEventIds: new Map(),
              notifyOutcome: deployOutcomeNotifier(deps.notifyLifecycle),
            });
          } catch (err) {
            logger.error(
              { err, service: request.service },
              'Resumed host build outcome failed',
            );
          } finally {
            release();
          }
        })(),
      );
    }
  }
  return resumed;
}

function deployOutcomeNotifier(
  notifyLifecycle: typeof notifyEntityLifecycle = notifyEntityLifecycle,
  lifecycle?: { runIds?: ReadonlyMap<string, string>; runId?: string },
): DeployOutcomeContext['notifyOutcome'] {
  return async (
    deployTask,
    event,
    fallbackRunId,
    stageEntryEventId,
    publishFailed,
  ) => {
    const notification = {
      group_folder: deployTask.project_id,
      task_id: deployTask.id,
      run_id:
        lifecycle?.runIds?.get(deployTask.id) ??
        lifecycle?.runId ??
        fallbackRunId,
      event,
      title:
        event === 'completed'
          ? `Task completed: ${deployTask.title}`
          : `Task failed: ${deployTask.title}`,
      defer_stage_entry: true,
      stage_entry_event_id: stageEntryEventId,
    };
    // A failure with a brain event is held while an objective handles it.
    if (publishFailed) {
      return publishEventAndNotify(
        deployTask,
        'task_failed',
        publishFailed,
        notification,
        { notify: notifyLifecycle },
      );
    }
    return notifyLifecycle(notification);
  };
}

/** The `task_failed` brain event of a deploy that failed or errored. */
function deployFailedPublisher(
  deployTask: Task,
  group: RegisteredGroup,
  error: string,
): ObjectiveEventPublisher {
  return (timestamp) =>
    publishEventWithResult(
      resolveBrainUrl(resolveBrainContainer(group)),
      {
        type: 'task_failed',
        project_id: deployTask.project_id,
        task_id: deployTask.id,
        objective_id: deployTask.objective_id ?? null,
        timestamp,
        data: { ...taskEventHeaders(deployTask, group), error },
      },
      group,
    );
}

interface DeployOutcomeContext {
  /** Task named in log lines and the brain `deploy_ready` event. */
  task: Task;
  group: RegisteredGroup;
  stages: StageDefinition[];
  deployStageId: string;
  serviceName: string;
  graceful: boolean;
  deployTasks: Task[];
  result: ServiceBuildResult;
  deployStageEntryEventIds: ReadonlyMap<string, string>;
  notifyOutcome: (
    deployTask: Task,
    event: 'completed' | 'failed',
    fallbackRunId: string,
    stageEntryEventId?: string,
    /** Publishes the `task_failed` brain event; `deployTask` must be in Failed. */
    publishFailed?: ObjectiveEventPublisher,
  ) => Promise<unknown>;
}

/**
 * Record a settled build: deploy notice, task completion or failure, and the
 * events that follow. Shared by live deploys and resumed host builds so both
 * produce the same outcome.
 */
async function writeDeployOutcome(ctx: DeployOutcomeContext): Promise<void> {
  const {
    task,
    group,
    stages,
    deployStageId,
    serviceName,
    graceful,
    result,
    deployStageEntryEventIds,
    notifyOutcome,
  } = ctx;
  await clearPendingHostBuild(ctx.deployTasks);
  // Notify UI clients that a new build is available (for restart indicator)
  if (!result.isError) {
    broadcast({ type: 'deploy_ready', payload: { service: serviceName } });
  }

  // Host builds only build; restarts stay explicit.
  if (!result.isError && graceful && !result.hostBuild) {
    // Notify ALL groups that use this service and have a brain container.
    // This fans out the deploy_ready event so every brain instance using
    // the rebuilt image gets notified (not just the triggering project).
    const now = new Date().toISOString();
    for (const g of Object.values(registeredGroups)) {
      if (!g.settings?.brainContainer?.startsWith(serviceName)) continue;
      const brainUrl = resolveBrainUrl(resolveBrainContainer(g));
      if (!brainUrl) continue;
      logger.info(
        {
          task_id: task.id,
          service: serviceName,
          group: g.folder,
          brainUrl,
        },
        'Build succeeded — sending deploy_ready event',
      );
      publishEvent(
        brainUrl,
        {
          type: 'deploy_ready',
          project_id: g.folder,
          task_id: task.id,
          timestamp: now,
          data: { service: serviceName },
        },
        g,
      );
    }
  }

  for (const candidate of ctx.deployTasks) {
    const deployTask = await taskStillInDeploy(candidate, deployStageId);
    if (!deployTask) continue;
    const deployMsg = appendTaskMessage(deployTask.project_id, {
      task_id: deployTask.id,
      role: 'system',
      entry_type: 'system_notice',
      content: formatDeployLog(serviceName, result.stdout, result.isError),
      agent_name: 'deploy',
      created_at: new Date().toISOString(),
    });
    if (deployMsg) {
      broadcast({
        type: 'task_message',
        payload: {
          task_id: deployTask.id,
          project_id: deployTask.project_id,
          message: deployMsg,
        },
      });
    }

    if (result.isError) {
      const failedStage = getFailedStage(stages);
      const failedAt = new Date().toISOString();
      const stageEntryEvent = await updateTask(deployTask.id, {
        status: failedStage?.id ?? 'failed',
        error: `Deploy failed: ${deployFailureExcerpt(result.stdout)}`,
        completed_at: failedAt,
      });
      broadcast({
        type: 'task_completed',
        payload: {
          task_id: deployTask.id,
          project_id: deployTask.project_id,
        },
      });
      const failedTask = {
        ...deployTask,
        status: failedStage?.id ?? 'failed',
      };
      await notifyOutcome(
        failedTask,
        'failed',
        `deploy:${deployTask.id}:${failedAt}`,
        stageEntryEvent?.id,
        deployFailedPublisher(
          failedTask,
          group,
          `Deploy failed: ${deployFailureExcerpt(result.stdout)}`,
        ),
      );
    } else {
      // Deploy succeeded — stay in deploy stage, just mark completed
      await recordDeployCompleted(
        deployTask,
        group,
        deployStageId,
        deployStageEntryEventIds.get(deployTask.id),
        notifyOutcome,
      );
    }
  }
}

/** Completion bookkeeping for a task that reached done in the deploy stage. */
async function recordDeployCompleted(
  deployTask: Task,
  group: RegisteredGroup,
  deployStageId: string,
  stageEntryEventId: string | undefined,
  notifyOutcome: DeployOutcomeContext['notifyOutcome'],
): Promise<void> {
  const completed_at = new Date().toISOString();
  await updateTask(deployTask.id, { completed_at });
  broadcast({
    type: 'task_completed',
    payload: {
      task_id: deployTask.id,
      project_id: deployTask.project_id,
    },
  });
  publishEvent(
    resolveBrainUrl(resolveBrainContainer(group)),
    {
      type: 'task_completed',
      project_id: deployTask.project_id,
      task_id: deployTask.id,
      objective_id: deployTask.objective_id ?? null,
      timestamp: completed_at,
      data: {
        ...taskEventHeaders(deployTask, group),
        status: deployStageId,
      },
    },
    group,
  );
  await notifyOutcome(
    deployTask,
    'completed',
    `deploy:${deployTask.id}:${completed_at}`,
    stageEntryEventId,
  );
}

async function runDeploy(
  task: Task,
  group: RegisteredGroup,
  opts?: TriggerDeployOptions,
): Promise<boolean> {
  const settings = group.settings;
  if (!settings?.deployService) return false;

  const stages = getGroupStages(group);
  const deployStageId = getDeployStageId(settings, stages) ?? 'deploy';
  const serviceName = settings.deployService;
  const transitionTasks = opts?.batchTasks?.length
    ? [...new Map(opts.batchTasks.map((item) => [item.id, item])).values()]
    : [task];
  // A/B experiment cards reach done without a merge or a service build; they
  // still get the same transition and completion bookkeeping below.
  const isGatedExperiment = (t: Task) =>
    !opts?.bypassAbExperimentGate && isAbExperimentTask(t);
  const deployTasks = transitionTasks.filter((t) => !isGatedExperiment(t));
  const experimentTasks = transitionTasks.filter(isGatedExperiment);
  const deployStageEntryEventIds = new Map<string, string>(
    opts?.stageEntryEventIds,
  );
  if (opts?.stageEntryEventId) {
    deployStageEntryEventIds.set(
      transitionTasks[0]!.id,
      opts.stageEntryEventId,
    );
  }
  const notifyOutcome = deployOutcomeNotifier(opts?.notifyLifecycle, {
    runIds: opts?.lifecycleRunIds,
    runId: opts?.lifecycleRunId,
  });

  logger.info(
    { task_id: task.id, service: serviceName },
    'Deploy stage: triggering auto-deploy',
  );

  // A deploy stage is also a done stage. Finalize Git before exposing that
  // status; callers that already merged a batch explicitly opt out.
  let merged = !!opts?.skipMerge;
  try {
    if (!opts?.skipMerge) {
      if (
        !(await mergeBranchForDeploy(task, group, 'deploy', undefined, {
          bypassAbExperimentGate: opts?.bypassAbExperimentGate,
        }))
      ) {
        await clearPendingDeployDispatch(transitionTasks, { bestEffort: true });
        return false;
      }
      merged = true;
    }

    // Ensure every successfully merged batch member is in deploy and notify UI.
    for (const deployTask of transitionTasks) {
      // A card entering deploy here (an agent handoff) carries the dispatch
      // receipt with the transition, so a restart before the build call is
      // redispatched at boot. Cards already in deploy keep their own marker.
      const marksDispatch =
        deployTask.status !== deployStageId && !isGatedExperiment(deployTask);
      const stageEntryEvent = await updateTask(
        deployTask.id,
        {
          status: deployStageId,
          ...(marksDispatch
            ? {
                custom_values: {
                  [DEPLOY_PENDING_DISPATCH_KEY]: new Date().toISOString(),
                },
              }
            : {}),
        },
        marksDispatch ? { mergeCustomValues: true } : undefined,
      );
      if (stageEntryEvent) {
        deployStageEntryEventIds.set(deployTask.id, stageEntryEvent.id);
      }
      // Re-read the persisted row after the transition. The broadcast
      // payload must be the full task: the UI invalidates task queries from
      // payload.project_id, so a partial payload degrades every client to a
      // global task-list refetch.
      const updatedTask = (await getTask(deployTask.id)) ?? deployTask;
      broadcast({
        type: 'task_updated',
        payload: {
          ...updatedTask,
          status: deployStageId,
        },
      });
    }

    for (const experimentTask of experimentTasks) {
      await recordDeployCompleted(
        experimentTask,
        group,
        deployStageId,
        deployStageEntryEventIds.get(experimentTask.id),
        notifyOutcome,
      );
    }
    if (experimentTasks.length > 0) {
      await clearPendingDeployDispatch(experimentTasks, { bestEffort: true });
    }
    if (deployTasks.length === 0) return true;
  } catch (err) {
    // Once the merge has settled, keep the build's dispatch receipt until the
    // build takes ownership below: recoverPendingDeployDispatches redispatches
    // it (without a merge) on the next boot. Experiment cards have no build.
    await clearPendingDeployDispatch(
      merged ? experimentTasks : transitionTasks,
      {
        bestEffort: true,
      },
    );
    throw err;
  }

  try {
    const graceful = group.settings?.gracefulDeploy === true;

    // Build the image. Restart is handled by the service health watcher
    // (service-watcher.ts) or manually. The task completes after a successful build.
    logger.info(
      { task_id: task.id, service: serviceName },
      'Deploy stage: building image',
    );

    // Clear the handoff marker immediately before calling the build/deploy
    // service so a self-deploy kill cannot cause a rebuild loop on next boot.
    await clearPendingDeployDispatch(deployTasks);

    const result = await trackServiceBuild(serviceName, () =>
      opts?.buildService
        ? opts.buildService(serviceName)
        : buildManagedService(
            serviceName,
            opts?.hostBuild?.callTool,
            async (request) => {
              await setPendingHostBuild(deployTasks, request);
              for (const deployTask of deployTasks) {
                const notice = appendTaskMessage(deployTask.project_id, {
                  task_id: deployTask.id,
                  role: 'system',
                  entry_type: 'system_notice',
                  content: `**Deploy ${serviceName}:** host build queued; waiting for it to finish.`,
                  agent_name: 'deploy',
                  created_at: new Date().toISOString(),
                });
                if (notice) {
                  broadcast({
                    type: 'task_message',
                    payload: {
                      task_id: deployTask.id,
                      project_id: deployTask.project_id,
                      message: notice,
                    },
                  });
                }
              }
            },
            opts?.hostBuild?.sleep,
            opts?.hostBuild?.now,
            opts?.hostBuild?.statusTimeoutMs,
          ),
    );

    await writeDeployOutcome({
      task: deployTasks[0]!,
      group,
      stages,
      deployStageId,
      serviceName,
      graceful,
      deployTasks,
      result,
      deployStageEntryEventIds,
      notifyOutcome,
    });
  } catch (err) {
    const errStr = err instanceof Error ? err.message : String(err);
    logger.error(
      { task_id: task.id, service: serviceName, error: errStr },
      'Deploy call failed',
    );

    await clearPendingHostBuild(deployTasks);
    await clearPendingDeployDispatch(deployTasks, { bestEffort: true });

    // Record the error so the UI shows what happened
    for (const candidate of deployTasks) {
      const deployTask = await taskStillInDeploy(candidate, deployStageId);
      if (!deployTask) continue;
      const errMsg = appendTaskMessage(deployTask.project_id, {
        task_id: deployTask.id,
        role: 'system',
        entry_type: 'system_notice',
        content: `**Deploy ${serviceName}: ERROR**\n\n\`\`\`\n${errStr}\n\`\`\``,
        agent_name: 'deploy',
        created_at: new Date().toISOString(),
      });
      if (errMsg) {
        broadcast({
          type: 'task_message',
          payload: {
            task_id: deployTask.id,
            project_id: deployTask.project_id,
            message: errMsg,
          },
        });
      }

      const failedStage = getFailedStage(stages);
      const errorAt = new Date().toISOString();
      const stageEntryEvent = await updateTask(deployTask.id, {
        status: failedStage?.id ?? 'failed',
        error: `Deploy error: ${errStr.slice(0, 500)}`,
        completed_at: errorAt,
      });
      broadcast({
        type: 'task_completed',
        payload: {
          task_id: deployTask.id,
          project_id: deployTask.project_id,
        },
      });
      const failedTask = {
        ...deployTask,
        status: failedStage?.id ?? 'failed',
      };
      await notifyOutcome(
        failedTask,
        'failed',
        `deploy:${deployTask.id}:${errorAt}`,
        stageEntryEvent?.id,
        deployFailedPublisher(
          failedTask,
          group,
          `Deploy error: ${errStr.slice(0, 500)}`,
        ),
      );
    }
  }

  return true;
}
