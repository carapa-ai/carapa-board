/**
 * One-shot LLM drafting of a kanban task description.
 *
 * The board UI calls POST /api/projects/:pid/tasks/:fid/description/draft,
 * which builds a prompt from the task's current description and the user's
 * instruction and sends it to the project's default chat runtime via a
 * single non-streaming LLM call. This module performs no persistence — the
 * UI applies the draft through the existing description update route.
 */
import { llmComplete } from '../../lib/llm-client.js';
import { getDefaultRuntimeSelection } from '../../lib/chat-agents.js';
import type { TaskDescriptionDraftHistoryEntry } from '../../types.js';

/** LLM invoker seam: system prompt + user message in, model text out. */
export type DescriptionDraftInvoker = (
  systemPrompt: string,
  userMessage: string,
  context?: { projectId?: string },
) => Promise<string>;

/** Fallback max output tokens when the agent profile sets none. */
const DESCRIPTION_DRAFT_MAX_TOKENS = 16_384;

/**
 * The production invoker: a one-shot, non-streaming completion against the
 * project's default chat runtime. Callers never hardcode an agent id — the
 * runtime is resolved per request from board_agents.jsonc.
 */
export const llmDescriptionDraftInvoker: DescriptionDraftInvoker = async (
  systemPrompt,
  userMessage,
  context,
) => {
  const response = await llmComplete(
    {
      runtimeSelection: getDefaultRuntimeSelection('chat'),
      maxTokens: DESCRIPTION_DRAFT_MAX_TOKENS,
    },
    systemPrompt,
    userMessage,
    { projectId: context?.projectId, privacyPurpose: 'helper' },
  );
  return response.content;
};

let activeDescriptionDraftInvoker: DescriptionDraftInvoker =
  llmDescriptionDraftInvoker;

/**
 * Test seam: swap the invoker used by the route and
 * `draftTaskDescription`. Pass `null` to restore the production LLM invoker.
 */
export function setDescriptionDraftInvoker(
  invoke: DescriptionDraftInvoker | null,
): void {
  activeDescriptionDraftInvoker = invoke ?? llmDescriptionDraftInvoker;
}

/** The invoker the route uses for production calls. */
export function getDescriptionDraftInvoker(): DescriptionDraftInvoker {
  return activeDescriptionDraftInvoker;
}

export interface DescriptionDraftInput {
  title: string;
  description: string;
  instruction: string;
  /** Prior refine turns, oldest first. */
  history?: TaskDescriptionDraftHistoryEntry[];
  /** Project whose privacy mode governs the draft call. */
  projectId?: string;
}

const SYSTEM_PROMPT = [
  'You are editing the description of a kanban task card.',
  "Given the task title, the current description, and the user's instruction, return ONLY the updated description as markdown.",
  'No preamble, no code fences, no explanation.',
  'Preserve the existing structure and any content the instruction does not change.',
].join(' ');

/** Build the prompt pair for a description rewrite. Pure — no LLM, no DB. */
function buildDescriptionDraftPrompt(input: DescriptionDraftInput): {
  systemPrompt: string;
  userMessage: string;
} {
  const lines: string[] = [];
  lines.push(`Task title: ${input.title.trim() || '(untitled)'}`);
  lines.push('');
  lines.push('Current description:');
  lines.push(input.description.trim() || '(no description yet)');
  const history = (input.history ?? []).filter(
    (entry) =>
      entry &&
      typeof entry.instruction === 'string' &&
      typeof entry.draft === 'string',
  );
  if (history.length > 0) {
    lines.push('');
    lines.push(
      `Refinement history from this panel (${history.length} turn${history.length === 1 ? '' : 's'}, oldest first). Edit the latest draft:`,
    );
    history.forEach((entry, index) => {
      lines.push('');
      lines.push(`Turn ${index + 1} instruction:`);
      lines.push(entry.instruction);
      lines.push(`Turn ${index + 1} draft:`);
      lines.push(entry.draft);
    });
  }
  lines.push('');
  lines.push('Instruction:');
  lines.push(input.instruction);
  return { systemPrompt: SYSTEM_PROMPT, userMessage: lines.join('\n') };
}

/**
 * Normalize raw model text: trim and strip a single outer code fence if the
 * model wrapped the entire response in one despite the system prompt.
 */
export function normalizeDraft(raw: string): string {
  const text = raw.trim();
  const fenced = text.match(
    /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/,
  );
  if (fenced) return fenced[1].trim();
  return text;
}

/**
 * Draft a rewritten task description with a single LLM call. `invoke` is
 * the production dependency seam: the route passes
 * `getDescriptionDraftInvoker()`; tests pass a stub.
 */
export async function draftTaskDescription(
  input: DescriptionDraftInput,
  invoke: DescriptionDraftInvoker = getDescriptionDraftInvoker(),
): Promise<{ draft: string }> {
  const { systemPrompt, userMessage } = buildDescriptionDraftPrompt(input);
  const draft = normalizeDraft(
    await invoke(systemPrompt, userMessage, {
      projectId: input.projectId,
    }),
  );
  if (!draft) {
    throw new Error('The language model returned an empty draft');
  }
  return { draft };
}
