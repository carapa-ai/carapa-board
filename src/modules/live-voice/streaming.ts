import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { logger } from '../../logger.js';
import { getTranscriber } from '../whisper/index.js';
import {
  LIVE_STT_API_URL,
  LIVE_STT_FINAL_TIMEOUT_MS,
  LIVE_STT_LANGUAGE,
  LIVE_STT_MAX_BUFFERED_BYTES,
  LIVE_STT_MAX_PENDING_UTTERANCES,
  LIVE_STT_MAX_UTTERANCE_MS,
  LIVE_STT_MODEL,
  LIVE_STT_PROMPT,
  LIVE_STT_PROTOCOL,
  LIVE_STT_SAMPLE_RATE,
} from './config.js';
import { recordLiveVoiceMetric } from './telemetry.js';
import { MEETING_LANGUAGES } from '../../config.js';
import { getMeetingLanguage } from '../../lib/meeting-languages.js';
import { isRecord } from '../../lib/type-guards.js';

type Transcriber = NonNullable<ReturnType<typeof getTranscriber>>;

export interface LiveGpuTranscriptionOptions {
  model: string;
  language?: string;
  prompt?: string;
  signal: AbortSignal;
}

export type LiveGpuTranscriber = (
  wav: Buffer,
  options: LiveGpuTranscriptionOptions,
) => Promise<string>;

export interface LiveVoiceStreamingDeps {
  gpuApiUrl?: string;
  model?: string;
  language?: string;
  prompt?: string;
  resolveTranscriber?: () => Transcriber | null;
  gpuTranscribe?: LiveGpuTranscriber;
  finalTimeoutMs?: number;
  /** Authenticated user's persisted preference; null means unset. */
  userLanguage?: string | null;
  userPreferenceBound?: boolean;
  /** Lazily resolves the bound user's persisted preference once the session
   * receives its start message (bound at the authenticated upgrade). A
   * lookup failure must degrade to the operator language, never abort the
   * session. */
  resolveBoundUserLanguage?: () => Promise<string | null>;
  /** Hard deadline for the bound-language lookup. A lookup that hangs past
   * it degrades to the operator language instead of delaying `ready` until
   * the client's own timeout fires. */
  userLanguageLookupTimeoutMs?: number;
}

export function normalizeLiveVoiceLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const option = getMeetingLanguage(MEETING_LANGUAGES, value);
  return option && option.code.toLowerCase() !== 'auto'
    ? option.code
    : undefined;
}

function whisperLanguageHint(value: string | undefined): string | undefined {
  if (!value || value.toLowerCase() === 'auto') return undefined;
  return value;
}

const USER_LANGUAGE_LOOKUP_TIMEOUT_MS = 3_000;

/** Resolves with `value`'s result, or the sentinel `'timeout'` when it does
 * not settle within `timeoutMs`. The original promise stays handled either
 * way, so a lookup that both fails and loses the race cannot produce an
 * unhandled rejection. */
function resolveWithin<T>(
  value: Promise<T>,
  timeoutMs: number,
): Promise<T | 'timeout'> {
  value.catch(() => undefined);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    value.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface PendingUtterance {
  id: string;
  pcm: Buffer;
  endedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  resolving: boolean;
}

interface FinalResult {
  text?: string;
  source?: 'gpu' | 'cpu-fallback';
  error?: string;
}

const LIVE_VOICE_MAX_FRAME_BYTES = 512 * 1024;
const liveVoiceWss = new WebSocketServer({
  noServer: true,
  maxPayload: LIVE_VOICE_MAX_FRAME_BYTES,
});

const liveVoiceClientUsers = new WeakMap<WebSocket, string | undefined>();

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.alloc(0);
}

export function pcm16ToWav(
  pcm: Buffer,
  sampleRate = LIVE_STT_SAMPLE_RATE,
): Buffer {
  const wav = Buffer.allocUnsafe(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

async function transcribeGpu(
  apiUrl: string,
  wav: Buffer,
  options: LiveGpuTranscriptionOptions,
): Promise<string> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
    'utterance.wav',
  );
  form.append('model', options.model);
  form.append('response_format', 'text');
  if (options.language) form.append('language', options.language);
  if (options.prompt) form.append('prompt', options.prompt);

  const response = await fetch(apiUrl, {
    method: 'POST',
    body: form,
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Live GPU STT error ${response.status}: ${body}`);
  }
  return (await response.text()).trim();
}

function sendJson(socket: WebSocket, value: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

/** Attach an authenticated browser stream. The browser owns phrase VAD; each
 * committed 16 kHz phrase goes straight to the warm GPU transcription API.
 * Retained PCM is sent to the CPU path only after a session-level GPU failure. */
export function attachLiveVoiceStreamingSession(
  client: WebSocket,
  deps: LiveVoiceStreamingDeps = {},
): void {
  const gpuApiUrl = deps.gpuApiUrl ?? LIVE_STT_API_URL;
  const model = deps.model ?? LIVE_STT_MODEL;
  // LIVE_STT_LANGUAGE is trusted operator configuration and may intentionally
  // contain a code outside the meeting picker catalog. Only the browser's
  // protocol value is constrained by MEETING_LANGUAGES.
  let language: string | undefined = deps.language ?? LIVE_STT_LANGUAGE;
  const prompt = deps.prompt ?? LIVE_STT_PROMPT;
  const resolveTranscriber = deps.resolveTranscriber ?? getTranscriber;
  const gpuTranscriber =
    deps.gpuTranscribe ??
    ((wav, options) => transcribeGpu(gpuApiUrl, wav, options));
  const finalTimeoutMs = deps.finalTimeoutMs ?? LIVE_STT_FINAL_TIMEOUT_MS;
  const gpuConfigured = Boolean(gpuApiUrl || deps.gpuTranscribe);

  let started = false;
  // True between accepting a start message and setting `started` (the
  // preference lookup below is async). Rejects a second start that arrives
  // in that window instead of resolving the language twice.
  let startPending = false;
  let closingAfterDrain = false;
  let disposed = false;
  let mode: 'gpu' | 'cpu-fallback' = gpuConfigured ? 'gpu' : 'cpu-fallback';
  let currentChunks: Buffer[] = [];
  let currentBytes = 0;
  let totalPendingBytes = 0;
  const pending = new Map<string, PendingUtterance>();
  const commitOrder: string[] = [];
  const results = new Map<string, FinalResult>();
  const gpuQueue: string[] = [];
  let activeGpuUtteranceId: string | null = null;
  let gpuAbort: AbortController | null = null;
  let fallbackQueue: Promise<void> = Promise.resolve();

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    gpuAbort?.abort();
    gpuAbort = null;
    for (const utterance of pending.values()) {
      if (utterance.timer) clearTimeout(utterance.timer);
    }
    pending.clear();
    currentChunks = [];
    currentBytes = 0;
  };

  const maybeFinishStop = () => {
    if (!closingAfterDrain || pending.size || results.size) return;
    sendJson(client, { type: 'stopped' });
    if (client.readyState === WebSocket.OPEN) client.close(1000, 'stopped');
  };

  const flushResults = () => {
    while (commitOrder.length) {
      const id = commitOrder[0]!;
      const result = results.get(id);
      if (!result) break;
      commitOrder.shift();
      results.delete(id);
      const utterance = pending.get(id);
      if (utterance?.timer) clearTimeout(utterance.timer);
      if (utterance) totalPendingBytes -= utterance.pcm.length;
      pending.delete(id);
      if (result.error) {
        sendJson(client, {
          type: 'error',
          utteranceId: id,
          message: result.error,
          recoverable: true,
        });
      } else {
        const latencyMs = utterance ? Date.now() - utterance.endedAt : 0;
        recordLiveVoiceMetric('utterance_end_to_final_stt_ms', latencyMs, {
          source: result.source,
        });
        sendJson(client, {
          type: 'final',
          utteranceId: id,
          text: result.text ?? '',
          source: result.source,
        });
      }
    }
    maybeFinishStop();
  };

  const settle = (id: string, result: FinalResult) => {
    if (!pending.has(id) || results.has(id)) {
      recordLiveVoiceMetric('stt_suppressed_results', 1, {
        reason: 'duplicate-or-late',
        utteranceId: id,
      });
      return;
    }
    if (commitOrder[0] !== id) {
      recordLiveVoiceMetric('stt_out_of_order_results', 1, {
        action: 'buffered',
        utteranceId: id,
      });
    }
    results.set(id, result);
    flushResults();
  };

  const fallbackOne = (id: string, reason: string): Promise<void> => {
    const utterance = pending.get(id);
    if (!utterance || utterance.resolving || results.has(id))
      return fallbackQueue;
    utterance.resolving = true;
    if (utterance.timer) clearTimeout(utterance.timer);
    recordLiveVoiceMetric('stt_fallbacks', 1, { reason });
    fallbackQueue = fallbackQueue.then(async () => {
      if (disposed || !pending.has(id) || results.has(id)) return;
      const transcriber = resolveTranscriber();
      if (!transcriber) {
        settle(id, { error: 'Voice transcription fallback is unavailable' });
        return;
      }
      try {
        const text = await transcriber(
          pcm16ToWav(utterance.pcm),
          'audio/wav',
          `utterance-${id}.wav`,
          {
            language: whisperLanguageHint(language) ?? null,
            prompt: prompt || undefined,
          },
        );
        if (!disposed)
          settle(id, { text: text.trim(), source: 'cpu-fallback' });
      } catch (error) {
        if (!disposed)
          settle(id, {
            error:
              error instanceof Error ? error.message : 'Transcription failed',
          });
      }
    });
    return fallbackQueue;
  };

  const switchToFallback = (reason: string) => {
    if (disposed || mode === 'cpu-fallback') return;
    mode = 'cpu-fallback';
    recordLiveVoiceMetric('stt_upstream_failures', 1, { reason });
    sendJson(client, { type: 'ready', mode, reason });
    gpuQueue.length = 0;
    activeGpuUtteranceId = null;
    gpuAbort?.abort();
    gpuAbort = null;
    for (const id of commitOrder) void fallbackOne(id, reason);
  };

  const dispatchNextGpu = () => {
    if (disposed || mode !== 'gpu' || activeGpuUtteranceId) return;
    let id = gpuQueue.shift();
    while (id && (!pending.has(id) || results.has(id))) id = gpuQueue.shift();
    if (!id) return;
    const utterance = pending.get(id);
    if (!utterance) return;

    activeGpuUtteranceId = id;
    const controller = new AbortController();
    gpuAbort = controller;
    utterance.timer = setTimeout(() => {
      if (mode === 'gpu' && activeGpuUtteranceId === id) {
        switchToFallback('gpu-final-timeout');
      }
    }, finalTimeoutMs);

    void gpuTranscriber(pcm16ToWav(utterance.pcm), {
      model,
      language: whisperLanguageHint(language),
      prompt: prompt || undefined,
      signal: controller.signal,
    })
      .then((text) => {
        if (
          disposed ||
          mode !== 'gpu' ||
          activeGpuUtteranceId !== id ||
          controller.signal.aborted
        )
          return;
        if (utterance.timer) clearTimeout(utterance.timer);
        utterance.resolving = true;
        activeGpuUtteranceId = null;
        gpuAbort = null;
        settle(id, { text: text.trim(), source: 'gpu' });
        dispatchNextGpu();
      })
      .catch((error: unknown) => {
        if (disposed || mode !== 'gpu' || controller.signal.aborted) return;
        logger.warn({ err: error }, 'Live GPU STT request failed');
        switchToFallback('gpu-inference-error');
      });
  };

  const commit = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
      sendJson(client, {
        type: 'error',
        message: 'Invalid utterance id',
        recoverable: true,
      });
      return;
    }
    if (!currentBytes) {
      sendJson(client, {
        type: 'error',
        utteranceId: id,
        message: 'No audio received for utterance',
        recoverable: true,
      });
      return;
    }
    if (
      pending.has(id) ||
      pending.size >= LIVE_STT_MAX_PENDING_UTTERANCES ||
      totalPendingBytes + currentBytes > LIVE_STT_MAX_BUFFERED_BYTES
    ) {
      sendJson(client, {
        type: 'error',
        utteranceId: id,
        message: 'Too many pending voice utterances',
        recoverable: true,
      });
      currentChunks = [];
      currentBytes = 0;
      return;
    }
    const pcm = Buffer.concat(currentChunks, currentBytes);
    currentChunks = [];
    currentBytes = 0;
    const utterance: PendingUtterance = {
      id,
      pcm,
      endedAt: Date.now(),
      resolving: false,
    };
    pending.set(id, utterance);
    commitOrder.push(id);
    totalPendingBytes += pcm.length;

    if (mode === 'gpu') {
      gpuQueue.push(id);
      dispatchNextGpu();
    } else {
      void fallbackOne(id, 'gpu-unavailable');
    }
  };

  client.on('message', async (raw, isBinary) => {
    if (disposed) return;
    if (isBinary) {
      if (!started) {
        sendJson(client, {
          type: 'error',
          message: 'Start the voice session before sending audio',
          recoverable: false,
        });
        return;
      }
      const chunk = rawDataBuffer(raw);
      const maxUtteranceBytes =
        (LIVE_STT_SAMPLE_RATE * 2 * LIVE_STT_MAX_UTTERANCE_MS) / 1000;
      if (
        !chunk.length ||
        chunk.length % 2 ||
        currentBytes + chunk.length > maxUtteranceBytes
      ) {
        sendJson(client, {
          type: 'error',
          message: 'Voice utterance exceeds the PCM limit',
          recoverable: true,
        });
        currentChunks = [];
        currentBytes = 0;
        return;
      }
      currentChunks.push(chunk);
      currentBytes += chunk.length;
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(rawDataBuffer(raw).toString('utf8'));
    } catch {
      // Invalid JSON is handled like any other invalid protocol message.
    }
    if (!isRecord(message)) {
      sendJson(client, {
        type: 'error',
        message: 'Invalid voice protocol message',
        recoverable: false,
      });
      return;
    }
    if (message.type === 'start') {
      if (started || startPending) {
        sendJson(client, {
          type: 'error',
          message: started
            ? 'Voice session already started'
            : 'Voice session is already starting',
          recoverable: false,
        });
        return;
      }
      if (
        message.protocol !== LIVE_STT_PROTOCOL ||
        message.sampleRate !== LIVE_STT_SAMPLE_RATE
      ) {
        sendJson(client, {
          type: 'error',
          message: 'Unsupported voice protocol or sample rate',
          recoverable: false,
        });
        return;
      }
      startPending = true;
      if (deps.userPreferenceBound) {
        if (message.dictation === true) {
          if (deps.userLanguage !== undefined && deps.userLanguage !== null) {
            language = normalizeLiveVoiceLanguage(deps.userLanguage);
          } else if (deps.resolveBoundUserLanguage) {
            try {
              const bound = await resolveWithin(
                deps.resolveBoundUserLanguage(),
                deps.userLanguageLookupTimeoutMs ??
                  USER_LANGUAGE_LOOKUP_TIMEOUT_MS,
              );
              if (bound === 'timeout') {
                logger.warn(
                  'Live voice preference lookup timed out; using operator language',
                );
              } else if (bound !== null && bound !== undefined) {
                language = normalizeLiveVoiceLanguage(bound);
              }
            } catch (error) {
              // The socket must survive a failed preference lookup: the
              // session degrades to the operator language instead of
              // closing, which the browser would see as a silent stop.
              logger.warn(
                { err: error },
                'Live voice preference lookup failed; using operator language',
              );
            }
          }
        } else if (message.language !== undefined) {
          // Live Mode sends the chat's explicit language choice; the
          // persisted preference governs dictation only.
          language = normalizeLiveVoiceLanguage(message.language);
        }
      } else if (message.language !== undefined) {
        language = normalizeLiveVoiceLanguage(message.language);
      }
      started = true;
      startPending = false;
      recordLiveVoiceMetric('stt_stream_connect_ms', 0, {
        transport: mode === 'gpu' ? 'gpu-http' : 'cpu-fallback',
      });
      sendJson(client, { type: 'ready', mode });
      return;
    }
    if (!started) return;
    if (message.type === 'commit' && typeof message.utteranceId === 'string') {
      commit(message.utteranceId);
      return;
    }
    if (message.type === 'discard') {
      currentChunks = [];
      currentBytes = 0;
      return;
    }
    if (message.type === 'stop') {
      if (currentBytes && typeof message.utteranceId === 'string') {
        commit(message.utteranceId);
      }
      closingAfterDrain = true;
      maybeFinishStop();
    }
  });
  client.on('close', cleanup);
  client.on('error', (error) => {
    logger.debug({ err: error }, 'Live voice client socket error');
    cleanup();
  });
}

liveVoiceWss.on('connection', (client) => {
  attachLiveVoiceStreamingSession(client);
});

export function handleLiveVoiceUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: LiveVoiceStreamingDeps = {},
): void {
  const userId = (req as IncomingMessage & { __userId?: string }).__userId;
  liveVoiceWss.handleUpgrade(req, socket, head, (client) => {
    liveVoiceClientUsers.set(client, userId);
    attachLiveVoiceStreamingSession(client, deps);
  });
}

/** Close the open live-voice sockets of a user whose account was disabled. */
export function closeLiveVoiceUserSockets(userId: string): void {
  for (const client of liveVoiceWss.clients) {
    if (liveVoiceClientUsers.get(client) === userId)
      client.close(1008, 'Account disabled');
  }
}

export function closeLiveVoiceWebSocketServer(): void {
  for (const client of liveVoiceWss.clients) client.close(1001, 'shutdown');
}
