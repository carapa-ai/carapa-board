import {
  afterAll,
  afterEach,
  beforeEach,
  beforeAll,
  describe,
  expect,
  test,
  spyOn,
} from 'bun:test';
import { mock as nodeMock } from 'node:test';
import * as wsEvents from '../objectives/ws-events.js';
import type { LiveQueueSnapshot } from './live-queue.js';
import { initDatabase } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  conversations,
  projects,
  ttsAudioAssets,
  users,
} from '../../db/schema.js';
import { conversationLiveRuns } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  enableLiveQueue,
  getBindableLiveRunMode,
  getLiveQueueSnapshot,
  markLiveQueueSpeechReady,
  registerLiveQueueMessage,
  renewLiveLease,
  startLiveQueueItem,
  stopLiveQueue,
  waitForLiveQueueStart,
} from './live-queue.js';

const conversationId = 'live-queue-test-conversation';

beforeAll(async () => {
  await initDatabase(':memory:');
  const now = new Date().toISOString();
  await drizzleDbRef.current.insert(users).values({
    id: 'live-user',
    username: 'live-user',
    password_hash: 'x',
    role: 'user',
    created_at: now,
  });
  await drizzleDbRef.current.insert(projects).values({
    id: 'live-project',
    jid: 'live@web',
    name: 'Live',
    folder: 'live-project',
    trigger: '@',
    added_at: now,
    user_id: 'live-user',
  });
  await drizzleDbRef.current.insert(conversations).values({
    id: conversationId,
    group_folder: 'live-project',
    created_at: now,
  });
  await drizzleDbRef.current.insert(ttsAudioAssets).values(
    ['b', 'm', 'a'].map((id) => ({
      id: `asset-${id}`,
      format: 'ogg',
      mimeType: 'audio/ogg',
      durationMs: 20,
      sampleRate: 24_000,
      byteLength: 1,
      model: 'test',
      voiceId: id,
      language: 'en',
      parameters: {},
      storagePath: `tts/${id}.ogg`,
      createdAt: now,
      lastAccessedAt: now,
    })),
  );
});

let broadcastSpy: ReturnType<typeof spyOn>;
const snapshotListeners = new Set<(snapshot: LiveQueueSnapshot) => void>();

function nextSnapshot(
  predicate: (snapshot: LiveQueueSnapshot) => boolean,
): Promise<LiveQueueSnapshot> {
  return new Promise((resolve) => {
    const listener = (snapshot: LiveQueueSnapshot) => {
      if (!predicate(snapshot)) return;
      snapshotListeners.delete(listener);
      resolve(snapshot);
    };
    snapshotListeners.add(listener);
  });
}

// The mock clock stays installed for the whole file. Node's mock timers number
// handles per enable cycle, so a handle the module still holds from an earlier
// test (live-queue.ts keeps them in module maps) would, after a per-test reset,
// clearTimeout() an unrelated timer of a later test.
let clockMocked = false;

afterAll(() => {
  nodeMock.timers.reset();
  clockMocked = false;
});

beforeEach(() => {
  if (!clockMocked) {
    nodeMock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    clockMocked = true;
  }
  const broadcast = wsEvents.broadcast;
  broadcastSpy = spyOn(wsEvents, 'broadcast').mockImplementation((event) => {
    broadcast(event);
    if (event.type !== 'persona_live_queue') return;
    const payload = event.payload as {
      conversation_id: string;
      snapshot: LiveQueueSnapshot;
    };
    if (payload.conversation_id === conversationId) {
      for (const listener of snapshotListeners) listener(payload.snapshot);
    }
  });
});

afterEach(async () => {
  try {
    await stopLiveQueue(conversationId);
  } finally {
    broadcastSpy.mockRestore();
    snapshotListeners.clear();
  }
});

describe('server-owned Live persona queue', () => {
  test('paces one lookahead and cancels it on stop while finishing current playback', async () => {
    await enableLiveQueue(conversationId, {
      sessionId: 'leader',
      userId: 'live-user',
      deviceId: 'device',
      platform: 'web',
    });
    await registerLiveQueueMessage({
      conversationId,
      messageId: 'b',
      participantId: 'B',
    });
    await markLiveQueueSpeechReady(conversationId, 'b', {
      id: 'asset-b',
      durationMs: 500,
    });
    let snapshot = (await getLiveQueueSnapshot(conversationId))!;
    expect(snapshot.current?.messageId).toBe('b');
    expect(snapshot.current?.state).toBe('released');

    const started = waitForLiveQueueStart(conversationId, 'b');
    const observerStart = await startLiveQueueItem({
      conversationId,
      itemId: snapshot.current!.id,
      runId: snapshot.runId,
      sessionId: 'leader',
      userId: 'observer-user',
      deviceId: 'observer-device',
    });
    expect(observerStart?.current?.state).toBe('playing');
    const duplicateStart = await startLiveQueueItem({
      conversationId,
      itemId: snapshot.current!.id,
      runId: snapshot.runId,
      sessionId: 'leader',
      userId: 'live-user',
      deviceId: 'device',
    });
    expect(duplicateStart).toBeNull();
    await started;
    await registerLiveQueueMessage({
      conversationId,
      messageId: 'm',
      participantId: 'M',
    });
    await markLiveQueueSpeechReady(conversationId, 'm', {
      id: 'asset-m',
      durationMs: 500,
    });
    snapshot = (await getLiveQueueSnapshot(conversationId))!;
    expect(snapshot.current?.messageId).toBe('b');
    expect(snapshot.current?.state).toBe('playing');
    expect(snapshot.hiddenMessageIds).toEqual(['m']);
    expect(snapshot.hiddenItems).toEqual([
      expect.objectContaining({
        messageId: 'm',
        participantId: 'M',
        state: 'ready',
      }),
    ]);
    expect(snapshot.cancelledMessageIds).toEqual([]);
    expect(snapshot.completedMessageIds).toEqual([]);

    const nextReleased = nextSnapshot(
      (next) =>
        next.current?.messageId === 'm' && next.current.state === 'released',
    );
    nodeMock.timers.tick(500);
    snapshot = await nextReleased;
    expect(snapshot.current?.messageId).toBe('m');
    expect(snapshot.current?.state).toBe('released');
    expect(snapshot.completedMessageIds).toContain('b');
    expect(snapshot.hiddenMessageIds).toEqual([]);

    await startLiveQueueItem({
      conversationId,
      itemId: snapshot.current!.id,
      runId: snapshot.runId,
      sessionId: 'leader',
      userId: 'live-user',
      deviceId: 'device',
    });
    await registerLiveQueueMessage({
      conversationId,
      messageId: 'a',
      participantId: 'A',
    });
    await markLiveQueueSpeechReady(conversationId, 'a', {
      id: 'asset-a',
      durationMs: 20,
    });
    await stopLiveQueue(conversationId);
    expect((await getLiveQueueSnapshot(conversationId))?.status).toBe(
      'stopping',
    );
    const finished = nextSnapshot((next) => next.status === 'off');
    nodeMock.timers.tick(500);
    const stopped = await finished;
    expect(stopped.status).toBe('off');
    expect(stopped.current).toBeNull();
    expect(stopped.cancelledMessageIds).toContain('a');
  });

  test('auto-starts a released item when every playback client misses it', async () => {
    await enableLiveQueue(conversationId, {
      sessionId: 'fallback-leader',
      userId: 'live-user',
      deviceId: 'device',
      platform: 'web',
    });
    await registerLiveQueueMessage({
      conversationId,
      messageId: 'fallback',
      participantId: 'B',
    });
    const started = waitForLiveQueueStart(conversationId, 'fallback');
    await markLiveQueueSpeechReady(conversationId, 'fallback', {
      id: 'asset-b',
      durationMs: 100,
    });
    const playing = nextSnapshot(
      (snapshot) =>
        snapshot.current?.messageId === 'fallback' &&
        snapshot.current.state === 'playing',
    );
    nodeMock.timers.tick(2_500);
    await started;
    await playing;
    expect((await getLiveQueueSnapshot(conversationId))?.current?.state).toBe(
      'playing',
    );
    await stopLiveQueue(conversationId);
    const stopped = nextSnapshot((snapshot) => snapshot.status === 'off');
    nodeMock.timers.tick(100);
    await stopped;
  });

  test('allows another authorized watcher to take an expired playback lease', async () => {
    await enableLiveQueue(conversationId, {
      sessionId: 'old-leader',
      userId: 'live-user',
      deviceId: 'old-device',
      platform: 'web',
    });
    await drizzleDbRef.current
      .update(conversationLiveRuns)
      .set({ leaseExpiresAt: new Date(0).toISOString() })
      .where(eq(conversationLiveRuns.conversationId, conversationId));
    const claimed = await renewLiveLease(conversationId, 'new-leader', {
      userId: 'live-user',
      deviceId: 'new-device',
      platform: 'android',
    });
    expect(claimed?.leaderSessionId).toBe('new-leader');
    expect(claimed?.status).toBe('active');
    await stopLiveQueue(conversationId);
  });

  test('lets a message bind only to a still-on run owned by its session', async () => {
    expect(await getBindableLiveRunMode(conversationId, 'stale')).toBeNull();
    await enableLiveQueue(conversationId, {
      sessionId: 'leader',
      mode: 'work',
      userId: 'live-user',
      deviceId: 'device',
      platform: 'web',
    });
    expect(await getBindableLiveRunMode(conversationId, 'leader')).toBe('work');
    expect(await getBindableLiveRunMode(conversationId, 'stale')).toBeNull();
    await drizzleDbRef.current
      .update(conversationLiveRuns)
      .set({ leaseExpiresAt: new Date(0).toISOString() })
      .where(eq(conversationLiveRuns.conversationId, conversationId));
    expect(await getBindableLiveRunMode(conversationId, 'stale')).toBe('work');
    await stopLiveQueue(conversationId);
    const stopped = await getLiveQueueSnapshot(conversationId);
    expect(stopped?.status).toBe('off');
    expect(await getBindableLiveRunMode(conversationId, 'leader')).toBeNull();
  });

  test('keeps Work Live Mode active without enrolling full persona replies in the speech queue', async () => {
    const snapshot = await enableLiveQueue(conversationId, {
      sessionId: 'work-leader',
      mode: 'work',
      userId: 'live-user',
      deviceId: 'work-device',
      platform: 'web',
    });
    expect(snapshot.mode).toBe('work');
    expect(
      await registerLiveQueueMessage({
        conversationId,
        messageId: 'work-message',
        participantId: 'M',
      }),
    ).toEqual({ accepted: false });
    expect((await getLiveQueueSnapshot(conversationId))?.current).toBeNull();
    await stopLiveQueue(conversationId);
  });
});
