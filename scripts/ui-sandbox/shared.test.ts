import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { waitForFileState } from '../../src/test-file-events.js';
import os from 'node:os';
import path from 'node:path';

import {
  acquireSandboxStartupLock,
  buildSandboxEnv,
  browserCliArgs,
  browserIdentity,
  TWO_USER_BROWSER_REQUIRED_MESSAGE,
  assertUserDeviceApproved,
  findBootstrapAdminDevice,
  ownedBrowserSessions,
  requirePendingDeviceForUser,
  reserveDistinctLoopbackPorts,
  writeSandboxDirectLlmConfig,
} from './shared.js';
import { boxStubToolResponse } from './box-stub-response.js';

describe('UI sandbox port allocation', () => {
  test('returns distinct ports and serializes concurrent launcher startup', async () => {
    const ports = await reserveDistinctLoopbackPorts(5);
    expect(new Set(ports).size).toBe(5);

    const first = await acquireSandboxStartupLock();
    let secondAcquired = false;
    const secondPromise = acquireSandboxStartupLock(2_000).then((lock) => {
      secondAcquired = true;
      return lock;
    });
    await expect(acquireSandboxStartupLock(1)).rejects.toThrow('Timed out');
    expect(secondAcquired).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    second.release();
  });
});

describe('UI sandbox browser ownership', () => {
  test('does not mistake an inherited session alone for recorded ownership', () => {
    const identity = browserIdentity('/tmp/ordinary-root', {
      PLAYWRIGHT_CLI_SESSION: 'stale-inherited-session',
    });
    expect(identity.recorded).toBe(false);
    expect(identity.session).toBe('ui-sandbox-ordinary-root');
    expect(browserCliArgs(identity, ['open', 'about:blank'])[0]).toBe(
      '-s=ui-sandbox-ordinary-root',
    );
  });

  test('keeps recorded board ownership out of launcher cleanup', () => {
    expect(ownedBrowserSessions('run-a', 'run-a-member', true)).toEqual([
      'run-a-member',
    ]);
    expect(
      browserCliArgs({ session: 'run-a', recorded: true }, [
        'open',
        'about:blank',
      ]),
    ).toEqual(['open', 'about:blank']);
    expect(
      browserCliArgs({ session: 'run-a-member', recorded: false }, [
        'open',
        'about:blank',
      ]),
    ).toEqual(['-s=run-a-member', 'open', 'about:blank']);
  });

  test('reuses a persistent conversation browser without claiming it for launcher cleanup', () => {
    const identity = browserIdentity('/tmp/disposable-app', {
      CARAPA_BROWSER_SESSION_ID: 'browser-conversation',
      PLAYWRIGHT_CLI_SESSION: 'browser-conversation',
      PLAYWRIGHT_DAEMON_SESSION_DIR: '/tmp/pwcli-browser-conversation',
    });
    expect(identity.session).toBe('browser-conversation');
    expect(browserCliArgs(identity, ['open', 'http://127.0.0.1:5173'])).toEqual(
      ['open', 'http://127.0.0.1:5173'],
    );
    expect(
      ownedBrowserSessions(
        identity.session,
        'member',
        !!(identity.recorded || identity.managed),
      ),
    ).not.toContain(identity.session);
  });
});

describe('UI sandbox CarapaBox stub', () => {
  test('simulates board builds and delegates restarts to the control endpoint', async () => {
    process.env.UI_SANDBOX_BUILD_DELAY_MS = '0';
    const previousControlUrl = process.env.UI_SANDBOX_CONTROL_URL;
    try {
      const build = await boxStubToolResponse('build_service', {
        name: 'carapa-board',
      });
      expect(build.status).toBe(200);
      expect(await build.json()).toEqual({
        result: 'UI sandbox: simulated carapa-board build succeeded',
        isError: false,
      });

      const noControl = await boxStubToolResponse('restart_service', {
        name: 'carapa-board',
      });
      expect(noControl.status).toBe(503);
      expect((await noControl.json()).isError).toBe(true);

      let controlCalls = 0;
      const control = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async () => {
          controlCalls += 1;
          return Response.json({ ok: true });
        },
      });
      process.env.UI_SANDBOX_CONTROL_URL = control.url;
      const restart = await boxStubToolResponse('restart_service', {
        name: 'carapa-board',
      });
      expect(restart.status).toBe(200);
      expect(await restart.json()).toEqual({
        result: 'UI sandbox: restarted carapa-board',
        isError: false,
      });
      expect(controlCalls).toBe(1);
      control.stop(true);
    } finally {
      if (previousControlUrl === undefined)
        delete process.env.UI_SANDBOX_CONTROL_URL;
      else process.env.UI_SANDBOX_CONTROL_URL = previousControlUrl;
      delete process.env.UI_SANDBOX_BUILD_DELAY_MS;
    }
  });
});

describe('UI sandbox environment', () => {
  test('isolates storage and strips inherited database and provider credentials', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-ui-env-'));
    try {
      const env = buildSandboxEnv(
        {
          PATH: process.env.PATH,
          DATABASE_URL: '[REDACTED]',
          POSTGRES_HOST: 'production.example',
          POSTGRES_PASSWORD: 'do-not-copy',
          OPENAI_API_KEY: 'external-secret',
          OPENAI_BASE_URL: 'https://external-provider.example/v1',
        },
        root,
        31001,
        31002,
        31003,
        true,
        'http://127.0.0.1:31004/v1',
      );
      expect(env.CARAPA_DATA_DIR).toBe(root);
      expect(env.CARAPA_GROUPS_HOST_DIR).toBe(path.join(root, 'groups'));
      expect(env.DATABASE_URL).toBe(path.join(root, 'data', 'pglite'));
      expect(env.POSTGRES_HOST).toBeUndefined();
      expect(env.POSTGRES_PASSWORD).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENAI_BASE_URL).toBeUndefined();
      expect(env.CARAPA_BOX_URL).toBe('http://127.0.0.1:31003');
      expect(env.AUTO_START_SANDBOXES).toBe('false');
      expect(env.ENABLE_SCHEDULER).toBe('false');
      expect(env.UI_SANDBOX_TWO_USER).toBe('true');
      expect(env.UI_SANDBOX_LLM_BASE_URL).toBe('http://127.0.0.1:31004/v1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes a loopback-only valid Direct runtime catalog', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-ui-runtime-'));
    try {
      const configPath = writeSandboxDirectLlmConfig(
        root,
        'http://127.0.0.1:32123/v1',
      );
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config).toMatchObject({
        version: 2,
        connections: {
          simulator: {
            baseUrl: 'http://127.0.0.1:32123/v1',
            wireApi: 'responses',
          },
        },
        harnesses: { direct: { kind: 'direct' } },
        models: {
          'ui-simulator': {
            bindings: { direct: { connection: 'simulator' } },
          },
        },
        defaults: {
          chat: { harnessId: 'direct', modelId: 'ui-simulator' },
          kanban: {
            fallback: { harnessId: 'direct', modelId: 'ui-simulator' },
          },
        },
      });
      expect(() =>
        writeSandboxDirectLlmConfig(root, 'https://api.openai.com/v1'),
      ).toThrow('must use loopback HTTP');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('UI sandbox launcher lifecycle', () => {
  async function fakeLauncher(
    exitImmediately?: number,
    args: string[] = [],
    signalExit = 0,
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-ui-launcher-'));
    const marker = path.join(root, 'ready');
    const setsid = path.join(root, 'setsid');
    const bun = path.join(root, 'bun');
    fs.writeFileSync(setsid, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    fs.writeFileSync(
      bun,
      exitImmediately == null
        ? `#!/bin/sh\ntrap "exit ${signalExit}" TERM INT\nprintf "%s" "$*" > "$UI_LAUNCHER_MARKER"\nwhile :; do sleep 1; done\n`
        : `#!/bin/sh\nexit ${exitImmediately}\n`,
      { mode: 0o755 },
    );
    const child = Bun.spawn(['bash', 'scripts/ui-sandbox/run.sh', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ''}`,
        UI_LAUNCHER_MARKER: marker,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { child, marker, root };
  }

  test('returns zero after intentional interrupt cleanup', async () => {
    const fixture = await fakeLauncher(undefined, ['--two-user', '--keep']);
    try {
      await waitForFileState(fixture.root, () =>
        fs.existsSync(fixture.marker) &&
        fs.readFileSync(fixture.marker, 'utf8').length > 0
          ? true
          : undefined,
      );
      expect(fs.readFileSync(fixture.marker, 'utf8')).toBe(
        'scripts/ui-sandbox/start.ts --two-user --keep',
      );
      fixture.child.kill('SIGINT');
      expect(await fixture.child.exited).toBe(0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('propagates genuine child startup failures', async () => {
    const fixture = await fakeLauncher(23);
    try {
      expect(await fixture.child.exited).toBe(23);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('preserves a signal-cleanup failure through the supervisor', async () => {
    const fixture = await fakeLauncher(undefined, [], 19);
    try {
      await waitForFileState(fixture.root, () =>
        fs.existsSync(fixture.marker) &&
        fs.readFileSync(fixture.marker, 'utf8').length > 0
          ? true
          : undefined,
      );
      fixture.child.kill('SIGINT');
      expect(await fixture.child.exited).toBe(19);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('UI sandbox browser launcher ownership fixture', () => {
  test('runs concurrent ordinary and recorded launchers with owned cleanup', async () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-ui-browser-fixture-'),
    );
    const realBun = Bun.which('bun');
    if (!realBun) throw new Error('fixture requires bun');
    const fixtureServer = path.join(fixtureRoot, 'server.ts');
    fs.writeFileSync(
      fixtureServer,
      `const port = Number(Bun.argv[2]);
Bun.serve({ port, fetch: () => new Response('ok') });
await new Promise(() => {});
`,
    );
    const fakeBun = path.join(fixtureRoot, 'bun');
    fs.writeFileSync(
      fakeBun,
      `#!/bin/sh
if [ "$1" = scripts/ui-sandbox/seed.ts ]; then exit 0; fi
if [ "$1" = scripts/ui-sandbox/box-stub.ts ]; then exec "$REAL_BUN" "$FIXTURE_SERVER" "$UI_SANDBOX_BOX_PORT"; fi
if [ "$1" = --watch ]; then exec "$REAL_BUN" "$FIXTURE_SERVER" "$API_PORT"; fi
exec "$REAL_BUN" "$@"
`,
      { mode: 0o755 },
    );
    const fakeNpm = path.join(fixtureRoot, 'npm');
    fs.writeFileSync(
      fakeNpm,
      `#!/bin/sh
port=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --port ]; then port="$2"; shift; fi
  shift
done
exec "$REAL_BUN" "$FIXTURE_SERVER" "$port"
`,
      { mode: 0o755 },
    );
    const fakeCli = path.join(fixtureRoot, 'playwright-cli');
    const log = path.join(fixtureRoot, 'events.log');
    fs.writeFileSync(
      fakeCli,
      `#!/bin/sh
command=$(printf '%s' "$*" | tr '\\n\\t' '  ')
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$PLAYWRIGHT_CLI_SESSION" "$PLAYWRIGHT_DAEMON_SESSION_DIR" "$PLAYWRIGHT_DAEMON_SOCKETS_DIR" "$CARAPA_RECORD_DIR" "$command" >> "$FIXTURE_LOG"
if [ "$1" = close ] || [ "$2" = close ]; then
  if [ "$FIXTURE_CLOSE_FAILURE" = 1 ]; then echo '### Error: fixture close failed' >&2; exit 17; fi
  exit 0
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = state-save ]; then
    shift
    printf '%s' '{"cookies":[{"name":"carapa_session","value":"fixture-session"}],"origins":[]}' > "$1"
    exit 0
  fi
  shift
done
`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH ?? '';
    const launch = async (extraEnv: Record<string, string> = {}) => {
      const childEnv: Record<string, string> = {
        ...process.env,
        ...extraEnv,
        PATH: `${fixtureRoot}:${originalPath}`,
        PLAYWRIGHT_CLI_BIN: fakeCli,
        REAL_BUN: realBun,
        FIXTURE_SERVER: fixtureServer,
        FIXTURE_LOG: log,
      };
      if (extraEnv.CARAPA_RECORD !== '1') {
        for (const key of [
          'CARAPA_RECORD',
          'PLAYWRIGHT_CLI_SESSION',
          'PLAYWRIGHT_DAEMON_SESSION_DIR',
          'PLAYWRIGHT_DAEMON_SOCKETS_DIR',
          'CARAPA_RECORD_DIR',
          'CARAPA_RECORD_SESSION',
          'CARAPA_RECORD_DAEMON_DIR',
          'CARAPA_RECORD_SOCKETS_DIR',
        ])
          delete childEnv[key];
      }
      const child = Bun.spawn([realBun, 'scripts/ui-sandbox/start.ts'], {
        cwd: process.cwd(),
        env: childEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      let stdout = '';
      let stderr = '';
      const ready = Promise.withResolvers<void>();
      const read = async (
        stream: ReadableStream<Uint8Array>,
        target: 'stdout' | 'stderr',
      ) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          if (target === 'stdout') {
            stdout += decoder.decode(chunk.value);
            if (
              stdout.includes('Disposable CarapaBoard UI sandbox is ready.') &&
              stdout.includes('Browser:') &&
              /Data:\s+\/tmp\/[^\n]+\n/.test(stdout)
            )
              ready.resolve();
          } else stderr += decoder.decode(chunk.value);
        }
      };
      const readers = Promise.all([
        read(child.stdout, 'stdout'),
        read(child.stderr, 'stderr'),
      ]);
      await Promise.race([
        ready.promise,
        child.exited.then(() => {
          throw new Error(`launcher exited before ready: ${stdout}\n${stderr}`);
        }),
      ]);
      expect(stdout).toContain('Disposable CarapaBoard UI sandbox is ready.');
      const root = stdout.match(/Data:\s+(\/tmp\/[^\s]+)/)?.[1];
      const apiPort = Number(
        stdout.match(/API:\s+http:\/\/127\.0\.0\.1:(\d+)/)?.[1],
      );
      const uiPort = Number(
        stdout.match(/UI:\s+http:\/\/127\.0\.0\.1:(\d+)/)?.[1],
      );
      if (!root || !apiPort || !uiPort)
        throw new Error(`launcher omitted identity: ${stdout}`);
      return {
        child,
        stdout,
        stderr,
        root,
        apiPort,
        uiPort,
        stop: async () => {
          child.kill('SIGINT');
          const code = await child.exited;
          await readers;
          return { code, stdout, stderr };
        },
      };
    };

    let first: Awaited<ReturnType<typeof launch>> | undefined;
    let second: Awaited<ReturnType<typeof launch>> | undefined;
    const completed: Array<Awaited<ReturnType<typeof launch>>> = [];
    try {
      [first, second] = await Promise.all([launch(), launch()]);
      expect(first.root).not.toBe(second.root);
      expect(first.apiPort).not.toBe(second.apiPort);
      expect(first.uiPort).not.toBe(second.uiPort);
      expect(
        first.stdout.match(/Browser:\s+playwright-cli -s=([^\s]+)/)?.[1],
      ).not.toBe(
        second.stdout.match(/Browser:\s+playwright-cli -s=([^\s]+)/)?.[1],
      );

      const ordinaryResults = await Promise.all([first.stop(), second.stop()]);
      expect(ordinaryResults.map((result) => result.code)).toEqual([0, 0]);
      expect(fs.existsSync(first.root)).toBe(false);
      expect(fs.existsSync(second.root)).toBe(false);

      const events = fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t'));
      expect(events.every((event) => event.length === 5)).toBe(true);
      const ordinaryCloses = events.filter((event) =>
        event[4]?.endsWith('close'),
      );
      expect(ordinaryCloses).toHaveLength(2);
      expect(ordinaryCloses[0][1]).not.toBe(ordinaryCloses[1][1]);
      expect(ordinaryCloses[0][2]).not.toBe(ordinaryCloses[1][2]);

      const recordedEnv = (runId: string) => ({
        CARAPA_RECORD: '1',
        PLAYWRIGHT_CLI_SESSION: `project--task--${runId}`,
        PLAYWRIGHT_DAEMON_SESSION_DIR: path.join(fixtureRoot, runId, 'daemon'),
        PLAYWRIGHT_DAEMON_SOCKETS_DIR: path.join(fixtureRoot, runId, 'sockets'),
        CARAPA_RECORD_DIR: path.join(fixtureRoot, runId, 'recording'),
      });
      const runA = await launch(recordedEnv('run-a'));
      completed.push(runA);
      const runB = await launch(recordedEnv('run-b'));
      completed.push(runB);
      const retry = await launch(recordedEnv('retry-new-run-id'));
      completed.push(retry);
      const recordedResults = await Promise.all(
        completed.map((launcher) => launcher.stop()),
      );
      expect(recordedResults.map((result) => result.code)).toEqual([0, 0, 0]);
      for (const launcher of completed)
        expect(fs.existsSync(launcher.root)).toBe(false);

      const recordedEvents = fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t'));
      for (const runId of ['run-a', 'run-b', 'retry-new-run-id']) {
        const expected = recordedEnv(runId);
        const commands = recordedEvents.filter(
          (event) => event[0] === expected.PLAYWRIGHT_CLI_SESSION,
        );
        expect(commands.length).toBeGreaterThan(0);
        expect(commands.every((event) => !event[4]?.includes('-s='))).toBe(
          true,
        );
        expect(
          commands.every(
            (event) => event[1] === expected.PLAYWRIGHT_DAEMON_SESSION_DIR,
          ),
        ).toBe(true);
        expect(
          commands.every(
            (event) => event[2] === expected.PLAYWRIGHT_DAEMON_SOCKETS_DIR,
          ),
        ).toBe(true);
        expect(
          commands.every((event) => event[3] === expected.CARAPA_RECORD_DIR),
        ).toBe(true);
        expect(commands.some((event) => event[4]?.endsWith('close'))).toBe(
          false,
        );
      }

      const failing = await launch({ FIXTURE_CLOSE_FAILURE: '1' });
      const failingResult = await failing.stop();
      expect(failingResult.code).toBe(1);
      expect(failingResult.stderr).toContain('playwright-cli');
      expect(fs.existsSync(failing.root)).toBe(false);
    } finally {
      await Promise.allSettled([
        first?.stop(),
        second?.stop(),
        ...completed.map((launcher) => launcher.stop()),
      ]);
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('UI sandbox controlled backend restart', () => {
  // Runs the real start.ts with faked seed/stub/vite/playwright children so
  // the supervisor and the /restart-board control handler exercise the
  // production race: both await the same exited promise of the SIGTERM'd
  // backend.
  function writeFixture(root: string) {
    const realBun = Bun.which('bun');
    if (!realBun) throw new Error('fixture requires bun');
    fs.writeFileSync(
      path.join(root, 'server.ts'),
      `import fs from 'node:fs';

const port = Number(Bun.argv[2]);
const killMarker = process.env.FIXTURE_KILL_MARKER;
Bun.serve({
  port,
  fetch: () => Response.json({ status: 'ok', pid: process.pid }),
});
if (killMarker) {
  fs.watch(process.env.FIXTURE_KILL_DIRECTORY!, () => {
    if (fs.existsSync(killMarker)) process.exit(17);
  });
}
await new Promise(() => {});
`,
    );
    fs.writeFileSync(
      path.join(root, 'bun'),
      `#!/bin/sh
root=$(cd "$(dirname "$0")" && pwd)
if [ "$1" = scripts/ui-sandbox/seed.ts ]; then exit 0; fi
if [ "$1" = scripts/ui-sandbox/box-stub.ts ]; then exec "$REAL_BUN" "$FIXTURE_SERVER" "$UI_SANDBOX_BOX_PORT"; fi
if [ "$1" = --watch ]; then
  FIXTURE_KILL_MARKER="$root/kill-backend"
  FIXTURE_KILL_DIRECTORY="$root"
  export FIXTURE_KILL_MARKER FIXTURE_KILL_DIRECTORY
  exec "$REAL_BUN" "$FIXTURE_SERVER" "$API_PORT"
fi
exec "$REAL_BUN" "$@"
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(root, 'npm'),
      `#!/bin/sh
port=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --port ]; then port="$2"; shift; fi
  shift
done
exec "$REAL_BUN" "$FIXTURE_SERVER" "$port"
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(root, 'playwright-cli'),
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = state-save ]; then
    shift
    printf '%s' '{"cookies":[{"name":"carapa_session","value":"fixture-session"}],"origins":[]}' > "$1"
    exit 0
  fi
  shift
done
exit 0
`,
      { mode: 0o755 },
    );
    return { realBun };
  }

  test('re-arms the supervisor on controlled restarts and still tears down on a real crash', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-ui-restart-'));
    let child: Bun.Subprocess | undefined;
    let stdout = '';
    let stderr = '';
    let readers: Promise<void> = Promise.resolve();
    try {
      const { realBun } = writeFixture(root);
      const recordingKeys = [
        'CARAPA_RECORD',
        'PLAYWRIGHT_CLI_SESSION',
        'PLAYWRIGHT_DAEMON_SESSION_DIR',
        'PLAYWRIGHT_DAEMON_SOCKETS_DIR',
        'CARAPA_RECORD_DIR',
        'CARAPA_RECORD_SESSION',
        'CARAPA_RECORD_DAEMON_DIR',
        'CARAPA_RECORD_SOCKETS_DIR',
      ];
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ''}`,
        PLAYWRIGHT_CLI_BIN: path.join(root, 'playwright-cli'),
        REAL_BUN: realBun,
        FIXTURE_SERVER: path.join(root, 'server.ts'),
      };
      for (const key of recordingKeys) delete childEnv[key];
      child = Bun.spawn([realBun, 'scripts/ui-sandbox/start.ts'], {
        cwd: process.cwd(),
        env: childEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const read = async (
        stream: ReadableStream<Uint8Array>,
        append: (chunk: string) => void,
      ) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          append(decoder.decode(chunk.value));
        }
      };
      const ready = Promise.withResolvers<void>();
      readers = Promise.all([
        read(child.stdout, (chunk) => {
          stdout += chunk;
          if (
            stdout.includes('Disposable CarapaBoard UI sandbox is ready.') &&
            /Data:\s+\/tmp\/[^\n]+\n/.test(stdout)
          )
            ready.resolve();
        }),
        read(child.stderr, (chunk) => {
          stderr += chunk;
        }),
      ]);
      await Promise.race([
        ready.promise,
        child.exited.then(() => {
          throw new Error(`launcher exited before ready: ${stdout}\n${stderr}`);
        }),
      ]);
      expect(stdout).toContain('Disposable CarapaBoard UI sandbox is ready.');
      const dataRoot = stdout.match(/Data:\s+(\/tmp\/[^\s]+)/)?.[1];
      const apiPort = Number(
        stdout.match(/API:\s+http:\/\/127\.0\.0\.1:(\d+)/)?.[1],
      );
      const controlUrl = stdout.match(
        /Control:\s+(http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1];
      if (!dataRoot || !apiPort || !controlUrl)
        throw new Error(`launcher omitted identity: ${stdout}`);
      const health = async () => {
        const response = await fetch(`http://127.0.0.1:${apiPort}/health`);
        if (!response.ok) throw new Error(`health returned ${response.status}`);
        return (await response.json()) as { pid: number };
      };

      // Two controlled restarts: each must re-spawn the backend (new pid),
      // return ok, and leave the supervisor armed on the replacement.
      let previousPid = (await health()).pid;
      for (let round = 1; round <= 2; round += 1) {
        const restart = await fetch(`${controlUrl}/restart-board`, {
          method: 'POST',
        });
        expect(restart.status).toBe(200);
        expect(await restart.json()).toEqual({ ok: true });
        const nextPid = (await health()).pid;
        expect(
          nextPid,
          `backend was not re-spawned on restart ${round}`,
        ).not.toBe(previousPid);
        previousPid = nextPid;
      }

      // A genuine crash (no restart in flight) must still tear the sandbox
      // down exactly like before the re-arm fix.
      fs.writeFileSync(path.join(root, 'kill-backend'), 'crash');
      const exitCode = await child.exited;
      await readers;
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Backend exited with code 17');
      expect(fs.existsSync(dataRoot)).toBe(false);
    } finally {
      if (child && !child.exitedSettled) {
        child.kill('SIGINT');
        await child.exited;
      }
      await readers;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('UI sandbox two-user device approval helpers', () => {
  const pending = { deviceId: 'd1', username: 'ui-member', isApproved: false };
  const approved = { deviceId: 'd2', username: 'ui-member', isApproved: true };

  test('locates the pending device and distinguishes missing from already approved', () => {
    expect(requirePendingDeviceForUser([approved, pending], 'ui-member')).toBe(
      pending,
    );
    expect(() => requirePendingDeviceForUser([], 'ui-member')).toThrow(
      'did not register a pending device',
    );
    expect(() => requirePendingDeviceForUser([approved], 'ui-member')).toThrow(
      'already approved',
    );
  });

  test('asserts approval and selects only an admin without an approved device', () => {
    expect(() => assertUserDeviceApproved([pending], 'ui-member')).toThrow(
      'is not approved',
    );
    expect(() =>
      assertUserDeviceApproved([approved], 'ui-member'),
    ).not.toThrow();
    const adminPending = { ...pending, username: 'ui-admin' };
    expect(findBootstrapAdminDevice([pending, adminPending], 'ui-admin')).toBe(
      adminPending,
    );
    expect(
      findBootstrapAdminDevice(
        [adminPending, { ...approved, username: 'ui-admin' }],
        'ui-admin',
      ),
    ).toBeUndefined();
  });

  test('explains why two-user mode needs a browser', () => {
    expect(TWO_USER_BROWSER_REQUIRED_MESSAGE).toContain(
      'fresh device signature',
    );
  });
});
