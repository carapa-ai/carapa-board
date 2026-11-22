import { parseAiUserPrompt, serializeAiUserPrompt } from './prompt.js';

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i,
  );
  return (match?.[1] ?? trimmed).trim();
}

/** Validate and canonicalize model-authored persona Markdown before it reaches the editor. */
export function normalizePersonaDraft(value: string): {
  prompt: string;
  identity: string;
  turn: 'before' | 'after';
  tools: string[];
} {
  const parsed = parseAiUserPrompt(stripMarkdownFence(value));
  if (!parsed.body)
    throw new Error('The drafted persona must include an instruction body');
  return {
    prompt: serializeAiUserPrompt(parsed),
    identity: parsed.identity,
    turn: parsed.turn,
    tools: parsed.tools,
  };
}

/** Reduce common model formatting wrappers while keeping the image prompt editable. */
export function normalizeAvatarPromptDraft(value: string): string {
  const prompt = stripMarkdownFence(value)
    .replace(/^(?:avatar|image) prompt:\s*/i, '')
    .replace(/^(["'])([\s\S]*)\1$/, '$2')
    .trim();
  if (!prompt) throw new Error('The model returned an empty avatar prompt');
  return prompt;
}
