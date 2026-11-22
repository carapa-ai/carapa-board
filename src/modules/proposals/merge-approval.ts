/**
 * Merge approvals: a `merge` proposal asks a person to approve merging one task
 * branch at one exact head commit after the merge risk gate held it. Only the
 * Board creates them (never `propose_changes`); the decision lives in
 * merge-approval-decision.ts.
 */
import type { Task } from '../kanban/types.js';
import { parseAction, type MergeFinding } from './actions.js';
import { announceProposals, newProposalId, proposalFence } from './announce.js';
import {
  findOpenMergeApproval,
  setPendingApproveAction,
} from './db-proposals.js';
import { serialize } from '../../lib/serial-queue.js';

export const MAX_STORED_FINDINGS = 30;
const MAX_RULE_ID_CHARS = 200;
const MAX_TEXT_CHARS = 1000;

export type MergeApprovalTask = Pick<Task, 'id' | 'title' | 'project_id'>;

export interface MergeApprovalRequest {
  proposalId: string;
  conversationId: string;
  objectiveId: string | null;
  /** False when an existing approval for this exact head was reused. */
  created: boolean;
}

/** Findings as markdown: rule id, file and reason, plus the head commit. */
export function formatMergeFindings(
  headSha: string,
  findings: MergeFinding[],
  omitted = 0,
): string {
  const listed = findings.map(
    (finding) =>
      `- \`${finding.ruleId}\` — \`${finding.file}\`: ${finding.reason}`,
  );
  if (omitted > 0) listed.push(`- … (+${omitted} more)`);
  return [
    `Task head commit: ${headSha ? `\`${headSha}\`` : '(unknown)'}`,
    '',
    ...listed,
  ].join('\n');
}

/**
 * Where the person decides: the approval's project conversation. Always the
 * task's project chat, whatever objective the task carries (the objective may
 * belong to another project).
 */
export function mergeApprovalLink(
  projectId: string,
  conversationId: string,
): string {
  return `/chat/${encodeURIComponent(projectId)}?conversationId=${encodeURIComponent(conversationId)}`;
}

/**
 * Ask for approval to merge `task` at `headSha`. Idempotent per (task, head):
 * a pending, in-flight or applied approval for that pair is reused, never
 * duplicated.
 */
export function requestMergeApproval(
  task: MergeApprovalTask,
  headSha: string,
  findings: MergeFinding[],
  options: { resume: boolean },
): Promise<MergeApprovalRequest> {
  return serialize(`merge-request:${task.id}:${headSha}`, async () => {
    const existing = await findOpenMergeApproval(task.id, headSha);
    if (existing) {
      const action = parseAction(existing.approve_action);
      // A review park for a head first parked from completion: the one open
      // approval must also resume the merge.
      if (
        existing.status === 'pending' &&
        action.type === 'merge_task' &&
        options.resume &&
        !action.resume
      ) {
        await setPendingApproveAction(existing.id, {
          ...action,
          resume: true,
        });
      }
      return {
        proposalId: existing.id,
        conversationId: existing.conversation_id,
        objectiveId: existing.objective_id,
        created: false,
      };
    }

    const stored = findings.slice(0, MAX_STORED_FINDINGS).map((finding) => ({
      ruleId: finding.ruleId.slice(0, MAX_RULE_ID_CHARS),
      file: finding.file.slice(0, MAX_TEXT_CHARS),
      reason: finding.reason.slice(0, MAX_TEXT_CHARS),
    }));
    const omitted = findings.length - stored.length;
    const id = newProposalId();
    const title = `Merge approval: ${task.title}`.slice(0, 120);
    const row = {
      id,
      project_id: task.project_id,
      objective_id: null,
      conversation_id: '',
      created_by_run: null,
      title,
      rationale: formatMergeFindings(headSha, stored, omitted),
      kind: 'merge' as const,
      name: task.id,
      target_layer: 'project' as const,
      approve_action: {
        type: 'merge_task' as const,
        resume: options.resume,
        findings: stored,
        ...(omitted > 0 ? { omitted } : {}),
      },
      deny_action: { type: 'none' as const },
      base_hash: headSha,
      status: 'pending' as const,
      created_at: new Date().toISOString(),
    };
    const { conversation_id } = await announceProposals({
      project_id: task.project_id,
      objective_id: null,
      title,
      triggerSource: 'system',
      rows: [row],
      content:
        `**${title}**\n\n` +
        `This task changes files covered by the project's merge risk rules, so it was not merged. ` +
        `Nothing merges until you approve this exact commit.\n\n${proposalFence(id)}`,
    });
    return {
      proposalId: id,
      conversationId: conversation_id,
      objectiveId: null,
      created: true,
    };
  });
}
