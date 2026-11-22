import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  BrowserSessions,
  type BrowserProcess,
  type SessionInput,
} from './sessions.js';

function input(group = 'one', expiresAt = Date.now() + 10_000): SessionInput {
  return {
    id: `web-view-${randomUUID()}`,
    token: 'a'.repeat(64),
    group,
    runId: randomUUID(),
    expiresAt,
  };
}
function browser() {
  let crashed!: () => void;
  let markStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });
  let stops = 0;
  return {
    process: {
      endpoint: 'ws://test/browser',
      closed: new Promise<void>((resolve) => {
        crashed = resolve;
      }),
      stop: async () => {
        stops++;
        markStopped();
      },
    } satisfies BrowserProcess,
    crash: () => crashed(),
    stopped,
    stops: () => stops,
  };
}

test('capacity includes pending launches; credentials and deletion stay session-scoped', async () => {
  const handles = [browser(), browser()];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const sessions = new BrowserSessions(async () => {
    const index = calls++;
    await pending;
    return handles[index].process;
  }, 2);
  const one = input();
  const two = { ...input('two'), token: 'b'.repeat(64) };
  const starts = [sessions.create(one), sessions.create(two)];
  try {
    await expect(sessions.create(input())).rejects.toThrow(
      'capacity exhausted',
    );
    expect(sessions.authorize(one.id, one.token)).toBeUndefined();
    release();
    await Promise.all(starts);
    expect(sessions.authorize(two.id, one.token)).toBeUndefined();
    expect(sessions.authorize(one.id, one.token)?.group).toBe('one');
    await sessions.delete(one.id);
    expect(sessions.authorize(one.id, one.token)).toBeUndefined();
    expect(sessions.authorize(two.id, two.token)?.runId).toBe(two.runId);
    expect(handles[0].stops()).toBe(1);
  } finally {
    release();
    await sessions.close();
  }
});

test('sidecar expiry and browser crashes revoke credentials without Board cleanup', async () => {
  const handles = [browser(), browser()];
  let calls = 0;
  let now = 1_000;
  let expire!: () => void;
  const sessions = new BrowserSessions(
    async () => handles[calls++].process,
    4,
    300_000,
    {
      now: () => now,
      setTimeout: (callback, delayMs) => {
        if (delayMs === 50) expire = callback;
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    },
  );
  const expires = input('expires', now + 50);
  const crashes = input('crashes', now + 10_000);
  await sessions.create(expires);
  await sessions.create(crashes);
  handles[1].crash();
  await handles[1].stopped;
  now = expires.expiresAt;
  expire();
  await handles[0].stopped;
  expect(sessions.authorize(expires.id, expires.token)).toBeUndefined();
  expect(sessions.authorize(crashes.id, crashes.token)).toBeUndefined();
  expect(handles.map((handle) => handle.stops())).toEqual([1, 1]);
  await sessions.close();
});

test('failed and cancelled startup release capacity and stop late browsers', async () => {
  const handle = browser();
  let release!: () => void;
  const sessions = new BrowserSessions(async (_id, signal) => {
    await new Promise<void>((resolve) => {
      release = resolve;
      signal.addEventListener('abort', resolve as any, { once: true });
    });
    return handle.process;
  }, 1);
  const item = input();
  const starting = sessions.create(item).catch((error) => error);
  await sessions.delete(item.id);
  release();
  expect((await starting).message).toContain('expired during startup');
  expect(sessions.authorize(item.id, item.token)).toBeUndefined();
  expect(handle.stops()).toBeGreaterThanOrEqual(1);
  await sessions.close();
  const failed = new BrowserSessions(async () => {
    throw new Error('startup failure');
  }, 1);
  await expect(failed.create(input())).rejects.toThrow('startup failure');
  await expect(failed.create(input())).rejects.toThrow('startup failure');
});

test('tab sessions outlive web_view lifetime when renewed, within their own cap and pool', async () => {
  const now = 1_000;
  const sessions = new BrowserSessions(
    async () => browser().process,
    1,
    90_000,
    {
      now: () => now,
      setTimeout: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
      clearTimeout: () => {},
    },
    { capacity: 2, maxLifetimeMs: 600_000 },
  );
  const tab = (expiresAt: number) => ({
    ...input('tab', expiresAt),
    id: `browser-tab-${randomUUID().replaceAll('-', '')}${'0'.repeat(8)}`,
  });
  try {
    // web_view keeps its short fixed lifetime; tabs get their own window.
    await expect(sessions.create(input('v', now + 300_000))).rejects.toThrow(
      'Invalid browser session',
    );
    const one = tab(now + 300_000);
    await sessions.create(one);
    await sessions.create(tab(now + 300_000));
    // Tab sessions neither consume nor are consumed by web_view capacity.
    await expect(sessions.create(tab(now + 300_000))).rejects.toThrow(
      'capacity exhausted',
    );
    const view = input('v', now + 60_000);
    await sessions.create(view);
    await expect(sessions.create(input('v', now + 60_000))).rejects.toThrow(
      'capacity exhausted',
    );
    // Renewal is bounded by the tab maximum and is not available to web_view.
    sessions.renew(one.id, now + 600_000);
    expect(sessions.authorize(one.id, one.token)?.expiresAt).toBe(
      now + 600_000,
    );
    expect(() => sessions.renew(one.id, now + 600_001)).toThrow('Invalid');
    expect(() => sessions.renew(view.id, now + 80_000)).toThrow('Invalid');
    await sessions.delete(one.id);
    await sessions.create(tab(now + 300_000));
  } finally {
    await sessions.close();
  }
});
