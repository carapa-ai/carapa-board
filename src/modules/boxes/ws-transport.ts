/**
 * MCP transport over an accepted box WebSocket: one JSON-RPC message per
 * text frame. Board is the MCP client; the box serves its tool registry.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { WebSocket } from 'ws';

export class BoxSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private closed = false;

  constructor(private readonly socket: WebSocket) {}

  async start(): Promise<void> {
    this.socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(data.toString()));
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
      this.onmessage?.(message);
    });
    this.socket.on('close', () => this.handleClose());
    this.socket.on('error', (error) => this.onerror?.(error));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      throw new Error('Box connection is closed');
    }
    await new Promise<void>((resolve, reject) =>
      this.socket.send(JSON.stringify(message), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }

  async close(): Promise<void> {
    if (this.socket.readyState === this.socket.OPEN) this.socket.close(1000);
    this.handleClose();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
