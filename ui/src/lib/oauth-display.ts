import type { OAuthAccess, OAuthGrantTarget } from '@/lib/api';

export function describeOAuthTarget(
  target: OAuthGrantTarget,
  name?: string,
): string {
  const label = name || target.folder;
  return target.kind === 'main' ? `Main workspace (${label})` : label;
}

export function describeOAuthAccess(access: OAuthAccess): string {
  return access === 'write' ? 'Read & write' : 'Read-only';
}

export function describeOAuthDays(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

/** Path of an MCP endpoint URL (`/mcp/carapa-board`), falling back to the input. */
export function oauthResourcePath(resource: string): string {
  try {
    return new URL(resource).pathname;
  } catch {
    return resource;
  }
}
