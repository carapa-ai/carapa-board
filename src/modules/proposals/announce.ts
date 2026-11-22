/**
 * Store proposal rows and post the card message. By default the rows go into a
 * fresh conversation that lands under Now -> Needs you; with `conversation_id`
 * they go into that existing conversation instead. Shared by agent proposals
 * and the Board's own merge approvals.
 */
import { broadcast } from '../objectives/ws-events.js';
import {
  createConversation,
  createObjectiveConversation,
  saveChatMessage,
  updateConversationPreview,
  updateConversationTitleIfUntitled,
} from '../chat/db-chats.js';
import { chatEventScope } from '../chat/conversation-scope.js';
import { insertProposals, type NewProposalRow } from './db-proposals.js';

export function newProposalId(): string {
  return `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The fenced block the chat renders as a proposal card. */
export function proposalFence(id: string): string {
  return '```carapaproposal\n' + `${JSON.stringify({ id })}\n` + '```';
}

export async function announceProposals(input: {
  project_id: string;
  objective_id: string | null;
  title: string;
  triggerSource: 'agent' | 'system';
  /** Rows without a conversation yet; it is assigned here. */
  rows: NewProposalRow[];
  content: string;
  /**
   * Post into this existing conversation (the user's current chat) instead of
   * creating one. The caller has verified it belongs to the project/objective.
   */
  conversation_id?: string;
}): Promise<{ conversation_id: string }> {
  const { project_id, objective_id, title, rows } = input;
  const existing = !!input.conversation_id;
  const conversationId = input.conversation_id
    ? input.conversation_id
    : (objective_id
        ? await createObjectiveConversation(project_id, objective_id, {
            triggerSource: input.triggerSource,
          })
        : await createConversation(project_id, {
            triggerSource: input.triggerSource,
          })
      ).id;
  for (const row of rows) row.conversation_id = conversationId;
  await insertProposals(rows);

  const saved = await saveChatMessage({
    group_folder: project_id,
    role: 'assistant',
    content: input.content,
    sender_name: null,
    source: 'web',
    created_at: new Date().toISOString(),
    conversation_id: conversationId,
    objective_id,
    // `pending` puts a new conversation under Now -> Needs you; the user is
    // already looking at an existing one.
    pending: !existing,
  });
  if (!existing) {
    await updateConversationTitleIfUntitled(conversationId, project_id, title);
    await updateConversationPreview(conversationId, title.slice(0, 120));
  }
  broadcast({
    type: 'chat_message',
    payload: { folder: project_id, message: saved },
  });
  broadcast({
    type: 'conversations_changed',
    payload: chatEventScope(project_id, objective_id),
  });
  return { conversation_id: conversationId };
}
