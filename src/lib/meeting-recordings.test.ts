import { describe, expect, test } from 'bun:test';

import {
  MAX_SESSION_AGE_MS,
  appendChunk,
  createSession,
  deleteSession,
  evictStaleSessions,
  getSession,
  touchSession,
} from './meeting-recordings.js';

const MIN = 60_000;

function newSession() {
  return createSession({
    conversation_id: 'lib-test-conv',
    group_folder: 'p1',
    user_id: 'u1',
  });
}

function backdate(
  session: ReturnType<typeof newSession>,
  startedAgoMs: number,
  idleMs: number,
) {
  const now = Date.now();
  session.started_at = new Date(now - startedAgoMs);
  session.last_activity_at = now - idleMs;
}

describe('meeting recording session expiry', () => {
  test('long-running session with recent activity survives; idle or over-age sessions are evicted', () => {
    const active = newSession();
    backdate(active, 31 * MIN, 1 * MIN);
    const idle = newSession();
    backdate(idle, 31 * MIN, 31 * MIN);
    const tooOld = newSession();
    backdate(tooOld, MAX_SESSION_AGE_MS + MIN, 1 * MIN);

    expect(getSession(active.recording_id)).toBe(active);
    expect(getSession(idle.recording_id)).toBeNull();
    expect(getSession(tooOld.recording_id)).toBeNull();
    deleteSession(active.recording_id);
  });

  test('evictStaleSessions applies the same idle and age rules', () => {
    const active = newSession();
    backdate(active, 31 * MIN, 1 * MIN);
    const idle = newSession();
    backdate(idle, 31 * MIN, 31 * MIN);
    const tooOld = newSession();
    backdate(tooOld, MAX_SESSION_AGE_MS + MIN, 1 * MIN);

    evictStaleSessions();

    expect(getSession(active.recording_id)).toBe(active);
    expect(getSession(idle.recording_id)).toBeNull();
    expect(getSession(tooOld.recording_id)).toBeNull();
    deleteSession(active.recording_id);
  });

  test('appending a chunk or touching the session bumps last_activity_at', () => {
    const session = newSession();
    backdate(session, 20 * MIN, 20 * MIN);
    const before = session.last_activity_at;

    appendChunk(session.recording_id, Buffer.alloc(512));
    expect(session.last_activity_at).toBeGreaterThan(before);

    session.last_activity_at = before;
    touchSession(session.recording_id);
    expect(session.last_activity_at).toBeGreaterThan(before);
    deleteSession(session.recording_id);
  });
});
