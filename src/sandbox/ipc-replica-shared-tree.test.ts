import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  IpcReplica,
  type ReplicaToolClient,
  type ReplicaTreeOptions,
} from './ipc-replica.js';

function replicaAnswering(
  answer: () => { stdout: string; isError: boolean },
): IpcReplica {
  // The test preload switches replication off; it is read at construction.
  const previous = process.env.IPC_REPLICA;
  delete process.env.IPC_REPLICA;
  const replica = new IpcReplica();
  if (previous === undefined) delete process.env.IPC_REPLICA;
  else process.env.IPC_REPLICA = previous;
  const client: ReplicaToolClient = { callTool: async () => answer() };
  replica.setClientResolver(() => client);
  return replica;
}

const probe = (extra: Record<string, unknown>) => ({
  stdout: JSON.stringify({
    pushed: [],
    files: [],
    dirs: [],
    deleted: [],
    more: false,
    ...extra,
  }),
  isError: false,
});

describe('IpcReplica.confirmSharedTree', () => {
  test('is true only when the box reports that it shares Board’s tree', async () => {
    const replica = replicaAnswering(() => probe({ shared: true }));
    expect(await replica.confirmSharedTree('carapa-bot-main-a')).toBe(true);
  });

  test('is false when the box keeps a tree of its own', async () => {
    const replica = replicaAnswering(() => probe({}));
    expect(await replica.confirmSharedTree('carapa-bot-main-a')).toBe(false);
  });

  test('is false when the local box cannot say (assumed layout is not proof)', async () => {
    const unreachable = replicaAnswering(() => {
      throw new Error('box offline');
    });
    expect(await unreachable.confirmSharedTree('carapa-bot-main-a')).toBe(
      false,
    );
    const outdated = replicaAnswering(() => probe({ unavailable: 'old box' }));
    expect(await outdated.confirmSharedTree('carapa-bot-main-a')).toBe(false);
  });
});

test('IpcReplica.confirmSharedTree treats switched-off replication as single-host', async () => {
  const previous = process.env.IPC_REPLICA;
  process.env.IPC_REPLICA = 'off';
  try {
    expect(await new IpcReplica().confirmSharedTree('carapa-bot-main-a')).toBe(
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.IPC_REPLICA;
    else process.env.IPC_REPLICA = previous;
  }
});

describe('IpcReplica offset chunks', () => {
  let tmp = '';
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const fileOf = (name: string, offset: number, text: string) => ({
    path: name,
    size: offset + text.length,
    mtimeMs: 1000,
    offset,
    data: Buffer.from(text).toString('base64'),
    replace: false,
    complete: offset === 0,
  });

  /** Replica over a temp tree; `answers` are the box's replies in call order. */
  function scripted(
    answers: Array<
      (args: Record<string, any>) => Record<string, unknown> | undefined
    >,
  ) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-replica-chunk-'));
    const options: ReplicaTreeOptions = {
      tree: 'ipc',
      localRoot: () => path.join(tmp, 'ipc'),
      stateDir: () => path.join(tmp, 'state'),
      backgroundRoots: [],
      excludedDirs: new Set(),
      splitRoots: [],
      wholeProject: false,
    };
    const previous = process.env.IPC_REPLICA;
    delete process.env.IPC_REPLICA;
    const replica = new IpcReplica(options);
    if (previous !== undefined) process.env.IPC_REPLICA = previous;
    const requests: Array<Record<string, any>> = [];
    const client: ReplicaToolClient = {
      callTool: async (_name, args) => {
        requests.push(args);
        return probe(answers.shift()?.(args) ?? {});
      },
    };
    replica.setClientResolver(() => client);
    const dir = path.join(tmp, 'ipc', 'proj', 'runs', 'r1');
    fs.mkdirSync(dir, { recursive: true });
    return { replica, requests, dir };
  }

  test('a refused append keeps the local prefix and is pulled again, never pushed', async () => {
    const { replica, requests, dir } = scripted([
      () => ({}), // probe
      () => ({ files: [fileOf('a.txt', 0, 'abcdefghij')] }),
      () => ({
        files: [fileOf('a.txt', 100, 'xyz'), fileOf('b.txt', 0, 'other')],
      }),
    ]);
    await replica.syncRoot('proj', 'runs/r1');
    await replica.syncRoot('proj', 'runs/r1');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('abcdefghij');
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('other');

    await replica.syncRoot('proj', 'runs/r1');
    const next = requests[requests.length - 1];
    expect(next.push.filter((op: any) => op.op === 'write')).toEqual([]);
    expect(next.base['a.txt']).toEqual([0, null]);
  });

  test('an append whose directory vanished mid-sync does not re-create it', async () => {
    const { replica, dir } = scripted([
      () => ({}), // probe
      () => ({ files: [fileOf('a.txt', 0, 'abcdefghij')] }),
      () => {
        fs.rmSync(dir, { recursive: true });
        return { files: [fileOf('a.txt', 100, 'xyz')] };
      },
    ]);
    await replica.syncRoot('proj', 'runs/r1');
    await replica.syncRoot('proj', 'runs/r1');
    expect(fs.existsSync(dir)).toBe(false);
  });
});
