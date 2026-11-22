import type { RegisteredGroup } from '../../../types.js';
import type { StageDefinition, StageEntryEventRef, Task } from '../types.js';
import { stripAllTestingDecisions, type TestingDecision } from '../testing.js';
import { getTask, updateTask } from '../../../db.js';
import {
  getLastActiveRunForTask,
  updateActiveRunTestingDecision,
} from '../../../db/active-runs.js';
import {
  TESTING_FAILURE_COUNT_KEY,
  TESTING_FAILURE_TOTAL_KEY,
} from '../db-kanban.js';
export { TESTING_FAILURE_COUNT_KEY };
import { appendTaskMessage } from '../../transcripts/transcript-store.js';
import { broadcast } from '../../objectives/ws-events.js';
import {
  publishEvent,
  resolveBrainContainer,
  resolveBrainUrl,
} from '../../objectives/brain-client.js';
import { taskEventHeaders } from './objective-events.js';
import { publishTaskEventAndNotify } from './objective-event-holds.js';
import {
  DEPLOY_PENDING_DISPATCH_KEY,
  mergeBranchForDeploy,
  triggerDeploy,
} from './deploy.js';
import {
  TESTING_CHAIN_KEY,
  TESTING_VERDICTS_KEY,
  nextTestingChainStage,
  readTestingChain,
  resolveCoTestingStages,
  testingRunAlreadyApplied,
  type TestingChain,
  type TestingChainVerdict,
} from './testing-chain.js';
import {
  findStage,
  getDeployStageId,
  getDoneStage,
  getFirstExecutableStage,
  getNextActiveStage,
  getQuestionStage,
  getTestingBlockedStage,
  isQuestionStage,
} from '../stages.js';
import { notifyEntityLifecycle } from '../../tools/push-tools.js';
import {
  runGitInRepo,
  taskUsesWorktree,
  validatedInstance,
} from '../../../lib/git-ops.js';

export interface TestingContext {
  task: Task;
  group: RegisteredGroup;
  stages: StageDefinition[];
  targetStatus: string;
  assistantContent: string;
  agent_name: string | null;
  model_name: string | null;
  runId?: string;
  newSessionId?: string;
  leaseAlreadyHeld?: boolean;
  /** Restart recovery: never wait for another owner's checkout lease. */
  deferToOtherCheckoutOwner?: boolean;
  /** Restart recovery: the run whose result this transition applies. */
  recoveryRunId?: string;
  /**
   * Restart recovery: extra custom values written in the same update as the
   * stage transition (the recovery's proof that it moved the card).
   */
  transitionValues?: (status: string) => Record<string, string>;
  /**
   * Restart recovery: leave the deploy to the `deploy_pending_dispatch`
   * dispatcher (written via `transitionValues`) instead of awaiting the build.
   */
  deferDeploy?: boolean;
  testingHeadSha?: string;
  testingTreeSha?: string;
  stageEntryEventRef?: StageEntryEventRef;
  /** True when the original tester response was persisted before format repair. */
  assistantResponsePersisted?: boolean;
  beforeTransition?: (
    changes?: Parameters<typeof updateTask>[1],
  ) => Promise<boolean>;
  runTransition?: (operation: () => Promise<void>) => Promise<boolean>;
}

export const MAX_CONSECUTIVE_TESTING_FAILURES = 3;
export const TESTING_HEAD_SHA_KEY = 'testing_head_sha';
export const TESTING_TREE_SHA_KEY = 'testing_tree_sha';
// Content identity captured when a Testing run acquired its slot, bound to that
// run. Restart recovery needs it because the live closure holding it is gone.
export const TESTING_INSPECTED_RUN_ID_KEY = 'testing_inspected_run_id';
export const TESTING_INSPECTED_HEAD_SHA_KEY = 'testing_inspected_head_sha';
export const TESTING_INSPECTED_TREE_SHA_KEY = 'testing_inspected_tree_sha';
const TESTING_INSPECTED_KEYS = [
  TESTING_INSPECTED_RUN_ID_KEY,
  TESTING_INSPECTED_HEAD_SHA_KEY,
  TESTING_INSPECTED_TREE_SHA_KEY,
];
const MERGE_OWNED_VALUE_KEYS = [
  'task_diff_base_sha',
  'linked_repository_merges',
] as const;

/** Persist (or clear, when unresolved) the identity a Testing run inspects. */
export async function recordTestingInspectedIdentity(
  task: Task,
  runId: string,
  identity: { headSha: string; treeSha: string } | undefined,
): Promise<void> {
  const latestTask = (await getTask(task.id)) ?? task;
  const customValues = { ...(latestTask.custom_values ?? {}) };
  for (const key of TESTING_INSPECTED_KEYS) delete customValues[key];
  if (identity) {
    customValues[TESTING_INSPECTED_RUN_ID_KEY] = runId;
    customValues[TESTING_INSPECTED_HEAD_SHA_KEY] = identity.headSha;
    customValues[TESTING_INSPECTED_TREE_SHA_KEY] = identity.treeSha;
  }
  await updateTask(task.id, { custom_values: customValues });
}

/** The persisted inspected identity, only when it belongs to `runId`. */
export function readTestingInspectedIdentity(
  task: Task,
  runId: string | undefined,
): { headSha: string; treeSha: string } | undefined {
  const values = task.custom_values ?? {};
  const headSha = values[TESTING_INSPECTED_HEAD_SHA_KEY];
  const treeSha = values[TESTING_INSPECTED_TREE_SHA_KEY];
  if (
    !runId ||
    values[TESTING_INSPECTED_RUN_ID_KEY] !== runId ||
    typeof headSha !== 'string' ||
    typeof treeSha !== 'string' ||
    !headSha ||
    !treeSha
  ) {
    return undefined;
  }
  return { headSha, treeSha };
}

const TESTING_CONTENT_CHANGED_NOTICE =
  '**Testing must run again — tracked content changed after validation.**';

/** Drop a passing verdict and keep the task in Testing for another run. */
export async function retryTestingAfterGitStateChange(
  task: Task,
  targetStatus: string,
  heading: string = TESTING_CONTENT_CHANGED_NOTICE,
): Promise<void> {
  const latestTask = (await getTask(task.id)) ?? task;
  const customValues = { ...(latestTask.custom_values ?? {}) };
  delete customValues[TESTING_HEAD_SHA_KEY];
  delete customValues[TESTING_TREE_SHA_KEY];
  for (const key of TESTING_INSPECTED_KEYS) delete customValues[key];
  // The retest starts from the primary tester in a fresh session: a kept chain
  // would plan an `extra` run against the previous run's stale tree.
  customValues[TESTING_CHAIN_KEY] = '';
  const notice = appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type: 'system_notice',
    content:
      heading +
      `\n\nThe passing verdict was not recorded. The task remains in \`${targetStatus}\` so the final prepared content is validated before Review. CarapaBoard keeps the repository identity used for this check internal; Testing and Review evaluate content only.`,
    created_at: new Date().toISOString(),
  });
  if (notice) {
    broadcast({
      type: 'task_message',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        message: notice,
      },
    });
  }
  await updateTask(task.id, {
    status: targetStatus,
    completed_at: null,
    session_id: '',
    custom_values: customValues,
  });
  const updated = await getTask(task.id);
  if (updated) broadcast({ type: 'task_updated', payload: updated });
}

/** Testing stage whose evidence is required before the selected review stage. */
export function getRequiredTestingStage(
  stages: StageDefinition[],
  reviewStageId: string,
  skipStages?: string[] | null,
): StageDefinition | undefined {
  const reviewIndex = stages.findIndex((stage) => stage.id === reviewStageId);
  if (reviewIndex < 0) return undefined;
  const skipped = new Set(skipStages ?? []);
  for (let index = reviewIndex - 1; index >= 0; index--) {
    const stage = stages[index];
    if (stage.type === 'testing' && !stage.inactive && !skipped.has(stage.id)) {
      return stage;
    }
  }
  return undefined;
}

/**
 * Refusal text when an agent moves a card into a Review stage whose required
 * Testing stage has no stored passing evidence, or null when the move is fine.
 * Looks only at stored evidence: without it the pipeline always defers the
 * review back to Testing, so this never blocks a review that would have run.
 */
export function agentReviewEntryDenial(
  stages: StageDefinition[],
  task: Pick<Task, 'status' | 'skip_stages' | 'custom_values'>,
  targetStatus: string,
): string | null {
  const reviewStage = findStage(stages, targetStatus);
  if (reviewStage?.type !== 'review' || task.status === targetStatus) {
    return null;
  }
  const testingStage = getRequiredTestingStage(
    stages,
    reviewStage.id,
    task.skip_stages,
  );
  if (!testingStage) return null;
  const values = task.custom_values ?? {};
  const hasEvidence = [TESTING_HEAD_SHA_KEY, TESTING_TREE_SHA_KEY].some(
    (key) => typeof values[key] === 'string' && values[key].length > 0,
  );
  if (hasEvidence) return null;
  return `Agents cannot move this task into review stage "${reviewStage.id}": the required Testing stage "${testingStage.id}" has no passing verdict for the current content. Fix what Testing reported (blocked verdicts usually mean missing data or environment), then move it to "${testingStage.id}"; a human may override.`;
}

/**
 * Thrown when a review start is deferred back to Testing. The task is already
 * back in Testing, so the runner logs it at info rather than as an error.
 */
export class ReviewDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewDeferredError';
  }
}

export const TESTING_EVIDENCE_CARRIED_FROM_KEY =
  'testing_evidence_carried_from';

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const GIT_BASE_REF_PATTERN = /^[\w./-]+$/;
const CARRIED_DRIFT_FILE_LIMIT = 10;

/**
 * Decide whether a rebase only pulled unrelated base changes into the task
 * branch: the task's own change must be byte-identical (same paths, modes and
 * blobs) before and after the rebase, and the base drift must touch none of
 * the task's files. Any git failure or unexpected output fails closed.
 * Returns the drifted base files when the evidence can be carried over.
 */
async function findCarriableBaseDrift(
  task: Task,
  group: RegisteredGroup,
  testedHead: string,
  reviewHead: string,
  runGit: typeof runGitInRepo,
): Promise<string[] | undefined> {
  const baseBranch = group.settings?.defaultBranch || 'develop';
  if (
    !GIT_BASE_REF_PATTERN.test(baseBranch) ||
    !GIT_SHA_PATTERN.test(testedHead) ||
    !GIT_SHA_PATTERN.test(reviewHead)
  ) {
    return undefined;
  }
  const instance = validatedInstance(task, group);
  const usesWorktree =
    !!task.branch_name && (taskUsesWorktree(group) || !!task.worktree_path);
  const prefix = usesWorktree ? `-C .worktrees/${task.branch_name} ` : '';
  const git = async (args: string): Promise<string | undefined> => {
    const result = await runGit(group, `${prefix}${args}`, instance);
    return result.ok ? result.output : undefined;
  };

  const newBase = (await git(`merge-base ${baseBranch} ${reviewHead}`))?.trim();
  if (!newBase || !GIT_SHA_PATTERN.test(newBase)) return undefined;
  const oldBase = (await git(`merge-base ${newBase} ${testedHead}`))?.trim();
  if (!oldBase || !GIT_SHA_PATTERN.test(oldBase) || oldBase === newBase) {
    return undefined;
  }

  // Raw full-index output lists every changed path with its mode and old/new
  // blob ids, so equal output means an identical patch without piping.
  const testedChange = await git(
    `diff --raw --full-index --no-renames ${oldBase} ${testedHead}`,
  );
  const reviewChange = await git(
    `diff --raw --full-index --no-renames ${newBase} ${reviewHead}`,
  );
  if (!testedChange?.trim() || testedChange.trim() !== reviewChange?.trim()) {
    return undefined;
  }
  const taskFiles = await git(
    `diff --name-only --no-renames ${newBase} ${reviewHead}`,
  );
  const driftFiles = await git(
    `diff --name-only --no-renames ${oldBase} ${newBase}`,
  );
  if (taskFiles === undefined || driftFiles === undefined) return undefined;
  const taskSet = new Set(taskFiles.split('\n').filter(Boolean));
  const drift = driftFiles.split('\n').filter(Boolean);
  if (taskSet.size === 0 || drift.length === 0) return undefined;
  return drift.some((file) => taskSet.has(file)) ? undefined : drift;
}

/**
 * Keep Review from consuming Testing evidence produced for different content.
 * Legacy evidence without a content fingerprint remains valid only at the
 * exact clean commit that Testing recorded. The one relaxation: a rebase that
 * leaves the task's own change byte-identical and pulls in base changes to
 * files the task does not touch keeps the evidence (re-stamped to the rebased
 * commit).
 */
export async function ensureReviewHasCurrentTestingEvidence(
  task: Task,
  group: RegisteredGroup,
  stages: StageDefinition[],
  reviewStageId: string,
  reviewHeadSha: string | undefined,
  reviewTreeSha: string | undefined,
  runGit: typeof runGitInRepo = runGitInRepo,
): Promise<boolean> {
  const testingStage = getRequiredTestingStage(
    stages,
    reviewStageId,
    task.skip_stages,
  );
  if (!testingStage) return true;

  const persistedTask = (await getTask(task.id)) ?? task;
  // Keep the caller's prepared checkout when the row has not persisted it yet.
  const latestTask: Task = {
    ...persistedTask,
    branch_name: persistedTask.branch_name || task.branch_name,
    worktree_path: persistedTask.worktree_path || task.worktree_path,
  };
  const customValues = latestTask.custom_values ?? {};
  const testedHead = customValues[TESTING_HEAD_SHA_KEY];
  const testedTree = customValues[TESTING_TREE_SHA_KEY];
  const hasStoredTree = Object.prototype.hasOwnProperty.call(
    customValues,
    TESTING_TREE_SHA_KEY,
  );
  const testedHeadSha =
    typeof testedHead === 'string' && testedHead.length > 0
      ? testedHead
      : undefined;
  const testedTreeSha =
    typeof testedTree === 'string' && testedTree.length > 0
      ? testedTree
      : undefined;

  if (
    reviewHeadSha &&
    reviewTreeSha &&
    ((testedTreeSha && testedTreeSha === reviewTreeSha) ||
      (!hasStoredTree && testedHeadSha === reviewHeadSha))
  ) {
    return true;
  }

  if (reviewHeadSha && reviewTreeSha && testedTreeSha && testedHeadSha) {
    const drift = await findCarriableBaseDrift(
      latestTask,
      group,
      testedHeadSha,
      reviewHeadSha,
      runGit,
    );
    if (drift) {
      await updateTask(task.id, {
        custom_values: {
          ...customValues,
          [TESTING_HEAD_SHA_KEY]: reviewHeadSha,
          [TESTING_TREE_SHA_KEY]: reviewTreeSha,
          [TESTING_EVIDENCE_CARRIED_FROM_KEY]: testedHeadSha,
        },
      });
      const shown = drift.slice(0, CARRIED_DRIFT_FILE_LIMIT);
      const more = drift.length - shown.length;
      const carried = appendTaskMessage(task.project_id, {
        task_id: task.id,
        role: 'system',
        entry_type: 'system_notice',
        content:
          `Testing evidence carried over: the base changed ${drift.length} file${drift.length === 1 ? '' : 's'}, none of them touched by this task.` +
          `\n\n${shown.map((file) => `- \`${file}\``).join('\n')}${more > 0 ? `\n- … and ${more} more` : ''}`,
        created_at: new Date().toISOString(),
      });
      if (carried) {
        broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            message: carried,
          },
        });
      }
      const updated = await getTask(task.id);
      if (updated) broadcast({ type: 'task_updated', payload: updated });
      return true;
    }
  }

  const timestamp = new Date().toISOString();
  const notice = appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type: 'system_notice',
    content:
      '**Review deferred — Testing evidence does not match the current tracked content.**' +
      `\n\nThe task was returned to \`${testingStage.id}\` so the current tracked content is validated before Review. CarapaBoard keeps the repository identity used for this check internal; Testing and Review evaluate content only.`,
    created_at: timestamp,
  });
  if (notice) {
    broadcast({
      type: 'task_message',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        message: notice,
      },
    });
  }
  await updateTask(task.id, {
    status: testingStage.id,
    completed_at: null,
  });
  const updated = await getTask(task.id);
  if (updated) broadcast({ type: 'task_updated', payload: updated });
  return false;
}

function verdictMessage(decision: TestingDecision): string {
  const heading =
    decision.decision === 'pass'
      ? '**Testing passed**'
      : decision.decision === 'fail'
        ? '**Testing failed**'
        : '**Testing blocked**';
  const issues = decision.issues.length
    ? `\n\n**Issues:**\n${decision.issues.map((issue) => `- ${issue}`).join('\n')}`
    : '';
  return `${heading}\n\n${decision.summary}${issues}`;
}

/**
 * Persist the tester's original response at its causal run boundary. When the
 * response was only the JSON verdict, the rendered verdict becomes the run
 * result so the run never has an empty result.
 */
export function persistTestingAssistantResponse(
  ctx: Pick<
    TestingContext,
    'task' | 'assistantContent' | 'agent_name' | 'model_name' | 'runId'
  > & { decision?: TestingDecision },
): void {
  const transcriptContent =
    stripAllTestingDecisions(ctx.assistantContent) ||
    (ctx.decision ? verdictMessage(ctx.decision) : '');
  if (!transcriptContent) return;

  const raw = appendTaskMessage(ctx.task.project_id, {
    task_id: ctx.task.id,
    role: 'assistant',
    content: transcriptContent,
    agent_name: ctx.agent_name,
    model_name: ctx.model_name,
    run_id: ctx.runId ?? null,
    entry_type: 'run_result',
    created_at: new Date().toISOString(),
  });
  broadcast({
    type: 'task_message',
    payload: {
      task_id: ctx.task.id,
      project_id: ctx.task.project_id,
      message: raw,
    },
  });
}

/**
 * Why a passing verdict of a tester chain must not count as a pass, as the
 * decision that replaces it; undefined when it may. Every tester must have
 * tested the commit and tree the primary tester left.
 */
function testingChainPassProblem(
  chain: TestingChain | null,
  ctx: TestingContext,
): TestingDecision | undefined {
  const { testingHeadSha, testingTreeSha } = ctx;
  if (!testingHeadSha || !testingTreeSha) {
    return {
      decision: 'blocked',
      issues: [
        'The clean Git commit and content tree this tester inspected could not be resolved, so the testers cannot be confirmed to have tested the same content.',
      ],
      summary: 'Testing could not confirm a shared content identity.',
    };
  }
  if (
    chain &&
    (chain.head !== testingHeadSha || chain.tree !== testingTreeSha)
  ) {
    return {
      decision: 'fail',
      issues: [
        `The task checkout changed between testers: the previous tester passed ${chain.head.slice(0, 7)}, this tester inspected ${testingHeadSha.slice(0, 7)}.`,
      ],
      summary: 'Testers did not test the same content.',
    };
  }
  return undefined;
}

/**
 * Record a passing tester while more testers remain. The card stays in the
 * testing stage so the queue launches the next tester; nothing advances and no
 * evidence is recorded until the last tester passed.
 */
async function continueTestingChain(
  ctx: TestingContext,
  input: { customValues: Record<string, string | number>; chain: TestingChain },
): Promise<void> {
  const { task } = ctx;
  const customValues = { ...input.customValues };
  delete customValues[TESTING_HEAD_SHA_KEY];
  delete customValues[TESTING_TREE_SHA_KEY];
  for (const key of TESTING_INSPECTED_KEYS) delete customValues[key];
  customValues[TESTING_CHAIN_KEY] = JSON.stringify(input.chain);
  const changes = { error: '', custom_values: customValues };
  if (ctx.beforeTransition) {
    if (!(await ctx.beforeTransition(changes))) return;
  } else {
    await updateTask(task.id, changes);
  }
  const updated = await getTask(task.id);
  if (updated) broadcast({ type: 'task_updated', payload: updated });
}

/** Apply a testing verdict. The executor, never the testing agent, owns transitions. */
export async function handleTestingDecision(
  decision: TestingDecision,
  ctx: TestingContext,
): Promise<void> {
  const { task, stages, targetStatus, agent_name } = ctx;
  const timestamp = new Date().toISOString();
  // The task object was captured when the run started. Re-read custom values so
  // a user prompt submitted during the run can reset the failure sequence.
  const latestTask = await getTask(task.id);
  const currentCustomValues =
    latestTask?.custom_values ?? task.custom_values ?? {};
  const currentFailureCount =
    typeof currentCustomValues[TESTING_FAILURE_COUNT_KEY] === 'number'
      ? currentCustomValues[TESTING_FAILURE_COUNT_KEY]
      : 0;

  // Recovery can replay a run whose verdict was applied just before a crash.
  if (testingRunAlreadyApplied(currentCustomValues, ctx.runId)) return;

  // Run history shows this verdict, not the process outcome. A chain-pass
  // problem below re-enters with a blocked decision that overwrites this.
  if (ctx.runId) {
    await updateActiveRunTestingDecision(ctx.runId, decision.decision);
  }

  // A task with extra testers (`co_stages`) is tested by each of them on the
  // same content. A stored chain means this verdict belongs to its next extra
  // tester; otherwise it is the stage's own (primary) tester.
  const storedChain = readTestingChain(currentCustomValues);
  const extraStages =
    storedChain?.stages ??
    resolveCoTestingStages(ctx.group, latestTask ?? task, targetStatus);
  const chainStageId = storedChain
    ? nextTestingChainStage(storedChain)
    : targetStatus;
  if (extraStages.length > 0 && decision.decision === 'pass') {
    const chainProblem = testingChainPassProblem(storedChain, ctx);
    if (chainProblem) {
      // Never a pass: the content the testers agreed on cannot be established.
      return handleTestingDecision(chainProblem, ctx);
    }
  }
  const lastRunId =
    extraStages.length > 0
      ? (await getLastActiveRunForTask(task.id))?.id
      : undefined;
  const verdicts: TestingChainVerdict[] =
    extraStages.length > 0
      ? [
          ...(storedChain?.verdicts ?? []),
          {
            stage_id: chainStageId,
            tester: ctx.model_name || agent_name || chainStageId,
            decision: decision.decision,
            summary: decision.summary,
            run_ids: [
              ...new Set([ctx.runId, lastRunId].filter((id) => !!id)),
            ] as string[],
          },
        ]
      : [];
  const continuesChain =
    decision.decision === 'pass' &&
    extraStages.length > 0 &&
    verdicts.length <= extraStages.length;
  // A passing tester that leaves more testers to run neither resets nor
  // advances the failure sequence: only the whole chain passing does.
  const testingFailureCount =
    decision.decision === 'fail'
      ? currentFailureCount + 1
      : continuesChain
        ? currentFailureCount
        : 0;
  const failureLimitReached =
    decision.decision === 'fail' &&
    testingFailureCount >= MAX_CONSECUTIVE_TESTING_FAILURES;

  if (!ctx.assistantResponsePersisted) {
    persistTestingAssistantResponse({ ...ctx, decision });
  }

  const summary = appendTaskMessage(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type:
      decision.decision === 'pass' ? 'system_notice' : 'testing_feedback',
    content: failureLimitReached
      ? `${verdictMessage(decision)}\n\n**Automatic retry limit reached** — testing failed ${testingFailureCount} consecutive times. The task has been parked for user input.`
      : continuesChain
        ? `${verdictMessage(decision)}\n\nNext tester: \`${extraStages[verdicts.length - 1]}\`. The task advances after the last tester passes.`
        : verdictMessage(decision),
    created_at: new Date().toISOString(),
  });
  if (summary)
    broadcast({
      type: 'task_message',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        message: summary,
      },
    });

  if (continuesChain) {
    await continueTestingChain(ctx, {
      customValues: currentCustomValues,
      chain: {
        head: ctx.testingHeadSha ?? '',
        tree: ctx.testingTreeSha ?? '',
        started_at:
          storedChain?.started_at ??
          latestTask?.started_at ??
          new Date().toISOString(),
        after_run_id: lastRunId ?? '',
        stages: extraStages,
        verdicts,
      },
    });
    return;
  }

  let nextStage: StageDefinition | undefined;
  if (decision.decision === 'pass') {
    nextStage =
      getNextActiveStage(stages, targetStatus, task.skip_stages ?? undefined) ??
      getDoneStage(stages);
  } else if (decision.decision === 'fail') {
    nextStage = failureLimitReached
      ? getTestingBlockedStage(stages)
      : getFirstExecutableStage(stages);
  } else {
    nextStage = getTestingBlockedStage(stages);
  }
  nextStage ??= findStage(stages, targetStatus);
  const nextCustomValues: Record<string, string | number> = {
    ...currentCustomValues,
    [TESTING_FAILURE_COUNT_KEY]: testingFailureCount,
  };
  if (decision.decision === 'fail') {
    const currentTotal = currentCustomValues[TESTING_FAILURE_TOTAL_KEY];
    nextCustomValues[TESTING_FAILURE_TOTAL_KEY] =
      (typeof currentTotal === 'number' ? currentTotal : 0) + 1;
  }
  if (
    decision.decision === 'pass' &&
    ctx.testingHeadSha &&
    ctx.testingTreeSha
  ) {
    nextCustomValues[TESTING_HEAD_SHA_KEY] = ctx.testingHeadSha;
    nextCustomValues[TESTING_TREE_SHA_KEY] = ctx.testingTreeSha;
  } else {
    delete nextCustomValues[TESTING_HEAD_SHA_KEY];
    delete nextCustomValues[TESTING_TREE_SHA_KEY];
  }
  for (const key of TESTING_INSPECTED_KEYS) delete nextCustomValues[key];
  // The round is decided: record who tested and drop the finished chain. Blank
  // values (not deletes) also override stored copies merged later.
  if (verdicts.length > 0) {
    nextCustomValues[TESTING_VERDICTS_KEY] = JSON.stringify(verdicts);
  } else if (TESTING_VERDICTS_KEY in nextCustomValues) {
    nextCustomValues[TESTING_VERDICTS_KEY] = '';
  }
  if (TESTING_CHAIN_KEY in nextCustomValues)
    nextCustomValues[TESTING_CHAIN_KEY] = '';

  if (ctx.beforeTransition && !(await ctx.beforeTransition())) return;
  const reachedDone = nextStage?.type === 'done';
  const hasDeployService = !!ctx.group.settings?.deployService;
  // Deploy owns the completion bookkeeping when Testing lands on the deploy stage.
  const reachedDeploy =
    reachedDone &&
    hasDeployService &&
    nextStage?.id === getDeployStageId(ctx.group.settings, stages);
  const mergeSource = hasDeployService ? 'deploy' : 'completion';
  if (reachedDone) {
    const checkpointTask = (await getTask(task.id)) ?? task;
    let checkpointReady = false;
    let mergeAllowed = true;
    if (ctx.runTransition) {
      mergeAllowed = await ctx.runTransition(async () => {
        checkpointReady = await mergeBranchForDeploy(
          checkpointTask,
          ctx.group,
          mergeSource,
          undefined,
          {
            leaseAlreadyHeld: ctx.leaseAlreadyHeld,
            deferToOtherOwner: ctx.deferToOtherCheckoutOwner,
          },
        );
      });
    } else {
      checkpointReady = await mergeBranchForDeploy(
        checkpointTask,
        ctx.group,
        mergeSource,
        undefined,
        {
          leaseAlreadyHeld: ctx.leaseAlreadyHeld,
          deferToOtherOwner: ctx.deferToOtherCheckoutOwner,
        },
      );
    }
    if (!mergeAllowed || !checkpointReady) return;
  }
  if (ctx.beforeTransition && !(await ctx.beforeTransition())) return;
  let transitionCustomValues = nextCustomValues;
  if (reachedDone) {
    const latestAfterMerge = await getTask(task.id);
    const latestValues = { ...latestAfterMerge?.custom_values };
    // Preserve Testing's intentional deletions when overlaying its values.
    for (const key of [
      ...TESTING_INSPECTED_KEYS,
      TESTING_HEAD_SHA_KEY,
      TESTING_TREE_SHA_KEY,
    ]) {
      if (!(key in nextCustomValues)) delete latestValues[key];
    }
    const testingValues = { ...nextCustomValues };
    for (const key of MERGE_OWNED_VALUE_KEYS) delete testingValues[key];
    transitionCustomValues = { ...latestValues, ...testingValues };
  }
  const transitionStatus = nextStage?.id ?? targetStatus;
  const transitionChanges = {
    status: transitionStatus,
    error: '',
    completed_at: reachedDone ? timestamp : null,
    custom_values: {
      ...transitionCustomValues,
      // A live run leaves the dispatch receipt with the transition; recovery
      // writes its own through `transitionValues`.
      ...(reachedDeploy && !ctx.deferDeploy
        ? { [DEPLOY_PENDING_DISPATCH_KEY]: timestamp }
        : {}),
      ...ctx.transitionValues?.(transitionStatus),
    },
    ...(decision.decision === 'pass'
      ? { session_id: ctx.newSessionId, last_agent_name: agent_name }
      : {
          session_id: task.session_id || '',
          last_agent_name: task.last_agent_name || '',
        }),
  };
  if (ctx.beforeTransition) {
    if (!(await ctx.beforeTransition(transitionChanges))) return;
  } else {
    const stageEntryEvent = await updateTask(
      task.id,
      transitionChanges,
      ctx.recoveryRunId ? { recoveryRunId: ctx.recoveryRunId } : undefined,
    );
    if (ctx.stageEntryEventRef) {
      ctx.stageEntryEventRef.id = stageEntryEvent?.id;
    }
  }
  const updated = await getTask(task.id);
  if (updated) broadcast({ type: 'task_updated', payload: updated });
  const needsInput = decision.decision === 'blocked' || failureLimitReached;
  if (updated && needsInput) {
    const notification = {
      group_folder: updated.project_id,
      task_id: updated.id,
      run_id: ctx.runId ?? updated.id,
      event: 'needs_input' as const,
      title: `Task needs input: ${updated.title}`,
      defer_stage_entry: true,
      stage_entry_event_id: ctx.stageEntryEventRef?.id,
    };
    // Only an event actually published to an objective can be held. Without a
    // Question stage the blocked card parks in the fallback stage instead.
    if (
      isQuestionStage(stages, updated.status) ||
      (!getQuestionStage(stages) &&
        task.status !== updated.status &&
        getTestingBlockedStage(stages)?.id === updated.status)
    ) {
      const reason = failureLimitReached
        ? `Testing failed ${testingFailureCount} consecutive times and requires user input.`
        : decision.issues.join('; ');
      await publishTaskEventAndNotify(
        updated,
        ctx.group,
        { type: 'task_question', source: 'testing_blocked', reason },
        notification,
      );
    } else {
      await notifyEntityLifecycle(notification);
    }
  }
  if (reachedDeploy) {
    if (ctx.deferDeploy) return;
    const runDeploy = async () => {
      await triggerDeploy(updated ?? task, ctx.group, {
        skipMerge: true,
        lifecycleRunId: ctx.runId ?? task.id,
        stageEntryEventId: ctx.stageEntryEventRef?.id,
      });
    };
    if (ctx.runTransition) await ctx.runTransition(runDeploy);
    else await runDeploy();
    return;
  }
  if (reachedDone) {
    const completedTask = updated ?? task;
    broadcast({
      type: 'task_completed',
      payload: { task_id: task.id, project_id: task.project_id },
    });
    publishEvent(
      resolveBrainUrl(resolveBrainContainer(ctx.group)),
      {
        type: 'task_completed',
        project_id: task.project_id,
        task_id: task.id,
        objective_id: task.objective_id ?? null,
        timestamp,
        data: {
          ...taskEventHeaders(completedTask, ctx.group),
          status: nextStage?.id,
          testing: true,
        },
      },
      ctx.group,
    );
    await notifyEntityLifecycle({
      group_folder: task.project_id,
      task_id: task.id,
      run_id: ctx.runId ?? task.id,
      event: 'completed',
      title: `Task completed: ${task.title}`,
      defer_stage_entry: true,
      stage_entry_event_id: ctx.stageEntryEventRef?.id,
    });
  }
}

export async function handleTestingBlocked(
  reason: string,
  ctx: TestingContext,
): Promise<void> {
  await handleTestingDecision(
    {
      decision: 'blocked',
      issues: [reason],
      summary: 'Testing could not reach a verdict.',
    },
    ctx,
  );
}
