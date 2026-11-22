import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { getNativeBinaryDataUrl } from './api.js';

const SPEECH_CACHE_DIR = 'tts';
const SPEECH_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const SPEECH_EXTENSIONS = ['ogg', 'wav', 'flac'] as const;
let prunePromise: Promise<void> | null = null;
let lastPrunedAt = 0;

function safeCacheKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160);
}

/** Remove only expired TTS files. Avatar caches live in separate directories. */
export async function pruneNativeSpeechCache(now = Date.now()): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const cutoff = now - SPEECH_CACHE_TTL_MS;
  const listing = await Filesystem.readdir({
    path: SPEECH_CACHE_DIR,
    directory: Directory.Cache,
  }).catch(() => null);
  if (!listing) return;
  await Promise.all(listing.files
    .filter((file) => file.type === 'file' && file.mtime < cutoff)
    .map((file) => Filesystem.deleteFile({
      path: `${SPEECH_CACHE_DIR}/${file.name}`,
      directory: Directory.Cache,
    }).catch(() => undefined)));
}

function ensurePruned(): Promise<void> {
  if (Date.now() - lastPrunedAt < 60 * 60 * 1000) return Promise.resolve();
  if (!prunePromise) {
    prunePromise = pruneNativeSpeechCache().then(() => { lastPrunedAt = Date.now(); }).finally(() => { prunePromise = null; });
  }
  return prunePromise;
}

/** Return a fresh native TTS file without contacting the server. */
export async function cachedNativeSpeechFileUrl(key: string): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  await ensurePruned();
  const safe = safeCacheKey(key);
  for (const extension of SPEECH_EXTENSIONS) {
    const path = `${SPEECH_CACHE_DIR}/${safe}.${extension}`;
    try {
      const [stat, file] = await Promise.all([
        Filesystem.stat({ path, directory: Directory.Cache }),
        Filesystem.getUri({ path, directory: Directory.Cache }),
      ]);
      if (stat.size > 0 && stat.mtime >= Date.now() - SPEECH_CACHE_TTL_MS) {
        return Capacitor.convertFileSrc(file.uri);
      }
      await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
    } catch {
      // Try the next supported audio extension.
    }
  }
  return null;
}

/** Persist native HTTP bytes outside the Android WebView blob boundary. */
export async function nativeSpeechFileUrl(response: Response, key: string): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  await ensurePruned();
  const binary = getNativeBinaryDataUrl(response);
  if (!binary) return null;
  const safe = safeCacheKey(key);
  const extension = binary.contentType.includes('wav') ? 'wav' : binary.contentType.includes('flac') ? 'flac' : 'ogg';
  const file = await Filesystem.writeFile({
    path: `${SPEECH_CACHE_DIR}/${safe}.${extension}`,
    data: binary.base64,
    directory: Directory.Cache,
    recursive: true,
  });
  return Capacitor.convertFileSrc(file.uri);
}

// The chat bundle loads this module during normal app startup. Native push
// delivery also performs the same cleanup in CarapaApiClient when the WebView
// is suspended or has not been opened recently.
void ensurePruned();
