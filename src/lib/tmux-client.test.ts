/**
 * TmuxClient tests — mirror the dependency-injection pattern from
 * src/modules/tools/tools.test.ts:33-60 without using top-level
 * `mock.module()` (which would leak into other test files run in the same
 * Bun process — see .agent/rules/08-testing-patterns.md).
 *
 * Setup/teardown is centralised in `beforeAll`/`afterAll` to avoid per-test
 * directory thrash; each test isolates state via unique task IDs / fake
 * directories instead.
 *
 * The fake carapa-box client (`FakeTmuxBox`) implements the same surface as
 * `TmuxBoxClient.attach()` and the resulting `TmuxAttachHandle`: each call
 * returns a `FakeHandle` that records exec/resize/detach invocations and
 * exposes `emitDelta(chunk)` so the test can drive live-byte delivery into
 * the client's fanout — that's the path that previously carried the
 * `"(no output)"` garbage from the MCP sandboxTmux_ tools.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from 'bun:test';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { TmuxClient, __test__ } from './tmux-client.js';
import type {
  TmuxAttachHandle,
  TmuxAttachInit,
  TmuxAttachOptions,
  TmuxBoxClient,
  TmuxDetachOptions,
  TmuxExecOptions,
  TmuxExecResult,
  TmuxResizeOptions,
} from './tmux-box-client.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

interface FakeHandle {
  /** `init` payload that `attach()` resolved with. */
  initPayload: TmuxAttachInit;
  /** Underlying handle object the TmuxClient holds. */
  handle: TmuxAttachHandle;
  /** Recorded `exec()` calls. */
  execCalls: TmuxExecOptions[];
  /** Recorded `resize()` calls. */
  resizeCalls: TmuxResizeOptions[];
  /** Recorded `detach()` calls. */
  detachCalls: TmuxDetachOptions[];
  /** Number of times `close()` was invoked. */
  closeCount: number;
  /** Number of times `onDelta()` listeners were registered. */
  deltaListenerCount: number;
  /** Push a shell-exit lifecycle event to every registered listener. */
  emitExit(): void;
  /** Push a delta to every registered listener. */
  emitDelta(chunk: string): void;
}

interface FakeTmuxBox {
  /** Recorded `attach()` calls. */
  attachCalls: Array<{
    stack: string;
    service: string;
    instance: string;
    options: TmuxAttachOptions;
  }>;
  /** Init payloads queued for the next `attach()` calls. */
  initResponses: TmuxAttachInit[];
  /** Per-handle exec responses. */
  execResponses: TmuxExecResult[];
  /** Per-handle resize responses. */
  resizeResponses: TmuxExecResult[];
  /** Per-handle detach responses (`{ isError }` shape). */
  detachResponses: Array<{ isError: boolean } | undefined>;
  /** Per-handle detached flag — set true after a successful detach. */
  handles: FakeHandle[];
  /** Underlying client with the method shape TmuxClient expects. */
  client: Pick<TmuxBoxClient, 'attach'>;
}

function makeFakeTmuxBox(initOverrides?: Partial<TmuxAttachInit>): FakeTmuxBox {
  const defaultInit: TmuxAttachInit = {
    streamId: 'box-stream-1',
    session: 'sess-abc',
    cols: 200,
    rows: 50,
    scrollback: 'hello world\n',
  };
  const state: FakeTmuxBox = {
    attachCalls: [],
    initResponses: [{ ...defaultInit, ...initOverrides }],
    execResponses: [],
    resizeResponses: [],
    detachResponses: [],
    handles: [],
    client: undefined as any,
  };

  const client: Pick<TmuxBoxClient, 'attach'> = {
    attach: async (stack, service, instance, options) => {
      state.attachCalls.push({ stack, service, instance, options });
      const init = state.initResponses.shift();
      if (!init) {
        throw new Error('fake attach: no init response queued');
      }
      return buildFakeHandle(state, init).handle;
    },
  };

  state.client = client;
  return state;
}

function buildFakeHandle(
  state: FakeTmuxBox,
  initPayload: TmuxAttachInit,
): FakeHandle {
  const execCalls: TmuxExecOptions[] = [];
  const resizeCalls: TmuxResizeOptions[] = [];
  const detachCalls: TmuxDetachOptions[] = [];
  let closeCount = 0;
  const listeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<() => void>();
  const handle: TmuxAttachHandle = {
    get init() {
      return initPayload;
    },
    onDelta: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => {
        exitListeners.delete(cb);
      };
    },
    exec: async (input) => {
      execCalls.push(input);
      const next = state.execResponses.shift();
      if (next) return next;
      return { isError: false, stdout: '' };
    },
    resize: async (opts) => {
      resizeCalls.push(opts);
      const next = state.resizeResponses.shift();
      if (next) return next;
      return { isError: false, stdout: '' };
    },
    detach: async () => {
      detachCalls.push({
        session: initPayload.session,
        streamId: initPayload.streamId,
      });
      const next = state.detachResponses.shift();
      if (next?.isError) {
        throw new Error('fake detach: isError=true');
      }
    },
    close: () => {
      closeCount += 1;
    },
    waitForInit: async () => initPayload,
  };
  const fake: FakeHandle = {
    initPayload,
    handle,
    execCalls,
    resizeCalls,
    detachCalls,
    get closeCount() {
      return closeCount;
    },
    get deltaListenerCount() {
      return listeners.size;
    },
    emitDelta: (chunk) => {
      for (const cb of listeners) cb(chunk);
    },
    emitExit: () => {
      for (const cb of exitListeners) cb();
    },
  };
  state.handles.push(fake);
  return fake;
}

// ── Suite-wide setup ────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-client-test-'));
const ipcDir = path.join(tmpRoot, 'ipc');
const storeDir = path.join(tmpRoot, 'store');

let streamCounter = 0;
const chunks: Array<{ streamId: string; chunk: string }> = [];

beforeAll(() => {
  fs.mkdirSync(ipcDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
});

beforeEach(() => {
  streamCounter = 0;
  chunks.length = 0;
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function newClient(
  fake: FakeTmuxBox,
  overrides: Partial<ConstructorParameters<typeof TmuxClient>[0]> = {},
): TmuxClient {
  return new TmuxClient({
    box: fake.client,
    ipcDir,
    storeDir,
    onChunk: (streamId, chunk) => chunks.push({ streamId, chunk }),
    generateStreamId: () => `stream-${++streamCounter}`,
    now: () => 1_700_000_000_000,
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TmuxClient', () => {
  test('open() returns { streamId, cols, rows, scrollback } and seeds the index', async () => {
    const fake = makeFakeTmuxBox();
    const client = newClient(fake);

    const result = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-test-1',
      taskId: 'task-attach-1',
    });

    // (a) open returns scrollback + streamId from the SSE `init` event.
    expect(result.session).toBe('sess-abc');
    expect(result.scrollback).toBe('hello world\n');
    expect(result.cols).toBe(200);
    expect(result.rows).toBe(50);
    expect(result.streamId).toMatch(/^stream-\d+$/);

    // It forwarded the right args to carapa-box.
    expect(fake.attachCalls).toHaveLength(1);
    expect(fake.attachCalls[0]).toEqual({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-test-1',
      options: { session: 'task-attach-1', cols: 200, rows: 50 },
    });

    // Initial scrollback was fanned out as a chunk.
    expect(chunks.at(-1)).toEqual({
      streamId: result.streamId,
      chunk: 'hello world\n',
    });

    // The session index was persisted to disk.
    const indexRaw = await fsp.readFile(
      path.join(ipcDir, 'tmux-sessions.json'),
      'utf8',
    );
    const index = JSON.parse(indexRaw);
    expect(index[result.streamId]).toEqual({
      taskId: 'task-attach-1',
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-test-1',
      session: 'sess-abc',
      rows: 50,
      boxStreamId: 'box-stream-1',
      createdAt: 1_700_000_000_000,
    });

    // And the initial scrollback is on disk for later replay.
    const log = await fsp.readFile(
      path.join(storeDir, 'task-attach-1.log'),
      'utf8',
    );
    expect(log).toBe('hello world\n');
  });

  test('sendKeys() base64-encodes the keys payload and does not fan out an echo', async () => {
    const fake = makeFakeTmuxBox();
    const client = newClient(fake);
    const opened = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-test-keys',
      taskId: 'task-keys-1',
    });

    const before = chunks.length;
    const keys = 'ls -la\n';
    const result = await client.sendKeys(opened.streamId, keys);

    expect(result.isError).toBe(false);
    // The exec call was issued with base64 input (the only side effect we
    // still rely on — the live echo now arrives through the SSE pump, not
    // through the exec response).
    expect(fake.handles[0].execCalls).toHaveLength(1);
    const call = fake.handles[0].execCalls[0];
    expect(call.input).toBe(Buffer.from(keys, 'utf8').toString('base64'));
    expect(Buffer.from(call.input, 'base64').toString('utf8')).toBe(keys);
    // Critically: NO chunk was fanned out from the exec response — the old
    // behaviour was to forward `result.stdout` (the literal `"(no output)"`
    // sentinel from carapa-box `register.ts:1637`). That path is gone.
    expect(chunks.length).toBe(before);
  });

  test('SSE deltas are fanned out to subscribers and appended to the buffer file', async () => {
    const fake = makeFakeTmuxBox();
    const client = newClient(fake);
    const opened = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-test-sse',
      taskId: 'task-sse-1',
    });

    const before = chunks.length;
    const received: string[] = [];
    const unsubscribe = client.subscribe(opened.streamId, (_sid, chunk) => {
      received.push(chunk);
    });

    // Drive the SSE pump directly from the fake.
    const handle = fake.handles[0];
    handle.emitDelta('line-A\n');
    handle.emitDelta('line-B\n');

    // Constructor-level onChunk hook received both.
    expect(chunks.slice(before).map((c) => c.chunk)).toEqual([
      'line-A\n',
      'line-B\n',
    ]);
    // Subscriber also received both (same chunks, NOT doubled).
    expect(received).toEqual(['line-A\n', 'line-B\n']);

    await client.flush(opened.streamId);
    const log = await fsp.readFile(
      path.join(storeDir, 'task-sse-1.log'),
      'utf8',
    );
    expect(log).toBe('hello world\nline-A\nline-B\n');

    unsubscribe();
  });

  test('two concurrent open() calls receive independently-routed deltas', async () => {
    const fake = makeFakeTmuxBox();
    fake.initResponses = [
      {
        streamId: 'box-stream-A',
        session: 'sess-A',
        cols: 200,
        rows: 50,
        scrollback: 'init-A\n',
      },
      {
        streamId: 'box-stream-B',
        session: 'sess-B',
        cols: 200,
        rows: 50,
        scrollback: 'init-B\n',
      },
    ];
    const client = newClient(fake);
    const openedA = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-concurrent-A',
      taskId: 'task-concurrent-A',
    });
    const openedB = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-concurrent-B',
      taskId: 'task-concurrent-B',
    });

    const aChunks: string[] = [];
    const bChunks: string[] = [];
    // Subscribers register AFTER open() — they only see live SSE deltas.
    // Initial scrollback went to the constructor-level onChunk hook, not
    // these late subscribers. The point of this test is per-stream routing,
    // not seed replay.
    client.subscribe(openedA.streamId, (_sid, chunk) => aChunks.push(chunk));
    client.subscribe(openedB.streamId, (_sid, chunk) => bChunks.push(chunk));

    // Emit to A — B's subscriber must NOT receive it.
    fake.handles[0].emitDelta('only-A\n');
    // Emit to B — A's subscriber must NOT receive it.
    fake.handles[1].emitDelta('only-B\n');

    expect(aChunks).toEqual(['only-A\n']);
    expect(bChunks).toEqual(['only-B\n']);
  });

  test('replay() reads the trailing lines of the buffer file', async () => {
    const fake = makeFakeTmuxBox();
    const client = newClient(fake);
    const opened = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-test-replay',
      taskId: 'task-replay-1',
    });

    // Append more lines via SSE deltas (this is the new "live" path).
    fake.handles[0].emitDelta('line-A\n');
    fake.handles[0].emitDelta('line-B\nline-C\n');
    await client.flush(opened.streamId);

    // (c) replay reads from the buffer file.
    // No trailing newline — replay is byte-faithful to what was stored.
    const tail = await client.replay(opened.streamId);
    expect(tail).toBe('hello world\nline-A\nline-B\nline-C');

    // Custom fromLine caps the slice.
    const tail2 = await client.replay(opened.streamId, { fromLine: 2 });
    expect(tail2).toBe('line-B\nline-C');
  });

  test('close(kill:false) keeps the session record and buffer on disk', async () => {
    const fake = makeFakeTmuxBox();
    const client = newClient(fake);
    const opened = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-test-close-soft',
      taskId: 'task-close-soft',
    });

    await client.close(opened.streamId, { kill: false });

    // No detach call should have been issued.
    expect(fake.handles[0].detachCalls).toHaveLength(0);
    // The local SSE handle WAS closed to release the fetch reader.
    expect(fake.handles[0].closeCount).toBe(1);

    // The session is still in the index.
    const indexRaw = await fsp.readFile(
      path.join(ipcDir, 'tmux-sessions.json'),
      'utf8',
    );
    const index = JSON.parse(indexRaw);
    expect(index[opened.streamId]).toBeDefined();

    // The buffer is still on disk.
    const log = await fsp.readFile(
      path.join(storeDir, 'task-close-soft.log'),
      'utf8',
    );
    expect(log).toBe('hello world\n');
  });

  test('close(kill:true) detaches and removes the session record', async () => {
    const fake = makeFakeTmuxBox();
    const client = newClient(fake);
    const opened = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-test-close-hard',
      taskId: 'task-close-hard',
    });

    await client.close(opened.streamId, { kill: true });

    // Detach was called with the session + streamId we got back from init.
    expect(fake.handles[0].detachCalls).toHaveLength(1);
    expect(fake.handles[0].detachCalls[0]).toEqual({
      session: 'sess-abc',
      streamId: 'box-stream-1',
    });
    // And the local SSE handle was closed too.
    expect(fake.handles[0].closeCount).toBe(1);

    // The session is gone from the index.
    const indexRaw = await fsp.readFile(
      path.join(ipcDir, 'tmux-sessions.json'),
      'utf8',
    );
    const index = JSON.parse(indexRaw);
    expect(index[opened.streamId]).toBeUndefined();

    // The buffer file is preserved for inspection.
    const log = await fsp.readFile(
      path.join(storeDir, 'task-close-hard.log'),
      'utf8',
    );
    expect(log).toBe('hello world\n');
  });

  test('open() throws when carapa-box reports an attach failure', async () => {
    const fake = makeFakeTmuxBox();
    fake.client.attach = (async () => {
      throw new Error('session does not exist');
    }) as any;

    const client = newClient(fake);
    await expect(
      client.open({
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'tmux-bad',
        taskId: 'task-bad-attach',
      }),
    ).rejects.toThrow(/tmux attach failed/);
  });

  test('a fresh client picks up sessions persisted by a previous client', async () => {
    // Client A opens a stream and writes some scrollback.
    const fakeA = makeFakeTmuxBox();
    const clientA = newClient(fakeA);
    const opened = await clientA.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-restart-1',
      taskId: 'task-restart-1',
    });
    fakeA.handles[0].emitDelta('line-1\n');
    fakeA.handles[0].emitDelta('line-2\n');
    await clientA.flush(opened.streamId);

    // Sanity-check A still owns the stream.
    expect(clientA.getRecord(opened.streamId)?.taskId).toBe('task-restart-1');
    expect(clientA.listSessions()).toHaveProperty(opened.streamId);

    // Construct a fresh client B in the SAME ipcDir/storeDir — simulates
    // a board restart where the in-memory map is gone but the persisted
    // index and buffer file are still on disk.
    const fakeB = makeFakeTmuxBox();
    const clientB = newClient(fakeB);

    // (1) B's getRecord resolves the streamId without ever calling attach.
    const recordB = clientB.getRecord(opened.streamId);
    expect(recordB).toEqual({
      taskId: 'task-restart-1',
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-restart-1',
      session: 'sess-abc',
      rows: 50,
      boxStreamId: 'box-stream-1',
      createdAt: 1_700_000_000_000,
    });
    // (2) B's listSessions includes the persisted record.
    expect(clientB.listSessions()).toHaveProperty(opened.streamId);
    // (3) CarapaBox was NOT re-attached just because the client came up.
    expect(fakeB.attachCalls).toHaveLength(0);
    // (4) B can replay the persisted scrollback for that streamId.
    const tail = await clientB.replay(opened.streamId);
    expect(tail).toBe('hello world\nline-1\nline-2');
    // (5) B's sendKeys fails (the stream isn't registered in-memory on B
    //     — that's the cleanup-hook's job to wire back into a live stream).
    await expect(clientB.sendKeys(opened.streamId, 'x')).rejects.toThrow(
      /tmux stream not found/,
    );
  });

  test('subscribeExit() reports a shell exit once to live and late subscribers', async () => {
    const fake = makeFakeTmuxBox();
    const client = newClient(fake);
    const opened = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-test-exit',
      taskId: 'task-exit-1',
    });

    const exits: string[] = [];
    client.subscribeExit(opened.streamId, (sid) => exits.push(`live:${sid}`));
    fake.handles[0].emitExit();
    fake.handles[0].emitExit();
    client.subscribeExit(opened.streamId, (sid) => exits.push(`late:${sid}`));

    expect(exits).toEqual([
      `live:${opened.streamId}`,
      `late:${opened.streamId}`,
    ]);
  });

  test('subscribe() unsubscribe() stops further chunks', async () => {
    const fake = makeFakeTmuxBox();
    const client = newClient(fake);
    const opened = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-sub-3',
      taskId: 'task-sub-3',
    });

    const received: string[] = [];
    const unsubscribe = client.subscribe(opened.streamId, (_sid, chunk) => {
      received.push(chunk);
    });

    fake.handles[0].emitDelta('first\n');
    expect(received).toEqual(['first\n']);

    unsubscribe();
    fake.handles[0].emitDelta('second\n');
    // No additional chunks after unsubscribe.
    expect(received).toEqual(['first\n']);
  });
});

describe('TmuxClient index loading (failure modes)', () => {
  // Use a private subdir so these tests don't interact with the index that
  // the main suite has been writing into.
  const subDir = path.join(tmpRoot, 'index-load');
  const subIpc = path.join(subDir, 'ipc');
  const subStore = path.join(subDir, 'store');

  beforeAll(() => {
    fs.mkdirSync(subIpc, { recursive: true });
    fs.mkdirSync(subStore, { recursive: true });
  });

  test('corrupt JSON on the index is treated as an empty map (no throw)', () => {
    const indexPath = path.join(subIpc, 'tmux-sessions.json');
    fs.writeFileSync(indexPath, '{ not valid json', 'utf8');
    const fake = makeFakeTmuxBox();
    const client = new TmuxClient({
      box: fake.client,
      ipcDir: subIpc,
      storeDir: subStore,
    });
    expect(client.listSessions()).toEqual({});
  });
});

describe('TmuxClient sweep-on-open (drops stale same-taskId entries)', () => {
  // Each test gets its own scratch dir under tmpRoot so the
  // previously-persisted index from earlier suites doesn't leak in
  // and contaminate the "only stream-1" / "only stream-2" assertions.
  let sweepIpc: string;
  let sweepStore: string;
  beforeEach(() => {
    sweepIpc = fs.mkdtempSync(path.join(tmpRoot, 'ipc-sweep-'));
    sweepStore = fs.mkdtempSync(path.join(tmpRoot, 'store-sweep-'));
  });

  test('open() with the same taskId drops an unread prior stream but keeps one still being read', async () => {
    const fake = makeFakeTmuxBox();
    // We open three times — queue more init payloads so the fake doesn't
    // throw `no init response queued` on later attach calls.
    fake.initResponses.push(
      { ...fake.initResponses[0] },
      { ...fake.initResponses[0] },
    );
    const clock = { value: 1_700_000_000_000 };
    const client = new TmuxClient({
      box: fake.client,
      ipcDir: sweepIpc,
      storeDir: sweepStore,
      generateStreamId: () => `stream-${++streamCounter}`,
      now: () => clock.value,
    });
    // Open stream #1 for taskId 'shell-A'.
    const first = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-sweep',
      taskId: 'shell-A',
    });
    expect(first.streamId).toBe('stream-1');
    expect(Object.keys(client.listSessions()).sort()).toEqual(['stream-1']);
    // Open stream #2 for the SAME taskId after a browser refresh: nobody
    // reads stream-1 any more and its grace period has passed, so it is
    // swept; only stream-2 should remain.
    clock.value += 31_000;
    const second = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-sweep',
      taskId: 'shell-A',
    });
    expect(second.streamId).toBe('stream-2');
    const sessions = client.listSessions();
    expect(Object.keys(sessions).sort()).toEqual(['stream-2']);
    expect(sessions['stream-2']?.taskId).toBe('shell-A');
    // The on-disk index should also reflect the sweep (single entry).
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(sweepIpc, 'tmux-sessions.json'), 'utf8'),
    );
    expect(Object.keys(onDisk).sort()).toEqual(['stream-2']);

    // A second viewer (another mounted panel or browser window) opens the
    // same tab while stream-2 is being read: both streams stay usable.
    const unsubscribe = client.subscribe('stream-2', () => {});
    clock.value += 31_000;
    const third = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-sweep',
      taskId: 'shell-A',
    });
    expect(Object.keys(client.listSessions()).sort()).toEqual([
      'stream-2',
      third.streamId,
    ]);
    unsubscribe();
  });

  test('open() with a DIFFERENT taskId does not drop the prior entry', async () => {
    const fake = makeFakeTmuxBox();
    fake.initResponses.push({ ...fake.initResponses[0] });
    const client = new TmuxClient({
      box: fake.client,
      ipcDir: sweepIpc,
      storeDir: sweepStore,
      generateStreamId: () => `stream-${++streamCounter}`,
    });
    // Two different taskIds (two sibling shell tabs sharing one
    // container). Both entries must coexist; the sweep is keyed
    // on taskId so unrelated entries are not collateral.
    await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-multi',
      taskId: 'shell-tab1',
    });
    await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-multi',
      taskId: 'shell-tab2',
    });
    const sessions = client.listSessions();
    expect(Object.keys(sessions).sort()).toEqual(['stream-1', 'stream-2']);
  });
});

describe('TmuxClient.reconcile()', () => {
  // Per-test scratch dir under tmpRoot so each reconcile test gets
  // its own tmux-sessions.json without colliding with the main
  // suite's index file.
  let reconcileIpc: string;
  beforeEach(() => {
    reconcileIpc = fs.mkdtempSync(path.join(tmpRoot, 'ipc-reconcile-'));
  });

  test('drops entries older than maxAgeMs that are not in this.streams', async () => {
    const fake = makeFakeTmuxBox();
    const nowRef = { value: 1_700_000_000_000 };
    const client = new TmuxClient({
      box: fake.client,
      ipcDir: reconcileIpc,
      storeDir,
      generateStreamId: () => `stream-${++streamCounter}`,
      now: () => nowRef.value,
    });
    // Seed two entries: one 25h old (over the 24h TTL), one 1h
    // old. After reconcile, only the fresh entry should remain.
    client['sessions'] = {
      'old-stream': {
        taskId: 'shell-old',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'tmux-reconcile',
        session: 'shell-old',
        createdAt: nowRef.value - 25 * 60 * 60 * 1000,
      },
      'fresh-stream': {
        taskId: 'shell-fresh',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'tmux-reconcile',
        session: 'shell-fresh',
        createdAt: nowRef.value - 1 * 60 * 60 * 1000,
      },
    };
    const dropped = await client.reconcile(24 * 60 * 60 * 1000);
    expect(dropped).toBe(1);
    expect(Object.keys(client.listSessions())).toEqual(['fresh-stream']);
    // The on-disk file should also reflect the drop.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(reconcileIpc, 'tmux-sessions.json'), 'utf8'),
    );
    expect(Object.keys(onDisk)).toEqual(['fresh-stream']);
  });

  test('keeps entries that ARE held in this.streams (live in this process)', async () => {
    const fake = makeFakeTmuxBox();
    const nowRef = { value: 1_700_000_000_000 };
    const client = new TmuxClient({
      box: fake.client,
      ipcDir: reconcileIpc,
      storeDir,
      generateStreamId: () => `stream-${++streamCounter}`,
      now: () => nowRef.value,
    });
    // Open a stream so its entry is held in this.streams. The
    // entry's createdAt uses `nowRef.value`.
    const opened = await client.open({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'tmux-reconcile-live',
      taskId: 'shell-live',
    });
    expect(client.listSessions()[opened.streamId]?.createdAt).toBe(
      nowRef.value,
    );
    // Fast-forward the clock past the TTL. The in-process stream
    // should still be considered live and not dropped.
    nowRef.value = 1_700_000_000_000 + 25 * 60 * 60 * 1000;
    const dropped = await client.reconcile(24 * 60 * 60 * 1000);
    expect(dropped).toBe(0);
    expect(client.listSessions()[opened.streamId]?.taskId).toBe('shell-live');
  });
});

describe('truncateToWindow', () => {
  test('drops the oldest bytes and snaps to a newline', () => {
    // "new line A\nnew line B\n" is 22 bytes. The full input is 32 bytes,
    // so the cap trims the first 10 bytes — which happens to span partway
    // through "old1\nold2\nnew ". The next \n in the resulting slice
    // is the one that terminates "new line A"; the truncated output
    // therefore starts on "new line B".
    const data = 'old1\nold2\nnew line A\nnew line B\n';
    const out = __test__.truncateToWindow(
      data,
      'new line A\nnew line B\n'.length,
    );
    // The truncated output must start on a fresh line.
    expect(out.startsWith('new line B')).toBe(true);
    // And preserve the tail content.
    expect(out).toContain('new line B');
  });

  test('does not split a multibyte character at the byte boundary', () => {
    const out = __test__.truncateToWindow('prefix\nαβγδε\n', 6);

    expect(out).not.toContain('�');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(6);
    expect(out).toBe('δε\n');
  });
});
