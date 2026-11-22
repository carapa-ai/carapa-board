/**
 * `prompt` proposals: an agent proposes a project system, worker or stage
 * prompt; on approval the Board applies it exactly as `set_project_prompt`.
 *
 * Staleness uses the hash of the single target prompt, not the whole-setup
 * revision, which changes with any stage or prompt edit. The setup revision is
 * checked once, at creation, like `set_project_prompt` does.
 */
import { hasPermission } from '../../mcp/auth.js';
import { sha256Hex } from '../../lib/hash.js';
import { withReparentMutex } from '../projects/reparent-project.js';
import { getGroupByFolder } from '../../state-manager.js';
import type { RegisteredGroup } from '../../types.js';
import { canAccessProject } from '../../routes/_helpers.js';
import {
  applyProjectPrompt,
  findCurrentGroup,
  readTargetPrompt,
  requireRevision,
  resolvePromptTarget,
} from '../project-setup/project-prompts.js';
import {
  assertPromptProposalShape,
  ProposalValidationError,
  type ProposalAction,
  type SetPromptAction,
} from './actions.js';
import { fileChange, type ActionPreview } from './targets.js';
import type { PromotionBaseFile } from './promotion-targets.js';

type Groups = Record<string, RegisteredGroup>;

/** Validate the prompt target, then read its live content (null if unset). */
async function readPromptWithFilename(
  groups: Groups,
  project: string,
  type: SetPromptAction['prompt_type'],
  stageId?: string,
): Promise<{ filename: string; current: string | null }> {
  const { filename } = resolvePromptTarget(groups, project, type, stageId);
  const current = await readTargetPrompt(groups, project, type, stageId);
  return { filename, current };
}

/** Which prompt a card is about; the file name is part of the preview. */
export interface PromptPresentation {
  targetProject: string;
  promptType: SetPromptAction['prompt_type'];
  stageId: string | null;
}

/** Hash of a prompt as stored: absent and empty are the same. */
function hashPrompt(content: string | null | undefined): string {
  return sha256Hex(content ?? '');
}

export function promptPresentation(
  action: ProposalAction,
): PromptPresentation | undefined {
  if (action.type !== 'set_prompt') return undefined;
  return {
    targetProject: action.target_project,
    promptType: action.prompt_type,
    stageId: action.stage_id ?? null,
  };
}

/**
 * Validate a new prompt proposal against the live board and capture the prompt
 * it was written against. Throws ProposalValidationError.
 */
export async function promptProposalBase(
  proposal: { name: string; target_layer: string },
  approve: ProposalAction,
  deny: ProposalAction | null,
  permissions: Record<string, string[]> | undefined,
  groups: Groups,
): Promise<{ hash: string; files: PromotionBaseFile[] }> {
  assertPromptProposalShape(proposal, approve, deny);
  const { target_project: project } = approve;
  if (!hasPermission(permissions, project, 'project_setup:read')) {
    throw new ProposalValidationError(
      `Unauthorized: missing "project_setup:read" permission for project "${project}"`,
    );
  }
  try {
    const { group } = findCurrentGroup(groups, project);
    await requireRevision(approve.expected_revision, group, groups);
    const { filename, current } = await readPromptWithFilename(
      groups,
      project,
      approve.prompt_type,
      approve.stage_id,
    );
    return {
      hash: hashPrompt(current),
      files: [{ path: filename, content: current ?? '' }],
    };
  } catch (err) {
    throw new ProposalValidationError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Diff of the live prompt against the proposed one, as the card shows it. */
export async function previewPrompt(
  action: SetPromptAction,
  baseHash: string,
  pending: boolean,
  groups: Groups,
): Promise<{ preview: ActionPreview; targetChanged: boolean }> {
  const { filename, current } = await readPromptWithFilename(
    groups,
    action.target_project,
    action.prompt_type,
    action.stage_id,
  );
  // Apply trims, and a blank prompt is removed.
  const proposed = action.content?.trim() || null;
  return {
    targetChanged: pending && hashPrompt(current) !== baseHash,
    preview: {
      actionType: 'set_prompt',
      targetPath: '',
      exists: current !== null,
      replacesSymlink: false,
      symlinkTarget: null,
      contentHidden: false,
      files: [
        {
          path: filename,
          // Removing a prompt that is already absent is still a removal, not an add.
          ...(!current && !proposed
            ? { change: 'removed' as const, diff: '' }
            : fileChange(
                current ? Buffer.from(current, 'utf8') : undefined,
                proposed ? Buffer.from(proposed, 'utf8') : undefined,
              )),
        },
      ],
      problem: null,
    },
  };
}

/** Serialization key for writes of one prompt file. */
export function promptLockKey(action: SetPromptAction): string {
  return `prompt:${action.target_project}:${action.prompt_type}:${action.stage_id ?? ''}`;
}

/**
 * Write the prompt unless it changed after the proposal. Returns the result
 * text, or null when the prompt is stale and nothing was written. Callers hold
 * the `promptLockKey` lock.
 */
export async function applyPromptProposal(
  action: SetPromptAction,
  baseHash: string,
  groups: Groups,
): Promise<string | null> {
  return withReparentMutex(async () => {
    const { filename, current } = await readPromptWithFilename(
      groups,
      action.target_project,
      action.prompt_type,
      action.stage_id,
    );
    if (hashPrompt(current) !== baseHash) return null;
    const { revision } = await applyProjectPrompt(
      groups,
      action.target_project,
      action.prompt_type,
      action.stage_id,
      action.content,
    );
    return `Applied \`${filename}\` to \`${action.target_project}\`, setup revision \`${revision}\``;
  });
}

class PromptApprovalDenied extends Error {}

/**
 * Whether this user may change the prompts of `project`: a signed-in admin
 * (except on another user's personal main project) or an explicit owner or
 * editor. Chat-only and viewer access do not count. Throws on every other case,
 * including lookup errors, so a failure never grants approval.
 */
export async function assertPromptApprover(
  user: { id?: string; role?: string } | undefined,
  project: string,
): Promise<void> {
  const denied = new PromptApprovalDenied(
    `Approving a prompt change needs owner or editor access to project "${project}"`,
  );
  if (!user?.id) throw denied;
  let allowed = false;
  try {
    const group = getGroupByFolder(project);
    if (!group) throw denied;
    allowed = await canAccessProject(
      { id: user.id, role: user.role },
      project,
      {
        min: 'editor',
      },
    );
  } catch {
    allowed = false;
  }
  if (!allowed) throw denied;
}
