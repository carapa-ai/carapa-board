import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { openFileAt, openTrustedDir } from '../../lib/group-fs.js';
import {
  artifactThumbnailPath,
  ensureArtifactThumbnail,
} from './artifact-thumbnails.js';

let tempDir = '';

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'carapa-artifact-thumb-'));
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** ensureArtifactThumbnail on `sourcePath`, writing into the dir of `thumbnailPath`. */
async function ensure(
  sourcePath: string,
  thumbnailPath: string,
  mimetype?: string,
): Promise<boolean> {
  await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
  const thumbDir = await openTrustedDir(path.dirname(thumbnailPath));
  const sourceDir = await openTrustedDir(path.dirname(sourcePath));
  const source = await openFileAt(sourceDir!, path.basename(sourcePath));
  try {
    return await ensureArtifactThumbnail(
      { ...source!, name: path.basename(sourcePath) },
      thumbDir!,
      mimetype,
    );
  } finally {
    await source!.handle.close();
    await sourceDir!.close();
    await thumbDir!.close();
  }
}

describe('artifact thumbnails', () => {
  test('creates and reuses a bounded thumbnail in the persistent cache path', async () => {
    const sourcePath = path.join(tempDir, 'source.png');
    const thumbnailPath = artifactThumbnailPath(tempDir, 'images/source.png');
    const canvas = createCanvas(1200, 600);
    await fs.writeFile(sourcePath, await canvas.encode('png'));

    expect(await ensure(sourcePath, thumbnailPath)).toBe(true);
    const firstStat = await fs.stat(thumbnailPath);
    const thumbnail = await loadImage(thumbnailPath);
    expect(thumbnail.width).toBe(256);
    expect(thumbnail.height).toBe(128);

    expect(await ensure(sourcePath, thumbnailPath)).toBe(true);
    const secondStat = await fs.stat(thumbnailPath);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  test('keeps cache paths inside the thumbnail directory', () => {
    const thumbnailPath = artifactThumbnailPath(tempDir, '../outside.png');
    expect(thumbnailPath.startsWith(path.join(tempDir, 'thumbnails'))).toBe(
      true,
    );
  });

  test('creates a thumbnail for a content-detected image without an extension', async () => {
    const sourcePath = path.join(tempDir, 'extensionless-image');
    const thumbnailPath = artifactThumbnailPath(
      tempDir,
      'images/extensionless-image',
    );
    const canvas = createCanvas(20, 20);
    await fs.writeFile(sourcePath, await canvas.encode('png'));

    expect(await ensure(sourcePath, thumbnailPath, 'image/png')).toBe(true);
  });

  test('supports concurrent generation of the same uncached thumbnail', async () => {
    const sourcePath = path.join(tempDir, 'concurrent.png');
    const thumbnailPath = artifactThumbnailPath(
      tempDir,
      'images/concurrent.png',
    );
    const canvas = createCanvas(80, 40);
    await fs.writeFile(sourcePath, await canvas.encode('png'));

    expect(
      await Promise.all(
        Array.from({ length: 8 }, () => ensure(sourcePath, thumbnailPath)),
      ),
    ).toEqual(Array(8).fill(true));
    expect((await loadImage(thumbnailPath)).width).toBe(80);
  });
});
