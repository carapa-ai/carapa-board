export type SpeechPriority =
  | 'focused'
  | 'background-completion'
  | 'background-blocker';
export interface SpeechItem {
  conversationId: string;
  text: string;
  priority: SpeechPriority;
  sequence: number;
  kind?: 'status' | 'narration' | 'reply';
  messageId?: string;
  voice?: string;
  lang?: string;
  projectId?: string;
  audioUrl?: string;
  startOffsetSeconds?: number;
  onStarted?: () => void;
}

const rank = (priority: SpeechPriority) =>
  priority === 'background-blocker' ? 3 : priority === 'focused' ? 2 : 1;

export function queueSpeech(
  queue: SpeechItem[],
  item: SpeechItem,
): SpeechItem[] {
  if (
    item.messageId &&
    queue.some((entry) => entry.messageId === item.messageId)
  )
    return queue;
  // Work Live Mode narration is an event stream, not replaceable state. Keep
  // every short marker in arrival order; the single player consumes this FIFO
  // without applying persona playback backpressure to the server.
  if (item.kind === 'narration') return [...queue, item];
  const retained =
    item.kind === 'reply'
      ? queue
      : queue.filter(
          (entry) =>
            entry.kind === 'reply' ||
            entry.conversationId !== item.conversationId,
        );
  return [...retained, item].sort(
    (a, b) =>
      Number(b.kind === 'reply') - Number(a.kind === 'reply') ||
      rank(b.priority) - rank(a.priority) ||
      a.sequence - b.sequence,
  );
}
export function cancelSpeech(
  queue: SpeechItem[],
  conversationId?: string,
): SpeechItem[] {
  return conversationId
    ? queue.filter((item) => item.conversationId !== conversationId)
    : [];
}
export function isBackgroundCompletionBlocked(
  focusedId: string | null,
  activeId: string | null,
  queue: SpeechItem[],
): boolean {
  return (
    focusedId !== null &&
    (activeId === focusedId ||
      queue.some((item) => item.priority === 'focused'))
  );
}
