import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import {
  attachLiveVoiceStreamingSession,
  type LiveGpuTranscriptionOptions,
  type LiveVoiceStreamingDeps,
} from './streaming.js';

const servers: Server[] = [];
const websocketServers: WebSocketServer[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (server.address() as { port: number }).port;
}

async function serveBoard(deps: LiveVoiceStreamingDeps): Promise<string> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  websocketServers.push(wss);
  wss.on('connection', (client) =>
    attachLiveVoiceStreamingSession(client, deps),
  );
  return `ws://127.0.0.1:${await listen(server)}`;
}

function messages(socket: WebSocket) {
  const queue: Record<string, any>[] = [];
  const waiters: Array<(message: Record<string, any>) => void> = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  return () =>
    new Promise<Record<string, any>>((resolve) => {
      const queued = queue.shift();
      if (queued) resolve(queued);
      else waiters.push(resolve);
    });
}

async function connect(url: string, language?: string) {
  const socket = new WebSocket(url);
  const next = messages(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'start',
      protocol: 'carapa.live-stt.v2',
      sampleRate: 16_000,
      ...(language === undefined ? {} : { language }),
    }),
  );
  return { socket, next };
}

async function flushFrames(socket: WebSocket): Promise<void> {
  const pong = once(socket, 'pong');
  socket.ping();
  await pong;
}

afterEach(async () => {
  await Promise.all(
    websocketServers.splice(0).map(async (wss) => {
      const closed = once(wss, 'close');
      for (const client of wss.clients) client.terminate();
      wss.close();
      await closed;
    }),
  );
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections?.();
      // Bun does not emit 'close' after a WebSocket upgrade; the callback
      // still runs once the server has stopped.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe('Live Voice streaming proxy', () => {
  test('rejects malformed session setup and oversized PCM', async () => {
    const boardUrl = await serveBoard({ gpuApiUrl: '' });
    const socket = new WebSocket(boardUrl);
    const next = messages(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(Buffer.alloc(2));
    expect(await next()).toMatchObject({ type: 'error', recoverable: false });
    socket.send(
      JSON.stringify({
        type: 'start',
        protocol: 'carapa.live-stt.v2',
        sampleRate: 48_000,
      }),
    );
    expect(await next()).toMatchObject({
      type: 'error',
      recoverable: false,
      message: 'Unsupported voice protocol or sample rate',
    });
    socket.close();

    const valid = await connect(boardUrl);
    await valid.next();
    valid.socket.send(Buffer.alloc(480_002));
    expect(await valid.next()).toMatchObject({
      type: 'error',
      recoverable: true,
      message: 'Voice utterance exceeds the PCM limit',
    });
    valid.socket.close();
  });

  test('stop commits the active phrase, drains it, and closes cleanly', async () => {
    const boardUrl = await serveBoard({
      gpuApiUrl: '',
      resolveTranscriber: () => async () => 'flushed on stop',
    });
    const { socket, next } = await connect(boardUrl);
    await next();
    socket.send(Buffer.alloc(800, 1));
    socket.send(JSON.stringify({ type: 'stop', utteranceId: 'last' }));
    expect(await next()).toMatchObject({
      type: 'final',
      utteranceId: 'last',
      text: 'flushed on stop',
    });
    expect(await next()).toMatchObject({ type: 'stopped' });
  });

  test('sends browser-detected PCM directly to GPU and returns its final', async () => {
    const calls: Buffer[] = [];
    let receivedOptions: LiveGpuTranscriptionOptions | undefined;
    const boardUrl = await serveBoard({
      gpuApiUrl: 'http://gpu.test/v1/audio/transcriptions',
      model: 'test-streaming-model',
      language: 'ro',
      prompt: 'Carapa',
      resolveTranscriber: () => null,
      gpuTranscribe: async (wav, options) => {
        calls.push(wav);
        receivedOptions = options;
        return 'gpu phrase';
      },
    });
    const { socket, next } = await connect(boardUrl);
    expect(await next()).toMatchObject({ type: 'ready', mode: 'gpu' });
    socket.send(Buffer.alloc(3_200, 7));
    await flushFrames(socket);
    expect(calls).toHaveLength(0);
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'one' }));
    expect(await next()).toMatchObject({
      type: 'final',
      utteranceId: 'one',
      text: 'gpu phrase',
      source: 'gpu',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subarray(0, 4).toString()).toBe('RIFF');
    expect(calls[0]!.readUInt32LE(24)).toBe(16_000);
    expect(calls[0]!.subarray(44)).toHaveLength(3_200);
    expect(receivedOptions).toMatchObject({
      model: 'test-streaming-model',
      language: 'ro',
      prompt: 'Carapa',
    });
    socket.close();
  });

  test('uses CPU immediately only when no GPU endpoint is configured', async () => {
    const calls: Buffer[] = [];
    const boardUrl = await serveBoard({
      gpuApiUrl: '',
      resolveTranscriber: () => async (buffer) => {
        calls.push(buffer);
        return 'cpu phrase';
      },
    });
    const { socket, next } = await connect(boardUrl);
    expect(await next()).toMatchObject({ type: 'ready', mode: 'cpu-fallback' });
    socket.send(Buffer.alloc(1_600, 3));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'fallback' }));
    expect(await next()).toMatchObject({
      type: 'final',
      utteranceId: 'fallback',
      text: 'cpu phrase',
      source: 'cpu-fallback',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subarray(44)).toHaveLength(1_600);
    socket.close();
  });

  test('omits the language hint for Auto', async () => {
    let receivedLanguage: string | null | undefined = 'unexpected';
    const boardUrl = await serveBoard({
      language: 'auto',
      gpuTranscribe: async (_wav, options) => {
        receivedLanguage = options.language;
        return 'auto phrase';
      },
    });
    const { socket, next } = await connect(boardUrl);
    await next();
    socket.send(Buffer.alloc(1_600, 1));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'auto' }));
    expect(await next()).toMatchObject({ text: 'auto phrase' });
    expect(receivedLanguage).toBeUndefined();
    socket.close();
  });

  test('passes an explicit Auto omission through the CPU fallback options', async () => {
    let receivedLanguage: string | null | undefined = 'unexpected';
    const boardUrl = await serveBoard({
      gpuApiUrl: '',
      language: 'auto',
      resolveTranscriber: () => async (_wav, _type, _filename, options) => {
        receivedLanguage = options?.language;
        return 'auto cpu phrase';
      },
    });
    const { socket, next } = await connect(boardUrl);
    await next();
    socket.send(Buffer.alloc(1_600, 1));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'auto-cpu' }));
    expect(await next()).toMatchObject({ text: 'auto cpu phrase' });
    expect(receivedLanguage).toBeNull();
    socket.close();
  });

  test('normalizes an untrusted protocol language to Auto', async () => {
    let receivedLanguage: string | undefined = 'unexpected';
    const boardUrl = await serveBoard({
      gpuTranscribe: async (_wav, options) => {
        receivedLanguage = options.language;
        return 'normalized phrase';
      },
    });
    const { socket, next } = await connect(boardUrl, 'not-a-language');
    await next();
    socket.send(Buffer.alloc(1_600, 1));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'invalid' }));
    expect(await next()).toMatchObject({ text: 'normalized phrase' });
    expect(receivedLanguage).toBeUndefined();
    socket.close();
  });

  test('retains the operator fallback when the bound user preference is unset', async () => {
    let receivedLanguage: string | undefined;
    const boardUrl = await serveBoard({
      language: 'fr',
      userLanguage: null,
      userPreferenceBound: true,
      gpuTranscribe: async (_wav, options) => {
        receivedLanguage = options.language;
        return 'operator phrase';
      },
    });
    const socket = new WebSocket(boardUrl);
    const next = messages(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(
      JSON.stringify({
        type: 'start',
        protocol: 'carapa.live-stt.v2',
        sampleRate: 16_000,
        dictation: true,
      }),
    );
    await next();
    socket.send(Buffer.alloc(1_600, 1));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'operator' }));
    expect(await next()).toMatchObject({ text: 'operator phrase' });
    expect(receivedLanguage).toBe('fr');
    socket.close();
  });

  test('resolves the bound user language lazily through the upgrade thunk', async () => {
    let receivedLanguage: string | undefined;
    const boardUrl = await serveBoard({
      userPreferenceBound: true,
      resolveBoundUserLanguage: async () => 'ro',
      gpuTranscribe: async (_wav, options) => {
        receivedLanguage = options.language;
        return 'thunk phrase';
      },
    });
    const socket = new WebSocket(boardUrl);
    const next = messages(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(
      JSON.stringify({
        type: 'start',
        protocol: 'carapa.live-stt.v2',
        sampleRate: 16_000,
        language: 'en',
        dictation: true,
      }),
    );
    expect(await next()).toMatchObject({ type: 'ready' });
    socket.send(Buffer.alloc(1_600, 1));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'thunk' }));
    expect(await next()).toMatchObject({ text: 'thunk phrase' });
    expect(receivedLanguage).toBe('ro');
    socket.close();
  });

  test('keeps the session ready and operator language when the language lookup throws', async () => {
    let receivedLanguage: string | undefined;
    const boardUrl = await serveBoard({
      language: 'fr',
      userPreferenceBound: true,
      resolveBoundUserLanguage: async () => {
        throw new Error('users table unavailable');
      },
      gpuTranscribe: async (_wav, options) => {
        receivedLanguage = options.language;
        return 'fallback phrase';
      },
    });
    const socket = new WebSocket(boardUrl);
    const next = messages(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(
      JSON.stringify({
        type: 'start',
        protocol: 'carapa.live-stt.v2',
        sampleRate: 16_000,
        language: 'en',
        dictation: true,
      }),
    );
    expect(await next()).toMatchObject({ type: 'ready' });
    socket.send(Buffer.alloc(1_600, 1));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'fallback' }));
    expect(await next()).toMatchObject({ text: 'fallback phrase' });
    expect(receivedLanguage).toBe('fr');
    socket.close();
  });

  test('does not consult the user preference for non-dictation sessions', async () => {
    let lookupCalls = 0;
    let receivedLanguage: string | undefined;
    const boardUrl = await serveBoard({
      language: 'fr',
      userPreferenceBound: true,
      resolveBoundUserLanguage: async () => {
        lookupCalls += 1;
        return 'ro';
      },
      gpuTranscribe: async (_wav, options) => {
        receivedLanguage = options.language;
        return 'live mode phrase';
      },
    });
    const { socket, next } = await connect(boardUrl);
    await next();
    socket.send(Buffer.alloc(1_600, 1));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'live-mode' }));
    expect(await next()).toMatchObject({ text: 'live mode phrase' });
    expect(receivedLanguage).toBe('fr');
    expect(lookupCalls).toBe(0);
    socket.close();
  });

  test('rejects a second start that arrives while the first is still resolving', async () => {
    let releaseLookup: () => void = () => {};
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const boardUrl = await serveBoard({
      userPreferenceBound: true,
      resolveBoundUserLanguage: async () => {
        await lookupGate;
        return 'ro';
      },
      gpuTranscribe: async () => 'gated phrase',
    });
    const socket = new WebSocket(boardUrl);
    const next = messages(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const start = JSON.stringify({
      type: 'start',
      protocol: 'carapa.live-stt.v2',
      sampleRate: 16_000,
      dictation: true,
    });
    socket.send(start);
    socket.send(start);
    // The duplicate lands while the preference lookup is still in flight:
    // it must be rejected instead of resolving the language a second time.
    expect(await next()).toMatchObject({
      type: 'error',
      recoverable: false,
      message: 'Voice session is already starting',
    });
    releaseLookup();
    expect(await next()).toMatchObject({ type: 'ready' });
    socket.close();
  });

  test('degrades to the operator language when the preference lookup hangs', async () => {
    let receivedLanguage: string | undefined;
    const boardUrl = await serveBoard({
      language: 'fr',
      userPreferenceBound: true,
      resolveBoundUserLanguage: () => new Promise<string | null>(() => {}),
      userLanguageLookupTimeoutMs: 50,
      gpuTranscribe: async (_wav, options) => {
        receivedLanguage = options.language;
        return 'hung phrase';
      },
    });
    const socket = new WebSocket(boardUrl);
    const next = messages(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(
      JSON.stringify({
        type: 'start',
        protocol: 'carapa.live-stt.v2',
        sampleRate: 16_000,
        language: 'en',
        dictation: true,
      }),
    );
    // The hung lookup must not hold 'ready' hostage: the timeout degrades to
    // the operator language and the session still transcribes.
    expect(await next()).toMatchObject({ type: 'ready' });
    socket.send(Buffer.alloc(1_600, 1));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'hung' }));
    expect(await next()).toMatchObject({ text: 'hung phrase' });
    expect(receivedLanguage).toBe('fr');
    socket.close();
  });

  test('switches the whole session to CPU only after a GPU request fails', async () => {
    let gpuCalls = 0;
    let cpuLanguage: string | null | undefined;
    const retainedLengths: number[] = [];
    const boardUrl = await serveBoard({
      gpuApiUrl: 'http://gpu.test/v1/audio/transcriptions',
      gpuTranscribe: async () => {
        gpuCalls++;
        throw new Error('GPU unavailable');
      },
      resolveTranscriber: () => async (wav, _type, _filename, options) => {
        cpuLanguage = options?.language;
        retainedLengths.push(wav.subarray(44).length);
        return `cpu phrase ${retainedLengths.length}`;
      },
    });
    const { socket, next } = await connect(boardUrl, 'ro');
    expect(await next()).toMatchObject({ type: 'ready', mode: 'gpu' });
    socket.send(Buffer.alloc(1_600, 2));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'failed' }));
    expect(await next()).toMatchObject({
      type: 'ready',
      mode: 'cpu-fallback',
      reason: 'gpu-inference-error',
    });
    expect(await next()).toMatchObject({
      type: 'final',
      utteranceId: 'failed',
      text: 'cpu phrase 1',
      source: 'cpu-fallback',
    });
    socket.send(Buffer.alloc(800, 3));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'later' }));
    expect(await next()).toMatchObject({
      type: 'final',
      utteranceId: 'later',
      text: 'cpu phrase 2',
      source: 'cpu-fallback',
    });
    expect(gpuCalls).toBe(1);
    expect(cpuLanguage).toBe('ro');
    expect(retainedLengths).toEqual([1_600, 800]);
    socket.close();
  });

  test('treats a GPU request timeout as a whole-session failure', async () => {
    let aborted = false;
    const boardUrl = await serveBoard({
      gpuApiUrl: 'http://gpu.test/v1/audio/transcriptions',
      finalTimeoutMs: 15,
      gpuTranscribe: (_wav, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      resolveTranscriber: () => async () => 'timeout fallback',
    });
    const { socket, next } = await connect(boardUrl);
    await next();
    socket.send(Buffer.alloc(800, 4));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'timeout' }));
    expect(await next()).toMatchObject({
      type: 'ready',
      mode: 'cpu-fallback',
      reason: 'gpu-final-timeout',
    });
    expect(await next()).toMatchObject({
      type: 'final',
      utteranceId: 'timeout',
      text: 'timeout fallback',
      source: 'cpu-fallback',
    });
    expect(aborted).toBe(true);
    socket.close();
  });

  test('keeps rapid GPU phrases isolated and allows one request in flight', async () => {
    const phrases: Buffer[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst: (() => void) | undefined;
    const boardUrl = await serveBoard({
      gpuApiUrl: 'http://gpu.test/v1/audio/transcriptions',
      resolveTranscriber: () => null,
      gpuTranscribe: async (wav) => {
        const number = phrases.push(wav);
        active++;
        maxActive = Math.max(maxActive, active);
        if (number === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        active--;
        return number === 1 ? 'first phrase' : 'second phrase';
      },
    });
    const { socket, next } = await connect(boardUrl);
    await next();
    socket.send(Buffer.alloc(800, 1));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'first' }));
    socket.send(Buffer.alloc(800, 2));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'second' }));
    await flushFrames(socket);
    expect(phrases).toHaveLength(1);
    releaseFirst!();
    expect(await next()).toMatchObject({
      type: 'final',
      utteranceId: 'first',
      text: 'first phrase',
    });
    expect(await next()).toMatchObject({
      type: 'final',
      utteranceId: 'second',
      text: 'second phrase',
    });
    expect(phrases).toHaveLength(2);
    expect(phrases[0]!.subarray(44)).not.toEqual(phrases[1]!.subarray(44));
    expect(maxActive).toBe(1);
    socket.close();
  });

  test('serializes CPU fallback calls and preserves commit order', async () => {
    const firstReleased = Promise.withResolvers<void>();
    let call = 0;
    let active = 0;
    let maxActive = 0;
    const boardUrl = await serveBoard({
      gpuApiUrl: '',
      resolveTranscriber: () => async () => {
        call++;
        const current = call;
        active++;
        maxActive = Math.max(maxActive, active);
        if (current === 1) await firstReleased.promise;
        active--;
        return current === 1 ? 'first phrase' : 'second phrase';
      },
    });
    const { socket, next } = await connect(boardUrl);
    await next();
    socket.send(Buffer.alloc(800, 1));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'first' }));
    socket.send(Buffer.alloc(800, 2));
    socket.send(JSON.stringify({ type: 'commit', utteranceId: 'second' }));
    await flushFrames(socket);
    expect(call).toBe(1);
    firstReleased.resolve();
    expect(await next()).toMatchObject({
      type: 'final',
      utteranceId: 'first',
      text: 'first phrase',
    });
    expect(await next()).toMatchObject({
      type: 'final',
      utteranceId: 'second',
      text: 'second phrase',
    });
    expect(maxActive).toBe(1);
    socket.close();
  });
});
