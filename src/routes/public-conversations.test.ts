import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import * as db from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import * as publicPrompting from '../modules/chat/public-prompting.js';
import publicConversationsRouter, {
  projectPublicMessages,
  sanitizePublicAssistantContent,
} from './public-conversations.js';

describe('public conversation projection', () => {
  test('removes tool headers, arguments, and quoted tool results', () => {
    const content = [
      'Public answer before.',
      '',
      '<!-- carapa-tool:request -->',
      '> **Using tool: read_file**',
      '',
      '```json',
      '{"path":"/workspace/private.txt"}',
      '```',
      '',
      '> secret tool output',
      '> another private line',
      '',
      'Public answer after.',
    ].join('\n');
    const projected = sanitizePublicAssistantContent(content);
    expect(projected).toContain('Public answer before.');
    expect(projected).toContain('Public answer after.');
    expect(projected).not.toContain('/workspace/private.txt');
    expect(projected).not.toContain('secret tool output');
    expect(projected).not.toContain('Using tool');
    expect(projected).not.toContain('carapa-tool');
  });

  test('omits LLM error turns from public conversations', () => {
    const messages = projectPublicMessages(
      [
        {
          id: 'failed-persona-turn',
          role: 'assistant',
          content: '⚠️ **LLM Error**: 400 status code (no body)',
          sender_name: 'Maya',
          agent_name: 'ai-main:maya-private-id',
        },
        {
          id: 'successful-persona-turn',
          role: 'assistant',
          content: 'Here is the public answer.',
          sender_name: 'Maya',
          agent_name: 'ai-main:maya-private-id',
        },
      ],
      'public-token',
    );

    expect(messages.map((message) => message.id)).toEqual([
      'successful-persona-turn',
    ]);
  });

  test('projects persona avatars through a token- and message-scoped URL', () => {
    const [message, nextMessage, baseAvatarMessage] = projectPublicMessages(
      [
        {
          id: 'persona-message-1',
          role: 'assistant',
          content: 'Hello from Maya.',
          sender_name: 'Maya',
          agent_name: 'ai-main:maya-private-id',
          emote: 'delighted',
        },
        {
          id: 'persona-message-2',
          role: 'assistant',
          content: 'A second reply.',
          sender_name: 'Maya',
          senderUserId: 'ai:maya-private-id',
          emote: 'delighted',
        },
        {
          id: 'persona-message-3',
          role: 'assistant',
          content: 'A neutral reply.',
          sender_name: 'Maya',
          senderUserId: 'ai:maya-private-id',
        },
      ],
      'public-token',
    );

    expect(message).toMatchObject({
      displayName: 'Maya',
      isPersona: true,
      speechAvailable: true,
      avatarUrl:
        '/api/public/conversations/public-token/messages/persona-message-1/avatar',
    });
    expect(message.avatarUrl).not.toContain('maya-private-id');
    expect(nextMessage.avatarUrl).toBe(message.avatarUrl);
    expect(baseAvatarMessage.avatarUrl).not.toBe(message.avatarUrl);
  });

  test('scrubs secrets from historical content and attachment labels', () => {
    const group = {
      folder: 'public-projection-test',
      settings: { brainAuthToken: 'private-brain-token-value' },
    } as any;
    const [message] = projectPublicMessages(
      [
        {
          id: 'secret-message',
          role: 'assistant',
          content: 'Token: private-brain-token-value',
          attachments: [
            {
              type: 'document',
              filename: 'private-brain-token-value.txt',
              caption: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
            },
          ],
        },
      ],
      'public-token',
      group,
    );
    expect(message.content).not.toContain('private-brain-token-value');
    expect(message.attachments[0].filename).not.toContain(
      'private-brain-token-value',
    );
    expect(message.attachments[0].caption).not.toContain(
      'abcdefghijklmnopqrstuvwxyz',
    );
  });
});

describe('POST /conversations/:token/prompts lock release', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let token = '';
  let cookie = '';
  let csrf = '';

  beforeAll(async () => {
    await db.initDatabase(':memory:');
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    const now = new Date().toISOString();
    await client.exec(
      `INSERT INTO users (id, username, password_hash, role, created_at)
       VALUES ('public-lock-owner', 'public-lock-owner', 'test', 'user', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.exec(
      `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main, user_id)
       VALUES ('public-lock', 'public-lock@web', 'public-lock', 'public-lock', '!', '${now}', 0, 'public-lock-owner')
       ON CONFLICT (id) DO NOTHING`,
    );
    const conversation = await db.createConversation('public-lock');
    const share = await db.createOrEnableConversationPublicShare(
      conversation.id,
      null,
    );
    await db.setConversationPublicVisitorPrompts(conversation.id, true);
    token = share.publicToken;

    const app = express();
    app.use(express.json());
    app.use('/api/public', publicConversationsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    spyOn(publicPrompting, 'getPublicPromptingEligibility').mockResolvedValue({
      available: true,
      reason: null,
      personaIds: [],
    });
    const session = await fetch(
      `${baseUrl}/api/public/conversations/${token}/visitor-session`,
    );
    cookie = (session.headers.get('set-cookie') || '').split(';')[0];
    csrf = ((await session.json()) as { csrfToken: string }).csrfToken;
  });

  afterEach(() => {
    mock.restore();
  });

  afterAll(async () => {
    mock.restore();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  function postPrompt() {
    return fetch(`${baseUrl}/api/public/conversations/${token}/prompts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: baseUrl,
        'x-public-csrf': csrf,
      },
      body: JSON.stringify({ prompt: 'hello' }),
    });
  }

  test('releases the process-local lock when an admission DB call rejects', async () => {
    spyOn(publicPrompting, 'getPublicPromptingEligibility').mockResolvedValue({
      available: true,
      reason: null,
      personaIds: [],
    });
    const count = spyOn(
      db,
      'countPublicPromptRequestsSince',
    ).mockRejectedValueOnce(new Error('db down'));
    const failed = await postPrompt();
    expect(failed.ok).toBe(false);
    expect(count).toHaveBeenCalled();

    const retry = await postPrompt();
    const body = (await retry.json()) as { error?: string };
    expect(body.error).not.toBe('Another visitor prompt is already running');
  });
});
