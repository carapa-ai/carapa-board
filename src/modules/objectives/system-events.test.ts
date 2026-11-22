import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BOX_RESTART_JITTER_MS,
  fanOutSystemEvent,
  publishBoardStarted,
  startBoxRestartWatcher,
} from './system-events.js';
import type { BoxWatcherDeps, SystemEventDeps } from './system-events.js';
import type { BrainEvent } from './brain-client.js';

type Published = { url: string | null; event: BrainEvent };

function makeDeps(groups: Array<{ folder: string; url: string | null }>): {
  deps: SystemEventDeps;
  published: Published[];
} {
  const published: Published[] = [];
  const byFolder = new Map(groups.map((g) => [g.folder, g.url]));
  return {
    published,
    deps: {
      groups: () => groups.map((g) => ({ folder: g.folder })),
      resolveUrl: (g) => byFolder.get(g.folder) ?? null,
      canPublish: () => true,
      publish: (url, event) => void published.push({ url, event }),
      now: () => new Date('2026-10-17T10:00:00.000Z'),
    },
  };
}

const savedFlag = process.env.BRAIN_SYSTEM_EVENTS;
afterEach(() => {
  if (savedFlag === undefined) delete process.env.BRAIN_SYSTEM_EVENTS;
  else process.env.BRAIN_SYSTEM_EVENTS = savedFlag;
});

describe('board_started', () => {
  test('publishes once per distinct brain URL and skips groups without a brain', () => {
    delete process.env.BRAIN_SYSTEM_EVENTS;
    const { deps, published } = makeDeps([
      { folder: 'a', url: 'http://brain-1' },
      { folder: 'b', url: 'http://brain-1' },
      { folder: 'c', url: 'http://brain-2' },
      { folder: 'd', url: null },
    ]);
    publishBoardStarted(deps);
    expect(published.map((p) => p.url)).toEqual([
      'http://brain-1',
      'http://brain-2',
    ]);
    const { event } = published[0];
    expect(event.type).toBe('board_started');
    expect(event.project_id).toBe('a');
    expect(event.timestamp).toBe('2026-10-17T10:00:00.000Z');
    expect(event.data).toMatchObject({ service: 'board' });
    expect(event.data).toHaveProperty('version');
    expect(event.data).toHaveProperty('buildTime');
    expect(typeof event.data.startedAt).toBe('string');
  });

  test('BRAIN_SYSTEM_EVENTS=0 publishes nothing', () => {
    process.env.BRAIN_SYSTEM_EVENTS = '0';
    const { deps, published } = makeDeps([{ folder: 'a', url: 'http://b' }]);
    publishBoardStarted(deps);
    expect(published).toEqual([]);
  });

  test('fan-out never throws', () => {
    const { deps } = makeDeps([]);
    deps.groups = () => {
      throw new Error('boom');
    };
    expect(() => fanOutSystemEvent('board_started', {}, deps)).not.toThrow();
  });
});

describe('box restart watcher', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-watcher-'));
  let fileSeq = 0;
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  function makeWatcher(
    reads: Array<unknown>,
    overrides: Partial<BoxWatcherDeps> = {},
  ) {
    const stateFile = path.join(tmpRoot, `state-${fileSeq++}.json`);
    const calls: Array<{ type: string; data: Record<string, unknown> }> = [];
    let tick: (() => Promise<void>) | undefined;
    let intervals = 0;
    const deps: BoxWatcherDeps = {
      fetchBox: async () => {
        const next = reads.shift();
        if (next instanceof Error) throw next;
        return next as never;
      },
      fanOut: (type, data) => void calls.push({ type, data }),
      setInterval: (fn) => {
        intervals += 1;
        tick = fn;
        return {};
      },
      clearInterval: () => {},
      stateFile,
      ...overrides,
    };
    return {
      stateFile,
      calls,
      deps,
      intervals: () => intervals,
      tick: () => tick!(),
    };
  }
  const box = (startedAt: string | null, version = 'v1') => ({
    version,
    buildTime: 'bt',
    startedAt,
  });

  test('records first read, ignores same/jittered start and errors, publishes on restart', async () => {
    delete process.env.BRAIN_SYSTEM_EVENTS;
    const w = makeWatcher([
      box('2026-10-17T09:00:00.000Z'),
      box('2026-10-17T09:00:00.000Z'),
      box(
        new Date(
          Date.parse('2026-10-17T09:00:00.000Z') + BOX_RESTART_JITTER_MS - 1000,
        ).toISOString(),
      ),
      new Error('down'),
      { error: 'HTTP 503' },
      box('2026-10-17T09:30:00.000Z', 'v2'),
    ]);
    const stop = startBoxRestartWatcher(w.deps);
    expect(stop).not.toBeNull();
    await stop!.initialPoll;
    for (let i = 0; i < 4; i++) await w.tick();
    expect(w.calls).toEqual([]);
    await w.tick();
    expect(w.calls).toEqual([
      {
        type: 'box_started',
        data: {
          service: 'box',
          version: 'v2',
          buildTime: 'bt',
          startedAt: '2026-10-17T09:30:00.000Z',
          previousVersion: 'v1',
          previousStartedAt: '2026-10-17T09:00:00.000Z',
        },
      },
    ]);
  });

  const readFile = (w: { stateFile: string }) =>
    JSON.parse(fs.readFileSync(w.stateFile, 'utf8'));

  test('persisted older baseline: the first poll emits once with previous values', async () => {
    delete process.env.BRAIN_SYSTEM_EVENTS;
    const w = makeWatcher([box('2026-10-17T10:00:00.000Z', 'v2')]);
    fs.writeFileSync(
      w.stateFile,
      JSON.stringify({ version: 'v1', startedAt: '2026-10-17T09:00:00.000Z' }),
    );
    await startBoxRestartWatcher(w.deps)!.initialPoll;
    expect(w.calls).toEqual([
      {
        type: 'box_started',
        data: {
          service: 'box',
          version: 'v2',
          buildTime: 'bt',
          startedAt: '2026-10-17T10:00:00.000Z',
          previousVersion: 'v1',
          previousStartedAt: '2026-10-17T09:00:00.000Z',
        },
      },
    ]);
    expect(readFile(w)).toEqual({
      version: 'v2',
      startedAt: '2026-10-17T10:00:00.000Z',
    });
  });

  test('persisted baseline within jitter: no event', async () => {
    delete process.env.BRAIN_SYSTEM_EVENTS;
    const w = makeWatcher([box('2026-10-17T09:00:10.000Z')]);
    fs.writeFileSync(
      w.stateFile,
      JSON.stringify({ version: 'v1', startedAt: '2026-10-17T09:00:00.000Z' }),
    );
    await startBoxRestartWatcher(w.deps)!.initialPoll;
    expect(w.calls).toEqual([]);
  });

  test('no file: first poll runs at start, records and writes baseline; later shift emits', async () => {
    delete process.env.BRAIN_SYSTEM_EVENTS;
    const w = makeWatcher([
      box('2026-10-17T09:00:00.000Z'),
      box('2026-10-17T09:30:00.000Z'),
    ]);
    const stop = startBoxRestartWatcher(w.deps)!;
    await stop.initialPoll;
    expect(w.calls).toEqual([]);
    expect(readFile(w)).toEqual({
      version: 'v1',
      startedAt: '2026-10-17T09:00:00.000Z',
    });
    await w.tick();
    expect(w.calls).toHaveLength(1);
  });

  test('corrupt file is treated as missing', async () => {
    delete process.env.BRAIN_SYSTEM_EVENTS;
    const w = makeWatcher([box('2026-10-17T09:00:00.000Z')]);
    fs.writeFileSync(w.stateFile, '{not json');
    await startBoxRestartWatcher(w.deps)!.initialPoll;
    expect(w.calls).toEqual([]);
    expect(readFile(w).startedAt).toBe('2026-10-17T09:00:00.000Z');
  });

  test('write failure does not stop later emits', async () => {
    delete process.env.BRAIN_SYSTEM_EVENTS;
    const w = makeWatcher(
      [box('2026-10-17T09:00:00.000Z'), box('2026-10-17T09:30:00.000Z')],
      {
        writeState: () => {
          throw new Error('disk full');
        },
      },
    );
    await startBoxRestartWatcher(w.deps)!.initialPoll;
    await w.tick();
    expect(w.calls).toHaveLength(1);
  });

  test('BRAIN_SYSTEM_EVENTS=0 starts no interval', () => {
    process.env.BRAIN_SYSTEM_EVENTS = '0';
    const w = makeWatcher([]);
    expect(startBoxRestartWatcher(w.deps)).toBeNull();
    expect(w.intervals()).toBe(0);
  });
});
