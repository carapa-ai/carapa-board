import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  aiUserAvatarThumbnailPath,
  ensureAiUserAvatarThumbnail,
} from './avatar-thumbnail.js';

let tempDir = '';

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'carapa-avatar-thumb-'));
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('AI user avatar thumbnails', () => {
  test('creates and reuses a bounded persistent JPEG', async () => {
    const sourcePath = path.join(tempDir, 'avatar.png');
    const canvas = createCanvas(1024, 1024);
    await fs.writeFile(sourcePath, await canvas.encode('png'));

    const thumbnailPath = await ensureAiUserAvatarThumbnail(sourcePath);
    expect(thumbnailPath).toBe(aiUserAvatarThumbnailPath(sourcePath));
    const firstStat = await fs.stat(thumbnailPath!);
    const thumbnail = await loadImage(thumbnailPath!);
    expect(thumbnail.width).toBe(256);
    expect(thumbnail.height).toBe(256);

    expect(await ensureAiUserAvatarThumbnail(sourcePath)).toBe(thumbnailPath);
    expect((await fs.stat(thumbnailPath!)).mtimeMs).toBe(firstStat.mtimeMs);
  });
});
