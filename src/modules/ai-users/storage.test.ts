import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import {
  aiUserDirectory,
  findAiUserAvatarCandidate,
  normalizeEmoteName,
  promoteAiUserAvatarCandidate,
  readAiUserImageReference,
  removeAiUserFiles,
  writeAiUserAvatar,
  writeAiUserAvatarCandidate,
  writeImmutableAiUserEmote,
} from './storage.js';

const TEST_ID = `emote-storage-${process.pid}`;
const CANDIDATE_TEST_ID = `avatar-candidate-storage-${process.pid}`;

afterAll(async () => {
  await Promise.all([
    removeAiUserFiles(TEST_ID),
    removeAiUserFiles(CANDIDATE_TEST_ID),
  ]);
});

describe('AI user emote storage', () => {
  test.each([
    [
      '.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'image/png',
    ],
    ['.jpg', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
    ['.webp', Buffer.from('RIFF0000WEBP', 'ascii'), 'image/webp'],
  ] as const)(
    'reads a saved %s avatar as an image-generation reference',
    async (extension, data, mimetype) => {
      const path = await writeAiUserAvatar(TEST_ID, extension, data);
      expect(await readAiUserImageReference(path)).toEqual({
        data: data.toString('base64'),
        mimetype,
      });
    },
  );

  test('normalizes free-text names into safe filenames', () => {
    expect(normalizeEmoteName('  Très Happy!!  ')).toBe('tres-happy');
    expect(() => normalizeEmoteName('---')).toThrow('letters or numbers');
  });

  test('promotes a candidate while archiving the current avatar outside the emote list', async () => {
    const current = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]);
    const candidate = Buffer.from([0xff, 0xd8, 0xff, 0x02]);
    const currentPath = await writeAiUserAvatar(
      CANDIDATE_TEST_ID,
      '.png',
      current,
    );
    await writeAiUserAvatarCandidate(CANDIDATE_TEST_ID, '.jpg', candidate);

    const promotedPath = await promoteAiUserAvatarCandidate(
      CANDIDATE_TEST_ID,
      currentPath,
    );

    expect(promotedPath).toBe(`ai-users/${CANDIDATE_TEST_ID}/avatar.jpg`);
    expect(await readAiUserImageReference(promotedPath)).toEqual({
      data: candidate.toString('base64'),
      mimetype: 'image/jpeg',
    });
    expect(await findAiUserAvatarCandidate(CANDIDATE_TEST_ID)).toBeNull();
    expect(await fs.readdir(aiUserDirectory(CANDIDATE_TEST_ID))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^avatar-previous-\d+\.png$/),
        'avatar.jpg',
      ]),
    );
  });
});
