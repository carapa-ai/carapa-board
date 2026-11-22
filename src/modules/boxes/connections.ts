/**
 * Live WebSocket connections opened by CarapaBox hosts.
 *
 * A box dials `wss://<board>/api/boxes/connect` with
 *   Authorization: Bearer <box token>
 *   X-Carapa-Box-Id: <box id>
 *   X-Carapa-Box-Kind / -Version / -Capabilities / -Isolation (informational)
 * and then serves its MCP tool registry over that socket. Board holds one MCP
 * client per connected box and routes sandbox tool calls through it.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from '../../logger.js';
import {
  authenticateBox,
  defaultIsolationLevel,
  recordBoxHello,
  touchBox,
  type BoxKind,
  type BoxRecord,
} from './registry.js';
import { BoxSocketTransport } from './ws-transport.js';
import { BoxHttpTunnel } from './http-tunnel.js';

export const BOX_CONNECT_PATH = '/api/boxes/connect';
const PING_INTERVAL_MS = 20_000;
const TOOL_TIMEOUT_MS = 10 * 60_000;

export interface BoxConnection {
  id: string;
  kind: BoxKind;
  version: string | null;
  capabilities: string[];
  isolationLevel: string;
  connectedAt: string;
  client: Client;
  socket: WebSocket;
  /** Streaming REST endpoints (browser viewer, tmux) when the box serves them. */
  httpTunnel?: BoxHttpTunnel;
}

const connections = new Map<string, BoxConnection>();
/**
 * Box ids listeners were last told are online. Tracked per box id, not per
 * connection, so a successor that replaces an announced connection and drops
 * before its own announcement still emits the offline event.
 */
const announcedOnline = new Set<string>();

/**
 * An upgrade in flight for a box id, from before its credential check until
 * it either becomes a registered connection or fails. disconnectBox cancels
 * these so a revoke/rotate landing mid-handshake cannot be missed.
 */
interface PendingHandshake {
  cancelled: { code: number; reason: string } | null;
  ws: WebSocket | null;
}
const pendingHandshakes = new Map<string, Set<PendingHandshake>>();

function beginHandshake(boxId: string): PendingHandshake {
  const handshake: PendingHandshake = { cancelled: null, ws: null };
  const set = pendingHandshakes.get(boxId) ?? new Set();
  set.add(handshake);
  pendingHandshakes.set(boxId, set);
  return handshake;
}

function endHandshake(boxId: string, handshake: PendingHandshake): void {
  const set = pendingHandshakes.get(boxId);
  if (!set) return;
  set.delete(handshake);
  if (!set.size) pendingHandshakes.delete(boxId);
}
const listeners = new Set<
  (event: { boxId: string; online: boolean }) => void
>();
let logSink: ((chunk: string) => void) | null = null;
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024 * 1024,
});

/** sandbox_exec log chunks streamed by a box (MCP logging notifications). */
export function setBoxLogSink(sink: (chunk: string) => void): void {
  logSink = sink;
}

export function onBoxConnectionChange(
  listener: (event: { boxId: string; online: boolean }) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBoxConnection(id: string): BoxConnection | undefined {
  return connections.get(id);
}

export function connectedBoxIds(): string[] {
  return [...connections.keys()];
}

/** Call a tool on a connected box. Throws when the box is offline. */
export async function callBoxTool(
  boxId: string,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const connection = connections.get(boxId);
  if (!connection) throw new Error(`CarapaBox "${boxId}" is offline`);
  return connection.client.callTool({ name, arguments: args }, undefined, {
    signal: options.signal,
    timeout: options.timeoutMs ?? TOOL_TIMEOUT_MS,
    resetTimeoutOnProgress: true,
  });
}

/** Close code telling a box its credential is no longer valid (do not retry). */
export const BOX_REVOKED_CLOSE_CODE = 4001;

/**
 * Close the live socket of a box and cancel any handshake still in flight for
 * it. Revocation, deletion and token rotation use BOX_REVOKED_CLOSE_CODE; any
 * other code lets the box reconnect.
 */
export function disconnectBox(
  id: string,
  reason = 'revoked',
  code = BOX_REVOKED_CLOSE_CODE,
): void {
  const connection = connections.get(id);
  if (connection) connection.socket.close(code, reason);
  for (const handshake of pendingHandshakes.get(id) ?? []) {
    handshake.cancelled = { code, reason };
    handshake.ws?.close(code, reason);
  }
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Handle an HTTP upgrade for BOX_CONNECT_PATH. */
export async function handleBoxUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const authorization = header(req, 'authorization');
  const boxId = header(req, 'x-carapa-box-id');
  const bearer = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  // Registered before the credential check so a revoke/rotate that lands while
  // authenticateBox is still awaiting is seen by disconnectBox.
  const handshake = beginHandshake(boxId);
  // ws never calls the upgrade callback when the client's socket vanished
  // during authentication (or its own handshake checks fail); drop the entry
  // whenever the raw socket closes so the per-box set stays bounded.
  socket.once('close', () => endHandshake(boxId, handshake));
  let box: BoxRecord | null = null;
  try {
    box = boxId && bearer ? await authenticateBox(boxId, bearer) : null;
  } catch (err) {
    logger.warn({ err, boxId }, '[boxes] Box authentication failed');
  }
  if (!box || handshake.cancelled) {
    endHandshake(boxId, handshake);
    logger.warn(
      { boxId, remote: req.socket.remoteAddress },
      '[boxes] Rejected box connection',
    );
    reject(socket, 401, 'Unauthorized');
    return;
  }
  const accepted = box;
  wss.handleUpgrade(req, socket, head, (ws) => {
    handshake.ws = ws;
    if (handshake.cancelled) {
      endHandshake(boxId, handshake);
      ws.close(handshake.cancelled.code, handshake.cancelled.reason);
      return;
    }
    void accept(ws, req, accepted, handshake)
      .catch((err) => {
        logger.warn(
          { err, boxId: accepted.id },
          '[boxes] Box handshake failed',
        );
        ws.close(1011, 'handshake failed');
      })
      .finally(() => endHandshake(boxId, handshake));
  });
}

async function accept(
  ws: WebSocket,
  req: IncomingMessage,
  box: BoxRecord,
  handshake: PendingHandshake,
): Promise<void> {
  const reportedKind = header(req, 'x-carapa-box-kind');
  // The registered kind is authoritative: a native runner cannot claim
  // container isolation by reporting a different kind.
  const kind = box.kind;
  if (reportedKind && reportedKind !== kind) {
    logger.warn(
      { boxId: box.id, reportedKind, kind },
      '[boxes] Box reported a different kind',
    );
  }
  const capabilities = header(req, 'x-carapa-box-capabilities')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const reportedIsolation = header(req, 'x-carapa-box-isolation');
  const isolationLevel =
    kind === 'native'
      ? 'reduced'
      : reportedIsolation || defaultIsolationLevel(kind);
  const version = header(req, 'x-carapa-box-version') || null;

  const transport = new BoxSocketTransport(ws);
  const client = new Client(
    { name: 'carapa-board', version: '1.0.0' },
    { capabilities: {} },
  );
  client.setNotificationHandler(
    LoggingMessageNotificationSchema,
    (notification) => {
      if (notification.params?.data)
        logSink?.(String(notification.params.data));
    },
  );

  await client.connect(transport);
  // The box may have been revoked, rotated or dropped while initializing.
  if (handshake.cancelled || ws.readyState !== ws.OPEN) {
    void client.close().catch(() => {});
    return;
  }

  const connection: BoxConnection = {
    id: box.id,
    kind,
    version,
    capabilities,
    isolationLevel,
    connectedAt: new Date().toISOString(),
    client,
    socket: ws,
    ...(capabilities.includes('http-tunnel')
      ? { httpTunnel: new BoxHttpTunnel(ws, box.id) }
      : {}),
  };

  // Everything from here to the first await is synchronous, so the entry,
  // the ping interval and the close handler appear together and a drop at any
  // later point is cleaned up.
  const previous = connections.get(box.id);
  connections.set(box.id, connection);
  if (previous) previous.socket.close(4000, 'replaced by a new connection');

  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const ping = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
    void touchBox(box.id).catch(() => {});
  }, PING_INTERVAL_MS);
  ping.unref?.();

  ws.on('close', () => {
    clearInterval(ping);
    if (connections.get(box.id) === connection) {
      connections.delete(box.id);
      void touchBox(box.id).catch(() => {});
      logger.info({ boxId: box.id }, '[boxes] Box disconnected');
      if (announcedOnline.delete(box.id))
        for (const listener of listeners)
          listener({ boxId: box.id, online: false });
    }
  });

  await recordBoxHello(box.id, {
    version: version ?? undefined,
    capabilities,
    isolationLevel,
  }).catch(() => {});
  // Dropped or replaced while the hello was being recorded: already cleaned up.
  if (connections.get(box.id) !== connection) return;
  announcedOnline.add(box.id);
  logger.info(
    { boxId: box.id, kind, version, isolationLevel },
    '[boxes] Box connected',
  );
  for (const listener of listeners) listener({ boxId: box.id, online: true });
}
