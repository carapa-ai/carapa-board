import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserIdleService,
  closeIdleBrowser,
  isBrowserAlreadyGone,
} from './browser-idle.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { webBrowserSessions } from '../modules/web/browser-sessions.js';
import {
  browserSessionFile,
  type PersistentBrowser,
} from './browser-sessions.js';

describe('isBrowserAlreadyGone', () => {
  test('recognises messages meaning nothing is left to reclaim', () => {
    expect(isBrowserAlreadyGone('service "app" is not running', 'app')).toBe(
      true,
    );
    expect(isBrowserAlreadyGone('Sandbox box-1 is stopped', 'app')).toBe(true);
    expect(
      isBrowserAlreadyGone(
        'browser-close ENOENT: no such file or directory, stat /workspace/gone',
        'app',
      ),
    ).toBe(true);
  });

  test('keeps unrelated failures as errors', () => {
    expect(isBrowserAlreadyGone('Exec failed: permission denied', 'app')).toBe(
      false,
    );
    expect(isBrowserAlreadyGone('', 'app')).toBe(false);
  });
});

describe('closeIdleBrowser', () => {
  const browser = {
    id: `browser-${'a'.repeat(40)}`,
    stack: 'stack',
    service: 'app',
    instance: 'inst',
  } as PersistentBrowser;

  test('releases the hub lease once the browser is closed, not when closing fails', async () => {
    const exec = spyOn(getSandboxClient(), 'sandboxExec');
    const release = spyOn(webBrowserSessions, 'releaseTab').mockResolvedValue();
    try {
      exec.mockResolvedValueOnce({ stdout: 'boom', isError: true });
      await expect(closeIdleBrowser(browser)).rejects.toThrow('boom');
      expect(release).not.toHaveBeenCalled();
      exec.mockResolvedValueOnce({ stdout: '', isError: false });
      await closeIdleBrowser(browser);
      expect(release.mock.calls).toEqual([[browser]]);
    } finally {
      exec.mockRestore();
      release.mockRestore();
    }
  });
});

describe('BrowserIdleService cleanup retries', () => {
  let dataDir: string;
  const browser: PersistentBrowser = {
    id: 'b1',
    projectId: 'p',
    conversationId: null,
    stack: 'stack',
    service: 'app',
    instance: 'inst',
    workDir: '/workspace/p',
    worktree: null,
    createdAt: new Date(1000).toISOString(),
    env: {},
  };

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-idle-'));
  });
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  function service(close: () => Promise<void>, id: string) {
    const target = { ...browser, id };
    fs.mkdirSync(path.dirname(browserSessionFile(target, dataDir)), {
      recursive: true,
    });
    return {
      target,
      service: new BrowserIdleService({
        now: () => 1_000_000,
        timeoutMs: 1,
        dataDir,
        list: () => [target],
        owner: async () => ({ busy: false, lastActivityAt: 0 }),
        close,
      }),
    };
  }

  test('a real close error is retried on every sweep', async () => {
    let calls = 0;
    const { service: idle } = service(async () => {
      calls++;
      throw new Error('Exec failed: permission denied');
    }, 'retry');
    expect(await idle.sweep()).toBe(0);
    expect(await idle.sweep()).toBe(0);
    expect(calls).toBe(2);
  });

  test('a completed close marks the browser closed and is not repeated', async () => {
    let calls = 0;
    const { service: idle } = service(async () => {
      calls++;
    }, 'done');
    expect(await idle.sweep()).toBe(1);
    expect(await idle.sweep()).toBe(0);
    expect(calls).toBe(1);
  });
});
