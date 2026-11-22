import { randomUUID } from 'crypto';
import { sha256Hex } from '../../lib/hash.js';
import fs from 'fs/promises';
import path from 'path';
import { STORE_DIR } from '../../config.js';
import {
  deleteTtsAudioAsset,
  getTtsAudioAsset,
  insertTtsAudioAsset,
  listUnlinkedTtsAudioAssets,
  touchTtsAudioAsset,
  type TtsAudioAssetRow,
} from '../../db.js';
import { InFlightCoalescer } from '../../lib/in-flight-coalescer.js';
import { isPathInside } from '../../lib/path-containment.js';
import { logger } from '../../logger.js';
import {
  TTS_CACHE_MAX_BYTES,
  TTS_CACHE_REVISION,
  TTS_CACHE_TRANSIENT_TTL_DAYS,
  TTS_FORMAT,
  TTS_LANG,
  TTS_MODEL,
  TTS_SPEED,
  TTS_STEPS,
  TTS_VOICE,
  type TtsFormat,
} from './config.js';
import {
  formatToMime,
  synthesize,
  type SynthOptions,
  type SynthResult,
} from './synthesizer.js';
import { voiceStyleRevision } from './voice-styles.js';
import { concatenateOggClips } from './audio-concat.js';
import { endsAtTtsBoundary } from './chunker.js';

const assetRoot = path.join(STORE_DIR, 'tts', 'assets');
const inFlight = new InFlightCoalescer();
const recentTouches = new Map<string, number>();

export interface CachedSpeech extends SynthResult {
  assetId: string | null;
  cacheHit: boolean;
  filePath: string | null;
}

function assetPath(id: string, format: TtsFormat): string {
  return path.join(assetRoot, id.slice(0, 2), `${id}.${format}`);
}

export function ttsAssetFilePath(
  asset: Pick<TtsAudioAssetRow, 'id' | 'format' | 'storagePath'>,
): string {
  const candidate = path.resolve(STORE_DIR, asset.storagePath);
  if (!isPathInside(assetRoot, candidate, { allowRoot: false })) {
    throw new Error('Invalid TTS asset path');
  }
  return candidate;
}

async function readReadyAsset(id: string): Promise<CachedSpeech | null> {
  const row = await getTtsAudioAsset(id);
  if (!row) return null;
  const filePath = ttsAssetFilePath(row);
  try {
    const audio = await fs.readFile(filePath);
    const now = Date.now();
    if (now - (recentTouches.get(id) || 0) > 60_000) {
      recentTouches.set(id, now);
      const timer = setTimeout(() => {
        if (recentTouches.get(id) === now) recentTouches.delete(id);
      }, 60_000);
      timer.unref();
      void touchTtsAudioAsset(id).catch(() => undefined);
    }
    return {
      assetId: id,
      cacheHit: true,
      filePath,
      audio,
      format: row.format as TtsFormat,
      durationMs: row.durationMs,
      sampleRate: row.sampleRate,
    };
  } catch {
    recentTouches.delete(id);
    await deleteTtsAudioAsset(id).catch(() => undefined);
    return null;
  }
}

export async function ttsCacheKey(
  text: string,
  opts: SynthOptions = {},
): Promise<{
  id: string;
  resolved: Required<SynthOptions>;
  voiceRevision: string;
}> {
  const resolved: Required<SynthOptions> = {
    voice: opts.voice ?? TTS_VOICE,
    lang: opts.lang ?? TTS_LANG,
    steps: opts.steps ?? TTS_STEPS,
    speed: opts.speed ?? TTS_SPEED,
    format: opts.format ?? TTS_FORMAT,
  };
  const voiceRevision = await voiceStyleRevision(resolved.voice);
  const canonical = JSON.stringify({
    revision: TTS_CACHE_REVISION,
    model: TTS_MODEL,
    text,
    ...resolved,
    voiceRevision,
  });
  return {
    id: sha256Hex(canonical),
    resolved,
    voiceRevision,
  };
}

/**
 * Return the ready asset `id`, or run `produce` once per id (concurrent callers
 * share it), store the audio and record it. A completed cache entry is the
 * file plus its metadata row.
 */
function cacheAsset(
  id: string,
  resolved: Required<SynthOptions>,
  parameters: Record<string, unknown>,
  produce: () => Promise<SynthResult>,
): Promise<CachedSpeech> {
  return inFlight.run(id, async () => {
    const raced = await readReadyAsset(id);
    if (raced) return raced;
    const result = await produce();
    if (result.usedFallbackVoice) {
      return { ...result, assetId: null, cacheHit: false, filePath: null };
    }
    const filePath = assetPath(id, result.format);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, result.audio, { flag: 'wx' });
      await fs.rename(temporary, filePath);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
    const now = new Date().toISOString();
    try {
      await insertTtsAudioAsset({
        id,
        format: result.format,
        mimeType: formatToMime(result.format),
        durationMs: result.durationMs,
        sampleRate: result.sampleRate,
        byteLength: result.audio.byteLength,
        model: TTS_MODEL,
        voiceId: resolved.voice,
        language: resolved.lang,
        parameters,
        storagePath: path.relative(STORE_DIR, filePath),
        createdAt: now,
        lastAccessedAt: now,
      });
    } catch (error) {
      // Do not strand a final-looking file when persistence fails.
      await fs.unlink(filePath).catch(() => undefined);
      throw error;
    }
    return { ...result, assetId: id, cacheHit: false, filePath };
  });
}

export async function synthesizeCached(
  text: string,
  opts: SynthOptions = {},
): Promise<CachedSpeech> {
  const key = await ttsCacheKey(text, opts);
  const ready = await readReadyAsset(key.id);
  if (ready) return ready;
  return cacheAsset(
    key.id,
    key.resolved,
    {
      steps: key.resolved.steps,
      speed: key.resolved.speed,
      voiceRevision: key.voiceRevision,
      cacheRevision: TTS_CACHE_REVISION,
    },
    () => synthesize(text, key.resolved),
  );
}

/**
 * Synthesize bounded chunks sequentially and cache one OGG. A short silence is
 * inserted only after chunks ending at natural punctuation; hard wraps remain
 * gapless. Chunk and pause boundaries are part of the cache identity.
 */
export async function synthesizeChunksCached(
  chunks: string[],
  opts: SynthOptions = {},
  gapMs = 300,
): Promise<CachedSpeech> {
  const clean = chunks.map((chunk) => chunk.trim()).filter(Boolean);
  if (clean.length === 0) throw new Error('Cannot synthesize empty TTS chunks');
  if (clean.length === 1)
    return synthesizeCached(clean[0], { ...opts, format: 'ogg' });

  const base = await ttsCacheKey(clean.join(' '), { ...opts, format: 'ogg' });
  const pauseAfter = clean.map(endsAtTtsBoundary);
  const id = sha256Hex(
    JSON.stringify({
      sourceId: base.id,
      mode: 'chunked-ogg-v2',
      chunks: clean,
      pauseAfter,
      gapMs,
    }),
  );
  const ready = await readReadyAsset(id);
  if (ready) return ready;
  return cacheAsset(
    id,
    base.resolved,
    {
      steps: base.resolved.steps,
      speed: base.resolved.speed,
      voiceRevision: base.voiceRevision,
      cacheRevision: TTS_CACHE_REVISION,
      synthesisMode: 'chunked-ogg-v2',
      chunkCount: clean.length,
      pauseCount: pauseAfter.slice(0, -1).filter(Boolean).length,
      gapMs,
    },
    async () => {
      const clips: SynthResult[] = [];
      for (const chunk of clean)
        clips.push(await synthesize(chunk, base.resolved));
      const result = await concatenateOggClips(clips, pauseAfter, gapMs);
      return {
        ...result,
        usedFallbackVoice: clips.some((clip) => clip.usedFallbackVoice),
      };
    },
  );
}

/** Evict only assets without a durable message link. */
export async function sweepTtsCache(
  now = Date.now(),
): Promise<{ removed: number; bytes: number }> {
  const candidates = await listUnlinkedTtsAudioAssets();
  const cutoff = now - TTS_CACHE_TRANSIENT_TTL_DAYS * 86_400_000;
  let total = candidates.reduce((sum, item) => sum + item.byteLength, 0);
  let removed = 0;
  let bytes = 0;
  for (const asset of candidates) {
    const expired = Date.parse(asset.lastAccessedAt) < cutoff;
    if (!expired && total <= TTS_CACHE_MAX_BYTES) continue;
    await fs.unlink(ttsAssetFilePath(asset)).catch(() => undefined);
    await deleteTtsAudioAsset(asset.id);
    recentTouches.delete(asset.id);
    total -= asset.byteLength;
    bytes += asset.byteLength;
    removed++;
  }
  if (removed)
    logger.info({ removed, bytes }, 'evicted transient TTS cache assets');
  return { removed, bytes };
}
