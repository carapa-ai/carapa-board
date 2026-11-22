export interface ChatMessageAttachment {
  type: 'audio' | 'image' | 'video' | 'document';
  url: string;
  mimetype: string;
  filename?: string;
  caption?: string;
  path?: string; // local absolute path on disk
  durationSeconds?: number;
}

interface ChatDeepLink {
  label: string;
  href: string;
  variant?: 'default' | 'outline' | 'destructive';
}

export interface ChatMessage {
  id: string;
  group_folder: string;
  role: 'user' | 'assistant';
  content: string;
  sender_name?: string | null; // WhatsApp sender display name
  senderUserId?: string | null;
  senderAvatarUrl?: string | null;
  source: 'whatsapp' | 'web' | 'http' | 'android' | 'ios' | 'public' | 'agent';
  /** Groups an anonymous public prompt with the persona turns it produced. */
  publicInteractionId?: string | null;
  created_at: string;
  conversation_id?: string | null;
  attachments?: ChatMessageAttachment[] | null;
  deepLinks?: ChatDeepLink[] | null;
  /** Stable browser queue IDs acknowledged by this canonical batched turn. */
  clientSubmissionIds?: string[];
  objective_id?: string | null;
  telemetry?: Record<string, unknown> | null;
  /** Persona expression selected for this message only. */
  emote?: string | null;
  /** Sanitized spoken variant with only validated Supertonic expression tags. */
  speechText?: string | null;
  /** Structured terminal outcome for an assistant turn. */
  failed?: boolean;
  /** The assistant produced an implementation plan awaiting user approval. */
  pending?: boolean;
  /** Internal agent-only prompt; API projections must not expose it. */
  executionContent?: string;
}

/** Materialized execution inputs admitted while a Direct-LLM turn is in flight. */
export interface DirectChatFollowupMetadata {
  conversationId: string;
  objectiveId?: string;
  executionContent: string;
  agentCmd: string;
  runtimeSelection?: {
    harnessId: string;
    modelId: string;
    reasoning?: string;
  };
  chatMode?: string | null;
  /** Explicit run sender; `null` is kept and loads no human preferences. Omit to use the message sender. */
  senderUserId?: string | null;
  /** Restricts lifecycle pushes; an empty list sends none. Omit for the default recipients. */
  lifecycleRecipientUserIds?: string[];
  triggeredByUserId?: string | null;
  triggerSource?: 'user' | 'agent' | 'schedule' | 'public' | 'system';
  delivery?:
    | {
        kind: 'whatsapp';
        chatJid: string;
        triggerTimestamp: string;
      }
    | {
        kind: 'public-persona';
        interactionId: string;
        visitorName: string;
      };
}

export interface DirectChatFollowupClaim {
  runId: string;
  groupFolder: string;
  conversationId: string;
  message: ChatMessage;
  metadata: DirectChatFollowupMetadata;
}

export type ConversationStatus =
  | 'idle'
  | 'working'
  | 'finished'
  | 'failed'
  | 'pending';
