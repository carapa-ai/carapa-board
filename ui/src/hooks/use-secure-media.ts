import { isKnowledgeFileContentUrl } from '@/lib/knowledge-files';
import { useCallback, useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { apiFetch, getNativeBinaryDataUrl } from '@/lib/api';
import { resolveApiUrl } from '@/lib/api-config';
import { useStore } from '@/store';

type NativeAvatarCacheEntry = {
  byteLength: number;
  secureUrl: string;
};

type NativeIdentityFallback = {
  entry: NativeAvatarCacheEntry;
  version: string;
  sourceUrl?: string;
};

const NATIVE_AVATAR_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const NATIVE_AVATAR_CACHE_MAX_ENTRIES = 128;
const nativeAvatarCache = new Map<string, NativeAvatarCacheEntry>();
const pendingNativeAvatars = new Map<string, Promise<NativeAvatarCacheEntry>>();
const lastNativeAvatarByIdentity = new Map<string, NativeIdentityFallback>();
const previousNativeAvatarByUrl = new Map<
  string,
  NativeIdentityFallback | null
>();
const failedNativeAvatarUrls = new Set<string>();
const pendingNativeAvatarDeletions = new Map<string, Promise<void>>();
const NATIVE_IDENTITY_INDEX_KEY = 'secure-media-native-identity-index-v1';
let nativeAvatarCacheBytes = 0;

function readPersistedIdentityFallback(
  identityKey: string,
): NativeIdentityFallback | null {
  try {
    const raw = globalThis.localStorage?.getItem(NATIVE_IDENTITY_INDEX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, NativeIdentityFallback>;
    const value = parsed[identityKey];
    return value?.entry?.secureUrl && value.version ? value : null;
  } catch {
    return null;
  }
}

function persistIdentityFallback(
  identityKey: string,
  fallback: NativeIdentityFallback,
): void {
  try {
    const raw = globalThis.localStorage?.getItem(NATIVE_IDENTITY_INDEX_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as Record<string, NativeIdentityFallback>)
      : {};
    const current = parsed[identityKey];
    if (
      !current ||
      compareImageVersions(fallback.version, current.version) >= 0
    ) {
      parsed[identityKey] = fallback;
      globalThis.localStorage?.setItem(
        NATIVE_IDENTITY_INDEX_KEY,
        JSON.stringify(parsed),
      );
    }
  } catch {
    // localStorage is unavailable in some native WebViews; the native file cache remains authoritative.
  }
}

export function rollbackNativeAvatarIdentity(url: string): void {
  const resolved = resolveApiUrl(
    url,
    Capacitor.isNativePlatform()
      ? useStore.getState().connectionMode
      : undefined,
  );
  failedNativeAvatarUrls.add(resolved);
  const cached = nativeAvatarCache.get(resolved);
  if (cached) {
    nativeAvatarCache.delete(resolved);
    nativeAvatarCacheBytes -= cached.byteLength;
  }
  const deletion = nativeAvatarCachePath(resolved).then((path) => {
    if (typeof Filesystem.deleteFile === 'function')
      return Filesystem.deleteFile({ path, directory: Directory.Cache })
        .catch(() => undefined)
        .then(() => undefined);
  });
  pendingNativeAvatarDeletions.set(resolved, deletion);
  const identityKey = nativeAiUserImageKey(resolved);
  const previous = previousNativeAvatarByUrl.get(resolved) ?? null;
  if (!identityKey || !previousNativeAvatarByUrl.has(resolved)) return;
  const current = lastNativeAvatarByIdentity.get(identityKey);
  if (current?.sourceUrl && current.sourceUrl !== resolved) return;
  if (previous) lastNativeAvatarByIdentity.set(identityKey, previous);
  else lastNativeAvatarByIdentity.delete(identityKey);
  try {
    const raw = globalThis.localStorage?.getItem(NATIVE_IDENTITY_INDEX_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as Record<string, NativeIdentityFallback>)
      : {};
    if (previous) parsed[identityKey] = previous;
    else delete parsed[identityKey];
    globalThis.localStorage?.setItem(
      NATIVE_IDENTITY_INDEX_KEY,
      JSON.stringify(parsed),
    );
  } catch {}
  previousNativeAvatarByUrl.delete(resolved);
}

async function nativeAvatarCachePath(url: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(url),
  );
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `avatar-thumbnails/${hash}.jpg`;
}

async function readPersistedNativeAvatar(
  url: string,
): Promise<NativeAvatarCacheEntry | null> {
  try {
    const path = await nativeAvatarCachePath(url);
    const [stat, file] = await Promise.all([
      Filesystem.stat({ path, directory: Directory.Cache }),
      Filesystem.getUri({ path, directory: Directory.Cache }),
    ]);
    if (stat.size <= 0) return null;
    return {
      secureUrl: Capacitor.convertFileSrc(file.uri),
      byteLength: stat.size,
    };
  } catch {
    return null;
  }
}

async function persistNativeAvatar(
  url: string,
  base64: string,
  byteLength: number,
): Promise<NativeAvatarCacheEntry | null> {
  try {
    const path = await nativeAvatarCachePath(url);
    const file = await Filesystem.writeFile({
      path,
      data: base64,
      directory: Directory.Cache,
      recursive: true,
    });
    return {
      secureUrl: Capacitor.convertFileSrc(file.uri),
      byteLength,
    };
  } catch (error) {
    console.warn('[SecureMedia] Could not persist native avatar cache', error);
    return null;
  }
}

function isVersionedImageThumbnail(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isAiUserThumbnail =
      /^\/api\/ai-users\/[^/]+\/(?:avatar|emotes\/[^/]+)$/.test(
        parsed.pathname,
      ) && parsed.searchParams.get('thumbnail') === '1';
    const isArtifactThumbnail =
      /^\/artifacts\/[^/]+\/thumbnails\/.+\.jpg$/.test(parsed.pathname);
    return (
      (isAiUserThumbnail || isArtifactThumbnail) && parsed.searchParams.has('v')
    );
  } catch {
    return false;
  }
}

function nativeAiUserImageKey(url: string): string | null {
  try {
    const resolved = /^https?:\/\//.test(url)
      ? url
      : resolveApiUrl(url, useStore.getState().connectionMode);
    const parsed = new URL(resolved);
    const match = parsed.pathname.match(
      /^\/api\/ai-users\/([^/]+)\/(avatar|emotes\/([^/]+))$/,
    );
    if (!match?.[1]) return null;
    const userId = decodeURIComponent(match[1]);
    const imageKey =
      match[2] === 'avatar'
        ? `${userId}:avatar`
        : `${userId}:emote:${decodeURIComponent(match[3])}`;
    return `${parsed.origin}:${imageKey}`;
  } catch {
    return null;
  }
}

function nativeImageVersion(url: string): string | null {
  try {
    return new URL(url).searchParams.get('v');
  } catch {
    return null;
  }
}

function compareImageVersions(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate)) {
    return leftDate - rightDate;
  }
  return left.localeCompare(right);
}

function immediateSecureMediaUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const isNative = Capacitor.isNativePlatform();
  const resolvedUrl = resolveApiUrl(
    url,
    isNative ? useStore.getState().connectionMode : undefined,
  );
  if (
    !isNative ||
    resolvedUrl.startsWith('blob:') ||
    resolvedUrl.startsWith('data:')
  ) {
    return resolvedUrl;
  }
  const exact = readCachedNativeAvatar(resolvedUrl);
  if (exact) return exact.secureUrl;
  const identityKey = nativeAiUserImageKey(resolvedUrl);
  if (!identityKey) return null;
  const memory = lastNativeAvatarByIdentity.get(identityKey);
  if (memory) return memory.entry.secureUrl;
  const persisted = readPersistedIdentityFallback(identityKey);
  if (persisted?.sourceUrl) return persisted.entry.secureUrl;
  return null;
}

function immediateNativeAvatarSource(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const resolvedUrl = resolveApiUrl(url, useStore.getState().connectionMode);
  if (!Capacitor.isNativePlatform()) return resolvedUrl;
  if (readCachedNativeAvatar(resolvedUrl)) return resolvedUrl;
  const identityKey = nativeAiUserImageKey(resolvedUrl);
  if (!identityKey) return resolvedUrl;
  return (
    lastNativeAvatarByIdentity.get(identityKey)?.sourceUrl ??
    readPersistedIdentityFallback(identityKey)?.sourceUrl ??
    resolvedUrl
  );
}

function readCachedNativeAvatar(url: string): NativeAvatarCacheEntry | null {
  if (failedNativeAvatarUrls.has(url)) return null;
  const cached = nativeAvatarCache.get(url);
  if (!cached) return null;
  // Refresh insertion order so Map acts as an LRU cache.
  nativeAvatarCache.delete(url);
  nativeAvatarCache.set(url, cached);
  return cached;
}

function cacheNativeAvatar(url: string, entry: NativeAvatarCacheEntry): void {
  failedNativeAvatarUrls.delete(url);
  const previous = nativeAvatarCache.get(url);
  if (previous) nativeAvatarCacheBytes -= previous.byteLength;
  nativeAvatarCache.delete(url);
  nativeAvatarCache.set(url, entry);
  nativeAvatarCacheBytes += entry.byteLength;
  const identityKey = nativeAiUserImageKey(url);
  const version = nativeImageVersion(url);
  if (identityKey && version !== null) {
    const current = lastNativeAvatarByIdentity.get(identityKey);
    if (!current || compareImageVersions(version, current.version) >= 0) {
      previousNativeAvatarByUrl.set(url, current ?? null);
      const fallback = { entry, version, sourceUrl: url };
      lastNativeAvatarByIdentity.set(identityKey, fallback);
      persistIdentityFallback(identityKey, fallback);
    }
  }
  while (
    nativeAvatarCache.size > NATIVE_AVATAR_CACHE_MAX_ENTRIES ||
    nativeAvatarCacheBytes > NATIVE_AVATAR_CACHE_MAX_BYTES
  ) {
    const oldest = nativeAvatarCache.entries().next().value as
      | [string, NativeAvatarCacheEntry]
      | undefined;
    if (!oldest) break;
    nativeAvatarCache.delete(oldest[0]);
    nativeAvatarCacheBytes -= oldest[1].byteLength;
  }
}

async function loadNativeAvatar(
  url: string,
  forceRefetch = false,
): Promise<NativeAvatarCacheEntry> {
  if (!forceRefetch) {
    const cached = readCachedNativeAvatar(url);
    if (cached) return cached;
    const pending = pendingNativeAvatars.get(url);
    if (pending) return pending;
  }

  const request = (async () => {
    const deletion = pendingNativeAvatarDeletions.get(url);
    if (deletion) await deletion;
    const persisted =
      forceRefetch || failedNativeAvatarUrls.has(url)
        ? null
        : await readPersistedNativeAvatar(url);
    if (persisted) {
      cacheNativeAvatar(url, persisted);
      console.debug('[SecureMedia] Native avatar disk-cache hit', {
        path: new URL(url).pathname,
        byteLength: persisted.byteLength,
      });
      return persisted;
    }
    const response = await apiFetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch avatar: ${response.status} ${response.statusText}`,
      );
    }
    const nativeMedia = getNativeBinaryDataUrl(response);
    if (!nativeMedia) throw new Error('Native avatar response was not binary');
    const entry = (await persistNativeAvatar(
      url,
      nativeMedia.base64,
      nativeMedia.byteLength,
    )) ?? {
      secureUrl: nativeMedia.url,
      byteLength: nativeMedia.byteLength,
    };
    cacheNativeAvatar(url, entry);
    return entry;
  })();
  pendingNativeAvatars.set(url, request);
  try {
    return await request;
  } finally {
    pendingNativeAvatars.delete(url);
  }
}

/**
 * Fetch media securely without exposing session tokens in URLs. Versioned
 * native image thumbnails use the OS-managed cache; other native media uses a
 * local URL.
 */
export function useSecureMedia(
  url: string | null | undefined,
  fallbackUrl?: string | null,
) {
  const signedBrowserMedia = Boolean(url && isKnowledgeFileContentUrl(url));
  const [secureUrl, setSecureUrl] = useState<string | null>(() =>
    signedBrowserMedia
      ? null
      : (immediateSecureMediaUrl(url) ?? immediateSecureMediaUrl(fallbackUrl)),
  );
  const [candidateSourceUrl, setCandidateSourceUrl] = useState<string | null>(
    () => immediateNativeAvatarSource(url),
  );
  const [loading, setLoading] = useState(() => {
    if (signedBrowserMedia) return true;
    if (!url || !Capacitor.isNativePlatform()) return false;
    const resolved = resolveApiUrl(url, useStore.getState().connectionMode);
    const identity = nativeAiUserImageKey(resolved);
    return Boolean(
      identity && readPersistedIdentityFallback(identity)?.sourceUrl,
    );
  });
  const [error, setError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [retryToken, setRetryToken] = useState(0);
  const retrySecureMedia = useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const isNative = Capacitor.isNativePlatform();
    // Desktop must remain same-origin. Supplying its persisted home/remote UI
    // preference here would incorrectly turn `/api/...` into a cross-origin
    // native endpoint. Only a Capacitor WebView needs explicit origin rebasing.
    const requestUrl = url
      ? resolveApiUrl(
          url,
          isNative ? useStore.getState().connectionMode : undefined,
        )
      : null;
    const fallbackRequestUrl = fallbackUrl
      ? resolveApiUrl(
          fallbackUrl,
          isNative ? useStore.getState().connectionMode : undefined,
        )
      : null;
    if (!requestUrl) {
      setSecureUrl(null);
      setCandidateSourceUrl(null);
      setLoading(false);
      setError(null);
      return;
    }
    const resolvedUrl = requestUrl;

    // Desktop browsers already share the board origin, cookies, cache, and
    // normal image decoding path. Native Capacitor is the only environment
    // that needs the authenticated HTTP bridge because its WebView origin is
    // separate from the selected home/remote backend.
    // Knowledge content uses module routes, which require a device signature.
    if (!isNative && !signedBrowserMedia) {
      setSecureUrl(resolvedUrl);
      setCandidateSourceUrl(resolvedUrl);
      setLoading(false);
      setError(null);
      return;
    }

    // If it's already a blob or data URL, don't do anything
    if (requestUrl.startsWith('blob:') || requestUrl.startsWith('data:')) {
      setSecureUrl(requestUrl);
      setCandidateSourceUrl(requestUrl);
      setLoading(false);
      setError(null);
      return;
    }

    const identityKey = nativeAiUserImageKey(resolvedUrl);
    const persistedIdentity = identityKey
      ? readPersistedIdentityFallback(identityKey)
      : null;
    const identityFallback = identityKey
      ? (lastNativeAvatarByIdentity.get(identityKey)?.entry ?? null)
      : null;
    const immediateFallback = immediateSecureMediaUrl(fallbackRequestUrl);

    // Streaming rows can briefly receive the canonical persona image without
    // its version query while participant metadata catches up. The native
    // cache is intentionally keyed by the exact versioned URL, so reuse the
    // last decoded image for that persona and wait for the canonical URL
    // instead of downloading an unversioned duplicate.
    if (identityFallback && !isVersionedImageThumbnail(resolvedUrl)) {
      setSecureUrl(identityFallback.secureUrl);
      setCandidateSourceUrl(
        lastNativeAvatarByIdentity.get(identityKey!)?.sourceUrl ?? resolvedUrl,
      );
      setLoading(false);
      setError(null);
      return;
    }
    if (
      identityKey &&
      !isVersionedImageThumbnail(resolvedUrl) &&
      immediateFallback
    ) {
      setSecureUrl(immediateFallback);
      setCandidateSourceUrl(fallbackRequestUrl);
      setLoading(false);
      setError(null);
      return;
    }
    if (
      identityKey &&
      !isVersionedImageThumbnail(resolvedUrl) &&
      persistedIdentity?.sourceUrl
    ) {
      let isMounted = true;
      let loadedSourceUrl = persistedIdentity.sourceUrl;
      setLoading(true);
      setError(null);
      void loadNativeAvatar(persistedIdentity.sourceUrl)
        .catch(() => {
          loadedSourceUrl = resolvedUrl;
          return loadNativeAvatar(resolvedUrl);
        })
        .then((entry) => {
          if (isMounted) {
            setSecureUrl(entry.secureUrl);
            setCandidateSourceUrl(loadedSourceUrl ?? resolvedUrl);
            setReloadToken((token) => token + 1);
          }
        })
        .catch((err) => {
          if (isMounted)
            setError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          if (isMounted) setLoading(false);
        });
      return () => {
        isMounted = false;
      };
    }
    if (
      identityKey &&
      !isVersionedImageThumbnail(resolvedUrl) &&
      persistedIdentity
    ) {
      // Legacy index entries do not carry the source URL needed for an
      // asynchronous filesystem validation. Keep their immediately decoded
      // fallback rather than clearing it and exposing an empty image.
      setSecureUrl(persistedIdentity.entry.secureUrl);
      setCandidateSourceUrl(persistedIdentity.sourceUrl ?? resolvedUrl);
      setLoading(false);
      setError(null);
      return;
    }
    if (
      identityKey &&
      !isVersionedImageThumbnail(resolvedUrl) &&
      fallbackRequestUrl &&
      isVersionedImageThumbnail(fallbackRequestUrl)
    ) {
      let isMounted = true;
      setLoading(true);
      setError(null);
      void loadNativeAvatar(fallbackRequestUrl)
        .then((fallback) => {
          if (isMounted) {
            setSecureUrl(fallback.secureUrl);
            setCandidateSourceUrl(fallbackRequestUrl);
            setReloadToken((token) => token + 1);
          }
        })
        .catch((err) => {
          if (isMounted)
            setError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          if (isMounted) setLoading(false);
        });
      return () => {
        isMounted = false;
      };
    }

    let isMounted = true;
    let objectUrl: string | null = null;
    // Keep the previous versioned avatar visible while a newly selected emote
    // is loaded. Clearing here made the native <img> temporarily lose its src,
    // exposing alt text between the streaming and canonical replay renderers.
    // Unversioned media still clears because its old URL may be revoked below.
    if (
      isVersionedImageThumbnail(resolvedUrl) &&
      persistedIdentity?.sourceUrl &&
      persistedIdentity.sourceUrl !== resolvedUrl
    ) {
      setSecureUrl(persistedIdentity.entry.secureUrl);
      setCandidateSourceUrl(persistedIdentity.sourceUrl ?? resolvedUrl);
    } else if (!isVersionedImageThumbnail(resolvedUrl) && !identityFallback)
      setSecureUrl(null);
    setLoading(true);
    setError(null);

    async function loadMedia() {
      try {
        if (isVersionedImageThumbnail(resolvedUrl)) {
          const cachedAvatar = await loadNativeAvatar(
            resolvedUrl,
            retryToken > 0,
          );
          if (isMounted) {
            setSecureUrl(cachedAvatar.secureUrl);
            setCandidateSourceUrl(resolvedUrl);
            setReloadToken((token) => token + 1);
          }
          return;
        }
        const response = await apiFetch(resolvedUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch media: ${response.status} ${response.statusText}`,
          );
        }
        const nativeMedia = getNativeBinaryDataUrl(response);
        if (nativeMedia) {
          console.debug('[SecureMedia] Native media ready', {
            path: new URL(resolvedUrl).pathname,
            contentType: nativeMedia.contentType,
            byteLength: nativeMedia.byteLength,
          });
          if (isMounted) {
            setSecureUrl(nativeMedia.url);
            setCandidateSourceUrl(resolvedUrl);
          }
          return;
        }
        const blob = await response.blob();
        console.debug('[SecureMedia] Blob media ready', {
          path: new URL(resolvedUrl, window.location.origin).pathname,
          contentType: blob.type,
          byteLength: blob.size,
        });
        if (isMounted) {
          objectUrl = URL.createObjectURL(blob);
          setSecureUrl(objectUrl);
          setCandidateSourceUrl(resolvedUrl);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          console.error('Error loading secure media:', err);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadMedia();

    return () => {
      isMounted = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [fallbackUrl, retryToken, url, signedBrowserMedia]);

  return {
    secureUrl,
    candidateSourceUrl,
    loading,
    error,
    reloadToken,
    retrySecureMedia,
  };
}
