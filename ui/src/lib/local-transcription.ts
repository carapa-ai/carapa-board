import { Capacitor, registerPlugin } from '@capacitor/core';
import { bytesToBase64 } from './base64';

/** Native `CarapaWhisper` state; see CarapaWhisperPlugin.kt. */
export type LocalTranscriptionState =
  | 'unsupported'
  | 'disabled'
  | 'missing'
  | 'downloading'
  | 'verifying'
  | 'installed'
  | 'loading'
  | 'ready'
  | 'failed';

export interface LocalModelDescriptor {
  id: string;
  label: string;
  sizeBytes: number;
  sha256: string;
}

/** One pinned catalog entry and its state on this device. */
export interface LocalModelEntry extends LocalModelDescriptor {
  installed: boolean;
  selected: boolean;
  loaded: boolean;
  phase?: 'downloading' | 'verifying' | 'loading' | null;
  progress?: number | null;
  error?: string | null;
}

/** Whisper models, or an Android speech recognition service. */
export type LocalTranscriptionEngine = 'whisper' | 'system';

/** An installed Android speech recognition service. */
export interface LocalRecognizerEntry {
  /** Flattened component name. */
  id: string;
  label: string;
  isDefault: boolean;
  selected: boolean;
}

export interface LocalTranscriptionStatus {
  /** State of the selected engine/model, or the device-level opt-in. */
  state: LocalTranscriptionState;
  /** Per-device opt-in; off by default so other devices keep server STT. */
  enabled: boolean;
  /** Absent on shells that predate the engine choice (Whisper only). */
  engine?: LocalTranscriptionEngine;
  engines?: Record<LocalTranscriptionEngine, { unsupported?: string | null }>;
  recognizers?: LocalRecognizerEntry[];
  /** Download fraction 0..1 while `downloading`. */
  progress?: number | null;
  error?: string | null;
  model: LocalModelDescriptor;
  models: LocalModelEntry[];
}

export type LocalPrepareResult =
  | { ok: true; status: LocalTranscriptionStatus }
  | {
      ok: false;
      code: 'disabled' | 'unsupported' | 'cancelled' | 'failed';
      message: string;
    };

export type LocalTranscriptionResult =
  | { ok: true; text: string; inferenceMs: number }
  | { ok: false; code: 'cancelled' | 'not-ready' | 'failed'; message: string };

interface CarapaWhisperPlugin {
  getStatus(): Promise<LocalTranscriptionStatus>;
  setEnabled(options: { enabled: boolean }): Promise<LocalTranscriptionStatus>;
  selectEngine(options: {
    engine: LocalTranscriptionEngine;
    recognizer?: string | null;
  }): Promise<LocalTranscriptionStatus>;
  selectModel(options: { id: string }): Promise<LocalTranscriptionStatus>;
  downloadModel(options: { id: string }): Promise<LocalTranscriptionStatus>;
  deleteModel(options: { id: string }): Promise<LocalTranscriptionStatus>;
  prepare(): Promise<LocalTranscriptionStatus>;
  transcribe(options: {
    requestId: string;
    pcm: string;
    language: string;
  }): Promise<{
    text: string;
    inferenceMs: number;
    audioMs: number;
    /** Android recognizer: one transcript per tried language. */
    candidates?: Array<{ language: string; text: string }>;
  }>;
  cancel(options: { requestIds?: string[] }): Promise<void>;
  addListener(
    event: 'status',
    listener: (status: LocalTranscriptionStatus) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

// Registered on first use so importing this module has no side effects.
let plugin: CarapaWhisperPlugin | null = null;
function whisper(): CarapaWhisperPlugin {
  plugin ??= registerPlugin<CarapaWhisperPlugin>('CarapaWhisper');
  return plugin;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function localTranscriptionAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/** Null outside the Android app, or on a shell without the plugin. */
export async function getLocalTranscriptionStatus(): Promise<LocalTranscriptionStatus | null> {
  if (!localTranscriptionAvailable()) return null;
  try {
    return await whisper().getStatus();
  } catch {
    return null;
  }
}

export function setLocalTranscriptionEnabled(
  enabled: boolean,
): Promise<LocalTranscriptionStatus> {
  return whisper().setEnabled({ enabled });
}

/** Switches between Whisper and an Android recognizer (null = system default). */
export function selectLocalEngine(
  engine: LocalTranscriptionEngine,
  recognizer?: string | null,
): Promise<LocalTranscriptionStatus> {
  return whisper().selectEngine(
    recognizer === undefined ? { engine } : { engine, recognizer },
  );
}

export function selectLocalModel(
  id: string,
): Promise<LocalTranscriptionStatus> {
  return whisper().selectModel({ id });
}

export function downloadLocalModel(
  id: string,
): Promise<LocalTranscriptionStatus> {
  return whisper().downloadModel({ id });
}

export function deleteLocalModel(
  id: string,
): Promise<LocalTranscriptionStatus> {
  return whisper().deleteModel({ id });
}

export function onLocalTranscriptionStatus(
  listener: (status: LocalTranscriptionStatus) => void,
): () => void {
  const handle = whisper().addListener('status', listener);
  return () =>
    void handle
      .then((registered) => registered.remove())
      .catch(() => undefined);
}

/** Downloads, verifies, and loads the pinned model when needed. */
export async function prepareLocalTranscription(
  onStatus?: (status: LocalTranscriptionStatus) => void,
): Promise<LocalPrepareResult> {
  const unsubscribe = onStatus ? onLocalTranscriptionStatus(onStatus) : null;
  try {
    return { ok: true, status: await whisper().prepare() };
  } catch (error) {
    const code = errorCode(error);
    return {
      ok: false,
      code:
        code === 'DISABLED'
          ? 'disabled'
          : code === 'UNSUPPORTED'
            ? 'unsupported'
            : code === 'CANCELLED'
              ? 'cancelled'
              : 'failed',
      message: errorMessage(error, 'The on-device voice model is unavailable'),
    };
  } finally {
    unsubscribe?.();
  }
}

/** Longest wait for the server's pick before the native choice is used.
 * use-live-voice.ts sizes its Stop wait from it (TRANSCRIPT_CHOICE_WAIT_MS). */
const TRANSCRIPT_CHOICE_TIMEOUT_MS = 4_000;

/**
 * The Android recognizer returns one transcript per language; a wrong
 * language yields phonetic nonsense, so the server (Jev) picks what was
 * really said. Falls back to the native choice (hinted language first).
 */
async function chooseTranscript(
  candidates: Array<{ language: string; text: string }>,
  fallback: string,
): Promise<string> {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  // Capacitor's native HTTP ignores the abort signal and can wait for minutes,
  // so the deadline also settles the race itself.
  const timedOut = new Promise<string>((resolve) => {
    deadline = setTimeout(() => {
      controller.abort();
      resolve(fallback);
    }, TRANSCRIPT_CHOICE_TIMEOUT_MS);
  });
  const request = (async () => {
    try {
      const [{ apiFetch }, { API_BASE_URL }] = await Promise.all([
        import('@/lib/api'),
        import('@/lib/api-config'),
      ]);
      const response = await apiFetch(
        `${API_BASE_URL}/api/live-voice/transcript-choice`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidates }),
          signal: controller.signal,
        },
      );
      if (!response.ok) return fallback;
      const choice = (await response.json()) as { text?: unknown };
      return typeof choice.text === 'string' ? choice.text : fallback;
    } catch {
      return fallback;
    }
  })();
  try {
    return await Promise.race([request, timedOut]);
  } finally {
    clearTimeout(deadline);
  }
}

/** Transcribes one committed 16 kHz mono Int16 phrase on the device. */
export async function transcribeLocalPhrase(
  requestId: string,
  pcm16: ArrayBuffer,
  language: string,
): Promise<LocalTranscriptionResult> {
  try {
    const result = await whisper().transcribe({
      requestId,
      pcm: bytesToBase64(new Uint8Array(pcm16)),
      language,
    });
    const text =
      (result.candidates?.filter((c) => c.text.trim()).length ?? 0) > 1
        ? await chooseTranscript(result.candidates!, result.text)
        : result.text;
    return { ok: true, text, inferenceMs: result.inferenceMs };
  } catch (error) {
    const code = errorCode(error);
    return {
      ok: false,
      code:
        code === 'CANCELLED'
          ? 'cancelled'
          : code === 'NOT_READY'
            ? 'not-ready'
            : 'failed',
      message: errorMessage(error, 'On-device transcription failed'),
    };
  }
}

export function cancelLocalPhrases(requestIds: string[]): void {
  if (!requestIds.length) return;
  void whisper()
    .cancel({ requestIds })
    .catch(() => undefined);
}
