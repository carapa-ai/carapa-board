const LIVE_MODE_SESSION_KEY = 'carapa-live-mode-session-id';

function generateLiveModeSessionId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `live-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function browserSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Keep ownership stable across refreshes without sharing it between browser tabs. */
export function liveModeSessionId(
  rotate = false,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = browserSessionStorage(),
): string {
  if (!rotate) {
    try {
      const existing = storage?.getItem(LIVE_MODE_SESSION_KEY)?.trim();
      if (existing && existing.length <= 128) return existing;
    } catch {
      // Fall through to an in-memory identity when storage access is blocked.
    }
  }

  const next = generateLiveModeSessionId();
  try {
    if (rotate) storage?.removeItem(LIVE_MODE_SESSION_KEY);
    storage?.setItem(LIVE_MODE_SESSION_KEY, next);
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
  return next;
}
