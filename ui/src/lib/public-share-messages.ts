import type {
  PublicConversationMessage,
  PublicConversationResponse,
} from '@/types';

/**
 * Merge a page of public messages into the ones already shown, keyed by id.
 * - `prepend`: an older page; ids already present are dropped and the page goes first.
 * - `merge`: a refreshed newest page; known ids are updated in place, new ids are appended.
 */
export function mergePublicMessages(
  existing: PublicConversationMessage[],
  incoming: PublicConversationMessage[],
  position: 'prepend' | 'merge',
): PublicConversationMessage[] {
  if (position === 'prepend') {
    const known = new Set(existing.map((message) => message.id));
    return [
      ...incoming.filter((message) => !known.has(message.id)),
      ...existing,
    ];
  }
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()];
}

/** Apply a refreshed first page without resetting the "load earlier" cursor. */
export function mergeRefreshedPage(
  current: PublicConversationResponse | null,
  next: PublicConversationResponse,
): PublicConversationResponse {
  if (!current) return next;
  return {
    ...next,
    messages: mergePublicMessages(current.messages, next.messages, 'merge'),
    hasMore: current.hasMore,
    nextOffset: current.nextOffset,
  };
}

/** Prepend an older page and advance the cursor to the page's own cursor. */
export function mergeOlderPage(
  current: PublicConversationResponse,
  older: PublicConversationResponse,
): PublicConversationResponse {
  return {
    ...current,
    messages: mergePublicMessages(current.messages, older.messages, 'prepend'),
    hasMore: older.hasMore,
    nextOffset: older.nextOffset,
  };
}
