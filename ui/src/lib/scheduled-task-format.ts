import type { ScheduledTask } from '@/types';

const INTERVAL_PARTS = [
  { label: 'day', milliseconds: 86_400_000 },
  { label: 'hour', milliseconds: 3_600_000 },
  { label: 'minute', milliseconds: 60_000 },
  { label: 'second', milliseconds: 1_000 },
] as const;

function pluralize(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

function formatIntervalMilliseconds(scheduleValue: string): string {
  const milliseconds = Number(scheduleValue);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return scheduleValue;
  }

  let remaining = milliseconds;
  const parts: string[] = [];
  for (const { label, milliseconds: unitMilliseconds } of INTERVAL_PARTS) {
    const value = Math.floor(remaining / unitMilliseconds);
    if (value === 0) continue;
    parts.push(pluralize(value, label));
    remaining %= unitMilliseconds;
  }

  if (remaining > 0 || parts.length === 0) {
    parts.push(pluralize(remaining, 'millisecond'));
  }
  return parts.join(' ');
}

export function formatScheduledTaskCadence(
  task: Pick<ScheduledTask, 'scheduleType' | 'scheduleValue'>,
): string {
  const { scheduleType, scheduleValue } = task;
  if (scheduleType === 'interval') {
    return `every ${formatIntervalMilliseconds(scheduleValue)}`;
  }
  if (scheduleType === 'once') return `once ${scheduleValue}`;
  return `cron ${scheduleValue}`;
}

export const FRESH_CONTEXT_DESCRIPTION =
  'Each run starts without inheriting the conversation history from the chat that created it.';
