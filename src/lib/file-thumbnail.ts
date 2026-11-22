import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { lstatAt, type PinnedDir, writeFileAt } from './group-fs.js';

export const FILE_THUMBNAIL_MAX_SIZE = 160;
/** Larger sources are not decoded: the whole image is held in memory. */
export const MAX_THUMBNAIL_SOURCE_BYTES = 50 * 1024 * 1024;
/** Decoded RGBA costs 4 bytes per pixel, so this bounds a decode to ~256 MB. */
const MAX_THUMBNAIL_PIXELS = 64_000_000;

export function isImageFilePath(filePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath);
}

const SVG_UNIT_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

/** Pixel size of an SVG length such as `10000`, `12.5cm`; null for %, em or garbage. */
function svgLengthPx(value: string | undefined): number | null {
  const match = value?.trim().match(/^([\d.]+)([a-z]*)$/i);
  const unit = match ? SVG_UNIT_PX[match[2].toLowerCase()] : undefined;
  return match && unit !== undefined ? Number(match[1]) * unit : null;
}

/**
 * Pixel count the rasterizer would allocate for an SVG: its root `width` and
 * `height`, each falling back to the `viewBox` size. Null when undeclared.
 */
function svgPixelCount(buf: Buffer): number | null {
  const head = buf.toString('utf8', 0, 64 * 1024);
  const tag = head.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const attr = (name: string) =>
    tag
      .match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
      ?.slice(1)
      .find(Boolean);
  const viewBox = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = svgLengthPx(attr('width')) ?? viewBox?.[2];
  const height = svgLengthPx(attr('height')) ?? viewBox?.[3];
  return width && height && Number.isFinite(width * height)
    ? width * height
    : null;
}

/**
 * Pixel count (width * height) declared by an image header, or null when the
 * format is not recognised or the header is truncated. Reads only the header,
 * so it can run before the decoder allocates the full bitmap.
 */
function declaredPixelCount(buf: Buffer): number | null {
  const dims = (w: number, h: number) => w * h;
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return dims(buf.readUInt32BE(16), buf.readUInt32BE(20)); // PNG IHDR
  }
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return dims(buf.readUInt16LE(6), buf.readUInt16LE(8));
  }
  if (buf.length >= 26 && buf.toString('latin1', 0, 2) === 'BM') {
    return dims(Math.abs(buf.readInt32LE(18)), Math.abs(buf.readInt32LE(22)));
  }
  if (
    buf.length >= 30 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8 ') {
      return dims(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    }
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return dims((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (kind === 'VP8X') {
      return dims(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
    }
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: walk the marker segments to the first start-of-frame.
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (
        marker === 0xd8 ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        i += 2;
        continue;
      }
      const isFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame)
        return dims(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return svgPixelCount(buf);
}

async function createImageThumbnail(
  source: Buffer | string,
  maxSize: number,
  quality: number,
  highQualitySmoothing = false,
): Promise<Buffer | null> {
  try {
    if (typeof source !== 'string') {
      const pixels = declaredPixelCount(source);
      if (pixels !== null && pixels > MAX_THUMBNAIL_PIXELS) return null;
    }
    const image = await loadImage(source);
    const sourceWidth = Number(image.width);
    const sourceHeight = Number(image.height);
    if (!sourceWidth || !sourceHeight) return null;
    const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
    const canvas = createCanvas(
      Math.max(1, Math.round(sourceWidth * scale)),
      Math.max(1, Math.round(sourceHeight * scale)),
    );
    const context = canvas.getContext('2d');
    if (highQualitySmoothing) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvas.encode('jpeg', quality);
  } catch {
    return null;
  }
}

/** Produce the small image representation used by the file explorer. */
export async function createFileThumbnail(
  source: Buffer,
): Promise<Buffer | null> {
  return createImageThumbnail(source, FILE_THUMBNAIL_MAX_SIZE, 80);
}

/** Create or refresh an atomically published persistent JPEG thumbnail. */
export async function ensurePersistentImageThumbnail(
  sourcePath: string,
  thumbnailPath: string,
  maxSize: number,
): Promise<boolean> {
  try {
    const [sourceStat, thumbnailStat] = await Promise.all([
      fs.stat(sourcePath),
      // A missing thumbnail just means it must be created.
      fs.stat(thumbnailPath).catch(() => null),
    ]);
    if (thumbnailStat && thumbnailStat.mtimeMs >= sourceStat.mtimeMs)
      return true;

    const encoded = await createImageThumbnail(sourcePath, maxSize, 82, true);
    if (!encoded) return false;
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    const temporaryPath = `${thumbnailPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, encoded);
    await fs.rename(temporaryPath, thumbnailPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read an opened file in full, never more than `maxBytes`. Returns null when
 * the file is over the cap, including a source that grew after `size` was
 * taken (one byte more than the cap is read to detect it).
 */
export async function readHandleBounded(
  handle: FileHandle,
  size: number,
  maxBytes: number,
): Promise<Buffer | null> {
  if (size > maxBytes) return null;
  const buffer = Buffer.allocUnsafe(Math.min(size, maxBytes) + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      length,
      buffer.length - length,
      length,
    );
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return length > maxBytes ? null : buffer.subarray(0, length);
}

/**
 * Create or refresh the JPEG thumbnail `thumbName` in the pinned `thumbDir`
 * for an already opened source image. Everything goes through descriptors: the
 * mtime comparison uses `lstatAt`, the source is read through its handle (never
 * more than `maxSourceBytes`) and the thumbnail is published with an atomic
 * `writeFileAt`. Returns false, never throws, for an over-cap, unreadable or
 * undecodable source.
 */
export async function ensurePinnedImageThumbnail(
  source: { handle: FileHandle; stat: Stats },
  thumbDir: PinnedDir,
  thumbName: string,
  maxSize: number,
  maxSourceBytes: number,
): Promise<boolean> {
  try {
    if (source.stat.size > maxSourceBytes) return false;
    const thumbnailStat = await lstatAt(thumbDir, thumbName).catch(() => null);
    if (
      thumbnailStat?.isFile() &&
      thumbnailStat.mtimeMs >= source.stat.mtimeMs
    ) {
      return true;
    }

    const bytes = await readHandleBounded(
      source.handle,
      source.stat.size,
      maxSourceBytes,
    );
    if (!bytes) return false;

    const encoded = await createImageThumbnail(bytes, maxSize, 82, true);
    if (!encoded) return false;
    await writeFileAt(thumbDir, thumbName, encoded);
    return true;
  } catch {
    return false;
  }
}
