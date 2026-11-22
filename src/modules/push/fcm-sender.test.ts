import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from 'bun:test';
import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// config.ts reads these at import time, so they are set before sender import.
// This file runs in its own Bun process (see scripts/test-file-groups.sh).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-sender-test-'));
const saPath = path.join(tmpDir, 'sa.json');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(
  saPath,
  JSON.stringify({
    client_email: 'test@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://token.test/token',
  }),
);
process.env.FCM_PROJECT_ID = 'test-project';
process.env.FCM_SERVICE_ACCOUNT_PATH = saPath;

const { sendPing } = await import('./fcm-sender.js');

const realFetch = globalThis.fetch;
const TOKENS = [{ device_id: 'dev1', token: 'tok1', platform: 'android' }];

let onStall: () => void = () => {};

/** Headers arrive immediately; the body never completes until the request is aborted. */
function stalledBodyResponse(signal: AbortSignal | null | undefined): Response {
  onStall();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () =>
        controller.error(new DOMException('aborted', 'AbortError')),
      );
    },
  });
  return new Response(body, { status: 200 });
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Response,
): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) =>
    handler(String(url), init ?? {})) as typeof fetch;
}

const tokenOk = () =>
  new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
    status: 200,
  });

beforeAll(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  jest.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('fcm-sender body deadline', () => {
  test('stalled token-endpoint body rejects within the timeout', async () => {
    const stalled = new Promise<void>((r) => (onStall = r));
    stubFetch((_url, init) => stalledBodyResponse(init.signal));
    const p = sendPing(TOKENS).then(
      () => 'resolved',
      (err) => String(err),
    );
    await stalled;
    jest.advanceTimersByTime(5_000);
    expect(await p).toContain('abort');
  });

  test('stalled send-endpoint body yields a transient result, not a hang', async () => {
    stubFetch((url, init) =>
      url.includes('token.test') ? tokenOk() : stalledBodyResponse(init.signal),
    );
    const stalled = new Promise<void>((r) => (onStall = r));
    const p = sendPing(TOKENS);
    await stalled;
    jest.advanceTimersByTime(5_000);
    expect(await p).toEqual({ delivered: [], stale: [], failed: [] });
  });

  test('success path delivers and leaves no timer pending', async () => {
    stubFetch((url) =>
      url.includes('token.test')
        ? tokenOk()
        : new Response('{}', { status: 200 }),
    );
    expect(await sendPing(TOKENS)).toEqual({
      delivered: ['dev1'],
      stale: [],
      failed: [],
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('UNREGISTERED error body is still classified stale', async () => {
    stubFetch((url) =>
      url.includes('token.test')
        ? tokenOk()
        : new Response(
            JSON.stringify({
              error: {
                status: 'NOT_FOUND',
                details: [{ errorCode: 'UNREGISTERED' }],
              },
            }),
            { status: 404 },
          ),
    );
    expect(await sendPing(TOKENS)).toEqual({
      delivered: [],
      stale: ['dev1'],
      failed: [],
    });
  });
});
