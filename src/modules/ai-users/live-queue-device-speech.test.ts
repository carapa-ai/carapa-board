import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { initDatabase } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  conversationLiveQueueItems,
  conversations,
  projects,
  users,
} from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  enableLiveQueue,
  isDeviceSpeechRun,
  markLiveQueueSpeechReady,
  registerLiveQueueMessage,
  renewLiveLease,
  startLiveQueueMessage,
  stopLiveQueue,
} from './live-queue.js';

const conversationId = 'live-device-speech-conversation';
const sessionId = 'tablet-session';

beforeAll(async () => {
  await initDatabase(':memory:');
  const now = new Date().toISOString();
  await drizzleDbRef.current.insert(users).values({
    id: 'device-speech-user',
    username: 'device-speech-user',
    password_hash: 'x',
    role: 'user',
    created_at: now,
  });
  await drizzleDbRef.current.insert(projects).values({
    id: 'device-speech-project',
    jid: 'device-speech@web',
    name: 'Device speech',
    folder: 'device-speech-project',
    trigger: '@',
    added_at: now,
    user_id: 'device-speech-user',
  });
  await drizzleDbRef.current.insert(conversations).values({
    id: conversationId,
    group_folder: 'device-speech-project',
    created_at: now,
  });
});

afterAll(() => stopLiveQueue(conversationId));

describe('Live queue for a device that speaks replies itself', () => {
  test('releases replies without server audio and times them by the device clip', async () => {
    await enableLiveQueue(conversationId, {
      sessionId,
      mode: 'personas',
      userId: 'device-speech-user',
      deviceId: 'tablet',
      platform: 'android',
      deviceSpeech: true,
    });
    // Each Live message re-registers the leader without its speech setting.
    await enableLiveQueue(conversationId, {
      sessionId,
      mode: 'personas',
      userId: 'device-speech-user',
      deviceId: 'tablet',
      platform: 'android',
    });
    expect(await isDeviceSpeechRun(conversationId)).toBe(true);

    await registerLiveQueueMessage({
      conversationId,
      messageId: 'reply-1',
      participantId: 'persona',
    });
    await markLiveQueueSpeechReady(conversationId, 'reply-1', null);
    const [released] = await drizzleDbRef.current
      .select()
      .from(conversationLiveQueueItems)
      .where(eq(conversationLiveQueueItems.messageId, 'reply-1'));
    expect(released).toMatchObject({
      state: 'released',
      assetId: null,
      durationMs: null,
    });

    await startLiveQueueMessage(conversationId, 'reply-1', sessionId, {
      durationMs: 60_000,
    });
    const [playing] = await drizzleDbRef.current
      .select()
      .from(conversationLiveQueueItems)
      .where(eq(conversationLiveQueueItems.messageId, 'reply-1'));
    expect(playing!.state).toBe('playing');
    expect(playing!.durationMs).toBe(60_000);
    expect(Date.parse(playing!.endsAt!) - Date.parse(playing!.startedAt!)).toBe(
      60_000,
    );
  });

  test('the leader can switch device speech off with its heartbeat', async () => {
    await renewLiveLease(conversationId, sessionId, {
      platform: 'android',
      deviceSpeech: false,
    });
    expect(await isDeviceSpeechRun(conversationId)).toBe(false);
  });
});
