const PREVIEW_MAX_LENGTH = 120;
// The web client appends this block (names plus container paths) after the
// user's text whenever it uploads attachments.
const TRAILING_ATTACHED_FILES_BLOCK =
  /(?:\n\n)?\[Attached files\]\n(?:- .+\n?)+$/;

export interface PreviewAttachment {
  type?: string;
  filename?: string;
}

/**
 * Conversation list preview for a user message, derived from the message text
 * before server-side enrichment. When attachment metadata accompanies the
 * message, the generated trailing `[Attached files]` block is dropped; the same
 * text without attachments is user-authored and kept as is. An attachment-only
 * message falls back to a names-only `Attached: a, b` label.
 */
export function buildConversationPreview(
  content: string,
  attachments?: readonly PreviewAttachment[] | null,
): string {
  if (!attachments?.length) return content.substring(0, PREVIEW_MAX_LENGTH);
  const text = content.replace(TRAILING_ATTACHED_FILES_BLOCK, '').trim();
  if (text) return text.substring(0, PREVIEW_MAX_LENGTH);
  const names = attachments.map((a) => a.filename || a.type || 'file');
  return `Attached: ${names.join(', ')}`.substring(0, PREVIEW_MAX_LENGTH);
}
