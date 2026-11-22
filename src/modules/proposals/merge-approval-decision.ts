/**
 * Decide a merge approval. Approving binds to the exact reviewed commit: the
 * task branch head is re-read first and a moved branch makes the approval stale
 * (and requests a fresh one). An approved review-parked card is merged through
 * the same path as the parked-merge retry sweep. Deny only records the
 * decision; the card stays parked.
 */
import { getTask } from '../../db.js';
import { logger } from '../../logger.js';
import { getGroupByFolder } from '../../state-manager.js';
import { runGitInRepo, validatedInstance } from '../../lib/git-ops.js';
import { shellQuote } from '../../utils.js';
import type { RegisteredGroup } from '../../types.js';
import type { Task } from '../kanban/types.js';
import {
  approvalRequiredNotice,
  classifyMergeRisk,
} from '../kanban/task/merge-risk-gate.js';
import type {
  MergeRetryDependencies,
  ParkedMergeOutcome,
} from '../kanban/task/merge-retry.js';
import { parseAction } from './actions.js';
import { updateProposalResult, type ProposalRow } from './db-proposals.js';
import { formatMergeFindings, MAX_STORED_FINDINGS } from './merge-approval.js';
import { serialize } from '../../lib/serial-queue.js';

const STALE_APPROVAL_RESULT =
  'The branch changed after this was requested. A new approval was requested.';

type FinalStatus = 'applied' | 'denied' | 'failed' | 'stale';

export interface MergeDecisionDependencies {
  getTask: (id: string) => Promise<Task | undefined>;
  getGroup: (folder: string) => RegisteredGroup | undefined;
  /** Current head sha of the task branch, or null when it cannot be read. */
  readBranchHead: (
    task: Task,
    group: RegisteredGroup,
  ) => Promise<string | null>;
  classifyMergeRisk: typeof classifyMergeRisk;
  /** The parked-merge retry sweep's collaborators and merge attempt. */
  retry: () => Promise<{
    deps: MergeRetryDependencies;
    attemptParkedMerge: (
      task: Task,
      group: RegisteredGroup,
      runs: Awaited<ReturnType<MergeRetryDependencies['getRuns']>>,
      deps: MergeRetryDependencies,
      options?: { afterHumanApproval?: boolean },
    ) => Promise<ParkedMergeOutcome>;
  }>;
}

async function readBranchHead(
  task: Task,
  group: RegisteredGroup,
): Promise<string | null> {
  if (!task.branch_name) return null;
  const head = await runGitInRepo(
    group,
    `rev-parse --verify ${shellQuote(`refs/heads/${task.branch_name}`)}`,
    validatedInstance(task, group),
  );
  const sha = head.output.trim();
  return head.ok && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
}

const defaultDependencies: MergeDecisionDependencies = {
  getTask,
  getGroup: getGroupByFolder,
  readBranchHead,
  classifyMergeRisk,
  // Loaded on demand: the retry module pulls in the whole task lifecycle,
  // which in turn reaches the tool registry that imports the proposals service.
  retry: async () => {
    const retry = await import('../kanban/task/merge-retry.js');
    return {
      deps: retry.defaultMergeRetryDependencies,
      attemptParkedMerge: retry.attemptParkedMerge,
    };
  },
};

/**
 * Record the decision of a claimed (`applying`) merge approval. `record`
 * finishes the row and posts the decision note; it runs before any merge so
 * the gate sees the applied approval.
 */
export function decideMergeProposal(
  claimed: ProposalRow,
  decision: 'approve' | 'deny',
  record: (status: FinalStatus, result: string) => Promise<ProposalRow>,
  postNote: (row: ProposalRow) => Promise<void>,
  deps: MergeDecisionDependencies = defaultDependencies,
): Promise<ProposalRow> {
  // One decision per task at a time, including the merge it triggers.
  return serialize(`merge-decision:${claimed.name}`, async () => {
    let recorded: ProposalRow | undefined;
    try {
      return await decide(
        claimed,
        decision,
        async (status, result) => {
          recorded = await record(status, result);
          return recorded;
        },
        deps,
      );
    } catch (err) {
      logger.warn(
        { err, proposalId: claimed.id },
        'Merge approval decision failed',
      );
      const message = err instanceof Error ? err.message : String(err);
      if (!recorded) return record('failed', message);
      const result = `Decision recorded, but a subsequent step failed: ${message}`;
      const updated = await updateProposalResult(claimed.id, result);
      const failed = updated ?? { ...recorded, result };
      await postNote(failed);
      return failed;
    }
  });
}

async function decide(
  claimed: ProposalRow,
  decision: 'approve' | 'deny',
  record: (status: FinalStatus, result: string) => Promise<ProposalRow>,
  deps: MergeDecisionDependencies,
): Promise<ProposalRow> {
  const decidedBy = claimed.decided_by ?? 'user';
  const task = await deps.getTask(claimed.name);
  const { deps: retryDeps, attemptParkedMerge } = await deps.retry();

  if (!task || task.archived) return record('failed', 'Task no longer exists');
  if (decision === 'deny') {
    const row = await record('denied', 'Denied. The card stays parked.');
    retryDeps.appendNotice(
      task,
      `**Merge denied by ${decidedBy}** — the branch at \`${claimed.base_hash}\` was not merged and the card stays parked.`,
    );
    return row;
  }

  if (task.merge_commit) return record('applied', 'Already merged.');
  const group = deps.getGroup(task.project_id);
  if (!group) return record('failed', 'Project no longer exists');

  const action = parseAction(claimed.approve_action);
  const resume = action.type === 'merge_task' && action.resume === true;

  const head = await deps.readBranchHead(task, group);
  if (head === null) {
    return record(
      'failed',
      'The task branch could not be read, so the approval was not applied.',
    );
  }
  if (head !== claimed.base_hash) {
    const risk = await deps.classifyMergeRisk(task, group);
    if (!risk.gated) {
      return record(
        'stale',
        'The branch changed after this was requested and no longer needs approval.',
      );
    }
    if (!risk.headSha) {
      return record(
        'failed',
        'The branch changed and its new head could not be checked, so no new approval was requested.',
      );
    }
    const row = await record('stale', STALE_APPROVAL_RESULT);
    retryDeps.appendNotice(
      task,
      await approvalRequiredNotice(
        task,
        group,
        {
          mergeOk: false,
          failureKind: 'approval_required',
          output: `${STALE_APPROVAL_RESULT}\n\n${formatMergeFindings(
            risk.headSha,
            risk.findings.slice(0, MAX_STORED_FINDINGS),
            Math.max(0, risk.findings.length - MAX_STORED_FINDINGS),
          )}`,
          approval: { headSha: risk.headSha, findings: risk.findings },
        },
        { resume },
      ),
    );
    return row;
  }

  const approvedNote = `**Merge approved by ${decidedBy}** — commit \`${claimed.base_hash}\`.`;
  if (!resume) {
    const row = await record(
      'applied',
      'Approved. Move the card again to merge it.',
    );
    retryDeps.appendNotice(
      task,
      `${approvedNote} Move the card to the stage you want again; the merge now passes the gate.`,
    );
    return row;
  }
  if (!(await retryDeps.stillParked(task, group))) {
    const row = await record(
      'applied',
      'Approved. The card is no longer parked, so the merge was not resumed; move it again to merge.',
    );
    retryDeps.appendNotice(task, approvedNote);
    return row;
  }

  // The gate reads this applied row, so it is recorded before merging.
  const row = await record('applied', 'Approved. Resuming the merge.');
  retryDeps.appendNotice(task, approvedNote);
  const runs = await retryDeps.getRuns(task.id);
  const outcome = await attemptParkedMerge(task, group, runs, retryDeps, {
    afterHumanApproval: true,
  });
  const summary: Record<ParkedMergeOutcome, string> = {
    merged: 'Approved and merged.',
    transition_refused:
      'Approved and merged, but the card could not be moved on; check the board.',
    approval_required: 'Approved, but the merge still needs approval.',
    conflict:
      'Approved, but merging conflicts; move the card to review to resolve it.',
    environment:
      'Approved, but the merge failed; the card stays parked. See its notice.',
    error: 'Approved, but the merge failed; see the card for details.',
  };
  const updated = await updateProposalResult(
    claimed.id,
    summary[outcome],
  ).catch(() => null);
  return updated ?? row;
}
