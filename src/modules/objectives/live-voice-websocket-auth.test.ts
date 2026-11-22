import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { signJwt, signUserJwt, verifyJwt } from '../../lib/auth-jwt.js';

let server: Server;
let baseUrl: string;
let createWsTicket: (sessionId: string) => string;
const persistedUserId = 'live-voice-user';
let resolvedPreferenceUserId: string | null = null;
function defaultPreferenceLookup(userId: string): Promise<string | null> {
  resolvedPreferenceUserId = userId;
  return Promise.resolve('ro');
}
let preferenceLookup: (userId: string) => Promise<string | null> =
  defaultPreferenceLookup;
let originalFetch: typeof fetch;
let capturedGpuLanguage: string | null = null;
let capturedCpuLanguage: string | null = null;
let fetchCount = 0;

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${baseUrl}${path}`);
    socket.onopen = () => {
      resolve(true);
      socket.close();
    };
    socket.onerror = () => {
      resolve(false);
      socket.close();
    };
  });
}

function connectLiveVoice(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl}${path}`);
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'start',
          protocol: 'carapa.live-stt.v2',
          sampleRate: 16_000,
        }),
      );
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      socket.close();
      resolve(message);
    };
    socket.onerror = () => reject(new Error('Live Voice upgrade failed'));
  });
}

beforeAll(async () => {
  process.env.LIVE_STT_API_URL = 'http://gpu.test/transcribe';
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    fetchCount++;
    const body = init?.body;
    if (body instanceof FormData) {
      const value = body.get('language');
      if (fetchCount === 1) {
        capturedGpuLanguage = typeof value === 'string' ? value : null;
        throw new Error('GPU unavailable');
      }
      capturedCpuLanguage = typeof value === 'string' ? value : null;
    }
    return new Response('authenticated gpu result');
  }) as typeof fetch;
  // The upgrade gate reads the session's user row (password-change check). The
  // db module is imported here so it loads after the env var above is set.
  const { initDatabase } = await import('../../db.js');
  await initDatabase(':memory:');
  const websocketEvents = await import('./ws-events.js');
  createWsTicket = websocketEvents.createWsTicket;
  websocketEvents.setSessionVerifier((session) => verifyJwt(session) !== null);
  server = createServer((_req, res) => res.writeHead(404).end());
  websocketEvents.attachWebSocket(server, {
    resolveUserLanguage: (userId) => preferenceLookup(userId),
    resolveTranscriber:
      () => async (_buffer, _mimetype, _filename, options) => {
        capturedCpuLanguage = options?.language ?? null;
        return 'authenticated cpu result';
      },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.close();
  globalThis.fetch = originalFetch;
  delete process.env.LIVE_STT_API_URL;
});

describe('Live Voice WebSocket authentication boundary', () => {
  test('binds the authenticated user preference at the live-voice boundary', async () => {
    const ticket = createWsTicket(signUserJwt(persistedUserId));
    const socket = new WebSocket(
      `${baseUrl}/api/live-voice/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    const messages: Record<string, unknown>[] = [];
    const final = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        messages.push(message);
        if (message.type === 'ready') {
          socket.send(Buffer.alloc(1_600, 1));
          socket.send(JSON.stringify({ type: 'commit', utteranceId: 'auth' }));
        }
        if (message.type === 'final') resolve(message);
      });
      socket.on('error', reject);
    });
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
        language: 'en',
      }),
    );
    expect(await final).toMatchObject({
      text: 'authenticated cpu result',
      source: 'cpu-fallback',
    });
    expect(capturedGpuLanguage).toBe('ro');
    expect(capturedCpuLanguage).toBe('ro');
    expect(resolvedPreferenceUserId).toBe(persistedUserId);
    socket.close();
  });

  test('accepts a same-origin ticket once and rejects unauthenticated upgrades', async () => {
    const ticket = createWsTicket(signUserJwt(persistedUserId));

    expect(
      await connectLiveVoice(
        `/api/live-voice/ws?ticket=${encodeURIComponent(ticket)}`,
      ),
    ).toMatchObject({ type: 'ready' });
    expect(
      await canConnect(
        `/api/live-voice/ws?ticket=${encodeURIComponent(ticket)}`,
      ),
    ).toBe(false);
    expect(await canConnect('/api/live-voice/ws')).toBe(false);
    // A valid non-user session (an agent JWT) would receive unfiltered events.
    const agentTicket = createWsTicket(
      signJwt({
        type: 'agent',
        sub: 'ws-agent',
        scope: { group_folder: 'p', permissions: {} },
      }),
    );
    expect(
      await canConnect(`/api/ws?ticket=${encodeURIComponent(agentTicket)}`),
    ).toBe(false);
    const userTicket = createWsTicket(signUserJwt(persistedUserId));
    expect(
      await canConnect(`/api/ws?ticket=${encodeURIComponent(userTicket)}`),
    ).toBe(true);
  });

  test('keeps the session alive when the preference lookup throws at the boundary', async () => {
    preferenceLookup = async () => {
      throw new Error('preference store unavailable');
    };
    const ticket = createWsTicket(signUserJwt(persistedUserId));
    const socket = new WebSocket(
      `${baseUrl}/api/live-voice/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    const final = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        if (message.type === 'ready') {
          socket.send(Buffer.alloc(1_600, 1));
          socket.send(
            JSON.stringify({
              type: 'commit',
              utteranceId: 'boundary-fallback',
            }),
          );
        }
        if (message.type === 'final') resolve(message);
      });
      socket.on('error', reject);
    });
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
        language: 'en',
      }),
    );
    try {
      const result = await final;
      expect(result).toMatchObject({ type: 'final' });
      expect(typeof result.text).toBe('string');
      // The throwing lookup must degrade to the operator language (unset in
      // this test), so no per-user language hint may reach the transcriber.
      // Every fetch in this test is recorded in capturedCpuLanguage by the
      // shared mock (only the process-wide first fetch uses the GPU slot).
      expect(capturedCpuLanguage).toBeNull();
    } finally {
      preferenceLookup = defaultPreferenceLookup;
    }
    socket.close();
  });
});
