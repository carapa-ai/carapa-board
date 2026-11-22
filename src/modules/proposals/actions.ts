/**
 * Typed action whitelist for agent-proposed rule/skill changes.
 *
 * An agent never supplies a command: it supplies one of these records, which
 * is validated here when the proposal is created and again before it runs.
 */
import { z } from 'zod';
import { STAGE_ID_PATTERN } from '../kanban/stages.js';

/** Skill and rule folders/files, handled by the item machinery. */
export const ITEM_PROPOSAL_KINDS = ['skill', 'rule'] as const;
export type ItemProposalKind = (typeof ITEM_PROPOSAL_KINDS)[number];
/** A project system, worker or stage prompt, applied like `set_project_prompt`. */
export const PROMPT_PROPOSAL_KIND = 'prompt';
/** Kinds an agent may propose through `propose_changes`. */
export const AGENT_PROPOSAL_KINDS = [
  ...ITEM_PROPOSAL_KINDS,
  PROMPT_PROPOSAL_KIND,
] as const;
/** `merge` rows are created only by the Board's merge approval flow. */
const PROPOSAL_KINDS = [...AGENT_PROPOSAL_KINDS, 'merge'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export function isItemKind(kind: ProposalKind): kind is ItemProposalKind {
  return (ITEM_PROPOSAL_KINDS as readonly string[]).includes(kind);
}

export const TARGET_LAYERS = [
  'project',
  'objective',
  'group_template',
  'objective_template',
  'platform',
] as const;
export type TargetLayer = (typeof TARGET_LAYERS)[number];

/** Layers whose actions this executor can apply. */
const SUPPORTED_LAYERS: readonly TargetLayer[] = [
  'project',
  'objective',
  'platform',
  'group_template',
  'objective_template',
];

export class ProposalValidationError extends Error {}

export class UnsupportedLayerError extends ProposalValidationError {
  constructor(layer: string) {
    super(`Target layer "${layer}" is not supported yet`);
  }
}

export function isLayerSupported(layer: TargetLayer): boolean {
  return SUPPORTED_LAYERS.includes(layer);
}

export function assertLayerSupported(layer: TargetLayer): void {
  if (!isLayerSupported(layer)) throw new UnsupportedLayerError(layer);
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_FILE_BYTES = 64 * 1024;
const MAX_PROPOSAL_BYTES = 256 * 1024;
export const MAX_FILES = 32;
const MAX_PROMPT_CHARS = 100_000;
const MAX_PATH_DEPTH = 6;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

const mergeFindingSchema = z
  .object({
    ruleId: z.string().max(200),
    file: z.string().max(1000),
    reason: z.string().max(1000),
  })
  .strict();
export type MergeFinding = z.infer<typeof mergeFindingSchema>;

const fileSchema = z
  .object({
    path: z
      .string()
      .describe('Path relative to the item, e.g. "SKILL.md" or "my-rule.md"'),
    content: z.string(),
  })
  .strict();

export const proposalActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('write_item'),
      files: z.array(fileSchema).min(1).max(MAX_FILES),
    })
    .strict(),
  z
    .object({
      type: z.literal('set_prompt'),
      /** Project whose prompt changes; may differ from the proposing project. */
      target_project: z.string().min(1),
      /** Setup revision from `get_project_setup`, checked at creation. */
      expected_revision: z.string().min(1),
      prompt_type: z.enum(['system', 'worker', 'stage']),
      stage_id: z.string().regex(STAGE_ID_PATTERN).optional(),
      /** Null or blank removes the prompt. */
      content: z.string().max(MAX_PROMPT_CHARS).nullable(),
    })
    .strict(),
  z.object({ type: z.literal('delete_item') }).strict(),
  z.object({ type: z.literal('mark_local') }).strict(),
  z.object({ type: z.literal('none') }).strict(),
  z
    .object({
      type: z.literal('merge_task'),
      /** Approving resumes the card the gate parked in review. */
      resume: z.boolean().optional(),
      /** What made the merge risky, for the approval card. */
      findings: z.array(mergeFindingSchema).max(200).optional(),
      /** Findings beyond those listed. */
      omitted: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type ProposalAction = z.infer<typeof proposalActionSchema>;
export type SetPromptAction = Extract<ProposalAction, { type: 'set_prompt' }>;

/** Proposal name for a prompt: `system`, `worker` or `stage-<stage id>`. */
function promptProposalName(action: SetPromptAction): string {
  if (action.prompt_type !== 'stage') return action.prompt_type;
  return `stage-${(action.stage_id ?? '').replace(/\./g, '-')}`;
}

/** Shape rules of a `prompt` proposal that need no board state. */
export function assertPromptProposalShape(
  proposal: { name: string; target_layer: string },
  approve: ProposalAction,
  deny: ProposalAction | null,
): asserts approve is SetPromptAction {
  if (approve.type !== 'set_prompt') {
    throw new ProposalValidationError(
      'A prompt proposal needs a set_prompt approve_action',
    );
  }
  if (proposal.target_layer !== 'project') {
    throw new ProposalValidationError(
      'A prompt proposal must use target_layer "project"',
    );
  }
  if (deny && deny.type !== 'none') {
    throw new ProposalValidationError(
      'A prompt proposal may only have a "none" deny_action',
    );
  }
  const expected = promptProposalName(approve);
  if (proposal.name !== expected) {
    throw new ProposalValidationError(
      `Prompt proposal name must be "${expected}", not "${proposal.name}"`,
    );
  }
}

/** A relative path with plain segments: no `..`, absolute, hidden or odd names. */
function isSafeItemPath(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 400) {
    return false;
  }
  const segments = raw.split('/');
  return (
    segments.length <= MAX_PATH_DEPTH &&
    segments.every((segment) => PATH_SEGMENT.test(segment))
  );
}

function hasFrontmatter(content: string): boolean {
  return /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.test(content);
}

/** Name of the file that carries the frontmatter for an item. */
export function itemEntryFile(kind: ItemProposalKind, name: string): string {
  return kind === 'skill' ? 'SKILL.md' : `${name}.md`;
}

export function parseAction(raw: unknown): ProposalAction {
  const parsed = proposalActionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProposalValidationError(
      `Invalid action: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'action'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export function assertValidName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ProposalValidationError(
      `Invalid name "${name}": must match ${NAME_PATTERN.source}`,
    );
  }
}

/** Validate an action against the item it targets. Throws on the first problem. */
export function validateAction(
  action: ProposalAction,
  item: { kind: ProposalKind; name: string },
): void {
  // Both directions: `merge_task` belongs to merge rows alone, and a merge row
  // can do nothing else.
  if (item.kind === 'merge') {
    if (action.type !== 'merge_task' && action.type !== 'none') {
      throw new ProposalValidationError(
        `A merge approval accepts only merge_task or none, not ${action.type}`,
      );
    }
    return;
  }
  if (action.type === 'merge_task') {
    throw new ProposalValidationError(
      'merge_task is only valid for a merge approval',
    );
  }
  if (item.kind === PROMPT_PROPOSAL_KIND) {
    if (action.type !== 'set_prompt' && action.type !== 'none') {
      throw new ProposalValidationError(
        `A prompt proposal accepts only set_prompt or none, not ${action.type}`,
      );
    }
    return;
  }
  if (action.type === 'set_prompt') {
    throw new ProposalValidationError(
      'set_prompt is only valid for a prompt proposal',
    );
  }
  if (action.type !== 'write_item') return;
  const entry = itemEntryFile(item.kind, item.name);
  const seen = new Set<string>();
  let total = 0;
  for (const file of action.files) {
    if (!isSafeItemPath(file.path)) {
      throw new ProposalValidationError(
        `Invalid file path "${file.path}": must be relative, without "..", hidden or unusual segments`,
      );
    }
    if (seen.has(file.path)) {
      throw new ProposalValidationError(`Duplicate file path "${file.path}"`);
    }
    seen.add(file.path);
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      throw new ProposalValidationError(
        `File "${file.path}" is ${bytes} bytes; the limit is ${MAX_FILE_BYTES}`,
      );
    }
    total += bytes;
  }
  if (total > MAX_PROPOSAL_BYTES) {
    throw new ProposalValidationError(
      `Proposal files total ${total} bytes; the limit is ${MAX_PROPOSAL_BYTES}`,
    );
  }
  if (item.kind === 'rule' && (action.files.length !== 1 || !seen.has(entry))) {
    throw new ProposalValidationError(
      `A rule is a single file; write exactly "${entry}"`,
    );
  }
  if (item.kind === 'skill' && !seen.has(entry)) {
    throw new ProposalValidationError(`A skill must include "${entry}"`);
  }
  const entryContent = action.files.find((f) => f.path === entry)?.content;
  if (item.kind === 'rule' && !hasFrontmatter(entryContent ?? '')) {
    throw new ProposalValidationError(
      `Rule file "${entry}" must start with a frontmatter block (--- ... ---)`,
    );
  }
}

/** Return `content` with `local: true` set in its frontmatter (created if absent). */
export function setLocalFrontmatter(content: string): string {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(
    content,
  );
  if (!match) return `---\nlocal: true\n---\n${content}`;
  const body = match[1];
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => /^local\s*:/.test(line));
  if (index >= 0) lines[index] = 'local: true';
  else lines.push('local: true');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return `---${eol}${lines.join(eol)}${eol}---${match[2]}${content.slice(match[0].length)}`;
}
