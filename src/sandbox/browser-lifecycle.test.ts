import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../db.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { logger } from '../logger.js';
import { webBrowserSessions } from '../modules/web/browser-sessions.js';
import { finalizeSandboxBrowsers } from './browser-lifecycle.js';
import {
  browserSessionFile,
  ensurePersistentBrowser,
  type PersistentBrowser,
} from './browser-sessions.js';

const stack = 'carapa-bot';
let dataDir: string;
let instanceCount = 0;
const spies: { mockRestore: () => void }[] = [];

beforeAll(async () => {
  await initDatabase(':memory:');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-lifecycle-'));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** Each test gets its own instance so descriptors never leak between cases. */
function instance(): string {
  return `box-${++instanceCount}`;
}

function descriptors(name: string, count: number): PersistentBrowser[] {
  return Array.from({ length: count }, (_, index) =>
    ensurePersistentBrowser(
      {
        projectId: `${name}-${index}`,
        conversationId: `conv-${index}`,
        stack,
        service: 'agent',
        instance: name,
        workDir: `/workspace/${name}-${index}`,
        worktree: null,
      },
      dataDir,
    ),
  );
}

function withActivity(browser: PersistentBrowser): {
  json: string;
  activity: string;
} {
  const json = browserSessionFile(browser, dataDir);
  const activity = json.replace(/\.json$/, '.activity.json');
  fs.writeFileSync(activity, JSON.stringify({ lastActivityAt: 1 }));
  return { json, activity };
}

function stubClose(
  handler: (id: string) => Promise<{ stdout: string; isError: boolean }>,
) {
  const spy = spyOn(getSandboxClient(), 'sandboxExec').mockImplementation(
    async (_stack, _service, command) =>
      handler(command.replace('browser-close ', '')),
  );
  spies.push(spy);
  return spy;
}

test('a successful close removes the descriptor and its activity file', async () => {
  const name = instance();
  const [browser] = descriptors(name, 1);
  const files = withActivity(browser);
  const spy = stubClose(async () => ({ stdout: '', isError: false }));
  const release = spyOn(webBrowserSessions, 'releaseTab').mockResolvedValue();
  spies.push(release);

  await finalizeSandboxBrowsers(stack, name, dataDir);

  // Sandbox stop also drops a native runner's hub browser lease.
  expect(release.mock.calls).toEqual([[browser]]);
  expect(spy.mock.calls).toEqual([
    [
      stack,
      'agent',
      `browser-close ${browser.id}`,
      { instance: name, timeout: 20 },
    ],
  ]);
  expect(fs.existsSync(files.json)).toBe(false);
  expect(fs.existsSync(files.activity)).toBe(false);
});

test('a close reporting the browser is already gone also removes the files', async () => {
  const name = instance();
  const [browser] = descriptors(name, 1);
  const files = withActivity(browser);
  stubClose(async () => ({
    stdout: 'service "agent" is not running',
    isError: true,
  }));

  await finalizeSandboxBrowsers(stack, name, dataDir);

  expect(fs.existsSync(files.json)).toBe(false);
  expect(fs.existsSync(files.activity)).toBe(false);
});

test('any other close failure keeps both files and logs a warning', async () => {
  const name = instance();
  const [browser] = descriptors(name, 1);
  const files = withActivity(browser);
  const warn = spyOn(logger, 'warn');
  spies.push(warn);
  stubClose(async () => ({
    stdout: 'Exec failed: permission denied',
    isError: true,
  }));
  const release = spyOn(webBrowserSessions, 'releaseTab').mockResolvedValue();
  spies.push(release);

  await finalizeSandboxBrowsers(stack, name, dataDir);

  // The browser may still be alive, so it keeps its lease.
  expect(release).not.toHaveBeenCalled();
  expect(fs.existsSync(files.json)).toBe(true);
  expect(fs.existsSync(files.activity)).toBe(true);
  expect(warn).toHaveBeenCalledWith(
    { sessionId: browser.id },
    'Persistent browser cleanup reported an error',
  );
});

test('a thrown close for one browser does not stop the others', async () => {
  const name = instance();
  const [failing, closing] = descriptors(name, 2);
  const failingFiles = withActivity(failing);
  const closingFiles = withActivity(closing);
  const warn = spyOn(logger, 'warn');
  spies.push(warn);
  const spy = stubClose(async (id) => {
    if (id === failing.id) throw new Error('socket hang up');
    return { stdout: '', isError: false };
  });

  await finalizeSandboxBrowsers(stack, name, dataDir);

  expect(spy).toHaveBeenCalledTimes(2);
  expect(fs.existsSync(closingFiles.json)).toBe(false);
  expect(fs.existsSync(failingFiles.json)).toBe(true);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: failing.id }),
    'Persistent browser cleanup failed',
  );
});

test('closes run with bounded concurrency', async () => {
  const name = instance();
  const browsers = descriptors(name, 10);
  let inFlight = 0;
  let peak = 0;
  const spy = spyOn(getSandboxClient(), 'sandboxExec').mockImplementation(
    async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield once so overlapping calls are observable without timers.
      await Promise.resolve();
      inFlight--;
      return { stdout: '', isError: false };
    },
  );
  spies.push(spy);

  await finalizeSandboxBrowsers(stack, name, dataDir);

  expect(spy).toHaveBeenCalledTimes(browsers.length);
  expect(peak).toBe(4);
});
