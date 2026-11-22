export interface SseKeepAliveResponse {
  writableEnded: boolean;
  write(chunk: string): unknown;
}

const SSE_KEEPALIVE_INTERVAL_MS = 25_000;

/** Keep a long-lived SSE response open through idle reverse-proxy timeouts. */
export function startSseKeepAlive(res: SseKeepAliveResponse): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    } catch {
      // best-effort
    }
  }, SSE_KEEPALIVE_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
