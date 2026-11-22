/**
 * Shared temporal recency scoring for keyword and vector recall paths.
 */

/** 0–1 score: higher when the event is closer to (but not after) asOf. */
export function temporalRecencyFactor(
  valid_from: string | null | undefined,
  asOf: string | undefined,
  last_accessed_at: string,
  nowMs: number = Date.now(),
): number {
  if (asOf && valid_from) {
    const asOfMs = new Date(asOf).getTime();
    const daysBeforeAsOf =
      (asOfMs - new Date(valid_from).getTime()) / 86_400_000;
    return Math.exp(-Math.max(0, daysBeforeAsOf) / 30);
  }
  const daysSinceAccess =
    (nowMs - new Date(last_accessed_at).getTime()) / 86_400_000;
  return Math.exp(-daysSinceAccess / 90);
}
