import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';

let brainUrl: string | null = 'http://brain.test';
mock.module('../../state-manager.js', () => ({
  getGroupByFolder: (folder: string) => ({ folder }),
}));
mock.module('../objectives/brain-client.js', () => ({
  resolveBrainContainer: () => 'brain-container',
  resolveBrainUrl: () => brainUrl,
}));

const { getBuildInfoTool } = await import('./tools.js');
const { CARAPA_BOX_URL, CARAPA_BOARD_DEPLOY_SERVICE } =
  await import('../../config.js');
const {
  markServerWebBuildBuilding,
  markServerWebBuildFailed,
  markServerWebBuildReady,
} = await import('../../lib/server-web-build-status.js');

const realFetch = globalThis.fetch;
type Handler = (
  url: string,
  init?: RequestInit,
) => Promise<Response> | Response;
let routes: Record<string, Handler> = {};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const hang: Handler = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(init.signal?.reason ?? new Error('aborted')),
    );
  });

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler(url, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  routes = {};
  brainUrl = 'http://brain.test';
});

const run = () =>
  getBuildInfoTool
    .handler({}, {} as any, { group_folder: 'project' })
    .then((out) => JSON.parse(out));

const BRAIN = 'http://brain.test/version';
const BOX = `${CARAPA_BOX_URL}/health`;

const registeredGroups = {
  a: {
    folder: 'carapa-board',
    parentId: 'carapa',
    settings: { deployService: CARAPA_BOARD_DEPLOY_SERVICE },
  },
  b: { folder: 'other' },
};

const buildDeps = {
  getRegisteredGroups: () => registeredGroups,
} as any;

const runAs = (context: Record<string, unknown>, deps: any = buildDeps) =>
  getBuildInfoTool
    .handler({}, deps, context as any)
    .then((out) => JSON.parse(out));

describe('get_build_info', () => {
  test('reports board, brain and box with unchanged top-level fields', async () => {
    const startedAt = '2026-10-13T00:00:00.000Z';
    routes[BRAIN] = () => json({ commit: 'abc1234', service: 'carapa-brain' });
    routes[BOX] = () =>
      json({ status: 'ok', version: 'v9', buildTime: 'bt', startedAt });
    const first = await run();
    const second = await run();
    expect(typeof first.version).toBe('string');
    expect(new Date(first.startedAt).toISOString()).toBe(first.startedAt);
    expect(second.startedAt).toBe(first.startedAt);
    expect(first.services.board).toEqual({
      version: first.version,
      buildTime: first.buildTime,
      startedAt: first.startedAt,
    });
    expect(first.services.brain).toEqual({
      commit: 'abc1234',
      buildTime: null,
      startedAt: null,
      url: 'http://brain.test',
    });
    expect(first.services.box).toEqual({
      version: 'v9',
      buildTime: 'bt',
      startedAt,
    });
    expect(getBuildInfoTool.requiredPermissions).toEqual(['tasks:read']);
  });

  test('unresolvable brain yields an error while box is still filled', async () => {
    brainUrl = null;
    routes[BOX] = () => json({ status: 'ok', uptime: 60 });
    const out = await run();
    expect(out.services.brain).toEqual({
      error: 'no brain configured for project',
    });
    expect(out.services.box.version).toBeNull();
    expect(out.services.box.buildTime).toBeNull();
    const age = Date.now() - new Date(out.services.box.startedAt).getTime();
    expect(Math.abs(age - 60_000)).toBeLessThan(5_000);
  });

  test('brain buildTime/startedAt pass through only when strings', async () => {
    routes[BOX] = () => json({ status: 'ok' });
    routes[BRAIN] = () =>
      json({
        commit: 'abc1234',
        service: 'carapa-brain',
        buildTime: '2026-10-12T10:00:00.000Z',
        startedAt: '2026-10-13T01:00:00.000Z',
      });
    expect((await run()).services.brain).toEqual({
      commit: 'abc1234',
      buildTime: '2026-10-12T10:00:00.000Z',
      startedAt: '2026-10-13T01:00:00.000Z',
      url: 'http://brain.test',
    });
    routes[BRAIN] = () =>
      json({ commit: 'abc1234', buildTime: 123, startedAt: { a: 1 } });
    const out = await run();
    expect(out.services.brain.buildTime).toBeNull();
    expect(out.services.brain.startedAt).toBeNull();
  });

  test('box failure is isolated to the box', async () => {
    routes[BRAIN] = () => json({ commit: 'abc1234' });
    routes[BOX] = () => json({ error: 'boom' }, 500);
    const out = await run();
    expect(out.services.box).toEqual({ error: 'HTTP 500' });
    expect(out.services.brain.commit).toBe('abc1234');
  });

  test('hanging endpoints are cut off with error objects', async () => {
    routes[BRAIN] = hang;
    routes[BOX] = hang;
    const out = await run();
    expect(out.services.brain.error).toContain('timed out');
    expect(out.services.box.error).toContain('timed out');
  }, 10_000);
});

describe('get_build_info serverWebBuild', () => {
  beforeAll(() => {
    routes[BRAIN] = () => json({ commit: 'abc1234' });
    routes[BOX] = () => json({ status: 'ok' });
  });

  test('reports the build status to every caller', async () => {
    markServerWebBuildBuilding();
    const out = await runAs({ group_folder: 'other' });
    expect(out.serverWebBuild).toEqual({ status: 'building' });
  });

  test('gives failing lines to the board project and its parent only', async () => {
    markServerWebBuildFailed(
      'CarapaBoard build failed',
      '#45 0.1 (fail) foo > bar\n#45 0.2 sending Bearer xyz to registry',
    );

    for (const group_folder of ['carapa-board', 'carapa']) {
      const out = await runAs({ group_folder });
      expect(out.serverWebBuild.status).toBe('failed');
      expect(out.serverWebBuild.error).toBe('CarapaBoard build failed');
      expect(
        out.serverWebBuild.failureLines.some((line: string) =>
          line.includes('(fail) foo > bar'),
        ),
      ).toBe(true);
      expect(JSON.stringify(out.serverWebBuild)).not.toContain('xyz');
    }
  });

  test('keeps failing lines away from other projects and wildcard permissions', async () => {
    markServerWebBuildFailed(
      'CarapaBoard build failed',
      '#45 0.1 (fail) foo > bar',
    );

    for (const group_folder of ['other', 'main', 'main-someone']) {
      const out = await runAs({
        group_folder,
        permissions: { '*': ['*:*'] },
      });
      expect(out.serverWebBuild).toEqual({ status: 'failed' });
    }
  });

  test('gives failing lines to admin OAuth users only', async () => {
    markServerWebBuildFailed(
      'CarapaBoard build failed',
      '#45 0.1 (fail) foo > bar',
    );

    const member = await runAs({
      group_folder: 'other',
      kind: 'oauth',
      oauth_user_is_admin: false,
    });
    expect(member.serverWebBuild).toEqual({ status: 'failed' });

    const admin = await runAs({
      group_folder: 'other',
      kind: 'oauth',
      oauth_user_is_admin: true,
    });
    expect(admin.serverWebBuild.status).toBe('failed');
    expect(
      admin.serverWebBuild.failureLines.some((line: string) =>
        line.includes('(fail) foo > bar'),
      ),
    ).toBe(true);
  });

  test('fails closed without registered groups', async () => {
    markServerWebBuildFailed(
      'CarapaBoard build failed',
      '#45 0.1 (fail) foo > bar',
    );

    const out = await runAs({ group_folder: 'carapa-board' }, {});
    expect(out.serverWebBuild).toEqual({ status: 'failed' });
  });

  test('reports no failing lines once the build succeeded', async () => {
    markServerWebBuildReady();

    const out = await runAs({ group_folder: 'carapa-board' });
    expect(out.serverWebBuild).toEqual({ status: 'ready' });
  });
});
