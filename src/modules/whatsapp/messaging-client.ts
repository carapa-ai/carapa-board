/**
 * Messaging client for carapa-wa-link.
 * Uses direct REST endpoints as primary transport (reliable with Bun).
 * Falls back to MCP SSE transport if REST is unavailable.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { extractText } from '../../lib/mcp-client.js';
import { logger } from '../../logger.js';

import type {
  RemoteMessage,
  RemoteChatInfo,
  MessagingConnectionStatus,
} from '../messaging/types.js';
import { sleep } from '../../lib/async.js';

export type {
  RemoteMessage,
  RemoteChatInfo,
  MessagingConnectionStatus,
} from '../messaging/types.js';

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export class MessagingClient {
  private client!: Client;
  private transport: StreamableHTTPClientTransport | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private prefix: string;
  private baseUrl: string; // REST base URL (e.g. http://localhost:3467)

  constructor(
    private url: string,
    private token?: string,
    provider = 'carapa-wa-link',
  ) {
    this.prefix = `${provider}_`;
    this.baseUrl = url.replace(/\/mcp$/, '');
    this.initClient();
  }

  private initClient(): void {
    this.client = new Client(
      { name: 'carapa-board-messaging', version: '1.0.0' },
      { capabilities: {} },
    );
  }

  // --- REST helpers ---

  private get restHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private async restGet<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.restHeaders,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`REST ${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  private async restPost<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.restHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`REST ${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  // --- MCP connection (fallback) ---

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      // If a previous transport existed, re-initialize the Client
      if (this.transport) {
        try {
          await this.transport.close();
        } catch {
          /* ignore */
        }
        this.transport = null;
        this.initClient();
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: { headers },
      });

      await this.client.connect(this.transport);
      this.connected = true;
      logger.info({ url: this.url }, 'Messaging MCP client connected');
    })().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.transport?.close();
    } catch {
      // Ignore close errors
    }
    this.connected = false;
  }

  private async reconnect(): Promise<void> {
    await this.disconnect();
    this.initClient();
    await this.connect();
    logger.info({ url: this.url }, 'Messaging MCP client reconnected');
  }

  async init(): Promise<void> {
    // Wait for REST API to become available (container may still be starting)
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await this.restGet('/health');
        logger.info({ baseUrl: this.baseUrl }, 'Messaging REST API reachable');
        return;
      } catch {
        if (attempt < 10) {
          await sleep(2000);
        }
      }
    }
    logger.warn(
      { baseUrl: this.baseUrl },
      'Messaging REST API not reachable after retries, continuing anyway',
    );
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!this.connected) {
      await this.connect();
    }

    const toolName = `${this.prefix}${name}`;
    try {
      const result = await this.client.callTool({
        name: toolName,
        arguments: args,
      });
      return extractText(result.content);
    } catch (err) {
      // Reconnect on session errors (e.g. server restart)
      logger.warn(
        { tool: toolName, error: String(err) },
        'Messaging tool call failed, reconnecting...',
      );
      await this.reconnect();
      const result = await this.client.callTool({
        name: toolName,
        arguments: args,
      });
      return extractText(result.content);
    }
  }

  // --- Public API (REST primary, MCP fallback) ---

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.restPost('/api/send', { chat_id: chatId, text });
      return;
    } catch (err) {
      logger.debug({ chatId, err }, 'REST send failed, trying MCP');
    }
    try {
      await this.callTool('send_message', { chat_id: chatId, text });
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send message');
    }
  }

  async setTyping(chatId: string, typing: boolean): Promise<void> {
    try {
      await this.restPost('/api/typing', { chat_id: chatId, typing });
      return;
    } catch {
      // silent fallthrough
    }
    try {
      await this.callTool('set_typing', {
        chat_id: chatId,
        typing: String(typing),
      });
    } catch (err) {
      logger.debug({ chatId, err }, 'Failed to set typing');
    }
  }

  async getNewMessages(
    chatIds: string[],
    since: string,
    excludePrefix?: string,
  ): Promise<{ messages: RemoteMessage[] }> {
    const args: Record<string, unknown> = { chat_ids: chatIds, since };
    if (excludePrefix) args.exclude_prefix = excludePrefix;
    try {
      return await this.restPost<{ messages: RemoteMessage[] }>(
        '/api/messages',
        args,
      );
    } catch (err) {
      logger.debug({ err }, 'REST getNewMessages failed, trying MCP');
    }
    try {
      const text = await this.callTool('get_new_messages', args);
      return parseJson(text, { messages: [] });
    } catch (err) {
      logger.error({ err }, 'Failed to poll messages');
      return { messages: [] };
    }
  }

  async getMessagesSince(
    chatId: string,
    since: string,
    excludePrefix?: string,
  ): Promise<RemoteMessage[]> {
    const args: Record<string, unknown> = { chat_id: chatId, since };
    if (excludePrefix) args.exclude_prefix = excludePrefix;
    try {
      const result = await this.restPost<{ messages: RemoteMessage[] }>(
        '/api/messages-since',
        args,
      );
      return result.messages;
    } catch (err) {
      logger.debug({ err }, 'REST getMessagesSince failed, trying MCP');
    }
    try {
      const text = await this.callTool('get_messages_since', args);
      return parseJson(text, { messages: [] }).messages;
    } catch (err) {
      logger.error({ err }, 'Failed to get messages since');
      return [];
    }
  }

  async listChats(): Promise<RemoteChatInfo[]> {
    try {
      const result = await this.restGet<{ chats: RemoteChatInfo[] }>(
        '/api/chats',
      );
      return result.chats;
    } catch (err) {
      logger.debug({ err }, 'REST listChats failed, trying MCP');
    }
    const text = await this.callTool('list_chats', {});
    return parseJson(text, { chats: [] }).chats;
  }

  async logout(): Promise<void> {
    await this.restPost('/api/logout', {});
  }

  async getStatus(): Promise<{
    status: MessagingConnectionStatus;
    qr?: string;
    jid?: string;
  }> {
    try {
      return await this.restGet<{
        status: MessagingConnectionStatus;
        qr?: string;
        jid?: string;
      }>('/status');
    } catch (err) {
      logger.debug({ err }, 'Failed to get messaging status via REST');
    }
    try {
      const text = await this.callTool('get_status', {});
      return parseJson(text, { status: 'disconnected' as const });
    } catch (err) {
      logger.debug({ err }, 'Failed to get messaging status via MCP');
      return { status: 'disconnected' };
    }
  }
}

// Singleton instance
let _client: MessagingClient | null = null;

export function getMessagingClient(): MessagingClient {
  if (!_client) {
    const url = process.env.MCP_WHATSAPP_URL || 'http://localhost:3467/mcp';
    const token = process.env.CARAPA_WA_LINK_TOKEN || undefined;
    const provider = process.env.MCP_MESSAGING_PROVIDER || 'carapa-wa-link';
    _client = new MessagingClient(url, token, provider);
  }
  return _client;
}
