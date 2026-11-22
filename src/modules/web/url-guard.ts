// Required Notice: Copyright Regun Software SRL (https://carapa.ai)

/**
 * Outbound URL guard for web_view.
 *
 * web_view fetches whatever URL an agent (or read-only OAuth client) supplies,
 * from inside the board process. Without a guard that reaches file:// paths,
 * loopback services, the container network and cloud metadata endpoints. This
 * module only admits http(s) URLs whose host resolves exclusively to public
 * addresses, and re-validates every redirect hop.
 *
 * Only the TARGET URL is checked. HTTP_PROXY / HTTPS_PROXY / NO_PROXY are left
 * to the runtime, so fetches keep routing through the configured egress proxy.
 *
 * Known residual risks (not covered by a pre-resolve check):
 * - DNS rebinding: the name may resolve differently between this check and the
 *   runtime's own lookup when it connects.
 * - Targets resolved by an upstream proxy: when a proxy performs the lookup,
 *   the address it connects to is not the one validated here.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type WebFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

/** Resolve a hostname to every address (IPv4 and IPv6) it maps to. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );

/** Thrown for a URL that must not be fetched. Carries only a reason category. */
export class BlockedUrlError extends Error {
  constructor(
    readonly reason: string,
    readonly scheme: string,
  ) {
    super(`web_view refused URL: ${reason}`);
    this.name = 'BlockedUrlError';
  }
}

// [network address, prefix length]
const BLOCKED_IPV4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15
  [0xe0000000, 4], // 224.0.0.0/4
  [0xf0000000, 4], // 240.0.0.0/4 (includes 255.255.255.255)
];

function parseIPv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isBlockedIPv4Value(value: number): boolean {
  return BLOCKED_IPV4.some(([base, prefix]) => {
    const size = 2 ** (32 - prefix);
    return value >= base && value < base + size;
  });
}

/** Parse an IPv6 literal into eight 16-bit groups, or null when malformed. */
function parseIPv6(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  // Fold a trailing dotted IPv4 part into two hex groups.
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (chunk: string): number[] | null => {
    if (chunk === '') return [];
    const groups: number[] = [];
    for (const piece of chunk.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isBlockedIPv6(address: string): boolean {
  const groups = parseIPv6(address);
  if (!groups) return true; // unparseable: fail closed

  const leadingZero = groups.slice(0, 5).every((group) => group === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses are
  // judged by their embedded IPv4 address; :: and ::1 fall out as 0.0.0.0/8.
  if (leadingZero && (groups[5] === 0xffff || groups[5] === 0)) {
    return isBlockedIPv4Value(groups[6] * 0x10000 + groups[7]);
  }

  const embeddedV4 = (high: number, low: number) =>
    isBlockedIPv4Value(high * 0x10000 + low);
  const zeroTo = (end: number) =>
    groups.slice(0, end).every((group) => group === 0);

  // IPv4-translated (SIIT, ::ffff:0:a.b.c.d) and NAT64 (64:ff9b::/96) carry the
  // IPv4 address in the last 32 bits.
  if (zeroTo(4) && groups[4] === 0xffff && groups[5] === 0) {
    return embeddedV4(groups[6], groups[7]);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    // 64:ff9b:1::/48 is local-use NAT64 whose IPv4 sits at prefix-dependent
    // offsets; refuse it outright.
    if (groups[2] === 1) return true;
    if (
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0
    ) {
      return embeddedV4(groups[6], groups[7]);
    }
  }
  // 6to4 (2002::/16) carries the IPv4 address in bits 16-47.
  if (groups[0] === 0x2002) return embeddedV4(groups[1], groups[2]);
  // Teredo (2001::/32) tunnels over IPv4 and is deprecated; refuse it outright.
  if (groups[0] === 0x2001 && groups[1] === 0) return true;

  return (
    (groups[0] & 0xfe00) === 0xfc00 || // fc00::/7
    (groups[0] & 0xffc0) === 0xfe80 || // fe80::/10
    groups[0] >> 8 === 0xff // ff00::/8
  );
}

/** True when the literal IPv4/IPv6 address is loopback, private, reserved or multicast. */
function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = parseIPv4(address);
    return value === null || isBlockedIPv4Value(value);
  }
  if (family === 6) return isBlockedIPv6(address);
  return true; // not an IP at all: fail closed
}

/**
 * Validate that `url` is a credential-free http(s) URL whose host is public.
 * Hostnames are resolved and rejected when ANY address is blocked, or when the
 * lookup fails or returns nothing.
 */
export async function assertPublicHttpUrl(
  url: string,
  resolve: Resolver = defaultResolver,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedUrlError('invalid URL', 'invalid');
  }

  const scheme = parsed.protocol.replace(/:$/, '');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedUrlError('only http and https URLs are allowed', scheme);
  }
  if (parsed.username || parsed.password) {
    throw new BlockedUrlError('URLs with credentials are not allowed', scheme);
  }

  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!hostname) throw new BlockedUrlError('URL has no host', scheme);

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new BlockedUrlError('private or reserved address', scheme);
    }
    return parsed;
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new BlockedUrlError('localhost is not allowed', scheme);
  }

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new BlockedUrlError('host could not be resolved', scheme);
  }
  if (addresses.length === 0) {
    throw new BlockedUrlError('host could not be resolved', scheme);
  }
  if (addresses.some(isBlockedAddress)) {
    throw new BlockedUrlError('host resolves to a private address', scheme);
  }
  return parsed;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

/**
 * Wrap `inner` so every request, and every redirect hop it follows, passes
 * assertPublicHttpUrl. Redirects are followed here (never by the runtime). A
 * caller that asks for `redirect: 'manual'` gets the 3xx response back after
 * the request URL is validated, and validates the next hop by calling again.
 */
export function createGuardedFetch(
  inner: WebFetch,
  resolve: Resolver = defaultResolver,
  maxRedirects = 5,
): WebFetch {
  return async (input, init) => {
    let current = requestUrl(input);
    let currentInit = init;
    const callerFollowsManually = init?.redirect === 'manual';

    for (let hops = 0; ; hops += 1) {
      const validated = await assertPublicHttpUrl(current, resolve);
      const res = await inner(validated.toString(), {
        ...currentInit,
        redirect: 'manual',
      });
      if (callerFollowsManually) return res;

      const location = res.headers.get('location');
      if (!REDIRECT_STATUSES.has(res.status) || !location) {
        if (hops > 0 && !res.url) {
          // Keep the last validated URL visible for finalUrl logic.
          Object.defineProperty(res, 'url', { value: validated.toString() });
        }
        return res;
      }

      await res.body?.cancel().catch(() => undefined);
      if (hops >= maxRedirects) {
        throw new BlockedUrlError(
          `more than ${maxRedirects} redirects`,
          validated.protocol.replace(/:$/, ''),
        );
      }
      try {
        current = new URL(location, validated).toString();
      } catch {
        throw new BlockedUrlError('redirect target is invalid', 'invalid');
      }
      if (res.status === 303) {
        currentInit = { ...currentInit, method: 'GET', body: undefined };
      }
    }
  };
}
