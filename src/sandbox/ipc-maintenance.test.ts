import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  maintainIpc,
  pruneEmptyRecordingDirectories,
} from './ipc-maintenance.js';
import type { RegisteredGroup } from '../types.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
const old = new Date(Date.now() - 10 * 86_400_000);
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'board-ipc-prune-'));
  roots.push(root);
  const ipc = path.join(root, 'ipc', 'carapa-bot-demo');
  await fs.mkdir(path.join(ipc, 'recordings'), { recursive: true });
  return { root, ipc };
}
const group = {
  folder: 'demo',
  settings: {
    defaultSandbox: 'carapa-bot',
    defaultSandboxService: 'agent',
    defaultSandboxInstance: 'demo',
  },
} as RegisteredGroup;

test('removes only aged empty recording directories, preserving videos, recent directories and symlinks', async () => {
  const { ipc } = await fixture();
  const dir = path.join(ipc, 'recordings');
  for (const name of ['empty', 'video', 'recent'])
    await fs.mkdir(path.join(dir, name));
  await fs.writeFile(path.join(dir, 'video', 'evidence.webm'), 'video');
  for (const name of ['empty', 'video'])
    await fs.utimes(path.join(dir, name), old, old);
  await fs.symlink(path.join(dir, 'video'), path.join(dir, 'alias'));
  expect(
    await pruneEmptyRecordingDirectories(dir, Date.now() - 86_400_000),
  ).toBe(1);
  expect((await fs.readdir(dir)).sort()).toEqual(['alias', 'recent', 'video']);
});

test('prunes only orphaned browser descriptors after successful close and dispatches sandbox session maintenance', async () => {
  const { root, ipc } = await fixture();
  const browsers = path.join(ipc, 'browser-sessions');
  await fs.mkdir(browsers);
  await fs.mkdir(path.join(ipc, 'sessions', 'old-session'), {
    recursive: true,
  });
  const commands: string[] = [];
  for (const [char, conversationId] of [
    ['a', 'deleted'],
    ['b', 'existing'],
    ['c', null],
  ] as const) {
    const id = `browser-${char.repeat(40)}`;
    const file = path.join(browsers, `${id}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({
        id,
        projectId: 'demo',
        conversationId,
        stack: 'carapa-bot',
        instance: 'demo',
        service: 'agent',
      }),
    );
    await fs.utimes(file, old, old);
  }
  const result = await maintainIpc([group], {
    dataDir: root,
    activeIpc: async () => new Set(),
    conversationExists: async (id) => id === 'existing',
    exec: async (_target, command) => {
      commands.push(command);
    },
  });
  expect(result).toMatchObject({
    browserDescriptors: 1,
    sessionSweeps: 1,
    errors: [],
  });
  expect(commands).toEqual([
    'prune-ipc.sh --apply --days=7',
    `browser-close browser-${'a'.repeat(40)}`,
  ]);
  expect(await fs.readdir(browsers)).toHaveLength(2);
});

test('active or recoverable runs preserve browsers while sandbox session pruning still runs', async () => {
  const { root, ipc } = await fixture();
  await fs.mkdir(path.join(ipc, 'sessions', 'idle'), { recursive: true });
  const browsers = path.join(ipc, 'browser-sessions');
  await fs.mkdir(browsers);
  const id = `browser-${'a'.repeat(40)}`;
  const file = path.join(browsers, `${id}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({
      id,
      projectId: 'deleted',
      stack: 'carapa-bot',
      instance: 'demo',
      service: 'agent',
    }),
  );
  await fs.utimes(file, old, old);
  const commands: string[] = [];
  const deps = {
    dataDir: root,
    activeIpc: async () => new Set(['carapa-bot-demo']),
    exec: async (_target: unknown, command: string) => {
      commands.push(command);
      if (command.startsWith('browser-close ')) throw new Error('close failed');
    },
  };
  expect((await maintainIpc([group], deps)).sessionSweeps).toBe(1);
  expect(commands.splice(0)).toEqual(['prune-ipc.sh --apply --days=7']);
  deps.activeIpc = async () => new Set();
  await fs.mkdir(path.join(ipc, 'runs', 'run-recovery'), { recursive: true });
  expect((await maintainIpc([group], deps)).sessionSweeps).toBe(1);
  expect(commands.splice(0)).toEqual(['prune-ipc.sh --apply --days=7']);
  await fs.rm(path.join(ipc, 'runs'), { recursive: true });
  expect((await maintainIpc([group], deps)).errors).toHaveLength(1);
  expect(commands).toEqual([
    'prune-ipc.sh --apply --days=7',
    `browser-close ${id}`,
  ]);
  expect(await fs.readFile(file, 'utf8')).toContain(id);
});
