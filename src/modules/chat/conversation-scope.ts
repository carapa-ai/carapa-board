import { broadcast, type WsEvent } from '../objectives/ws-events.js';

/**
 * Chat WebSocket scope: `folder` is always the owning project's folder.
 * Objective chats add `objective_id` (and `project_id`) as extra fields.
 */
export function chatEventScope(
  projectFolder: string,
  objectiveId?: string | null,
): { folder: string; objective_id?: string; project_id?: string } {
  return objectiveId
    ? {
        folder: projectFolder,
        objective_id: objectiveId,
        project_id: projectFolder,
      }
    : { folder: projectFolder };
}

/** Broadcast a chat event, tagging it with the objective it belongs to. */
export function broadcastConversationEvent(
  event: WsEvent,
  projectId: string,
  objectiveId?: string,
): void {
  if (
    !objectiveId ||
    !(event.type.startsWith('chat_') || event.type === 'conversations_changed')
  )
    return broadcast(event);
  broadcast({
    type: event.type,
    payload: {
      ...(event.payload as Record<string, unknown>),
      objective_id: objectiveId,
      project_id: projectId,
    },
  });
}
