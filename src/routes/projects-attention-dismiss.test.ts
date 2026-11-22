/**
 * POST /api/projects/attention/dismiss-all — checking off a whole Now group.
 *
 * Checking off the Replies group must also read the dismissed conversations,
 * so their unread dot leaves the chat lists. That includes the rows the
 * client synthesizes from a text notification, which are not attention items.
 * Rows the client protects and rows with newer activity stay untouched, and
 * a failed read never fails the dismissal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  createConversation,
  createNotificationPayload,
  createUser,
  getConversation,
  initDatabase,
  saveChatMessage,
  upsertProjectMember,
} from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import {
  loadState,
  registerGroup,
  registeredGroups,
  unregisterGroup,
} from '../state-manager.js';
import type { RegisteredGroup } from '../types.js';
import projectsRouter from './projects.js';

const folder = `attention-dismiss-${process.pid}`;
const jid = `${folder}@web`;

let server: Server;
let baseUrl: string;
let userId: string;

function group(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '!',
    added_at: new Date().toISOString(),
    user_id: userId,
    is_main: false,
    ...overrides,
  };
}

/** A conversation with one assistant reply, so it lands in the Now list. */
async function replyConversation(title: string) {
  const conversation = await createConversation(folder);
  await saveChatMessage({
    group_folder: folder,
    role: 'assistant',
    content: title,
    source: 'web',
    created_at: new Date().toISOString(),
    conversation_id: conversation.id,
  });
  return conversation.id;
}

/**
 * A conversation the user answered last. It is not an attention item (the
 * attention query skips conversations whose last assistant message predates
 * the last user message), but a text notification deep-linking to it makes
 * the client show it as a Reply row.
 */
async function answeredConversation(projectFolder: string) {
  const conversation = await createConversation(projectFolder);
  await saveChatMessage({
    group_folder: projectFolder,
    role: 'assistant',
    content: 'Agent reply',
    source: 'web',
    created_at: '2026-10-20T10:00:00.000Z',
    conversation_id: conversation.id,
  });
  await saveChatMessage({
    group_folder: projectFolder,
    role: 'user',
    content: 'My follow-up',
    source: 'web',
    created_at: '2026-10-20T11:00:00.000Z',
    conversation_id: conversation.id,
  });
  return conversation.id;
}

async function readAt(conversationId: string) {
  return (await getConversation(conversationId))?.read_at ?? null;
}

async function dismissAll(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/projects/attention/dismiss-all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Run SQL on the shared PGlite handle behind the Drizzle client. */
async function exec(sql: string) {
  const handle = drizzleDbRef.current as any;
  const client =
    handle?.$client ?? handle?._?.client ?? handle?.session?.client;
  await client.exec(sql);
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  const user = await createUser(`attention-dismiss-${process.pid}`, 'password');
  userId = user.id;
  await registerGroup(jid, group());

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Other route suites reload the shared registry in the changed-files
    // runner. Restore this request's owned project at the HTTP boundary.
    registeredGroups[jid] ??= group();
    Object.assign(req, { authUser: { id: userId, role: 'user' } });
    next();
  });
  app.use(projectsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await unregisterGroup(jid);
});

describe('POST /projects/attention/dismiss-all', () => {
  test('reads the dismissed replies so their unread dot goes away', async () => {
    const first = await replyConversation('First unread reply');
    const second = await replyConversation('Second unread reply');
    expect(await readAt(first)).toBeNull();

    const result = await dismissAll({
      group: 'unread',
      asOf: new Date(Date.now() + 60_000).toISOString(),
      exclude: [],
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, dismissed: 2 });
    for (const conversationId of [first, second]) {
      const row = await getConversation(conversationId);
      expect(row?.read_at).toBeTruthy();
      expect(Date.parse(row!.read_at!)).toBeGreaterThanOrEqual(
        Date.parse(row!.last_assistant_at!),
      );
    }
  });

  test('keeps a protected reply unread and undismissed', async () => {
    const protectedReply = await replyConversation('Protected reply');
    const otherReply = await replyConversation('Other reply');

    const result = await dismissAll({
      group: 'unread',
      asOf: new Date(Date.now() + 60_000).toISOString(),
      exclude: [{ kind: 'conversation', id: protectedReply }],
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, dismissed: 1 });
    expect(await readAt(protectedReply)).toBeNull();
    expect(await readAt(otherReply)).toBeTruthy();
  });

  test('reads a reply that only a notification points at', async () => {
    // The client shows this conversation as a Reply row because a text
    // notification deep-links to it, but it is not an attention item.
    const conversation = await answeredConversation(folder);
    await createNotificationPayload({
      user_id: userId,
      kind: 'text',
      summary: 'Agent needs a decision',
      content: 'Please choose',
      action_url: `/chat/${folder}?conversationId=${conversation}`,
    });
    expect(await readAt(conversation)).toBeNull();

    const result = await dismissAll({
      group: 'unread',
      asOf: new Date(Date.now() + 60_000).toISOString(),
      exclude: [],
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
    expect(await readAt(conversation)).toBeTruthy();
  });

  test('keeps a notification reply with newer activity unread', async () => {
    // The conversation's own activity times the row, not the notification
    // that brought it to the list. A reply that arrived after the list was
    // built stays unread, exactly like a server-derived row.
    const conversation = await answeredConversation(folder);
    await createNotificationPayload({
      user_id: userId,
      kind: 'text',
      summary: 'Agent needs a decision',
      content: 'Please choose',
      action_url: `/chat/${folder}?conversationId=${conversation}`,
    });

    // The list the user saw is built before the next reply arrives.
    const asOf = new Date().toISOString();
    await saveChatMessage({
      group_folder: folder,
      role: 'assistant',
      content: 'Agent reply after the list was built',
      source: 'web',
      created_at: new Date(Date.now() + 1_000).toISOString(),
      conversation_id: conversation,
    });

    const result = await dismissAll({
      group: 'unread',
      asOf,
      exclude: [],
    });

    expect(result.status).toBe(200);
    expect(await readAt(conversation)).toBeNull();
  });

  test('keeps a notification reply in another group unread', async () => {
    // The conversation has a failed reply, so it is a "Needs you" row. The
    // notification reuses that server row, so the Replies dismissal must not
    // read it and clear its failure badge.
    const conversation = await createConversation(folder);
    await saveChatMessage({
      group_folder: folder,
      role: 'assistant',
      content: 'Failed reply',
      source: 'web',
      created_at: new Date().toISOString(),
      failed: true,
      conversation_id: conversation.id,
    });
    await createNotificationPayload({
      user_id: userId,
      kind: 'text',
      summary: 'Agent needs a decision',
      content: 'Please choose',
      action_url: `/chat/${folder}?conversationId=${conversation.id}`,
    });

    const result = await dismissAll({
      group: 'unread',
      asOf: new Date(Date.now() + 60_000).toISOString(),
      exclude: [],
    });

    expect(result.status).toBe(200);
    expect(await readAt(conversation.id)).toBeNull();
  });

  test('keeps a protected notification reply unread', async () => {
    const conversation = await answeredConversation(folder);
    await createNotificationPayload({
      user_id: userId,
      kind: 'text',
      summary: 'Agent needs a decision',
      content: 'Please choose',
      action_url: `/chat/${folder}?conversationId=${conversation}`,
    });

    const result = await dismissAll({
      group: 'unread',
      asOf: new Date(Date.now() + 60_000).toISOString(),
      exclude: [{ kind: 'conversation', id: conversation }],
    });

    expect(result.status).toBe(200);
    expect(await readAt(conversation)).toBeNull();
  });

  test('does not read a conversation outside the caller view', async () => {
    const foreignFolder = `attention-dismiss-foreign-${process.pid}`;
    const foreignJid = `${foreignFolder}@web`;
    const foreignOwner = await createUser(
      `attention-dismiss-foreign-${process.pid}`,
      'password',
    );
    await registerGroup(foreignJid, {
      name: foreignFolder,
      folder: foreignFolder,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: foreignOwner.id,
      is_main: false,
    });
    try {
      const foreignConversation = await answeredConversation(foreignFolder);
      // A notification link alone must not grant read access to a project
      // the caller is not a member of.
      await createNotificationPayload({
        user_id: userId,
        kind: 'text',
        summary: 'Cross-project link',
        content: 'Please choose',
        action_url: `/chat/${foreignFolder}?conversationId=${foreignConversation}`,
      });

      const result = await dismissAll({
        group: 'unread',
        asOf: new Date(Date.now() + 60_000).toISOString(),
        exclude: [],
      });

      expect(result.status).toBe(200);
      expect(await readAt(foreignConversation)).toBeNull();
    } finally {
      await unregisterGroup(foreignJid);
    }
  });

  test('reads the caller reply even when other projects fill the scan limit', async () => {
    const foreignFolder = `attention-dismiss-busy-${process.pid}`;
    const foreignJid = `${foreignFolder}@web`;
    const foreignOwner = await createUser(
      `attention-dismiss-busy-${process.pid}`,
      'password',
    );
    await registerGroup(foreignJid, {
      name: foreignFolder,
      folder: foreignFolder,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: foreignOwner.id,
      is_main: false,
    });
    try {
      const mine = await replyConversation('Reply under a busy board');
      // More newer replies than the scan limit, none visible to the caller.
      const newer = new Date(Date.now() + 3_600_000).toISOString();
      await exec(
        `INSERT INTO conversations (id, group_folder, created_at, last_assistant_at)
           SELECT 'busy-${process.pid}-' || n, '${foreignFolder}', '${newer}', '${newer}'
           FROM generate_series(1, 520) AS n;`,
      );

      const result = await dismissAll({
        group: 'unread',
        asOf: new Date(Date.now() + 7_200_000).toISOString(),
        exclude: [],
      });

      expect(result.status).toBe(200);
      expect(await readAt(mine)).toBeTruthy();
    } finally {
      await exec(
        `DELETE FROM conversations WHERE group_folder = '${foreignFolder}';`,
      );
      await unregisterGroup(foreignJid);
    }
  });

  test('leaves a reply with activity newer than the list untouched', async () => {
    const conversation = await createConversation(folder);
    const newer = new Date(Date.now() + 60_000).toISOString();
    await saveChatMessage({
      group_folder: folder,
      role: 'assistant',
      content: 'Reply from after the list was built',
      source: 'web',
      created_at: newer,
      conversation_id: conversation.id,
    });

    const result = await dismissAll({
      group: 'unread',
      asOf: new Date().toISOString(),
      exclude: [],
    });

    expect(result.status).toBe(200);
    expect(await readAt(conversation.id)).toBeNull();
  });

  test('does not read conversations when another group is checked off', async () => {
    const conversation = await createConversation(folder);
    await saveChatMessage({
      group_folder: folder,
      role: 'assistant',
      content: 'Reply waiting in the replies group',
      source: 'web',
      created_at: new Date().toISOString(),
      conversation_id: conversation.id,
    });

    const result = await dismissAll({
      group: 'completed',
      asOf: new Date(Date.now() + 60_000).toISOString(),
      exclude: [],
    });

    expect(result.status).toBe(200);
    expect(await readAt(conversation.id)).toBeNull();
  });

  test('a failed read does not fail the dismissal or the other reads', async () => {
    const failing = await replyConversation('Reply whose read fails');
    const healthy = await replyConversation('Reply whose read succeeds');
    // A CHECK constraint rejects the read of one conversation. Unlike a
    // trigger it still fires while the shared test session runs with
    // `session_replication_role = 'replica'`.
    await exec(
      `ALTER TABLE conversations ADD CONSTRAINT attention_dismiss_read_boom
         CHECK (id <> '${failing}' OR read_at IS NULL);`,
    );

    try {
      const result = await dismissAll({
        group: 'unread',
        asOf: new Date(Date.now() + 60_000).toISOString(),
        exclude: [],
      });

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true });
      expect(await readAt(failing)).toBeNull();
      expect(await readAt(healthy)).toBeTruthy();
    } finally {
      await exec(
        `ALTER TABLE conversations DROP CONSTRAINT IF EXISTS attention_dismiss_read_boom;`,
      );
    }
  });
});
