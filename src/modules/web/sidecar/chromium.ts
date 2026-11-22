import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import type { BrowserProcess } from './sessions.js';

/** No shell, inherited agent configuration, proxy, or shared browser profile. */
export async function launchChromium(
  _id: string,
  signal: AbortSignal,
): Promise<BrowserProcess> {
  signal.throwIfAborted();
  const dir = await mkdtemp('/tmp/web-browser-');
  const child = spawn(
    process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--no-proxy-server',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      'about:blank',
    ],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        XDG_CACHE_HOME: dir,
        LANG: 'C.UTF-8',
      },
    },
  );
  let failure: Error | undefined;
  child.on('error', (error) => {
    failure = error;
  });
  let exited = false;
  const closed = once(child, 'close')
    .catch(() => undefined)
    .then(() => {
      exited = true;
    });
  let stopping: Promise<void> | undefined;
  const killGroup = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch (error: any) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const stop = () =>
    (stopping ??= (async () => {
      killGroup('SIGTERM');
      await Promise.race([closed, Bun.sleep(2000)]);
      killGroup('SIGKILL');
      await closed;
      await rm(dir, { recursive: true, force: true });
    })());
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (failure || exited)
        throw new Error('Chromium exited during sidecar startup');
      const contents = await readFile(
        `${dir}/DevToolsActivePort`,
        'utf8',
      ).catch(() => '');
      const [port, wsPath] = contents.trim().split('\n');
      if (
        /^\d+$/.test(port || '') &&
        /^\/devtools\/browser\/[a-f0-9-]+$/.test(wsPath || '')
      ) {
        return { endpoint: `ws://127.0.0.1:${port}${wsPath}`, closed, stop };
      }
      await Bun.sleep(50);
    }
    throw new Error('Chromium sidecar startup timed out');
  } catch (error) {
    await stop();
    throw error;
  }
}
