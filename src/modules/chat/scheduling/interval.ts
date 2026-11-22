export function parseIntervalMs(scheduleValue: string): number {
  const normalized = scheduleValue.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(
      'Interval schedule_value must be a positive integer in milliseconds',
    );
  }

  const intervalMs = Number(normalized);
  if (!Number.isSafeInteger(intervalMs)) {
    throw new Error('Interval schedule_value is too large');
  }

  return intervalMs;
}
