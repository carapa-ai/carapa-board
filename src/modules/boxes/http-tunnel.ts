/**
 * HTTP requests to a remote box's streaming REST endpoints (browser viewer,
 * tmux) over its hub WebSocket. MCP uses text frames; the tunnel uses binary
 * frames on the same socket:
 *
 *   [type u8][stream id u32 BE][payload]
 *
 *   Board -> box   0x01 REQUEST  JSON { method, path, headers, body? (base64) }
 *                  0x04 CANCEL   (empty)
 *   box -> Board   0x11 HEAD     JSON { status, statusText, headers }
 *                  0x12 DATA     raw body bytes
 *                  0x13 END      (empty)
 *                  0x14 ERROR    UTF-8 message
 *
 * The box replays requests against its own HTTP API with its own token and
 * only allows /api/browser/* and /api/tmux/* (carapa-box
 * src/hub/http-tunnel.ts). Board's credentials are never sent.
 */
import type { RawData, WebSocket } from 'ws';
import { logger } from '../../logger.js';
import { isRecord } from '../../lib/type-guards.js';

const FRAME = {
  request: 0x01,
  cancel: 0x04,
  head: 0x11,
  data: 0x12,
  end: 0x13,
  error: 0x14,
} as const;
const FORWARDED_HEADERS = ['content-type', 'accept', 'last-event-id'];
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
/** A consumer that falls this far behind is cut off instead of buffering. */
const MAX_UNREAD_BYTES = 16 * 1024 * 1024;

interface PendingStream {
  resolve(response: Response): void;
  reject(error: Error): void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  cleanup(): void;
}

function encodeFrame(type: number, id: number, payload = ''): Buffer {
  const body = Buffer.from(payload);
  const frame = Buffer.alloc(5 + body.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(id, 1);
  body.copy(frame, 5);
  return frame;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function encodeBody(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body).toString('base64');
  if (body instanceof Uint8Array) return Buffer.from(body).toString('base64');
  throw new TypeError('Unsupported box tunnel request body');
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

export class BoxHttpTunnel {
  private nextId = 1;
  private readonly streams = new Map<number, PendingStream>();
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly boxId: string,
  ) {
    socket.on('message', (data, isBinary) => {
      try {
        if (isBinary) this.onFrame(toBuffer(data));
      } catch (err) {
        logger.warn({ err, boxId: this.boxId }, '[boxes] Invalid tunnel frame');
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const id of [...this.streams.keys()])
        this.finish(id, new Error('Box connection closed'));
    });
  }

  /** A fetch whose origin is ignored: the path is replayed on the box. */
  readonly fetch = (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (this.closed || this.socket.readyState !== this.socket.OPEN)
      return Promise.reject(new Error('Box connection is closed'));
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = new Headers(init.headers);
    const forwarded: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = headers.get(name);
      if (value !== null) forwarded[name] = value;
    }
    let body: string | undefined;
    try {
      body = encodeBody(init.body);
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;

    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        this.send(FRAME.cancel, id);
        this.finish(id, abortError(signal!));
      };
      this.streams.set(id, {
        resolve,
        reject,
        controller: null,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send(
        FRAME.request,
        id,
        JSON.stringify({
          method: (init.method || 'GET').toUpperCase(),
          path: url.pathname + url.search,
          headers: forwarded,
          ...(body === undefined ? {} : { body }),
        }),
      );
    });
  };

  private send(type: number, id: number, payload?: string): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      this.finish(id, new Error('Box connection is closed'));
      return;
    }
    this.socket.send(encodeFrame(type, id, payload), (error) => {
      if (error) this.finish(id, error);
    });
  }

  /** End a stream: settle the pending fetch or error/close its body. */
  private finish(id: number, error?: Error): void {
    const pending = this.streams.get(id);
    if (!pending) return;
    this.streams.delete(id);
    pending.cleanup();
    if (pending.controller) {
      try {
        if (error) pending.controller.error(error);
        else pending.controller.close();
      } catch {
        /* the consumer already cancelled the body */
      }
    } else {
      pending.reject(error ?? new Error('Box tunnel stream ended early'));
    }
  }

  private onFrame(frame: Buffer): void {
    if (frame.length < 5) return;
    const type = frame.readUInt8(0);
    const id = frame.readUInt32BE(1);
    const payload = frame.subarray(5);
    const pending = this.streams.get(id);
    if (!pending) return;
    if (type === FRAME.head && !pending.controller) {
      try {
        const head: unknown = JSON.parse(payload.toString('utf8'));
        if (
          !isRecord(head) ||
          typeof head.status !== 'number' ||
          !Number.isInteger(head.status) ||
          (head.status !== 101 && (head.status < 200 || head.status > 599)) ||
          (head.statusText !== undefined &&
            typeof head.statusText !== 'string') ||
          (head.headers !== undefined &&
            (!isRecord(head.headers) ||
              Object.values(head.headers).some(
                (value) => typeof value !== 'string',
              )))
        )
          throw new Error('Invalid box tunnel response');
        const headers = new Headers(
          head.headers as Record<string, string> | undefined,
        );
        let controller: ReadableStreamDefaultController<Uint8Array> | null =
          null;
        const body = NULL_BODY_STATUS.has(head.status)
          ? null
          : new ReadableStream<Uint8Array>(
              {
                start: (value) => {
                  controller = value;
                },
                cancel: () => {
                  if (this.streams.get(id) !== pending) return;
                  this.streams.delete(id);
                  pending.cleanup();
                  this.send(FRAME.cancel, id);
                },
              },
              new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }),
            );
        const response = new Response(body, {
          status: head.status,
          statusText: head.statusText,
          headers,
        });
        pending.controller = controller;
        pending.resolve(response);
        if (!body) {
          this.streams.delete(id);
          pending.cleanup();
        }
      } catch {
        try {
          this.send(FRAME.cancel, id);
        } finally {
          this.finish(id, new Error('Invalid box tunnel response'));
        }
      }
    } else if (type === FRAME.data && pending.controller) {
      pending.controller.enqueue(new Uint8Array(payload));
      if ((pending.controller.desiredSize ?? 0) < -MAX_UNREAD_BYTES) {
        this.send(FRAME.cancel, id);
        this.finish(id, new Error('Box tunnel consumer is too slow'));
      }
    } else if (type === FRAME.end) {
      this.finish(id);
    } else if (type === FRAME.error) {
      this.finish(id, new Error(payload.toString('utf8')));
    }
  }
}
