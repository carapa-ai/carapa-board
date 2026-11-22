/**
 * Standard contract for optional CarapaBoard modules.
 *
 * Each module implements this interface. Core loads enabled modules at boot
 * and delegates lifecycle, tool registration, and route mounting to them.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Router } from 'express';
import type { McpServerDeps } from '../mcp/auth.js';

export interface CarapaModule {
  /** Unique module identifier (e.g. 'whisper', 'vector-store') */
  name: string;

  /** Whether the module is enabled (checks feature flags, config) */
  isEnabled(): boolean;

  /** Initialize the module (connect to services, etc). Non-blocking. */
  init?(): Promise<void>;

  /** Clean shutdown */
  shutdown?(): Promise<void>;

  /** Register MCP tools on the agent server */
  registerTools?(server: McpServer, deps: McpServerDeps, scope?: any): void;

  /** Return an Express Router with module-specific routes */
  getRouter?(): Router;

  /** Config keys to expose via GET /api/config */
  getConfigFlags?(): Record<string, unknown>;
}
