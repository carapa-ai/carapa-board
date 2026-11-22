import { describe, expect, test } from 'bun:test';
import { createCanvas } from '@napi-rs/canvas';
import { AVATAR_MAX_BYTES, decodeAvatarDataUrl } from './avatar-image.js';

describe('avatar image boundary', () => {
  test('accepts complete matching PNG, JPEG, and WebP payloads', async () => {
    const canvas = createCanvas(2, 2);
    for (const [declared, format, extension] of [
      ['png', 'png', '.png'],
      ['jpeg', 'jpeg', '.jpg'],
      ['webp', 'webp', '.webp'],
    ] as const) {
      const bytes = Buffer.from(
        format === 'png'
          ? await canvas.encode('png')
          : await canvas.encode(format),
      );
      await expect(
        decodeAvatarDataUrl(
          `data:image/${declared};base64,${bytes.toString('base64')}`,
        ),
      ).resolves.toEqual({ data: bytes, extension });
    }
  });

  test('rejects matching but corrupt image payloads', async () => {
    for (const [declared, bytes] of [
      ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
      ['jpeg', Buffer.from([0xff, 0xd8, 0xff])],
      ['webp', Buffer.from('RIFF0000WEBP', 'ascii')],
    ] as const) {
      await expect(
        decodeAvatarDataUrl(
          `data:image/${declared};base64,${bytes.toString('base64')}`,
        ),
      ).resolves.toBeNull();
    }
  });

  test('rejects spoofed, unsupported, empty, and oversized uploads', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
    await expect(
      decodeAvatarDataUrl(`data:image/png;base64,${jpeg.toString('base64')}`),
    ).resolves.toBeNull();
    await expect(
      decodeAvatarDataUrl('data:image/gif;base64,R0lGODlh'),
    ).resolves.toBeNull();
    await expect(
      decodeAvatarDataUrl('data:image/png;base64,'),
    ).resolves.toBeNull();
    const oversized = Buffer.alloc(AVATAR_MAX_BYTES + 1, 0);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(
      decodeAvatarDataUrl(
        `data:image/png;base64,${oversized.toString('base64')}`,
      ),
    ).resolves.toBeNull();
  });
});
