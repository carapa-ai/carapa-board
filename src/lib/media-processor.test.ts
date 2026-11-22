import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

let transcriberCalled = false;

mock.module('../modules/whisper/index.js', () => ({
  getTranscriber: () =>
    transcriberCalled
      ? null
      : async () => {
          transcriberCalled = true;
          return 'whisper text';
        },
}));

const { enrichMessageContent } = await import('./media-processor.js');

describe('enrichMessageContent nativeAudio', () => {
  let tmpDir: string;

  beforeEach(() => {
    transcriberCalled = false;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-proc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('skips Whisper when nativeAudio is true', async () => {
    const originalFetch = globalThis.fetch;
    // `typeof fetch` (bun-types) declares a `preconnect` member, so a bare
    // async function is not assignable. Object.assign attaches a no-op so the
    // mock satisfies the type without changing call behaviour.
    globalThis.fetch = Object.assign(
      async () =>
        new Response(Buffer.from('fake-audio'), {
          status: 200,
          headers: { 'Content-Type': 'audio/ogg' },
        }),
      { preconnect: () => {} },
    );

    try {
      const result = await enrichMessageContent(
        {
          id: '1',
          chat_id: 'main',
          sender: 'User',
          content: '',
          sender_name: 'User',
          timestamp: new Date().toISOString(),
          attachments: [
            {
              type: 'audio',
              url: 'http://example/audio.ogg',
              mimetype: 'audio/ogg',
              filename: 'voice.ogg',
            },
          ],
        },
        {
          saveDir: tmpDir,
          containerPrefix: '/workspace/ipc/uploads',
          nativeAudio: true,
        },
      );

      expect(transcriberCalled).toBe(false);
      expect(result.forAgent).toContain('[Voice message: voice.ogg]');
      expect(result.attachments?.[0]?.path).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
