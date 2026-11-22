import { logger } from '../logger.js';
import * as dbKb from '../modules/knowledge/db-kb.js';
import * as pushTools from '../modules/tools/push-tools.js';

const MS_PER_DAY = 86_400_000;
const EXPIRY_THRESHOLDS = [1, 3, 7, 14] as const;
type ExpiryThreshold = (typeof EXPIRY_THRESHOLDS)[number] | 'expired';

const SUMMARY_MAX = 120;
const ACTION_URL = '/admin/provider-accounts';
const CODE_HOST_PROVIDERS = new Set(['gitlab', 'github']);

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  codex: 'Codex / ChatGPT',
  antigravity: 'Antigravity / Google',
  meta: 'Meta / Muse Code',
  xai: 'xAI / Grok Build',
  cursor: 'Cursor',
  'mistral-vibe': 'Mistral Vibe',
  'mistral-eu': 'Mistral API',
  openrouter: 'OpenRouter',
  'anthropic-api': 'Anthropic API',
  'anthropic-admin': 'Anthropic Admin',
  openai: 'OpenAI API',
  google: 'Google Gemini API',
  nvidia: 'NVIDIA API',
  jev: 'Typesafe / Jev',
  gitlab: 'GitLab',
  github: 'GitHub',
};

interface DueNotice {
  accountId: string;
  provider: string;
  source_id: string;
  summary: string;
  content: string;
}

export interface KeyExpiryNotifierDeps {
  now?: () => number;
  listUsers?: typeof dbKb.listUsers;
  getUserMainFolder?: typeof dbKb.getUserMainFolder;
  notifyUserSystem?: typeof pushTools.notifyUserSystem;
}

function parseUtcDate(
  value: unknown,
): { year: number; month: number; day: number; dateStr: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, dateStr: value };
}

function resolveExpiryStatus(
  expiresAt: unknown,
  nowMs: number,
): { dateStr: string; threshold: ExpiryThreshold; daysLeft: number } | null {
  const parsed = parseUtcDate(expiresAt);
  if (!parsed) return null;
  // A key dated YYYY-MM-DD stays usable through the end of that UTC day.
  const endOfDayMs = Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1);
  const remainingMs = endOfDayMs - nowMs;
  if (remainingMs <= 0) {
    return { dateStr: parsed.dateStr, threshold: 'expired', daysLeft: 0 };
  }
  const daysLeft = Math.floor(remainingMs / MS_PER_DAY);
  const threshold = EXPIRY_THRESHOLDS.find((t) => t >= daysLeft);
  if (threshold === undefined) return null;
  return { dateStr: parsed.dateStr, threshold, daysLeft };
}

function formatSummary(
  providerName: string,
  label: string,
  verb: string,
): string {
  const head = `${providerName} key "`;
  const tail = `" ${verb}`;
  const full = `${head}${label}${tail}`;
  if (full.length <= SUMMARY_MAX) return full;
  const room = SUMMARY_MAX - head.length - tail.length;
  if (room < 2) return full.slice(0, SUMMARY_MAX);
  return `${head}${label.slice(0, room - 1)}…${tail}`;
}

function formatExpiryMeta(
  expiresAt: string | undefined,
  expirySource: unknown,
): string | null {
  if (!expiresAt) return null;
  const sourceLabel =
    expirySource === 'provider'
      ? 'provider-reported'
      : expirySource === 'manual'
        ? 'manual'
        : null;
  return sourceLabel ? `${expiresAt} UTC, ${sourceLabel}` : `${expiresAt} UTC`;
}

function buildDueNotices(listing: any, nowMs: number): DueNotice[] {
  const accounts: any[] = Array.isArray(listing)
    ? listing
    : Array.isArray(listing?.accounts)
      ? listing.accounts
      : [];
  const utcDate = new Date(nowMs).toISOString().slice(0, 10);
  const notices: DueNotice[] = [];

  for (const account of accounts) {
    if (!account || typeof account !== 'object') continue;
    if (typeof account.id !== 'string' || !account.id) continue;
    if (typeof account.provider !== 'string' || !account.provider) continue;

    const provider = account.provider;
    const providerName = PROVIDER_NAMES[provider] ?? provider;
    const label =
      typeof account.label === 'string' && account.label.trim()
        ? account.label.trim()
        : account.id;
    const host =
      CODE_HOST_PROVIDERS.has(provider) &&
      typeof account.host === 'string' &&
      account.host.trim()
        ? account.host.trim()
        : undefined;
    const hostSuffix = host ? ` (${host})` : '';

    const parsedDate = parseUtcDate(account.expiresAt)?.dateStr;
    const expiryMeta = formatExpiryMeta(parsedDate, account.expirySource);
    const expiry = resolveExpiryStatus(account.expiresAt, nowMs);

    if (expiry) {
      if (expiry.threshold === 'expired') {
        notices.push({
          accountId: account.id,
          provider,
          source_id: `key-expiry:${account.id}:${expiry.dateStr}:expired`,
          summary: formatSummary(providerName, label, 'has expired'),
          content: `The ${providerName} key "${label}"${hostSuffix} expired on ${expiryMeta ?? `${expiry.dateStr} UTC`}. Replace the key in Managed accounts.`,
        });
      } else {
        const when =
          expiry.daysLeft === 0
            ? 'today'
            : expiry.daysLeft === 1
              ? 'in 1 day'
              : `in ${expiry.daysLeft} days`;
        notices.push({
          accountId: account.id,
          provider,
          source_id: `key-expiry:${account.id}:${expiry.dateStr}:${expiry.threshold}`,
          summary: formatSummary(providerName, label, `expires ${when}`),
          content: `The ${providerName} key "${label}"${hostSuffix} expires ${when} (${expiryMeta ?? `${expiry.dateStr} UTC`}). Replace the key in Managed accounts.`,
        });
      }
    }

    if (account.keyCheck === 'rejected') {
      const expiryNote = expiryMeta ? ` (expiry: ${expiryMeta})` : '';
      notices.push({
        accountId: account.id,
        provider,
        source_id: `key-rejected:${account.id}:${utcDate}`,
        summary: formatSummary(providerName, label, 'was rejected'),
        content: `The ${providerName} key "${label}"${hostSuffix} was rejected by the provider${expiryNote}. Replace the key in Managed accounts.`,
      });
    }
  }

  return notices;
}

/**
 * Check a CarapaBox provider-accounts listing for expiring, expired, or
 * provider-rejected API keys and notify board admins via push.
 * Never throws into the polling caller.
 */
export async function checkManagedKeyNotifications(
  listing: any,
  deps: KeyExpiryNotifierDeps = {},
): Promise<void> {
  try {
    const nowMs = (deps.now ?? Date.now)();
    const notices = buildDueNotices(listing, nowMs);
    if (notices.length === 0) return;

    const loadUsers = deps.listUsers ?? dbKb.listUsers;
    const loadMainFolder = deps.getUserMainFolder ?? dbKb.getUserMainFolder;
    const sendNotice = deps.notifyUserSystem ?? pushTools.notifyUserSystem;

    const users = await loadUsers();
    const admins = users.filter((u) => u.role === 'admin' && !u.disabled);
    if (admins.length === 0) return;

    for (const admin of admins) {
      let mainFolder: string | undefined;
      try {
        mainFolder = await loadMainFolder(admin.id);
      } catch (err) {
        logger.warn(
          {
            userId: admin.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to resolve admin main folder for key notification',
        );
        continue;
      }

      for (const notice of notices) {
        try {
          await sendNotice(admin.id, mainFolder ?? '', {
            summary: notice.summary,
            content: notice.content,
            source_id: notice.source_id,
            action_url: ACTION_URL,
            suppress_push: !mainFolder,
          });
        } catch (err) {
          logger.warn(
            {
              userId: admin.id,
              accountId: notice.accountId,
              provider: notice.provider,
              sourceId: notice.source_id,
              err: err instanceof Error ? err.message : String(err),
            },
            'Failed to deliver managed key notification',
          );
        }
      }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Managed key notification check failed',
    );
  }
}
