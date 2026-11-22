import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { CronExpressionParser } from 'cron-parser';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const DIVISIONS: { amount: number; name: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, name: 'seconds' },
  { amount: 60, name: 'minutes' },
  { amount: 24, name: 'hours' },
  { amount: 7, name: 'days' },
  { amount: 4.34524, name: 'weeks' },
  { amount: 12, name: 'months' },
  { amount: Number.POSITIVE_INFINITY, name: 'years' },
];

/**
 * `justNow` replaces the seconds labels ("5 seconds ago", "in 5 seconds")
 * with "just now" for labels that are only refreshed once a minute.
 */
export function formatRelativeTime(
  iso: string,
  { justNow = false }: { justNow?: boolean } = {},
): string {
  let duration = (new Date(iso).getTime() - Date.now()) / 1000;
  if (justNow && Math.abs(duration) < DIVISIONS[0].amount) return 'just now';
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.name);
    }
    duration /= division.amount;
  }
  return iso;
}

/** Local date and time with seconds, for tooltips on relative times. */
export function formatExactTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. 45000 -> "45s", 125000 -> "2m 5s", 3661000 -> "1h 1m"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    } else {
      // Fallback for non-secure contexts
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      textArea.style.top = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const result = document.execCommand('copy');
      textArea.remove();
      return !!result;
    }
  } catch (err) {
    console.error('Failed to copy text:', err);
    return false;
  }
}

/**
 * Validate a cron expression with the same parser the server uses
 * (`cron-parser`), so the dialogs accept and reject the same input.
 * Returns an error message or null if valid.
 */
export function validateCron(expr: string): string | null {
  const trimmed = expr.trim();
  // cron-parser pads missing fields, but a schedule needs at least the five
  // standard ones (the server also accepts a leading seconds field, i.e. six;
  // macros such as @daily are single tokens that expand on their own).
  if (!trimmed.startsWith('@') && trimmed.split(/\s+/).length < 5)
    return 'Must have 5 fields: minute hour day month weekday';
  try {
    CronExpressionParser.parse(trimmed);
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : '';
    return reason
      ? `Invalid cron expression: ${reason}`
      : 'Invalid cron expression';
  }
}
