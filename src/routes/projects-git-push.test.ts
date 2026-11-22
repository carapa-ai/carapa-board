/**
 * POST /projects/:pid/git/push — the box qualifies a bare push source as
 * refs/heads/<src>, so the route must publish the captured commit through a
 * fully qualified snapshot ref and always remove that ref afterwards.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createUser, initDatabase } from '../db.js';
import { withProjectGitLock } from '../lib/git-ops.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import {
  loadState,
  registerGroup,
  registeredGroups,
  unregisterGroup,
} from '../state-manager.js';
import type { RegisteredGroup } from '../types.js';
import projectsRouter from './projects.js';

const folder = `git-push-${process.pid}`;
const jid = `${folder}@web`;
const sha = 'a'.repeat(40);
const url = 'https://example.test/repo.git';
const SNAPSHOT = 'refs/board/push-snapshot';

let server: Server;
let baseUrl: string;
let userId: string;
let commands: string[];
let fail: (command: string) => boolean;
let restore: () => void;
let onArrive: () => void = () => {};

function group(): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '!',
    added_at: new Date().toISOString(),
    user_id: userId,
    is_main: false,
    settings: { defaultBranch: 'main', repositoryUrl: url },
  };
}

async function push() {
  const response = await fetch(`${baseUrl}/projects/${folder}/git/push`, {
    method: 'POST',
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  userId = (await createUser(`git-push-${process.pid}`, 'password')).id;
  await registerGroup(jid, group());

  const spy = spyOn(getSandboxClient(), 'sandboxGit').mockImplementation(
    async (_name: string, command: string) => {
      commands.push(command);
      const isError = fail(command);
      return {
        isError,
        stdout: command.startsWith('rev-parse') ? `${sha}\n` : 'out',
      } as Awaited<
        ReturnType<ReturnType<typeof getSandboxClient>['sandboxGit']>
      >;
    },
  );
  restore = () => spy.mockRestore();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    registeredGroups[jid] ??= group();
    if (req.method === 'POST') onArrive();
    const agent = req.header('x-test-agent');
    if (agent) {
      Object.assign(req, {
        authCredentialKind: 'agent',
        tokenScope: {
          group_folder: folder,
          ...(agent === 'run' ? { task_id: 't', run_id: 'r' } : {}),
        },
      });
    } else {
      Object.assign(req, { authUser: { id: userId, role: 'user' } });
    }
    next();
  });
  app.use(projectsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  restore();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await unregisterGroup(jid);
});

beforeEach(() => {
  commands = [];
  fail = () => false;
});

describe('POST /projects/:pid/git/push', () => {
  test('pushes a qualified snapshot ref, removes it, then records tracking', async () => {
    const res = await push();

    expect(res.status).toBe(200);
    expect(res.body.warning).toBeUndefined();
    expect(commands).toEqual([
      expect.stringContaining('rev-parse'),
      `update-ref '${SNAPSHOT}' '${sha}'`,
      `push -- '${url}' '${SNAPSHOT}:refs/heads/main'`,
      `update-ref -d '${SNAPSHOT}'`,
      expect.stringMatching(new RegExp(`^update-ref '[^']+' '${sha}'$`)),
    ]);
    expect(commands.some((c) => c.includes(`${sha}:`))).toBe(false);
  });

  test('removes the snapshot and skips tracking when the push fails', async () => {
    fail = (c) => c.startsWith('push');

    const res = await push();

    expect(res.status).toBe(500);
    expect(res.body.output).toBe('out');
    expect(commands.slice(1)).toEqual([
      `update-ref '${SNAPSHOT}' '${sha}'`,
      `push -- '${url}' '${SNAPSHOT}:refs/heads/main'`,
      `update-ref -d '${SNAPSHOT}'`,
    ]);
  });

  test('warns, after removing the snapshot, when tracking cannot be refreshed', async () => {
    fail = (c) => c.startsWith('update-ref') && !c.includes(SNAPSHOT);

    const res = await push();

    expect(res.status).toBe(200);
    expect(res.body.warning).toContain('ahead/behind may be stale');
    expect(commands[3]).toBe(`update-ref -d '${SNAPSHOT}'`);
    expect(commands).toHaveLength(5);
  });

  test('a failed snapshot delete does not fail a successful push', async () => {
    fail = (c) => c === `update-ref -d '${SNAPSHOT}'`;

    const res = await push();

    expect(res.status).toBe(200);
  });

  test('waits for the project git lock, whatever the repository mode', async () => {
    let release!: () => void;
    const held = withProjectGitLock(
      folder,
      () => new Promise<void>((resolve) => (release = resolve)),
      { waitForCompletion: true },
    );
    const arrived = new Promise<void>((resolve) => (onArrive = resolve));

    const pending = push();
    await arrived;
    // A full round trip on another connection: an unlocked handler would
    // already have issued its first git command by now.
    await fetch(`${baseUrl}/projects/${folder}/lock-barrier`);
    const ranWhileHeld = [...commands];
    release();
    await held;
    const res = await pending;

    expect(ranWhileHeld).toEqual([]);
    expect(res.status).toBe(200);
    expect(commands).toHaveLength(5);
  });
});

describe('agent credentials', () => {
  test.each(
    (['push', 'fetch', 'pull'] as const).flatMap((action) =>
      (['1', 'run'] as const).map((kind) => [action, kind] as const),
    ),
  )('refuses git %s for an agent credential (%s)', async (action, kind) => {
    const res = await fetch(`${baseUrl}/projects/${folder}/git/${action}`, {
      method: 'POST',
      headers: { 'x-test-agent': kind },
    });

    expect(res.status).toBe(403);
    expect(commands).toEqual([]);
  });
});
