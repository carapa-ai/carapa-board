export const PUBLIC_REPLAY_READING_DELAY_MS = 1_200;

export type PublicReplayMessageVisibility = 'before' | 'complete' | 'current' | 'hidden';

/** Resolve presentation without relying on array indexes that can shift when older history loads. */
export function publicReplayMessageVisibility(
  messageIds: readonly string[],
  startMessageId: string,
  currentMessageId: string,
  messageId: string,
): PublicReplayMessageVisibility {
  const startIndex = messageIds.indexOf(startMessageId);
  const currentIndex = messageIds.indexOf(currentMessageId);
  const messageIndex = messageIds.indexOf(messageId);
  if (startIndex < 0 || currentIndex < 0 || messageIndex < 0 || messageIndex < startIndex) return 'before';
  if (messageIndex < currentIndex) return 'complete';
  if (messageIndex === currentIndex) return 'current';
  return 'hidden';
}

export function publicReplayAudioProgress(currentTime: number, duration: number): number {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(1, currentTime / duration));
}

export function nextPublicReplayMessageId(
  messageIds: readonly string[],
  currentMessageId: string,
): string | null {
  const currentIndex = messageIds.indexOf(currentMessageId);
  return currentIndex >= 0 ? messageIds[currentIndex + 1] ?? null : null;
}

export function nextPublicReplaySpeakerId(
  messages: readonly { id: string; speechAvailable: boolean }[],
  currentMessageId: string,
): string | null {
  const currentIndex = messages.findIndex((message) => message.id === currentMessageId);
  return currentIndex >= 0
    ? messages.slice(currentIndex + 1).find((message) => message.speechAvailable)?.id ?? null
    : null;
}
