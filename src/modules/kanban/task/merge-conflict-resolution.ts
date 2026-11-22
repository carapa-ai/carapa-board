import type { RegisteredGroup } from '../../../types.js';
import type { TaskBranchMergeResult } from '../../../lib/git-ops.js';
import {
  mergeTaskBranchToDefault,
  TaskStateError,
  withProjectGitLock,
} from '../../../lib/git-ops.js';
import type { Task, TaskMessage } from '../types.js';
import { appendTaskMessage } from '../../transcripts/transcript-store.js';
import { getActiveRunForTask } from '../../../db.js';
import { broadcast } from '../../objectives/ws-events.js';
import { logger } from '../../../logger.js';
import { acquireSharedCheckoutLease } from '../../../concurrency/shared-checkout-lease.js';

import { isAbExperimentTask } from '../stages.js';
import {
  ensureBranchAtPinnedHead,
  evaluateMergeRisk,
  type MergeRiskDependencies,
} from './merge-risk-gate.js';

export interface MergeWithResolutionResult extends TaskBranchMergeResult {
  manualReason?: string;
}

export interface MergeDependencies {
  mergeTaskBranchToDefault: typeof mergeTaskBranchToDefault;
  withProjectGitLock: typeof withProjectGitLock;
  /** Merge risk gate collaborators; the real git and proposals store by default. */
  riskGate?: MergeRiskDependencies;
}

const defaultMergeDependencies: MergeDependencies = {
  mergeTaskBranchToDefault,
  withProjectGitLock,
};

export interface MergeConflictPromptDependencies {
  appendTaskMessage: typeof appendTaskMessage;
  broadcast: typeof broadcast;
}

const defaultPromptDependencies: MergeConflictPromptDependencies = {
  appendTaskMessage,
  broadcast,
};

/**
 * Merge a task branch under the per-project git lock.
 *
 * Real content conflicts are intentionally returned to the lifecycle caller.
 * The task must re-enter implementation, merge the current default branch in
 * its existing worktree, and pass Testing and Review again before another
 * completion merge is attempted.
 */
export async function mergeTaskBranchWithResolution(
  task: Task,
  group: RegisteredGroup,
  source: 'review' | 'deploy' | 'deploy_batch' | 'completion' | 'recovery',
  dependencies: MergeDependencies = defaultMergeDependencies,
  options: {
    leaseAlreadyHeld?: boolean;
    bypassAbExperimentGate?: boolean;
    /** Throw SharedCheckoutBusyError instead of waiting for another owner's lease. */
    deferToOtherOwner?: boolean;
    /** Restart recovery: a failed task-state read is not a merge failure. */
    propagateStateErrors?: boolean;
  } = {},
): Promise<MergeWithResolutionResult> {
  if (isAbExperimentTask(task) && !options.bypassAbExperimentGate) {
    logger.info(
      { task_id: task.id, source },
      '[merge] A/B experiment task: merge skipped',
    );
    return {
      mergeOk: true,
      output: 'A/B experiment task: merge skipped',
      skipped: 'ab_variant',
    };
  }
  // Classify before waiting for the lease so a risky branch never queues for
  // it. The merge is classified again under the project git lock, and the
  // classified head is enforced right before the sandbox merge call.
  const riskDependencies = dependencies.riskGate;
  const early = await evaluateMergeRisk(task, group, source, riskDependencies);
  if (early.blocked) return early.blocked;
  // Restart recovery: a failed read is not a merge failure, it keeps its marker.
  const activeRun = options.propagateStateErrors
    ? await getActiveRunForTask(task.id).catch((error) => {
        throw new TaskStateError(error);
      })
    : await getActiveRunForTask(task.id);
  const lease =
    !options.leaseAlreadyHeld && (!activeRun || task.worktree_path)
      ? await acquireSharedCheckoutLease(
          task.project_id,
          { type: 'task', id: task.id },
          { deferToOtherOwner: options.deferToOtherOwner },
        )
      : undefined;
  let result: TaskBranchMergeResult;
  try {
    result = await dependencies.withProjectGitLock(
      task.project_id,
      async () => {
        const verdict = await evaluateMergeRisk(
          task,
          group,
          source,
          riskDependencies,
        );
        if (verdict.blocked) return verdict.blocked;
        return dependencies.mergeTaskBranchToDefault(task, group, {
          beforeMerge: () =>
            ensureBranchAtPinnedHead(
              task,
              group,
              verdict.pinnedHead,
              riskDependencies,
            ),
        });
      },
    );
  } finally {
    await lease?.release();
  }
  logger.info(
    {
      task_id: task.id,
      source,
      mergeOk: result.mergeOk,
      failureKind: result.failureKind,
    },
    '[merge] Task completion merge finished',
  );
  return result;
}

function buildMergeConflictReworkPrompt(
  defaultBranch: string,
  mergeOutput: string,
): string {
  return [
    '## Merge conflict to resolve',
    '',
    `Merge \`${defaultBranch}\` into your existing task worktree and fix every conflict.`,
    'Preserve the intended task behavior, inspect the resolved diff for accidental loss, run the relevant focused checks and `bun verify`, then commit the conflict resolution.',
    'Do not modify, reset, stash, clean, or discard changes from the default checkout.',
    '',
    'Original merge output:',
    '```',
    mergeOutput.trim() || '(no merge output)',
    '```',
  ].join('\n');
}

/** Append a one-shot prompt for the implementation stage selected by caller. */
export function appendMergeConflictReworkPrompt(
  task: Task,
  targetStage: string,
  defaultBranch: string,
  mergeOutput: string,
  dependencies: MergeConflictPromptDependencies = defaultPromptDependencies,
): TaskMessage {
  const message = dependencies.appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type: 'stage_prompt',
    target_stage: targetStage,
    content: buildMergeConflictReworkPrompt(defaultBranch, mergeOutput),
    created_at: new Date().toISOString(),
  });
  dependencies.broadcast({
    type: 'task_message',
    payload: { task_id: task.id, project_id: task.project_id, message },
  });
  return message;
}
