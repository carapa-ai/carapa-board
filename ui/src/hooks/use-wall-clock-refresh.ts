import { useEffect, useState } from 'react';

const WALL_CLOCK_REFRESH_INTERVAL_MS = 60_000;

/** Re-renders the caller periodically so wall-clock-derived labels stay current. */
export function useWallClockRefresh(enabled = true): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    const interval = window.setInterval(
      () => setTick((tick) => tick + 1),
      WALL_CLOCK_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [enabled]);
}
