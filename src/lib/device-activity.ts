import { updateDeviceLastUsed } from '../db.js';

export const DEVICE_ACTIVITY_THROTTLE_MS = 60_000;

export type DeviceActivityWriter = (
  deviceId: string,
  userId?: string,
) => Promise<void>;

interface DeviceActivityThrottleOptions {
  writer: DeviceActivityWriter;
  intervalMs?: number;
  now?: () => number;
  onError?: (error: unknown, deviceId: string) => void;
}

/**
 * Coalesces best-effort device activity writes before they can acquire a
 * database connection. Entries are retained for at most two throttle windows,
 * and the single cleanup timer never keeps the process alive.
 */
export class DeviceActivityThrottle {
  private readonly lastScheduledAt = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly writer: DeviceActivityWriter;
  private readonly onError?: (error: unknown, deviceId: string) => void;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(options: DeviceActivityThrottleOptions) {
    this.writer = options.writer;
    this.intervalMs = options.intervalMs ?? DEVICE_ACTIVITY_THROTTLE_MS;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  touch(deviceId: string, userId?: string): void {
    const now = this.now();
    const lastScheduledAt = this.lastScheduledAt.get(deviceId);
    if (
      lastScheduledAt !== undefined &&
      now - lastScheduledAt < this.intervalMs
    ) {
      return;
    }

    // Admit the device before starting persistence so concurrent calls cannot
    // race into duplicate writes. Failures remain throttled during an outage.
    this.lastScheduledAt.set(deviceId, now);
    this.scheduleCleanup();
    void Promise.resolve()
      .then(() => this.writer(deviceId, userId))
      .catch((error) => {
        try {
          this.onError?.(error, deviceId);
        } catch {
          // Error reporting is best-effort too; never leak a rejection.
        }
      });
  }

  clear(): void {
    this.lastScheduledAt.clear();
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer || this.lastScheduledAt.size === 0) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      const expiredBefore = this.now() - this.intervalMs;
      for (const [deviceId, scheduledAt] of this.lastScheduledAt) {
        if (scheduledAt <= expiredBefore) this.lastScheduledAt.delete(deviceId);
      }
      this.scheduleCleanup();
    }, this.intervalMs);
    this.cleanupTimer.unref?.();
  }
}

let deviceActivityWriter: DeviceActivityWriter = updateDeviceLastUsed;
const deviceActivityThrottle = new DeviceActivityThrottle({
  writer: (deviceId, userId) => deviceActivityWriter(deviceId, userId),
});

export function touchDeviceLastUsed(deviceId: string, userId?: string): void {
  deviceActivityThrottle.touch(deviceId, userId);
}

/** Override the persistence boundary for focused HTTP tests; null restores it. */
export function setDeviceActivityWriterForTest(
  writer: DeviceActivityWriter | null,
): void {
  deviceActivityWriter = writer ?? updateDeviceLastUsed;
  deviceActivityThrottle.clear();
}
