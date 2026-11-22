import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { getLiveVoiceRouter } from './routes.js';

async function serve(configured: boolean) {
  const calls: Array<{ mimetype: string; filename?: string }> = [];
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req: any, _res, next) => {
    if (req.headers.authorization === 'Bearer test')
      req.authUser = { id: 'user' };
    next();
  });
  app.use(
    '/api',
    getLiveVoiceRouter({
      transcriptionConfigured: configured,
      transcriber: () =>
        configured
          ? async (_buffer, mimetype, filename) => {
              calls.push({ mimetype, filename });
              return 'hello live mode';
            }
          : null,
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, () => resolve(value));
  });
  const address = server.address();
  return {
    server,
    calls,
    base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
  };
}

describe('Live Voice shared Whisper endpoint', () => {
  let configured: Awaited<ReturnType<typeof serve>>;
  let unavailable: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    configured = await serve(true);
    unavailable = await serve(false);
  });
  afterAll(() => {
    configured.server.close();
    unavailable.server.close();
  });

  test('reports a calm text-only fallback when shared transcription is unconfigured', async () => {
    const config = (await fetch(
      `${unavailable.base}/api/live-voice/config`,
    ).then((r) => r.json())) as any;
    expect(config.transcriptionConfigured).toBe(false);
    expect(config.utteranceTransport).toBe('json-base64-v1');
    expect(config.websocketUrl).toBeUndefined();
    const form = new FormData();
    form.append(
      'audio',
      new Blob(['wav'], { type: 'audio/wav' }),
      'utterance.wav',
    );
    const response = await fetch(
      `${unavailable.base}/api/live-voice/utterance`,
      { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form },
    );
    expect(response.status).toBe(503);
  });

  test('requires authentication and sends same-origin utterances through the shared transcriber', async () => {
    const unauthenticated = new FormData();
    unauthenticated.append(
      'audio',
      new Blob(['wav'], { type: 'audio/wav' }),
      'utterance.wav',
    );
    expect(
      (
        await fetch(`${configured.base}/api/live-voice/utterance`, {
          method: 'POST',
          body: unauthenticated,
        })
      ).status,
    ).toBe(401);
    const form = new FormData();
    form.append(
      'audio',
      new Blob(['wav'], { type: 'audio/wav' }),
      'utterance.wav',
    );
    const response = await fetch(
      `${configured.base}/api/live-voice/utterance`,
      { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form },
    );
    expect(await response.json()).toEqual({
      outcome: 'transcribed',
      text: 'hello live mode',
    });
    expect(configured.calls).toEqual([
      { mimetype: 'audio/wav', filename: 'utterance.wav' },
    ]);
  });

  test('accepts the explicit base64 audio contract used by native Capacitor', async () => {
    const response = await fetch(
      `${configured.base}/api/live-voice/utterance`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioBase64: Buffer.from('wav').toString('base64'),
          mimetype: 'audio/wav',
          filename: 'utterance.wav',
        }),
      },
    );
    expect(await response.json()).toEqual({
      outcome: 'transcribed',
      text: 'hello live mode',
    });
    expect(configured.calls.at(-1)).toEqual({
      mimetype: 'audio/wav',
      filename: 'utterance.wav',
    });
  });
});
