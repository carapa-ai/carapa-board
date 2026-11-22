/**
 * Regression tests for checkoutTaskBranch.
 *
 * checkoutTaskBranch used to fire the async updateTask() without awaiting it,
 * read the task back through the async getTask() without awaiting it, and
 * broadcast the pending Promise as the `task_updated` payload — which
 * JSON-serialized to {} for connected clients. The un-awaited branch_name
 * write also raced the `started_at` update the pipeline issues for the same
 * row immediately after slot acquisition.
 *
 * These tests exercise the real WebSocket boundary: a live HTTP server with
 * attachWebSocket() and a ws client authenticated through the API-token
 * ticket (an unscoped connection, which queueClientEvent forwards every
 * event to). No module mocking is used so the shared `bun test` process
 * keeps the real ws-events exports for the other test files.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';

import { createTask, createUser, getTask, initDatabase } from '../db.js';
import { signUserJwt, verifyJwt } from './auth-jwt.js';
import {
  attachWebSocket,
  createWsTicket,
  setSessionVerifier,
} from '../modules/objectives/ws-events.js';
import type { RegisteredGroup } from '../types.js';
import { taskFixture, truncateTestDb } from '../test-helpers.js';
import { checkoutTaskBranch, getBranchNameForTask } from './git-ops.js';

const PROJ = 'checkout-branch-proj';

interface WsClient {
  socket: WebSocket;
  events: { type: string; payload?: unknown }[];
  lastMessageAt: number;
}

function groupWithBranches(): RegisteredGroup {
  return {
    name: PROJ,
    jid: `${PROJ}@test`,
    folder: PROJ,
    trigger: '',
    added_at: new Date().toISOString(),
    settings: { taskCheckoutMode: 'worktree' },
  };
}

function waitForEvent(
  ws: WsClient,
  type: string,
  timeoutMs = 3000,
): Promise<{ type: string; payload?: unknown }> {
  return new Promise((resolve, reject) => {
    const existing = ws.events.find((e) => e.type === type);
    if (existing) return resolve(existing);
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${type}`)),
      timeoutMs,
    );
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as {
        type: string;
        payload?: unknown;
      };
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.socket.off('message', onMessage);
      resolve(message);
    };
    ws.socket.on('message', onMessage);
  });
}

async function connectClient(): Promise<WsClient> {
  // Admins receive every project's events; truncation removed earlier users.
  const admin = await createUser('checkout-ws-admin', 'pw', 'admin');
  const ticket = createWsTicket(signUserJwt(admin.id));
  const socket = new WebSocket(
    `${baseUrl}/api/ws?ticket=${encodeURIComponent(ticket)}`,
  );
  const ws: WsClient = { socket, events: [], lastMessageAt: 0 };
  socket.on('message', (raw) => {
    ws.events.push(
      JSON.parse(String(raw)) as { type: string; payload?: unknown },
    );
    ws.lastMessageAt = Date.now();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  await waitForEvent(ws, 'connected');
  return ws;
}

let server: Server;
let baseUrl = '';
let client: WsClient | null = null;

beforeAll(async () => {
  setSessionVerifier((session) => verifyJwt(session) !== null);
  await initDatabase(':memory:');
  server = createServer((_req, res) => res.writeHead(404).end());
  attachWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `ws://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await truncateTestDb();
  client = await connectClient();
});

afterEach(async () => {
  client?.socket.close();
  client = null;
});

afterAll(async () => {
  server.close();
});

describe('checkoutTaskBranch', () => {
  test('persists the branch before returning and broadcasts the resolved task', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    const expectedBranch = getBranchNameForTask(task);

    const event = waitForEvent(client!, 'task_updated');
    await checkoutTaskBranch(task, groupWithBranches());

    // The write must be durable before the callback returns: the pipeline
    // immediately issues the started_at update for the same row.
    const persisted = await getTask(task.id);
    expect(persisted?.branch_name).toBe(expectedBranch);

    const received = await event;
    // The payload used to be a pending Promise, which JSON-serialized to {}
    // for connected clients; it must be the resolved task.
    expect(received.payload).toMatchObject({
      id: task.id,
      branch_name: expectedBranch,
    });
  });

  test('does nothing when branch-per-task is not enabled', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));

    await checkoutTaskBranch(task, {
      folder: PROJ,
      settings: {},
    } as RegisteredGroup);

    expect((await getTask(task.id))?.branch_name).toBeNull();
  });

  test('preserves an already persisted branch', async () => {
    const task = await createTask(
      taskFixture({
        project_id: PROJ,
        branch_name: 'already-persisted-branch',
      }),
    );

    await checkoutTaskBranch(task, groupWithBranches());

    expect((await getTask(task.id))?.branch_name).toBe(
      'already-persisted-branch',
    );
  });
});
