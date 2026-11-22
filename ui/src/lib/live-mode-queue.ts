import type { RuntimeSelection, sendChatMessage } from '@/lib/api';
import { useStore, type QueuedPrompt } from '@/store';

type LiveModeSend = typeof sendChatMessage;

/** The server processed a Live Mode send as a normal message because its run
 * is off or owned by another session: drop this device's local ownership
 * (which also stops its microphone). Turning Live Mode on stays explicit. */
export function clearRejectedLiveModeOwnership(conversationId: string): void {
  const state = useStore.getState();
  state.setConversationLiveModeEnabled(conversationId, false);
  if (state.liveModeFocusedConversationId === conversationId) {
    state.setLiveModeEnabled(false);
    state.setLiveModeFocus(null, null);
  }
}

function replacePendingPrompt(
  conversationId: string,
  pendingId: string,
  replacement?: QueuedPrompt,
): void {
  useStore.setState((state) => {
    const current = state.queuedPromptsByConv[conversationId] ?? [];
    const index = current.findIndex((prompt) => prompt.id === pendingId);
    if (index < 0) return state;
    const next = [...current];
    if (replacement) next.splice(index, 1, replacement);
    else next.splice(index, 1);
    const queues = { ...state.queuedPromptsByConv };
    if (next.length > 0) queues[conversationId] = next;
    else delete queues[conversationId];
    return { queuedPromptsByConv: queues };
  });
}

interface ConversationSubmissionChain {
  tail: Promise<void>;
  /** The server rejected Live Mode ownership; chained phrases must not be
   * POSTed as Live Mode turns. */
  rejected: boolean;
}

/** Per-conversation submission chains. An entry exists only while a
 * conversation has a submission in flight. */
const submissionChains = new Map<string, ConversationSubmissionChain>();

/** A browser-owned Live Mode prompt ahead of `id` that has not been handed to
 * the server (a failed send, or a send the server returned to the browser). */
function hasEarlierBrowserOwnedLivePrompt(
  conversationId: string,
  id: string,
): boolean {
  const queue = useStore.getState().queuedPromptsByConv[conversationId] ?? [];
  const index = queue.findIndex((prompt) => prompt.id === id);
  return queue
    .slice(0, Math.max(index, 0))
    .some(
      (prompt) =>
        prompt.liveMode && !prompt.serverOwned && !prompt.consumedByServer,
    );
}

/** Keep a Live Mode transcript browser-owned until the POST acknowledges
 * ownership. Its stable ID makes an ambiguous retry safe after a lost reply.
 *
 * Phrases are shown in the local queue immediately, but their POSTs are
 * serialized per conversation so the server receives them in spoken order. A
 * phrase that cannot be sent in order is not dropped and not retried here: it
 * stays a local non-acknowledged prompt, and the normal idle/completion retry
 * sends the browser-owned prompts together in queue order. That applies to a
 * phrase queued behind a failed or rejected send, and to one that follows a
 * failed send after the chain has drained. */
export function submitLiveModeTranscriptWithQueueOwnership(input: {
  projectId: string;
  conversationId: string;
  text: string;
  agentCmd?: string;
  runtimeSelection?: RuntimeSelection;
  liveModeSessionId: string;
  liveModeKind: 'personas' | 'work';
  send?: LiveModeSend;
}): Promise<void> {
  const id = crypto.randomUUID();
  const pending: QueuedPrompt = {
    id,
    contextKey: input.projectId,
    content: input.text,
    bubbleContent: input.text,
    draftContent: input.text,
    conversation_id: input.conversationId,
    agent_cmd: input.agentCmd,
    runtimeSelection: input.runtimeSelection,
    memoryContextLevel: 'off',
    awaitingAcknowledgement: true,
    liveMode: true,
    liveModeSessionId: input.liveModeSessionId,
    liveModeKind: input.liveModeKind,
  };
  useStore.getState().enqueuePrompt(input.conversationId, pending);

  const { conversationId } = input;
  const previous = submissionChains.get(conversationId);
  const chain = previous ?? { tail: Promise.resolve(), rejected: false };
  const deliver = async (): Promise<void> => {
    if (
      chain.rejected ||
      hasEarlierBrowserOwnedLivePrompt(conversationId, id)
    ) {
      replacePendingPrompt(conversationId, id, {
        ...pending,
        awaitingAcknowledgement: false,
      });
      return;
    }
    try {
      const sender = input.send ?? (await import('@/lib/api')).sendChatMessage;
      const result = await sender(
        input.projectId,
        input.text,
        conversationId,
        undefined,
        input.agentCmd,
        undefined,
        true,
        input.runtimeSelection,
        undefined,
        undefined,
        undefined,
        input.liveModeSessionId,
        input.liveModeKind,
        id,
        [id],
      );
      if (result.liveModeRejected) {
        chain.rejected = true;
        clearRejectedLiveModeOwnership(conversationId);
      }
      if (result.delivery === 'queued' && result.queueOwner !== 'direct') {
        replacePendingPrompt(
          conversationId,
          id,
          result.queueOwner === 'persona'
            ? {
                ...pending,
                id: result.queuedMessageId,
                awaitingAcknowledgement: false,
                serverOwned: true,
                serverQueueOwner: 'persona',
              }
            : { ...pending, awaitingAcknowledgement: false },
        );
        return;
      }
      replacePendingPrompt(conversationId, id);
    } catch (error) {
      // The backend may have accepted the turn. Retain the same ID for the
      // normal idle/completion retry, which is idempotent at the route.
      replacePendingPrompt(conversationId, id, {
        ...pending,
        awaitingAcknowledgement: false,
      });
      throw error;
    }
  };

  // An idle conversation starts its POST immediately.
  const run = previous ? chain.tail.then(deliver) : deliver();
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chain.tail = tail;
  submissionChains.set(conversationId, chain);
  void tail.then(() => {
    if (submissionChains.get(conversationId)?.tail === tail)
      submissionChains.delete(conversationId);
  });
  return run;
}
