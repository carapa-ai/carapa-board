import fs from 'fs';
import type { Request, Response } from 'express';
import type { TtsAudioAssetRow } from '../../db.js';
import { touchTtsAudioAsset } from '../../db.js';
import { ttsAssetFilePath } from './cache.js';

/** Serve one immutable asset with HEAD and single-range support. */
export async function serveTtsAsset(
  req: Request,
  res: Response,
  asset: TtsAudioAssetRow,
): Promise<void> {
  const filePath = ttsAssetFilePath(asset);
  const size = asset.byteLength;
  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', `"tts-${asset.id}"`);
  res.setHeader('X-Audio-Duration', (asset.durationMs / 1000).toFixed(3));
  res.setHeader('X-TTS-Asset-Id', asset.id);
  void touchTtsAudioAsset(asset.id).catch(() => undefined);

  const rangeNotSatisfiable = () => {
    res.status(416).setHeader('Content-Range', `bytes */${size}`);
    res.end();
  };

  const rawRange = req.headers.range;
  const range = rawRange?.match(/^bytes=(\d*)-(\d*)$/);
  if (rawRange && (!range || (!range[1] && !range[2]))) {
    rangeNotSatisfiable();
    return;
  }
  if (!range) {
    res.setHeader('Content-Length', size);
    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }
    fs.createReadStream(filePath)
      .on('error', () => res.destroy())
      .pipe(res);
    return;
  }
  const suffixLength =
    !range[1] && range[2] ? Number.parseInt(range[2], 10) : null;
  const start =
    suffixLength !== null
      ? Math.max(0, size - suffixLength)
      : range[1]
        ? Number.parseInt(range[1], 10)
        : 0;
  const end =
    suffixLength !== null
      ? size - 1
      : range[2]
        ? Number.parseInt(range[2], 10)
        : size - 1;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    rangeNotSatisfiable();
    return;
  }
  const boundedEnd = Math.min(end, size - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${boundedEnd}/${size}`);
  res.setHeader('Content-Length', boundedEnd - start + 1);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath, { start, end: boundedEnd })
    .on('error', () => res.destroy())
    .pipe(res);
}
