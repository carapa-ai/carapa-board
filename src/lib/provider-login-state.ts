/**
 * Which provider accounts need a new login, from the CarapaBox
 * provider-accounts listing. The kanban queue holds cards whose harness needs
 * such a provider instead of starting runs that can only fail.
 *
 * A provider is "login required" when the listing has accounts for it and none
 * is `connected` or `refreshPending`. A provider with no account (API-key-only
 * or local routes) is never held, and neither is anything while the listing
 * cannot be fetched, so a Box outage cannot freeze the board.
 */
import { CARAPA_BOX_API_TOKEN, CARAPA_BOX_URL } from '../config.js';
import { logger } from '../logger.js';

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const USABLE_STATES = new Set(['connected', 'refreshPending']);

/** Providers whose accounts are all `loginRequired` in the latest listing. */
let loginRequired: ReadonlySet<string> = new Set();
/** The same from the last listing that could be fetched; survives a Box outage. */
let lastKnownRequired: ReadonlySet<string> = new Set();
let fetchedAt = 0;
let listingSeq = 0;
let inflight: Promise<boolean> | null = null;

/**
 * Providers a run reported "No credentials configured for" while the listing
 * could not be fetched, mapped to the listing sequence they were flagged at.
 * Any later listing that does not show the provider needing a login releases
 * them.
 */
const credentialHolds = new Map<string, number>();
/** Providers whose current outage already produced a user notification. */
const notifiedOutages = new Map<string, number>();
const reconnectListeners = new Set<(provider: string) => void>();

/** Call `listener` whenever a held provider becomes usable again. */
export function onProviderReconnected(
  listener: (provider: string) => void,
): void {
  reconnectListeners.add(listener);
}

/** Forget the outage of `provider` and tell listeners to release its cards. */
function notifyProviderReconnected(provider: string): void {
  credentialHolds.delete(provider);
  notifiedOutages.delete(provider);
  for (const listener of reconnectListeners) {
    try {
      listener(provider);
    } catch (err) {
      logger.warn({ err, provider }, 'Provider reconnect listener failed');
    }
  }
}

/**
 * Record a listing as the current provider state. A provider the queue was
 * holding that is usable now is reconnected: its cards are released.
 */
export function ingestProviderListing(listing: any): void {
  const accounts: any[] = Array.isArray(listing)
    ? listing
    : Array.isArray(listing?.accounts)
      ? listing.accounts
      : [];
  const listed = new Set<string>();
  const connected = new Set<string>();
  for (const account of accounts) {
    if (typeof account?.provider !== 'string') continue;
    listed.add(account.provider);
    if (USABLE_STATES.has(account.state)) connected.add(account.provider);
  }
  const wasRequired = lastKnownRequired;
  loginRequired = lastKnownRequired = new Set(
    [...listed].filter((p) => !connected.has(p)),
  );
  fetchedAt = Date.now();
  listingSeq += 1;
  // A routine refreshPending -> connected refresh holds nothing, so it is not
  // a reconnect. A provider whose accounts were all removed is no longer in
  // outage either, so its hold and notification are released the same way.
  const reconnected = new Set(
    [...wasRequired].filter(
      (provider) => connected.has(provider) || !listed.has(provider),
    ),
  );
  // A flag set while Box was unreachable yields to any newer listing: a
  // provider it lists as needing a login is held by the listing itself, and
  // any other (usable, or without accounts) is released.
  for (const [provider, seq] of [...credentialHolds]) {
    if (seq >= listingSeq) continue;
    if (loginRequired.has(provider)) credentialHolds.delete(provider);
    else reconnected.add(provider);
  }
  for (const provider of reconnected) notifyProviderReconnected(provider);
}

/** The current listing from Box, or null when it cannot be fetched. */
export async function fetchProviderListing(): Promise<any | null> {
  if (!CARAPA_BOX_API_TOKEN) return null;
  try {
    const response = await fetch(
      new URL('/api/admin/provider-accounts', CARAPA_BOX_URL),
      {
        headers: { Authorization: `Bearer ${CARAPA_BOX_API_TOKEN}` },
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Fetch and record the listing; false when it cannot be fetched. */
async function refreshListing(): Promise<boolean> {
  inflight ??= (async () => {
    const listing = await fetchProviderListing();
    if (listing) ingestProviderListing(listing);
    else {
      loginRequired = new Set();
      fetchedAt = Date.now();
    }
    return !!listing;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Providers the queue must not start cards for. The listing is cached for
 * about a minute.
 */
export async function getProviderLoginHolds(): Promise<ReadonlySet<string>> {
  if (Date.now() - fetchedAt >= CACHE_TTL_MS) await refreshListing();
  return new Set([...loginRequired, ...credentialHolds.keys()]);
}

/**
 * A run ended with "No credentials configured for <provider>". Refresh the
 * listing, then report whether the queue will hold the provider's cards.
 * - The listing shows the provider needing a login: held until it is usable.
 * - The listing cannot be fetched: held until a later listing no longer shows
 *   it needing a login. Without a Box token no listing can arrive, so no hold.
 * - The listing shows a usable account: not held. A hold no listing would
 *   ever release would freeze the provider, and a released one would restart
 *   the card at once and fail it again without limit.
 */
export async function holdProviderForCredentialError(
  provider: string,
): Promise<boolean> {
  if (!(await refreshListing())) {
    if (!CARAPA_BOX_API_TOKEN) return false;
    credentialHolds.set(provider, listingSeq);
    return true;
  }
  return loginRequired.has(provider);
}

/**
 * Start time of the provider's outage the first time it is claimed, null
 * afterwards, so one notification covers every card the outage holds.
 */
export function claimOutageNotification(provider: string): number | null {
  if (notifiedOutages.has(provider)) return null;
  const startedAt = Date.now();
  notifiedOutages.set(provider, startedAt);
  return startedAt;
}

/** Let a failed notification be retried by the next hold of this provider. */
export function releaseOutageNotification(provider: string): void {
  notifiedOutages.delete(provider);
}
