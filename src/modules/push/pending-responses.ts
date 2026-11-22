import { logger } from '../../logger.js';

export type FormResponseResult =
  | { status: 'submitted'; values: Record<string, unknown> }
  | { status: 'expired' }
  | { status: 'aborted' }
  | { status: 'cancelled' };

interface Pending {
  resolve: (v: FormResponseResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

export function awaitFormResponse(
  payloadId: string,
  timeoutMs: number,
): Promise<FormResponseResult> {
  return new Promise((resolve) => {
    const existing = pending.get(payloadId);
    if (existing) {
      logger.warn(
        { payload_id: payloadId },
        '[pending-responses] duplicate await; replacing prior listener',
      );
      existing.resolve({ status: 'cancelled' });
      clearTimeout(existing.timer);
      pending.delete(payloadId);
    }
    const timer = setTimeout(() => {
      pending.delete(payloadId);
      logger.debug(
        { payload_id: payloadId },
        '[pending-responses] await timed out (expired)',
      );
      resolve({ status: 'expired' });
    }, timeoutMs);
    pending.set(payloadId, { resolve, timer });
    logger.debug(
      {
        payload_id: payloadId,
        timeout_ms: timeoutMs,
        pending_count: pending.size,
      },
      '[pending-responses] await registered',
    );
  });
}

/**
 * Wakes the awaiter (if any) for this payload. Returns true if a listener
 * was waiting; false if no one was. Idempotent: subsequent calls are no-ops.
 */
export function deliverFormResponse(
  payloadId: string,
  values: Record<string, unknown>,
): boolean {
  const p = pending.get(payloadId);
  if (!p) {
    logger.debug(
      { payload_id: payloadId, pending_count: pending.size },
      '[pending-responses] deliver: no awaiter (already resolved or never registered)',
    );
    return false;
  }
  clearTimeout(p.timer);
  pending.delete(payloadId);
  p.resolve({ status: 'submitted', values });
  logger.debug(
    { payload_id: payloadId, value_keys: Object.keys(values) },
    '[pending-responses] deliver: woke awaiter (submitted)',
  );
  return true;
}

export function cancelPending(
  payloadId: string,
  reason: 'aborted' | 'cancelled',
): void {
  const p = pending.get(payloadId);
  if (!p) {
    logger.debug(
      { payload_id: payloadId, reason, pending_count: pending.size },
      '[pending-responses] cancel: no awaiter to wake',
    );
    return;
  }
  clearTimeout(p.timer);
  pending.delete(payloadId);
  p.resolve({ status: reason });
  logger.debug(
    { payload_id: payloadId, reason },
    '[pending-responses] cancel: woke awaiter',
  );
}

export function pendingCount(): number {
  return pending.size;
}
