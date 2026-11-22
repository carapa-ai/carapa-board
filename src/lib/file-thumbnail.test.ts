import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  createFileThumbnail,
  ensurePinnedImageThumbnail,
  FILE_THUMBNAIL_MAX_SIZE,
} from './file-thumbnail.js';
import { openFileAt, openTrustedDir } from './group-fs.js';

describe('file explorer thumbnails', () => {
  test('returns a bounded jpeg rather than the original image', async () => {
    const source = createCanvas(800, 400);
    const thumbnail = await createFileThumbnail(await source.encode('png'));
    expect(thumbnail).not.toBeNull();
    const image = await loadImage(thumbnail!);
    expect(image.width).toBe(FILE_THUMBNAIL_MAX_SIZE);
    expect(image.height).toBe(80);
  });

  test('returns null when jpeg encoding rejects asynchronously', async () => {
    const source = createCanvas(4, 4);
    const png = await source.encode('png');
    const encode = spyOn(
      Object.getPrototypeOf(source),
      'encode',
    ).mockRejectedValueOnce(new Error('synthetic encoder failure'));

    try {
      expect(await createFileThumbnail(png)).toBeNull();
    } finally {
      encode.mockRestore();
    }
  });

  test('ensurePinnedImageThumbnail writes atomically through the pinned dirs and caps the source', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-thumb-'));
    const dir = (await openTrustedDir(tmp))!;
    try {
      const png = await createCanvas(400, 200).encode('png');
      fs.writeFileSync(path.join(tmp, 'src.png'), png);
      const opened = (await openFileAt(dir, 'src.png'))!;
      try {
        expect(
          await ensurePinnedImageThumbnail(
            opened,
            dir,
            'src.jpg',
            100,
            1 << 20,
          ),
        ).toBe(true);
        const image = await loadImage(path.join(tmp, 'src.jpg'));
        expect([image.width, image.height]).toEqual([100, 50]);
        // Up to date: not rewritten.
        const inode = fs.statSync(path.join(tmp, 'src.jpg')).ino;
        expect(
          await ensurePinnedImageThumbnail(
            opened,
            dir,
            'src.jpg',
            100,
            1 << 20,
          ),
        ).toBe(true);
        expect(fs.statSync(path.join(tmp, 'src.jpg')).ino).toBe(inode);
        // Over the source cap: false, nothing written.
        expect(
          await ensurePinnedImageThumbnail(opened, dir, 'big.jpg', 100, 10),
        ).toBe(false);
        expect(fs.existsSync(path.join(tmp, 'big.jpg'))).toBe(false);
        expect(fs.readdirSync(tmp).sort()).toEqual(['src.jpg', 'src.png']);
      } finally {
        await opened.handle.close();
      }
    } finally {
      await dir.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
