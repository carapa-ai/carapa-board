import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import {
  createUser,
  deactivateDeviceIfSafe,
  initDatabase,
  registerDeviceKey,
} from '../../db.js';
import { signUserJwt, verifyJwt } from '../../lib/auth-jwt.js';
import {
  attachWebSocket,
  closeDeviceSockets,
  createWsTicket,
  setSessionVerifier,
} from './ws-events.js';

const approvedDevice = 'wsd-approved';
const spareDevice = 'wsd-spare';
const pendingDevice = 'wsd-pending';
const revokedDevice = 'wsd-revoked';
let server: Server;
let baseUrl: string;
let userId: string;

function open(path: string, session: string): Promise<WebSocket | number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${baseUrl}${path}`, {
      headers: { cookie: `carapa_session=${session}` },
    });
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_req, res) => resolve(res.statusCode!));
    socket.once('error', () => resolve(0));
  });
}

beforeAll(async () => {
  await initDatabase(':memory:');
  userId = (await createUser('wsd-user', 'password', 'admin')).id;
  for (const [id, approve] of [
    [approvedDevice, true],
    [spareDevice, true],
    [pendingDevice, false],
    [revokedDevice, true],
  ] as const) {
    await registerDeviceKey(id, userId, `key-${id}`, id, approve);
  }
  expect(await deactivateDeviceIfSafe(revokedDevice, userId)).toBe('ok');
  setSessionVerifier((session) => verifyJwt(session) !== null);
  server = createServer((_req, res) => res.writeHead(404).end());
  attachWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('WebSocket upgrade device gate', () => {
  for (const path of ['/api/ws', '/api/live-voice/ws']) {
    test(`${path} refuses revoked and pending devices, admits the rest`, async () => {
      expect(await open(path, signUserJwt(userId, revokedDevice))).toBe(401);
      expect(await open(path, signUserJwt(userId, pendingDevice))).toBe(403);
      expect(await open(path, signUserJwt(userId, 'wsd-unknown'))).toBe(401);
      for (const session of [
        signUserJwt(userId, approvedDevice),
        signUserJwt(userId),
      ]) {
        const socket = await open(path, session);
        expect(socket).toBeInstanceOf(WebSocket);
        (socket as WebSocket).close();
      }
    });
  }

  test('a ticket for a revoked device is refused, an approved one admitted', async () => {
    const connect = (session: string) =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket(
          `${baseUrl}/api/ws?ticket=${createWsTicket(session)}`,
        );
        socket.once('open', () => {
          socket.close();
          resolve(true);
        });
        socket.once('unexpected-response', () => resolve(false));
        socket.once('error', () => resolve(false));
      });
    expect(await connect(signUserJwt(userId, revokedDevice))).toBe(false);
    expect(await connect(signUserJwt(userId, approvedDevice))).toBe(true);
  });

  test('closeDeviceSockets closes only the matching device sockets', async () => {
    const target = (await open(
      '/api/ws',
      signUserJwt(userId, spareDevice),
    )) as WebSocket;
    const other = (await open(
      '/api/ws',
      signUserJwt(userId, approvedDevice),
    )) as WebSocket;
    const closed = new Promise<number>((resolve) =>
      target.once('close', resolve),
    );
    closeDeviceSockets(userId, spareDevice);
    expect(await closed).toBe(1008);
    expect(other.readyState).toBe(WebSocket.OPEN);
    other.close();
  });
});
