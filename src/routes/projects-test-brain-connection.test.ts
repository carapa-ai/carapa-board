import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createUser, getUserById, initDatabase } from '../db.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { refreshBrainPortCache } from '../modules/objectives/brain-client.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import projectsRouter from './projects.js';

const pid = `test-brain-conn-${process.pid}`;
const jid = `${pid}@web`;
const TOKEN = 'secret-brain-token-xyz';
const INGRESS_HOST = 'ingress.brain-test.invalid';
const INGRESS_PORT = 48123;
const realFetch = globalThis.fetch;
let server: Server;
let baseUrl: string;
let adminId: string;

const ps = (services: object[], ingress: object[] = []) => ({
  stdout: JSON.stringify([{ name: 'stack-x', services, ingress }]),
  isError: false,
});
const svc = (service: string, hostname: string, ports: string[] = []) => ({
  service,
  hostname,
  status: 'running',
  ports,
});
const ingressFor = (service: string) => ({
  service,
  kind: 'http',
  host: INGRESS_HOST,
  port: INGRESS_PORT,
  direct: true,
});
const NO_STACKS = { stdout: 'No running compose projects', isError: false };

function stubPs(result: { stdout: string; isError: boolean }) {
  spyOn(getSandboxClient(), 'sandboxPs').mockResolvedValue(result);
}

/** Answer brain requests with `brain`; let the test's own requests through. */
function stubBrainFetch(brain: () => Promise<Response>) {
  spyOn(globalThis, 'fetch').mockImplementation(((
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) =>
    String(input).startsWith(baseUrl)
      ? realFetch(input, init)
      : brain()) as typeof fetch);
}

async function testConnection(brainContainer: string) {
  const response = await realFetch(
    `${baseUrl}/projects/${pid}/test-brain-connection`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brainContainer, brainAuthToken: TOKEN }),
    },
  );
  const body = await response.json();
  const text = JSON.stringify(body);
  for (const secret of [TOKEN, INGRESS_HOST, String(INGRESS_PORT)])
    expect(text).not.toContain(secret);
  return body;
}

const connectionError = (code: string) =>
  Object.assign(new Error(`connect ${code} ${INGRESS_HOST}:${INGRESS_PORT}`), {
    code,
  });

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  adminId = (await createUser(`${pid}-admin`, 'password', 'admin')).id;
  await registerGroup(jid, {
    jid,
    name: 'Brain connection test',
    folder: pid,
    trigger: '@brain',
    added_at: new Date().toISOString(),
    settings: { status: 'running', disableObservations: false },
  });

  const app = express();
  app.use(express.json());
  app.use(async (req: any, _res, next) => {
    req.authUser = await getUserById(adminId);
    next();
  });
  app.use(projectsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  (globalThis.fetch as { mockRestore?: () => void }).mockRestore?.();
  (
    getSandboxClient().sandboxPs as { mockRestore?: () => void }
  ).mockRestore?.();
  // Drop cached URLs so each case resolves from its own sandbox_ps.
  spyOn(getSandboxClient(), 'sandboxPs').mockResolvedValue(NO_STACKS);
  await refreshBrainPortCache();
  (
    getSandboxClient().sandboxPs as { mockRestore?: () => void }
  ).mockRestore?.();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unregisterGroup(jid);
});

describe('POST /projects/:pid/test-brain-connection', () => {
  test('not-found: container absent from sandbox_ps', async () => {
    stubPs(ps([svc('carapa-brain', 'other-brain')]));
    expect(await testConnection('missing-brain')).toEqual({
      result: 'not-found',
    });
  });

  test('no-endpoint: listed service without HTTP ingress', async () => {
    stubPs(
      ps([
        svc('carapa-brain', 'brain-host-1'),
        svc('worker', 'worker-1', ['43111->3111/tcp']),
      ]),
    );
    expect(await testConnection('brain-host-1')).toEqual({
      result: 'no-endpoint',
    });
    // A bare stack name is not a hostname.
    expect(await testConnection('stack-x')).toEqual({ result: 'not-found' });
    expect(await testConnection('worker-1')).toEqual({
      result: 'no-endpoint',
    });
  });

  test('discovery-failed: sandbox_ps errors and nothing is cached', async () => {
    stubPs({ stdout: 'boom', isError: true });
    expect(await testConnection('brain-host-1')).toEqual({
      result: 'discovery-failed',
    });
  });

  test('unreachable: reports the transport error code', async () => {
    stubPs(
      ps([svc('carapa-brain', 'brain-host-1')], [ingressFor('carapa-brain')]),
    );
    stubBrainFetch(async () => {
      throw connectionError('ECONNREFUSED');
    });
    expect(await testConnection('brain-host-1')).toEqual({
      result: 'unreachable',
      code: 'ECONNREFUSED',
    });
  });

  test('unreachable: timeout and unusable codes', async () => {
    stubPs(
      ps([svc('carapa-brain', 'brain-host-1')], [ingressFor('carapa-brain')]),
    );
    stubBrainFetch(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect(await testConnection('brain-host-1')).toEqual({
      result: 'unreachable',
      code: 'timeout',
    });
    (globalThis.fetch as { mockRestore?: () => void }).mockRestore?.();
    stubBrainFetch(async () => {
      throw Object.assign(new Error('x'), { code: 'bad code with spaces!' });
    });
    expect(await testConnection('brain-host-1')).toEqual({
      result: 'unreachable',
    });
  });

  test.each([
    [200, { result: 'accepted' }],
    [401, { result: 'rejected', status: 401 }],
    [403, { result: 'rejected', status: 403 }],
    [500, { result: 'error', status: 500 }],
  ])('HTTP %i from the brain', async (status, expected) => {
    stubPs(
      ps([svc('carapa-brain', 'brain-host-1')], [ingressFor('carapa-brain')]),
    );
    stubBrainFetch(async () => new Response('{}', { status }));
    expect(await testConnection('brain-host-1')).toEqual(expected);
  });
});
