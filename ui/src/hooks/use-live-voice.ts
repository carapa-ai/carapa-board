import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { API_BASE_URL } from '@/lib/api-config';
import { apiFetch } from '@/lib/api';
import { cutOffLiveSpeech } from '@/lib/use-tts';
import { createReplyAudioTracker } from '@/lib/reply-audio';
import {
  LIVE_VOICE_PROTOCOL,
  LiveVoiceDetector,
  StreamingPcmResampler,
  cleanupLiveVoiceResources as cleanupAudioResources,
  zeroCrossingRate,
} from '@/lib/live-voice-protocol';
import { liveVoiceWebSocketUrl } from '@/lib/live-voice-socket';
import {
  expireSilentCapture,
  releaseStaleMicrophoneStream,
} from '@/lib/live-voice-lifecycle';
import { recordLiveMetric } from '@/lib/live-telemetry';
import {
  cancelLocalPhrases,
  getLocalTranscriptionStatus,
  prepareLocalTranscription,
  transcribeLocalPhrase,
  type LocalTranscriptionStatus,
} from '@/lib/local-transcription';

export type LiveVoiceStatus =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'hearing'
  | 'transcribing'
  | 'no-speech'
  | 'empty'
  | 'unavailable'
  /** Server connection lost; a retry is scheduled or in flight (`reconnect`). */
  | 'reconnecting'
  | 'error';
export interface LiveVoiceState {
  status: LiveVoiceStatus;
  capturing: boolean;
  partial: string;
  lastFinal: string | null;
  error: string | null;
  mode?: 'gpu' | 'cpu-fallback';
  /** Why a finish() ended without everything it waited for (no words, a
   * failed phrase, a stalled server). The state itself is back to `idle`. */
  finishNotice?: string | null;
  /** Language capture listens in ('auto' = detected) and who transcribes. */
  listening?: {
    engine: 'server' | 'whisper' | 'system';
    language: string;
  } | null;
}
export interface LiveVoiceResources {
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  node?: AudioNode;
  socket?: WebSocket;
  workletUrl?: string;
  abort?: AbortController;
  firstFrameTimer?: number;
  /** On-device Whisper phrase queue, set instead of `socket` when enabled. */
  local?: LocalPhraseQueue;
}

interface LocalPhraseQueue {
  submit: (utteranceId: string, pcm: ArrayBuffer) => void;
  drain: () => Promise<void>;
  cancel: () => void;
}

const SEND_BATCH_MS = 80;
const PRE_ROLL_MS = 200;
/** Server-path phrase bound. The server rejects a phrase above its 15 s PCM
 * cap (`LIVE_STT_MAX_UTTERANCE_MS`) and drops the audio already received, so
 * the browser ends a phrase at 15 s minus `PRE_ROLL_MS` minus a margin for the
 * last frame (up to 1024 samples), the pre-roll's extra frame and the last
 * unsent batch. */
const SERVER_MAX_UTTERANCE_MS = 14_500;
const LOCAL_SAMPLE_RATE = 16_000;
const DICTATION_LANGUAGE_CACHE = 'carapa.dictation-language';
const MODEL_TOAST_ID = 'carapa-local-voice-model';
/** While reply audio plays, speech only barges in when its frame RMS exceeds
 * the larger of this floor and ECHO_BARGE_IN_RATIO x the recent playback-time
 * level (its decaying peak). Quieter speech is treated as speaker echo. */
const ECHO_BARGE_IN_MIN_RMS = 0.05;
const ECHO_BARGE_IN_RATIO = 2.5;
const ECHO_LEVEL_HALF_LIFE_MS = 1_500;
/** After reply audio (and its tail) ends, a still-suppressed phrase becomes an
 * utterance on the first frame at or above this RMS (the detector's onset
 * floor), so an answer that runs on from the reply is not swallowed. */
const ECHO_RESUME_MIN_RMS = 0.012;
/** Reconnect backoff: 0.5 s, 1 s, 2 s, 4 s, 8 s, then every 10 s. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const RECONNECTING_MESSAGE = 'Reconnecting voice…';

/** Failures of reaching the server (as opposed to a denied microphone or an
 * outdated backend), which a reconnect can fix. */
const transientErrors = new WeakSet<object>();
function transient<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    if (typeof error === 'object' && error) transientErrors.add(error);
    throw error;
  });
}

// Responsive layouts can briefly mount two controls. Globally serialize mic
// ownership so one phrase can never be submitted twice.
let activeLiveVoiceCapture: { owner: string; stop: () => void } | null = null;

export function cleanupLiveVoiceResources(resources: LiveVoiceResources): void {
  resources.abort?.abort();
  resources.local?.cancel();
  if (resources.firstFrameTimer) clearTimeout(resources.firstFrameTimer);
  if (resources.socket && resources.socket.readyState <= WebSocket.OPEN) {
    resources.socket.close();
  }
  cleanupAudioResources(resources);
}

function pcm16(chunks: Float32Array[], length: number): ArrayBuffer {
  const output = new ArrayBuffer(length * 2);
  const view = new DataView(output);
  let offset = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const sample = Math.max(-1, Math.min(1, chunk[i]!));
      view.setInt16(offset * 2, sample * 0x7fff, true);
      offset++;
    }
  }
  return output;
}

/** Shown when Stop finds no words in anything captured. */
const NO_WORDS_MESSAGE = 'No words were recognized.';
/** Longest silence from the server while finish() waits for `stopped` or the
 * next final; past it the composer is freed with a failure instead of staying
 * pending. A phrase may take the server's whole budget: the GPU attempt times
 * out after 10 s, then the CPU fallback allows 60 s per request, plus
 * transport delay. Phrases run one after another, so every result and the
 * server's switch-to-fallback notice re-arm the wait. */
const FINISH_STALL_TIMEOUT_MS = 90_000;
/** Same bound for on-device Whisper, which has no deadline of its own: one
 * call takes seconds (about 7 s for the first one after a model load), so
 * only a native worker that never returns reaches it. Each result re-arms it. */
const WHISPER_FINISH_STALL_TIMEOUT_MS = 60_000;
/** Worst case of one phrase on the Android recognizer, all inside one native
 * call (no result until it returns). Mirrors SystemSpeechRecognizer.kt:
 * "auto" tries up to MAX_LANGUAGES languages one after another; each is
 * recognized once and, after a TRANSIENT_ERRORS failure, once more, each
 * attempt waiting up to TIMEOUT_MS and then up to 1 s for its writer thread;
 * then transcribeLocalPhrase may wait for the server's pick. */
const SYSTEM_RECOGNIZER_ATTEMPT_MS = 30_000; // TIMEOUT_MS
const SYSTEM_RECOGNIZER_ATTEMPT_CLEANUP_MS = 1_000; // writer.join(1_000)
const SYSTEM_RECOGNIZER_MAX_LANGUAGES = 3; // MAX_LANGUAGES
const SYSTEM_RECOGNIZER_ATTEMPTS_PER_LANGUAGE = 2; // attempt + one retry
const TRANSCRIPT_CHOICE_WAIT_MS = 4_000; // TRANSCRIPT_CHOICE_TIMEOUT_MS
const FINISH_STALL_MARGIN_MS = 10_000;
const SYSTEM_RECOGNIZER_FINISH_STALL_TIMEOUT_MS =
  SYSTEM_RECOGNIZER_MAX_LANGUAGES *
    SYSTEM_RECOGNIZER_ATTEMPTS_PER_LANGUAGE *
    (SYSTEM_RECOGNIZER_ATTEMPT_MS + SYSTEM_RECOGNIZER_ATTEMPT_CLEANUP_MS) +
  TRANSCRIPT_CHOICE_WAIT_MS +
  FINISH_STALL_MARGIN_MS; // 200 s

/** On-device phrase boundaries (server path: `SERVER_MAX_UTTERANCE_MS`). A short
 * phrase needs a real pause; once it is long enough for Whisper to have
 * context, a breath between words ends it, so continuous speech still
 * produces text every few seconds. */
const LOCAL_PHRASE_DETECTION = {
  trailingSilenceMs: 700,
  relaxAfterMs: 3_000,
  relaxedTrailingSilenceMs: 200,
  maxUtteranceMs: 8_000,
};
/** Merged on-device batches stay within one 30 s Whisper window. */
const MAX_MERGED_PCM_BYTES = 25 * LOCAL_SAMPLE_RATE * 2;
/** Silence between merged phrases, so Whisper still hears the pause. */
const MERGE_GAP_BYTES = Math.round(0.15 * LOCAL_SAMPLE_RATE) * 2;

/** Joins Int16 PCM phrases with a short silence between them. */
function mergePhrases(chunks: ArrayBuffer[]): ArrayBuffer {
  if (chunks.length === 1) return chunks[0]!;
  const total =
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) +
    MERGE_GAP_BYTES * (chunks.length - 1);
  const merged = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk, index) => {
    if (index > 0) offset += MERGE_GAP_BYTES;
    merged.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  });
  return merged.buffer;
}

/** The saved dictation language, or the last one seen when the board is
 * unreachable, so on-device dictation keeps working offline. */
async function accountDictationLanguage(signal: AbortSignal): Promise<string> {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), 3_000);
  const onAbort = () => timeout.abort();
  signal.addEventListener('abort', onAbort);
  try {
    const preferences = (await apiFetch(
      `${API_BASE_URL}/api/account/preferences`,
      { signal: timeout.signal },
    ).then((response) => response.json())) as {
      dictationLanguage?: string | null;
    };
    const language = preferences.dictationLanguage || 'auto';
    try {
      localStorage.setItem(DICTATION_LANGUAGE_CACHE, language);
    } catch {
      // Caching is a convenience; the fetched value is still used.
    }
    return language;
  } catch (error) {
    if (signal.aborted) throw error;
    try {
      return localStorage.getItem(DICTATION_LANGUAGE_CACHE) || 'auto';
    } catch {
      return 'auto';
    }
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** On-device language hint. A fixed language L becomes "L,en": Whisper picks
 * L or English per phrase, instead of translating English speech into L. */
function localLanguageHint(language: string): string {
  const lang = language.trim().toLowerCase();
  if (!lang || lang === 'auto') return 'auto';
  const base = lang.split('-')[0]!;
  return base === 'en' ? 'en' : `${base},en`;
}

function showModelProgress(status: LocalTranscriptionStatus): void {
  const size = Math.round(status.model.sizeBytes / 1_000_000);
  if (status.state === 'downloading') {
    toast.loading(
      `Downloading on-device voice model (${size} MB)… ${Math.floor((status.progress ?? 0) * 100)}%`,
      { id: MODEL_TOAST_ID },
    );
  } else if (status.state === 'verifying') {
    toast.loading('Verifying on-device voice model…', { id: MODEL_TOAST_ID });
  } else if (status.state === 'loading') {
    toast.loading('Loading on-device voice model…', { id: MODEL_TOAST_ID });
  }
}

interface StreamingConfig {
  transcriptionConfigured: boolean;
  streamingConfigured?: boolean;
  streamingTransport?: string;
  websocketPath?: string;
  sampleRate: number;
  language?: string;
}

/** Continuous microphone capture shared by composer dictation and Live Mode.
 * Browser VAD defines stable phrases; only final phrases leave this hook. */
export function useLiveVoice(
  enabled: boolean,
  onFinal: (text: string) => void | Promise<void>,
  options: {
    useAccountDictationLanguage?: boolean;
    /** The chosen speech-to-text language ('auto' or a meeting-language
     * code); overrides the account dictation language. Unset keeps the
     * account/operator default.
     * Changing it restarts an active capture. */
    language?: string;
    /** Live Mode only: ignore speech that starts while the assistant's reply
     * is playing unless it is clearly louder than the playback echo. */
    suppressReplyEcho?: boolean;
    /** Live Mode only: when the server STT connection drops or cannot be
     * established while enabled, retry with backoff instead of staying dead.
     * Dictation keeps its immediate failure (and failure toast). */
    reconnect?: boolean;
    /** Microphone level (frame RMS, 0..1) for a recording indicator. */
    onLevel?: (rms: number) => void;
    /** Voiced audio a phrase needs before it counts as speech (detector
     * default 300 ms). Dictation lowers it so one-word answers survive. */
    minSpeechMs?: number;
  } = {},
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, setState] = useState<LiveVoiceState>({
    status: 'idle',
    capturing: false,
    partial: '',
    lastFinal: null,
    error: null,
  });
  const resources = useRef<LiveVoiceResources>({});
  const generation = useRef(0);
  const speaking = useRef(false);
  /** Capture ended by finish(); stays `transcribing` until the rest arrives. */
  const finishing = useRef(false);
  /** Last failure reported while finish() was still waiting for phrases. */
  const finishFailure = useRef<string | null>(null);
  const finishTimer = useRef<number | null>(null);
  const localStallTimeoutMs = useRef(WHISPER_FINISH_STALL_TIMEOUT_MS);
  /** The newest final of this session had no words, even if it arrived
   * before Stop; Stop reports it. */
  const lastFinalEmpty = useRef(false);
  /** A phrase at or after Stop had no words, even if later ones had. */
  const emptyDuringFinish = useRef(false);
  const detectorRef = useRef<LiveVoiceDetector | null>(null);
  const owner = useRef(crypto.randomUUID());
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);
  const startRef = useRef<() => Promise<void>>(async () => undefined);
  const ownershipChannel = useRef<BroadcastChannel | null>(null);
  const onFinalRef = useRef(onFinal);
  const activeUtteranceId = useRef<string | null>(null);
  const utteranceEnded = useRef(new Map<string, number>());
  const deliveredUtteranceIds = useRef(new Set<string>());
  const sendChunks = useRef<Float32Array[]>([]);
  const sendSamples = useRef(0);
  const preRoll = useRef<Float32Array[]>([]);
  const preRollSamples = useRef(0);
  onFinalRef.current = onFinal;

  const releaseAudio = useCallback(() => {
    const current = resources.current;
    if (current.firstFrameTimer) clearTimeout(current.firstFrameTimer);
    cleanupAudioResources(current);
    resources.current = {
      socket: current.socket,
      abort: current.abort,
      local: current.local,
    };
  }, []);

  const clearFinishTimer = useCallback(() => {
    if (finishTimer.current === null) return;
    window.clearTimeout(finishTimer.current);
    finishTimer.current = null;
  }, []);

  const stop = useCallback(() => {
    generation.current++;
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    clearFinishTimer();
    lastFinalEmpty.current = false;
    emptyDuringFinish.current = false;
    cleanupLiveVoiceResources(resources.current);
    resources.current = {};
    speaking.current = false;
    finishing.current = false;
    activeUtteranceId.current = null;
    detectorRef.current = null;
    sendChunks.current = [];
    sendSamples.current = 0;
    preRoll.current = [];
    preRollSamples.current = 0;
    utteranceEnded.current.clear();
    deliveredUtteranceIds.current.clear();
    if (activeLiveVoiceCapture?.owner === owner.current) {
      activeLiveVoiceCapture = null;
    }
    setState({
      status: 'idle',
      capturing: false,
      partial: '',
      lastFinal: null,
      error: null,
    });
  }, [clearFinishTimer]);

  const flushAudio = useCallback(() => {
    const socket = resources.current.socket;
    if (
      !sendSamples.current ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    socket.send(pcm16(sendChunks.current, sendSamples.current));
    sendChunks.current = [];
    sendSamples.current = 0;
  }, []);

  const queueAudio = useCallback(
    (chunk: Float32Array, sampleRate: number) => {
      sendChunks.current.push(chunk);
      sendSamples.current += chunk.length;
      if (sendSamples.current >= (sampleRate * SEND_BATCH_MS) / 1000) {
        flushAudio();
      }
    },
    [flushAudio],
  );

  const commit = useCallback(() => {
    const { socket, local } = resources.current;
    const id = activeUtteranceId.current;
    if (!id) return null;
    if (local) {
      // One native inference call per committed phrase.
      const pcm = pcm16(sendChunks.current, sendSamples.current);
      sendChunks.current = [];
      sendSamples.current = 0;
      utteranceEnded.current.set(id, performance.now());
      local.submit(id, pcm);
    } else {
      if (!socket || socket.readyState !== WebSocket.OPEN) return null;
      flushAudio();
      utteranceEnded.current.set(id, performance.now());
      socket.send(JSON.stringify({ type: 'commit', utteranceId: id }));
    }
    activeUtteranceId.current = null;
    speaking.current = false;
    setState((current) => ({
      ...current,
      status: 'transcribing',
      error: null,
    }));
    return id;
  }, [flushAudio]);

  /** Drops the open utterance without transcribing it. */
  const dropOpenUtterance = useCallback(() => {
    speaking.current = false;
    activeUtteranceId.current = null;
    sendChunks.current = [];
    sendSamples.current = 0;
    resources.current.socket?.send(JSON.stringify({ type: 'discard' }));
  }, []);

  /** Stop before trailing silence: a phrase below the detector's speech
   * minimums (a tap, a click) is dropped; a qualifying short word is kept. */
  const dropIfBelowSpeechFloor = useCallback(() => {
    if (activeUtteranceId.current && detectorRef.current?.flush() === false) {
      dropOpenUtterance();
    }
  }, [dropOpenUtterance]);

  /** Ends a finish() back at `idle`. A failure reported meanwhile, or a last
   * phrase without words, is handed over as `finishNotice` for the failure
   * toast; the earlier inserted text stays. */
  const settleFinish = useCallback(() => {
    const notice =
      finishFailure.current ??
      (lastFinalEmpty.current || emptyDuringFinish.current
        ? NO_WORDS_MESSAGE
        : null);
    finishFailure.current = null;
    stop();
    if (notice) {
      setState((current) => ({ ...current, finishNotice: notice }));
    }
  }, [stop]);

  /** (Re)starts the bound on how long finish() waits for the server or the
   * on-device queue; on expiry the late results are dropped with the capture. */
  const armFinishTimer = useCallback(() => {
    clearFinishTimer();
    finishTimer.current = window.setTimeout(
      () => {
        finishTimer.current = null;
        finishFailure.current ??= 'Voice transcription timed out';
        settleFinish();
      },
      resources.current.local
        ? localStallTimeoutMs.current
        : FINISH_STALL_TIMEOUT_MS,
    );
  }, [clearFinishTimer, settleFinish]);

  /** Stops capture; resolves once on-device phrases are delivered. */
  const finish = useCallback((): Promise<void> => {
    if (!resources.current.node) {
      // Still starting: nothing was captured, and a server that has not
      // started the session would never acknowledge a stop.
      stop();
      return Promise.resolve();
    }
    finishing.current = true;
    finishFailure.current = null;
    // A blank result that came back just before Stop still counts, even when
    // a later phrase succeeds while Stop drains.
    emptyDuringFinish.current = lastFinalEmpty.current;
    setState((current) => ({
      ...current,
      capturing: false,
      status: 'transcribing',
    }));
    const local = resources.current.local;
    if (local) {
      releaseAudio();
      dropIfBelowSpeechFloor();
      commit();
      armFinishTimer();
      return local.drain().then(() => {
        if (resources.current.local === local) settleFinish();
      });
    }
    const socket = resources.current.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      // The connection is already going away (its close event may not have
      // fired yet): report it like a close during the drain, not a silent stop.
      finishFailure.current ??= 'Voice connection closed';
      settleFinish();
      return Promise.resolve();
    }
    releaseAudio();
    dropIfBelowSpeechFloor();
    const id = commit();
    socket.send(
      JSON.stringify({
        type: 'stop',
        ...(id ? {} : { utteranceId: activeUtteranceId.current ?? undefined }),
      }),
    );
    if (!id) {
      setState((current) => ({ ...current, status: 'transcribing' }));
    }
    // A dead connection may never deliver `stopped` or a close event.
    armFinishTimer();
    return Promise.resolve();
  }, [
    armFinishTimer,
    commit,
    dropIfBelowSpeechFloor,
    releaseAudio,
    settleFinish,
    stop,
  ]);

  const start = useCallback(async () => {
    if (activeLiveVoiceCapture?.owner !== owner.current) {
      activeLiveVoiceCapture?.stop();
    }
    stop();
    activeLiveVoiceCapture = { owner: owner.current, stop };
    ownershipChannel.current?.postMessage({
      type: 'claim',
      owner: owner.current,
    });
    const retrying = reconnectAttempt.current > 0;
    setState({
      status: retrying ? 'reconnecting' : 'initializing',
      capturing: true,
      partial: '',
      lastFinal: null,
      error: retrying ? RECONNECTING_MESSAGE : null,
    });
    const abort = new AbortController();
    resources.current.abort = abort;
    const run = generation.current;
    const isCurrent = () => run === generation.current && !abort.signal.aborted;
    const reconnect = optionsRef.current.reconnect === true;
    /** Ends this run and schedules a fresh start() after the backoff. Phrases
     * committed but not yet final are dropped, not replayed. */
    const scheduleReconnect = (): boolean => {
      if (!reconnect || !isCurrent()) return false;
      generation.current++;
      cleanupLiveVoiceResources(resources.current);
      resources.current = {};
      speaking.current = false;
      activeUtteranceId.current = null;
      sendChunks.current = [];
      sendSamples.current = 0;
      utteranceEnded.current.clear();
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** reconnectAttempt.current,
      );
      reconnectAttempt.current++;
      setState({
        status: 'reconnecting',
        capturing: false,
        partial: '',
        lastFinal: null,
        error: RECONNECTING_MESSAGE,
      });
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        void startRef.current();
      }, delay);
      return true;
    };

    const deliverFinal = (utteranceId: string, rawText: unknown) => {
      if (deliveredUtteranceIds.current.has(utteranceId)) return;
      deliveredUtteranceIds.current.add(utteranceId);
      if (finishTimer.current !== null) armFinishTimer();
      const ended = utteranceEnded.current.get(utteranceId);
      utteranceEnded.current.delete(utteranceId);
      if (ended !== undefined) {
        recordLiveMetric(
          'utterance_end_to_final_stt_ms',
          performance.now() - ended,
        );
      }
      const text = typeof rawText === 'string' ? rawText.trim() : '';
      if (!text) {
        lastFinalEmpty.current = true;
        if (finishing.current) {
          emptyDuringFinish.current = true;
          return;
        }
        setState((current) => ({
          ...current,
          // Soft informational hint, never a failure toast: an empty
          // final while actively speaking must land on the same `empty`
          // soft-hint status as the idle case, so `hearing` stays
          // reserved for the actionable recoverable backend error.
          status: 'empty',
          error: `${NO_WORDS_MESSAGE} Keep talking or try again.`,
        }));
        return;
      }
      lastFinalEmpty.current = false;
      setState((current) => ({
        ...current,
        status: finishing.current
          ? 'transcribing'
          : speaking.current
            ? 'hearing'
            : 'ready',
        lastFinal: text,
        error: null,
      }));
      Promise.resolve(onFinalRef.current(text)).catch((error) => {
        if (!isCurrent()) return;
        const message =
          error instanceof Error ? error.message : 'Voice message failed';
        if (finishing.current) {
          // Stop still drains the other phrases; its exit reports this.
          finishFailure.current = message;
          return;
        }
        setState((current) => ({
          ...current,
          status: 'error',
          error: message,
        }));
      });
    };
    const reportError = (
      message: string,
      recoverable: boolean,
      utteranceId?: string,
    ) => {
      recordLiveMetric('failed_stt_calls');
      if (finishing.current) finishFailure.current = message;
      if (finishTimer.current !== null && recoverable) armFinishTimer();
      if (utteranceId) utteranceEnded.current.delete(utteranceId);
      if (!recoverable && finishing.current) {
        // A terminal error while Stop waits ends Stop like any other failure:
        // idle with a notice, not the capture-time `error` state.
        settleFinish();
        return;
      }
      if (!recoverable) {
        clearFinishTimer();
        generation.current++;
        cleanupLiveVoiceResources(resources.current);
        resources.current = {};
        if (activeLiveVoiceCapture?.owner === owner.current) {
          activeLiveVoiceCapture = null;
        }
      }
      setState((current) => ({
        ...current,
        capturing: recoverable ? current.capturing : false,
        status: recoverable
          ? finishing.current
            ? 'transcribing'
            : speaking.current
              ? 'hearing'
              : 'ready'
          : 'error',
        error: message,
      }));
    };
    /** Serial on-device queue. Each inference costs about the same for any
     * phrase up to ~10 s, so phrases committed while one runs are merged into
     * a single next call; the queue then keeps up with continuous speech and
     * little is left to transcribe after Stop. Finals arrive in phrase order
     * and stale results are dropped after stop or unmount. */
    const localPhraseQueue = (language: string): LocalPhraseQueue => {
      const requests = new Set<string>();
      const batches: { ids: string[]; chunks: ArrayBuffer[]; bytes: number }[] =
        [];
      let running: Promise<void> | null = null;
      const pump = async () => {
        while (batches.length && isCurrent()) {
          const batch = batches.shift()!;
          const pcm = mergePhrases(batch.chunks);
          // The newest phrase identifies the batch: deliveries, latency, and
          // cancellation follow it.
          const requestId = batch.ids[batch.ids.length - 1]!;
          for (const id of batch.ids.slice(0, -1)) {
            utteranceEnded.current.delete(id);
          }
          requests.add(requestId);
          const result = await transcribeLocalPhrase(requestId, pcm, language);
          requests.delete(requestId);
          if (!isCurrent()) return;
          if (result.ok) {
            const ended = utteranceEnded.current.get(requestId);
            if (ended !== undefined) {
              console.info(
                `[carapa-local-stt] end-of-speech to final ${Math.round(performance.now() - ended)} ms (inference ${result.inferenceMs} ms, ${batch.ids.length} phrase(s), language ${language})`,
              );
            }
            deliverFinal(requestId, result.text);
          } else if (result.code !== 'cancelled') {
            reportError(
              `On-device transcription failed: ${result.message}`,
              result.code === 'failed',
              requestId,
            );
          }
        }
      };
      return {
        submit(utteranceId, pcm) {
          const last = batches[batches.length - 1];
          if (last && last.bytes + pcm.byteLength <= MAX_MERGED_PCM_BYTES) {
            last.ids.push(utteranceId);
            last.chunks.push(pcm);
            last.bytes += pcm.byteLength;
          } else {
            batches.push({
              ids: [utteranceId],
              chunks: [pcm],
              bytes: pcm.byteLength,
            });
          }
          running ??= pump().finally(() => {
            running = null;
          });
        },
        drain: () => running ?? Promise.resolve(),
        cancel() {
          batches.length = 0;
          cancelLocalPhrases([...requests]);
          requests.clear();
        },
      };
    };

    const opts = optionsRef.current;
    try {
      const localStatus = await getLocalTranscriptionStatus();
      if (!isCurrent()) return;
      let serverSocket: WebSocket | undefined;
      let sampleRate = LOCAL_SAMPLE_RATE;
      if (localStatus?.enabled) {
        // On-device Whisper (opted in per device): no live-voice config,
        // socket, or audio upload, and never a fallback to server STT.
        // The Android recognizer cannot detect the language (it returns
        // nothing for speech in another language), so Live Mode gives it the
        // account's dictation language too; Whisper detects it itself.
        const language =
          opts.language ??
          (opts.useAccountDictationLanguage || localStatus.engine === 'system'
            ? await accountDictationLanguage(abort.signal)
            : 'auto');
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          listening: {
            engine: localStatus.engine === 'system' ? 'system' : 'whisper',
            language: language || 'auto',
          },
        }));
        const prepared = await prepareLocalTranscription((status) => {
          if (isCurrent()) showModelProgress(status);
          else toast.dismiss(MODEL_TOAST_ID);
        });
        toast.dismiss(MODEL_TOAST_ID);
        if (!isCurrent()) return;
        if (!prepared.ok) {
          throw new Error(
            `On-device transcription unavailable: ${prepared.message}`,
          );
        }
        localStallTimeoutMs.current =
          localStatus.engine === 'system'
            ? SYSTEM_RECOGNIZER_FINISH_STALL_TIMEOUT_MS
            : WHISPER_FINISH_STALL_TIMEOUT_MS;
        resources.current = {
          ...resources.current,
          abort,
          local: localPhraseQueue(localLanguageHint(language)),
        };
      } else {
        const config = (await transient(
          apiFetch(`${API_BASE_URL}/api/live-voice/config`, {
            signal: abort.signal,
          }).then((response) => response.json()),
        )) as StreamingConfig;
        if (!isCurrent()) return;
        sampleRate = config.sampleRate || LOCAL_SAMPLE_RATE;
        // An explicit language replaces the saved dictation preference and
        // is sent like Live Mode's choice (the server ignores it for
        // dictation-flagged sessions).
        const useAccountLanguage =
          opts.useAccountDictationLanguage && !opts.language;
        const accountPreferences = useAccountLanguage
          ? ((await apiFetch(`${API_BASE_URL}/api/account/preferences`, {
              signal: abort.signal,
            }).then((response) => response.json())) as {
              dictationLanguage?: string | null;
            })
          : null;
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          listening: {
            engine: 'server',
            language:
              (useAccountLanguage
                ? accountPreferences?.dictationLanguage
                : (opts.language ?? config.language)) || 'auto',
          },
        }));
        if (!config.streamingConfigured && !config.transcriptionConfigured) {
          throw new Error(
            'Voice input unavailable: configure local transcription',
          );
        }
        if (config.streamingTransport !== LIVE_VOICE_PROTOCOL) {
          throw new Error(
            'Voice input unavailable: CarapaBoard backend is outdated',
          );
        }

        const socketUrl = await liveVoiceWebSocketUrl(
          config.websocketPath || '/api/live-voice/ws',
        );
        if (!isCurrent()) return;
        const socket = new WebSocket(socketUrl);
        socket.binaryType = 'arraybuffer';
        resources.current = { ...resources.current, socket, abort };

        await transient(
          new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(
              () =>
                reject(new Error('Local voice service did not become ready')),
              6_000,
            );
            const rejectAndClear = (error: Error) => {
              window.clearTimeout(timer);
              reject(error);
            };
            socket.onopen = () => {
              socket.send(
                JSON.stringify({
                  type: 'start',
                  protocol: LIVE_VOICE_PROTOCOL,
                  sampleRate,
                  ...(useAccountLanguage
                    ? {
                        dictation: true,
                        ...(accountPreferences?.dictationLanguage != null
                          ? { language: accountPreferences.dictationLanguage }
                          : {}),
                      }
                    : opts.language
                      ? { language: opts.language }
                      : {}),
                }),
              );
            };
            socket.onerror = () =>
              rejectAndClear(new Error('Local voice socket failed'));
            socket.onmessage = (event) => {
              if (typeof event.data !== 'string') return;
              let message: Record<string, unknown>;
              try {
                message = JSON.parse(event.data);
              } catch {
                return;
              }
              if (message.type === 'ready') {
                window.clearTimeout(timer);
                reconnectAttempt.current = 0;
                setState((current) => ({
                  ...current,
                  mode:
                    message.mode === 'cpu-fallback' ? 'cpu-fallback' : 'gpu',
                }));
                resolve();
              }
            };
          }),
        );
        if (!isCurrent()) {
          socket.close();
          return;
        }

        socket.onmessage = (event) => {
          if (!isCurrent() || typeof event.data !== 'string') return;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === 'ready') {
            // The fallback switch restarts the server's clock for the phrases
            // finish() still waits for.
            if (finishTimer.current !== null) armFinishTimer();
            setState((current) => ({
              ...current,
              mode: message.mode === 'cpu-fallback' ? 'cpu-fallback' : 'gpu',
            }));
            return;
          }
          if (
            message.type === 'final' &&
            typeof message.utteranceId === 'string'
          ) {
            deliverFinal(message.utteranceId, message.text);
            return;
          }
          if (message.type === 'stopped') {
            settleFinish();
            return;
          }
          if (message.type === 'error') {
            reportError(
              typeof message.message === 'string'
                ? message.message
                : 'Transcription failed',
              message.recoverable === true,
              typeof message.utteranceId === 'string'
                ? message.utteranceId
                : undefined,
            );
          }
        };
        socket.onclose = () => {
          if (!isCurrent()) return;
          if (finishing.current) {
            // Stop was waiting for the last phrases: end at idle with a notice
            // like a timeout; capture-time disconnects stay `unavailable`.
            finishFailure.current ??= 'Voice connection closed';
            settleFinish();
            return;
          }
          if (scheduleReconnect()) return;
          cleanupLiveVoiceResources(resources.current);
          resources.current = {};
          if (activeLiveVoiceCapture?.owner === owner.current) {
            activeLiveVoiceCapture = null;
          }
          setState((current) => ({
            ...current,
            capturing: false,
            status: 'unavailable',
            error: current.error || 'Voice connection closed',
          }));
        };
        serverSocket = socket;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (releaseStaleMicrophoneStream(stream, isCurrent())) return;
      resources.current = {
        ...resources.current,
        stream,
        abort,
        socket: serverSocket,
      };
      const context = new AudioContext({
        sampleRate: sampleRate,
      });
      resources.current = {
        ...resources.current,
        stream,
        context,
        abort,
        socket: serverSocket,
      };
      if (context.state !== 'running') await context.resume();
      if (context.state !== 'running') {
        throw new Error(
          'Audio capture could not start. Tap the microphone and try again.',
        );
      }
      const source = context.createMediaStreamSource(stream);
      resources.current = {
        ...resources.current,
        stream,
        context,
        source,
        abort,
        socket: serverSocket,
      };
      const detector = new LiveVoiceDetector({
        sampleRate: sampleRate,
        // On-device Whisper costs about the same per phrase up to ~10 s and is
        // far more accurate on whole sentences than on clause fragments, so
        // only a real pause ends a phrase.
        ...(resources.current.local
          ? LOCAL_PHRASE_DETECTION
          : { maxUtteranceMs: SERVER_MAX_UTTERANCE_MS }),
        minSpeechMs: opts.minSpeechMs,
      });
      detectorRef.current = detector;
      const targetSampleRate = sampleRate;
      const resampler = new StreamingPcmResampler(
        context.sampleRate,
        targetSampleRate,
      );
      const maxPreRollSamples = (targetSampleRate * PRE_ROLL_MS) / 1000;
      let receivedFrame = false;
      let quietSamples = 0;
      const suppressReplyEcho = optionsRef.current.suppressReplyEcho === true;
      const replyAudioActive = createReplyAudioTracker();
      let playbackLevel = 0;
      let replyWasActive = false;
      /** The current detector phrase began as speaker echo and has not yet
       * been promoted to a real utterance by a clearly louder frame. */
      let echoSuppressed = false;

      const bufferPreRoll = (frame: Float32Array) => {
        preRoll.current.push(frame);
        preRollSamples.current += frame.length;
        while (
          preRollSamples.current > maxPreRollSamples &&
          preRoll.current.length > 1
        ) {
          preRollSamples.current -= preRoll.current.shift()!.length;
        }
      };
      const beginUtterance = (frame: Float32Array) => {
        quietSamples = 0;
        speaking.current = true;
        activeUtteranceId.current = crypto.randomUUID();
        for (const buffered of preRoll.current) {
          queueAudio(buffered, targetSampleRate);
        }
        preRoll.current = [];
        preRollSamples.current = 0;
        queueAudio(frame, targetSampleRate);
        setState((current) => ({
          ...current,
          status: 'hearing',
          error: null,
        }));
        void cutOffLiveSpeech();
      };

      const handle = (input: Float32Array) => {
        // After finish() only committed phrases may still arrive.
        if (!isCurrent() || !input.length || finishing.current) return;
        const resampled = resampler.push(input);
        if (!resampled.length) return;
        if (!receivedFrame) {
          receivedFrame = true;
          if (resources.current.firstFrameTimer) {
            clearTimeout(resources.current.firstFrameTimer);
          }
          resources.current.firstFrameTimer = undefined;
          setState((current) => ({
            ...current,
            status: 'ready',
            error: null,
          }));
        }
        const copy = resampled;
        const rms = Math.sqrt(
          copy.reduce((sum, value) => sum + value * value, 0) / copy.length,
        );
        optionsRef.current.onLevel?.(rms);
        // Compare against the level heard before this frame, then fold it in.
        let replyActive = false;
        let echoLikely = false;
        if (suppressReplyEcho) {
          replyActive = replyAudioActive();
          if (replyActive !== replyWasActive) {
            replyWasActive = replyActive;
            if (!replyActive) {
              // The reply and its echo tail just ended. A long playback pins
              // the detector's adaptive noise floor at the speaker echo it
              // heard, which can lift the onset above normal speech; forget
              // it so the next utterance is detected from its first word.
              detector.resetNoiseFloor();
            }
          }
          if (replyActive) {
            echoLikely =
              rms <=
              Math.max(
                ECHO_BARGE_IN_MIN_RMS,
                ECHO_BARGE_IN_RATIO * playbackLevel,
              );
            playbackLevel = Math.max(
              rms,
              playbackLevel *
                0.5 **
                  (((copy.length / targetSampleRate) * 1000) /
                    ECHO_LEVEL_HALF_LIFE_MS),
            );
          } else playbackLevel = 0;
        }
        const decision = detector.push(
          rms,
          copy.length,
          zeroCrossingRate(copy),
        );
        if (decision === 'silence') {
          quietSamples += copy.length;
          bufferPreRoll(copy);
          if (quietSamples >= targetSampleRate * 8) {
            quietSamples = 0;
            setState((current) => ({
              ...current,
              status: 'no-speech',
              error: 'No speech detected. You can keep talking or use text.',
            }));
          }
          return;
        }
        if (decision === 'speech-start' && echoLikely) {
          // Speaker echo: no barge-in and no utterance until a later frame of
          // this phrase is clearly louder than the playback level.
          echoSuppressed = true;
          bufferPreRoll(copy);
          return;
        }
        if (echoSuppressed) {
          if (decision === 'finalize' || decision === 'discard') {
            // The suppressed phrase never became an utterance: nothing to
            // commit, message the server about, or tell the user.
            echoSuppressed = false;
            preRoll.current = [];
            preRollSamples.current = 0;
            return;
          }
          if (replyActive ? echoLikely : rms < ECHO_RESUME_MIN_RMS) {
            bufferPreRoll(copy);
            return;
          }
          echoSuppressed = false;
          beginUtterance(copy);
          return;
        }
        if (decision === 'speech-start') {
          beginUtterance(copy);
          return;
        }
        if (decision === 'discard') {
          dropOpenUtterance();
          setState((current) => ({
            ...current,
            status: 'no-speech',
            error: 'Brief noise ignored. Keep talking or use text.',
          }));
          return;
        }
        if (!speaking.current) return;
        queueAudio(copy, targetSampleRate);
        if (decision === 'finalize') commit();
      };

      let node: AudioNode;
      if (context.audioWorklet) {
        const workletUrl = URL.createObjectURL(
          new Blob(
            [
              `class C extends AudioWorkletProcessor{process(i){const c=i[0]?.[0];if(c)this.port.postMessage(c.slice());return true}}registerProcessor('carapa-pcm',C)`,
            ],
            { type: 'text/javascript' },
          ),
        );
        resources.current.workletUrl = workletUrl;
        await context.audioWorklet.addModule(workletUrl);
        if (!isCurrent()) return;
        const worklet = new AudioWorkletNode(context, 'carapa-pcm');
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) =>
          handle(event.data);
        node = worklet;
      } else {
        const processor = context.createScriptProcessor(1024, 1, 1);
        processor.onaudioprocess = (event) =>
          handle(event.inputBuffer.getChannelData(0));
        node = processor;
      }
      const firstFrameTimer = window.setTimeout(() => {
        if (
          !expireSilentCapture(receivedFrame, isCurrent(), () =>
            cleanupLiveVoiceResources(resources.current),
          )
        )
          return;
        resources.current = {};
        setState({
          status: 'error',
          capturing: false,
          partial: '',
          lastFinal: null,
          error:
            'Microphone started but no audio was received. Tap the microphone and try again.',
        });
      }, 3_000);
      resources.current = {
        ...resources.current,
        node,
        firstFrameTimer,
      };
      source.connect(node);
      node.connect(context.destination);
    } catch (error) {
      if (!isCurrent()) return;
      recordLiveMetric('failed_stt_calls');
      if (
        typeof error === 'object' &&
        error &&
        transientErrors.has(error) &&
        scheduleReconnect()
      ) {
        return;
      }
      cleanupLiveVoiceResources(resources.current);
      resources.current = {};
      setState({
        status: 'unavailable',
        capturing: false,
        partial: '',
        lastFinal: null,
        error:
          error instanceof Error ? error.message : 'Microphone unavailable',
      });
    }
  }, [
    armFinishTimer,
    clearFinishTimer,
    commit,
    dropOpenUtterance,
    queueAudio,
    releaseAudio,
    settleFinish,
    stop,
  ]);
  startRef.current = start;

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('carapa-live-voice-capture');
    ownershipChannel.current = channel;
    channel.onmessage = (event) => {
      if (event.data?.type === 'claim' && event.data?.owner !== owner.current) {
        stop();
      }
    };
    return () => {
      if (ownershipChannel.current === channel) {
        ownershipChannel.current = null;
      }
      channel.close();
    };
  }, [stop]);

  const languageOverride = options.language;
  useEffect(() => {
    reconnectAttempt.current = 0;
    if (enabled) void start();
    else stop();
    return stop;
  }, [enabled, start, stop, languageOverride]);

  return { ...state, start, finish, stop };
}

/** Toasts a visible error when a user-initiated capture fails:
 *  - capture dies in a failure state (`unavailable`/`error`) — the silent
 *    revert the user reported;
 *  - a recoverable backend error or phrase-callback failure lands while
 *    capture keeps running — otherwise the message would only reach the
 *    screen-reader region.
 * A failure while finish() waits for the last phrases counts as the capture
 * dying; a finish() that ended with a notice (no words, failed phrase, stalled
 * server) toasts it once the state is back at idle. Intentional stops (finish, ownership handoff, remount) land on
 * `transcribing`/`idle` with a cleared error, so they stay silent. */
export function useDictationFailureToast(
  dictation: Pick<LiveVoiceState, 'capturing' | 'status' | 'error'> &
    Pick<Partial<LiveVoiceState>, 'finishNotice'>,
): void {
  const finishNotice = dictation.finishNotice;
  useEffect(() => {
    if (finishNotice) toast.error(`Dictation stopped: ${finishNotice}`);
  }, [finishNotice]);
  const wasActive = useRef(false);
  const previousError = useRef<string | null>(null);
  useEffect(() => {
    const was = wasActive.current;
    const error = dictation.error;
    const previous = previousError.current;
    wasActive.current =
      dictation.capturing || dictation.status === 'transcribing';
    previousError.current = error;
    if (!error) return;
    const captureDied =
      was &&
      !dictation.capturing &&
      (dictation.status === 'unavailable' || dictation.status === 'error');
    const lingering =
      dictation.capturing &&
      previous === null &&
      (dictation.status === 'ready' ||
        dictation.status === 'hearing' ||
        dictation.status === 'error');
    if (captureDied) {
      toast.error(`Dictation stopped: ${error}`);
    } else if (lingering) {
      toast.error(`Dictation issue: ${error}`);
    }
  }, [dictation.capturing, dictation.status, dictation.error]);
}
