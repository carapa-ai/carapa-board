import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createNotificationPayload,
  createTask,
  createUser,
  getUnreadPayloads,
  initDatabase,
  registerDeviceKey,
} from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { projects } from '../db/schema.js';
import { appendChatTranscriptEntry, getGroupDir } from '../group-dir.js';
import { createConversation } from '../modules/chat/db-chats.js';
import {
  updateUserAdminStanding,
  upsertProjectMember,
} from '../modules/knowledge/db-kb.js';
import { insertAiUserRow } from '../modules/ai-users/db-ai-users.js';
import { TTS_LANG } from '../modules/tts/config.js';
import {
  resetJevMock,
  setJevMockHandler,
} from '../test-utils/jev-mock-server.js';
import { awaitFormResponse } from '../modules/push/pending-responses.js';
import {
  deleteTaskTranscript,
  readTaskMessagesAsync,
} from '../modules/transcripts/transcript-store.js';
import pushRouter, {
  handleAckPayloadSession,
  handleAckUnreadNotifications,
  handleNativeSpeechText,
} from './push.js';

describe('bulk notification acknowledgement route', () => {
  let userId: string;

  beforeAll(async () => {
    await initDatabase(':memory:');
    userId = (await createUser(`push-route-${Date.now()}`, 'password')).id;
  });

  test('cancels every pending JSON form and only acknowledges current-user unread payloads', async () => {
    const form = await createNotificationPayload({
      user_id: userId,
      kind: 'json_form',
      summary: 'Approval needed',
      content: JSON.stringify({ type: 'object', properties: {} }),
      respond_to: { kind: 'chat', id: 'conversation-bulk' },
    });
    const text = await createNotificationPayload({
      user_id: userId,
      kind: 'text',
      summary: 'Message',
      content: 'hello',
    });
    const otherUser = await createUser(
      `push-route-other-${Date.now()}`,
      'password',
    );
    const other = await createNotificationPayload({
      user_id: otherUser.id,
      kind: 'text',
      summary: 'Private message',
      content: 'keep this',
    });
    const waiting = awaitFormResponse(form.id, 1_000);
    let body: unknown;
    const res = {
      status: (code: number) => ({
        json: (value: unknown) => {
          body = { code, value };
          return body;
        },
      }),
      json: (value: unknown) => {
        body = value;
        return value;
      },
    };

    await handleAckUnreadNotifications({ authUser: { id: userId } }, res);

    expect(await waiting).toEqual({ status: 'cancelled' });
    expect(body).toEqual({
      ok: true,
      payloads: [
        { id: form.id, kind: 'json_form' },
        { id: text.id, kind: 'text' },
      ],
    });
    expect(await getUnreadPayloads(userId)).toEqual([]);
    expect(await getUnreadPayloads(otherUser.id)).toEqual([
      expect.objectContaining({ id: other.id }),
    ]);
  });

  test('is idempotent when no unread payloads remain', async () => {
    let body: unknown;
    await handleAckUnreadNotifications(
      { authUser: { id: userId } },
      { json: (value: unknown) => (body = value) },
    );
    expect(body).toEqual({ ok: true, payloads: [] });
  });
});

describe('form_response acknowledgement', () => {
  let userId: string;
  const taskIds: Array<{ projectId: string; taskId: string }> = [];
  const projectId = `push-form-ack-${Date.now()}`;
  const schema = JSON.stringify({
    type: 'object',
    properties: { answer: { type: 'string' } },
  });

  beforeAll(async () => {
    await initDatabase(':memory:');
    userId = (await createUser(`push-form-${Date.now()}`, 'password')).id;
    await drizzleDbRef.current.insert(projects).values({
      id: projectId,
      jid: `${projectId}@test`,
      name: projectId,
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    for (const { projectId: p, taskId } of taskIds) {
      await deleteTaskTranscript(p, taskId);
    }
  });

  async function ack(payloadId: string, answer: string) {
    let result: { code: number; body: unknown } = { code: 200, body: null };
    const res: any = {
      status: (code: number) => {
        result.code = code;
        return res;
      },
      json: (body: unknown) => {
        result.body = body;
        return res;
      },
    };
    await handleAckPayloadSession(
      {
        authUser: { id: userId },
        params: { id: payloadId },
        body: { form_response: { answer } },
      },
      res,
      () => {},
    );
    return result;
  }

  test('second form_response returns 409 and appends no second task message', async () => {
    const task = await createTask({
      project_id: projectId,
      title: 'Needs an answer',
      description: '',
      status: 'backlog',
      priority: 0,
    });
    taskIds.push({ projectId, taskId: task.id });
    const form = await createNotificationPayload({
      user_id: userId,
      kind: 'json_form',
      summary: 'Question',
      content: schema,
      respond_to: { kind: 'task', id: task.id },
    });

    expect((await ack(form.id, 'first')).code).toBe(200);
    const second = await ack(form.id, 'second');

    expect(second).toEqual({ code: 409, body: { error: 'already_answered' } });
    // Routing of the first answer is fire-and-forget; wait for its message.
    let messages = await readTaskMessagesAsync(projectId, task.id);
    for (let i = 0; i < 200 && messages.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      messages = await readTaskMessagesAsync(projectId, task.id);
    }
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('first');
  });

  test('form_response after expires_at returns 410', async () => {
    const form = await createNotificationPayload({
      user_id: userId,
      kind: 'json_form',
      summary: 'Late',
      content: schema,
      ttl_ms: -1_000,
    });

    expect(await ack(form.id, 'late')).toEqual({
      code: 410,
      body: { error: 'expired' },
    });
  });

  test('first form_response still resolves a wait=true awaiter', async () => {
    const form = await createNotificationPayload({
      user_id: userId,
      kind: 'json_form',
      summary: 'Awaited',
      content: schema,
    });
    const waiting = awaitFormResponse(form.id, 5_000);

    expect((await ack(form.id, 'yes')).code).toBe(200);

    expect(await waiting).toEqual({
      status: 'submitted',
      values: { answer: 'yes' },
    });
  });
});

describe('native speech text route', () => {
  const projectId = `push-speech-text-${process.pid}`;
  const memberDevice = `${projectId}-member`;
  const outsiderDevice = `${projectId}-outsider`;
  let conversationId: string;
  let personaConversationId: string;
  let archivedConversationId: string;

  beforeAll(async () => {
    await initDatabase(':memory:');
    const member = await createUser(`${projectId}-member`, 'password');
    const outsider = await createUser(`${projectId}-outsider`, 'password');
    await registerDeviceKey(memberDevice, member.id, 'key', 'test', true);
    await registerDeviceKey(outsiderDevice, outsider.id, 'key', 'test', true);
    await drizzleDbRef.current.insert(projects).values({
      id: projectId,
      jid: `${projectId}@test`,
      name: projectId,
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
    });
    await upsertProjectMember(member.id, projectId, 'owner');
    conversationId = (
      await createConversation(projectId, { triggerSource: 'system' })
    ).id;
    appendChatTranscriptEntry(projectId, conversationId, {
      id: 'persona-reply',
      type: 'message',
      role: 'assistant',
      content: 'Hello there. That is great.',
      senderUserId: 'ai:reviewer',
      speechText: 'Hello there. <laugh> That is great.',
      created_at: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    await insertAiUserRow({
      id: `${projectId}-ro`,
      name: 'Romanian persona',
      identity: 'Romanian persona',
      presetId: 'fast',
      promptPath: `ai-users/${projectId}-ro/prompt.md`,
      voiceLang: 'ro',
      turn: 'after',
      tools: [],
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    personaConversationId = (
      await createConversation(projectId, { triggerSource: 'system' })
    ).id;
    appendChatTranscriptEntry(projectId, personaConversationId, {
      id: 'romanian-persona-english-reply',
      type: 'message',
      role: 'assistant',
      content: 'The build is green now.',
      senderUserId: `ai:${projectId}-ro`,
      created_at: now,
    });
  });

  beforeAll(async () => {
    // Shape written by run (v1) archiving: the message row keeps its archive
    // id; the attribution row names the provider id that Live items use.
    archivedConversationId = (
      await createConversation(projectId, { triggerSource: 'system' })
    ).id;
    appendChatTranscriptEntry(projectId, archivedConversationId, {
      id: 'run-1-v1-23-msg_live',
      type: 'message',
      role: 'assistant',
      content: 'Archived reply.',
      agent_name: `ai-main:${projectId}-ro`,
    });
    appendChatTranscriptEntry(projectId, archivedConversationId, {
      id: 'msg_live',
      type: 'ai_user_attribution',
      role: 'assistant',
      content: '',
      agent_name: `ai-main:${projectId}-ro`,
      senderUserId: `ai:${projectId}-ro`,
      speechText: 'Archived reply.',
    });
  });

  afterAll(() => {
    resetJevMock();
    fs.rmSync(getGroupDir(projectId), { recursive: true, force: true });
  });

  async function get(
    device: string | null,
    messageId: string,
    query: Record<string, string> = { manual: '1' },
    cid = conversationId,
  ) {
    const result: { code: number; body: any } = { code: 200, body: null };
    const res: any = {
      status: (code: number) => {
        result.code = code;
        return res;
      },
      json: (body: unknown) => {
        result.body = body;
        return res;
      },
      setHeader: () => res,
    };
    await handleNativeSpeechText(
      {
        headers: device ? { 'x-carapa-device-id': device } : {},
        params: { cid, messageId },
        query,
      },
      res,
    );
    return result;
  }

  test('returns the speech-ready text without expression tags', async () => {
    expect(await get(memberDevice, 'persona-reply')).toEqual({
      code: 200,
      body: { text: 'Hello there. That is great.', language: TTS_LANG },
    });
  });

  test('requires a known device, conversation access and a live session', async () => {
    expect((await get(null, 'persona-reply')).code).toBe(400);
    expect((await get(`${projectId}-unknown`, 'persona-reply')).code).toBe(401);
    expect((await get(outsiderDevice, 'persona-reply')).code).toBe(404);
    expect((await get(memberDevice, 'persona-reply', {})).code).toBe(409);
  });

  test("speaks a reply in its own language, else the persona's", async () => {
    const language = async () =>
      (
        await get(
          memberDevice,
          'romanian-persona-english-reply',
          { manual: '1' },
          personaConversationId,
        )
      ).body.language;
    // The mock's default answer is the first label: the persona's language.
    expect(await language()).toBe('ro');
    setJevMockHandler(() => ({
      answers: {
        language: {
          type: 'choice',
          choice: 'en',
          probabilities: { ro: 0.01, en: 0.99 },
        },
      },
    }));
    expect(await language()).toBe('en');
    // Unsure answers lean to the first label (the persona's language): the
    // runner-up is used when Jev confirms it on its own.
    setJevMockHandler(() => ({
      answers: {
        language: {
          type: 'choice',
          choice: 'ro',
          probabilities: { ro: 0.5, en: 0.45 },
          noul: 0.98,
        },
      },
    }));
    expect(await language()).toBe('en');
    resetJevMock();
  });

  test('resolves a run-archived reply by its provider message id', async () => {
    const result = await get(
      memberDevice,
      'msg_live',
      { manual: '1' },
      archivedConversationId,
    );
    expect(result).toEqual({
      code: 200,
      body: { text: 'Archived reply.', language: 'ro' },
    });
  });

  test('returns 404 for an unknown message', async () => {
    expect((await get(memberDevice, 'missing-reply')).code).toBe(404);
  });
});

describe('signed push token route', () => {
  const tag = `push-token-${process.pid}`;
  let server: Server;
  let baseUrl: string;

  const register = (deviceId: string) =>
    fetch(`${baseUrl}/devices/push-token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-carapa-device-id': deviceId,
      },
      body: JSON.stringify({ token: 't', platform: 'web' }),
    });

  beforeAll(async () => {
    await initDatabase(':memory:');
    const disabled = await createUser(`${tag}-disabled`, 'password');
    const enabled = await createUser(`${tag}-enabled`, 'password');
    await registerDeviceKey(
      `${tag}-disabled`,
      disabled.id,
      'key',
      'test',
      true,
    );
    await registerDeviceKey(`${tag}-enabled`, enabled.id, 'key', 'test', true);
    await updateUserAdminStanding(disabled.id, { disabled: true });
    const app = express();
    app.use(express.json());
    app.use(pushRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("refuses a disabled user's device and accepts an enabled one", async () => {
    expect((await register(`${tag}-disabled`)).status).toBe(401);
    expect((await register(`${tag}-enabled`)).status).toBe(200);
  });
});
