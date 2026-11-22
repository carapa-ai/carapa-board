export function personaSenderId(entry: {
  senderUserId?: unknown;
  agent_name?: unknown;
}): string | null {
  if (
    typeof entry.senderUserId === 'string' &&
    entry.senderUserId.startsWith('ai:')
  ) {
    return entry.senderUserId;
  }
  if (typeof entry.agent_name !== 'string') return null;
  if (entry.agent_name.startsWith('ai-main:')) {
    return `ai:${entry.agent_name.slice('ai-main:'.length)}`;
  }
  return entry.agent_name.startsWith('ai:') ? entry.agent_name : null;
}

export function startsNewPersonaBubble(
  currentSenderId: string | null,
  incomingSenderId: string | null,
  incomingHasContent: boolean,
  incomingIsStreaming = false,
): boolean {
  return (
    (incomingHasContent || incomingIsStreaming) &&
    incomingSenderId !== null &&
    (incomingSenderId !== currentSenderId ||
      (incomingIsStreaming && incomingHasContent))
  );
}

/** True when the current user turn already contains an invited persona row. */
export function hasPersonaResponseAfterLastUser(
  messages: Array<{
    role: string;
    senderUserId?: unknown;
    agent_name?: unknown;
  }>,
): boolean {
  let lastUserIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === 'user') lastUserIndex = index;
  }
  if (lastUserIndex < 0) return false;
  return messages
    .slice(lastUserIndex + 1)
    .some(
      (message) =>
        message.role === 'assistant' && personaSenderId(message) !== null,
    );
}

/**
 * Keep the default agent's live response between any before-persona turns and
 * the after-persona turns that follow it. The returned message remains a
 * stable React anchor while the streamed response becomes durable.
 */
export function defaultAgentStreamAnchorId(
  messages: Array<{
    id: string;
    role: string;
    senderUserId?: unknown;
    agent_name?: unknown;
  }>,
  beforePersonaIds: ReadonlySet<string>,
): string | null {
  let lastUserIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === 'user') lastUserIndex = index;
  }
  if (lastUserIndex < 0) return null;

  let anchorId = messages[lastUserIndex].id;
  for (let index = lastUserIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const senderId = personaSenderId(message);
    if (!senderId || !beforePersonaIds.has(senderId)) break;
    anchorId = message.id;
  }
  return anchorId;
}
