import { describe, expect, test } from 'bun:test';
import {
  DEVICE_ACTIVITY_THROTTLE_MS,
  DeviceActivityThrottle,
} from './device-activity.js';

describe('DeviceActivityThrottle', () => {
  test('coalesces a burst per device and refreshes independently after expiry', async () => {
    let now = 1_000;
    const writes: Array<[string, string | undefined]> = [];
    let batchSize = 2;
    let written = Promise.withResolvers<void>();
    const throttle = new DeviceActivityThrottle({
      now: () => now,
      writer: async (deviceId, userId) => {
        writes.push([deviceId, userId]);
        if (writes.length === batchSize) written.resolve();
      },
    });

    try {
      for (let i = 0; i < 20; i++) throttle.touch('device-a', 'user-a');
      throttle.touch('device-b', 'user-b');
      await written.promise;

      expect(writes).toEqual([
        ['device-a', 'user-a'],
        ['device-b', 'user-b'],
      ]);

      now += DEVICE_ACTIVITY_THROTTLE_MS - 1;
      throttle.touch('device-a', 'user-a');
      throttle.touch('device-b', 'user-b');
      expect(writes).toHaveLength(2);

      now += 1;
      batchSize = 3;
      written = Promise.withResolvers<void>();
      throttle.touch('device-a');
      await written.promise;
      expect(writes).toEqual([
        ['device-a', 'user-a'],
        ['device-b', 'user-b'],
        ['device-a', undefined],
      ]);
    } finally {
      throttle.clear();
    }
  });

  test('contains rejected writes and error-handler failures', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    const throttle = new DeviceActivityThrottle({
      writer: async () => {
        throw new Error('database unavailable');
      },
      onError: () => {
        throw new Error('logger unavailable');
      },
    });

    try {
      expect(throttle.touch('device-a', 'user-a')).toBeUndefined();
      // Node emits unhandledRejection on the next event-loop turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      throttle.clear();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
