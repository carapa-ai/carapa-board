import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test';
import {
  registeredGroups,
  applyGroupUpdateInMemory,
} from '../../state-manager.js';
import { callCarapaMailTool } from './client.js';

/**
 * Drives the real MCP SDK client against a stubbed `fetch` (the transport's
 * default fetch), so the SDK's own request timeout and abort wiring are exercised.
 */
const JID = 'mail-client-test@g.us';
const FOLDER = 'mail-client-test';

const realFetch = globalThis.fetch;
let toolCallSignal: AbortSignal | undefined;
let onToolCall: (() => void) | undefined;
let toolCallGate: Promise<void> = Promise.resolve();

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
}

const stubFetch = (async (_url: unknown, init?: RequestInit) => {
  if (init?.method !== 'POST') return new Response(null, { status: 405 });
  const msg = JSON.parse(String(init.body));
  if (msg.method === 'initialize') {
    return json({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: {},
        serverInfo: { name: 'fake-mail', version: '1.0.0' },
      },
    });
  }
  if (msg.method === 'tools/call') {
    const signal = init.signal as AbortSignal;
    toolCallSignal = signal;
    onToolCall?.();
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
      void toolCallGate.then(resolve);
    });
    return json({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'read ok' }] },
    });
  }
  return new Response(null, { status: 202 });
}) as unknown as typeof fetch;

beforeAll(() => {
  registeredGroups[JID] = {
    name: 'Mail client test',
    folder: FOLDER,
    trigger: '@x',
    added_at: new Date(0).toISOString(),
    settings: { carapaMailEnabled: true, carapaMailToken: 'tok' },
  };
  applyGroupUpdateInMemory(JID, {}); // rebuild the folder index
  globalThis.fetch = stubFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
  // The folder index has no public removal path; disable the project instead.
  applyGroupUpdateInMemory(JID, { settings: {} });
  delete registeredGroups[JID];
});

describe('callCarapaMailTool', () => {
  test('waits past the SDK 60 s default up to the 120 s ceiling', async () => {
    let gate!: () => void;
    toolCallGate = new Promise<void>((r) => (gate = r));
    const started = new Promise<void>((r) => (onToolCall = r));
    jest.useFakeTimers();
    try {
      const call = callCarapaMailTool(FOLDER, 'carapamail_read_email', {});
      await started;
      jest.advanceTimersByTime(70_000); // would trip the SDK's 60 s default
      gate();
      expect(await call).toBe('read ok');
    } finally {
      jest.useRealTimers();
    }
  });

  test('caller abort closes the in-flight request and returns the aborted error', async () => {
    toolCallGate = new Promise<void>(() => {});
    const started = new Promise<void>((r) => (onToolCall = r));
    const ac = new AbortController();
    const call = callCarapaMailTool(FOLDER, 'carapamail_send', {}, ac.signal);
    await started;
    ac.abort();
    expect(await call).toBe('Error: carapa-mail request aborted');
    expect(toolCallSignal?.aborted).toBe(true);
  });
});
