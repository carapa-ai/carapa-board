import { expect, test } from 'bun:test';
import { createEventLoopLagMonitor } from './event-loop-lag.js';

function setup() {
  let clock = 1_000;
  let tick: () => void = () => {};
  const monitor = createEventLoopLagMonitor({
    tickMs: 20,
    windowMs: 10_000,
    now: () => clock,
    setInterval: (fn) => {
      tick = fn;
      return {};
    },
    clearInterval: () => {},
    forceEnabled: true,
  });
  monitor.start();
  return {
    monitor,
    /** Advance the clock and fire one timer tick. */
    advance(ms: number) {
      clock += ms;
      tick();
    },
    now: () => clock,
  };
}

test('maxLoopLagSince reports a stall inside the window and 0 after it', () => {
  const t = setup();
  t.advance(20); // on time
  const beforeStall = t.now();
  t.advance(20 + 130); // tick fires 130 ms late
  expect(t.monitor.maxLoopLagSince(beforeStall)).toBe(130);
  expect(t.monitor.maxLoopLagSince(t.now() - 1_000)).toBe(130);

  t.advance(20);
  expect(t.monitor.maxLoopLagSince(t.now() - 10)).toBe(0);
});

test('samples older than the retention window are dropped', () => {
  const t = setup();
  t.advance(20 + 200);
  expect(t.monitor.maxLoopLagSince(0)).toBe(200);
  for (let i = 0; i < 501; i++) t.advance(20); // > 10 s of on-time ticks
  expect(t.monitor.maxLoopLagSince(0)).toBe(0);
});
