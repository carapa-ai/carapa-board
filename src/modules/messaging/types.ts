/**
 * Messaging provider abstraction.
 *
 * WhatsApp is the first implementation. Future providers (Telegram, Slack)
 * implement the same interface and register via the provider registry.
 */

interface MediaAttachment {
  type: 'audio' | 'image' | 'document';
  /** URL supplied by the messaging provider. */
  url: string;
  mimetype: string;
  filename?: string;
  caption?: string;
}

export interface RemoteMessage {
  id: string;
  chat_id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  attachments?: MediaAttachment[];
}

export interface RemoteChatInfo {
  chat_id: string;
  name: string;
  last_activity: string;
}

export type MessagingConnectionStatus =
  | 'disconnected'
  | 'qr_pending'
  | 'connected';

export interface MessagingProvider {
  /** Provider name (e.g. 'whatsapp', 'telegram') */
  name: string;

  /** Initialize connection to the messaging service */
  init(): Promise<void>;

  /** Send a text message to a chat/group JID */
  sendMessage(jid: string, text: string): Promise<void>;

  /** Set typing indicator */
  setTyping(jid: string, typing: boolean): Promise<void>;

  /** Get messages since a timestamp for the given JIDs */
  getNewMessages(
    jids: string[],
    since: string,
    botName: string,
  ): Promise<{ messages: RemoteMessage[] }>;

  /** Get messages since a timestamp for a specific chat */
  getMessagesSince(
    chatId: string,
    since: string,
    botName: string,
  ): Promise<RemoteMessage[]>;

  /** Get connection status */
  getStatus(): Promise<{
    status: MessagingConnectionStatus;
    qr?: string;
    jid?: string;
  }>;

  /** List available groups/chats */
  listChats(): Promise<RemoteChatInfo[]>;

  /** Disconnect/logout */
  logout(): Promise<void>;
}
