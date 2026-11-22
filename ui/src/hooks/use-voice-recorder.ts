import { useCallback, useEffect, useRef, useState } from 'react';
import { RECORDER_MIME_TYPES } from '@/lib/recorder-mime-types';

export interface VoiceRecording {
  file: File;
  durationSeconds: number;
}

interface Session {
  stream: MediaStream;
  recorder: MediaRecorder;
  context: AudioContext;
  frame: number;
  startedAt: number;
  chunks: Blob[];
}

/** Shorter than this is an accidental tap, not a voice message. */
const MIN_RECORDING_SECONDS = 0.4;

const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
};

/** Records one voice message for a model that takes the audio itself.
 * `onLevel` receives the microphone level (RMS, 0..1) once per frame. */
export function useVoiceRecorder(onLevel: (rms: number) => void) {
  const [recording, setRecording] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  /** Bumped by every start/stop, so a slow permission prompt cannot revive a
   * capture that was already stopped. */
  const generation = useRef(0);
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;

  const release = useCallback(() => {
    const current = session.current;
    session.current = null;
    if (current) {
      cancelAnimationFrame(current.frame);
      current.stream.getTracks().forEach((track) => track.stop());
      void current.context.close().catch(() => undefined);
    }
    onLevelRef.current(0);
    setRecording(false);
    setStartedAt(null);
  }, []);

  const start = useCallback(async () => {
    if (session.current) return;
    const mine = ++generation.current;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (mine !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = RECORDER_MIME_TYPES.find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const current: Session = {
        stream,
        recorder,
        context,
        frame: 0,
        startedAt: performance.now(),
        chunks,
      };
      const measure = () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        onLevelRef.current(Math.sqrt(sum / samples.length));
        current.frame = requestAnimationFrame(measure);
      };
      current.frame = requestAnimationFrame(measure);
      session.current = current;
      recorder.start();
      setStartedAt(Date.now());
      setRecording(true);
    } catch {
      if (mine !== generation.current) return;
      release();
      setError(
        'Microphone could not start. Allow microphone access and try again.',
      );
    }
  }, [release]);

  /** Ends the recording; resolves with the voice message, or null when it
   * was too short or nothing was captured. */
  const stop = useCallback((): Promise<VoiceRecording | null> => {
    generation.current++;
    const current = session.current;
    if (!current) return Promise.resolve(null);
    return new Promise((resolve) => {
      current.recorder.onstop = () => {
        const durationSeconds = (performance.now() - current.startedAt) / 1000;
        const type = (
          current.recorder.mimeType ||
          current.chunks[0]?.type ||
          'audio/webm'
        ).split(';')[0]!;
        const blob = new Blob(current.chunks, { type });
        release();
        if (!blob.size || durationSeconds < MIN_RECORDING_SECONDS) {
          resolve(null);
          return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        resolve({
          file: new File(
            [blob],
            `voice-message-${stamp}.${EXTENSIONS[type] ?? 'webm'}`,
            { type },
          ),
          durationSeconds,
        });
      };
      try {
        current.recorder.stop();
      } catch {
        release();
        resolve(null);
      }
    });
  }, [release]);

  /** Ends the recording and throws it away. */
  const cancel = useCallback(() => {
    generation.current++;
    const current = session.current;
    if (!current) return;
    current.recorder.onstop = null;
    try {
      current.recorder.stop();
    } catch {
      // Already inactive.
    }
    release();
  }, [release]);

  const isRecording = useCallback(() => session.current !== null, []);

  useEffect(() => cancel, [cancel]);

  return { recording, startedAt, error, start, stop, cancel, isRecording };
}
