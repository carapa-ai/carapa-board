import { Capacitor } from '@capacitor/core';
import { useStore } from '../store';

/**
 * On native platforms, we must use a full URL to reach the backend.
 * On web, we use an empty string so that relative paths (/api/...)
 * are handled by the Vite proxy (dev) or the same-origin server (prod).
 */
// Build-time defaults from .env; both are empty in a public build, which then
// has no server until the user sets one up (see `isServerConfigured`).
export const LOCAL_IP: string = import.meta.env.VITE_LOCAL_IP || '';

// VITE_API_URL (e.g. https://board.yourdomain.com) is the remote default.
const envUrl: string = import.meta.env.VITE_API_URL || '';

const DEFAULT_HOME_URL = LOCAL_IP ? `https://${LOCAL_IP}:3000` : '';
const DEFAULT_REMOTE_URL = envUrl || DEFAULT_HOME_URL;

/**
 * User-entered server addresses (native only). All fields are optional.
 * `homeCertSha256` / `remoteCertSha256` (64 lowercase hex) and `otaPublicKey`
 * (base64 of 32 bytes) are stored here. The pins are handed to native code
 * (`syncServerPins`) as an additional trust anchor for that one address.
 */
export interface ServerConfig {
  homeUrl?: string;
  remoteUrl?: string;
  homeCertSha256?: string;
  remoteCertSha256?: string;
  otaPublicKey?: string;
}

const SERVER_CONFIG_KEY = 'carapa-server-config';

/**
 * Validate and normalise a user-entered server address: https only, a host
 * with an optional port, no userinfo, path, query or fragment. Returns the
 * origin without a trailing slash.
 */
export function parseServerUrl(
  input: string,
): { url: string } | { error: string } {
  const raw = input.trim();
  const match = /^https:\/\/([^/?#@\\\s]+)\/?$/i.exec(raw);
  if (!match) {
    if (!/^https:\/\//i.test(raw)) return { error: 'Use an https:// address' };
    if (raw.includes('@')) return { error: 'Remove the user name or password' };
    return { error: 'Use only a host and optional port, without a path' };
  }
  try {
    const url = new URL(raw);
    if (!url.hostname || url.username || url.password) {
      return { error: 'Enter a valid host name' };
    }
    return { url: url.origin };
  } catch {
    return { error: 'Enter a valid address' };
  }
}

/** Validate a SHA-256 fingerprint (64 hex chars, any case); returns lowercase. */
export function parseCertSha256(input: unknown): string | null {
  return typeof input === 'string' && /^[0-9a-f]{64}$/i.test(input)
    ? input.toLowerCase()
    : null;
}

/** Validate a canonical base64 string that decodes to exactly 32 bytes. */
export function parseOtaPublicKey(input: unknown): string | null {
  if (typeof input !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(input)) {
    return null;
  }
  try {
    return btoa(atob(input)) === input && atob(input).length === 32
      ? input
      : null;
  } catch {
    return null;
  }
}

/** One-line trust state of an address, as shown next to it in the UI. */
export function describeCertPin(certSha256?: string): string {
  return certSha256
    ? `Pinned certificate: ${certSha256.slice(0, 8)}…${certSha256.slice(-8)}`
    : 'Needs a publicly trusted certificate or a CA installed on this device';
}

/** One-line description of the OTA key a config trusts for UI updates. */
export function describeOtaKey(otaPublicKey: string): string {
  return `UI updates signed by: ${otaPublicKey.slice(0, 8)}…`;
}

/** True when a pin or the OTA key differs between two configs. */
export function serverTrustChanged(a: ServerConfig, b: ServerConfig): boolean {
  return (
    a.homeCertSha256 !== b.homeCertSha256 ||
    a.remoteCertSha256 !== b.remoteCertSha256 ||
    a.otaPublicKey !== b.otaPublicKey
  );
}

const SERVER_LINK_PREFIX = 'carapaboard://server';

/**
 * Setup link for the Android app:
 * `carapaboard://server?v=1&home=…&remote=…[&homeCert=…&remoteCert=…&otaKey=…]`.
 */
export function buildServerLink(config: ServerConfig): string {
  const parts = ['v=1'];
  for (const key of ['home', 'remote'] as const) {
    const url = config[`${key}Url`];
    if (url) parts.push(`${key}=${encodeURIComponent(url)}`);
    const cert = config[`${key}CertSha256`];
    if (url && cert) parts.push(`${key}Cert=${cert}`);
  }
  if (config.otaPublicKey) {
    parts.push(`otaKey=${encodeURIComponent(config.otaPublicKey)}`);
  }
  return `${SERVER_LINK_PREFIX}?${parts.join('&')}`;
}

/**
 * Validate a setup link: only version 1, at least one of `home` / `remote`,
 * each run through `parseServerUrl`. Optional `homeCert` / `remoteCert` (need
 * their address) and `otaKey` must be valid or the whole link is rejected.
 * Unknown parameters are ignored. The link
 * is untrusted input (any app or page can fire it); callers must still ask
 * the user before applying it.
 */
export function parseServerLink(
  link: string,
): { config: ServerConfig } | { error: string } {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return { error: 'Not a server link' };
  }
  if (url.protocol !== 'carapaboard:' || url.hostname !== 'server') {
    return { error: 'Not a server link' };
  }
  if (url.searchParams.get('v') !== '1') {
    return { error: 'Unsupported server link version' };
  }
  const config: ServerConfig = {};
  for (const key of ['home', 'remote'] as const) {
    const value = url.searchParams.get(key);
    if (value === null) continue;
    const result = parseServerUrl(value);
    if ('error' in result) return { error: `${key}: ${result.error}` };
    config[`${key}Url`] = result.url;
  }
  if (!config.homeUrl && !config.remoteUrl) {
    return { error: 'The link has no server address' };
  }
  for (const key of ['home', 'remote'] as const) {
    const value = url.searchParams.get(`${key}Cert`);
    if (value === null) continue;
    if (!config[`${key}Url`]) {
      return { error: `${key}Cert: the link has no ${key} address` };
    }
    const cert = parseCertSha256(value);
    if (!cert) return { error: `${key}Cert: not a SHA-256 fingerprint` };
    config[`${key}CertSha256`] = cert;
  }
  const otaKey = url.searchParams.get('otaKey');
  if (otaKey !== null) {
    const key = parseOtaPublicKey(otaKey);
    if (!key) return { error: 'otaKey: not a 32-byte base64 public key' };
    config.otaPublicKey = key;
  }
  return { config };
}

function readStoredServerConfig(): ServerConfig {
  if (!Capacitor.isNativePlatform() || typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(SERVER_CONFIG_KEY) ?? '{}');
    const config: ServerConfig = {};
    for (const key of ['homeUrl', 'remoteUrl'] as const) {
      const value = parsed?.[key];
      const result = typeof value === 'string' ? parseServerUrl(value) : null;
      if (result && 'url' in result) config[key] = result.url;
    }
    for (const key of ['home', 'remote'] as const) {
      const cert = parseCertSha256(parsed?.[`${key}CertSha256`]);
      if (cert && config[`${key}Url`]) config[`${key}CertSha256`] = cert;
    }
    const otaKey = parseOtaPublicKey(parsed?.otaPublicKey);
    if (otaKey) config.otaPublicKey = otaKey;
    return config;
  } catch {
    return {};
  }
}

/**
 * A single configured URL serves both modes; nothing stored means the build-time
 * defaults. Both URLs are '' when there is neither (see `isServerConfigured`).
 */
export function resolveServerUrls(config: ServerConfig) {
  const homeUrl = config.homeUrl ?? config.remoteUrl;
  const remoteUrl = config.remoteUrl ?? config.homeUrl;
  if (homeUrl && remoteUrl) return { homeUrl, remoteUrl };
  return {
    homeUrl: DEFAULT_HOME_URL || DEFAULT_REMOTE_URL,
    remoteUrl: DEFAULT_REMOTE_URL,
  };
}

/**
 * False only on native when no address is stored and the build has no default:
 * a fresh install of a build without an operator's server. The web build talks
 * to its own origin and is always configured.
 */
export function isServerConfigured(): boolean {
  if (!Capacitor.isNativePlatform()) return true;
  return Boolean(resolveServerUrls(serverConfig).remoteUrl);
}

let serverConfig = readStoredServerConfig();
const initialUrls = resolveServerUrls(serverConfig);

// Live bindings: importers see the current value after a config change.
export let HOME_URL = initialUrls.homeUrl;
export let REMOTE_URL = initialUrls.remoteUrl;

const serverConfigListeners = new Set<() => void>();

// Bumped whenever the server config changes (or starts to). An async login that
// began under an older value must discard its result instead of storing it.
let serverConfigEpoch = 0;

export function getServerConfigEpoch(): number {
  return serverConfigEpoch;
}

/** Invalidate in-flight logins before credentials for the old server are wiped. */
export function invalidateServerConfigEpoch(): void {
  serverConfigEpoch++;
}

export async function clearSessionCookies(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const { CapacitorCookies } = await import('@capacitor/core');
  await CapacitorCookies.clearAllCookies();
}

// Native board requests that may still deliver a Set-Cookie. The platform
// cookie jar is outside the JS epoch checks and is not port-scoped, so a
// response from the old server must not land after the cookies were wiped.
const inFlightNative = new Set<Promise<void>>();

/** Register a native board request; a response outliving a server change wipes cookies again. */
export function trackNativeRequest<T>(request: Promise<T>): Promise<T> {
  if (!Capacitor.isNativePlatform()) return request;
  const epoch = serverConfigEpoch;
  const settled: Promise<void> = request
    .then(
      () => undefined,
      () => undefined,
    )
    .then(async () => {
      inFlightNative.delete(settled);
      if (epoch !== serverConfigEpoch) {
        await clearSessionCookies().catch(() => undefined);
      }
    });
  inFlightNative.add(settled);
  return request;
}

/** Wait (bounded) until native board requests finished, including ones started meanwhile. */
export async function drainNativeRequests(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlightNative.size > 0 && Date.now() < deadline) {
    await Promise.race([
      Promise.all([...inFlightNative]),
      new Promise((resolve) => setTimeout(resolve, deadline - Date.now())),
    ]);
  }
}

export function getServerConfig(): ServerConfig {
  return serverConfig;
}

export function subscribeServerConfig(listener: () => void): () => void {
  serverConfigListeners.add(listener);
  return () => serverConfigListeners.delete(listener);
}

/**
 * Persist the server config (null restores the app defaults) and apply it
 * immediately. Callers must wipe credentials for the old server first.
 */
export function setServerConfig(config: ServerConfig | null): void {
  serverConfigEpoch++;
  serverConfig = config ?? {};
  try {
    if (config && (config.homeUrl || config.remoteUrl)) {
      localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify(config));
    } else {
      localStorage.removeItem(SERVER_CONFIG_KEY);
    }
  } catch (e) {
    console.warn('[API] Failed to persist server config:', e);
  }
  ({ homeUrl: HOME_URL, remoteUrl: REMOTE_URL } =
    resolveServerUrls(serverConfig));
  updateApiBaseUrl(useStore.getState().connectionMode);
  serverConfigListeners.forEach((listener) => listener());
}

export function apiBaseUrlForMode(mode: 'home' | 'remote'): string {
  return mode === 'home' ? HOME_URL : REMOTE_URL;
}

/** Return the equivalent remote URL for a request aimed at the home server. */
export function remoteRetryUrlForEndpoints(
  url: string,
  homeUrl: string,
  remoteUrl: string,
): string | null {
  if (remoteUrl === homeUrl) return null;
  if (url === homeUrl) return remoteUrl;
  if (url.startsWith(`${homeUrl}/`)) {
    return `${remoteUrl}${url.slice(homeUrl.length)}`;
  }
  return null;
}

export function remoteRetryUrl(url: string): string | null {
  return remoteRetryUrlForEndpoints(url, HOME_URL, REMOTE_URL);
}

/**
 * Resolve a backend-owned URL against the selected native connection.
 *
 * Persisted media URLs can be relative or can contain the origin that was
 * active when the message was created. Rebase both home and remote URLs so a
 * connection-mode change never leaves images pinned to the stale endpoint.
 * External URLs (and local blob/data previews) are intentionally untouched.
 */
export function resolveApiUrl(url: string, mode?: 'home' | 'remote'): string {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return url;

  const baseUrl = mode ? apiBaseUrlForMode(mode) : API_BASE_URL;
  if (url.startsWith('/')) return `${baseUrl}${url}`;

  for (const knownBase of new Set([HOME_URL, REMOTE_URL])) {
    if (url === knownBase) return baseUrl;
    if (url.startsWith(`${knownBase}/`)) {
      return `${baseUrl}${url.slice(knownBase.length)}`;
    }
  }

  return url;
}

// --- Synchronous Store Initialization ---
// We read the persisted store directly from localStorage to ensure API_BASE_URL
// is correct even before the React app hydrates.
let initialMode: 'home' | 'remote' = 'remote';
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('carapa-ui-state');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.state?.connectionMode) {
        initialMode = parsed.state.connectionMode;
      }
    } catch (e) {
      console.warn('[API] Failed to parse initial network state:', e);
    }
  }
}

export let API_BASE_URL = Capacitor.isNativePlatform()
  ? apiBaseUrlForMode(initialMode)
  : '';

export function updateApiBaseUrl(mode: 'home' | 'remote') {
  if (Capacitor.isNativePlatform()) {
    API_BASE_URL = apiBaseUrlForMode(mode);
    console.log(`[API] Base URL updated to ${mode}: ${API_BASE_URL}`);
  }
}
