import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import net, { type AddressInfo } from 'node:net';

import {
  createUser,
  initDatabase,
  removeProjectMember,
  updateUserAdminStanding,
  upsertProjectMember,
} from '../db.js';
import { getGroupDir } from '../group-dir.js';
import * as brainClient from '../modules/objectives/brain-client.js';
import { getObjectiveDir } from '../modules/objectives/objective-folder.js';
import {
  hasDashboardPathTokenAccess,
  verifyDashboardTicket,
  issueDashboardPathToken,
} from '../modules/objectives/dashboard-access.js';
import { createObjective } from '../modules/objectives/db-objectives.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import { userCanReadProjectDashboard } from './_helpers.js';
import { computeObjectiveWorkDir } from '../modules/objectives/objective-folder.js';
import objectivesRouter, { readObjectiveQueuedEvents } from './objectives.js';
import path from 'node:path';

const projectId = `route-dashboard-proxy-${process.pid}`;
const jid = `${projectId}@web`;
let server: Server;
let port: number;
let objectiveId: string;
let otherObjectiveId: string;
let adminId: string;
let memberId: string;

afterEach(() => mock.restore());

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  await registerGroup(jid, {
    jid,
    name: 'Dashboard proxy route test',
    folder: projectId,
    trigger: '@dashboard-proxy',
    added_at: new Date().toISOString(),
    settings: { status: 'running', brainContainer: 'brain-test' },
  });
  // The first user is the admin; path tokens are checked against real users.
  adminId = (await createUser('dash-admin', 'test', 'admin')).id;
  memberId = (await createUser('dash-member', 'test', 'user')).id;
  await upsertProjectMember(memberId, projectId, 'viewer');
  const newObjective = async (title: string) =>
    (
      await createObjective({
        project_id: projectId,
        title,
        description: '',
        status: 'active',
        priority: 0,
        deadline: null,
        progress: 0,
        metadata: null,
        trigger_config: null,
        eventRuntimeSelection: null,
      })
    ).id;
  objectiveId = await newObjective('Dashboard proxy fixture');
  otherObjectiveId = await newObjective('Other dashboard fixture');
  const app = express();
  // Stand-in for the auth middleware: `x-test-user: <id>[:admin]` sets authUser.
  app.use((req: any, _res, next) => {
    const header = req.headers['x-test-user'];
    if (typeof header === 'string') {
      const [id, role] = header.split(':');
      req.authUser = { id, role: role ?? 'user' };
    }
    next();
  });
  app.use(objectivesRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.close();
  await unregisterGroup(jid);
  fs.rmSync(getGroupDir(projectId), { recursive: true, force: true });
});

/** Send the request target verbatim so `%2e%2e` is not normalised client-side. */
function rawGet(target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk) => (data += chunk.toString()));
    socket.on('error', reject);
    socket.on('close', () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1]);
      resolve({ status, body: data.split('\r\n\r\n').slice(1).join('') });
    });
    socket.write(
      `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    );
  });
}

const dashboardBase = () =>
  `/projects/${projectId}/objectives/${objectiveId}/dashboard/`;

describe('objective dashboard brain proxy path validation', () => {
  test.each([
    '%2e%2e/obj-B/',
    'a/%2e%2e/%2e%2e/status',
    '..%2fobj-B/',
    'a%5c..%5cb',
    '%252e%252e/obj-B/index.html',
    'a/%252e%252e/%252e%252e/status',
    'x%253fy',
    '100%25',
  ])('rejects traversal segment %s without calling the brain', async (tail) => {
    const fetchSpy = spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      new Response('leak', { status: 200 }),
    );
    const res = await rawGet(`${dashboardBase()}${tail}`);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid dashboard path' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['index.html', 'index.html'],
    ['assets/app.js?x=1', 'assets/app.js?x=1'],
    ['assets/app.js?x=1&ticket=abc', 'assets/app.js?x=1'],
  ])('proxies %s to the objective dashboard', async (tail, expected) => {
    const fetchSpy = spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    const res = await rawGet(`${dashboardBase()}${tail}`);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('brain-test');
    expect(fetchSpy.mock.calls[0]?.[1]).toBe(
      `/dashboard/${objectiveId}/${expected}`,
    );
  });
});

const CSP = 'sandbox allow-scripts allow-forms allow-popups';
const tokenFor = (oid = objectiveId, now?: number) =>
  issueDashboardPathToken(projectId, oid, memberId, now);
const tokenBase = (token: string, oid = objectiveId) =>
  `/projects/${projectId}/objectives/${oid}/dashboard/t/${token}/`;
const get = (target: string) => fetch(`http://127.0.0.1:${port}${target}`);

describe('objective dashboard sandbox headers', () => {
  const expectSandboxHeaders = (res: Response) => {
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  };

  test('brain-proxied responses drop upstream cookies and CSP and keep the sandbox headers', async () => {
    spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      new Response('ok', {
        status: 200,
        headers: {
          'Set-Cookie': 'carapa_session=evil; Path=/',
          'Content-Security-Policy': 'default-src *',
          'Referrer-Policy': 'unsafe-url',
          'X-Upstream': 'kept',
        },
      }),
    );
    const res = await get(`${dashboardBase()}index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-upstream')).toBe('kept');
    expectSandboxHeaders(res);
  });

  test('static and empty-state responses carry the sandbox headers', async () => {
    const dashboardDir = `${getObjectiveDir(projectId, objectiveId)}/dashboard`;
    fs.rmSync(dashboardDir, { recursive: true, force: true });
    spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      new Response('no', { status: 404 }),
    );
    const placeholder = await get(`${dashboardBase()}index.html`);
    expect(placeholder.status).toBe(404);
    expectSandboxHeaders(placeholder);

    fs.mkdirSync(dashboardDir, { recursive: true });
    fs.writeFileSync(`${dashboardDir}/index.html`, '<p>static</p>');
    const staticRes = await get(`${dashboardBase()}index.html`);
    expect(staticRes.status).toBe(200);
    expectSandboxHeaders(staticRes);
  });
});

describe('objective dashboard path token', () => {
  test('is stripped before the brain proxy and before static resolution', async () => {
    const fetchSpy = spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    const token = tokenFor();
    const proxied = await get(`${tokenBase(token)}assets/app.js?x=1`);
    expect(proxied.status).toBe(200);
    expect(fetchSpy.mock.calls[0]?.[1]).toBe(
      `/dashboard/${objectiveId}/assets/app.js?x=1`,
    );
    expect(String(fetchSpy.mock.calls[0]?.[1])).not.toContain(token);

    const dashboardDir = `${getObjectiveDir(projectId, objectiveId)}/dashboard`;
    fs.mkdirSync(dashboardDir, { recursive: true });
    fs.writeFileSync(`${dashboardDir}/index.html`, '<p>token static</p>');
    fetchSpy.mockResolvedValue(new Response('no', { status: 404 }));
    const staticRes = await get(`${tokenBase(token)}index.html`);
    expect(staticRes.status).toBe(200);
    expect(await staticRes.text()).toContain('<p>token static</p>');
  });

  test('is refused for another objective or when expired', async () => {
    const fetchSpy = spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      new Response('leak', { status: 200 }),
    );
    const rejected = [
      // Issued for objective A, presented for objective B.
      tokenBase(tokenFor(), otherObjectiveId),
      tokenBase(tokenFor(objectiveId, Date.now() - 9 * 60 * 60 * 1000)),
    ];
    for (const base of rejected) {
      const res = await get(`${base}index.html`);
      expect(res.status).toBe(401);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a tampered token is refused, and a plain t/ directory still resolves', async () => {
    const [payload, signature] = tokenFor().split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        pid: projectId,
        oid: otherObjectiveId,
        userId: memberId,
        exp: Date.now() + 60_000,
      }),
    ).toString('base64url');
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    const fetchSpy = spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      new Response('leak', { status: 200 }),
    );
    for (const tampered of [
      `${payload}.${flipped}`,
      `${forgedPayload}.${signature}`,
    ]) {
      expect(
        await hasDashboardPathTokenAccess(
          'GET',
          `/api/projects/${projectId}/objectives/${objectiveId}/dashboard/t/${tampered}/index.html`,
          userCanReadProjectDashboard,
        ),
      ).toBe(false);
      expect((await get(`${tokenBase(tampered)}index.html`)).status).toBe(401);
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));
    expect((await get(`${dashboardBase()}t/data.json`)).status).toBe(200);
    expect(fetchSpy.mock.calls[0]?.[1]).toBe(
      `/dashboard/${objectiveId}/t/data.json`,
    );
  });

  test('authenticates only GET below the same objective dashboard in the auth gate', async () => {
    const token = tokenFor();
    const gate = (method: string, p: string) =>
      hasDashboardPathTokenAccess(method, p, userCanReadProjectDashboard);
    const dashboardPath = `/api/projects/${projectId}/objectives/${objectiveId}/dashboard/t/${token}/index.html`;
    expect(await gate('GET', dashboardPath)).toBe(true);
    expect(await gate('POST', dashboardPath)).toBe(false);
    expect(
      await gate(
        'GET',
        `/api/projects/${projectId}/objectives/${otherObjectiveId}/dashboard/t/${token}/index.html`,
      ),
    ).toBe(false);
    for (const other of [
      `/api/projects/${projectId}/objectives/${objectiveId}/events/t/${token}/`,
      `/api/projects/${projectId}/objectives/${objectiveId}/dashboard-refresh/t/${token}/`,
      `/api/projects/${projectId}/tasks/t/${token}/`,
      `/api/projects/${projectId}/objectives/${objectiveId}/dashboard/x/t/${token}/index.html`,
    ]) {
      expect(await gate('GET', other)).toBe(false);
    }
  });

  test('stops working once the user loses project access or is disabled', async () => {
    spyOn(brainClient, 'fetchBrain').mockImplementation(
      async () => new Response('ok', { status: 200 }),
    );
    const gatePath = (token: string) =>
      `/api/projects/${projectId}/objectives/${objectiveId}/dashboard/t/${token}/index.html`;
    const token = tokenFor();
    const allowed = () =>
      hasDashboardPathTokenAccess(
        'GET',
        gatePath(token),
        userCanReadProjectDashboard,
      );
    const status = async () =>
      (await get(`${tokenBase(token)}index.html`)).status;

    expect(await allowed()).toBe(true);
    expect(await status()).toBe(200);

    await removeProjectMember(memberId, projectId);
    expect(await allowed()).toBe(false);
    expect(await status()).toBe(401);

    await upsertProjectMember(memberId, projectId, 'viewer');
    expect(await status()).toBe(200);

    await updateUserAdminStanding(memberId, { disabled: true });
    expect(await allowed()).toBe(false);
    expect(await status()).toBe(401);
    await updateUserAdminStanding(memberId, { disabled: false });
    expect(await status()).toBe(200);
  });

  test('refuses a token without a userId and a non-string ticket', async () => {
    const unsigned = issueDashboardPathToken(
      projectId,
      objectiveId,
      null as unknown as string,
    );
    expect(
      await hasDashboardPathTokenAccess(
        'GET',
        `/api/projects/${projectId}/objectives/${objectiveId}/dashboard/t/${unsigned}/index.html`,
        async () => true,
      ),
    ).toBe(false);
    expect(verifyDashboardTicket(['a', 'b'], projectId, objectiveId)).toBe(
      false,
    );
  });
});

describe('objective dashboard ticket issuance', () => {
  const ticketUrl = () =>
    `http://127.0.0.1:${port}/projects/${projectId}/objectives/${objectiveId}/dashboard-ticket`;

  test('refuses a user without access to the project and issues no token', async () => {
    const res = await fetch(ticketUrl(), {
      method: 'POST',
      headers: { 'x-test-user': 'not-a-member' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pathToken).toBeUndefined();
    expect(body.ticket).toBeUndefined();
  });

  test('issues a path token that the dashboard route accepts to an admin', async () => {
    const res = await fetch(ticketUrl(), {
      method: 'POST',
      headers: { 'x-test-user': `${adminId}:admin` },
    });
    expect(res.status).toBe(200);
    const { pathToken } = (await res.json()) as { pathToken: string };
    spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    expect((await get(`${tokenBase(pathToken)}index.html`)).status).toBe(200);
  });
});

describe('objective dashboard static fallback symlinks', () => {
  test('refuses symlinks leaving the dashboard dir and serves normal files', async () => {
    const dashboardDir = `${getObjectiveDir(projectId, objectiveId)}/dashboard`;
    const outside = fs.mkdtempSync(`${os.tmpdir()}/dashboard-outside-`);
    try {
      fs.mkdirSync(dashboardDir, { recursive: true });
      fs.writeFileSync(`${outside}/secret.txt`, 'TOP-SECRET');
      fs.writeFileSync(`${dashboardDir}/index.html`, '<p>dash</p>');
      fs.symlinkSync(`${outside}/secret.txt`, `${dashboardDir}/leak.txt`);
      fs.symlinkSync(outside, `${dashboardDir}/leakdir`);
      spyOn(brainClient, 'fetchBrain').mockResolvedValue(
        new Response('no', { status: 404 }),
      );

      for (const tail of ['leak.txt', 'leakdir/secret.txt']) {
        const res = await rawGet(`${dashboardBase()}${tail}`);
        expect(res.status).toBe(400);
        expect(res.body).not.toContain('TOP-SECRET');
      }
      const ok = await rawGet(`${dashboardBase()}index.html`);
      expect(ok.status).toBe(200);
      expect(ok.body).toContain('<p>dash</p>');

      // The dashboard dir itself replaced by a symlink to outside the group.
      fs.rmSync(dashboardDir, { recursive: true, force: true });
      fs.writeFileSync(`${outside}/index.html`, 'TOP-SECRET');
      fs.symlinkSync(outside, dashboardDir);
      const swapped = await rawGet(`${dashboardBase()}index.html`);
      expect(swapped.status).toBe(404);
      expect(swapped.body).not.toContain('TOP-SECRET');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('serves a script-free empty state for a missing index.html and JSON 404 for other files', async () => {
    const dashboardDir = `${getObjectiveDir(projectId, objectiveId)}/dashboard`;
    fs.rmSync(dashboardDir, { recursive: true, force: true });
    spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      new Response('no', { status: 404 }),
    );

    // Neither dashboard dir nor index.html exists yet.
    const res = await fetch(
      `http://127.0.0.1:${port}${dashboardBase()}index.html`,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('No dashboard yet');
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//i);

    const asset = await rawGet(`${dashboardBase()}app.js`);
    expect(asset.status).toBe(404);
    expect(JSON.parse(asset.body)).toEqual({ error: 'File not found' });

    // Once index.html exists it is served unchanged.
    fs.mkdirSync(dashboardDir, { recursive: true });
    fs.writeFileSync(`${dashboardDir}/index.html`, '<p>real dash</p>');
    const real = await rawGet(`${dashboardBase()}index.html`);
    expect(real.status).toBe(200);
    expect(real.body).toContain('<p>real dash</p>');
    expect(real.body).not.toContain('No dashboard yet');
  });
});

describe('objective runs pagination', () => {
  const runIds = ['r1', 'r2', 'r3', 'r4', 'r5'];

  async function fetchRuns(query: string, withCurrent: boolean) {
    const dir = getObjectiveDir(projectId, objectiveId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      `${dir}/run-stats.jsonl`,
      runIds.map((runId) => JSON.stringify({ runId })).join('\n') + '\n',
    );
    fs.writeFileSync(
      `${dir}/events.jsonl`,
      withCurrent
        ? JSON.stringify({
            type: 'agent_invoked',
            timestamp: new Date(Date.now() - 60_000).toISOString(),
            payload: { run_id: 'live', trigger_type: 'self_reminder' },
          }) + '\n'
        : '',
    );
    spyOn(brainClient, 'fetchBrain').mockResolvedValue(
      Response.json({ processor: { activeObjectiveIds: [objectiveId] } }),
    );
    const existsSpy = spyOn(fs, 'existsSync');
    const res = await rawGet(
      `/projects/${projectId}/objectives/${objectiveId}/runs?${query}`,
    );
    const checkedRunIds = new Set(
      existsSpy.mock.calls
        .map(([target]) => /session-transcripts\/([^./]+)/.exec(String(target)))
        .filter((match) => match !== null)
        .map((match) => match![1]),
    );
    existsSpy.mockRestore();
    const body = JSON.parse(res.body) as {
      runs: { runId: string; running?: boolean }[];
      total: number;
    };
    return { body, checkedRunIds };
  }

  test('without a current run, windows run-stats and checks only the page', async () => {
    const { body, checkedRunIds } = await fetchRuns('limit=2&offset=1', false);
    expect(body.total).toBe(5);
    expect(body.runs.map((run) => run.runId)).toEqual(['r4', 'r3']);
    expect([...checkedRunIds].sort()).toEqual(['r3', 'r4']);
  });

  test('with a current run, lists it first and shifts later windows by one', async () => {
    const first = await fetchRuns('limit=2&offset=0', true);
    expect(first.body.total).toBe(6);
    expect(first.body.runs.map((run) => run.runId)).toEqual(['live', 'r5']);
    expect(first.body.runs[0]?.running).toBe(true);
    expect([...first.checkedRunIds]).toEqual(['r5']);

    const second = await fetchRuns('limit=2&offset=2', true);
    expect(second.body.total).toBe(6);
    expect(second.body.runs.map((run) => run.runId)).toEqual(['r4', 'r3']);
    expect([...second.checkedRunIds].sort()).toEqual(['r3', 'r4']);
  });
});

describe('main brain layout', () => {
  const userFolder = `route-brain-main-user-${process.pid}`;
  const objective = 'obj-brain-layout';
  const queue = JSON.stringify({
    items: [{ objectiveId: objective, triggerEvent: { timestamp: 't' } }],
  });
  const register = (folder: string, userId: string) =>
    registerGroup(`${folder}@web`, {
      jid: `${folder}@web`,
      name: folder,
      folder,
      trigger: '@brain',
      added_at: new Date().toISOString(),
      is_main: true,
      user_id: userId,
    });

  afterAll(async () => {
    await unregisterGroup(`${userFolder}@web`);
    fs.rmSync(getGroupDir(userFolder), { recursive: true, force: true });
  });

  test('a per-user main keeps its objectives and queue in its own folder', async () => {
    await register(userFolder, 'alice');
    expect(computeObjectiveWorkDir(userFolder, objective)).toBe(
      `/workspace/group/objectives/${objective}`,
    );
    fs.writeFileSync(path.join(getGroupDir(userFolder), 'queue.json'), queue);
    expect(await readObjectiveQueuedEvents(userFolder, objective)).toHaveLength(
      1,
    );
  });

  describe('child projects', () => {
    const parentFolder = `route-brain-parent-${process.pid}`;
    const ownChild = `route-brain-own-child-${process.pid}`;
    const sharedParent = `route-brain-shared-parent-${process.pid}`;
    const sharedChild = `route-brain-shared-child-${process.pid}`;
    const brainParent = `route-brain-brain-parent-${process.pid}`;
    const brainlessChild = `route-brain-brainless-child-${process.pid}`;
    const folders = [
      parentFolder,
      ownChild,
      sharedParent,
      sharedChild,
      brainParent,
      brainlessChild,
    ];
    const registerGroupAt = (
      folder: string,
      parentId?: string,
      settings?: Record<string, unknown>,
    ) =>
      registerGroup(`${folder}@web`, {
        jid: `${folder}@web`,
        name: folder,
        folder,
        trigger: '@brain',
        added_at: new Date().toISOString(),
        parentId,
        settings,
      });
    const writeQueue = (folder: string) => {
      fs.mkdirSync(getGroupDir(folder), { recursive: true });
      fs.writeFileSync(path.join(getGroupDir(folder), 'queue.json'), queue);
    };

    afterAll(async () => {
      for (const folder of folders) {
        await unregisterGroup(`${folder}@web`);
        fs.rmSync(getGroupDir(folder), { recursive: true, force: true });
      }
    });

    test('a child with its own brain reads its own queue.json', async () => {
      await registerGroupAt(parentFolder, undefined, {
        isParent: true,
        brainContainer: 'brain-parent',
      });
      await registerGroupAt(ownChild, parentFolder, {
        brainContainer: 'brain-own-child',
      });
      writeQueue(ownChild);
      expect(await readObjectiveQueuedEvents(ownChild, objective)).toHaveLength(
        1,
      );
    });

    test('a child using its non-shared parent brain reads the parent queue.json', async () => {
      await registerGroupAt(brainParent, undefined, {
        isParent: true,
        brainContainer: 'brain-top',
      });
      await registerGroupAt(brainlessChild, brainParent);
      writeQueue(brainParent);
      expect(
        await readObjectiveQueuedEvents(brainlessChild, objective),
      ).toHaveLength(1);
    });

    test('a child of a shared-sandbox owner reads the owner queue.json', async () => {
      await registerGroupAt(sharedParent, undefined, {
        isParent: true,
        sandboxOwnership: 'shared',
      });
      await registerGroupAt(sharedChild, sharedParent);
      writeQueue(sharedParent);
      expect(
        await readObjectiveQueuedEvents(sharedChild, objective),
      ).toHaveLength(1);
    });
  });
});
