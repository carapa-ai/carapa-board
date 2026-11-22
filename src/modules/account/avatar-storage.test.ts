import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import {
  accountAvatarDirectory,
  findAccountAvatarCandidate,
  promoteAccountAvatarCandidate,
  readAccountAvatarReference,
  writeAccountAvatar,
  writeAccountAvatarCandidate,
} from './avatar-storage.js';

const userId = `account-avatar-storage-${process.pid}`;

afterAll(async () => {
  await fs.rm(accountAvatarDirectory(userId), { recursive: true, force: true });
});

describe('account avatar storage', () => {
  test('restores the current avatar and candidate when profile persistence fails', async () => {
    const current = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const candidate = Buffer.from([0xff, 0xd8, 0xff]);
    const currentAsset = await writeAccountAvatar(userId, '.png', current);
    await writeAccountAvatarCandidate(userId, '.jpg', candidate);

    await expect(
      promoteAccountAvatarCandidate(
        userId,
        async () => currentAsset.path,
        async () => {
          throw new Error('profile persistence failed');
        },
      ),
    ).rejects.toThrow('profile persistence failed');

    expect(await readAccountAvatarReference(userId, currentAsset.path)).toEqual(
      {
        data: current.toString('base64'),
        mimetype: 'image/png',
      },
    );
    expect(await findAccountAvatarCandidate(userId)).toEqual(
      expect.objectContaining({
        path: `account-avatars/${userId}/avatar-candidate.jpg`,
      }),
    );
  });
  test('removes the archived previous avatar after successful promotion', async () => {
    const promotionUserId = `${userId}-promotion`;
    const current = await writeAccountAvatar(
      promotionUserId,
      '.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    await writeAccountAvatarCandidate(
      promotionUserId,
      '.jpg',
      Buffer.from([0xff, 0xd8, 0xff]),
    );
    await promoteAccountAvatarCandidate(
      promotionUserId,
      async () => current.path,
    );
    expect(
      (await fs.readdir(accountAvatarDirectory(promotionUserId))).some((name) =>
        name.startsWith('avatar-previous-'),
      ),
    ).toBe(false);
    await fs.rm(accountAvatarDirectory(promotionUserId), {
      recursive: true,
      force: true,
    });
  });
  test('restores the saved avatar when upload profile persistence fails', async () => {
    const current = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const replacement = Buffer.from([0xff, 0xd8, 0xff]);
    const currentAsset = await writeAccountAvatar(userId, '.png', current);
    await expect(
      writeAccountAvatar(userId, '.jpg', replacement, async () => {
        throw new Error('profile persistence failed');
      }),
    ).rejects.toThrow('profile persistence failed');
    expect(await readAccountAvatarReference(userId, currentAsset.path)).toEqual(
      {
        data: current.toString('base64'),
        mimetype: 'image/png',
      },
    );
  });
});
