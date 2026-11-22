import { CARAPA_BOX_URL, CARAPA_BOX_API_TOKEN } from '../../config.js';
import type { ToolDefinition } from '../tools/types.js';
import { openRouterCredits, openRouterModelPrices } from './openrouter.js';

const UNAVAILABLE = JSON.stringify({ error: 'Provider usage unavailable' });

const iso = (epochMs: unknown): string | undefined =>
  typeof epochMs === 'number' && Number.isFinite(epochMs)
    ? new Date(epochMs).toISOString()
    : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Same bounds as the Box account fields (tier 1-40 chars, capacity 1-1000). */
const tierOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length >= 1 && value.length <= 40
    ? value
    : undefined;
const capacityOf = (value: unknown): number | undefined =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= 1000
    ? value
    : undefined;

/** Allow-listed projection of one Box usage entry; never copies other fields. */
function projectUsage(
  entry: any,
  capacity: number | undefined,
): {
  plan?: string;
  windows: Array<{
    label: string;
    usedPercent: number;
    resetsAt?: string;
    remainingCapacity?: number;
  }> | null;
  error?: string;
  fetchedAt?: string;
} {
  if (!entry || typeof entry !== 'object')
    return { windows: null, error: 'Usage unavailable' };
  const fetchedAt = iso(entry.fetchedAt);
  if (typeof entry.error === 'string')
    return { windows: null, error: entry.error, fetchedAt };
  const windows = Array.isArray(entry.windows)
    ? entry.windows.map((w: any) => {
        const usedPercent = Number(w?.usedPercent);
        const remaining =
          capacity !== undefined && Number.isFinite(usedPercent)
            ? Math.round((capacity * (100 - usedPercent)) / 100)
            : undefined;
        return {
          label: String(w?.label ?? ''),
          usedPercent,
          resetsAt: iso(w?.resetsAt),
          remainingCapacity: remaining,
        };
      })
    : null;
  return { plan: str(entry.plan), windows, fetchedAt };
}

type ProjectedUsage = ReturnType<typeof projectUsage>;

/** One connected provider account with its usage windows, as `get_provider_usage` reports it. */
export interface ProviderUsageAccount extends ProjectedUsage {
  provider?: string;
  label?: string;
  scope?: string;
  tier?: string;
  capacity?: number;
}

export interface ProviderUsageSnapshot {
  accounts: ProviderUsageAccount[];
  openRouter?: {
    credits?: Record<string, unknown>;
    modelPrices?: unknown;
  };
  fetchedAt?: string;
}

type BoxRequest = typeof fetch;
type BoxConfiguration = () => { url: string; token: string };

const defaultConfiguration: BoxConfiguration = () => ({
  url: CARAPA_BOX_URL,
  token: CARAPA_BOX_API_TOKEN,
});

/**
 * Read the Box provider accounts and their usage. Returns null when Box is
 * not configured or unreachable, or answers with an error.
 */
export async function fetchProviderUsage(
  request: BoxRequest = fetch,
  configuration: BoxConfiguration = defaultConfiguration,
  timeoutMs = 30_000,
): Promise<ProviderUsageSnapshot | null> {
  const { url, token } = configuration();
  if (!token) return null;
  const boxGet = async (path: string) => {
    const upstream = await request(new URL(path, url), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!upstream.ok) throw new Error('upstream');
    return upstream.json() as Promise<any>;
  };
  try {
    const [accountsBody, usageBody] = await Promise.all([
      boxGet('/api/admin/provider-accounts'),
      boxGet('/api/admin/provider-accounts/usage'),
    ]);
    const listing: any[] = Array.isArray(accountsBody)
      ? accountsBody
      : Array.isArray(accountsBody?.accounts)
        ? accountsBody.accounts
        : [];
    // Project integration keys (labelled with a project folder) are not AI provider accounts.
    const list = listing.filter((account) => account?.scope !== 'project');
    const usage = usageBody?.usage ?? {};
    let latest = 0;
    const accounts = list.map((account) => {
      const fetched = usage[account?.id]?.fetchedAt;
      if (typeof fetched === 'number' && fetched > latest) latest = fetched;
      const capacity = capacityOf(account?.capacity);
      return {
        provider: str(account?.provider),
        label: str(account?.label),
        scope: str(account?.scope),
        tier: tierOf(account?.tier),
        capacity,
        ...projectUsage(usage[account?.id], capacity),
      };
    });
    const credits = openRouterCredits(usageBody?.credits);
    const modelPrices = openRouterModelPrices(usageBody?.openRouterPrices);
    return {
      accounts,
      openRouter:
        credits || modelPrices
          ? {
              credits: credits && {
                ...credits,
                fetchedAt: iso(credits.fetchedAt),
              },
              modelPrices,
            }
          : undefined,
      fetchedAt: iso(latest || undefined),
    };
  } catch {
    return null;
  }
}

export function createGetProviderUsageTool(
  request: BoxRequest = fetch,
  configuration: BoxConfiguration = defaultConfiguration,
): ToolDefinition {
  return {
    name: 'get_provider_usage',
    description:
      'Read-only: subscription usage windows for the connected AI provider accounts (e.g. 5-hour, Weekly). ' +
      '`usedPercent` is 0-100, the share of that window already consumed; `resetsAt` is the ISO time at which the window resets. ' +
      'Percentages are not comparable across accounts. When an account has `capacity` (a relative size, e.g. 1000 for a large plan, 1 for a free tier), ' +
      'compare its window `remainingCapacity` instead. Accounts without `capacity` have unknown size. ' +
      'Do not move background work onto an account just because its percentage is low; accounts with a small capacity (e.g. <= 10) are for deliberate small use only. ' +
      'An account with `windows: null` and an `error` has no usable data. ' +
      '`openRouter` covers OpenRouter, which is prepaid credits rather than a subscription: `credits` is the balance in US dollars ' +
      '(`remaining` = `totalCredits` - `totalUsage`; it does not reset), and `modelPrices` lists each OpenRouter model Board offers with its ' +
      'price in US dollars per million tokens (`inputPerMillion`, `outputPerMillion`, `cacheReadPerMillion`). A price of 0 is a free model. ' +
      'Prefer cheaper models for background work, and avoid costly ones when `remaining` is low.',
    inputSchema: {},
    requiredPermissions: ['tasks:read'],
    handler: async () => {
      const snapshot = await fetchProviderUsage(request, configuration);
      return snapshot ? JSON.stringify(snapshot) : UNAVAILABLE;
    },
  };
}

export const getProviderUsageTool = createGetProviderUsageTool();
