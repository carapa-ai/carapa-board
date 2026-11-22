import type { Conversation } from '../types.js';

export type LiveModeKind = 'personas' | 'work';

export const PERSONA_LIVE_MODE_HINT =
  'Select a main persona to use Persona Live Mode';

/**
 * One fallback kind for both consumers (ChatPage and LiveModePanel). A stored
 * `personas` kind in a chat with no main or invited persona resolves to
 * `work`, so the panel can never show a Persona policy the chat cannot
 * produce.
 */
export function resolveLiveModeKind(
  stored: LiveModeKind | undefined,
  personaDriven: boolean,
): LiveModeKind {
  if (stored === 'work') return 'work';
  return personaDriven ? 'personas' : 'work';
}

export interface LiveConversationMetadata {
  conversationId: string;
  projectId: string;
  projectName: string;
  title: string;
  preview: string;
  state: string;
  status: string | null;
  updatedAt: string;
}

export function metadataFromConversation(
  conversation: Conversation,
  projectName: string,
  activity?: { state?: string; status?: string | null; updated_at?: string },
): LiveConversationMetadata {
  return {
    conversationId: conversation.id,
    projectId: conversation.group_folder,
    projectName,
    title:
      conversation.title ||
      conversation.preview ||
      `Conversation ${conversation.id.slice(0, 8)}`,
    preview: (conversation.preview || '').slice(0, 160),
    state:
      activity?.state ||
      (conversation.status === 'working' ? 'working' : 'idle'),
    status: activity?.status ?? null,
    updatedAt:
      activity?.updated_at ||
      conversation.last_user_at ||
      conversation.created_at,
  };
}
