import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { initDatabase } from '../../db.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';
import { queueClientEvent, type WsEvent } from './ws-events.js';

const ADMIN = 'ws-pm-admin';
const OWNER = 'ws-pm-owner';
const FOREIGN_MAIN = 'main-ws-pm-owner';
const ADMIN_MAIN = 'main-ws-pm-admin';
const ORPHAN_MAIN = 'main-ws-pm-orphan';
const PROJECT = 'ws-pm-project';
const OWNED_PROJECT = 'ws-pm-owned';

const access = (isAdmin: boolean, explicit: string[] = []) => ({
  isAdmin,
  explicitProjects: new Set(explicit),
  implicitProjectConvIds: new Map<string, Set<string>>(),
  expires: Date.now() + 1000,
});

async function delivered(
  userId: string,
  userAccess: ReturnType<typeof access>,
  event: WsEvent,
): Promise<boolean> {
  const sent: string[] = [];
  const client = {
    readyState: 1,
    __userId: userId,
    send: (value: string) => sent.push(value),
  } as any;
  await queueClientEvent(client, event, async () => userAccess);
  return sent.length === 1;
}

describe('live events for a personal main', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    await loadState();
    const now = new Date().toISOString();
    for (const [folder, userId, isMain] of [
      [FOREIGN_MAIN, OWNER, true],
      [ADMIN_MAIN, ADMIN, true],
      [ORPHAN_MAIN, undefined, true],
      [PROJECT, undefined, false],
      [OWNED_PROJECT, OWNER, false],
    ] as const) {
      await registerGroup(`${folder}@kanban`, {
        name: folder,
        folder,
        jid: `${folder}@kanban`,
        trigger: '!',
        added_at: now,
        is_main: isMain,
        user_id: userId,
      });
    }
  });

  afterAll(async () => {
    for (const folder of [
      FOREIGN_MAIN,
      ADMIN_MAIN,
      ORPHAN_MAIN,
      PROJECT,
      OWNED_PROJECT,
    ]) {
      await unregisterGroup(`${folder}@kanban`);
    }
  });

  test('an admin does not receive chat, live-activity or conversation events of another user’s main', async () => {
    for (const type of [
      'chat_output',
      'live_activity',
      'conversations_changed',
    ] as const) {
      const event: WsEvent = {
        type,
        payload: { folder: FOREIGN_MAIN, conversation_id: 'c1' },
      };
      expect(await delivered(ADMIN, access(true), event)).toBe(false);
      expect(await delivered(OWNER, access(false, [FOREIGN_MAIN]), event)).toBe(
        true,
      );
    }
  });

  test('an admin still receives own-main, ordinary-project and global events', async () => {
    expect(
      await delivered(ADMIN, access(true), {
        type: 'chat_output',
        payload: { folder: ADMIN_MAIN },
      }),
    ).toBe(true);
    expect(
      await delivered(ADMIN, access(true), {
        type: 'chat_output',
        payload: { folder: PROJECT },
      }),
    ).toBe(true);
    expect(
      await delivered(ADMIN, access(true), {
        type: 'chat_output',
        payload: { folder: 'not-registered' },
      }),
    ).toBe(true);
    expect(
      await delivered(ADMIN, access(true), {
        type: 'server_restarted',
        payload: { started_at: 1 },
      }),
    ).toBe(true);
  });

  test('an admin receives events of a project owned by another user only through membership', async () => {
    const chat = (folder: string): WsEvent => ({
      type: 'chat_output',
      payload: { folder },
    });
    expect(await delivered(ADMIN, access(true), chat(OWNED_PROJECT))).toBe(
      false,
    );
    expect(
      await delivered(
        ADMIN,
        access(true, [OWNED_PROJECT]),
        chat(OWNED_PROJECT),
      ),
    ).toBe(true);
    // A stray membership row never opens another user's personal main.
    expect(
      await delivered(ADMIN, access(true, [FOREIGN_MAIN]), chat(FOREIGN_MAIN)),
    ).toBe(false);
    // The ownerless project keeps the admin bypass.
    expect(await delivered(ADMIN, access(true), chat(PROJECT))).toBe(true);
  });

  test('a main without an owner is foreign to every admin', async () => {
    expect(
      await delivered(ADMIN, access(true), {
        type: 'chat_output',
        payload: { project_id: ORPHAN_MAIN },
      }),
    ).toBe(false);
  });

  test('a payload with only a conversation id has no folder and is treated as global', async () => {
    // eventProjectFolder cannot resolve a folder from conversation_id alone;
    // every broadcast of a project's chat carries its folder or project_id.
    expect(
      await delivered(ADMIN, access(true), {
        type: 'chat_output',
        payload: { conversation_id: 'c1' },
      }),
    ).toBe(true);
  });

  test('user-scoped events still reach only the target user', async () => {
    const event: WsEvent = {
      type: 'notification_created',
      payload: { user_id: OWNER },
    };
    expect(await delivered(ADMIN, access(true), event)).toBe(false);
    expect(await delivered(OWNER, access(false), event)).toBe(true);
  });
});
