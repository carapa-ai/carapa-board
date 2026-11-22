import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { initDatabase } from '../db.js';
import { getGroupDir } from '../group-dir.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { getTmuxClient } from '../lib/tmux-client.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
} from '../state-manager.js';
import {
  getVectorStoreHooks,
  setVectorStoreHooks,
} from '../modules/vector-store/hooks.js';
import projectsRouter from './projects.js';

const pid = `delete-graph-route-${process.pid}`;
const jid = `${pid}@web`;
let server: Server;
let baseUrl: string;
const previousHooks = getVectorStoreHooks();
const sandboxClient = getSandboxClient() as any;
const tmuxClient = getTmuxClient() as any;
const originalSandboxStop = sandboxClient.sandboxStop;
const originalForget = tmuxClient.forgetByInstance;

async function register() {
  await unregisterGroup(jid);
  await registerGroup(jid, {
    jid,
    name: 'Delete graph route',
    folder: pid,
    trigger: '@delete',
    added_at: new Date().toISOString(),
    settings: { status: 'running' },
  });
}

function installHook(
  deleteGroupMemoryGraph: (folder: string) => Promise<number>,
) {
  setVectorStoreHooks({ deleteGroupMemoryGraph } as any);
}

const renamedPid = `${pid}-renamed`.toLowerCase().replace(/[^a-z0-9]+/g, '-');

beforeAll(async () => {
  sandboxClient.sandboxStop = async () => ({ stdout: '', isError: false });
  tmuxClient.forgetByInstance = async () => 0;
  await initDatabase(':memory:');
  await loadState();
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.authUser = { id: 'admin', role: 'admin' };
    next();
  });
  app.use(projectsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sandboxClient.sandboxStop = originalSandboxStop;
  tmuxClient.forgetByInstance = originalForget;
  setVectorStoreHooks(previousHooks as any);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unregisterGroup(jid);
});

describe('DELETE /projects/:pid Neo4j memory graph', () => {
  test('calls the hook with the deleted project folder only', async () => {
    await register();
    const folders: string[] = [];
    installHook(async (folder) => {
      folders.push(folder);
      return 2;
    });
    const res = await fetch(`${baseUrl}/projects/${pid}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(folders).toEqual([pid]);
    expect(getGroupByFolder(pid)).toBeUndefined();
  });

  test('a rejecting hook still returns ok', async () => {
    await register();
    installHook(async () => {
      throw new Error('neo4j down');
    });
    const res = await fetch(`${baseUrl}/projects/${pid}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getGroupByFolder(pid)).toBeUndefined();
  });
});

describe('PATCH /projects/:pid folder rename Neo4j memory graph', () => {
  async function rename() {
    // A rename that cannot move its directory is refused, so the directory an
    // earlier case renamed to must not be left in the way.
    fs.rmSync(getGroupDir(renamedPid), { recursive: true, force: true });
    return fetch(`${baseUrl}/projects/${pid}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder: renamedPid }),
    });
  }

  test('calls the hook once with (old, new)', async () => {
    await register();
    const calls: Array<[string, string]> = [];
    setVectorStoreHooks({
      renameGroupMemoryGraph: async (from: string, to: string) => {
        calls.push([from, to]);
        return 2;
      },
    } as any);
    const res = await rename();
    expect(res.status).toBe(200);
    expect(calls).toEqual([[pid, renamedPid]]);
    expect(getGroupByFolder(renamedPid)).toBeDefined();
  });

  test('a rejecting hook still returns 200', async () => {
    await register();
    setVectorStoreHooks({
      renameGroupMemoryGraph: async () => {
        throw new Error('neo4j down');
      },
    } as any);
    const res = await rename();
    expect(res.status).toBe(200);
    expect(getGroupByFolder(renamedPid)).toBeDefined();
  });
});
