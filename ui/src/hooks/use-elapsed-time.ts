import { useState, useEffect } from 'react';

/**
 * Hook that returns the elapsed time in ms since a given ISO timestamp,
 * updating every second. Returns 0 if started_at is falsy.
 */
export function useElapsedTime(started_at: string | undefined | null, enabled = true): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!started_at || !enabled) {
      setElapsed(0);
      return;
    }

    const startMs = new Date(started_at).getTime();
    const update = () => setElapsed(Math.max(0, Date.now() - startMs));
    update(); // immediate

    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [started_at, enabled]);

  return elapsed;
}
