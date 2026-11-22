/**
 * Meeting recording endpoints — real-time audio streaming with transcription
 * (Whisper or native-audio LLM when the conversation agent supports it).
 *
 * Endpoints live under /api/projects/:pid/meetings/…
 */
import multer, { MulterError } from 'multer';
import { Router, type RequestHandler } from 'express';
import {
  createSession,
  evictStaleSessions,
  getSession,
  isRateLimited,
  appendChunk,
  finalizeSession,
  deleteSession,
  normalizeMimeType,
  getFullTranscript,
  touchSession,
  FLUSH_INTERVAL_SEC,
} from '../lib/meeting-recordings.js';
import {
  buildFullRecordingBlob,
  convertAudioToWav,
  probeAudioDurationSec,
  extractWavSegment,
  syncAudioSpool,
  removeAudioSpool,
} from '../lib/meeting-audio.js';
import {
  isDuplicateTranscriptPart,
  meetingWhisperLanguage,
  mergeMeetingTranscripts,
  sanitizeMeetingTranscriptChunk,
} from '../lib/meeting-transcript.js';
import { getTranscriber } from '../modules/whisper/index.js';
import { WHISPER_LANGUAGE, WHISPER_PROMPT } from '../modules/whisper/config.js';
import { MEETING_LANGUAGES } from '../config.js';
import {
  getMeetingLanguage,
  type MeetingLanguageScript,
} from '../lib/meeting-languages.js';
import type { RecordingSession } from '../lib/meeting-recordings.js';
import {
  getDefaultRuntimeSelection,
  isDirectRuntime,
  resolveAgentReference,
  resolveRuntimeSelection,
} from '../lib/chat-agents.js';
import { transcribeAudioWithAgent } from '../lib/transcribe-audio-llm.js';
import type { ChatAgentOption } from '../lib/chat-agents.js';

function whisperOptionsForSession(session: RecordingSession) {
  const opt = getMeetingLanguage(MEETING_LANGUAGES, session.language);
  return {
    language: meetingWhisperLanguage(session.language, WHISPER_LANGUAGE),
    prompt: opt?.prompt || WHISPER_PROMPT || undefined,
  };
}

function scriptForSession(
  session: RecordingSession,
): MeetingLanguageScript | 'auto' {
  const lang = session.language?.trim().toLowerCase();
  if (!lang || lang === 'auto') return 'auto';
  return getMeetingLanguage(MEETING_LANGUAGES, lang)?.script ?? 'latin';
}
import { writeArtifactFile } from '../modules/chat/artifacts.js';
import {
  broadcast,
  broadcastWithAccess,
  type UserAccess,
  type WsEvent,
} from '../modules/objectives/ws-events.js';
import { getGroupByFolder } from '../state-manager.js';
import { getConversation } from '../db.js';
import { canReceiveRecordingTranscript } from '../modules/knowledge/db-kb.js';
import { logger } from '../logger.js';
import { isRecord } from '../lib/type-guards.js';
import { adminBypassesProject } from '../lib/project-ownership.js';
import {
  canAccessProject,
  canEditProjectLocalFiles,
  requireConversationAccess,
} from './_helpers.js';

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

const audioStorage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHUNK_BYTES, files: 1 },
});

/** Parse the `audio` part, answering 413 when a chunk exceeds the upload limits. */
const uploadChunkAudio: RequestHandler = (req, res, next) => {
  audioStorage.single('audio')(req, res, (err: unknown) => {
    if (
      err instanceof MulterError &&
      (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT')
    ) {
      return res.status(413).json({ error: 'Audio chunk too large' });
    }
    next(err);
  });
};

const router = Router();

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  };
  return map[mime] ?? 'webm';
}

/** Minimum new audio (seconds) worth transcribing. */
const MIN_TRANSCRIBE_SEC = 0.5;

const MIN_WAV_BYTES = 1024;

function listenAgentConfig(
  session: RecordingSession,
): ChatAgentOption | undefined {
  if (!session.listen_agent_id) return undefined;
  const cfg = resolveAgentReference(session.listen_agent_id);
  // Live transcription calls the model's API directly; an audio-capable CLI
  // harness (which hears a file it opens) cannot serve it.
  return cfg?.audio && isDirectRuntime(cfg) ? cfg : undefined;
}

function appendTranscriptPart(
  session: RecordingSession,
  transcript: string,
): string {
  const last = session.transcript_parts[session.transcript_parts.length - 1];
  if (!last || !isDuplicateTranscriptPart(last, transcript)) {
    session.transcript_parts.push(transcript);
  }
  return getFullTranscript(session);
}

/**
 * Whether the project the recording started in still exists under its folder
 * name and the recording's conversation still belongs to it. A rename, a
 * delete or a reused folder name breaks the binding, and the session's stored
 * folder then names a different (or no) project.
 */
async function isRecordingBoundToProject(
  session: Pick<RecordingSession, 'conversation_id' | 'group_folder'>,
): Promise<boolean> {
  if (!getGroupByFolder(session.group_folder)) return false;
  const conv = await getConversation(session.conversation_id);
  return conv?.group_folder === session.group_folder;
}

async function authorizeRecordingSession(
  req: any,
  res: any,
  session: RecordingSession,
): Promise<boolean> {
  if (!req.authUser?.id) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (
    req.params.pid !== session.group_folder ||
    !(await isRecordingBoundToProject(session))
  ) {
    res.status(404).json({ error: 'Recording session not found' });
    return false;
  }
  const isOwnSession = req.authUser.id === session.user_id;
  if (
    !adminBypassesProject(req.authUser, session.group_folder) &&
    !(
      isOwnSession &&
      (await canAccessProject(req.authUser, session.group_folder, {
        min: 'viewer',
        implicit: true,
      }))
    )
  ) {
    res.status(403).json({ error: 'Access denied to this recording' });
    return false;
  }
  return true;
}

async function transcribeSegmentBuffer(
  session: RecordingSession,
  wav: Buffer,
): Promise<string> {
  const llmAgent = listenAgentConfig(session);
  if (llmAgent) {
    try {
      return (
        await transcribeAudioWithAgent(wav, 'audio/wav', llmAgent)
      ).trim();
    } catch (err) {
      logger.warn(
        { err, recording_id: session.recording_id, agentId: llmAgent.id },
        'LLM meeting transcription failed — falling back to Whisper',
      );
    }
  }

  const transcriber = getTranscriber();
  if (!transcriber) return '';
  return (
    await transcriber(
      wav,
      'audio/wav',
      `segment-${Date.now()}.wav`,
      whisperOptionsForSession(session),
    )
  ).trim();
}

/**
 * Run `work` after any transcription already queued for the session, so at most
 * one runs at a time and no audio window is transcribed twice.
 */
function enqueueTranscription<T>(
  session: RecordingSession,
  work: () => Promise<T>,
): Promise<T> {
  const run = (session.transcription ?? Promise.resolve()).then(work);
  const tail: Promise<void> = run
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      if (session.transcription === tail) session.transcription = null;
    });
  session.transcription = tail;
  return run;
}

/**
 * Transcribe the next window of *new* audio from the growing recording
 * (everything not yet transcribed when `drain` is set, e.g. on stop).
 * Advances `transcribed_through_sec` so later windows never repeat earlier speech.
 * Callers must go through `enqueueTranscription`.
 */
async function transcribeNextAudio(
  session: RecordingSession,
  drain = false,
): Promise<string | null> {
  if (session.all_chunks.length === 0) return null;

  const llmAgent = listenAgentConfig(session);
  const transcriber = getTranscriber();
  if (!llmAgent && !transcriber) return null;

  const ext = extFromMime(session.mime_type);
  try {
    const audioPath = await syncAudioSpool(
      session.audio_spool,
      session.all_chunks,
      ext,
    );
    if (!audioPath) return null;

    const totalSec = await probeAudioDurationSec(audioPath);
    if (!totalSec) return null;

    const startSec = session.transcribed_through_sec;
    const remainingSec = totalSec - startSec;
    if (remainingSec < MIN_TRANSCRIBE_SEC) return null;

    const durationSec = drain
      ? remainingSec
      : Math.min(FLUSH_INTERVAL_SEC, remainingSec);
    const wav = await extractWavSegment(audioPath, startSec, durationSec);
    if (!wav || wav.length < MIN_WAV_BYTES) return null;

    try {
      const priorContext = getFullTranscript(session);
      const raw = await transcribeSegmentBuffer(session, wav);
      const transcript = sanitizeMeetingTranscriptChunk(
        raw,
        priorContext,
        scriptForSession(session),
      );
      session.transcribed_through_sec = startSec + durationSec;
      if (transcript) return appendTranscriptPart(session, transcript);
    } catch (err) {
      logger.error(
        {
          err,
          recording_id: session.recording_id,
          startSec,
          durationSec,
        },
        'Meeting audio transcription failed for segment — skipping',
      );
    }

    return null;
  } finally {
    // The session was deleted while this ran; do not leave the spool behind.
    if (session.closed) await removeAudioSpool(session.audio_spool);
  }
}

/**
 * The live transcript event, scoped to the recording's project so the common
 * project filter delivers it only to users who can see that project (or the
 * recording's shared conversation). Null when there is no text yet.
 */
export function meetingTranscriptEvent(
  session: RecordingSession,
  final = false,
  transcript?: string,
): WsEvent | null {
  const partialTranscript = transcript ?? getFullTranscript(session);
  if (!partialTranscript) return null;
  return {
    type: 'meeting_transcript',
    payload: {
      recording_id: session.recording_id,
      conversation_id: session.conversation_id,
      project_id: session.group_folder,
      partial_transcript: partialTranscript,
      final,
    },
  };
}

/**
 * The recipient's access to this recording as one delivery-time decision
 * (`canReceiveRecordingTranscript`, a single database snapshot that also binds
 * the recording's original conversation to its original project), expressed as
 * the view the common project filter reads. Neither the 30-second socket cache
 * nor the project registry is consulted, so a stale admin flag, a deleted
 * project's grants or a reused folder name cannot widen delivery. The view is
 * deliberately non-admin: the decision already includes the admin rule.
 */
export async function transcriptAccess(
  session: Pick<RecordingSession, 'conversation_id' | 'group_folder'>,
  userId: string,
): Promise<UserAccess> {
  let allowed = false;
  try {
    allowed = await canReceiveRecordingTranscript(
      userId,
      session.conversation_id,
      session.group_folder,
    );
  } catch (err) {
    logger.warn({ err }, 'Live transcript dropped: access check failed');
  }
  return {
    isAdmin: false,
    explicitProjects: new Set(allowed ? [session.group_folder] : []),
    implicitProjectConvIds: new Map(),
    expires: Date.now(),
  };
}

function emitPartialTranscript(
  session: RecordingSession,
  final = false,
  transcript?: string,
): void {
  const event = meetingTranscriptEvent(session, final, transcript);
  if (!event) return;
  broadcastWithAccess(event, (userId) => transcriptAccess(session, userId));
}

// Whether the caller may record here now: the same owner/editor-or-admin-bypass
// rule `enforceProjectAccess` applies to the write routes, evaluated against
// the current account and membership. The chat UI reads it to offer recording.
router.get('/projects/:pid/meetings/access', (req: any, res) => {
  res.json({ canRecord: canEditProjectLocalFiles(req) });
});

router.post('/projects/:pid/meetings/record', async (req: any, res) => {
  const pid = req.params.pid;
  const group = getGroupByFolder(pid);
  if (!group) return res.status(404).json({ error: 'Project not found' });

  if (!isRecord(req.body)) {
    return res.status(400).json({ error: 'JSON body is required' });
  }
  const { conversation_id, language } = req.body;
  if (!conversation_id || typeof conversation_id !== 'string') {
    return res.status(400).json({ error: 'conversation_id is required' });
  }
  const sessionLanguage =
    typeof language === 'string' && language.trim() ? language.trim() : null;
  if (
    sessionLanguage &&
    !MEETING_LANGUAGES.some((l) => l.code === sessionLanguage)
  ) {
    return res.status(400).json({ error: 'Invalid meeting language' });
  }

  if (!(await requireConversationAccess(req, res, conversation_id, 'read'))) {
    return;
  }

  const conv = await getConversation(conversation_id);
  if (!conv || conv.group_folder !== pid) {
    return res
      .status(404)
      .json({ error: 'Conversation not found in this project' });
  }
  const selection =
    conv.runtimeSelection ||
    group.settings?.chatRuntimeSelection ||
    getDefaultRuntimeSelection('chat');
  const resolvedConfig = resolveRuntimeSelection(selection);
  const listenAgentId =
    resolvedConfig.audio === true ? resolvedConfig.id : null;

  const session = createSession({
    conversation_id,
    group_folder: pid,
    user_id: req.authUser?.id ?? 'anonymous',
    language: sessionLanguage,
    listen_agent_id: listenAgentId,
  });

  res.json({ recording_id: session.recording_id });
});

router.post(
  '/projects/:pid/meetings/record/:recordingId/chunk',
  uploadChunkAudio,
  async (req: any, res) => {
    const recordingId = req.params.recordingId;

    evictStaleSessions();

    const session = getSession(recordingId);
    if (!session) {
      return res.status(404).json({ error: 'Recording session not found' });
    }

    if (!(await authorizeRecordingSession(req, res, session))) return;

    if (isRateLimited(recordingId)) {
      return res
        .status(429)
        .json({ error: 'Rate limited — one chunk per second' });
    }

    const audioFile = req.file;
    if (!audioFile) {
      return res
        .status(400)
        .json({ error: 'Missing `audio` field in multipart form' });
    }

    const audioBuffer: Buffer = audioFile.buffer;
    if (audioBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty audio chunk' });
    }

    const bodyMime =
      typeof req.body?.mime_type === 'string' ? req.body.mime_type : undefined;
    const mimeType = normalizeMimeType(bodyMime || audioFile.mimetype);
    const result = appendChunk(recordingId, audioBuffer, mimeType);

    // One transcription per session at a time: a flush that comes due while
    // one is running is skipped; the next flush (or stop) picks up the audio.
    if (result?.shouldFlush && !result.session.transcription) {
      await enqueueTranscription(result.session, () =>
        transcribeNextAudio(result.session),
      );
      emitPartialTranscript(result.session);
    }

    res.json({ ok: true });
  },
);

const MAX_TRANSCRIPT_PART_CHARS = 10_000;

/**
 * Append text transcribed on the client (Android on-device Whisper), so a
 * recording can stream its transcript without uploading audio. Uses the same
 * sanitizing, de-duplication, and live broadcast as server-transcribed audio.
 */
router.post(
  '/projects/:pid/meetings/record/:recordingId/transcript',
  async (req: any, res) => {
    const recordingId = req.params.recordingId;

    evictStaleSessions();

    const session = getSession(recordingId);
    if (!session) {
      return res.status(404).json({ error: 'Recording session not found' });
    }

    if (!(await authorizeRecordingSession(req, res, session))) return;

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (text.length > MAX_TRANSCRIPT_PART_CHARS) {
      return res.status(413).json({ error: 'Transcript part too large' });
    }

    touchSession(recordingId);

    const transcript = sanitizeMeetingTranscriptChunk(
      text,
      getFullTranscript(session),
      scriptForSession(session),
    );
    if (transcript) {
      appendTranscriptPart(session, transcript);
      emitPartialTranscript(session);
    }

    res.json({ ok: true });
  },
);

type StopResult = { status: number; body: unknown };

/** Stops being processed, so concurrent stops of one recording share one. */
const stopsInFlight = new Map<string, Promise<StopResult>>();

const TRANSCRIPT_NOT_SAVED_ERROR =
  'The transcript could not be saved to the project files. Copy it before closing this panel.';

router.post(
  '/projects/:pid/meetings/record/:recordingId/stop',
  async (req: any, res) => {
    const recordingId = req.params.recordingId;

    const session = getSession(recordingId);
    if (!session) {
      return res.status(404).json({ error: 'Recording session not found' });
    }

    if (!(await authorizeRecordingSession(req, res, session))) return;

    // A stop already in flight (e.g. a client transport retry) is joined, not
    // repeated. No await between this check and the insert below.
    const inFlight = stopsInFlight.get(recordingId);
    if (inFlight) {
      const result = await inFlight;
      return res.status(result.status).json(result.body);
    }

    // Keep the idle sweep from evicting a session whose stop is processing.
    touchSession(recordingId);

    const runStop = async (): Promise<StopResult> => {
      await enqueueTranscription(session, () =>
        transcribeNextAudio(session, true),
      );

      const finalized = finalizeSession(recordingId);
      if (!finalized) {
        return {
          status: 404,
          body: { error: 'Recording session not found' },
        };
      }

      const { session: finalSession } = finalized;
      const priorTranscript =
        typeof req.body?.prior_transcript === 'string'
          ? req.body.prior_transcript.trim()
          : '';

      let transcript = getFullTranscript(finalSession);

      // Last resort: decode the full recording once (still O(1) at stop, not per window).
      if (!transcript && finalSession.all_chunks.length > 0) {
        const fullBlob = buildFullRecordingBlob(finalSession.all_chunks);
        if (fullBlob) {
          const ext = extFromMime(finalSession.mime_type);
          let buffer: Buffer = fullBlob;
          let mime = finalSession.mime_type;
          let filename = `recording-final.${ext}`;
          const wav = await convertAudioToWav(fullBlob, ext);
          if (wav) {
            buffer = wav;
            mime = 'audio/wav';
            filename = 'recording-final.wav';
          }
          try {
            const llmAgent = listenAgentConfig(finalSession);
            const transcriber = getTranscriber();
            if (llmAgent || transcriber) {
              const raw = llmAgent
                ? await transcribeAudioWithAgent(buffer, mime, llmAgent).catch(
                    (err) => {
                      logger.warn(
                        { err, recording_id: finalSession.recording_id },
                        'LLM full-recording transcription failed — trying Whisper',
                      );
                      return transcriber
                        ? transcriber(
                            buffer,
                            mime,
                            filename,
                            whisperOptionsForSession(finalSession),
                          )
                        : '';
                    },
                  )
                : await transcriber!(
                    buffer,
                    mime,
                    filename,
                    whisperOptionsForSession(finalSession),
                  );
              transcript = sanitizeMeetingTranscriptChunk(
                raw.trim(),
                getFullTranscript(finalSession),
                scriptForSession(finalSession),
              );
              if (transcript) {
                transcript = appendTranscriptPart(finalSession, transcript);
              }
            }
          } catch (err) {
            logger.error(
              { err, recording_id: finalSession.recording_id },
              'Whisper transcription failed for full recording fallback',
            );
          }
        }
      }

      transcript = mergeMeetingTranscripts(priorTranscript, transcript);

      // Persist the merged transcript as a topic-scoped artifact keyed by the
      // conversation (one meeting = one conversation). Re-stopping the same
      // recording overwrites the same path, which is exactly the merge semantic
      // we want — no stable row id needed.
      let artifactUrl: string | undefined;
      let artifactRelPath: string | undefined;
      let artifactFilename: string | undefined;
      let artifactError: string | undefined;
      if (transcript && !(await isRecordingBoundToProject(finalSession))) {
        logger.error(
          { recording_id: finalSession.recording_id },
          'Meeting transcript not saved: its project was renamed or deleted',
        );
        artifactError = TRANSCRIPT_NOT_SAVED_ERROR;
      } else if (transcript) {
        const artifactBuffer = Buffer.from(
          `# Meeting Recording Transcript\n\n${transcript}`,
          'utf-8',
        );
        const relPath = `meetings/${finalSession.conversation_id}.md`;
        try {
          const written = await writeArtifactFile(
            finalSession.group_folder,
            relPath,
            artifactBuffer,
            {
              mimetype: 'text/markdown',
              caption: 'Meeting recording transcript',
            },
          );
          artifactUrl = written.url;
          artifactRelPath = `artifacts/${written.relPath}`;
          artifactFilename = `${finalSession.conversation_id}.md`;
          broadcast({
            type: 'artifacts_changed',
            payload: { folder: finalSession.group_folder },
          });
        } catch (err) {
          logger.error(
            { err, recording_id: finalSession.recording_id },
            'Failed to persist transcript artifact',
          );
          artifactError = TRANSCRIPT_NOT_SAVED_ERROR;
        }
      }

      // Keep the recording itself beside the transcript, one file per recorded
      // segment (a resumed meeting adds another), so a model that hears audio
      // can listen to it.
      let audioUrl: string | undefined;
      let audioRelPath: string | undefined;
      const recording = buildFullRecordingBlob(finalSession.all_chunks);
      if (recording && !(await isRecordingBoundToProject(finalSession))) {
        logger.error(
          { recording_id: finalSession.recording_id },
          'Meeting recording not saved: its project was renamed or deleted',
        );
      } else if (recording) {
        const mimetype = finalSession.mime_type.split(';')[0]!.trim();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        try {
          const written = await writeArtifactFile(
            finalSession.group_folder,
            `meetings/${finalSession.conversation_id}-${stamp}.${extFromMime(mimetype)}`,
            recording,
            { mimetype, caption: 'Meeting recording' },
          );
          audioUrl = written.url;
          audioRelPath = `artifacts/${written.relPath}`;
          broadcast({
            type: 'artifacts_changed',
            payload: { folder: finalSession.group_folder },
          });
        } catch (err) {
          logger.error(
            { err, recording_id: finalSession.recording_id },
            'Failed to persist meeting recording',
          );
        }
      }

      if (transcript) {
        emitPartialTranscript(finalSession, true, transcript);
      }
      deleteSession(recordingId);

      return {
        status: 200,
        body: {
          transcript,
          audio_url: audioUrl,
          audio_rel_path: audioRelPath,
          artifact_url: artifactUrl,
          artifact_rel_path: artifactRelPath,
          artifact_filename: artifactFilename,
          artifact_error: artifactError,
        },
      };
    };

    const stop = runStop().finally(() => stopsInFlight.delete(recordingId));
    stopsInFlight.set(recordingId, stop);
    const result = await stop;
    res.status(result.status).json(result.body);
  },
);

router.delete(
  '/projects/:pid/meetings/record/:recordingId',
  async (req: any, res) => {
    const recordingId = req.params.recordingId;

    const session = getSession(recordingId);
    if (!session) {
      return res.status(404).json({ error: 'Recording session not found' });
    }

    if (!(await authorizeRecordingSession(req, res, session))) return;

    deleteSession(recordingId);
    res.json({ ok: true });
  },
);

export default router;
