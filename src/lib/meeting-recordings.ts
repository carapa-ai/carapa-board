/**
 * In-memory store for active meeting recording sessions.
 *
 * All MediaRecorder chunks are kept in order. Transcription advances a
 * time offset (`transcribed_through_sec`) so each Whisper call only covers
 * new audio — see meeting-audio.ts extractWavSegment.
 */

import { randomUUID } from 'crypto';
import {
  createAudioSpool,
  removeAudioSpool,
  type AudioSpool,
} from './meeting-audio.js';
import { joinTranscriptParts } from './meeting-transcript.js';
import { logger } from '../logger.js';

/** Target window size for each Whisper call (seconds). */
export const FLUSH_INTERVAL_SEC = 5;

/** Flush check interval while chunks arrive (ms). */
const FLUSH_INTERVAL_MS = FLUSH_INTERVAL_SEC * 1_000;

/** A session with no chunk or transcript text for this long is evicted. */
const IDLE_TTL_MS = 30 * 60 * 1000;
/** Absolute session age cap; bounds the in-memory `all_chunks` audio buffer. */
export const MAX_SESSION_AGE_MS = 4 * 60 * 60 * 1000;
const CHUNK_RATE_LIMIT_MS = 1_000;
const MIN_CHUNK_BYTES = 256;

export interface RecordingSession {
  recording_id: string;
  conversation_id: string;
  group_folder: string;
  user_id: string;
  started_at: Date;
  /** Epoch ms of the last accepted chunk or transcript text (or creation). */
  last_activity_at: number;
  mime_type: string;
  all_chunks: Buffer[];
  transcript_parts: string[];
  /** How many seconds of audio have already been sent to Whisper. */
  transcribed_through_sec: number;
  last_flush_at: number;
  lastChunkAt?: number;
  /** ISO-639-1 language hint for Whisper, or null / auto for detection. */
  language: string | null;
  /** Resolved board_agents id for native-audio listening (e.g. llm:gemma4-12b). */
  listen_agent_id: string | null;
  /** On-disk copy of `all_chunks` that ffmpeg/ffprobe read; see meeting-audio.ts. */
  audio_spool: AudioSpool;
  /** Tail of the session's transcription work; null when none is in flight. */
  transcription: Promise<void> | null;
  /** Set once the session leaves the store, so late work cleans up after itself. */
  closed: boolean;
}

const sessions = new Map<string, RecordingSession>();

const EVICTION_SWEEP_MS = 60 * 1000;
let evictionTimer: ReturnType<typeof setInterval> | null = null;

export function normalizeMimeType(mime: string | undefined): string {
  if (!mime) return 'audio/webm';
  const base = mime.split(';')[0]?.trim().toLowerCase() || 'audio/webm';
  if (base.startsWith('audio/')) return base;
  return 'audio/webm';
}

export function createSession(params: {
  conversation_id: string;
  group_folder: string;
  user_id: string;
  language?: string | null;
  listen_agent_id?: string | null;
}): RecordingSession {
  const now = Date.now();
  const session: RecordingSession = {
    recording_id: randomUUID(),
    conversation_id: params.conversation_id,
    group_folder: params.group_folder,
    user_id: params.user_id,
    started_at: new Date(now),
    last_activity_at: now,
    mime_type: 'audio/webm',
    all_chunks: [],
    transcript_parts: [],
    transcribed_through_sec: 0,
    last_flush_at: now,
    language: params.language?.trim() || null,
    listen_agent_id: params.listen_agent_id ?? null,
    audio_spool: createAudioSpool(),
    transcription: null,
    closed: false,
  };
  sessions.set(session.recording_id, session);
  if (!evictionTimer) {
    evictionTimer = setInterval(evictStaleSessions, EVICTION_SWEEP_MS);
    evictionTimer.unref();
  }
  logger.info(
    {
      recording_id: session.recording_id,
      conversation_id: params.conversation_id,
    },
    'Meeting recording session created',
  );
  return session;
}

/** Remove a session from the store and release its temp audio. */
function discardSession(recordingId: string, session: RecordingSession): void {
  sessions.delete(recordingId);
  session.closed = true;
  void removeAudioSpool(session.audio_spool);
}

function isExpired(session: RecordingSession, now: number): boolean {
  return (
    now - session.last_activity_at > IDLE_TTL_MS ||
    now - session.started_at.getTime() > MAX_SESSION_AGE_MS
  );
}

/** Record client activity so an ongoing meeting is not evicted as idle. */
export function touchSession(recordingId: string): void {
  const session = sessions.get(recordingId);
  if (session) session.last_activity_at = Date.now();
}

export function getSession(recordingId: string): RecordingSession | null {
  const session = sessions.get(recordingId);
  if (!session) return null;

  if (isExpired(session, Date.now())) {
    discardSession(recordingId, session);
    logger.warn(
      { recording_id: recordingId },
      'Meeting recording session evicted (stale)',
    );
    return null;
  }

  return session;
}

export function isRateLimited(recordingId: string): boolean {
  const session = sessions.get(recordingId);
  if (!session) return false;

  const lastChunkAt = session.lastChunkAt;
  if (lastChunkAt && Date.now() - lastChunkAt < CHUNK_RATE_LIMIT_MS) {
    return true;
  }
  session.lastChunkAt = Date.now();
  return false;
}

/**
 * Append a chunk. Returns `shouldFlush` when it's time to transcribe the next
 * window of *new* audio (if enough has accumulated since `transcribed_through_sec`).
 */
export function appendChunk(
  recordingId: string,
  chunk: Buffer,
  mimeType?: string,
): { session: RecordingSession; shouldFlush: boolean } | null {
  const session = sessions.get(recordingId);
  if (!session) return null;

  session.last_activity_at = Date.now();

  if (mimeType) {
    session.mime_type = normalizeMimeType(mimeType);
  }

  if (chunk.length < MIN_CHUNK_BYTES) {
    return null;
  }

  session.all_chunks.push(chunk);

  const elapsed = Date.now() - session.last_flush_at;
  if (elapsed >= FLUSH_INTERVAL_MS) {
    session.last_flush_at = Date.now();
    return { session, shouldFlush: true };
  }

  return null;
}

export function getFullTranscript(session: RecordingSession): string {
  return joinTranscriptParts(...session.transcript_parts);
}

export function finalizeSession(recordingId: string): {
  session: RecordingSession;
  fullTranscript: string;
} | null {
  const session = sessions.get(recordingId);
  if (!session) return null;

  return { session, fullTranscript: getFullTranscript(session) };
}

export function deleteSession(recordingId: string): boolean {
  const session = sessions.get(recordingId);
  if (!session) return false;
  discardSession(recordingId, session);
  return true;
}

export function evictStaleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (isExpired(session, now)) {
      discardSession(id, session);
      logger.info({ recording_id: id }, 'Evicted stale recording session');
    }
  }
  if (sessions.size === 0 && evictionTimer) {
    clearInterval(evictionTimer);
    evictionTimer = null;
  }
}
