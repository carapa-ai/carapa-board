import { ENABLE_NGINX_PROXY } from '../config.js';
import { getSandboxClient, type SandboxClient } from '../lib/mcp-client.js';
import type { RegisteredGroup } from '../types.js';
import { resolveEffectiveSandbox } from './effective-settings.js';

function canonicalProxyHostnameAliases(
  aliases: string[] | undefined,
): string[] {
  return [
    ...new Set(
      (aliases ?? [])
        .map((hostname) => hostname.trim().toLowerCase().replace(/\.$/, ''))
        .filter(Boolean),
    ),
  ].sort();
}

export function proxyHostnameAliasesChanged(
  previous: string[] | undefined,
  next: string[] | undefined,
): boolean {
  const previousCanonical = canonicalProxyHostnameAliases(previous);
  const nextCanonical = canonicalProxyHostnameAliases(next);
  return (
    previousCanonical.length !== nextCanonical.length ||
    previousCanonical.some(
      (hostname, index) => hostname !== nextCanonical[index],
    )
  );
}

export function shouldSyncProxyHostnameAliases(
  settingsUpdate: Record<string, unknown>,
  previous: string[] | undefined,
  next: string[] | undefined,
): boolean {
  return (
    Object.hasOwn(settingsUpdate, 'proxyHostnameAliases') &&
    proxyHostnameAliasesChanged(previous, next)
  );
}

export async function syncProxyHostnameAliases(
  group: RegisteredGroup,
  client: Pick<SandboxClient, 'sandboxProxyAliases'> = getSandboxClient(),
  enabled = ENABLE_NGINX_PROXY,
): Promise<void> {
  if (!enabled) return;

  const effective = resolveEffectiveSandbox(group);
  const result = await client.sandboxProxyAliases(
    effective.stack,
    effective.proxyHostnameAliases,
    effective.instance,
  );
  if (result.isError) {
    throw new Error(
      result.stdout || 'CarapaBox rejected the proxy alias update',
    );
  }
}
