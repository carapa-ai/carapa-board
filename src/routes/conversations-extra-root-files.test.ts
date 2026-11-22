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
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { initDatabase } from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import * as gitOps from '../lib/git-ops.js';
import { loadState, updateGroup } from '../state-manager.js';

const { default: conversationsRouter } = await import('./conversations.js');

describe('extra workspace root files routes', () => {
  const projectId = 'extra-root-files-route';
  let server: Server | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    await initDatabase(':memory:');
    const handle = drizzleDbRef.current as any;
    const client =
      handle?.$client ?? handle?._?.client ?? handle?.session?.client;
    await client.exec(
      `INSERT INTO projects (id, jid, name, folder, trigger, added_at, is_main)
       VALUES ('${projectId}', '${projectId}@web', '${projectId}', '${projectId}', '!', '${new Date().toISOString()}', 0)
       ON CONFLICT (id) DO NOTHING`,
    );
    await loadState();
    await updateGroup(`${projectId}@web`, {
      settings: { workspaceRoots: ['/data/shared'] },
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as any).authUser = { id: 'u', username: 'admin', role: 'admin' };
      next();
    });
    app.use(conversationsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  afterEach(() => {
    spyOn(gitOps, 'runGitInRepo').mockRestore();
  });

  test('unknown index is 404 and path traversal is 400, without running a sandbox command', async () => {
    const run = spyOn(gitOps, 'runGitInRepo');
    const base = `${baseUrl}/projects/${projectId}/files/root`;
    expect((await fetch(`${base}/1`)).status).toBe(404);
    expect((await fetch(`${base}/1/content?path=a.txt`)).status).toBe(404);
    expect((await fetch(`${base}/x`)).status).toBe(404);
    expect((await fetch(`${base}/0?path=../x`)).status).toBe(400);
    expect((await fetch(`${base}/0/content?path=../x`)).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  test('a valid index lists through the realpath guard for that root', async () => {
    const run = spyOn(gitOps, 'runGitInRepo').mockResolvedValue({
      ok: true,
      output: '1\t0\tsub\tsub\t\n',
    } as any);
    const res = await fetch(`${baseUrl}/projects/${projectId}/files/root/0`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).available).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    const command = String(run.mock.calls[0][1]);
    expect(command).toContain('realpath -e -- ');
    expect(command).toContain('/data/shared');
    expect(command).toContain('__INVALID_DIRECTORY__');
  });

  test('a search with an escaping path is guarded too', async () => {
    const run = spyOn(gitOps, 'runGitInRepo').mockResolvedValue({
      ok: false,
      output: '__INVALID_DIRECTORY__',
    } as any);
    const res = await fetch(
      `${baseUrl}/projects/${projectId}/files/root/0?search=a&path=link`,
    );
    expect(res.status).toBe(400);
    expect(String(run.mock.calls[0][1])).toContain('/data/shared/link');
  });

  test('a missing root answers unavailable instead of an error', async () => {
    spyOn(gitOps, 'runGitInRepo').mockResolvedValue({
      ok: false,
      output: '__INVALID_DIRECTORY__ __ROOT_MISSING__',
    } as any);
    const res = await fetch(`${baseUrl}/projects/${projectId}/files/root/0`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: false,
      reason: 'list-failed',
      ignored: [],
    });
  });
});
