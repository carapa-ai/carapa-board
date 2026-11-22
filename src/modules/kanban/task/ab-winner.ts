import type { RegisteredGroup } from '../../../types.js';
import {
  claimAbWinner,
  clearAbWinner,
  getTask,
  updateTask,
} from '../db-kanban.js';
import {
  findStage,
  getDeployStageId,
  getFirstExecutableStage,
  getGroupStages,
  getInitialStage,
  isAbExperimentParent,
} from '../stages.js';
import type { Task } from '../types.js';
import { broadcast } from '../../objectives/ws-events.js';
import { logger } from '../../../logger.js';
import {
  publishEvent,
  resolveBrainContainer,
  resolveBrainUrl,
} from '../../objectives/brain-client.js';
import { mergeBranchForDeploy } from './deploy.js';
import { taskEventHeaders } from './objective-events.js';
import type { MergeApprovalDetails } from './merge-risk-gate.js';

/** A rejected winner pick, carrying the HTTP status the route should answer with. */
export class AbWinnerError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string,
    /** Set when the merge risk gate holds the variant for a person's approval. */
    readonly approval?: MergeApprovalDetails,
  ) {
    super(message);
    this.name = 'AbWinnerError';
  }
}

export interface AbWinnerDependencies {
  getTask: typeof getTask;
  updateTask: typeof updateTask;
  claimAbWinner: typeof claimAbWinner;
  clearAbWinner: typeof clearAbWinner;
  mergeBranchForDeploy: typeof mergeBranchForDeploy;
  broadcast: typeof broadcast;
  publishEvent: typeof publishEvent;
  resolveBrainUrl: typeof resolveBrainUrl;
  resolveBrainContainer: typeof resolveBrainContainer;
  /** Wake the project queue so dependents of the parent can start. */
  drainQueue: (projectId: string, group: RegisteredGroup) => void;
}

const defaultDependencies: Omit<AbWinnerDependencies, 'drainQueue'> = {
  getTask,
  updateTask,
  claimAbWinner,
  clearAbWinner,
  mergeBranchForDeploy,
  broadcast,
  publishEvent,
  resolveBrainUrl,
  resolveBrainContainer,
};

/**
 * Pick the winning variant of an A/B experiment: merge only that child's
 * branch (through the ordinary deploy merge path, bypassing the experiment
 * gate), then complete the parent, which has no branch of its own. Losing
 * children are left untouched. No build or deploy is started and the winner
 * keeps its done stage, so the call returns as soon as the merge finishes.
 *
 * The winner is claimed with a compare-and-set before any Git work, so
 * concurrent picks produce exactly one winner. A failed merge releases the
 * claim so the user can retry. A merge conflict returns the variant to the
 * rework stage, as for any task. A checkpoint/environment failure (for
 * example a dirty default checkout) makes the deploy merge path park the card
 * in the initial stage; the variant is put back in its done stage with its
 * completion time so it stays selectable, and the "Task checkpoint pending"
 * notice remains as the visible reason.
 */
export async function pickAbWinner(
  group: RegisteredGroup,
  parentId: string,
  winnerTaskId: string,
  dependencies: Pick<AbWinnerDependencies, 'drainQueue'> &
    Partial<AbWinnerDependencies>,
): Promise<Task> {
  const deps = { ...defaultDependencies, ...dependencies };
  const stages = getGroupStages(group);

  const parent = await deps.getTask(parentId);
  if (!parent || parent.project_id !== group.folder) {
    throw new AbWinnerError(404, 'Task not found');
  }
  if (!isAbExperimentParent(parent) && !parent.ab_fork_commit) {
    throw new AbWinnerError(400, 'Task is not an A/B experiment');
  }
  const winner = await deps.getTask(winnerTaskId);
  if (
    !winner ||
    winner.project_id !== group.folder ||
    winner.ab_parent_task_id !== parent.id
  ) {
    throw new AbWinnerError(400, 'taskId is not a variant of this experiment');
  }
  if (findStage(stages, winner.status)?.type !== 'done' || winner.archived) {
    throw new AbWinnerError(400, 'The chosen variant is not done');
  }

  // Resolve the parent's completion stage before any irreversible work.
  const doneStageId = resolveParentDoneStageId(group, stages);
  if (!doneStageId) {
    throw new AbWinnerError(
      400,
      'The project has no done stage other than its deploy stage to complete the experiment in',
    );
  }

  if (!(await deps.claimAbWinner(parent.id, winner.id))) {
    throw new AbWinnerError(409, 'A winner has already been picked');
  }

  let merged = false;
  let approval: MergeApprovalDetails | undefined;
  try {
    merged = await deps.mergeBranchForDeploy(
      winner,
      group,
      'deploy',
      undefined,
      {
        bypassAbExperimentGate: true,
        onApprovalRequired: (held) => {
          approval = held;
        },
      },
    );
  } finally {
    if (!merged) await deps.clearAbWinner(parent.id, winner.id);
  }
  if (!merged) {
    await restoreVariantAfterEnvironmentFailure(deps, group, winner);
    throw new AbWinnerError(
      409,
      'The variant could not be merged; no winner was recorded. See the variant card for details.',
      approval,
    );
  }

  await deps.updateTask(parent.id, {
    status: doneStageId,
    completed_at: new Date().toISOString(),
  });
  logger.info(
    { parent_id: parent.id, winner_id: winner.id },
    '[ab] Winner merged; experiment parent completed',
  );

  // The variants' own task_completed events carry merged: false; tell the
  // owning objective that the winner merged (no deploy runs to publish it).
  const winnerNow = (await deps.getTask(winner.id)) ?? winner;
  deps.publishEvent(
    deps.resolveBrainUrl(deps.resolveBrainContainer(group)),
    {
      type: 'task_completed',
      project_id: winnerNow.project_id,
      task_id: winnerNow.id,
      objective_id: winnerNow.objective_id ?? null,
      timestamp: new Date().toISOString(),
      data: {
        ...taskEventHeaders(winnerNow, group),
        status: winnerNow.status,
        ab_winner: true,
        ab_parent_task_id: parent.id,
      },
    },
    group,
  );

  const updatedParent = (await deps.getTask(parent.id)) ?? parent;
  deps.broadcast({ type: 'task_updated', payload: updatedParent });
  deps.broadcast({
    type: 'task_completed',
    payload: { task_id: parent.id, project_id: parent.project_id },
  });
  // Dependents of the parent are gated on its done status; start them now.
  deps.drainQueue(parent.project_id, group);
  return updatedParent;
}

/**
 * The done stage the experiment parent completes in: the first active done
 * stage that is not the project's deploy stage (entering that stays an
 * explicit move). The deploy stage is the configured `deployStage` or, with a
 * `deployService`, the implicit first done stage. It is never a fallback, so
 * `undefined` means the pick must be rejected before any irreversible work.
 */
function resolveParentDoneStageId(
  group: RegisteredGroup,
  stages: ReturnType<typeof getGroupStages>,
): string | undefined {
  const deployStageId =
    group.settings?.deployStage || group.settings?.deployService
      ? getDeployStageId(group.settings, stages)
      : undefined;
  return stages.find(
    (s) => s.type === 'done' && !s.inactive && s.id !== deployStageId,
  )?.id;
}

/**
 * Undo the deploy merge path's parking of a variant after a non-conflict
 * failure. The failure kind is not reported back, so it is recognised by the
 * variant sitting in the initial stage, where the conflict path never leaves
 * it (it routes to the first executable stage). When those stages coincide the
 * two cases cannot be told apart and the variant is left as the merge path set it.
 */
async function restoreVariantAfterEnvironmentFailure(
  deps: Pick<AbWinnerDependencies, 'getTask' | 'updateTask' | 'broadcast'>,
  group: RegisteredGroup,
  winner: Task,
): Promise<void> {
  const stages = getGroupStages(group);
  const current = await deps.getTask(winner.id);
  const parkedStageId = getInitialStage(stages)?.id;
  if (
    !current ||
    current.status === winner.status ||
    current.status !== parkedStageId ||
    current.status === getFirstExecutableStage(stages)?.id
  ) {
    return;
  }
  await deps.updateTask(winner.id, {
    status: winner.status,
    completed_at: winner.completed_at ?? null,
  });
  const restored = await deps.getTask(winner.id);
  if (restored) deps.broadcast({ type: 'task_updated', payload: restored });
}
