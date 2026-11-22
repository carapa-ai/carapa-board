import { randomUUID } from 'crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  conversationLiveQueueItems,
  conversationLiveRuns,
} from '../../db/schema.js';
import { getConversation } from '../chat/db-chats.js';
import { broadcast } from '../objectives/ws-events.js';
import {
  getPersonaLiveOwner,
  setPersonaLiveSession,
  type LiveModeKind,
} from './playback-gate.js';
import { getPushTokensForUser } from '../../db.js';
import { sendPing } from '../push/fcm-sender.js';
import { logger } from '../../logger.js';
import type { PersonaLiveQueueSnapshot } from '../../types.js';
import {
  resolvePersonaSpeechSources,
  type PersonaSpeechInput,
} from '../tts/message-speech.js';

export type LiveQueueState =
  | 'generating'
  | 'synthesizing'
  | 'ready'
  | 'released'
  | 'playing'
  | 'completed'
  | 'failed'
  | 'cancelled';

const START_GRACE_MS = 15_000;
const AUTO_START_GRACE_MS = 2_500;
/** A device-speech item starts after the device fetched and synthesized it. */
const DEVICE_SPEECH_START_GRACE_MS = 20_000;
/** Upper bound for a device-reported clip length. */
const MAX_DEVICE_CLIP_MS = 15 * 60_000;
const LEASE_MS = 15_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const leaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const startWaiters = new Map<string, Set<() => void>>();
const androidWatchers = new Map<
  string,
  Map<string, { userId: string; expiresAt: number }>
>();
const WATCHER_TTL_MS = 30 * 60_000;

export function registerLiveQueueWatcher(
  conversationId: string,
  userId: string,
  deviceId: string,
): void {
  const watchers = androidWatchers.get(conversationId) ?? new Map();
  watchers.set(deviceId, { userId, expiresAt: Date.now() + WATCHER_TTL_MS });
  androidWatchers.set(conversationId, watchers);
}

export function unregisterLiveQueueWatcher(
  conversationId: string,
  deviceId: string,
): void {
  const watchers = androidWatchers.get(conversationId);
  watchers?.delete(deviceId);
  if (watchers?.size === 0) androidWatchers.delete(conversationId);
}

function scheduleLeaseExpiry(
  conversationId: string,
  runId: string,
  expiresAt: string,
): void {
  const previous = leaseTimers.get(conversationId);
  if (previous) clearTimeout(previous);
  leaseTimers.set(
    conversationId,
    setTimeout(
      () =>
        void (async () => {
          leaseTimers.delete(conversationId);
          const [run] = await drizzleDbRef.current
            .select()
            .from(conversationLiveRuns)
            .where(eq(conversationLiveRuns.conversationId, conversationId))
            .limit(1);
          if (
            !run ||
            run.runId !== runId ||
            run.leaseExpiresAt !== expiresAt ||
            run.status === 'off' ||
            run.status === 'stopping'
          )
            return;
          // Expiry permits another authorized device to take ownership in
          // renewLiveLease(); it must not pause a server-owned discussion. The
          // existing session remains usable for FCM and automatic queue pacing until
          // a takeover or explicit Stop replaces it.
          logger.debug(
            { conversationId, runId },
            'Live queue owner lease expired; run remains active',
          );
        })(),
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    ),
  );
}

async function notifyAndroidRelease(
  conversationId: string,
  messageId: string,
): Promise<void> {
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  if (!run?.leaderSessionId) return;
  try {
    // Every registered Android watcher mirrors playback. FCM is deliberately
    // not leader-only: observers must continue receiving queue items while
    // their WebView/socket is suspended. Native deduplication makes the FCM +
    // foreground-WebSocket race harmless. Only leader start ACKs pace the run.
    const now = Date.now();
    const watchers = androidWatchers.get(conversationId) ?? new Map();
    const targets = new Map<string, string>();
    for (const [deviceId, watcher] of watchers) {
      if (watcher.expiresAt <= now) watchers.delete(deviceId);
      else targets.set(deviceId, watcher.userId);
    }
    if (
      run.leaderPlatform === 'android' &&
      run.leaderUserId &&
      run.leaderDeviceId
    ) {
      targets.set(run.leaderDeviceId, run.leaderUserId);
    }
    const userIds = [...new Set(targets.values())];
    const ref = [conversationId, messageId, run.leaderSessionId]
      .map(encodeURIComponent)
      .join('|');
    await Promise.all(
      userIds.map(async (user_id) => {
        const tokens = (await getPushTokensForUser(user_id)).filter(
          (token) =>
            token.platform === 'android' && targets.has(token.device_id),
        );
        if (!tokens.length) return;
        await sendPing(tokens, ref, 'live_tts', { user_id });
      }),
    );
  } catch (error) {
    logger.warn(
      { error, conversationId, messageId },
      'failed to notify Android about released Live queue item',
    );
  }
}

function notifyStarted(conversationId: string, messageId: string): void {
  const key = `${conversationId}\0${messageId}`;
  for (const resolve of startWaiters.get(key) ?? []) resolve();
  startWaiters.delete(key);
}

function schedule(item: typeof conversationLiveQueueItems.$inferSelect): void {
  const previous = timers.get(item.conversationId);
  if (previous) clearTimeout(previous);
  if (!item.endsAt || item.state !== 'playing') return;
  const delay = Math.max(0, Date.parse(item.endsAt) - Date.now());
  const timer = setTimeout(
    () => void completeCurrent(item.conversationId, item.runId, item.id),
    delay,
  );
  timers.set(item.conversationId, timer);
}

function scheduleReleasedFallback(
  item: typeof conversationLiveQueueItems.$inferSelect,
): void {
  const previous = releaseTimers.get(item.conversationId);
  if (previous) clearTimeout(previous);
  if (item.state !== 'released') return;
  releaseTimers.set(
    item.conversationId,
    setTimeout(
      () =>
        void (async () => {
          releaseTimers.delete(item.conversationId);
          const [run] = await drizzleDbRef.current
            .select()
            .from(conversationLiveRuns)
            .where(eq(conversationLiveRuns.conversationId, item.conversationId))
            .limit(1);
          if (
            !run?.leaderSessionId ||
            run.runId !== item.runId ||
            run.status !== 'active'
          )
            return;
          logger.warn(
            {
              conversationId: item.conversationId,
              messageId: item.messageId,
              runId: item.runId,
            },
            'Live queue auto-starting released item after client grace',
          );
          await startLiveQueueItem({
            conversationId: item.conversationId,
            itemId: item.id,
            runId: item.runId,
            sessionId: run.leaderSessionId,
          });
        })(),
      item.assetId ? AUTO_START_GRACE_MS : DEVICE_SPEECH_START_GRACE_MS,
    ),
  );
}

export type LiveQueueSnapshot = PersonaLiveQueueSnapshot;

export async function getLiveQueueSnapshot(
  conversationId: string,
): Promise<LiveQueueSnapshot | null> {
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  if (!run) return null;
  const [current] = run.currentItemId
    ? await drizzleDbRef.current
        .select()
        .from(conversationLiveQueueItems)
        .where(eq(conversationLiveQueueItems.id, run.currentItemId))
        .limit(1)
    : [];
  let currentSource: PersonaSpeechInput | null = null;
  const hiddenItems = await drizzleDbRef.current
    .select({
      messageId: conversationLiveQueueItems.messageId,
      participantId: conversationLiveQueueItems.participantId,
      state: conversationLiveQueueItems.state,
      createdAt: conversationLiveQueueItems.createdAt,
    })
    .from(conversationLiveQueueItems)
    .where(
      and(
        eq(conversationLiveQueueItems.conversationId, conversationId),
        eq(conversationLiveQueueItems.runId, run.runId),
        inArray(conversationLiveQueueItems.state, [
          'generating',
          'synthesizing',
          'ready',
        ]),
      ),
    );
  const cancelledItems = await drizzleDbRef.current
    .select({ messageId: conversationLiveQueueItems.messageId })
    .from(conversationLiveQueueItems)
    .where(
      and(
        eq(conversationLiveQueueItems.conversationId, conversationId),
        eq(conversationLiveQueueItems.runId, run.runId),
        inArray(conversationLiveQueueItems.state, ['cancelled', 'failed']),
      ),
    );
  const completedItems = await drizzleDbRef.current
    .select({ messageId: conversationLiveQueueItems.messageId })
    .from(conversationLiveQueueItems)
    .where(
      and(
        eq(conversationLiveQueueItems.conversationId, conversationId),
        eq(conversationLiveQueueItems.runId, run.runId),
        eq(conversationLiveQueueItems.state, 'completed'),
      ),
    );
  const sourceMessageIds = [
    ...new Set([
      ...completedItems.map((item) => item.messageId),
      ...(current ? [current.messageId] : []),
      ...hiddenItems.map((item) => item.messageId),
    ]),
  ];
  const sources = await resolvePersonaSpeechSources(
    conversationId,
    sourceMessageIds,
    { includeMainAgent: true },
  );
  const completedSources = completedItems.map((item) => {
    const source = sources.get(item.messageId);
    return {
      messageId: item.messageId,
      participantId: source?.speakerId ?? '',
      text: source?.text ?? '',
      content: source?.displayContent ?? '',
      senderName: source?.senderName ?? '',
      createdAt: source?.createdAt ?? run.updatedAt,
      emote: source?.emote ?? null,
      telemetry: source?.telemetry ?? null,
    };
  });
  if (current) currentSource = sources.get(current.messageId) ?? null;
  const hiddenSources = hiddenItems.map((item) => {
    const source = sources.get(item.messageId);
    return {
      messageId: item.messageId,
      participantId: item.participantId,
      state: item.state as 'generating' | 'synthesizing' | 'ready',
      senderName: source?.senderName ?? '',
      createdAt: source?.createdAt ?? item.createdAt,
      emote: source?.emote ?? null,
      telemetry: source?.telemetry ?? null,
    };
  });
  const currentPlaybackVisible =
    current?.state === 'released' ||
    current?.state === 'playing' ||
    current?.state === 'completed';
  return {
    protocolVersion: 2,
    conversationId,
    runId: run.runId,
    epoch: run.epoch,
    mode: run.mode,
    revision: run.revision,
    status: run.status,
    serverNow: new Date().toISOString(),
    leaderSessionId: run.leaderSessionId ?? null,
    hiddenMessageIds: hiddenItems.map((item) => item.messageId),
    hiddenItems: hiddenSources,
    cancelledMessageIds: cancelledItems.map((item) => item.messageId),
    completedMessageIds: completedItems.map((item) => item.messageId),
    completedItems: completedSources,
    current: current
      ? {
          id: current.id,
          sequence: current.sequence,
          participantId: current.participantId,
          messageId: current.messageId,
          state: current.state,
          durationMs: current.durationMs ?? null,
          releasedAt: current.releasedAt ?? null,
          startedAt: current.startedAt ?? null,
          endsAt: current.endsAt ?? null,
          error: current.error ?? null,
          // Keep generation/synthesis payloads metadata-only. The browser
          // materializes the preparing owner from identity fields and only
          // receives response text once voice playback owns the row.
          text: currentPlaybackVisible ? (currentSource?.text ?? '') : '',
          content: currentPlaybackVisible
            ? (currentSource?.displayContent ?? '')
            : '',
          senderName: currentSource?.senderName ?? '',
          createdAt:
            currentSource?.createdAt ?? current.releasedAt ?? run.updatedAt,
          emote: currentSource?.emote ?? null,
          telemetry: currentSource?.telemetry ?? null,
        }
      : null,
  };
}

export async function listLiveQueueSnapshots(): Promise<
  Array<{ folder: string; snapshot: LiveQueueSnapshot }>
> {
  const runs = await drizzleDbRef.current
    .select({ conversationId: conversationLiveRuns.conversationId })
    .from(conversationLiveRuns)
    .where(
      inArray(conversationLiveRuns.status, ['active', 'paused', 'stopping']),
    );
  const result: Array<{ folder: string; snapshot: LiveQueueSnapshot }> = [];
  for (const run of runs) {
    const [conversation, snapshot] = await Promise.all([
      getConversation(run.conversationId),
      getLiveQueueSnapshot(run.conversationId),
    ]);
    if (conversation && snapshot)
      result.push({ folder: conversation.group_folder, snapshot });
  }
  return result;
}

export async function publishLiveQueue(conversationId: string): Promise<void> {
  const [snapshot, conversation] = await Promise.all([
    getLiveQueueSnapshot(conversationId),
    getConversation(conversationId),
  ]);
  if (!snapshot || !conversation) return;
  logger.info(
    {
      conversationId,
      runId: snapshot.runId,
      revision: snapshot.revision,
      status: snapshot.status,
      currentMessageId: snapshot.current?.messageId ?? null,
      currentState: snapshot.current?.state ?? null,
      hiddenMessageIds: snapshot.hiddenMessageIds,
      leaderSessionId: snapshot.leaderSessionId,
    },
    'Live queue snapshot published',
  );
  broadcast({
    type: 'persona_live_queue',
    payload: {
      folder: conversation.group_folder,
      conversation_id: conversationId,
      snapshot,
    },
  });
}

async function bump(
  conversationId: string,
  changes: Partial<typeof conversationLiveRuns.$inferInsert> = {},
) {
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  if (!run) return undefined;
  const [updated] = await drizzleDbRef.current
    .update(conversationLiveRuns)
    .set({
      ...changes,
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(conversationLiveRuns.conversationId, conversationId),
        eq(conversationLiveRuns.runId, run.runId),
      ),
    )
    .returning();
  return updated;
}

export async function enableLiveQueue(
  conversationId: string,
  owner: {
    sessionId: string;
    mode?: LiveModeKind;
    userId?: string;
    deviceId?: string;
    platform: 'web' | 'android' | 'ios';
    /** The device speaks replies with its own TTS; no Supertonic audio. */
    deviceSpeech?: boolean;
  },
): Promise<LiveQueueSnapshot> {
  const now = new Date().toISOString();
  const [existing] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  const mode = owner.mode ?? existing?.mode ?? 'personas';
  const continuing = Boolean(
    existing && existing.status !== 'off' && existing.mode === mode,
  );
  if (existing && existing.status !== 'off' && !continuing) {
    const liveOwner = getPersonaLiveOwner(conversationId);
    await stopLiveQueue(conversationId);
    if (liveOwner?.sessionId === owner.sessionId && liveOwner.mode === mode) {
      setPersonaLiveSession(conversationId, liveOwner.sessionId, liveOwner);
    }
    const timer = timers.get(conversationId);
    if (timer) clearTimeout(timer);
    timers.delete(conversationId);
    // Unlike a normal stop, a replacement cannot track the old playing item
    // until its timer finishes: the run row now belongs to the new mode.
    await drizzleDbRef.current
      .update(conversationLiveQueueItems)
      .set({ state: 'cancelled', updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(conversationLiveQueueItems.conversationId, conversationId),
          eq(conversationLiveQueueItems.runId, existing.runId),
          eq(conversationLiveQueueItems.state, 'playing'),
        ),
      );
  }
  const runId = continuing ? existing!.runId : randomUUID();
  const epoch = existing ? existing.epoch + (continuing ? 0 : 1) : 1;
  // Each Live message re-registers its leader without the speech setting;
  // keep what its Live Mode start and heartbeats reported, so a fast reply
  // is not synthesized by the server while waiting for the next heartbeat.
  const deviceSpeech =
    owner.deviceSpeech ??
    (continuing && existing!.leaderSessionId === owner.sessionId
      ? existing!.leaderDeviceSpeech === 1
      : false);
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  // A replacement advances twice: once in stopLiveQueue's bump and once here.
  await drizzleDbRef.current
    .insert(conversationLiveRuns)
    .values({
      conversationId,
      runId,
      epoch,
      mode,
      status: 'active',
      revision:
        (existing?.revision ?? 0) +
        (existing && existing.status !== 'off' && !continuing ? 2 : 1),
      nextSequence: continuing ? existing!.nextSequence : 1,
      currentItemId: continuing ? existing!.currentItemId : null,
      leaderUserId: owner.userId ?? null,
      leaderDeviceId: owner.deviceId ?? null,
      leaderSessionId: owner.sessionId,
      leaderPlatform: owner.platform,
      leaderDeviceSpeech: deviceSpeech ? 1 : 0,
      leaseToken,
      leaseExpiresAt,
      error: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: conversationLiveRuns.conversationId,
      set: {
        runId,
        epoch,
        mode,
        status: 'active',
        revision:
          (existing?.revision ?? 0) +
          (existing && existing.status !== 'off' && !continuing ? 2 : 1),
        nextSequence: continuing ? existing!.nextSequence : 1,
        currentItemId: continuing ? existing!.currentItemId : null,
        leaderUserId: owner.userId ?? null,
        leaderDeviceId: owner.deviceId ?? null,
        leaderSessionId: owner.sessionId,
        leaderPlatform: owner.platform,
        leaderDeviceSpeech: deviceSpeech ? 1 : 0,
        leaseToken,
        leaseExpiresAt,
        error: null,
        updatedAt: now,
      },
    });
  scheduleLeaseExpiry(conversationId, runId, leaseExpiresAt);
  await publishLiveQueue(conversationId);
  return (await getLiveQueueSnapshot(conversationId))!;
}

/**
 * Mode of the live run a message from `sessionId` may bind to, or null when
 * binding would have to create or re-open a run. Only an `active`/`paused` run
 * qualifies, and only for its current leader or once its lease has expired, so
 * a stale device cannot turn back on a run that another device stopped.
 */
export async function getBindableLiveRunMode(
  conversationId: string,
  sessionId: string,
): Promise<LiveModeKind | null> {
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  if (!run || (run.status !== 'active' && run.status !== 'paused')) return null;
  const expired =
    !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= Date.now();
  return run.leaderSessionId === sessionId || expired ? run.mode : null;
}

export async function renewLiveLease(
  conversationId: string,
  sessionId: string,
  owner?: {
    userId?: string;
    deviceId?: string;
    platform?: 'web' | 'android' | 'ios';
    deviceSpeech?: boolean;
  },
) {
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  if (!run || run.status === 'off') return null;
  const expired =
    !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= Date.now();
  if (run.leaderSessionId !== sessionId && !expired)
    return getLiveQueueSnapshot(conversationId);
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  await bump(conversationId, {
    leaseExpiresAt,
    status: run.status === 'paused' ? 'active' : run.status,
    // The leader may switch device speech on or off between heartbeats.
    ...(owner?.deviceSpeech !== undefined
      ? { leaderDeviceSpeech: owner.deviceSpeech ? 1 : 0 }
      : {}),
    ...(run.leaderSessionId !== sessionId
      ? {
          leaderSessionId: sessionId,
          leaderUserId: owner?.userId ?? null,
          leaderDeviceId: owner?.deviceId ?? null,
          leaderPlatform: owner?.platform ?? 'web',
          leaseToken: randomUUID(),
        }
      : {}),
  });
  if (run.leaderSessionId !== sessionId)
    setPersonaLiveSession(conversationId, sessionId, {
      ...owner,
      mode: run.mode,
    });
  scheduleLeaseExpiry(conversationId, run.runId, leaseExpiresAt);
  await publishLiveQueue(conversationId);
  return getLiveQueueSnapshot(conversationId);
}

export async function registerLiveQueueMessage(input: {
  conversationId: string;
  messageId: string;
  participantId: string;
}): Promise<{
  accepted: boolean;
  isCurrent?: boolean;
  runId?: string;
  epoch?: number;
}> {
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, input.conversationId))
    .limit(1);
  if (
    !run ||
    run.mode !== 'personas' ||
    !['active', 'paused', 'stopping'].includes(run.status)
  )
    return { accepted: false };
  if (run.status === 'stopping')
    return { accepted: false, runId: run.runId, epoch: run.epoch };
  const existing = await drizzleDbRef.current
    .select()
    .from(conversationLiveQueueItems)
    .where(
      and(
        eq(conversationLiveQueueItems.conversationId, input.conversationId),
        eq(conversationLiveQueueItems.messageId, input.messageId),
      ),
    )
    .limit(1);
  if (existing[0])
    return {
      accepted: true,
      isCurrent: run.currentItemId === existing[0].id,
      runId: run.runId,
      epoch: run.epoch,
    };
  const now = new Date().toISOString();
  const id = randomUUID();
  await drizzleDbRef.current.insert(conversationLiveQueueItems).values({
    id,
    conversationId: input.conversationId,
    runId: run.runId,
    epoch: run.epoch,
    sequence: run.nextSequence,
    participantId: input.participantId,
    messageId: input.messageId,
    state: 'synthesizing',
    createdAt: now,
    updatedAt: now,
  });
  await bump(input.conversationId, {
    nextSequence: run.nextSequence + 1,
    currentItemId: run.currentItemId ?? id,
  });
  await publishLiveQueue(input.conversationId);
  return {
    accepted: true,
    isCurrent: !run.currentItemId,
    runId: run.runId,
    epoch: run.epoch,
  };
}

/**
 * Whether the active persona run's leading device speaks replies itself, so
 * its queue items are released without Supertonic audio; the device reports
 * each clip's length when playback starts.
 */
export async function isDeviceSpeechRun(
  conversationId: string,
): Promise<boolean> {
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  return Boolean(
    run &&
    run.mode === 'personas' &&
    run.status !== 'off' &&
    run.leaderDeviceSpeech === 1,
  );
}

/** `asset` null: a device-speech item, released without server audio. */
export async function markLiveQueueSpeechReady(
  conversationId: string,
  messageId: string,
  asset: { id: string; durationMs: number } | null,
): Promise<void> {
  const [item] = await drizzleDbRef.current
    .select()
    .from(conversationLiveQueueItems)
    .where(
      and(
        eq(conversationLiveQueueItems.conversationId, conversationId),
        eq(conversationLiveQueueItems.messageId, messageId),
      ),
    )
    .limit(1);
  if (!item) return;
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  if (
    !run ||
    run.runId !== item.runId ||
    run.epoch !== item.epoch ||
    run.status === 'off' ||
    run.status === 'stopping'
  )
    return;
  const now = new Date().toISOString();
  const state: LiveQueueState =
    run.currentItemId === item.id ? 'released' : 'ready';
  // State-guarded so a late duplicate (the shared in-flight synthesis promise
  // has several waiters) or a completeCurrent reconcile can never overwrite an
  // already-released item back to 'ready'.
  const [updated] = await drizzleDbRef.current
    .update(conversationLiveQueueItems)
    .set({
      state,
      assetId: asset?.id ?? null,
      durationMs: asset?.durationMs ?? null,
      releasedAt: state === 'released' ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(conversationLiveQueueItems.id, item.id),
        inArray(conversationLiveQueueItems.state, [
          'synthesizing',
          'generating',
        ]),
      ),
    )
    .returning();
  if (!updated) return;
  await bump(conversationId);
  await publishLiveQueue(conversationId);
  if (state === 'released') {
    scheduleReleasedFallback({
      ...item,
      state,
      assetId: asset?.id ?? null,
      durationMs: asset?.durationMs ?? null,
      releasedAt: now,
      updatedAt: now,
    });
    void notifyAndroidRelease(conversationId, messageId);
  }
}

export async function failLiveQueueMessage(
  conversationId: string,
  messageId: string,
  error: string,
): Promise<void> {
  const [item] = await drizzleDbRef.current
    .update(conversationLiveQueueItems)
    .set({ state: 'failed', error, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(conversationLiveQueueItems.conversationId, conversationId),
        eq(conversationLiveQueueItems.messageId, messageId),
        inArray(conversationLiveQueueItems.state, [
          'generating',
          'synthesizing',
        ]),
      ),
    )
    .returning();
  notifyStarted(conversationId, messageId);
  if (!item) return;
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  if (!run || run.runId !== item.runId) return;
  if (run.currentItemId === item.id) {
    await completeCurrent(conversationId, item.runId, item.id);
  } else {
    await bump(conversationId);
    await publishLiveQueue(conversationId);
  }
}

export async function startLiveQueueItem(input: {
  conversationId: string;
  itemId: string;
  runId: string;
  sessionId: string;
  userId?: string;
  deviceId?: string;
  /** Clip length measured by the device; used when the item has none. */
  durationMs?: number;
}) {
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, input.conversationId))
    .limit(1);
  const [item] = await drizzleDbRef.current
    .select()
    .from(conversationLiveQueueItems)
    .where(eq(conversationLiveQueueItems.id, input.itemId))
    .limit(1);
  if (
    !run ||
    !item ||
    run.runId !== input.runId ||
    item.runId !== input.runId ||
    run.leaderSessionId !== input.sessionId ||
    item.state !== 'released'
  )
    return null;
  // Any authorized client carrying the active session may claim this unique
  // released item. The released-state predicate above makes the transition
  // idempotent: the first actual playback start wins and duplicates are no-ops.
  const startedAt = new Date();
  // Device-speech items have no server audio; their clip length comes from
  // the device's playback-start signal.
  const durationMs =
    item.durationMs ??
    (input.durationMs !== undefined &&
    Number.isFinite(input.durationMs) &&
    input.durationMs > 0
      ? Math.min(Math.round(input.durationMs), MAX_DEVICE_CLIP_MS)
      : 0);
  const endsAt = new Date(startedAt.getTime() + durationMs);
  const [startedItem] = await drizzleDbRef.current
    .update(conversationLiveQueueItems)
    .set({
      state: 'playing',
      durationMs,
      startedAt: startedAt.toISOString(),
      endsAt: endsAt.toISOString(),
      updatedAt: startedAt.toISOString(),
    })
    .where(
      and(
        eq(conversationLiveQueueItems.id, item.id),
        eq(conversationLiveQueueItems.state, 'released'),
      ),
    )
    .returning();
  if (!startedItem) return null;
  const releaseTimer = releaseTimers.get(input.conversationId);
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimers.delete(input.conversationId);
  const leaseExpiresAt = new Date(
    endsAt.getTime() + START_GRACE_MS,
  ).toISOString();
  await bump(input.conversationId, { leaseExpiresAt, status: 'active' });
  scheduleLeaseExpiry(input.conversationId, run.runId, leaseExpiresAt);
  const playing = { ...startedItem, state: 'playing' as const };
  schedule(playing);
  notifyStarted(input.conversationId, item.messageId);
  await publishLiveQueue(input.conversationId);
  return getLiveQueueSnapshot(input.conversationId);
}

export async function startLiveQueueMessage(
  conversationId: string,
  messageId: string,
  sessionId: string,
  owner?: { userId?: string; deviceId?: string; durationMs?: number },
) {
  const [item] = await drizzleDbRef.current
    .select()
    .from(conversationLiveQueueItems)
    .where(
      and(
        eq(conversationLiveQueueItems.conversationId, conversationId),
        eq(conversationLiveQueueItems.messageId, messageId),
      ),
    )
    .limit(1);
  if (!item) return null;
  return startLiveQueueItem({
    conversationId,
    itemId: item.id,
    runId: item.runId,
    sessionId,
    ...owner,
  });
}

async function completeCurrent(
  conversationId: string,
  runId: string,
  itemId: string,
): Promise<void> {
  timers.delete(conversationId);
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  if (!run || run.runId !== runId || run.currentItemId !== itemId) return;
  const now = new Date().toISOString();
  await drizzleDbRef.current
    .update(conversationLiveQueueItems)
    .set({ state: 'completed', updatedAt: now })
    .where(
      and(
        eq(conversationLiveQueueItems.id, itemId),
        eq(conversationLiveQueueItems.state, 'playing'),
      ),
    );
  if (run.status === 'stopping') {
    const leaseTimer = leaseTimers.get(conversationId);
    if (leaseTimer) clearTimeout(leaseTimer);
    leaseTimers.delete(conversationId);
    await bump(conversationId, {
      status: 'off',
      currentItemId: null,
      leaderSessionId: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    setPersonaLiveSession(conversationId, null);
    androidWatchers.delete(conversationId);
  } else {
    const [next] = await drizzleDbRef.current
      .select()
      .from(conversationLiveQueueItems)
      .where(
        and(
          eq(conversationLiveQueueItems.conversationId, conversationId),
          eq(conversationLiveQueueItems.runId, runId),
          inArray(conversationLiveQueueItems.state, [
            'ready',
            'synthesizing',
            'generating',
          ]),
        ),
      )
      .orderBy(asc(conversationLiveQueueItems.sequence))
      .limit(1);
    // Advance the talking stick first. markLiveQueueSpeechReady marks an
    // item 'released' only when it is already current and 'ready' otherwise;
    // releasing before the bump would leave the new current item stuck in
    // 'ready' with nothing left to release it.
    await bump(conversationId, { currentItemId: next?.id ?? null });
    await reconcileCurrentLiveQueueItem(conversationId, runId);
  }
  await publishLiveQueue(conversationId);
}

/**
 * Repair the talking-stick transition after completeCurrent's bump.
 *
 * Two races can leave the run stalled otherwise: a speech-ready that landed
 * between the pending-item query and the bump wrote 'ready' (it was not
 * current yet) and is now the current item — nothing else releases a current
 * 'ready' item; and a registration that landed in the same window was
 * overwritten by the bump's null currentItemId. Re-read the run and release
 * or adopt accordingly. The 'ready' transition is state-guarded so a
 * concurrent markLiveQueueSpeechReady can never clobber it back.
 */
async function reconcileCurrentLiveQueueItem(
  conversationId: string,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [run] = await drizzleDbRef.current
      .select()
      .from(conversationLiveRuns)
      .where(eq(conversationLiveRuns.conversationId, conversationId))
      .limit(1);
    if (
      !run ||
      run.runId !== runId ||
      run.status === 'off' ||
      run.status === 'stopping'
    )
      return;
    if (!run.currentItemId) {
      const [pending] = await drizzleDbRef.current
        .select()
        .from(conversationLiveQueueItems)
        .where(
          and(
            eq(conversationLiveQueueItems.conversationId, conversationId),
            eq(conversationLiveQueueItems.runId, runId),
            inArray(conversationLiveQueueItems.state, [
              'ready',
              'synthesizing',
              'generating',
            ]),
          ),
        )
        .orderBy(asc(conversationLiveQueueItems.sequence))
        .limit(1);
      if (!pending) return;
      await bump(conversationId, { currentItemId: pending.id });
      continue;
    }
    const [current] = await drizzleDbRef.current
      .select()
      .from(conversationLiveQueueItems)
      .where(eq(conversationLiveQueueItems.id, run.currentItemId))
      .limit(1);
    if (!current || current.runId !== runId) return;
    if (current.state !== 'ready') return;
    const now = new Date().toISOString();
    const [released] = await drizzleDbRef.current
      .update(conversationLiveQueueItems)
      .set({ state: 'released', releasedAt: now, updatedAt: now })
      .where(
        and(
          eq(conversationLiveQueueItems.id, current.id),
          eq(conversationLiveQueueItems.state, 'ready'),
        ),
      )
      .returning();
    if (!released) return;
    await bump(conversationId);
    scheduleReleasedFallback(released);
    void notifyAndroidRelease(conversationId, current.messageId);
    return;
  }
}

export async function waitForLiveQueueStart(
  conversationId: string,
  messageId: string,
): Promise<void> {
  const [[run], [item]] = await Promise.all([
    drizzleDbRef.current
      .select()
      .from(conversationLiveRuns)
      .where(eq(conversationLiveRuns.conversationId, conversationId))
      .limit(1),
    drizzleDbRef.current
      .select()
      .from(conversationLiveQueueItems)
      .where(
        and(
          eq(conversationLiveQueueItems.conversationId, conversationId),
          eq(conversationLiveQueueItems.messageId, messageId),
        ),
      )
      .limit(1),
  ]);
  if (
    !run ||
    run.status === 'off' ||
    (item &&
      ['playing', 'completed', 'cancelled', 'failed'].includes(item.state))
  )
    return;
  const key = `${conversationId}\0${messageId}`;
  const waiting = new Promise<void>((resolve) => {
    const waiters = startWaiters.get(key) ?? new Set();
    waiters.add(resolve);
    startWaiters.set(key, waiters);
  });
  // A start, failure or stop may have landed while the initial reads ran.
  const [[latestRun], [latestItem]] = await Promise.all([
    drizzleDbRef.current
      .select()
      .from(conversationLiveRuns)
      .where(eq(conversationLiveRuns.conversationId, conversationId))
      .limit(1),
    drizzleDbRef.current
      .select()
      .from(conversationLiveQueueItems)
      .where(
        and(
          eq(conversationLiveQueueItems.conversationId, conversationId),
          eq(conversationLiveQueueItems.messageId, messageId),
        ),
      )
      .limit(1),
  ]);
  if (
    !latestRun ||
    latestRun.status === 'off' ||
    latestRun.runId !== run.runId ||
    (latestItem &&
      ['playing', 'completed', 'cancelled', 'failed'].includes(
        latestItem.state,
      ))
  ) {
    notifyStarted(conversationId, messageId);
  }
  await waiting;
}

export async function stopLiveQueue(conversationId: string): Promise<void> {
  const [run] = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(eq(conversationLiveRuns.conversationId, conversationId))
    .limit(1);
  if (!run || run.status === 'off') return;
  const releaseTimer = releaseTimers.get(conversationId);
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimers.delete(conversationId);
  for (const [key, waiters] of [...startWaiters]) {
    if (!key.startsWith(`${conversationId}\0`)) continue;
    startWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }
  const leaseTimer = leaseTimers.get(conversationId);
  if (leaseTimer) clearTimeout(leaseTimer);
  leaseTimers.delete(conversationId);
  const items = await drizzleDbRef.current
    .select()
    .from(conversationLiveQueueItems)
    .where(
      and(
        eq(conversationLiveQueueItems.conversationId, conversationId),
        eq(conversationLiveQueueItems.runId, run.runId),
      ),
    );
  const current = items.find((item) => item.id === run.currentItemId);
  await drizzleDbRef.current
    .update(conversationLiveQueueItems)
    .set({ state: 'cancelled', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(conversationLiveQueueItems.conversationId, conversationId),
        eq(conversationLiveQueueItems.runId, run.runId),
        inArray(conversationLiveQueueItems.state, [
          'generating',
          'synthesizing',
          'ready',
          'released',
        ]),
      ),
    );
  for (const item of items)
    if (item.id !== current?.id) notifyStarted(conversationId, item.messageId);
  if (current?.state === 'playing')
    await bump(conversationId, { status: 'stopping' });
  else {
    if (current) notifyStarted(conversationId, current.messageId);
    await bump(conversationId, {
      status: 'off',
      currentItemId: null,
      leaderSessionId: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    setPersonaLiveSession(conversationId, null);
    androidWatchers.delete(conversationId);
  }
  await publishLiveQueue(conversationId);
}

export async function recoverLiveQueues(): Promise<void> {
  const runs = await drizzleDbRef.current
    .select()
    .from(conversationLiveRuns)
    .where(
      inArray(conversationLiveRuns.status, ['active', 'paused', 'stopping']),
    );
  for (const run of runs) {
    if (run.leaderSessionId)
      setPersonaLiveSession(run.conversationId, run.leaderSessionId, {
        mode: run.mode,
        userId: run.leaderUserId ?? undefined,
        deviceId: run.leaderDeviceId ?? undefined,
        platform: run.leaderPlatform ?? undefined,
      });
    if (run.leaseExpiresAt && run.status !== 'stopping')
      scheduleLeaseExpiry(run.conversationId, run.runId, run.leaseExpiresAt);
    if (!run.currentItemId) continue;
    const [item] = await drizzleDbRef.current
      .select()
      .from(conversationLiveQueueItems)
      .where(eq(conversationLiveQueueItems.id, run.currentItemId))
      .limit(1);
    if (!item) continue;
    if (item.state === 'playing') schedule(item);
    else if (item.state === 'released') scheduleReleasedFallback(item);
    else if (item.state === 'synthesizing') {
      const { ensurePersonaMessageSpeech, resolvePersonaSpeechSource } =
        await import('../tts/message-speech.js');
      const source = await resolvePersonaSpeechSource(
        run.conversationId,
        item.messageId,
        { includeMainAgent: true },
      );
      if (source && run.leaderDeviceSpeech === 1) {
        await markLiveQueueSpeechReady(
          run.conversationId,
          item.messageId,
          null,
        );
      } else if (source) {
        try {
          const asset = await ensurePersonaMessageSpeech(source);
          if (!asset) throw new Error('TTS asset was not persisted');
          await markLiveQueueSpeechReady(
            run.conversationId,
            item.messageId,
            asset,
          );
        } catch (error) {
          await failLiveQueueMessage(
            run.conversationId,
            item.messageId,
            error instanceof Error ? error.message : 'Speech recovery failed',
          );
        }
      } else {
        await bump(run.conversationId, {
          status: 'paused',
          error: 'The interrupted Live response could not be recovered.',
        });
      }
    } else if (item.state === 'generating')
      await bump(run.conversationId, {
        status: 'paused',
        error: 'Live response generation was interrupted by a server restart.',
      });
  }
}
