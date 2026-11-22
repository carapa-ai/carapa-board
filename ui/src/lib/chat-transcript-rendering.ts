import { isSyntheticTranscriptId } from './chat-transcript-ownership';

/** Remove repeated canonical assistant rows without removing attribution boundaries. */
export function deduplicateCanonicalAssistantEntries<
  T extends Record<string, any>,
>(entries: T[]): T[] {
  const seen = new Map<string, string>();
  let userTurn = 0;
  return entries.filter((entry) => {
    if (entry.type === 'message' && entry.role === 'user') {
      userTurn += 1;
      return true;
    }
    if (entry.type !== 'message' || entry.role !== 'assistant') return true;
    const identity =
      typeof entry.canonicalMessageId === 'string' &&
      entry.canonicalMessageId.length > 0
        ? entry.canonicalMessageId
        : typeof entry.id === 'string'
          ? entry.id
          : null;
    if (!identity) return true;
    // Formatter fallback IDs encode only an entry's current array position,
    // so pagination or stale refetches can reuse them for another user turn.
    // Canonical/provider IDs remain globally unique across the transcript.
    const deduplicationKey = isSyntheticTranscriptId(identity)
      ? `${userTurn}:${identity}`
      : identity;
    const content = typeof entry.content === 'string' ? entry.content : '';
    const previous = seen.get(deduplicationKey);
    if (previous === undefined) {
      seen.set(deduplicationKey, content);
      return true;
    }
    if (!previous && content) {
      seen.set(deduplicationKey, content);
      return true;
    }
    return false;
  });
}
