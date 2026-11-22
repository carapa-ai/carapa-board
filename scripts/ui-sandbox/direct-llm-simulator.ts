export type SimulatorRequestStatus =
  | 'connected'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface SimulatorRequestSnapshot {
  id: number;
  status: SimulatorRequestStatus;
  model: string | null;
  input: unknown;
  lastUserText: string;
}

interface SimulatorRequest extends SimulatorRequestSnapshot {
  controller: ReadableStreamDefaultController<Uint8Array>;
}

export interface DirectLlmSimulator {
  baseUrl: string;
  controlUrl: string;
  port: number;
  requests(): SimulatorRequestSnapshot[];
  stop(): void;
}

const encoder = new TextEncoder();

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map(extractText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return extractText(item.content);
  return '';
}

function lastUserText(input: unknown): string {
  if (!Array.isArray(input)) return '';
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index] as Record<string, unknown> | null;
    if (item?.role === 'user') return extractText(item.content);
  }
  return '';
}

function snapshot(request: SimulatorRequest): SimulatorRequestSnapshot {
  return {
    id: request.id,
    status: request.status,
    model: request.model,
    input: request.input,
    lastUserText: request.lastUserText,
  };
}

function sse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: unknown,
): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

function parseRequestId(
  pathname: string,
): { id: number; action: string } | undefined {
  const match = pathname.match(
    /^\/control\/requests\/(\d+)\/(chunk|release|fail)$/,
  );
  if (!match) return undefined;
  return { id: Number(match[1]), action: match[2] };
}

function completeRequest(record: SimulatorRequest, text: string): void {
  if (text) {
    record.status = 'streaming';
    sse(record.controller, {
      type: 'response.output_text.delta',
      delta: text,
    });
  }
  record.status = 'completed';
  sse(record.controller, {
    type: 'response.completed',
    response: {
      id: `sim-response-${record.id}`,
      status: 'completed',
      usage: {
        input_tokens: 10,
        output_tokens: Math.max(1, Math.ceil(text.length / 4)),
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  record.controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  record.controller.close();
}

function defaultReplyText(record: SimulatorRequest): string {
  return `Simulated response to: ${record.lastUserText}`;
}

export interface DirectLlmSimulatorOptions {
  /** Complete every new request immediately instead of holding its stream. */
  autoRelease?: boolean;
  /** Reply text used while auto-release is on; defaults to the echo reply. */
  autoReleaseText?: string;
}

export function startDirectLlmSimulator(
  port = 0,
  onAbort?: (request: SimulatorRequestSnapshot) => void,
  options: DirectLlmSimulatorOptions = {},
): DirectLlmSimulator {
  const active = new Map<number, SimulatorRequest>();
  const history: SimulatorRequest[] = [];
  let nextId = 1;
  let autoRelease = options.autoRelease === true;
  let autoReleaseText = options.autoReleaseText;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/health' && request.method === 'GET') {
        return Response.json({ ok: true });
      }
      if (url.pathname === '/control/requests' && request.method === 'GET') {
        return Response.json(history.map(snapshot));
      }
      if (url.pathname === '/control/auto-release') {
        if (request.method === 'POST') {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          if (typeof body.enabled !== 'boolean') {
            return Response.json(
              { error: '"enabled" must be a boolean' },
              { status: 400 },
            );
          }
          autoRelease = body.enabled;
          autoReleaseText =
            typeof body.text === 'string' ? body.text : undefined;
        } else if (request.method !== 'GET') {
          return Response.json({ error: 'Not found' }, { status: 404 });
        }
        return Response.json({
          enabled: autoRelease,
          text: autoReleaseText ?? null,
        });
      }
      if (url.pathname === '/v1/responses' && request.method === 'POST') {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return Response.json(
            { error: { message: 'Invalid JSON body' } },
            { status: 400 },
          );
        }
        if (body.stream !== true) {
          return Response.json(
            { error: { message: 'The UI simulator requires stream=true' } },
            { status: 400 },
          );
        }

        const id = nextId++;
        let record!: SimulatorRequest;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            record = {
              id,
              status: 'connected',
              model: typeof body.model === 'string' ? body.model : null,
              input: body.input,
              lastUserText: lastUserText(body.input),
              controller,
            };
            active.set(id, record);
            history.push(record);
            request.signal.addEventListener(
              'abort',
              () => {
                if (!active.delete(id)) return;
                record.status = 'aborted';
                onAbort?.(snapshot(record));
                try {
                  controller.close();
                } catch {}
              },
              { once: true },
            );
            sse(controller, {
              type: 'response.created',
              response: { id: `sim-response-${id}`, status: 'in_progress' },
            });
            if (autoRelease) {
              active.delete(id);
              completeRequest(
                record,
                autoReleaseText ?? defaultReplyText(record),
              );
            }
          },
          cancel() {
            if (!active.delete(id)) return;
            record.status = 'aborted';
            onAbort?.(snapshot(record));
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }

      const control = parseRequestId(url.pathname);
      if (control && request.method === 'POST') {
        const record = active.get(control.id);
        if (!record) {
          return Response.json(
            { error: 'Request is not active' },
            { status: 409 },
          );
        }
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        if (control.action === 'chunk') {
          const text = typeof body.text === 'string' ? body.text : '';
          record.status = 'streaming';
          sse(record.controller, {
            type: 'response.output_text.delta',
            delta: text,
          });
          return Response.json(snapshot(record));
        }
        if (control.action === 'fail') {
          const message =
            typeof body.message === 'string' && body.message
              ? body.message
              : 'Simulated provider failure';
          record.status = 'failed';
          active.delete(record.id);
          sse(record.controller, {
            type: 'response.failed',
            response: {
              status: 'failed',
              error: { message, code: 'simulated_failure' },
            },
          });
          record.controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          record.controller.close();
          return Response.json(snapshot(record));
        }

        active.delete(record.id);
        completeRequest(
          record,
          typeof body.text === 'string' ? body.text : defaultReplyText(record),
        );
        return Response.json(snapshot(record));
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    controlUrl: `http://127.0.0.1:${server.port}/control`,
    port: server.port,
    requests: () => history.map(snapshot),
    stop() {
      for (const request of active.values()) {
        request.status = 'aborted';
        try {
          request.controller.close();
        } catch {}
      }
      active.clear();
      server.stop(true);
    },
  };
}
