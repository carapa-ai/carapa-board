import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface BrowserTestRuntime {
  root: string;
  port: number;
  url: string;
  session: string;
  recorded: boolean;
  managed: boolean;
  env: Record<string, string>;
  cliArgs(args: string[]): string[];
  cleanup(): void;
}

interface BunSubprocessLike {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

/** Vite prints its address after listening; await that startup signal instead of
 * spending test time repeatedly probing a port that has not opened yet. */
export async function waitForViteReady(
  process: Pick<BunSubprocessLike, 'stdout' | 'exited'>,
): Promise<void> {
  const reader = process.stdout.getReader();
  const ready = async () => {
    const decoder = new TextDecoder();
    let output = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done)
          throw new Error('Vite closed stdout before publishing its address');
        output = (output + decoder.decode(value, { stream: true })).slice(
          -4096,
        );
        // Coloured output (CI/FORCE_COLOR) puts an escape between "Local" and ":".
        const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
        if (/Local:\s+https?:\/\//.test(plain)) return;
      }
    } finally {
      reader.releaseLock();
    }
  };
  await Promise.race([
    ready(),
    process.exited.then((code) => {
      throw new Error(`Vite exited before readiness (exit ${code})`);
    }),
  ]);
}

interface BunRuntimeLike {
  spawn(
    command: string[],
    options: {
      env: Record<string, string>;
      stdout: 'pipe';
      stderr: 'pipe';
    },
  ): BunSubprocessLike;
}

const bunRuntime = (globalThis as { Bun?: BunRuntimeLike }).Bun;
let recordedSessionTail = Promise.resolve();
const allocatedLoopbackPorts = new Set<number>();

export async function acquireRecordedSession(
  runtime: BrowserTestRuntime,
): Promise<() => void> {
  if (!runtime.recorded && !runtime.managed) return () => {};
  const previous = recordedSessionTail;
  let release!: () => void;
  recordedSessionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

async function runPlaywrightCliOnce(
  runtime: BrowserTestRuntime,
  args: string[],
  sessionOverride?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const commandArgs =
    sessionOverride && !runtime.recorded && !runtime.managed
      ? [`-s=${sessionOverride}`, ...args]
      : runtime.cliArgs(args);
  if (!bunRuntime) throw new Error('Browser runtime requires Bun');
  const child = bunRuntime.spawn(['playwright-cli', ...commandArgs], {
    env: runtime.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

export async function runBrowserCli(
  runtime: BrowserTestRuntime,
  args: string[],
  sessionOverride?: string,
): Promise<string> {
  let result = await runPlaywrightCliOnce(runtime, args, sessionOverride);
  const hasModalError =
    result.stdout.includes('does not handle the modal state') ||
    result.stderr.includes('does not handle the modal state');
  if (hasModalError) {
    // A prior suite may have left a page confirm open in a board-owned
    // recorded browser. Dismiss only that runtime's active dialog, but never
    // hide the original command failure or retry it as though it succeeded.
    const dismissed = await runPlaywrightCliOnce(
      runtime,
      ['dialog-dismiss'],
      sessionOverride,
    );
    if (
      dismissed.code !== 0 ||
      dismissed.stdout.includes('### Error') ||
      dismissed.stderr.includes('### Error')
    ) {
      throw new Error(dismissed.stderr || dismissed.stdout);
    }
  }
  if (
    result.code !== 0 ||
    result.stdout.includes('### Error') ||
    result.stderr.includes('### Error')
  ) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout;
}

async function allocateLoopbackPort(): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Could not allocate a loopback port'));
          return;
        }
        server.close((error) =>
          error ? reject(error) : resolve(address.port),
        );
      });
    });
    if (!allocatedLoopbackPorts.has(port)) {
      // Keep this process-local reservation until the runtime is cleaned up;
      // suites allocate before handing the port to Vite.
      allocatedLoopbackPorts.add(port);
      return port;
    }
  }
}

function hasBoardRecordingEnvironment(): boolean {
  return Boolean(
    process.env.CARAPA_RECORD === '1' &&
    process.env.PLAYWRIGHT_CLI_SESSION &&
    process.env.PLAYWRIGHT_DAEMON_SESSION_DIR &&
    process.env.PLAYWRIGHT_DAEMON_SOCKETS_DIR &&
    process.env.CARAPA_RECORD_DIR,
  );
}

export async function allocateBrowserTestRuntime(
  prefix: string,
): Promise<BrowserTestRuntime> {
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `carapa-${prefix}-${nonce}-`),
  );
  const port = await allocateLoopbackPort();
  const recorded = hasBoardRecordingEnvironment();
  const managed = Boolean(
    (process.env.CARAPA_BROWSER_SESSION_ID ||
      process.env.CARAPA_BROWSER_RUN_ID) &&
    process.env.PLAYWRIGHT_CLI_SESSION &&
    process.env.PLAYWRIGHT_DAEMON_SESSION_DIR,
  );
  const boardOwned = recorded || managed;
  // `session` is this allocation's diagnostic/ordinary ownership identity.
  // Recorded commands remain bound to the injected board session through the
  // child environment and intentionally omit -s; keeping the allocation
  // identity unique prevents ambient recorded metadata from collapsing two
  // runtime allocations into one test owner.
  const session = `${prefix}-${nonce}`;
  const daemonDir = path.join(root, 'daemon');
  const socketsDir = path.join(root, 'sockets');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.mkdirSync(socketsDir, { recursive: true });
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PLAYWRIGHT_DAEMON_SESSION_DIR: boardOwned
      ? (process.env.PLAYWRIGHT_DAEMON_SESSION_DIR ?? daemonDir)
      : daemonDir,
    PLAYWRIGHT_DAEMON_SOCKETS_DIR: boardOwned
      ? (process.env.PLAYWRIGHT_DAEMON_SOCKETS_DIR ?? socketsDir)
      : socketsDir,
  };
  if (!boardOwned) {
    delete env.CARAPA_RECORD;
    delete env.PLAYWRIGHT_CLI_SESSION;
    delete env.CARAPA_RECORD_DIR;
    delete env.CARAPA_RECORD_SESSION;
    delete env.CARAPA_RECORD_DAEMON_DIR;
    delete env.CARAPA_RECORD_SOCKETS_DIR;
  }

  return {
    root,
    port,
    url: `http://127.0.0.1:${port}`,
    session,
    recorded,
    managed,
    env,
    cliArgs: (args) => (boardOwned ? args : [`-s=${session}`, ...args]),
    cleanup: () => {
      // The root belongs to this helper even in recorded mode. The injected
      // daemon/session/recording paths remain board-owned and are never
      // removed here.
      fs.rmSync(root, { recursive: true, force: true });
      allocatedLoopbackPorts.delete(port);
    },
  };
}
