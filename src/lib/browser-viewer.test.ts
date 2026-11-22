import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { BrowserViewerService } from './browser-viewer.js';
import { BrowserIdleService } from '../sandbox/browser-idle.js';
import {
  ensurePersistentBrowser,
  browserSessionFile,
  readAllPersistentBrowsers,
  type PersistentBrowser,
} from '../sandbox/browser-sessions.js';
import type { ActiveRun } from '../modules/kanban/execution/types.js';

let server: Server;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  if (server?.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function setup(browser?: {
  idle: BrowserIdleService;
  persistent: PersistentBrowser;
}) {
  let authorized = true;
  let now = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const calls: {
    url: string;
    method: string;
    body?: string;
    token?: string;
  }[] = [];
  const run = {
    id: browser?.persistent.id || 'run-one',
    group_folder: 'project-one',
    sandbox_stack: 'carapa-bot',
    sandbox_service: 'agent',
    sandbox_instance: 'shared',
  } as ActiveRun;
  const service = new BrowserViewerService({
    authorize: async (user, project, id) =>
      authorized &&
      user === 'owner' &&
      project === run.group_folder &&
      id === run.id
        ? { run, session: {} as never, persistent: browser?.persistent }
        : null,
    baseUrl: 'http://box/mcp',
    token: 'private-box-token',
    now: () => now,
    idle: browser?.idle,
    fetch: (async (url: string, options: RequestInit) => {
      calls.push({
        url,
        method: options.method!,
        body: options.body as string,
        token: (options.headers as Record<string, string>).Authorization,
      });
      if (url.endsWith('/attach')) {
        let ownController: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            ownController = value;
          },
        });
        options.signal?.addEventListener(
          'abort',
          () => {
            try {
              ownController.close();
            } catch {}
          },
          { once: true },
        );
        emit({
          type: 'attached',
          viewerId: '00000000-0000-4000-8000-000000000001',
        });
        emit({ type: 'ready' });
        return new Response(stream);
      }
      return new Response('{}');
    }) as typeof fetch,
  });
  function emit(event: unknown) {
    controller!.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
  }
  server = createServer();
  server.on('upgrade', (req, socket, head) => {
    // This seam stands in for the shared router's already-validated user ticket.
    (req as typeof req & { __userId: string }).__userId = new URL(
      req.url!,
      'http://localhost',
    ).searchParams.get('user')!;
    void service.upgrade(req, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Run this test in the supported Carapa sandbox');
  function connect(id: string, user = 'owner') {
    const ws = new WebSocket(
      `ws://127.0.0.1:${(address as { port: number }).port}/api/browser/ws?viewerId=${id}&user=${user}`,
    );
    clients.push(ws);
    ws.on('error', () => {});
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    const opened = once(ws, 'open');
    return { ws, messages, opened };
  }
  return {
    service,
    calls,
    emit,
    connect,
    revoke: () => {
      authorized = false;
    },
    expire: () => {
      now = 30001;
    },
  };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error('Browser transport condition timed out');
}

test('rejects other projects, users, expired handles, and handle replay', async () => {
  const h = await setup();
  expect(await h.service.issue('owner', 'other-project', 'run-one')).toBeNull();
  const wrongUser = await h.service.issue('owner', 'project-one', 'run-one');
  await expect(h.connect(wrongUser!, 'intruder').opened).rejects.toThrow();
  await expect(h.connect(wrongUser!).opened).rejects.toThrow();
  const expired = await h.service.issue('owner', 'project-one', 'run-one');
  h.expire();
  await expect(h.connect(expired!).opened).rejects.toThrow();
  expect(h.calls).toHaveLength(0);
});

test('streams frames, batches ordered input, and reconnects without closing the browser', async () => {
  const h = await setup();
  const id = await h.service.issue('owner', 'project-one', 'run-one');
  const client = h.connect(id!);
  await client.opened;
  await until(() => client.messages.length > 0);
  h.emit({
    type: 'message',
    data: JSON.stringify({ method: 'frame', params: { data: 'image' } }),
  });
  const messages = [
    { id: 1, method: 'keydown', params: { key: 'a' } },
    { id: 2, method: 'keyup', params: { key: 'a' } },
  ];
  for (const message of messages) client.ws.send(JSON.stringify(message));
  await until(
    () =>
      h.calls.some((call) => call.url.endsWith('/input')) &&
      client.messages.some((message) => message.method === 'frame'),
  );
  const input = h.calls.find((call) => call.url.endsWith('/input'))!;
  expect(JSON.parse(input.body!).map(JSON.parse)).toEqual(messages);
  expect(h.calls[0].token).toBe('Bearer private-box-token');
  expect(JSON.parse(h.calls[0].body!)).toEqual({
    stack: 'carapa-bot',
    service: 'agent',
    instance: 'shared',
    sessionId: 'run-one',
  });
  expect(JSON.stringify(client.messages)).not.toContain('private-box-token');
  const closed = once(client.ws, 'close');
  client.ws.close();
  await closed;
  await until(() => h.calls.some((call) => call.method === 'DELETE'));
  const next = await h.service.issue('owner', 'project-one', 'run-one');
  await h.connect(next!).opened;
  await expect(h.connect(id!).opened).rejects.toThrow();
  expect(h.calls.filter((call) => call.url.endsWith('/attach'))).toHaveLength(
    2,
  );
});

test('rechecks access at upgrade and terminates an attached viewer when its run ends or access is revoked', async () => {
  const h = await setup();
  const client = h.connect(
    (await h.service.issue('owner', 'project-one', 'run-one'))!,
  );
  await client.opened;
  const pending = await h.service.issue('owner', 'project-one', 'run-one');
  h.revoke();
  await expect(h.connect(pending!).opened).rejects.toThrow();
  await until(() =>
    client.messages.some((message) => message.params?.state === 'ended'),
  );
  await until(() => h.calls.some((call) => call.method === 'DELETE'));
}, 5000);

test('completion and recovery share ordered browser cleanup and ignore legacy runs', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { DATA_DIR } = await import('../config.js');
  const { finalizeRunBrowser } =
    await import('../sandbox/browser-lifecycle.js');
  const instance = `browser-recovery-test-${process.pid}`;
  const run = {
    id: 'run-recovery',
    group_folder: instance,
    task_id: 'task',
    sandbox_stack: 'carapa-bot',
    sandbox_service: 'agent',
    sandbox_instance: instance,
  } as ActiveRun;
  const ipc = path.join(DATA_DIR, 'ipc', `carapa-bot-${instance}`);
  const dir = path.join(ipc, 'runs', run.id);
  const calls: string[] = [];
  const client = {
    sandboxExec: async (_stack: string, _service: string, command: string) => {
      calls.push(command);
      return { isError: false, stdout: '' };
    },
  } as never;
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'args.json'), JSON.stringify({ env: {} }));
    await finalizeRunBrowser(run, client);
    expect(calls).toHaveLength(0);
    fs.writeFileSync(
      path.join(dir, 'args.json'),
      JSON.stringify({
        env: {
          CARAPA_BROWSER_RUN_ID: run.id,
          CARAPA_RECORD: '1',
          CARAPA_RECORD_SESSION: 'scoped-run',
          PLAYWRIGHT_DAEMON_SESSION_DIR: '/tmp/pwcli-scoped-run',
        },
      }),
    );
    await Promise.all([
      finalizeRunBrowser(run, client),
      finalizeRunBrowser(run, client),
    ]);
    expect(calls).toEqual([
      "record-end.sh '/tmp/pwcli-scoped-run' 'scoped-run' 'run-recovery'",
      'browser-close run-recovery',
    ]);
    calls.length = 0;
    fs.writeFileSync(
      path.join(dir, 'args.json'),
      JSON.stringify({
        env: {
          CARAPA_BROWSER_RUN_ID: run.id,
          CARAPA_BROWSER_SESSION_ID: 'persistent-conversation',
          CARAPA_RECORD: '0',
        },
      }),
    );
    await finalizeRunBrowser({ ...run, task_id: null }, client);
    expect(calls).toHaveLength(0); // A completed or cancelled chat turn does not close its browser.
  } finally {
    fs.rmSync(ipc, { recursive: true, force: true });
  }
});

// Automatic resource reclamation is a new core browser lifecycle: a lost or
// hidden viewer must allow expiry, while visible viewers and agent runs must
// never be interrupted. Exercise it through the real WebSocket attachment.
test('idle expiry protects viewers and agents, persists closure, and serializes reopening', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-idle-'));
  const timeout = 15 * 60_000;
  let now = Date.now();
  let busy = false;
  let ownerActivity = now;
  let finishClose: (() => void) | undefined;
  let enterClose: (() => void) | undefined;
  const closed: string[] = [];
  const browser = ensurePersistentBrowser(
    {
      projectId: 'project-one',
      conversationId: 'conversation-one',
      stack: 'carapa-bot',
      instance: 'idle-check',
      service: 'agent',
      workDir: '/workspace/project-one',
      worktree: null,
    },
    root,
  );
  const deps = {
    now: () => now,
    timeoutMs: timeout,
    dataDir: root,
    list: () => readAllPersistentBrowsers(root),
    owner: async () => ({ busy, lastActivityAt: ownerActivity }),
    close: async () => {
      closed.push(browser.id);
      if (enterClose) {
        const wait = new Promise<void>((resolve) => {
          finishClose = resolve;
        });
        enterClose();
        await wait;
      }
    },
  };
  const idle = new BrowserIdleService(deps);
  const h = await setup({ idle, persistent: browser });
  const first = h.connect(
    (await h.service.issue('owner', 'project-one', browser.id))!,
  );
  const second = h.connect(
    (await h.service.issue('owner', 'project-one', browser.id))!,
  );
  try {
    await Promise.all([first.opened, second.opened]);
    await until(
      () => h.calls.filter((call) => call.url.endsWith('/attach')).length === 2,
    );
    now += timeout + 1;
    expect(await idle.sweep()).toBe(0);
    first.ws.send(
      JSON.stringify({
        id: 1,
        method: 'setVisible',
        params: { visible: false },
      }),
    );
    await until(
      () => h.calls.filter((call) => call.url.endsWith('/input')).length === 1,
    );
    now += timeout + 1;
    expect(await idle.sweep()).toBe(0); // The second user is still viewing.
    second.ws.send(
      JSON.stringify({
        id: 2,
        method: 'setVisible',
        params: { visible: false },
      }),
    );
    await until(
      () => h.calls.filter((call) => call.url.endsWith('/input')).length === 2,
    );
    now += timeout + 1;
    busy = true;
    expect(await idle.sweep()).toBe(0);
    busy = false;
    expect(await idle.sweep()).toBe(0); // A full idle window after the run.
    now += timeout + 1;
    ownerActivity = now;
    expect(await idle.sweep()).toBe(0); // A new conversation message resets it.
    now += timeout + 1;
    expect(await idle.sweep()).toBe(1);
    expect(closed).toEqual([browser.id]);
    expect(fs.existsSync(browserSessionFile(browser, root))).toBe(true);
    expect(await new BrowserIdleService(deps).sweep()).toBe(0); // Board restart.

    await idle.use(browser, () => {});
    now += timeout + 1;
    const closing = new Promise<void>((resolve) => {
      enterClose = resolve;
    });
    const sweep = idle.sweep();
    await closing;
    let reopened = false;
    const reopen = idle.use(browser, () => {
      reopened = true;
    });
    await Promise.resolve();
    expect(reopened).toBe(false);
    finishClose!();
    await Promise.all([sweep, reopen]);
    enterClose = undefined;
    expect(reopened).toBe(true);
    expect(await idle.sweep()).toBe(0);
  } finally {
    finishClose?.();
    first.ws.terminate();
    second.ws.terminate();
    await until(
      () => h.calls.filter((call) => call.method === 'DELETE').length === 2,
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
