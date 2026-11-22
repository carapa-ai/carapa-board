import type { Response } from 'express';

export type PublicConversationEvent =
  | { type: 'changed'; messageId?: string; autoSpeak?: boolean }
  | {
      type: 'speechReady';
      messageId: string;
      durationMs: number;
      autoSpeak: boolean;
    }
  | { type: 'speechFailed'; messageId: string }
  | { type: 'liveMode'; enabled: boolean }
  | { type: 'revoked' };

const subscribers = new Map<string, Set<Response>>();

export function subscribePublicConversation(
  conversationId: string,
  response: Response,
): () => void {
  const set = subscribers.get(conversationId) ?? new Set<Response>();
  set.add(response);
  subscribers.set(conversationId, set);
  return () => {
    set.delete(response);
    if (set.size === 0) subscribers.delete(conversationId);
  };
}

export function publishPublicConversationEvent(
  conversationId: string,
  event: PublicConversationEvent,
): void {
  const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of subscribers.get(conversationId) ?? []) {
    try {
      response.write(data);
      if (event.type === 'revoked') response.end();
    } catch {
      response.end();
    }
  }
  if (event.type === 'revoked') subscribers.delete(conversationId);
}

export function publishPublicEventFromBoardEvent(event: {
  type: string;
  payload: unknown;
}): void {
  const payload = event.payload as any;
  const conversationId =
    payload?.conversation_id ?? payload?.message?.conversation_id;
  if (typeof conversationId !== 'string') return;
  if (event.type === 'chat_message') {
    const message = payload?.message;
    publishPublicConversationEvent(conversationId, {
      type: 'changed',
      messageId: typeof message?.id === 'string' ? message.id : undefined,
      // Speech is announced only after the shared server asset is ready.
      autoSpeak: false,
    });
  } else if (
    event.type === 'chat_completed' ||
    event.type === 'messages_cleared'
  ) {
    publishPublicConversationEvent(conversationId, { type: 'changed' });
  }
}
