import type { ChatModeDefinition } from '@/types';

/** Limits enforced by the server (`src/routes/projects.ts`, chatModes). */
const MAX_CHAT_MODES = 20;
const MAX_CHAT_MODE_LABEL_LENGTH = 60;
const CHAT_MODE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

export function isValidChatModeId(id: string): boolean {
  return CHAT_MODE_ID_PATTERN.test(id);
}

export function isValidChatModeLabel(label: string): boolean {
  const trimmed = label.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_CHAT_MODE_LABEL_LENGTH;
}

/**
 * Returns a message when the configured chat modes would be rejected by the
 * server (too many modes, an invalid or duplicate id, or a blank or overlong
 * label); otherwise null. An unset or empty list means the built-in defaults,
 * which are always valid.
 */
export function chatModeIdError(
  modes: ChatModeDefinition[] | undefined,
): string | null {
  if ((modes?.length ?? 0) > MAX_CHAT_MODES) {
    return `At most ${MAX_CHAT_MODES} chat modes are allowed.`;
  }
  const seen = new Set<string>();
  for (const mode of modes ?? []) {
    if (!mode.id) return 'Every chat mode needs an id.';
    if (!isValidChatModeId(mode.id)) {
      return `Chat mode id "${mode.id}" must start with a letter and use only lowercase letters, digits, "-" or "_" (max 40 characters).`;
    }
    if (seen.has(mode.id)) return `Chat mode id "${mode.id}" is used twice.`;
    seen.add(mode.id);
    if (!isValidChatModeLabel(mode.label ?? '')) {
      return `Chat mode "${mode.id}" needs a label of 1-${MAX_CHAT_MODE_LABEL_LENGTH} characters.`;
    }
  }
  return null;
}

/**
 * Builds the id-keyed prompt map saved to the server from per-row prompts.
 * Rows with an empty or already-used id (which block saving) and rows without
 * a prompt are omitted.
 */
export function serializeChatModePrompts(
  modes: ChatModeDefinition[],
  rowPrompts: (string | undefined)[],
): Record<string, string> {
  const prompts: Record<string, string> = {};
  const seen = new Set<string>();
  modes.forEach((mode, i) => {
    const prompt = rowPrompts[i];
    if (!mode.id || seen.has(mode.id)) return;
    seen.add(mode.id);
    if (prompt !== undefined) prompts[mode.id] = prompt;
  });
  return prompts;
}
