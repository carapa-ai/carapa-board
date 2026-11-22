import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { Capacitor } from '@capacitor/core';
import { useSecureMedia } from '@/hooks/use-secure-media';
import { rollbackNativeAvatarIdentity } from '@/hooks/use-secure-media';
import { resolveApiUrl } from '@/lib/api-config';
import {
  aiUserImageKey,
  cacheBrowserImage,
  decodedBrowserImages,
  lastBrowserImageByIdentity,
} from '@/lib/browser-image-cache';

type SecureImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string;
  fallbackSrc?: string;
};

function BrowserSecureImage({
  src,
  fallbackSrc,
  onLoad,
  ...props
}: SecureImageProps) {
  const resolvedSrc = resolveApiUrl(src);
  const resolvedFallbackSrc = fallbackSrc ? resolveApiUrl(fallbackSrc) : null;
  const identityKey = aiUserImageKey(resolvedSrc);
  const fallbackIdentityKey = resolvedFallbackSrc
    ? aiUserImageKey(resolvedFallbackSrc)
    : null;
  const [displayedSrc, setDisplayedSrc] = useState(
    () =>
      (identityKey && lastBrowserImageByIdentity.get(identityKey)) ||
      (fallbackIdentityKey &&
        lastBrowserImageByIdentity.get(fallbackIdentityKey)) ||
      resolvedFallbackSrc ||
      resolvedSrc,
  );
  const previousIdentityRef = useRef(identityKey);
  useEffect(() => {
    if (previousIdentityRef.current === identityKey) return;
    previousIdentityRef.current = identityKey;
    setDisplayedSrc(
      (identityKey && lastBrowserImageByIdentity.get(identityKey)) ||
        resolvedFallbackSrc ||
        resolvedSrc,
    );
  }, [identityKey, resolvedFallbackSrc, resolvedSrc]);
  const unresolvedPersonaUrl =
    Boolean(identityKey) && !new URL(resolvedSrc, window.location.origin).searchParams.has('v');

  useEffect(() => {
    if (displayedSrc === resolvedSrc) return;
    if (unresolvedPersonaUrl && identityKey && displayedSrc !== resolvedFallbackSrc)
      return;
    if (decodedBrowserImages.has(resolvedSrc)) {
      setDisplayedSrc(resolvedSrc);
      return;
    }
    let cancelled = false;
    const nextImage = new Image();
    nextImage.onload = () => {
      void nextImage.decode().then(() => {
        if (cancelled) return;
        decodedBrowserImages.add(resolvedSrc);
        if (identityKey) cacheBrowserImage(identityKey, resolvedSrc);
        setDisplayedSrc(resolvedSrc);
      }).catch(() => undefined);
    };
    nextImage.onerror = () => {
      if (cancelled) return;
      // Keep the previous successfully rendered avatar visible.
    };
    nextImage.src = resolvedSrc;
    return () => {
      cancelled = true;
      nextImage.onload = null;
      nextImage.onerror = null;
    };
  }, [displayedSrc, identityKey, resolvedFallbackSrc, resolvedSrc, unresolvedPersonaUrl]);

  return (
    <img
      {...props}
      src={displayedSrc}
      onLoad={(event) => {
        decodedBrowserImages.add(displayedSrc);
        const displayedIdentityKey = aiUserImageKey(displayedSrc);
        if (displayedIdentityKey) cacheBrowserImage(displayedIdentityKey, displayedSrc);
        onLoad?.(event);
      }}
    />
  );
}

/**
 * An authenticated, connection-aware image for backend-owned media.
 * Blob/data URLs and external public URLs also work through the same surface.
 */
function NativeSecureImage({
  src,
  fallbackSrc,
  onError,
  ...props
}: SecureImageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const decodedUrlRef = useRef<string | null>(null);
  const retriedInitialCandidateRef = useRef(false);
  // Persona thumbnails may already be available synchronously from the native
  // memory cache. Ask the hook immediately so a newly mounted streaming row
  // never exposes an empty image while its observer waits to intersect.
  const isPersonaImage = /\/api\/ai-users\/[^/]+\/(?:avatar|emotes\/)/.test(
    src,
  );
  const [shouldLoad, setShouldLoad] = useState(
    () => isPersonaImage || typeof IntersectionObserver === 'undefined',
  );
  const {
    secureUrl,
    candidateSourceUrl,
    loading,
    error,
    reloadToken,
    retrySecureMedia,
  } =
    useSecureMedia(shouldLoad ? src : null, fallbackSrc);
  const [displayUrl, setDisplayUrl] = useState<string | null>(secureUrl);
  const sourceIdentity = (() => {
    try {
      const path = new URL(src, window.location.origin).pathname;
      return path.match(/^\/api\/ai-users\/[^/]+\/(?:avatar|emotes\/[^/]+)/)?.[0] ?? src;
    } catch {
      return src;
    }
  })();
  const previousSourceIdentity = useRef(sourceIdentity);
  useEffect(() => {
    if (previousSourceIdentity.current === sourceIdentity) return;
    previousSourceIdentity.current = sourceIdentity;
    decodedUrlRef.current = null;
    retriedInitialCandidateRef.current = false;
    setDisplayUrl(null);
    setDecodeFailed(false);
  }, [sourceIdentity]);
  useEffect(() => {
    if (secureUrl && secureUrl !== decodedUrlRef.current) setDisplayUrl(secureUrl);
  }, [secureUrl]);
  useEffect(() => {
    if (!decodeFailed || !secureUrl || reloadToken === 0) return;
    if (decodedUrlRef.current || reloadToken < 1) return;
    setDisplayUrl(null);
    const retry = setTimeout(() => setDisplayUrl(secureUrl), 0);
    return () => clearTimeout(retry);
  }, [decodeFailed, reloadToken, secureUrl]);

  useEffect(() => {
    if (shouldLoad || typeof IntersectionObserver === 'undefined') return;
    const image = imageRef.current;
    if (!image) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: '256px' },
    );
    observer.observe(image);
    return () => observer.disconnect();
  }, [shouldLoad]);

  const sourcePath = (() => {
    try {
      return new URL(src, window.location.origin).pathname;
    } catch {
      return '<invalid-url>';
    }
  })();

  return (
    <img
      {...props}
      ref={imageRef}
      src={displayUrl ?? undefined}
      alt={displayUrl ? props.alt : ''}
      aria-busy={loading || undefined}
      style={{
        ...props.style,
        ...((loading && (!displayUrl || reloadToken === 0)) || decodeFailed
          ? { visibility: 'hidden' as const }
          : undefined),
        ...(displayUrl && !decodeFailed ? { visibility: 'visible' as const } : undefined),
      }}
      data-media-error={error ? 'true' : undefined}
      onLoad={(event) => {
        setDecodeFailed(false);
        decodedUrlRef.current = displayUrl;
        setDisplayUrl(displayUrl);
        console.debug('[SecureImage] Native image decoded', {
          path: sourcePath,
          naturalWidth: event.currentTarget.naturalWidth,
          naturalHeight: event.currentTarget.naturalHeight,
        });
        props.onLoad?.(event);
      }}
      onError={(event) => {
        if (decodedUrlRef.current) {
          setDisplayUrl(decodedUrlRef.current);
          setDecodeFailed(false);
        } else {
          setDecodeFailed(true);
          if (!decodedUrlRef.current && !retriedInitialCandidateRef.current) {
            retriedInitialCandidateRef.current = true;
            retrySecureMedia();
          }
        }
        rollbackNativeAvatarIdentity(candidateSourceUrl ?? src);
        console.error('[SecureImage] Native image decode failed', {
          path: sourcePath,
          hasSecureUrl: Boolean(secureUrl),
        });
        onError?.(event);
      }}
    />
  );
}

export function SecureImage({ src, ...props }: SecureImageProps) {
  if (!Capacitor.isNativePlatform()) {
    return <BrowserSecureImage {...props} src={src} />;
  }
  return <NativeSecureImage {...props} src={src} />;
}
