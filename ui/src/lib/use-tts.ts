/**
 * Shared text-to-speech player for the board UI / Android app.
 *
 * Pseudo-streaming WITHOUT relying on HTTP response streaming (which doesn't
 * survive CapacitorHttp on native): we sentence-chunk the text client-side and
 * fire one-shot POST /api/tts/synthesize per chunk sequentially, queueing each
 * audio clip so playback starts on chunk 0 while later chunks render.
 *
 * A single module-level controller drives one <audio> element, so only one
 * message ever plays at a time across the whole app. Components subscribe via
 * `useTts()` and call `toggle(id, text, opts)` / `stop()`.
 */

import { useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/api';
import { API_BASE_URL } from '@/lib/api-config';
import { validateLiveStatus } from './live-speech-protocol';
import {
  queueSpeech,
  cancelSpeech,
  isBackgroundCompletionBlocked,
  type SpeechItem,
} from './live-speech-queue';
import { recordLiveMetric } from './live-telemetry';
import { synthesizeLiveStatus } from './live-speech-client';
import {
  deviceTtsEnabled,
  previewDeviceSpeech,
  synthesizeDeviceSpeech,
} from './device-tts';
import {
  cachedNativeSpeechFileUrl,
  nativeSpeechFileUrl,
} from './native-speech';
import { holdConnectionMode } from './network-detection';
import {
  cacheNativeSpeech,
  isBridgeSupported,
  stopActiveNativeSpeech,
} from './push-bridge';
import {
  markLivePersonaPlaybackStarted,
  markLivePersonaSynthesizing,
  markLivePersonaWaiting,
  releaseLivePersonaReveal,
  releaseLivePersonaReveals,
  clearLivePersonaReveal,
  beginLivePersonaReveal,
  bufferLivePersonaChunk,
  updateLivePersonaPlayback,
} from './live-persona-reveal';
export {
  queueSpeech,
  cancelSpeech,
  isBackgroundCompletionBlocked,
} from './live-speech-queue';
export { validateLiveStatus } from './live-speech-protocol';

export type LiveSpeechPriority =
  | 'focused'
  | 'background-completion'
  | 'background-blocker';
export interface LiveSpeechState {
  status: 'idle' | 'synthesizing' | 'speaking';
  conversationId: string | null;
  messageId: string | null;
  text: string | null;
  currentTime: number;
  duration: number;
  muted: boolean;
  announceCompletions: boolean;
  error: string | null;
}

// Live Mode deliberately has a separate, tiny protocol. Callers cannot submit
// chat output here: only these bounded status phrases are accepted.
let liveState: LiveSpeechState = {
  status: 'idle',
  conversationId: null,
  messageId: null,
  text: null,
  currentTime: 0,
  duration: 0,
  muted: false,
  announceCompletions: false,
  error: null,
};
const liveListeners = new Set<() => void>();
let liveAudio: HTMLAudioElement | null = null;
let liveQueue: SpeechItem[] = [];
let liveSeq = 0;
let liveToken = 0;
let liveFocus: string | null = null;
let liveCurrentKind: 'status' | 'narration' | 'reply' | null = null;
let liveCurrentMessageId: string | null = null;
let blockedAutoplayItem: SpeechItem | null = null;
let liveProgressFrame: number | null = null;
const spokenLiveMessageIds = new Set<string>();
type PreparedLiveReply = {
  result: Awaited<ReturnType<typeof synthesizeLiveStatus>>;
  synthesizedDuration: number;
};
const preparedLiveReplies = new Map<
  string,
  { promise: Promise<PreparedLiveReply>; abort: () => void }
>();
export function retryBlockedLiveSpeech(): void {
  const item = blockedAutoplayItem;
  if (!item?.messageId) return;
  blockedAutoplayItem = null;
  spokenLiveMessageIds.delete(item.messageId);
  clearLivePersonaReveal(item.messageId);
  beginLivePersonaReveal(item.messageId, item.conversationId);
  bufferLivePersonaChunk(item.messageId, item.text);
  liveEmit({ ...liveState, error: null });
  enqueueLiveReply(item as Parameters<typeof enqueueLiveReply>[0]);
}

function liveEmit(next: LiveSpeechState) {
  liveState = next;
  liveListeners.forEach((listener) => listener());
}
function liveSubscribe(listener: () => void) {
  liveListeners.add(listener);
  return () => liveListeners.delete(listener);
}
function stopLiveProgress(): void {
  if (liveProgressFrame !== null && typeof cancelAnimationFrame === 'function')
    cancelAnimationFrame(liveProgressFrame);
  liveProgressFrame = null;
}
function interruptLiveAudio() {
  liveToken++;
  stopLiveProgress();
  if (liveCurrentMessageId) releaseLivePersonaReveal(liveCurrentMessageId);
  if (liveAudio) {
    liveAudio.pause();
    liveAudio.removeAttribute('src');
    liveAudio.load();
    liveAudio = null;
  }
  liveCurrentKind = null;
  liveCurrentMessageId = null;
  liveEmit({
    ...liveState,
    status: 'idle',
    conversationId: null,
    messageId: null,
    text: null,
    currentTime: 0,
    duration: 0,
  });
}
function cancelLiveAudio(releasePreparedReveals = true) {
  // Cancellation can happen while a persona is still generating and has not
  // entered the speech queue yet, so release every delayed presentation.
  if (releasePreparedReveals) releaseLivePersonaReveals();
  for (const prepared of preparedLiveReplies.values()) prepared.abort();
  preparedLiveReplies.clear();
  interruptLiveAudio();
  liveQueue = cancelSpeech(liveQueue);
}
export function cancelLiveSpeech() {
  cancelLiveAudio();
}
/**
 * Cut audio immediately for a server Stop without releasing persona pacing.
 * The Stop endpoint owns gate cancellation after it records the durable
 * conversation-scoped stop signal.
 */
export function cutOffLiveSpeechForServerStop(): Promise<void> {
  stopTts();
  cancelLiveAudio();
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function')
      requestAnimationFrame(() => resolve());
    else queueMicrotask(resolve);
  });
}
/** Resolves at the next rendering boundary after every speech source is paused. */
export function cutOffLiveSpeech(): Promise<void> {
  stopTts();
  cancelLiveAudio();
  void stopActiveNativeSpeech();
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function')
      requestAnimationFrame(() => resolve());
    else queueMicrotask(resolve);
  });
}
export function setLiveSpeechFocus(conversationId: string | null) {
  if (liveFocus !== conversationId) {
    liveFocus = conversationId;
    // Switching focus must stop the currently playing clip, but it must not
    // release newly materialized queue-owned preparing rows. Those rows are
    // identity-bound owners and remain hidden until their own playback.
    cancelLiveAudio(false);
  }
}
export function setLiveSpeechMuted(muted: boolean) {
  liveState = { ...liveState, muted };
  if (muted) cancelLiveAudio();
  liveEmit(liveState);
}
export function subscribeLiveSpeech(listener: () => void) {
  return liveSubscribe(listener);
}
export function setLiveCompletionAnnouncements(enabled: boolean) {
  liveEmit({ ...liveState, announceCompletions: enabled });
}
export function getLiveSpeechState() {
  return liveState;
}
export function useLiveSpeech() {
  useSyncExternalStore(
    liveSubscribe,
    () => liveState,
    () => liveState,
  );
  return liveState;
}

function prepareLiveReply(item: SpeechItem): Promise<PreparedLiveReply> {
  if (!item.messageId)
    return Promise.reject(new Error('Live reply message id is required'));
  const existing = preparedLiveReplies.get(item.messageId);
  if (existing) return existing.promise;
  let activeController: AbortController | null = null;
  let cancelled = false;
  const promise = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (cancelled)
        throw new DOMException(
          'Live reply preparation cancelled',
          'AbortError',
        );
      const controller = new AbortController();
      activeController = controller;
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const started = performance.now();
        let replyText = item.text;
        const prepared = item.audioUrl
          ? null
          : await apiFetch(API_BASE_URL + '/api/tts/prepare', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: item.text,
                lang: item.lang,
                projectId: item.projectId,
                detectLanguage: true,
              }),
              signal: controller.signal,
            }).catch(() => null);
        let replyLang = item.lang;
        if (prepared?.ok) {
          const body = (await prepared.json()) as {
            sentences?: unknown;
            language?: unknown;
          };
          if (Array.isArray(body.sentences))
            replyText = body.sentences.map(String).filter(Boolean).join(' ');
          if (typeof body.language === 'string') replyLang = body.language;
        }
        const response = item.audioUrl
          ? await apiFetch(item.audioUrl, { signal: controller.signal })
          : await apiFetch(API_BASE_URL + '/api/tts/synthesize', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Live-Conversation': item.conversationId,
              },
              body: JSON.stringify({
                text: replyText,
                voice: item.voice,
                lang: replyLang,
                format: 'ogg',
                steps: 8,
                profile: 'interactive',
              }),
              signal: controller.signal,
            });
        if (!response.ok) throw new Error(`Live TTS ${response.status}`);
        const durationHeader = Number.parseFloat(
          response.headers.get('X-Audio-Duration') || '',
        );
        return {
          result: {
            audio: await response.arrayBuffer(),
            text: item.text,
            requestMs: performance.now() - started,
            response,
          },
          synthesizedDuration:
            Number.isFinite(durationHeader) && durationHeader > 0
              ? durationHeader
              : 0,
        };
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Live reply synthesis failed');
  })();
  preparedLiveReplies.set(item.messageId, {
    promise,
    abort: () => {
      cancelled = true;
      activeController?.abort();
    },
  });
  return promise;
}

/** Download one server-prepared persona asset without admitting it to playback. */
export function prefetchLiveReply(input: {
  messageId: string;
  conversationId: string;
  projectId: string;
  audioUrl: string;
}): void {
  if (
    liveState.muted ||
    input.conversationId !== liveFocus ||
    preparedLiveReplies.has(input.messageId)
  )
    return;
  const promise = prepareLiveReply({
    kind: 'reply',
    messageId: input.messageId,
    conversationId: input.conversationId,
    projectId: input.projectId,
    audioUrl: input.audioUrl,
    text: '',
    priority: 'focused',
    sequence: ++liveSeq,
  });
  void promise.catch(() => {
    // Playback retries and surfaces a real failure if speculative preparation failed.
    if (preparedLiveReplies.get(input.messageId)?.promise === promise)
      preparedLiveReplies.delete(input.messageId);
  });
}

function prefetchNextLiveReply(): void {
  if (liveState.status !== 'speaking' || liveCurrentKind !== 'reply') return;
  const next = liveQueue.find(
    (item) => item.kind === 'reply' && item.messageId,
  );
  if (next)
    void prepareLiveReply(next).catch(() => {
      /* surfaced when playback reaches it */
    });
}

async function speakLiveNext() {
  if (liveState.status !== 'idle' || liveState.muted || !liveQueue.length)
    return;
  // Background completion is deliberately deferred while focused speech is
  // active or queued, even when completion announcements are enabled.
  if (
    liveQueue[0].priority === 'background-completion' &&
    isBackgroundCompletionBlocked(
      liveFocus,
      liveState.conversationId,
      liveQueue,
    )
  )
    return;
  const item = liveQueue.shift()!;
  const gen = liveToken;
  liveCurrentKind = item.kind || 'status';
  liveCurrentMessageId =
    item.kind === 'reply' ? (item.messageId ?? null) : null;
  if (liveCurrentMessageId) markLivePersonaSynthesizing(liveCurrentMessageId);
  const synthesisStarted = performance.now();
  liveEmit({
    ...liveState,
    status: 'synthesizing',
    conversationId: item.conversationId,
    messageId: liveCurrentMessageId,
    text: item.text,
    currentTime: 0,
    duration: 0,
    error: null,
  });
  try {
    let result: Awaited<ReturnType<typeof synthesizeLiveStatus>> | null = null;
    let synthesizedDuration = 0;
    let lastError: unknown;
    if (item.kind === 'reply') {
      const prepared = await prepareLiveReply(item);
      result = prepared.result;
      synthesizedDuration = prepared.synthesizedDuration;
      if (item.messageId) preparedLiveReplies.delete(item.messageId);
    }
    // Android with on-device TTS speaks narration itself, in the language
    // the text is written in; server synthesis is the fallback.
    const deviceUrl =
      item.kind === 'reply' || !(await deviceTtsEnabled())
        ? null
        : await synthesizeDeviceSpeech(
            item.text,
            (await getSentences(item.text, item)).language ?? item.lang,
          );
    for (
      let attempt = 0;
      item.kind !== 'reply' && !deviceUrl && attempt < 2 && !result;
      attempt++
    ) {
      const controller = new AbortController();
      // The board-side TTS request allows the local engine up to 90 seconds to
      // drain concurrent persona and narration work. Keep the browser deadline
      // slightly longer so it receives the server result instead of aborting a
      // synthesis that is still progressing.
      const timeout = setTimeout(() => controller.abort(), 100_000);
      try {
        result = await synthesizeLiveStatus(
          (url, init) => apiFetch(url, { ...init, signal: controller.signal }),
          API_BASE_URL + '/api/tts/synthesize',
          item.conversationId,
          item.text,
          'registry',
          { voice: item.voice, lang: item.lang },
        );
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!result && !deviceUrl)
      throw lastError instanceof Error
        ? lastError
        : new Error('Live speech synthesis failed');
    if (gen !== liveToken) return;
    const nativeUrl =
      deviceUrl ??
      (result?.response
        ? await nativeSpeechFileUrl(
            result.response,
            result.response.headers.get('X-TTS-Asset-Id') ||
              item.messageId ||
              `${item.conversationId}-status`,
          )
        : null);
    const url =
      nativeUrl ||
      URL.createObjectURL(new Blob([result!.audio], { type: 'audio/ogg' }));
    const revocable = !nativeUrl;
    if (gen !== liveToken) {
      if (revocable) URL.revokeObjectURL(url);
      return;
    }
    const audio = new Audio(url);
    liveAudio = audio;
    const messageId = liveCurrentMessageId;
    const finish = () => {
      stopLiveProgress();
      if (messageId) releaseLivePersonaReveal(messageId);
      if (revocable) URL.revokeObjectURL(url);
      liveAudio = null;
      liveCurrentKind = null;
      liveCurrentMessageId = null;
      liveEmit({
        ...liveState,
        status: 'idle',
        conversationId: null,
        messageId: null,
        text: null,
        currentTime: 0,
        duration: 0,
      });
      void speakLiveNext();
    };
    audio.onended = finish;
    audio.onerror = finish;
    if ((item.startOffsetSeconds ?? 0) > 0) {
      if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve) => {
          audio.addEventListener('loadedmetadata', () => resolve(), {
            once: true,
          });
          audio.load();
        });
      }
      const maximum = Number.isFinite(audio.duration)
        ? Math.max(0, audio.duration - 0.05)
        : item.startOffsetSeconds!;
      audio.currentTime = Math.min(item.startOffsetSeconds!, maximum);
    }
    await audio.play();
    item.onStarted?.();
    recordLiveMetric('first_audio_ms', performance.now() - synthesisStarted);
    if (messageId) markLivePersonaPlaybackStarted(messageId);
    const updateProgress = () => {
      if (gen !== liveToken || liveAudio !== audio) return;
      const duration =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : synthesizedDuration;
      const currentTime = Number.isFinite(audio.currentTime)
        ? audio.currentTime
        : 0;
      if (messageId && duration > 0)
        updateLivePersonaPlayback(messageId, currentTime / duration);
      // The reveal store emits only on word boundaries. Keep public playback
      // timing useful without rerendering Live Mode controls at 60 fps.
      if (
        duration !== liveState.duration ||
        currentTime - liveState.currentTime >= 0.25
      ) {
        liveEmit({
          ...liveState,
          status: 'speaking',
          messageId,
          currentTime,
          duration,
        });
      }
      liveProgressFrame = requestAnimationFrame(updateProgress);
    };
    liveEmit({
      ...liveState,
      status: 'speaking',
      messageId,
      currentTime: 0,
      duration:
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : synthesizedDuration,
    });
    prefetchNextLiveReply();
    if (typeof requestAnimationFrame === 'function')
      liveProgressFrame = requestAnimationFrame(updateProgress);
  } catch (error) {
    // HTTP failures reached the board and are counted by the TTS route. Only
    // browser-only transport/playback failures are recorded here.
    if (!(error instanceof Error && /^Live TTS \d+$/.test(error.message)))
      recordLiveMetric('failed_tts_calls');
    if (gen === liveToken) {
      if (liveAudio) {
        liveAudio.pause();
        liveAudio.removeAttribute('src');
        liveAudio.load();
        liveAudio = null;
      }
      stopLiveProgress();
      const autoplayBlocked =
        error instanceof DOMException && error.name === 'NotAllowedError';
      if (autoplayBlocked && item.kind === 'reply') blockedAutoplayItem = item;
      else if (liveCurrentMessageId)
        releaseLivePersonaReveal(liveCurrentMessageId);
      liveCurrentKind = null;
      liveCurrentMessageId = null;
      liveEmit({
        ...liveState,
        status: 'idle',
        conversationId: null,
        messageId: null,
        text: null,
        currentTime: 0,
        duration: 0,
        error: autoplayBlocked
          ? 'Audio permission required'
          : error instanceof Error
            ? error.message
            : 'Live speech failed',
      });
      void speakLiveNext();
    }
  }
}
export function enqueueLiveSpeech(
  conversationId: string,
  text: string,
  priority: LiveSpeechPriority = 'focused',
  source: 'registry' | undefined = undefined,
  playback: 'latest' | 'fifo' = 'latest',
  speechProfile?: { voice?: string; lang?: string },
): boolean {
  if (source !== 'registry') return false;
  const value = validateLiveStatus(text);
  if (!value || liveState.muted) return false;
  if (liveState.error) liveEmit({ ...liveState, error: null });
  if (
    priority === 'background-completion' &&
    !liveState.announceCompletions &&
    liveFocus !== null &&
    conversationId !== liveFocus
  )
    return false;
  if (
    playback === 'latest' &&
    priority !== 'background-completion' &&
    liveCurrentKind !== 'reply'
  ) {
    interruptLiveAudio();
    stopTts();
  }
  // Ordinary registry state coalesces. Work narration uses an event FIFO so
  // short markers remain sequential even when the server produces them faster
  // than this client synthesizes or plays them.
  const item: SpeechItem = {
    conversationId,
    text: value,
    priority,
    sequence: ++liveSeq,
    kind: playback === 'fifo' ? 'narration' : 'status',
    voice: speechProfile?.voice,
    lang: speechProfile?.lang,
  };
  if (
    playback === 'latest' &&
    liveQueue.some((entry) => entry.conversationId === conversationId)
  )
    recordLiveMetric('queue_drops');
  liveQueue = queueSpeech(liveQueue, item);
  // Latest-state updates may take ownership immediately. FIFO narration only
  // starts here when the shared player is idle.
  void speakLiveNext();
  return true;
}

export function enqueueLiveReply(input: {
  messageId: string;
  conversationId: string;
  text: string;
  voice?: string;
  lang?: string;
  projectId?: string;
  audioUrl?: string;
  startOffsetSeconds?: number;
  onStarted?: () => void;
}): boolean {
  const value = input.text.trim();
  if (spokenLiveMessageIds.has(input.messageId)) return true;
  if (
    !value ||
    value.length > 20_000 ||
    liveState.muted ||
    input.conversationId !== liveFocus
  )
    return false;
  spokenLiveMessageIds.add(input.messageId);
  if (spokenLiveMessageIds.size > 500)
    spokenLiveMessageIds.delete(spokenLiveMessageIds.values().next().value!);
  liveQueue = queueSpeech(liveQueue, {
    kind: 'reply',
    messageId: input.messageId,
    conversationId: input.conversationId,
    text: value,
    voice: input.voice,
    lang: input.lang,
    projectId: input.projectId,
    audioUrl: input.audioUrl,
    startOffsetSeconds: input.startOffsetSeconds,
    onStarted: input.onStarted,
    priority: 'focused',
    sequence: ++liveSeq,
  });
  // Keep exactly one turn ahead: generate the queued voice while the current
  // persona is speaking, but playback still remains strictly sequential.
  prefetchNextLiveReply();
  markLivePersonaWaiting(input.messageId);
  void speakLiveNext();
  return true;
}

export interface TtsOptions {
  voice?: string;
  lang?: string;
  format?: string; // wav | flac | ogg
  steps?: number;
  maxChunkChars?: number;
  projectId?: string; // for resolving the project's normalizer LLM
  prepareUrl?: string; // durable persona asset lazy-generation endpoint
  audioUrl?: string; // durable persona asset download endpoint
  cacheKey?: string; // stable native cache key for durable message speech
  conversationId?: string; // native streaming download identity
  messageId?: string; // native streaming download identity
  exactChunks?: string[]; // already-normalized phrases that must keep cache identity
  /**
   * Voice previews pick the engine explicitly: 'server' is the Supertonic
   * voice even when this Android device speaks replies itself; 'device' is
   * this device's voice for `lang`, with no server fallback.
   */
  engine?: 'server' | 'device';
  onError?: (message: string) => void; // device preview failure reason
}

interface TtsState {
  activeId: string | null;
  loading: boolean; // true between toggle and the first clip starting to play
}

let state: TtsState = { activeId: null, loading: false };
const listeners = new Set<() => void>();

function emit(next: TtsState) {
  state = next;
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// --- playback internals ---
// Each synthesized clip gets its OWN <audio> element that begins decoding the
// moment its bytes arrive (preload), so playback flows clip→clip with ~no gap.
// (A single shared element only loads the next blob AFTER the previous ends,
// which added an audible gap per sentence.)
interface Clip {
  el: HTMLAudioElement;
  url: string;
}
let queue: Clip[] = []; // preloaded clips awaiting playback
let current: Clip | null = null;
let producing = false; // still synthesizing chunks
let token = 0; // generation token; bumped on every stop/new play to abandon stale work

function revoke(url: string) {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
}

function enqueueClip(url: string) {
  const el = new Audio();
  el.preload = 'auto';
  el.src = url;
  el.load(); // start decoding now, while earlier clips are still playing
  queue.push({ el, url });
  playNext();
}

function maybeFinish() {
  if (
    !producing &&
    !current &&
    queue.length === 0 &&
    (state.activeId || state.loading)
  ) {
    emit({ activeId: null, loading: false });
  }
}

function playNext() {
  if (current || queue.length === 0) return;
  const clip = queue.shift()!;
  current = clip;
  let done = false;
  const advance = () => {
    if (done) return; // one transition per clip (ended / error / play-reject can overlap)
    done = true;
    clip.el.onended = null;
    clip.el.onerror = null;
    revoke(clip.url);
    if (current === clip) current = null;
    playNext();
    maybeFinish();
  };
  clip.el.onended = advance;
  clip.el.onerror = advance;
  clip.el.play().catch(advance); // autoplay rejects are rare (toggle is click-driven)
}

export function stopTts() {
  token++;
  producing = false;
  if (current) {
    current.el.pause();
    current.el.onended = null;
    current.el.onerror = null;
    revoke(current.url);
    current = null;
  }
  for (const clip of queue) {
    clip.el.removeAttribute('src');
    revoke(clip.url);
  }
  queue = [];
  if (state.activeId || state.loading) emit({ activeId: null, loading: false });
}

// Reduce a rendered assistant message to just its spoken reply.
//
// Thinking, tool calls, bash output, and errors are all rendered as markdown
// blockquotes (see markdown-content.tsx), and the final reply prose never is —
// so dropping fenced code + blockquote lines leaves exactly what to speak.
function stripMarkdown(s: string): string {
  const withoutCode = s.replace(/```[\s\S]*?```/g, '\n'); // fenced code blocks
  const withoutQuotes = withoutCode
    .split('\n')
    .filter((line) => !/^\s*>/.test(line)) // blockquotes = thinking / tools / output / errors
    .join('\n');
  return withoutQuotes
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const SENTENCE_RE = /[^.!?…:;—]+[.!?…:;—]+(?:["'’”»)\]]+)?|\S[^.!?…:;—]*$/g;
function chunkText(text: string, maxChars: number): string[] {
  const clean = stripMarkdown(text);
  if (!clean) return [];
  const sentences = clean.match(SENTENCE_RE) ?? [clean];
  const chunks: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > maxChars) {
      flush();
      let w = '';
      for (const word of s.split(' ')) {
        if (w && w.length + 1 + word.length > maxChars) {
          chunks.push(w);
          w = '';
        }
        w = w ? `${w} ${word}` : word;
      }
      if (w) chunks.push(w);
      continue;
    }
    if (cur && cur.length + 1 + s.length > maxChars) flush();
    cur = cur ? `${cur} ${s}` : s;
  }
  flush();
  return chunks;
}

function mime(fmt: string): string {
  return 'audio/' + (fmt === 'wav' ? 'wav' : fmt === 'flac' ? 'flac' : 'ogg');
}

// Resolve speech-ready sentences: server-side LLM normalization (numbers→words,
// abbreviations, currency, sentence segmentation), with a client-side strip +
// split fallback if the endpoint is unavailable. The server also detects the
// language the text is written in, which the voice then speaks.
async function getSentences(
  text: string,
  opts: TtsOptions,
): Promise<{ sentences: string[]; language?: string }> {
  try {
    const r = await apiFetch(API_BASE_URL + '/api/tts/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        lang: opts.lang,
        projectId: opts.projectId,
        detectLanguage: true,
      }),
    });
    if (r.ok) {
      const data = (await r.json()) as {
        sentences?: unknown;
        language?: unknown;
      };
      if (Array.isArray(data.sentences) && data.sentences.length > 0) {
        return {
          sentences: (data.sentences as unknown[])
            .map(String)
            .filter((s) => s.trim()),
          language:
            typeof data.language === 'string' ? data.language : undefined,
        };
      }
    }
  } catch {
    /* fall through to client-side chunking */
  }
  return { sentences: chunkText(text, opts.maxChunkChars ?? 240) };
}

async function synthChunk(
  text: string,
  opts: TtsOptions,
  fmt: string,
  gen: number,
): Promise<string | null> {
  if (opts.engine === 'device') {
    try {
      const url = await previewDeviceSpeech(text, opts.lang);
      return gen === token ? url : null;
    } catch (error) {
      if (gen === token)
        opts.onError?.(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  const deviceUrl =
    opts.engine === 'server'
      ? null
      : await synthesizeDeviceSpeech(text, opts.lang);
  if (deviceUrl) return gen === token ? deviceUrl : null;
  const r = await apiFetch(API_BASE_URL + '/api/tts/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voice: opts.voice,
      lang: opts.lang,
      steps: opts.steps,
      format: fmt,
    }),
  });
  if (gen !== token) return null; // superseded / stopped while in flight
  if (!r.ok) throw new Error(`TTS ${r.status}`);
  const nativeUrl = await nativeSpeechFileUrl(
    r,
    r.headers.get('X-TTS-Asset-Id') || `clip-${gen}`,
  );
  if (nativeUrl) return nativeUrl;
  const buf = await r.arrayBuffer();
  if (gen !== token) return null;
  return URL.createObjectURL(new Blob([buf], { type: mime(fmt) }));
}

/** Toggle playback for a message: starts it, or stops it if already active. */
export async function toggleTts(
  id: string,
  text: string,
  opts: TtsOptions = {},
): Promise<void> {
  if (state.activeId === id) {
    stopTts();
    return;
  }
  cancelLiveSpeech(); // ordinary TTS and Live Mode share one voice
  stopTts(); // stop whatever is currently playing
  const gen = ++token;
  const fmt = opts.format || 'ogg';

  emit({ activeId: id, loading: true });
  producing = true;

  if (opts.audioUrl) {
    let releaseConnectionMode: (() => void) | null = null;
    try {
      // The cache holds server audio; with device TTS the native download
      // below returns the device rendition (or falls back) instead.
      const cachedUrl =
        opts.cacheKey && !(await deviceTtsEnabled())
          ? await cachedNativeSpeechFileUrl(opts.cacheKey)
          : null;
      if (cachedUrl) {
        if (gen !== token) return;
        emit({ activeId: id, loading: false });
        enqueueClip(cachedUrl);
        return;
      }
      releaseConnectionMode = holdConnectionMode();
      if (isBridgeSupported()) {
        const conversationId = opts.conversationId;
        const messageId = opts.messageId;
        if (!conversationId || !messageId)
          throw new Error('Native speech identity is missing');
        let nativeUrl = await cacheNativeSpeech(conversationId, messageId);
        if (!nativeUrl && opts.prepareUrl) {
          const prepared = await apiFetch(opts.prepareUrl, { method: 'POST' });
          if (!prepared.ok) throw new Error(`TTS ${prepared.status}`);
          nativeUrl = await cacheNativeSpeech(conversationId, messageId);
        }
        if (!nativeUrl) throw new Error('Native speech download failed');
        if (gen !== token) return;
        emit({ activeId: id, loading: false });
        enqueueClip(nativeUrl);
        return;
      }
      if (opts.prepareUrl) {
        const prepared = await apiFetch(opts.prepareUrl, { method: 'POST' });
        if (!prepared.ok) throw new Error(`TTS ${prepared.status}`);
      }
      const response = await apiFetch(opts.audioUrl);
      if (!response.ok) throw new Error(`TTS ${response.status}`);
      if (gen !== token) return;
      const nativeUrl = await nativeSpeechFileUrl(
        response,
        opts.cacheKey || response.headers.get('X-TTS-Asset-Id') || id,
      );
      const url =
        nativeUrl ||
        URL.createObjectURL(
          new Blob([await response.arrayBuffer()], {
            type: response.headers.get('content-type') || 'audio/ogg',
          }),
        );
      if (gen !== token) {
        if (!nativeUrl) revoke(url);
        return;
      }
      emit({ activeId: id, loading: false });
      enqueueClip(url);
    } catch {
      if (gen === token) stopTts();
    } finally {
      releaseConnectionMode?.();
      if (gen === token) {
        producing = false;
        maybeFinish();
      }
    }
    return;
  }

  // Normalize ordinary prose first. Live narration supplies its original
  // bounded phrases so replay uses the same content-addressed cache entries.
  let chunks: string[];
  if (opts.exactChunks) {
    chunks = opts.exactChunks.map((chunk) => chunk.trim()).filter(Boolean);
  } else {
    try {
      const prepared = await getSentences(text, opts);
      chunks = prepared.sentences;
      if (prepared.language) opts = { ...opts, lang: prepared.language };
    } catch {
      chunks = [];
    }
  }
  if (gen !== token) return; // stopped during preparation
  // Safety: bound per-chunk length so no single synth runs long enough to hit
  // the server-call timeout (an over-long sentence is the usual cause).
  const cap = opts.maxChunkChars ?? 240;
  chunks = chunks.flatMap((s) => (s.length > cap ? chunkText(s, cap) : [s]));
  if (chunks.length === 0) {
    producing = false;
    emit({ activeId: null, loading: false });
    return;
  }

  let failures = 0;
  try {
    for (const chunk of chunks) {
      if (gen !== token) return; // stopped or superseded
      let url: string | null = null;
      try {
        url = await synthChunk(chunk, opts, fmt, gen);
      } catch {
        // Skip a single failed/timed-out sentence and keep the rest playing,
        // but bail if the server is clearly unhealthy (avoid long hangs).
        if (++failures >= 2) {
          if (gen === token) stopTts();
          return;
        }
        continue;
      }
      if (gen !== token) return;
      if (url) {
        failures = 0;
        if (state.loading) emit({ activeId: id, loading: false });
        enqueueClip(url);
      }
    }
  } finally {
    if (gen === token) {
      producing = false;
      maybeFinish();
    }
  }
}

export function useTts() {
  useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  return {
    activeId: state.activeId,
    loading: state.loading,
    toggle: toggleTts,
    stop: stopTts,
  };
}
