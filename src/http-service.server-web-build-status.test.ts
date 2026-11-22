import * as mcpClient from './lib/mcp-client.js';
import * as wsEvents from './modules/objectives/ws-events.js';
import * as taskExecutor from './modules/kanban/task-executor.js';
import * as kanbanDb from './modules/kanban/db-kanban.js';
import { createTask, getTasksByProject } from './modules/kanban/db-kanban.js';
import { readTaskMessages } from './modules/transcripts/transcript-store.js';
import { projects } from './db/schema.js';
import { loadState, registerGroup } from './state-manager.js';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Server } from 'node:http';
import { createSigningPayload } from './crypto-verify.js';
import { initDatabase } from './db.js';
import { createUser, registerDeviceKey } from './db.js';
import { signUserJwt, signJwt } from './lib/auth-jwt.js';
import { setDeviceActivityWriterForTest } from './lib/device-activity.js';
import { drizzleDbRef } from './db/drizzle-client.js';
import { deviceKeys } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { logger, sanitizeLogValue } from './logger.js';

let buildFinished = Promise.withResolvers<void>();
let restoreBroadcast: (() => void) | undefined;
let observeBroadcast:
  | ((event: Parameters<typeof wsEvents.broadcast>[0]) => void)
  | undefined;
let buildStarted: Promise<void> = Promise.resolve();
let releaseBuild = () => {};
let nextBuildResult = { stdout: '', isError: false };
let nextBuildError: unknown = null;

const sandboxClientStub = {
  callTool: async (name: string) => {
    if (name === 'build_service') {
      await buildStarted;
      if (nextBuildError) throw nextBuildError;
      return nextBuildResult;
    }
    return { stdout: '', isError: false };
  },
};
let restoreSandboxClient: (() => void) | undefined;

let server: Server;
let baseUrl: string;
let admin: { id: string };
let member: { id: string };
const adminDevice = 'status-test-admin-device';
const pendingDevice = 'status-test-pending-device';
let pendingToken = '';
const memberDevice = 'status-test-member-device';

const credentials = new Map<string, { token: string; privateKey: CryptoKey }>();

async function signedFetch(
  path: string,
  method: 'GET' | 'POST',
  identity: 'admin' | 'member',
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const item = credentials.get(identity)!;
  const deviceId = identity === 'admin' ? adminDevice : memberDevice;
  const timestamp = new Date().toISOString();
  const payload = createSigningPayload(method, path, timestamp, '');
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    item.privateKey,
    new TextEncoder().encode(payload),
  );
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${item.token}`,
      'x-carapa-device-id': deviceId,
      'x-carapa-timestamp': timestamp,
      'x-carapa-signature': Buffer.from(signature).toString('base64'),
      ...extraHeaders,
    },
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}
async function signedNativeFetch(
  path: string,
  identity: 'admin' | 'member',
  body: Record<string, unknown>,
): Promise<Response> {
  const item = credentials.get(identity)!;
  const deviceId = identity === 'admin' ? adminDevice : memberDevice;
  const timestamp = new Date().toISOString();
  const bodyText = JSON.stringify(body);
  const payload = createSigningPayload('POST', path, timestamp, bodyText);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    item.privateKey,
    new TextEncoder().encode(payload),
  );
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-carapa-device-id': deviceId,
      'x-carapa-timestamp': timestamp,
      'x-carapa-signature': Buffer.from(signature).toString('base64'),
    },
    body: bodyText,
  });
}

async function holdNextBuild(): Promise<void> {
  buildFinished = Promise.withResolvers<void>();
  buildStarted = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
}

async function waitForStatus(status: string, identity: 'admin' = 'admin') {
  await buildFinished.promise;
  const response = await signedFetch(
    '/api/admin/rebuild-board/status',
    'GET',
    identity,
  );
  expect(response.body.status).toBe(status);
  return response.body;
}

beforeAll(async () => {
  await initDatabase(':memory:');
  const pending = await createUser('status-pending', 'password', 'user');
  admin = await createUser('status-admin', 'password', 'admin');
  member = await createUser('status-member', 'password', 'user');
  const adminKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const memberKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  await registerDeviceKey(
    adminDevice,
    admin.id,
    Buffer.from(
      await crypto.subtle.exportKey('spki', adminKeyPair.publicKey),
    ).toString('base64'),
    'test',
    true,
  );
  await registerDeviceKey(
    memberDevice,
    member.id,
    Buffer.from(
      await crypto.subtle.exportKey('spki', memberKeyPair.publicKey),
    ).toString('base64'),
    'test',
    true,
  );
  await registerDeviceKey(
    pendingDevice,
    pending.id,
    'pending-device-public-key',
    'test',
    false,
  );
  pendingToken = signUserJwt(pending.id, pendingDevice);
  credentials.set('admin', {
    token: signUserJwt(admin.id, adminDevice),
    privateKey: adminKeyPair.privateKey,
  });
  credentials.set('member', {
    token: signUserJwt(member.id, memberDevice),
    privateKey: memberKeyPair.privateKey,
  });
  const sandboxSpy = spyOn(mcpClient, 'getSandboxClient').mockReturnValue(
    sandboxClientStub as any,
  );
  restoreSandboxClient = () => sandboxSpy.mockRestore();
  const broadcast = wsEvents.broadcast;
  const observer = spyOn(wsEvents, 'broadcast').mockImplementation((event) => {
    broadcast(event);
    observeBroadcast?.(event);
    if (event.type === 'deploy_ready' || event.type === 'deploy_failed')
      buildFinished.resolve();
  });
  restoreBroadcast = () => observer.mockRestore();
  const { app } = await import('./http-service.js');
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  restoreBroadcast?.();
  restoreSandboxClient?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('server/web build status endpoint', () => {
  test('issues a WebSocket ticket from a valid bearer when the WebView cookie is stale', async () => {
    const staleCookie = signJwt(
      { type: 'user', sub: admin.id, did: adminDevice },
      -60,
    );
    const response = await fetch(`${baseUrl}/api/ws-ticket`, {
      headers: {
        Authorization: `Bearer ${credentials.get('admin')!.token}`,
        Cookie: `carapa_session=${staleCookie}`,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ticket: expect.any(String),
    });
  });

  test('provider account guard accepts a renewed human session with stale bearer, but rejects scoped credentials', async () => {
    // A nonexistent child route exercises both real account guards and device
    // signature verification without contacting Box or touching credentials.
    const endpoint = '/api/admin/provider-accounts/auth-regression-probe';
    const stale = signJwt(
      { type: 'user', sub: admin.id, did: adminDevice },
      -60,
    );
    const cookie = `carapa_session=${credentials.get('admin')!.token}`;
    expect((await signedFetch(endpoint, 'GET', 'admin')).status).toBe(404);
    expect(
      (
        await signedFetch(endpoint, 'GET', 'admin', {
          Cookie: cookie,
          Authorization: `Bearer ${stale}`,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await signedFetch(endpoint, 'GET', 'admin', {
          Authorization: `Bearer ${stale}`,
        })
      ).status,
    ).toBe(401);
    const agent = signJwt({
      type: 'agent',
      sub: 'account-test-agent',
      scope: { group_folder: 'main', permissions: { '*': ['*:*'] } },
    });
    expect(
      (
        await signedFetch(endpoint, 'GET', 'admin', {
          Cookie: cookie,
          Authorization: `Bearer ${agent}`,
        })
      ).status,
    ).toBe(403);
    expect((await signedFetch(endpoint, 'GET', 'member')).status).toBe(403);
    expect(
      (
        await signedFetch(endpoint, 'GET', 'admin', {
          'x-carapa-signature': 'invalid-signature',
        })
      ).status,
    ).toBe(401);
  });

  test('rejects unsigned callers and authenticated non-admins', async () => {
    const response = await fetch(`${baseUrl}/api/admin/rebuild-board/status`);
    expect(response.status).toBe(401);

    const memberResponse = await signedFetch(
      '/api/admin/rebuild-board/status',
      'GET',
      'member',
    );
    expect(memberResponse.status).toBe(403);
  });

  test('coalesces authenticated and verified-signature device touches', async () => {
    const writes: Array<[string, string | undefined]> = [];
    setDeviceActivityWriterForTest(async (deviceId, userId) => {
      writes.push([deviceId, userId]);
    });

    try {
      const burst = await Promise.all(
        Array.from({ length: 12 }, () =>
          signedFetch('/api/admin/rebuild-board/status', 'GET', 'admin'),
        ),
      );
      expect(burst.every((response) => response.status === 200)).toBe(true);
      expect(writes).toEqual([[adminDevice, admin.id]]);

      const memberResponse = await signedFetch(
        '/api/admin/rebuild-board/status',
        'GET',
        'member',
      );
      expect(memberResponse.status).toBe(403);
      expect(writes).toEqual([
        [adminDevice, admin.id],
        [memberDevice, member.id],
      ]);

      // Reset only the in-memory throttle so the signature-only path can be
      // observed independently. It must retain the unscoped DB contract.
      writes.length = 0;
      setDeviceActivityWriterForTest(async (deviceId, userId) => {
        writes.push([deviceId, userId]);
      });
      const nativeResponse = await signedNativeFetch(
        '/api/devices/push-token',
        'admin',
        { token: 'device-activity-test-token', platform: 'android' },
      );
      expect(nativeResponse.status).toBe(200);
      expect(writes).toEqual([[adminDevice, undefined]]);
    } finally {
      setDeviceActivityWriterForTest(null);
    }
  });

  test('still enforces pending approval and immediate device revocation', async () => {
    const pendingResponse = await fetch(`${baseUrl}/api/runtime-catalog`, {
      headers: {
        Authorization: `Bearer ${pendingToken}`,
        'x-carapa-device-id': pendingDevice,
      },
    });
    expect(pendingResponse.status).toBe(403);
    expect(await pendingResponse.json()).toMatchObject({
      requiresApproval: true,
    });

    await drizzleDbRef.current
      .update(deviceKeys)
      .set({ is_active: false })
      .where(eq(deviceKeys.device_id, memberDevice));
    try {
      const revokedResponse = await fetch(`${baseUrl}/api/runtime-catalog`, {
        headers: {
          Authorization: `Bearer ${credentials.get('member')!.token}`,
          'x-carapa-device-id': memberDevice,
        },
      });
      expect(revokedResponse.status).toBe(401);
    } finally {
      await drizzleDbRef.current
        .update(deviceKeys)
        .set({ is_active: true })
        .where(eq(deviceKeys.device_id, memberDevice));
    }
  });

  test('runs the real admin handler through building to ready', async () => {
    await holdNextBuild();
    nextBuildResult = { stdout: 'built', isError: false };

    const accepted = await signedFetch(
      '/api/admin/rebuild-board',
      'POST',
      'admin',
    );
    expect(accepted.status).toBe(202);
    expect(
      (await signedFetch('/api/admin/rebuild-board/status', 'GET', 'admin'))
        .body.status,
    ).toBe('building');

    releaseBuild();
    expect((await waitForStatus('ready')).status).toBe('ready');
  });

  test('runs the real admin handler from building to failed', async () => {
    await holdNextBuild();
    nextBuildResult = { stdout: 'failed output', isError: true };

    const accepted = await signedFetch(
      '/api/admin/rebuild-board',
      'POST',
      'admin',
    );
    expect(accepted.status).toBe(202);
    expect(
      (await signedFetch('/api/admin/rebuild-board/status', 'GET', 'admin'))
        .body.status,
    ).toBe('building');

    releaseBuild();
    const failed = await waitForStatus('failed');
    expect(failed).toMatchObject({
      status: 'failed',
      output: 'failed output',
    });
  });

  test('logs the tail of a failed build output within the logger bound', async () => {
    const marker = 'FINAL-FAILING-STEP-MARKER';
    const logged: unknown[] = [];
    const errorSpy = spyOn(logger, 'error').mockImplementation(((
      fields: unknown,
    ) => {
      logged.push(fields);
    }) as never);
    try {
      await holdNextBuild();
      nextBuildResult = {
        stdout: `${'x'.repeat(10_000)}\n${marker}`,
        isError: true,
      };
      await signedFetch('/api/admin/rebuild-board', 'POST', 'admin');
      releaseBuild();
      await waitForStatus('failed');

      const fields = logged.find(
        (item) => (item as { output?: string })?.output !== undefined,
      );
      const output = (sanitizeLogValue(fields) as { output: string }).output;
      expect(output).toContain(marker);
      expect(output.length).toBeLessThanOrEqual(2000);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('clears the failed output when the next build succeeds', async () => {
    await holdNextBuild();
    nextBuildResult = { stdout: 'built', isError: false };
    await signedFetch('/api/admin/rebuild-board', 'POST', 'admin');
    releaseBuild();
    const ready = await waitForStatus('ready');
    expect(ready).not.toHaveProperty('output');
  });

  test('marks the build failed when the CarapaBox request throws', async () => {
    await holdNextBuild();
    nextBuildError = new Error('CarapaBox unreachable');

    const accepted = await signedFetch(
      '/api/admin/rebuild-board',
      'POST',
      'admin',
    );
    expect(accepted.status).toBe(202);
    expect(
      (await signedFetch('/api/admin/rebuild-board/status', 'GET', 'admin'))
        .body.status,
    ).toBe('building');

    releaseBuild();
    const failed = await waitForStatus('failed');
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'Build request failed: Error: CarapaBox unreachable',
    });
    nextBuildError = null;
  });

  describe('BOARD_BUILD_FAILURE_PROJECT', () => {
    const folder = 'build-failure-cards';
    const failingLine =
      'ERROR: failed to build: failed to solve: process "/bin/sh -c bun run typecheck" did not complete successfully: exit code: 2';
    let drainSpy: ReturnType<typeof spyOn>;

    async function failBuild(stdout: string) {
      await holdNextBuild();
      nextBuildResult = { stdout, isError: true };
      await signedFetch('/api/admin/rebuild-board', 'POST', 'admin');
      releaseBuild();
      await waitForStatus('failed');
    }

    beforeAll(async () => {
      const added_at = new Date().toISOString();
      await drizzleDbRef.current.insert(projects).values({
        id: folder,
        jid: `${folder}@test`,
        name: folder,
        folder,
        trigger: '!',
        added_at,
        is_main: 0,
        user_id: admin.id,
      });
      await loadState();
      await registerGroup(`${folder}@test`, {
        name: folder,
        folder,
        jid: `${folder}@test`,
        trigger: '!',
        added_at,
        user_id: admin.id,
      });
      drainSpy = spyOn(taskExecutor, 'drainProjectQueue').mockResolvedValue();
    });

    afterAll(() => {
      drainSpy.mockRestore();
      delete process.env.BOARD_BUILD_FAILURE_PROJECT;
    });

    test('creates no card while the setting is unset', async () => {
      delete process.env.BOARD_BUILD_FAILURE_PROJECT;
      await failBuild(`${failingLine}\n[build] GIT_COMMIT=5734402abcdef`);
      expect(await getTasksByProject(folder)).toHaveLength(0);
    });

    test('opens one card from the full output and comments on a repeat', async () => {
      process.env.BOARD_BUILD_FAILURE_PROJECT = folder;
      const log = `[build] GIT_COMMIT=5734402abcdef\n${failingLine}\n${'x'.repeat(30_000)}\nBuild carapa-board: FAILED`;
      await failBuild(log);

      const [card] = await getTasksByProject(folder);
      expect(await getTasksByProject(folder)).toHaveLength(1);
      expect(card.title).toBe('Build failed at 5734402: bun run typecheck');
      expect(card.status).toBe('in_progress');
      expect(card.priority).toBe(-100);
      expect(card.ownerUserId).toBe(admin.id);
      expect(card.description).toContain(failingLine);
      expect(card.description).toContain('Fix the cause on develop');

      await failBuild(log);
      expect(await getTasksByProject(folder)).toHaveLength(1);
      expect(
        readTaskMessages(folder, card.id).some((message) =>
          message.content.includes('failed again'),
        ),
      ).toBe(true);

      await failBuild(log.replace('5734402', 'abcdef0'));
      const priorities = (await getTasksByProject(folder)).map(
        (task) => task.priority,
      );
      expect(priorities.sort((a, b) => a - b)).toEqual([-100, -99]);
    });

    test('a failed pre-read leaves all marked cards unchanged after a green build', async () => {
      process.env.BOARD_BUILD_FAILURE_PROJECT = folder;
      const cards = await Promise.all(
        ['pre-read failure', 'other candidate'].map((title) =>
          createTask({
            project_id: folder,
            title,
            description: '',
            status: 'in_progress',
            custom_values: { board_build_failure: 1 },
          }),
        ),
      );
      const getTask = kanbanDb.getTask;
      const readSpy = spyOn(kanbanDb, 'getTask').mockImplementation((id) =>
        id === cards[0].id
          ? Promise.reject(new Error('pre-read failed'))
          : getTask(id),
      );
      const warned = Promise.withResolvers<void>();
      const warnSpy = spyOn(logger, 'warn').mockImplementation(((
        _fields: unknown,
        message: string,
      ) => {
        if (message === 'Build-failure card resolve failed') warned.resolve();
      }) as never);
      try {
        await holdNextBuild();
        nextBuildResult = { stdout: 'GIT_COMMIT=abcdef123456', isError: false };
        expect(
          (await signedFetch('/api/admin/rebuild-board', 'POST', 'admin'))
            .status,
        ).toBe(202);
        releaseBuild();
        await waitForStatus('ready');
        await warned.promise;
        const stored = await getTasksByProject(folder);
        for (const card of cards) {
          expect(stored.find((task) => task.id === card.id)?.archived).toBe(
            false,
          );
          expect(readTaskMessages(folder, card.id)).toHaveLength(0);
        }
      } finally {
        readSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    test('a green build resolves marked cards without touching unmarked cards', async () => {
      process.env.BOARD_BUILD_FAILURE_PROJECT = folder;
      const unstarted = (await getTasksByProject(folder)).find((card) =>
        card.title.startsWith('Build failed at 5734402:'),
      )!;
      const started = await createTask({
        project_id: folder,
        title: 'Started failure',
        description: '',
        status: 'in_progress',
        started_at: new Date().toISOString(),
        custom_values: unstarted.custom_values,
      });
      const unmarked = await createTask({
        project_id: folder,
        title: 'Build failed at unrelated',
        description: '',
        status: 'in_progress',
      });
      const resolved = Promise.withResolvers<void>();
      const seen = new Set<string>();
      observeBroadcast = (event) => {
        const payload = event.payload as {
          id?: string;
          task_id?: string;
          message?: { content: string };
        };
        if (event.type === 'task_updated' && payload.id === unstarted.id)
          seen.add('archive');
        if (
          event.type === 'task_message' &&
          payload.task_id === started.id &&
          payload.message?.content.includes('A later build succeeded')
        )
          seen.add('note');
        if (seen.size === 2) resolved.resolve();
      };
      try {
        await holdNextBuild();
        nextBuildResult = { stdout: 'GIT_COMMIT=abcdef123456', isError: false };
        await signedFetch('/api/admin/rebuild-board', 'POST', 'admin');
        releaseBuild();
        await waitForStatus('ready');
        await resolved.promise;
        const cards = await getTasksByProject(folder);
        expect(cards.find((card) => card.id === unstarted.id)?.archived).toBe(
          true,
        );
        expect(
          readTaskMessages(folder, unstarted.id).some((message) =>
            message.content.includes(
              'Resolved: a later build succeeded at abcdef1',
            ),
          ),
        ).toBe(true);
        expect(cards.find((card) => card.id === started.id)).toMatchObject({
          status: 'in_progress',
          archived: false,
        });
        expect(
          readTaskMessages(folder, started.id).some(
            (message) =>
              message.target_stage === 'in_progress' &&
              message.content.includes('A later build succeeded at abcdef1'),
          ),
        ).toBe(true);
        expect(cards.find((card) => card.id === unmarked.id)?.archived).toBe(
          false,
        );
        expect(readTaskMessages(folder, unmarked.id)).toHaveLength(0);
      } finally {
        observeBroadcast = undefined;
      }
    });
  });
});
