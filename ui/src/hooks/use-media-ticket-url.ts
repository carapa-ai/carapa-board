import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { withMediaTicket } from '@/lib/api';
import { resolveApiUrl } from '@/lib/api-config';
import { useStore } from '@/store';

/**
 * A streamable URL for a board file: the resolved URL with a short-lived media
 * ticket, so a bare <video>/<audio src> plays it with Range requests instead of
 * downloading it through the native bridge. `url` is null while pending and
 * when the board issues no ticket for this URL.
 */
export function useMediaTicketUrl(url: string | null): {
  url: string | null;
  pending: boolean;
} {
  const [ticketed, setTicketed] = useState<{
    source: string;
    url: string | null;
  } | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const resolved = resolveApiUrl(
      url,
      Capacitor.isNativePlatform()
        ? useStore.getState().connectionMode
        : undefined,
    );
    void withMediaTicket(resolved).then((streamUrl) => {
      if (!cancelled) setTicketed({ source: url, url: streamUrl });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!url) return { url: null, pending: false };
  if (ticketed?.source !== url) return { url: null, pending: true };
  return { url: ticketed.url, pending: false };
}
