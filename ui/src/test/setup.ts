import { afterAll, afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// findBy*/waitFor return as soon as their condition is observed; this limit is
// only a hang safeguard. The 1s default is too tight when CI runs Vitest
// alongside other builds, so it must not decide whether a test passes.
configure({ asyncUtilTimeout: 5000 });

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage(),
});

Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: storage(),
});

// jsdom does not implement scrollIntoView. Production code often calls it from
// a deferred callback (e.g. requestAnimationFrame) that can fire after the
// test body ends, where it surfaces as a run-level "Unhandled Error" and fails
// the whole suite even though every test passed. Provide a no-op default.
if (
  typeof Element !== 'undefined' &&
  typeof Element.prototype.scrollIntoView !== 'function'
) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom lacks the pointer-capture and resize APIs Radix Select/Popper call when
// a list opens. No-op defaults keep the shared Select usable in tests.
if (typeof Element !== 'undefined') {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// @testing-library/react auto-registers an afterEach(cleanup) only when a
// *global* `afterEach` exists (see node_modules/@testing-library/react/dist).
// This vitest config does not enable `globals: true`, so that global is
// absent and RTL cleanup never runs. Every React root mounted via
// render()/renderHook() then stays mounted after each test, leaving
// react-dom's NormalPriority passive-effect scheduler timer — which reads
// `window.event` — pending. In the full UI suite that timer fires after a
// test file's jsdom environment is torn down, surfacing as an intermittent
// `ReferenceError: window is not defined` (originally attributed to
// use-task-mutations.vitest.tsx, but every file that renders React without
// cleanup leaks the same timer). Register cleanup unconditionally for every
// file so roots are always unmounted and no scheduler timer leaks across files.
afterEach(() => {
  cleanup();
});

// Unmounting can itself queue a 0 ms timer: Radix FocusScope dispatches its
// unmount event from setTimeout(..., 0). If the file's jsdom environment is torn
// down first, that callback builds Node's CustomEvent and dispatches it on a
// jsdom element, failing the whole run with "parameter 1 is not of type
// 'Event'" although every test passed. Equal-delay timers run in the order they
// were queued, so this one fires only after every 0 ms timer the final cleanup
// queued; the environment is torn down after it.
afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});
