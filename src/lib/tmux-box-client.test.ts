/**
 * TmuxBoxClient tests — SSE parser + REST call shape.
 *
 * The board calls into carapa-box via:
 *   POST   /api/tmux/attach → SSE stream of `init` + `delta` events
 *   POST   /api/tmux/exec
 *   POST   /api/tmux/resize
 *   DELETE /api/tmux/detach
 *
 * These tests mock `globalThis.fetch` so we don't need a live carapa-box.
 * A tiny ReadableStream-from-async-iterator helper stands in for the SSE
 * body so we can drive the parser with deterministic byte sequences.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'bun:test';

import { TmuxBoxClient } from './tmux-box-client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a `ReadableStream<Uint8Array>` that emits the supplied string chunks
 * one-by-one (the way a real fetch chunked body would). Using queued async
 * ticks gives the parser time to process each chunk before the next one
 * arrives — closer to network behaviour than dumping the whole string in a
 * single read.
 */
function sseStreamFrom(
  chunks: string[],
  subscribed: Promise<void> = Promise.resolve(),
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (i > 0) await subscribed;
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

// Capture fetch calls so each test can assert URL/method/body/headers.
interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
let fetchCalls: FetchCall[];
let fetchImpl: typeof fetch;
let originalFetch: typeof fetch | null;

beforeAll(() => {
  originalFetch = globalThis.fetch;
  fetchImpl = (async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(
        init.headers as Record<string, string>,
      )) {
        headers[k] = v as string;
      }
    }
    fetchCalls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    // Hand back the queued response for this call.
    const responder = (fetchImpl as any).__responses.shift();
    if (!responder) {
      throw new Error(`fetch: no queued response for ${url}`);
    }
    return responder();
  }) as typeof fetch;
  (fetchImpl as any).__responses = [] as Array<() => Response>;
  globalThis.fetch = fetchImpl;
});

afterAll(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

beforeEach(() => {
  fetchCalls = [];
  (fetchImpl as any).__responses = [];
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TmuxBoxClient.attach — SSE parsing', () => {
  test('init event resolves with { streamId, session, cols, rows, scrollback }', async () => {
    const sse = [
      'event: init\ndata: {"streamId":"box-1","session":"sess-A","cols":120,"rows":40,"scrollback":"hello\\n"}\n\n',
    ];
    (fetchImpl as any).__responses = [
      () =>
        new Response(sseStreamFrom(sse), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ];

    const client = new TmuxBoxClient('http://localhost:3100', 'tok-abc');
    const handle = await client.attach('stack1', 'svc1', 'inst1', {
      session: 'sess-A',
      cols: 120,
      rows: 40,
    });

    expect(handle.init).toEqual({
      streamId: 'box-1',
      session: 'sess-A',
      cols: 120,
      rows: 40,
      scrollback: 'hello\n',
    });

    // The POST went out with the right URL, method, body, and Bearer auth.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://localhost:3100/api/tmux/attach');
    expect(fetchCalls[0].method).toBe('POST');
    expect(fetchCalls[0].headers['Authorization']).toBe('Bearer tok-abc');
    expect(fetchCalls[0].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(fetchCalls[0].body)).toEqual({
      stack: 'stack1',
      service: 'svc1',
      instance: 'inst1',
      session: 'sess-A',
      cols: 120,
      rows: 40,
    });

    handle.close();
  });

  test('delta events are fanned out to onDelta listeners in order', async () => {
    // The init event always arrives first per carapa-box's protocol. Then
    // the deltas — split across multiple chunks to also exercise the
    // cross-chunk buffering in the SSE parser.
    const subscribed = Promise.withResolvers<void>();
    const sse = [
      'event: init\ndata: {"streamId":"box-1","session":"sess-A","cols":1,"rows":1,"scrollback":""}\n\n',
      'event: delta\ndata: {"delta":"part-1"}\n\n',
      'event: delta\ndata: {"delta":"part-2"}\n\nevent: delta\n',
      'data: {"delta":"part-3"}\n\n',
      // SSE comment line mixed in — must be ignored.
      ': keepalive\nevent: delta\ndata: {"delta":"part-4"}\n\n',
    ];
    (fetchImpl as any).__responses = [
      () =>
        new Response(sseStreamFrom(sse, subscribed.promise), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ];

    const client = new TmuxBoxClient('http://localhost:3100', 'tok-abc');
    const handle = await client.attach('stack1', 'svc1', 'inst1', {
      session: 'sess-A',
    });

    const received: string[] = [];
    const delivered = Promise.withResolvers<void>();
    handle.onDelta((chunk) => {
      received.push(chunk);
      if (received.length === 4) delivered.resolve();
    });

    subscribed.resolve();
    await delivered.promise;
    expect(received).toEqual(['part-1', 'part-2', 'part-3', 'part-4']);

    handle.close();
  });

  test('exit events are observable when the shell ends immediately after init', async () => {
    const sse = [
      'event: init\ndata: {"streamId":"box-exit","session":"sess-exit","cols":80,"rows":24,"scrollback":""}\n\n',
      'event: exit\ndata: {"streamId":"box-exit","reason":"shell-exited"}\n\n',
    ];
    (fetchImpl as any).__responses = [
      () =>
        new Response(sseStreamFrom(sse), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ];

    const client = new TmuxBoxClient('http://localhost:3100');
    const handle = await client.attach('s', 'svc', 'i', {
      session: 'sess-exit',
    });

    let exits = 0;
    const delivered = Promise.withResolvers<void>();
    handle.onExit(() => {
      exits += 1;
      delivered.resolve();
    });
    await delivered.promise;
    expect(exits).toBe(1);
  });

  test('a bad init payload (no streamId/session) rejects the attach promise', async () => {
    const sse = ['event: init\ndata: {"scrollback":"x"}\n\n'];
    (fetchImpl as any).__responses = [
      () =>
        new Response(sseStreamFrom(sse), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ];

    const client = new TmuxBoxClient('http://localhost:3100');
    await expect(
      client.attach('s', 'svc', 'i', { session: 'sess' }),
    ).rejects.toThrow(/init payload missing streamId\/session/);
  });

  const sseResponse = (chunks: string[]) => () =>
    new Response(sseStreamFrom(chunks), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

  test('error frame before init rejects with the box reason, not the generic ended-before-init', async () => {
    (fetchImpl as any).__responses = [
      sseResponse([
        'event: error\ndata: {"streamId":"x","error":"Error: no such session\\nat foo"}\n\n',
      ]),
    ];
    const client = new TmuxBoxClient('http://localhost:3100');
    const err = await client
      .attach('s', 'svc', 'i', { session: 'sess' })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe(
      'tmux attach: box reported error before init: Error: no such session',
    );
    expect((err as Error).message).not.toMatch(/ended before init/);
  });

  test('non-JSON error data uses the raw text, bounded to 240 chars', async () => {
    (fetchImpl as any).__responses = [
      sseResponse([`event: error\ndata: ${'x'.repeat(500)}\n\n`]),
    ];
    const client = new TmuxBoxClient('http://localhost:3100');
    const err = await client
      .attach('s', 'svc', 'i', { session: 'sess' })
      .catch((e: Error) => e);
    const prefix = 'tmux attach: box reported error before init: ';
    expect((err as Error).message).toBe(prefix + 'x'.repeat(240));
  });

  test('error frame after init does not reject and the handle stays usable', async () => {
    (fetchImpl as any).__responses = [
      sseResponse([
        'event: init\ndata: {"streamId":"b","session":"s","cols":1,"rows":1,"scrollback":""}\n\n',
        'event: error\ndata: {"streamId":"b","error":"late failure"}\n\n',
      ]),
    ];
    const client = new TmuxBoxClient('http://localhost:3100');
    const handle = await client.attach('s', 'svc', 'i', { session: 's' });
    expect(handle.init.streamId).toBe('b');
    (fetchImpl as any).__responses = [
      () => jsonResponse(200, { isError: false, stdout: 'ok' }),
    ];
    await expect(handle.exec({ input: 'aA==' })).resolves.toEqual({
      isError: false,
      stdout: 'ok',
    });
    handle.close();
  });

  test('non-2xx attach response rejects', async () => {
    (fetchImpl as any).__responses = [
      () => new Response('boom', { status: 500, statusText: 'Server Error' }),
    ];
    const client = new TmuxBoxClient('http://localhost:3100');
    await expect(
      client.attach('s', 'svc', 'i', { session: 'sess' }),
    ).rejects.toThrow();
  });

  test('a trailing /mcp on the URL is stripped (mirrors SandboxClient)', async () => {
    const sse = [
      'event: init\ndata: {"streamId":"b","session":"s","cols":1,"rows":1,"scrollback":""}\n\n',
    ];
    (fetchImpl as any).__responses = [
      () =>
        new Response(sseStreamFrom(sse), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ];
    const client = new TmuxBoxClient('http://localhost:3100/mcp');
    const handle = await client.attach('s', 'svc', 'i', { session: 's' });
    expect(fetchCalls[0].url).toBe('http://localhost:3100/api/tmux/attach');
    handle.close();
  });
});

describe('TmuxBoxClient.attach handle — REST calls', () => {
  async function attachWithHandle(): Promise<{
    client: TmuxBoxClient;
    handle: Awaited<ReturnType<TmuxBoxClient['attach']>>;
  }> {
    const sse = [
      'event: init\ndata: {"streamId":"box-1","session":"sess-A","cols":120,"rows":40,"scrollback":""}\n\n',
    ];
    (fetchImpl as any).__responses = [
      () =>
        new Response(sseStreamFrom(sse), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ];
    const client = new TmuxBoxClient('http://localhost:3100', 'tok-1');
    const handle = await client.attach('s', 'svc', 'i', {
      session: 'sess-A',
      cols: 120,
      rows: 40,
    });
    // Reset the call log so exec/resize/detach calls can be inspected in
    // isolation from the attach POST.
    fetchCalls = [];
    return { client, handle };
  }

  test('exec() POSTs base64 input to /api/tmux/exec and returns the result', async () => {
    const { handle } = await attachWithHandle();
    (fetchImpl as any).__responses = [
      () => jsonResponse(200, { isError: false, stdout: 'ignored' }),
    ];

    const result = await handle.exec({
      input: Buffer.from('ls\n').toString('base64'),
    });
    expect(result).toEqual({ isError: false, stdout: 'ignored' });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://localhost:3100/api/tmux/exec');
    expect(fetchCalls[0].method).toBe('POST');
    expect(fetchCalls[0].headers['Authorization']).toBe('Bearer tok-1');
    // The box's zod schema requires `stack` and `service` (and accepts
    // `instance`); the attach handle carries them in its internal context
    // so every subsequent call echoes them. The wire is base64-encoded
    // because the board's `TmuxClient.sendKeys` already encoded the raw
    // keystrokes for safe JSON transport — without `inputBase64: true`
    // the box would forward the base64 string verbatim to `tmux send-keys`,
    // and the shell would receive literal `aA==` instead of the typed
    // `h` that was on the wire at the bash tab.
    expect(JSON.parse(fetchCalls[0].body)).toEqual({
      stack: 's',
      service: 'svc',
      instance: 'i',
      session: 'sess-A',
      input: Buffer.from('ls\n').toString('base64'),
      inputBase64: true,
    });

    handle.close();
  });

  test('detach() DELETEs /api/tmux/detach with { session, streamId }', async () => {
    const { handle } = await attachWithHandle();
    (fetchImpl as any).__responses = [() => emptyResponse(204)];

    await handle.detach();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://localhost:3100/api/tmux/detach');
    expect(fetchCalls[0].method).toBe('DELETE');
    // Same reasoning: box's detachSchema requires stack/service.
    expect(JSON.parse(fetchCalls[0].body)).toEqual({
      stack: 's',
      service: 'svc',
      instance: 'i',
      session: 'sess-A',
      streamId: 'box-1',
    });

    handle.close();
  });
});
