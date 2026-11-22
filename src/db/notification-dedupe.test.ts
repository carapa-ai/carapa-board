/**
 * Dedupe contract for createNotificationPayload, relied on by the
 * PushNotification redirect (src/modules/tools/push-tools.ts firePushNotification).
 *
 * The adopt/recovery path re-streams output.jsonl from byte 0, so the same
 * built-in PushNotification tool_use can be parsed more than once. The unique
 * (user_id, source_tool_use_id) index makes the second insert a no-op and
 * returns created:false so the caller skips re-sending the FCM push. notify_user
 * passes no source_tool_use_id (NULL), and NULLs must stay distinct so those
 * rows never collide.
 */

import { describe, test, expect, beforeAll, spyOn } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import {
  ackDuplicateUnreadMemoryReviewPayloads,
  ackSupersededNotificationPayloads,
  ackUnreadPayloads,
  createNotificationPayload,
  getUnreadPayloads,
  initDatabase,
} from '../db.js';
import { drizzleDbRef } from './drizzle-client.js';

const base = {
  kind: 'text' as const,
  summary: 'hi',
  content: 'hello from the agent',
};

function client(): PGlite {
  const handle = drizzleDbRef.current as unknown as
    | {
        $client?: PGlite;
        _?: { client?: PGlite };
        session?: { client?: PGlite };
      }
    | undefined;
  return (handle?.$client ??
    handle?._?.client ??
    handle?.session?.client) as PGlite;
}

beforeAll(async () => {
  await initDatabase(':memory:');
  // This suite exercises the unique-index dedupe, not the user FK — suppress FK
  // enforcement (the suite default) so we can use synthetic user_ids.
  await client().exec("SET session_replication_role = 'replica'");
});

describe('createNotificationPayload dedupe by (user_id, source_tool_use_id)', () => {
  test('second insert with same user + tool_use id is skipped (created:false)', async () => {
    const args = {
      ...base,
      user_id: 'u-dedupe-1',
      source_tool_use_id: 'toolu_AAA',
    };
    const first = await createNotificationPayload(args);
    const second = await createNotificationPayload(args);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  test('same tool_use id but different users both insert', async () => {
    const a = await createNotificationPayload({
      ...base,
      user_id: 'u-dedupe-2a',
      source_tool_use_id: 'toolu_BBB',
    });
    const b = await createNotificationPayload({
      ...base,
      user_id: 'u-dedupe-2b',
      source_tool_use_id: 'toolu_BBB',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
  });

  test('null source_tool_use_id never collides (notify_user path)', async () => {
    const a = await createNotificationPayload({
      ...base,
      user_id: 'u-dedupe-3',
    });
    const b = await createNotificationPayload({
      ...base,
      user_id: 'u-dedupe-3',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.id).not.toBe(b.id);
  });

  test('persists an internal action URL', async () => {
    const created = await createNotificationPayload({
      ...base,
      user_id: 'u-action',
      action_url: '/memory-review?mode=existing&projectId=demo',
    });
    const rows = await client().query<{ action_url: string }>(
      'SELECT action_url FROM notification_payloads WHERE id = $1',
      [created.id],
    );
    expect(rows.rows[0]?.action_url).toBe(
      '/memory-review?mode=existing&projectId=demo',
    );
  });

  test('acknowledges older unread notifications for the same action URL', async () => {
    const userId = 'u-supersede';
    const actionUrl =
      '/memory-review?mode=existing&projectId=demo&auditId=audit-1';
    await createNotificationPayload({
      ...base,
      user_id: userId,
      summary: 'Memory audit paused',
      action_url: actionUrl,
      source_tool_use_id: 'memory-audit:audit-1:paused',
    });
    const current = await createNotificationPayload({
      ...base,
      user_id: userId,
      summary: 'Memory audit ready for review',
      action_url: actionUrl,
      source_tool_use_id: 'memory-audit:audit-1:ready',
    });

    await ackSupersededNotificationPayloads(
      userId,
      actionUrl,
      'memory-audit:audit-1:ready',
    );

    const unread = await getUnreadPayloads(userId);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.id).toBe(current.id);
  });

  test('cleans up existing duplicate memory-review notifications', async () => {
    const userId = 'u-existing-duplicates';
    const actionUrl =
      '/memory-review?mode=existing&projectId=demo&auditId=audit-2';
    const now = spyOn(Date, 'now').mockReturnValue(Date.now());
    let current: Awaited<ReturnType<typeof createNotificationPayload>>;
    try {
      await createNotificationPayload({
        ...base,
        user_id: userId,
        summary: 'Memory audit paused',
        action_url: actionUrl,
        source_tool_use_id: 'memory-audit:audit-2:paused',
      });
      current = await createNotificationPayload({
        ...base,
        user_id: userId,
        summary: 'Memory audit ready for review',
        action_url: actionUrl,
        source_tool_use_id: 'memory-audit:audit-2:ready',
      });
    } finally {
      now.mockRestore();
    }

    await ackDuplicateUnreadMemoryReviewPayloads(userId);

    const unread = await getUnreadPayloads(userId);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.id).toBe(current.id);
  });

  test('bulk acknowledgement is user-scoped, skips expired rows, and is idempotent', async () => {
    const mine = await createNotificationPayload({
      ...base,
      user_id: 'u-bulk-1',
    });
    const expired = await createNotificationPayload({
      ...base,
      user_id: 'u-bulk-1',
      ttl_ms: -1,
    });
    const other = await createNotificationPayload({
      ...base,
      user_id: 'u-bulk-2',
    });

    expect(await ackUnreadPayloads('u-bulk-1')).toEqual([
      { id: mine.id, kind: 'text' },
    ]);
    expect(await getUnreadPayloads('u-bulk-1')).toEqual([]);
    expect(await getUnreadPayloads('u-bulk-2')).toEqual([
      expect.objectContaining({ id: other.id }),
    ]);
    expect(await ackUnreadPayloads('u-bulk-1')).toEqual([]);
    expect(await getUnreadPayloads('u-bulk-1')).toEqual([]);
    expect(expired.id).not.toBe(mine.id);
  });
});
