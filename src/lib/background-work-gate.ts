/**
 * In-process gate for automatic background LLM work (reflection, memory
 * maintenance/audits, conversation titles, ...).
 *
 * While a server/web build is in flight or a restart is pending, background
 * entry points must not START new jobs (`canStartBackgroundWork()`), while jobs
 * already running finish their current unit of work. Every job wraps its work
 * in `trackBackgroundWork` so a pending restart can wait until none remain.
 *
 * State is deliberately in-memory only: the replacement process starts
 * unpaused. Gating happens at job boundaries, never inside the LLM helpers,
 * because those also serve user-initiated calls.
 */

/** Label under which running direct-LLM chat turns are counted. */
export const DIRECT_CHAT_WORK_LABEL = 'direct-chat';

let pausedReason: string | null = null;
const inFlight = new Map<string, number>();
let idleWaiters: Array<() => void> = [];
const resumeListeners = new Set<() => void>();

export function pauseBackgroundWork(reason: string): void {
  pausedReason ??= reason;
}

export function resumeBackgroundWork(): void {
  if (pausedReason === null) return;
  pausedReason = null;
  for (const listener of [...resumeListeners]) {
    try {
      listener();
    } catch {
      // A failing listener must not keep other deferred work parked.
    }
  }
}

export function canStartBackgroundWork(): boolean {
  return pausedReason === null;
}

/**
 * Count one in-flight job under `label` and return its idempotent release.
 * For work whose body cannot be wrapped in `trackBackgroundWork`; the caller
 * must release in a `finally`. Never gates starting: only `canStartBackgroundWork`
 * does that, and only for callers that choose to consult it.
 */
export function beginBackgroundWork(label: string): () => void {
  inFlight.set(label, (inFlight.get(label) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (inFlight.get(label) ?? 1) - 1;
    if (remaining > 0) inFlight.set(label, remaining);
    else inFlight.delete(label);
    if (inFlight.size === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };
}

/** Run `fn` as a counted background job; the count is released in `finally`. */
export async function trackBackgroundWork<T>(
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const release = beginBackgroundWork(label);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Snapshot of in-flight job counts by label (labels with no jobs omitted). */
export function getInFlight(): Record<string, number> {
  return Object.fromEntries(inFlight);
}

/**
 * Resolves `true` once no tracked job is in flight (immediately when none is),
 * or `false` if `signal` aborts first.
 */
export function waitForBackgroundWorkIdle(
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (inFlight.size === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onIdle = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    };
    const onAbort = () => {
      idleWaiters = idleWaiters.filter((waiter) => waiter !== onIdle);
      resolve(false);
    };
    idleWaiters.push(onIdle);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Subscribe to the gate reopening so parked queues can restart. */
export function onBackgroundWorkResumed(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => resumeListeners.delete(listener);
}
