/**
 * Capacity-aware choice among the cross-provider candidates of one Auto tier.
 * Usage comes from Box (the same fetch behind `get_provider_usage`) and is
 * cached briefly; whenever it is missing the first candidate wins, as it did
 * before capacity was considered.
 */

import { logger } from '../../logger.js';
import {
  fetchProviderUsage,
  type ProviderUsageAccount,
  type ProviderUsageSnapshot,
} from './tools.js';

/** Provider account that serves each harness. Unlisted harnesses have unknown capacity. */
export const HARNESS_PROVIDER: Readonly<Record<string, string>> = {
  claude: 'anthropic',
  codex: 'codex',
  antigravity: 'antigravity',
  muse: 'meta',
  grok: 'xai',
  cursor: 'cursor',
};

/** A candidate is skipped once any window of its account is this used. */
const CAPACITY_SKIP_PERCENT = 95;

export type CapacityReason =
  | 'most-remaining'
  | 'unknown-capacity'
  | 'capacity-exhausted'
  | 'usage-unavailable';

export interface CapacityChoice<T> {
  candidate: T;
  /** Absent when the tier has a single candidate, so nothing was chosen. */
  capacityReason?: CapacityReason;
  /** Remaining capacity of the chosen account's shortest window, when known. */
  remainingCapacity?: number;
}

type UsageWindow = NonNullable<ProviderUsageAccount['windows']>[number];

const HOURS: Record<string, number> = {
  hour: 1,
  day: 24,
  daily: 24,
  week: 168,
  weekly: 168,
  month: 720,
  monthly: 720,
};

/** Window length in hours parsed from its label ("5-hour", "Weekly"); unparseable labels sort last. */
function windowHours(label: string): number {
  const match = /^\s*(?:(\d+(?:\.\d+)?)[\s-]*)?([a-z]+)/i.exec(label);
  const unit = match?.[2]?.toLowerCase().replace(/s$/, '');
  const hours = unit ? HOURS[unit] : undefined;
  if (hours === undefined) return Infinity;
  return (match?.[1] ? Number(match[1]) : 1) * hours;
}

const resetTime = (window: UsageWindow): number => {
  const time = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return Number.isFinite(time) ? time : Infinity;
};

/** Shortest window of the account; the one that resets first breaks a length tie. */
function shortestWindow(windows: UsageWindow[]): UsageWindow {
  return windows.reduce((best, next) => {
    const byLength = windowHours(next.label) - windowHours(best.label);
    return byLength < 0 || (byLength === 0 && resetTime(next) < resetTime(best))
      ? next
      : best;
  });
}

interface CandidateUsage {
  index: number;
  exhausted: boolean;
  remaining?: number;
  resetsAt: number;
}

/** The account of the harness's provider, preferring one that reports usage. */
function accountFor(
  harnessId: string,
  accounts: ProviderUsageAccount[],
): ProviderUsageAccount | undefined {
  const provider = HARNESS_PROVIDER[harnessId];
  const own = accounts.filter((account) => account.provider === provider);
  return provider
    ? (own.find((account) => account.windows?.length) ?? own[0])
    : undefined;
}

function usageOf(
  index: number,
  account: ProviderUsageAccount | undefined,
): CandidateUsage {
  const windows = account?.windows ?? [];
  const exhausted = windows.some(
    (window) => window.usedPercent >= CAPACITY_SKIP_PERCENT,
  );
  if (account?.capacity === undefined || !windows.length)
    return { index, exhausted, resetsAt: Infinity };
  const window = shortestWindow(windows);
  return {
    index,
    exhausted,
    remaining: window.remainingCapacity,
    resetsAt: resetTime(window),
  };
}

/**
 * Choose among the `candidates` of one tier (in config order). `accounts` is
 * null when usage is unavailable. Capacity is only considered when at least one
 * candidate's account has a known capacity; otherwise the first candidate wins.
 *
 * 1. Candidates whose account has a window used >= 95% are skipped.
 * 2. Known capacity ranks before unknown: the most remaining capacity in the
 *    account's shortest window wins, a tie goes to the sooner reset, then to
 *    config order. Unknown capacity keeps config order.
 * 3. When every candidate is skipped, config order applies.
 */
export function selectCapacityCandidate<T extends { harnessId: string }>(
  candidates: readonly T[],
  accounts: ProviderUsageAccount[] | null,
): CapacityChoice<T> {
  const first = candidates[0]!;
  if (candidates.length < 2) return { candidate: first };
  if (!accounts)
    return { candidate: first, capacityReason: 'usage-unavailable' };

  const usages = candidates.map((candidate, index) =>
    usageOf(index, accountFor(candidate.harnessId, accounts)),
  );
  if (usages.every((usage) => usage.remaining === undefined))
    return { candidate: first, capacityReason: 'unknown-capacity' };

  const open = usages.filter((usage) => !usage.exhausted);
  if (!open.length)
    return {
      candidate: first,
      capacityReason: 'capacity-exhausted',
      remainingCapacity: usages[0]!.remaining,
    };

  const best = open.reduce((current, next) => {
    if ((current.remaining === undefined) !== (next.remaining === undefined))
      return current.remaining === undefined ? next : current;
    if (current.remaining !== next.remaining)
      return (next.remaining ?? 0) > (current.remaining ?? 0) ? next : current;
    return next.resetsAt < current.resetsAt ? next : current;
  });
  return {
    candidate: candidates[best.index]!,
    capacityReason:
      best.remaining === undefined ? 'unknown-capacity' : 'most-remaining',
    remainingCapacity: best.remaining,
  };
}

const PROVIDER_USAGE_TTL_MS = 60_000;
/** A usage lookup must not hold up a run start for long; Box answers quickly or not at all. */
const PROVIDER_USAGE_TIMEOUT_MS = 5_000;

/**
 * Provider accounts for capacity routing, cached for `ttlMs`. A failed lookup
 * is cached too, so an unreachable Box costs one short timeout per interval.
 * Concurrent callers share one lookup. Resolves null when usage is unavailable.
 */
export function createProviderUsageLoader(
  fetchUsage: () => Promise<ProviderUsageSnapshot | null> = () =>
    fetchProviderUsage(fetch, undefined, PROVIDER_USAGE_TIMEOUT_MS),
  options: { ttlMs?: number; now?: () => number } = {},
): () => Promise<ProviderUsageAccount[] | null> {
  const ttlMs = options.ttlMs ?? PROVIDER_USAGE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; accounts: ProviderUsageAccount[] | null } | null =
    null;
  let inFlight: Promise<ProviderUsageAccount[] | null> | null = null;

  return () => {
    if (cached && now() - cached.at < ttlMs)
      return Promise.resolve(cached.accounts);
    inFlight ??= fetchUsage()
      .then((snapshot) => snapshot?.accounts ?? null)
      .catch((err) => {
        logger.warn({ err }, 'Provider usage lookup failed');
        return null;
      })
      .then((accounts) => {
        cached = { at: now(), accounts };
        return accounts;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

export const loadProviderUsageAccounts = createProviderUsageLoader();
