import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import * as db from './db.js';
import { drizzleDbRef } from './db/drizzle-client.js';
import { deviceKeys, users } from './db/schema.js';

const suffix = crypto.randomUUID().slice(0, 8);
const userIds: string[] = [];

beforeAll(async () => {
  await db.initDatabase(':memory:');
});
afterAll(async () => {
  for (const id of userIds)
    await drizzleDbRef.current.delete(users).where(eq(users.id, id));
});

// Registers one approved device and, optionally, more devices; extra ones are
// approved only when listed in `approvedExtras`.
async function seedUser(name: string, extras: Record<string, boolean>) {
  const user = await db.createUser(`${suffix}-${name}`, 'test', 'user');
  userIds.push(user.id);
  const approved = `${suffix}-${name}-approved`;
  await db.registerDeviceKey(approved, user.id, 'pk', 'Approved', true);
  for (const [id, isApproved] of Object.entries(extras))
    await db.registerDeviceKey(
      `${suffix}-${name}-${id}`,
      user.id,
      'pk',
      id,
      isApproved,
    );
  return { user, approved, extra: (id: string) => `${suffix}-${name}-${id}` };
}

test('a pending device does not count toward the last-active guard', async () => {
  const s = await seedUser('pending', { pending: false });
  expect(await db.deactivateDeviceIfSafe(s.approved, s.user.id)).toBe(
    'last_active',
  );
  expect(await db.deleteDeviceIfSafe(s.approved, s.user.id)).toBe(
    'last_active',
  );

  // Removing or deactivating the pending device is always allowed.
  expect(await db.deactivateDeviceIfSafe(s.extra('pending'), s.user.id)).toBe(
    'ok',
  );
  expect(await db.deleteDeviceIfSafe(s.extra('pending'), s.user.id)).toBe('ok');
  expect(await db.deleteDeviceIfSafe(s.extra('pending'), s.user.id)).toBe(
    'not_found',
  );
});

test('two approved devices keep the existing behaviour', async () => {
  const s = await seedUser('two', { second: true });
  expect(await db.deactivateDeviceIfSafe(s.extra('second'), s.user.id)).toBe(
    'ok',
  );
  // Only one approved active device remains.
  expect(await db.deleteDeviceIfSafe(s.approved, s.user.id)).toBe(
    'last_active',
  );
});
