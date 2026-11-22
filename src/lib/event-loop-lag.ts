/**
 * Event-loop lag sampler. A short interval timer measures how late each tick
 * fires (actual minus expected delay); a late tick means the loop was blocked
 * for that long. `maxLoopLagSince(startMs)` lets slow-query / slow-request
 * warns say whether a stall overlapped the operation, so loop stalls can be
 * told apart from genuine database or handler time.
 *
 * A tick at least `STALL_LOG_MS` late also logs one `Event loop stalled` warn
 * (rate limited), so a stall in which no slow query or request completes still
 * leaves a record, with CPU and memory readings to tell a frozen host from
 * process-bound work.
 *
 * Disabled when NODE_ENV === 'test' unless a caller passes `forceEnabled`.
 */

import { logger } from '../logger.js';

const TICK_MS = 20;
const WINDOW_MS = 10_000;
const STALL_LOG_MS = 5_000;
const STALL_LOG_INTERVAL_MS = 30_000;
const BYTES_PER_MB = 1024 * 1024;

interface LagSample {
  /** When the late tick finally ran. */
  at: number;
  /** How late it ran; the blocked span is [at - lagMs, at]. */
  lagMs: number;
}

export interface EventLoopLagOptions {
  tickMs?: number;
  windowMs?: number;
  /** Test seam: clock in epoch milliseconds. */
  now?: () => number;
  /** Test seam: timer scheduler. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Test seam: bypass the NODE_ENV=test bypass. */
  forceEnabled?: boolean;
}

export interface EventLoopLagMonitor {
  start(): void;
  stop(): void;
  /** Max lag of any sample whose blocked span overlaps [startMs, now]; 0 if none. */
  maxLoopLagSince(startMs: number): number;
}

export function createEventLoopLagMonitor(
  opts: EventLoopLagOptions = {},
): EventLoopLagMonitor {
  const tickMs = opts.tickMs ?? TICK_MS;
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const now = opts.now ?? Date.now;
  const schedule = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel =
    opts.clearInterval ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let samples: LagSample[] = [];
  let handle: unknown = null;
  let lastTick = 0;
  let lastCpu = process.cpuUsage();
  let lastStallLogAt = -Infinity;

  function logStall(
    at: number,
    lagMs: number,
    cpuDelta: { user: number; system: number },
  ): void {
    if (at - lastStallLogAt < STALL_LOG_INTERVAL_MS) return;
    lastStallLogAt = at;
    const mem = process.memoryUsage();
    logger.warn(
      {
        lagMs,
        blockedFrom: new Date(at - lagMs).toISOString(),
        blockedTo: new Date(at).toISOString(),
        cpuUserMs: Math.round(cpuDelta.user / 1000),
        cpuSystemMs: Math.round(cpuDelta.system / 1000),
        rssMb: Math.round(mem.rss / BYTES_PER_MB),
        heapUsedMb: Math.round(mem.heapUsed / BYTES_PER_MB),
      },
      'Event loop stalled',
    );
  }

  function prune(at: number): void {
    const cutoff = at - windowMs;
    if (samples.length > 0 && samples[0].at < cutoff) {
      samples = samples.filter((s) => s.at >= cutoff);
    }
  }

  function tick(): void {
    const at = now();
    const lagMs = Math.max(0, at - lastTick - tickMs);
    lastTick = at;
    const cpu = process.cpuUsage();
    const cpuDelta = {
      user: cpu.user - lastCpu.user,
      system: cpu.system - lastCpu.system,
    };
    lastCpu = cpu;
    if (lagMs > 0) samples.push({ at, lagMs });
    if (lagMs >= STALL_LOG_MS) logStall(at, lagMs, cpuDelta);
    prune(at);
  }

  return {
    start() {
      if (handle !== null) return;
      if (process.env.NODE_ENV === 'test' && !opts.forceEnabled) return;
      lastTick = now();
      lastCpu = process.cpuUsage();
      handle = schedule(tick, tickMs);
      (handle as { unref?: () => void } | null)?.unref?.();
    },
    stop() {
      if (handle === null) return;
      cancel(handle);
      handle = null;
      samples = [];
    },
    maxLoopLagSince(startMs) {
      const end = now();
      prune(end);
      let max = 0;
      for (const s of samples) {
        if (s.at >= startMs && s.at - s.lagMs <= end && s.lagMs > max) {
          max = s.lagMs;
        }
      }
      return max;
    },
  };
}

const defaultMonitor = createEventLoopLagMonitor();

/** Start the process-wide sampler (idempotent; no-op under NODE_ENV=test). */
export function startEventLoopLagMonitor(): void {
  defaultMonitor.start();
}

export function stopEventLoopLagMonitor(): void {
  defaultMonitor.stop();
}

/** Max event-loop lag overlapping [startMs, now]; 0 when none or not started. */
export function maxLoopLagSince(startMs: number): number {
  return defaultMonitor.maxLoopLagSince(startMs);
}
