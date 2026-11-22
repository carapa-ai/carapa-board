import { afterEach, describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { allocateBrowserTestRuntime } from './browser-runtime';

const runtimes: Array<Awaited<ReturnType<typeof allocateBrowserTestRuntime>>> =
  [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanup();
});

describe('browser test runtime allocation', () => {
  test('allocates distinct ports, roots, and semantic sessions in one process', async () => {
    const first = await allocateBrowserTestRuntime('chat-suite');
    const second = await allocateBrowserTestRuntime('chat-suite');
    runtimes.push(first, second);

    expect(first.port).not.toBe(second.port);
    expect(first.root).not.toBe(second.root);
    expect(first.session).not.toBe(second.session);
    expect(first.cliArgs(['open', first.url])[0]).toBe(
      first.recorded || first.managed ? 'open' : `-s=${first.session}`,
    );
    expect(second.cliArgs(['open', second.url])[0]).toBe(
      second.recorded || second.managed ? 'open' : `-s=${second.session}`,
    );
  });

  test.each(['recorded', 'persistent', 'run'])(
    'preserves the injected %s browser while removing test-owned roots',
    async (scope) => {
      const keys = [
        'CARAPA_RECORD',
        'PLAYWRIGHT_CLI_SESSION',
        'PLAYWRIGHT_DAEMON_SESSION_DIR',
        'PLAYWRIGHT_DAEMON_SOCKETS_DIR',
        'CARAPA_RECORD_DIR',
        'CARAPA_BROWSER_SESSION_ID',
        'CARAPA_BROWSER_RUN_ID',
      ] as const;
      const previous = Object.fromEntries(
        keys.map((key) => [key, process.env[key]]),
      );
      const daemonDir = '/tmp/carapa-recorded-daemon-fixture';
      const socketsDir = '/tmp/carapa-recorded-sockets-fixture';
      const recordingDir = '/tmp/carapa-recorded-recording-fixture';
      try {
        process.env.CARAPA_RECORD = scope === 'recorded' ? '1' : '0';
        delete process.env.CARAPA_BROWSER_SESSION_ID;
        delete process.env.CARAPA_BROWSER_RUN_ID;
        if (scope === 'persistent')
          process.env.CARAPA_BROWSER_SESSION_ID = 'recorded-fixture-session';
        if (scope === 'run')
          process.env.CARAPA_BROWSER_RUN_ID = 'run-fixture-session';
        process.env.PLAYWRIGHT_CLI_SESSION = 'recorded-fixture-session';
        process.env.PLAYWRIGHT_DAEMON_SESSION_DIR = daemonDir;
        process.env.PLAYWRIGHT_DAEMON_SOCKETS_DIR = socketsDir;
        process.env.CARAPA_RECORD_DIR = recordingDir;
        const runtime = await allocateBrowserTestRuntime(
          'recorded-root-cleanup',
        );
        expect(runtime.recorded).toBe(scope === 'recorded');
        expect(runtime.cliArgs(['open', runtime.url])).toEqual([
          'open',
          runtime.url,
        ]);
        expect(runtime.env.PLAYWRIGHT_CLI_SESSION).toBe(
          'recorded-fixture-session',
        );
        expect(runtime.env.PLAYWRIGHT_DAEMON_SESSION_DIR).toBe(daemonDir);
        expect(runtime.env.PLAYWRIGHT_DAEMON_SOCKETS_DIR).toBe(socketsDir);
        expect(existsSync(runtime.root)).toBe(true);
        runtime.cleanup();
        expect(existsSync(runtime.root)).toBe(false);
      } finally {
        for (const key of keys) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
      }
    },
  );
});
