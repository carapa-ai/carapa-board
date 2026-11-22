import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

// Box credentials/DB are out of scope: the registry is replaced so each test
// controls exactly when authentication and hello recording complete.
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

let authGate: Deferred | null = null;
let authStarted: Deferred | null = null;
let helloGate: Deferred | null = null;
let helloStarted: Deferred | null = null;
let touched: Deferred | null = null;

mock.module('./registry.js', () => ({
  defaultIsolationLevel: () => 'container',
  authenticateBox: async (id: string) => {
    authStarted?.resolve();
    await authGate?.promise;
    return {
      id,
      label: id,
      kind: 'docker',
      tokenPrefix: '',
      isolationLevel: 'container',
      version: null,
      capabilities: [],
      createdAt: '',
      lastSeenAt: null,
      revokedAt: null,
    };
  },
  recordBoxHello: async () => {
    helloStarted?.resolve();
    await helloGate?.promise;
  },
  touchBox: async () => {
    touched?.resolve();
  },
}));

const {
  BOX_CONNECT_PATH,
  BOX_REVOKED_CLOSE_CODE,
  disconnectBox,
  getBoxConnection,
  handleBoxUpgrade,
  onBoxConnectionChange,
} = await import('./connections.js');

let server: Server;
let port: number;
const boxes: WebSocket[] = [];

beforeAll(async () => {
  server = createServer();
  server.on('upgrade', (req, socket, head) => {
    void handleBoxUpgrade(req, socket, head);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of boxes) ws.terminate();
  await new Promise<void>((r) => server.close(() => r()));
});

interface FakeBox {
  ws: WebSocket;
  /** Resolves once Board has sent its MCP `initialize` request. */
  initializeReceived: Promise<void>;
  /** Answers the withheld `initialize` request. */
  release(): void;
  closed: Promise<number>;
}

/** Dial Board like a CarapaBox, withholding the initialize reply until release(). */
function dialBox(id: string): FakeBox {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${BOX_CONNECT_PATH}`, {
    headers: { authorization: 'Bearer cbx_test', 'x-carapa-box-id': id },
  });
  boxes.push(ws);
  const received = deferred();
  let initialize: { id: number; protocolVersion: string } | null = null;
  ws.on('error', () => {});
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.method !== 'initialize') return;
    initialize = {
      id: message.id,
      protocolVersion: message.params.protocolVersion,
    };
    received.resolve();
  });
  const closed = new Promise<number>((resolve) =>
    ws.on('close', (code) => resolve(code)),
  );
  return {
    ws,
    initializeReceived: received.promise,
    release() {
      if (!initialize) throw new Error('initialize not received');
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: initialize.id,
          result: {
            protocolVersion: initialize.protocolVersion,
            capabilities: {},
            serverInfo: { name: 'fake-box', version: '0' },
          },
        }),
      );
    },
    closed,
  };
}

describe('box connection handshake', () => {
  test('disconnectBox during authentication rejects the upgrade', async () => {
    authGate = deferred();
    authStarted = deferred();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BOX_CONNECT_PATH}`, {
      headers: { authorization: 'Bearer cbx_test', 'x-carapa-box-id': 'auth' },
    });
    boxes.push(ws);
    const status = new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => {});
    });
    await authStarted.promise;
    disconnectBox('auth');
    authGate.resolve();
    expect(await status).toBe(401);
    expect(getBoxConnection('auth')).toBeUndefined();
    authGate = null;
    authStarted = null;
  });

  test('disconnectBox during the MCP initialize closes the pending socket', async () => {
    const box = dialBox('pending');
    await box.initializeReceived;
    disconnectBox('pending', 'revoked');
    expect(await box.closed).toBe(BOX_REVOKED_CLOSE_CODE);
    // A late initialize reply must not resurrect the connection.
    expect(getBoxConnection('pending')).toBeUndefined();
  });

  test('a socket closing while the hello is recorded leaves no entry, interval or online event', async () => {
    const intervals: unknown[] = [];
    const cleared: unknown[] = [];
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const handle = realSet(fn, ms);
      if (ms === 20_000) intervals.push(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((
      handle: Parameters<typeof clearInterval>[0],
    ) => {
      cleared.push(handle);
      realClear(handle);
    }) as typeof clearInterval;
    const events: string[] = [];
    const off = onBoxConnectionChange((e) =>
      events.push(`${e.boxId}:${e.online}`),
    );
    helloGate = deferred();
    helloStarted = deferred();
    touched = deferred();
    try {
      const box = dialBox('drop');
      await box.initializeReceived;
      box.release();
      await helloStarted.promise;
      box.ws.close();
      // The close handler's touchBox is the observable cleanup barrier.
      await touched.promise;
      const hello = helloGate;
      hello.resolve();
      // Let the awaited hello continuation run to completion.
      await new Promise((r) => setImmediate(r));
      expect(getBoxConnection('drop')).toBeUndefined();
      expect(intervals).toHaveLength(1);
      expect(cleared).toContain(intervals[0]);
      expect(events).toEqual([]);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      off();
      helloGate = helloStarted = touched = null;
    }
  });

  test('two concurrent connections for one box leave exactly one open socket', async () => {
    const first = dialBox('dup');
    const second = dialBox('dup');
    await Promise.all([first.initializeReceived, second.initializeReceived]);
    first.release();
    second.release();
    // One of the two is replaced and closed with 4000; the other stays up.
    const [winner, loser] = await Promise.race([
      first.closed.then(() => [second, first] as const),
      second.closed.then(() => [first, second] as const),
    ]);
    expect(await loser.closed).toBe(4000);
    expect(winner.ws.readyState).toBe(WebSocket.OPEN);
    expect(getBoxConnection('dup')).toBeDefined();
  });
});
