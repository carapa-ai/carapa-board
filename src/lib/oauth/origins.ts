/**
 * Public-origin allowlist for MCP OAuth. The issuer / resource origin is never
 * derived from request headers alone: a request maps to an origin only when its
 * host matches an entry of `CARAPA_BOARD_PUBLIC_ORIGINS`. With the variable
 * unset (or no match) every OAuth surface behaves as if it did not exist.
 */
import type { Request } from 'express';
import { logger } from '../../logger.js';

/** MCP endpoints an OAuth token may be used on (lowercase, no trailing slash). */
const OAUTH_MCP_PATHS = ['/mcp/carapa-board'] as const;

/** Resource names that may be requested. */
const OAUTH_RESOURCE_NAMES = ['carapa-board'] as const;

export function configuredPublicOrigins(): string[] {
  const out = new Set<string>();
  for (const raw of (process.env.CARAPA_BOARD_PUBLIC_ORIGINS ?? '').split(
    ',',
  )) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      const url = new URL(entry);
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new Error();
      out.add(url.origin);
    } catch {
      logger.warn(
        { entry },
        'Ignoring invalid CARAPA_BOARD_PUBLIC_ORIGINS entry',
      );
    }
  }
  return [...out];
}

const firstHeader = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)
    ?.split(',')[0]
    ?.trim()
    .toLowerCase();

/**
 * The allowlisted origin that serves this request, or null. The request host
 * (X-Forwarded-Host when a proxy supplies one, else Host) selects an allowlist
 * entry; the returned origin always comes from the allowlist itself.
 */
export function resolvePublicOrigin(req: Request): string | null {
  const host =
    firstHeader(req.headers['x-forwarded-host']) ??
    firstHeader(req.headers.host);
  if (!host) return null;
  return (
    configuredPublicOrigins().find((o) => new URL(o).host === host) ?? null
  );
}

/** Normalised lowercase path without trailing slashes ("" for root). */
function normalizeRoutePath(path: string): string {
  return path.toLowerCase().replace(/\/+$/, '');
}

export function isOAuthMcpPath(path: string): boolean {
  return (OAUTH_MCP_PATHS as readonly string[]).includes(
    normalizeRoutePath(path),
  );
}

/** PRM URL advertised in `WWW-Authenticate` for an MCP endpoint path. */
export function protectedResourceMetadataUrl(
  origin: string,
  mcpPath: string,
): string {
  const p = normalizeRoutePath(mcpPath);
  return `${origin}/.well-known/oauth-protected-resource${p}`;
}

/** The `resource` value for an MCP resource name on `origin`. */
export function resourceUrl(origin: string, name: string): string {
  return `${origin}/mcp/${name}`;
}

/** True iff `resource` is exactly `<origin>/mcp/<known resource name>`. */
export function isValidResourceForOrigin(
  resource: string,
  origin: string,
): boolean {
  return OAUTH_RESOURCE_NAMES.some((n) => resource === resourceUrl(origin, n));
}

export function originOfResource(resource: string): string | null {
  try {
    return new URL(resource).origin;
  } catch {
    return null;
  }
}
