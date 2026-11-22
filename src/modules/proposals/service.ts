/**
 * Proposal lifecycle: an agent creates a conversation of proposals, a user
 * approves or denies each one, and the stored typed action is executed.
 */
import { z } from 'zod';
import type { TriggerSource } from '../kanban/types.js';
import { logger } from '../../logger.js';
import { getGroupByFolder, registeredGroups } from '../../state-manager.js';
import { getActiveRunById, getConversation, getTask } from '../../db.js';
import { broadcast } from '../objectives/ws-events.js';
import { getObjective } from '../objectives/db-objectives.js';
import { saveChatMessage } from '../chat/db-chats.js';
import { chatEventScope } from '../chat/conversation-scope.js';
import {
  AGENT_PROPOSAL_KINDS,
  assertLayerSupported,
  assertValidName,
  isLayerSupported,
  isItemKind,
  type ItemProposalKind,
  type MergeFinding,
  parseAction,
  type ProposalKind,
  ProposalValidationError,
  proposalActionSchema,
  PROMPT_PROPOSAL_KIND,
  TARGET_LAYERS,
  UnsupportedLayerError,
  validateAction,
  type ProposalAction,
} from './actions.js';
import {
  claimProposal,
  countOpenProposals,
  finishProposal,
  listApplyingProposals,
  updateProposalResult,
  type NewProposalRow,
  type ProposalRow,
} from './db-proposals.js';
import { announceProposals, newProposalId, proposalFence } from './announce.js';
import {
  decideMergeProposal,
  type MergeDecisionDependencies,
} from './merge-approval-decision.js';
import {
  applyPromptProposal,
  previewPrompt,
  promptLockKey,
  promptPresentation,
  promptProposalBase,
  type PromptPresentation,
} from './prompt-proposals.js';
import { serialize } from '../../lib/serial-queue.js';
import {
  executeAction,
  refreshAgentView,
  type ExecutionOutcome,
} from './executor.js';
import {
  applyPromotionProposal,
  assertPromotionActions,
  previewPromotion,
  parseBaseFiles,
  promotionBase,
} from './promotion.js';
import {
  isPromotionLayer,
  promotionTarget,
  type PromotionBaseFile,
} from './promotion-targets.js';
import {
  hashSnapshot,
  previewAction,
  readSnapshot,
  resolveTarget,
  unverifiableReason,
  type ActionPreview,
} from './targets.js';

export const proposalInputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Short label for this proposal; defaults to the overall title'),
  rationale: z
    .string()
    .min(1)
    .max(1500)
    .describe('Why the user should approve this change, in a few sentences'),
  kind: z.enum(AGENT_PROPOSAL_KINDS),
  name: z.string().describe('Item name: lowercase letters, digits and dashes'),
  target_layer: z
    .enum(TARGET_LAYERS)
    .describe(
      '"platform", "group_template" and "objective_template" are committed to their source repository on approval',
    ),
  approve_action: proposalActionSchema.describe(
    'Runs when the user approves. write_item replaces the whole skill folder or rule file.',
  ),
  deny_action: proposalActionSchema
    .optional()
    .describe('Optional follow-up when the user denies, e.g. mark_local'),
});
type ProposalInput = z.infer<typeof proposalInputSchema>;

export const MAX_PROPOSALS_PER_CALL = 10;

export interface CreateProposalsInput {
  project_id: string;
  objective_id?: string | null;
  title: string;
  proposals: ProposalInput[];
  created_by_run?: string | null;
  /** The caller's MCP permissions; a prompt proposal needs `project_setup:read` on its target. */
  permissions?: Record<string, string[]>;
  /** The calling agent run; decides whether the cards go to the current chat. */
  run?: {
    conversation_id?: string;
    task_id?: string;
    run_id?: string;
    trigger_source?: TriggerSource;
  };
}

/**
 * The conversation to post into when the call comes from a chat turn the user
 * started in this project (and objective, when given); null otherwise.
 *
 * The turn is read from the server-owned trigger source of the run: passed
 * directly by DirectLLM runs (no `active_runs` row), else read from the run's
 * record. The conversation's `lastTriggerSource` is only written when a user
 * message arrives, so it stays `user` through later agent- or system-started
 * turns.
 */
async function interactiveConversation(
  input: CreateProposalsInput,
): Promise<{ id: string; objective_id: string | null } | null> {
  const { conversation_id, task_id, run_id, trigger_source } = input.run ?? {};
  if (!conversation_id || task_id) return null;
  if (trigger_source) {
    if (trigger_source !== 'user') return null;
  } else {
    if (!run_id) return null;
    const run = await getActiveRunById(run_id);
    if (
      !run ||
      run.status !== 'running' ||
      run.triggerSource !== 'user' ||
      run.task_id ||
      run.isScheduledTask ||
      run.group_folder !== input.project_id ||
      run.conversation_id !== conversation_id
    ) {
      return null;
    }
  }
  const conversation = await getConversation(conversation_id);
  if (!conversation || conversation.group_folder !== input.project_id) {
    return null;
  }
  const conversationObjective = conversation.objective_id ?? null;
  if (input.objective_id && input.objective_id !== conversationObjective) {
    return null;
  }
  return { id: conversation.id, objective_id: conversationObjective };
}

function conversationText(title: string, rows: NewProposalRow[]): string {
  const sections = rows.map(
    (row, index) =>
      `### ${index + 1}. ${row.title}\n\n` +
      `\`${row.kind}\` \`${row.name}\` · ${row.target_layer.replace(/_/g, ' ')} layer\n\n` +
      `${row.rationale}\n\n` +
      proposalFence(row.id),
  );
  return `**${title}**\n\nReview each proposal below. Nothing changes until you approve it.\n\n${sections.join('\n\n')}`;
}

/**
 * Validate, store and announce proposals in the user's current chat when the
 * call comes from their turn, otherwise in a new pending conversation.
 */
export async function createProposals(
  input: CreateProposalsInput,
): Promise<{ conversation_id: string; proposal_ids: string[] }> {
  if (!getGroupByFolder(input.project_id)) {
    throw new ProposalValidationError(
      `Project "${input.project_id}" not found`,
    );
  }
  if (input.proposals.length === 0) {
    throw new ProposalValidationError('At least one proposal is required');
  }
  if (input.proposals.length > MAX_PROPOSALS_PER_CALL) {
    throw new ProposalValidationError(
      `At most ${MAX_PROPOSALS_PER_CALL} proposals per call`,
    );
  }
  if (input.objective_id) {
    const objective = await getObjective(input.objective_id);
    if (!objective || objective.project_id !== input.project_id) {
      throw new ProposalValidationError(
        `Objective "${input.objective_id}" does not belong to project "${input.project_id}"`,
      );
    }
  }
  const current = await interactiveConversation(input);
  const objectiveId = input.objective_id || current?.objective_id || null;

  const createdAt = new Date().toISOString();
  const rows: NewProposalRow[] = [];
  for (const [index, proposal] of input.proposals.entries()) {
    const label = `Proposal ${index + 1}`;
    try {
      // Merge approvals are created only by the Board, never on an agent's say.
      if (
        !(AGENT_PROPOSAL_KINDS as readonly string[]).includes(proposal.kind)
      ) {
        throw new ProposalValidationError(
          `Kind "${proposal.kind}" cannot be proposed; use ${AGENT_PROPOSAL_KINDS.join(' or ')}`,
        );
      }
      // A prompt name (`stage-<id>`) is checked against its action instead.
      if (proposal.kind !== PROMPT_PROPOSAL_KIND) {
        assertValidName(proposal.name);
      }
      assertLayerSupported(proposal.target_layer);
      const approve = parseAction(proposal.approve_action);
      const deny = proposal.deny_action
        ? parseAction(proposal.deny_action)
        : null;
      validateAction(approve, proposal);
      if (deny) validateAction(deny, proposal);
      const id = newProposalId();
      let baseHash: string;
      let baseFiles: PromotionBaseFile[] | null = null;
      if (proposal.kind === PROMPT_PROPOSAL_KIND) {
        const base = await promptProposalBase(
          proposal,
          approve,
          deny,
          input.permissions,
          registeredGroups,
        );
        baseHash = base.hash;
        baseFiles = base.files;
      } else if (isPromotionLayer(proposal.target_layer)) {
        assertPromotionActions(approve, deny);
        const base = await promotionBase(
          {
            id,
            title: proposal.title ?? input.title,
            target_layer: proposal.target_layer,
            kind: proposal.kind,
            name: proposal.name,
          },
          approve,
        );
        baseHash = base.hash;
        baseFiles = base.files;
      } else {
        const target = resolveTarget({
          project_id: input.project_id,
          objective_id: objectiveId,
          kind: proposal.kind,
          name: proposal.name,
          target_layer: proposal.target_layer,
        });
        const snapshot = await readSnapshot(target);
        // Refuse early what could never be applied, so the user is not asked.
        const unverifiable =
          unverifiableReason(approve, snapshot) ??
          (deny ? unverifiableReason(deny, snapshot) : null);
        if (unverifiable) throw new ProposalValidationError(unverifiable);
        baseHash = hashSnapshot(snapshot);
      }
      rows.push({
        id,
        project_id: input.project_id,
        objective_id: objectiveId,
        conversation_id: '',
        created_by_run: input.created_by_run ?? null,
        title: proposal.title ?? input.title,
        rationale: proposal.rationale,
        kind: proposal.kind,
        name: proposal.name,
        target_layer: proposal.target_layer,
        approve_action: approve,
        deny_action: deny,
        base_hash: baseHash,
        base_files: baseFiles,
        status: 'pending',
        created_at: createdAt,
      });
    } catch (err) {
      if (err instanceof ProposalValidationError) {
        throw new ProposalValidationError(`${label}: ${err.message}`);
      }
      throw err;
    }
  }

  const { conversation_id } = await announceProposals({
    project_id: input.project_id,
    objective_id: objectiveId,
    title: input.title,
    triggerSource: 'agent',
    rows,
    content: conversationText(input.title, rows),
    conversation_id: current?.id,
  });
  return {
    conversation_id,
    proposal_ids: rows.map((row) => row.id as string),
  };
}

/** A skill or rule proposal: the rows the item machinery can resolve and run. */
type ItemProposalRow = ProposalRow & { kind: ItemProposalKind };

function isItemProposal(row: ProposalRow): row is ItemProposalRow {
  return isItemKind(row.kind);
}

function isPromptProposal(row: ProposalRow): boolean {
  return row.kind === PROMPT_PROPOSAL_KIND;
}

/** What a merge approval card shows beyond the shared fields. */
interface MergePresentation {
  taskId: string;
  /** Null once the task no longer exists. */
  taskTitle: string | null;
  headSha: string;
  findings: MergeFinding[];
  /** Findings beyond those listed. */
  omitted: number;
}

export interface ProposalPresentation {
  id: string;
  projectId: string;
  objectiveId: string | null;
  conversationId: string;
  title: string;
  rationale: string;
  kind: ProposalKind;
  name: string;
  targetLayer: string;
  status: ProposalRow['status'];
  decidedBy: string | null;
  decidedAt: string | null;
  result: string | null;
  createdAt: string;
  /** What Approve will do. */
  approve: ActionPreview;
  /** What Deny will do; null when Deny only closes the proposal. */
  deny: ActionPreview | null;
  /** The target changed after the proposal was written, so it can no longer run. */
  targetChanged: boolean;
  /** The proposal's layer cannot be executed yet. */
  supported: boolean;
  /** Set for kind `merge`. */
  merge?: MergePresentation;
  /** Set for kind `prompt`. */
  prompt?: PromptPresentation;
}

function unavailablePreview(
  action: ProposalAction,
  problem: string | null,
): ActionPreview {
  return {
    actionType: action.type,
    targetPath: '',
    exists: false,
    replacesSymlink: false,
    symlinkTarget: null,
    contentHidden: false,
    files: [],
    problem,
  };
}

/** The authoritative, UI-facing view of a stored proposal. */
export async function presentProposal(
  row: ProposalRow,
): Promise<ProposalPresentation> {
  const approve = parseAction(row.approve_action);
  const parsedDeny = row.deny_action ? parseAction(row.deny_action) : null;
  // A missing or `none` deny action only closes the proposal: no preview.
  const deny = parsedDeny && parsedDeny.type !== 'none' ? parsedDeny : null;
  const supported = isLayerSupported(row.target_layer);
  let approvePreview: ActionPreview;
  let denyPreview: ActionPreview | null = null;
  let targetChanged = false;
  let merge: MergePresentation | undefined;
  const prompt = promptPresentation(approve);
  try {
    if (approve.type === 'set_prompt' && isPromptProposal(row)) {
      const shown = await previewPrompt(
        approve,
        row.base_hash,
        row.status === 'pending',
        registeredGroups,
      );
      approvePreview = shown.preview;
      targetChanged = shown.targetChanged;
    } else if (!isItemProposal(row)) {
      const task = await getTask(row.name);
      const listing = approve.type === 'merge_task' ? approve : undefined;
      merge = {
        taskId: row.name,
        taskTitle: task?.title ?? null,
        headSha: row.base_hash,
        findings: listing?.findings ?? [],
        omitted: listing?.omitted ?? 0,
      };
      approvePreview = unavailablePreview(approve, null);
    } else if (!supported) {
      throw new UnsupportedLayerError(row.target_layer);
    } else if (isPromotionLayer(row.target_layer)) {
      // The repository is not readable from Board: the preview diffs against
      // the content stored at proposal time, and staleness is checked by the
      // promotion script when the user approves.
      approvePreview = previewPromotion(
        approve,
        row,
        parseBaseFiles(row.base_files),
      );
      denyPreview = null;
    } else {
      const target = resolveTarget(row);
      const snapshot = await readSnapshot(target);
      targetChanged =
        row.status === 'pending' && hashSnapshot(snapshot) !== row.base_hash;
      approvePreview = previewAction(approve, target, snapshot);
      denyPreview = deny ? previewAction(deny, target, snapshot) : null;
    }
  } catch (err) {
    const problem = err instanceof Error ? err.message : String(err);
    approvePreview = unavailablePreview(approve, problem);
    denyPreview = deny ? unavailablePreview(deny, problem) : null;
  }
  return {
    id: row.id,
    projectId: row.project_id,
    objectiveId: row.objective_id,
    conversationId: row.conversation_id,
    title: row.title,
    rationale: row.rationale,
    kind: row.kind,
    name: row.name,
    targetLayer: row.target_layer,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    result: row.result,
    createdAt: row.created_at,
    approve: approvePreview,
    deny: denyPreview,
    targetChanged,
    supported,
    ...(merge ? { merge } : {}),
    ...(prompt && isPromptProposal(row) ? { prompt } : {}),
  };
}

export class ProposalAlreadyDecidedError extends Error {
  constructor(public readonly status: ProposalRow['status']) {
    super(`Proposal is already ${status}`);
  }
}

async function appendDecisionNote(row: ProposalRow): Promise<void> {
  await serialize(`note:${row.conversation_id}`, async () => {
    const open = await countOpenProposals(row.conversation_id);
    const verb = {
      applied: row.kind === 'merge' ? 'Approved' : 'Approved and applied',
      denied: 'Denied',
      failed: 'Failed',
      stale: 'Stale, nothing written',
    } as const;
    const label = verb[row.status as keyof typeof verb] ?? String(row.status);
    const saved = await saveChatMessage({
      group_folder: row.project_id,
      role: 'assistant',
      content: `\n\n_${label} by ${row.decided_by ?? 'user'}: ${row.title} (\`${row.name}\`). ${row.result ?? ''}_`,
      sender_name: null,
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: row.conversation_id,
      objective_id: row.objective_id,
      // Stay under "Needs you" until every proposal has been decided.
      pending: open > 0,
    });
    broadcast({
      type: 'chat_message',
      payload: { folder: row.project_id, message: saved },
    });
    broadcast({
      type: 'conversations_changed',
      payload: chatEventScope(row.project_id, row.objective_id),
    });
  });
}

async function postDecisionNote(row: ProposalRow): Promise<void> {
  try {
    await appendDecisionNote(row);
  } catch (err) {
    logger.warn({ err, proposalId: row.id }, 'Proposal: decision note failed');
  }
}

/** Finish a claimed row and post its decision note; the note is best effort. */
async function recordOutcome(
  claimed: ProposalRow,
  status: 'applied' | 'denied' | 'failed' | 'stale',
  result: string,
): Promise<ProposalRow> {
  const finished =
    (await finishProposal(claimed.id, status, result)) ?? claimed;
  await postDecisionNote(finished);
  return finished;
}

/** A prompt proposal: deny only dismisses; approve writes unless it went stale. */
async function decidePromptProposal(
  claimed: ProposalRow,
  action: ProposalAction,
): Promise<ProposalRow> {
  let status: 'applied' | 'denied' | 'failed' | 'stale';
  let result: string;
  try {
    if (action.type === 'set_prompt') {
      const applied = await serialize(promptLockKey(action), () =>
        applyPromptProposal(action, claimed.base_hash, registeredGroups),
      );
      status = applied ? 'applied' : 'stale';
      result =
        applied ??
        'The prompt changed after this was proposed. Nothing was written.';
    } else {
      status = 'denied';
      result = 'Dismissed.';
    }
  } catch (err) {
    status = 'failed';
    result = err instanceof Error ? err.message : String(err);
    logger.warn({ err, proposalId: claimed.id }, 'Prompt proposal failed');
  }
  return recordOutcome(claimed, status, result);
}

/**
 * Apply the user's decision. Throws UnsupportedLayerError (nothing claimed) or
 * ProposalAlreadyDecidedError; execution failures are recorded on the row.
 */
export async function decideProposal(
  row: ProposalRow,
  decision: 'approve' | 'deny',
  decidedBy: string,
  mergeDeps?: MergeDecisionDependencies,
): Promise<ProposalRow> {
  const action: ProposalAction =
    decision === 'approve'
      ? parseAction(row.approve_action)
      : row.deny_action
        ? parseAction(row.deny_action)
        : { type: 'none' };
  if (action.type !== 'none') assertLayerSupported(row.target_layer);

  const claimed = await claimProposal(row.id, decidedBy);
  if (!claimed) throw new ProposalAlreadyDecidedError(row.status);
  if (isPromptProposal(claimed)) {
    return decidePromptProposal(claimed, action);
  }
  if (!isItemProposal(claimed)) {
    return decideMergeProposal(
      claimed,
      decision,
      (status, result) => recordOutcome(claimed, status, result),
      postDecisionNote,
      mergeDeps,
    );
  }

  let status: 'applied' | 'denied' | 'failed' | 'stale';
  let result: string;
  let needsRefresh = false;
  try {
    if (action.type === 'none') {
      status = decision === 'approve' ? 'applied' : 'denied';
      result = decision === 'approve' ? 'No change was needed.' : 'Dismissed.';
    } else {
      let applied: ExecutionOutcome | null;
      if (isPromotionLayer(claimed.target_layer)) {
        applied = await serialize(
          // One commit at a time per repository, whatever item it touches.
          `promotion:${promotionTarget(claimed.target_layer, claimed.kind, claimed.name).repo}`,
          () => applyPromotionProposal(claimed, action),
        );
      } else {
        const target = resolveTarget(claimed);
        applied = await serialize(`item:${target.itemPath}`, async () => {
          const snapshot = await readSnapshot(target);
          if (hashSnapshot(snapshot) !== claimed.base_hash) return null;
          return executeAction(action, target, snapshot);
        });
      }
      if (!applied) {
        status = 'stale';
        result =
          'The target changed after this was proposed. Nothing was written.';
      } else {
        status = decision === 'approve' ? 'applied' : 'denied';
        result = applied.message;
        needsRefresh = applied.needsRefresh;
      }
    }
  } catch (err) {
    status = 'failed';
    result = err instanceof Error ? err.message : String(err);
    logger.warn({ err, proposalId: row.id }, 'Proposal action failed');
  }

  // Record the outcome as soon as the write is done: the (slow) refresh below
  // must not leave an already-applied change in `applying`.
  const finished = await recordOutcome(claimed, status, result);
  if (!needsRefresh) return finished;
  const refreshed = await refreshAgentView(claimed.project_id);
  return (
    (await updateProposalResult(row.id, `${result}. ${refreshed}`)) ?? finished
  );
}

/**
 * Close proposals a Board restart left in `applying`. The action is never
 * replayed: the outcome is recorded as failed with a hint whether the target
 * still matches the proposal's base, so the user can check and re-propose.
 */
export async function reconcileInterruptedProposals(): Promise<number> {
  const rows = await listApplyingProposals();
  for (const row of rows) {
    let detail = '';
    if (isPromptProposal(row)) {
      detail = ' The prompt may or may not have been written.';
    } else if (!isItemProposal(row)) {
      // The merge is never resumed on its own: the approval may or may not have
      // been recorded as applied, and a person decides again.
      detail =
        ' The merge was not resumed. Check the task card; if it is still parked, move it again to request a new approval.';
    } else {
      try {
        const target = resolveTarget(row);
        const matches =
          hashSnapshot(await readSnapshot(target)) === row.base_hash;
        detail = ` ${target.itemPath} ${
          matches
            ? 'still matches the proposal base, so the change was most likely not written.'
            : 'differs from the proposal base, so the change may have been written.'
        }`;
      } catch {
        /* the target cannot be inspected; report the interruption alone */
      }
    }
    const finished = await finishProposal(
      row.id,
      'failed',
      `Board restarted while this was being applied; it was not replayed.${detail}${isItemProposal(row) || isPromptProposal(row) ? ' Check the target and propose again if needed.' : ''}`,
    );
    if (!finished) continue;
    try {
      await appendDecisionNote(finished);
    } catch (err) {
      logger.warn(
        { err, proposalId: row.id },
        'Proposal: recovery note failed',
      );
    }
  }
  return rows.length;
}
