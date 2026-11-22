import { useEffect, useRef, useState } from 'react';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { toast } from 'sonner';
import { confirmAction } from '@/components/confirm-dialog';
import {
  type ServerConfig,
  describeCertPin,
  describeOtaKey,
  parseServerLink,
} from '@/lib/api-config';
import { useAuth } from '@/lib/auth';
import {
  ServerChangeIncompleteError,
  applyServerConfig,
} from '@/lib/server-config';

const HANDLED_LAUNCH_URL_KEY = 'carapa-handled-launch-url';

/**
 * True unless the app is confirmed signed out. If the startup check failed
 * (server unreachable) a persisted user still counts as signed in; without
 * one (first run, wrong address) the link is the way to fix the server.
 */
function serverChangeBlocked(): boolean {
  const { authenticated, authRequired, user, signingIn } = useAuth.getState();
  return (
    authenticated ||
    authRequired === false ||
    (authRequired === null && user !== null) ||
    signingIn
  );
}

/** Dialog lines for one address and whether its certificate is pinned. */
function addressLines(label: string, url?: string, certSha256?: string) {
  if (!url) return [];
  return [`${label}: ${url}`, describeCertPin(certSha256)];
}

/** Everything the dialog shows about what the link would apply. */
function describeServerConfig(config: ServerConfig): string {
  return [
    'A link asks this app to connect to:',
    ...addressLines('Home / LAN', config.homeUrl, config.homeCertSha256),
    ...addressLines('Remote', config.remoteUrl, config.remoteCertSha256),
    config.otaPublicKey && describeOtaKey(config.otaPublicKey),
    'Saved logins are removed. Only continue if you trust this server.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Handle a `carapaboard://server?...` setup link. The link is untrusted (any
 * app or page can fire it): it never changes a signed-in app, and a signed-out
 * app only switches after the user confirms the full origins.
 */
async function handleServerLink(link: string) {
  const result = parseServerLink(link);
  if ('error' in result) {
    toast.error(`Invalid server link: ${result.error}`);
    return;
  }
  const notice = () =>
    toast.info('The server can only be changed after signing out.');
  if (serverChangeBlocked()) return notice();

  const confirmed = await confirmAction(describeServerConfig(result.config), {
    title: 'Use this server?',
    confirmLabel: 'Use this server',
  });
  if (!confirmed) return;
  // The user may have signed in while the dialog was open.
  if (serverChangeBlocked()) return notice();
  // Held until the reload: the login form refuses to start meanwhile.
  useAuth.getState().setServerChanging(true);
  try {
    await applyServerConfig(result.config);
    // Restart from a clean state against the new server.
    window.location.reload();
  } catch (err) {
    console.error('Server link failed:', err);
    if (err instanceof ServerChangeIncompleteError) {
      // Startup recovery retries behind a blocking screen.
      window.location.reload();
      return;
    }
    useAuth.getState().setServerChanging(false);
    toast.error(
      'Could not remove the saved device credentials, so the server was not changed. Try again or restart the app.',
    );
  }
}

/** Mount once near the app root; listens for setup links on Android. */
export function ServerLinkHandler() {
  const checking = useAuth((s) => s.checking);
  const [link, setLink] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    const open = (url?: string) => {
      if (url && !cancelled) setLink((current) => current ?? url);
    };
    const listener = App.addListener('appUrlOpen', ({ url }) => open(url));
    // The launch URL stays available after a WebView reload; offer it once.
    void App.getLaunchUrl().then((launch) => {
      if (!launch?.url) return;
      if (sessionStorage.getItem(HANDLED_LAUNCH_URL_KEY) === launch.url) return;
      sessionStorage.setItem(HANDLED_LAUNCH_URL_KEY, launch.url);
      open(launch.url);
    });
    return () => {
      cancelled = true;
      void listener.then((handle) => handle.remove());
    };
  }, []);

  // Wait for the first auth check so a signed-in user is never prompted.
  useEffect(() => {
    if (!link || checking || busy.current) return;
    busy.current = true;
    void handleServerLink(link).finally(() => {
      busy.current = false;
      setLink(null);
    });
  }, [link, checking]);

  return null;
}
