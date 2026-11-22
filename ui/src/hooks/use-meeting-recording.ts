import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startMeetingRecording,
  stopMeetingRecording,
  sendRecordingChunk,
  cancelMeetingRecording,
} from '@/lib/api';
import { joinTranscriptParts } from '@/lib/meeting-transcript';
import { RECORDER_MIME_TYPES } from '@/lib/recorder-mime-types';
import { useStore } from '@/store';
import type { MeetingRecordingState } from '@/types';

/** Minimum interval between chunk uploads (backend rate limit) */
const CHUNK_MIN_INTERVAL_MS = 1_000;

/** MediaRecorder timeslice — how often to emit audio data */
const RECORDER_TIMESLICE_MS = 2_000;

const EMPTY_MEETING_STATE: MeetingRecordingState = {
  isRecording: false,
  isStarting: false,
  isStopping: false,
  recordingId: null,
  error: null,
  duration: 0,
  partialTranscript: null,
  artifactUrl: null,
  artifactRelPath: null,
  artifactFilename: null,
  audioRecordings: [],
  language: null,
};

/**
 * Hook for managing meeting recording sessions with real-time transcript streaming.
 *
 * Audio chunks are always uploaded: the server transcribes them and keeps the
 * recording, so on-device transcription is not used for meetings.
 *
 * Uses Zustand store to track active recordings. Partial transcripts arrive
 * via WebSocket events and are stored in the Zustand store — no polling needed.
 *
 * @param project_id  - The project ID to associate the recording with.
 * @param conversationId - The active conversation ID (required to start a recording).
 * @param onStateChange - Optional callback for recording state changes.
 */
export function useMeetingRecording(
  project_id: string,
  conversationId: string | null,
  onStateChange?: (state: MeetingRecordingState) => void,
) {
  const [state, setState] =
    useState<MeetingRecordingState>(EMPTY_MEETING_STATE);

  /** Transcript accumulated across stop/resume cycles until the panel is dismissed. */
  const sessionTranscriptRef = useRef<string | null>(null);
  const sessionArtifactRef = useRef<{
    url: string;
    relPath: string;
    filename: string;
  } | null>(null);
  /** Saved recordings of this meeting, one per stop/resume segment. */
  const sessionAudioRef = useRef<Array<{ url: string; relPath: string }>>([]);
  const sessionLanguageRef = useRef<string | null>(null);

  // Duration timer ref
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationRef = useRef(0);

  // Audio capture refs
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recorderMimeRef = useRef<string>('audio/webm');
  const lastChunkSentAtRef = useRef<number>(0);

  // Promise-based sync for the final MediaRecorder data event.
  // When stopRecording() fires stop(), it creates a Promise and stores
  // the resolve function here. The ondataavailable handler resolves it
  // when recorder.state === 'inactive' (the final flush event).
  const finalChunkRef = useRef<{
    resolve: () => void;
  } | null>(null);

  // Read partial transcript from store — populated by WS event handler
  const meetingPartialTranscripts = useStore(
    (s) => s.meetingPartialTranscripts,
  );

  // Helper to stop the media stream tracks
  const stopMediaStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  const clearSession = useCallback(() => {
    sessionTranscriptRef.current = null;
    sessionArtifactRef.current = null;
    sessionAudioRef.current = [];
    sessionLanguageRef.current = null;
    setState(EMPTY_MEETING_STATE);
  }, []);

  const markRecording = useCallback(
    (recordingId: string, resumeBaseTranscript: string | null) => {
      setState((prev) => ({
        ...prev,
        isStarting: false,
        isRecording: true,
        recordingId,
        error: null,
        duration: 0,
        partialTranscript: resumeBaseTranscript,
        artifactUrl: sessionArtifactRef.current?.url ?? prev.artifactUrl,
        artifactRelPath:
          sessionArtifactRef.current?.relPath ?? prev.artifactRelPath,
        artifactFilename:
          sessionArtifactRef.current?.filename ?? prev.artifactFilename,
        language: sessionLanguageRef.current,
      }));

      durationRef.current = 0;
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
      durationTimerRef.current = setInterval(() => {
        durationRef.current += 1;
        setState((prev) => ({ ...prev, duration: durationRef.current }));
      }, 1000);
    },
    [],
  );

  const beginCapture = useCallback(
    async (recordingId: string, resumeBaseTranscript: string | null) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const mimeType = RECORDER_MIME_TYPES.find((t) =>
        MediaRecorder.isTypeSupported(t),
      );

      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      mediaRecorderRef.current = recorder;
      recorderMimeRef.current = recorder.mimeType || mimeType || 'audio/webm';
      lastChunkSentAtRef.current = 0;

      recorder.ondataavailable = async (e) => {
        if (e.data.size === 0) return;

        try {
          const now = Date.now();
          const timeSinceLastChunk = now - lastChunkSentAtRef.current;
          if (
            timeSinceLastChunk < CHUNK_MIN_INTERVAL_MS &&
            lastChunkSentAtRef.current > 0
          ) {
            const delay = CHUNK_MIN_INTERVAL_MS - timeSinceLastChunk;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          await sendRecordingChunk(
            recordingId,
            project_id,
            e.data,
            recorderMimeRef.current,
          );
          lastChunkSentAtRef.current = Date.now();
        } catch (err) {
          console.error('Failed to send audio chunk', err);
        }

        if (recorder.state === 'inactive' && finalChunkRef.current) {
          finalChunkRef.current.resolve();
          finalChunkRef.current = null;
        }
      };

      recorder.onstop = () => {
        stopMediaStream();
      };

      recorder.start(RECORDER_TIMESLICE_MS);
      markRecording(recordingId, resumeBaseTranscript);
    },
    [project_id, stopMediaStream, markRecording],
  );

  // Start a new recording session (or resume after a prior stop).
  const startRecording = useCallback(
    async (
      conversationIdOverride?: string,
      options?: { resume?: boolean; language?: string },
    ) => {
      if (state.isRecording || state.isStarting) return;
      const convId = conversationIdOverride ?? conversationId;
      if (!convId) return;

      const isResume = options?.resume ?? false;
      if (!isResume) {
        sessionTranscriptRef.current = null;
        sessionArtifactRef.current = null;
        sessionAudioRef.current = [];
        sessionLanguageRef.current = options?.language ?? 'auto';
      } else {
        sessionTranscriptRef.current =
          sessionTranscriptRef.current ??
          state.partialTranscript?.trim() ??
          null;
      }

      const resumeBaseTranscript = isResume
        ? sessionTranscriptRef.current
        : null;

      setState((prev) => ({
        ...prev,
        isStarting: true,
        error: null,
        partialTranscript: resumeBaseTranscript,
        language: sessionLanguageRef.current,
        ...(isResume
          ? {}
          : {
              artifactUrl: null,
              artifactRelPath: null,
              artifactFilename: null,
              audioRecordings: [],
            }),
      }));

      try {
        const data = await startMeetingRecording(project_id, convId, {
          language: sessionLanguageRef.current ?? undefined,
        });
        await beginCapture(data.recording_id, resumeBaseTranscript);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setState((prev) => ({
          ...prev,
          isStarting: false,
          error: message,
          partialTranscript: sessionTranscriptRef.current,
        }));
        stopMediaStream();
      }
    },
    [
      project_id,
      conversationId,
      state.isRecording,
      state.isStarting,
      state.partialTranscript,
      beginCapture,
      stopMediaStream,
    ],
  );

  const resumeRecording = useCallback(async () => {
    await startRecording(undefined, { resume: true });
  }, [startRecording]);

  // Stop the current recording session
  const stopRecording = useCallback(async () => {
    if (!state.isRecording || state.isStopping) return;
    const currentRecordingId = state.recordingId;

    if (!currentRecordingId) return;

    setState((prev) => ({ ...prev, isStopping: true }));

    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }

    if (mediaRecorderRef.current) {
      let _resolve: () => void;
      const finalChunkPromise = new Promise<void>((resolve) => {
        _resolve = resolve;
      });
      finalChunkRef.current = { resolve: _resolve! };
      mediaRecorderRef.current.stop();

      try {
        await Promise.race([
          finalChunkPromise,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Final chunk timeout')), 5000),
          ),
        ]);
      } catch (e) {
        console.warn('Timed out waiting for final audio chunk', e);
      }
      mediaRecorderRef.current = null;
    }

    stopMediaStream();

    try {
      const {
        transcript,
        audio_url: audioUrl,
        audio_rel_path: audioRelPath,
        artifact_url: artifactUrl,
        artifact_rel_path: artifactRelPath,
        artifact_filename: artifactFilename,
        artifact_error: artifactError,
      } = await stopMeetingRecording(currentRecordingId, project_id, {
        prior_transcript: sessionTranscriptRef.current ?? undefined,
      });

      if (transcript) {
        useStore
          .getState()
          .setMeetingPartialTranscript(currentRecordingId, transcript);
      }

      const mergedTranscript =
        transcript?.trim() || sessionTranscriptRef.current || null;
      sessionTranscriptRef.current = mergedTranscript;

      if (audioUrl && audioRelPath) {
        sessionAudioRef.current = [
          ...sessionAudioRef.current,
          { url: audioUrl, relPath: audioRelPath },
        ];
      }
      if (artifactUrl && artifactRelPath && artifactFilename) {
        sessionArtifactRef.current = {
          url: artifactUrl,
          relPath: artifactRelPath,
          filename: artifactFilename,
        };
      }

      setState((prev) => ({
        ...prev,
        isStopping: false,
        isRecording: false,
        recordingId: null,
        error: artifactError ?? null,
        partialTranscript: mergedTranscript,
        artifactUrl: artifactUrl ?? sessionArtifactRef.current?.url ?? null,
        artifactRelPath:
          artifactRelPath ?? sessionArtifactRef.current?.relPath ?? null,
        artifactFilename:
          artifactFilename ?? sessionArtifactRef.current?.filename ?? null,
        audioRecordings: sessionAudioRef.current,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setState((prev) => ({
        ...prev,
        isStopping: false,
        error: message,
        partialTranscript: sessionTranscriptRef.current,
      }));
    }
  }, [
    project_id,
    state.isRecording,
    state.isStopping,
    state.recordingId,
    stopMediaStream,
  ]);

  const cancelRecording = useCallback(async () => {
    if (!state.isRecording && !state.isStarting) return;
    const currentRecordingId = state.recordingId;
    const preservedTranscript = sessionTranscriptRef.current;
    const preservedArtifact = sessionArtifactRef.current;
    const preservedLanguage = sessionLanguageRef.current;

    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }

    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    stopMediaStream();

    if (currentRecordingId) {
      try {
        await cancelMeetingRecording(currentRecordingId, project_id);
      } catch (err) {
        console.warn('Failed to cancel meeting recording', err);
      }
    }

    setState({
      ...EMPTY_MEETING_STATE,
      partialTranscript: preservedTranscript,
      artifactUrl: preservedArtifact?.url ?? null,
      artifactRelPath: preservedArtifact?.relPath ?? null,
      artifactFilename: preservedArtifact?.filename ?? null,
      audioRecordings: sessionAudioRef.current,
      language: preservedLanguage,
    });
  }, [
    project_id,
    state.isRecording,
    state.isStarting,
    state.recordingId,
    stopMediaStream,
  ]);

  // Sync partial transcript from store into local state
  useEffect(() => {
    if (!state.isRecording || !state.recordingId) return;

    const fromStore = meetingPartialTranscripts[state.recordingId] ?? null;
    setState((prev) => ({
      ...prev,
      partialTranscript: joinTranscriptParts(
        sessionTranscriptRef.current,
        fromStore,
      ),
    }));
  }, [meetingPartialTranscripts, state.isRecording, state.recordingId]);

  // Notify caller of state changes
  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current = null;
      }
      stopMediaStream();
    };
  }, [stopMediaStream]);

  return {
    state,
    startRecording,
    resumeRecording,
    stopRecording,
    cancelRecording,
    clearSession,
  };
}
