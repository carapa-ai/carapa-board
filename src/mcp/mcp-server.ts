/**
 * MCP Server for CarapaBoard agent tools.
 *
 * Exposes two distinct servers over HTTP SSE:
 *
 *   carapa-agent       (/mcp/carapa-board)
 *     Safe tools for coding agents working within a task.  Includes
 *     create_task (scope-limited: agent can only create tasks in its own
 *     project or, for parent projects, in child projects).
 *
 *   carapa-orchestrator (/mcp/carapa-orchestrator)
 *     Everything in carapa-agent plus structural tools: register_group,
 *     and project/stage configuration tools.
 *     Intended for the main coordinator agent.
 *
 * One McpServer + StreamableHTTPServerTransport per session per server.
 */

import { randomUUID } from 'crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

import { logger } from '../logger.js';
import { startSseKeepAlive } from '../lib/sse-keepalive.js';
import { mainFolderFor } from '../lib/oauth/service.js';

import type { McpServerDeps } from './auth.js';

// Tool registrars — each adds its tool set to a given McpServer
import { registerToolsToMcp } from '../modules/tools/index.js';
import { registerModuleTools } from '../modules/loader.js';
import { registerGitNexusResources } from '../modules/gitnexus/tools.js';

import { TokenScope } from './auth-tokens.js';
import { getAgentPermissionsResolved } from './auth.js';
import { getGroupByFolder, registeredGroups } from '../state-manager.js';

import type { AuthUser } from '../db.js';
import { getActiveToolsets } from '../modules/tools/registry.js';
import { ensureMailToolsLoadedForMcp } from '../modules/mail/tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Server factories
// ─────────────────────────────────────────────────────────────────────────────

async function createCarapaMcpServer(
  deps: McpServerDeps,
  scope?: TokenScope,
): Promise<McpServer> {
  const name = scope?.permissions?.['*']?.includes('*:*')
    ? 'carapa-orchestrator'
    : 'carapa-agent';

  const server = new McpServer(
    { name, version: '1.0.0' },
    { capabilities: { logging: {}, resources: {} } },
  );

  const group_folder = scope?.group_folder || 'main';
  const activeToolsets = getActiveToolsets(group_folder);

  if (scope) await ensureMailToolsLoadedForMcp(scope);
  registerToolsToMcp(server, deps, scope);
  registerModuleTools(server, deps, scope);

  if (activeToolsets.includes('gitnexus')) {
    registerGitNexusResources(server, deps, scope);
  }

  return server;
}

/** Order-insensitive comparison of permission keys and their value arrays. */
function samePermissions(
  a?: Record<string, string[]>,
  b?: Record<string, string[]>,
): boolean {
  if (!a || !b) return a === b;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    const left = [...a[key]].sort();
    const right = [...b[key]].sort();
    return left.length === right.length && left.every((v, i) => v === right[i]);
  });
}

/**
 * True when two token scopes grant the same authority. A session resumed with
 * a token whose scope differs from the one it was initialized with must not
 * reuse the initialize-time scope.
 */
export function sameTokenScope(a?: TokenScope, b?: TokenScope): boolean {
  if (!a || !b) return a === b;
  return (
    a.kind === b.kind &&
    a.group_folder === b.group_folder &&
    a.task_id === b.task_id &&
    a.conversation_id === b.conversation_id &&
    a.run_id === b.run_id &&
    a.oauth_user_id === b.oauth_user_id &&
    a.oauth_user_is_admin === b.oauth_user_is_admin &&
    a.oauth_access === b.oauth_access &&
    samePermissions(a.permissions, b.permissions)
  );
}

/**
 * Logged-in humans (browser session, user JWT) reach MCP with the same scope
 * as their per-user main agent: their own main plus owned and member projects
 * (viewers read-only). Nobody gets the `'*'` wildcard over MCP. A missing main
 * group fails closed to no permissions.
 */
async function resolveHumanTokenScope(req: express.Request): Promise<void> {
  // Set by the auth middleware in http-service.ts (untyped there).
  const { authUser, authCredentialKind } = req as express.Request & {
    authUser?: AuthUser;
    authCredentialKind?: string;
  };
  if (authCredentialKind !== 'user' || !authUser) return;
  const group_folder = mainFolderFor(authUser.username);
  const main = getGroupByFolder(group_folder);
  req.tokenScope = {
    group_folder,
    // The folder name alone proves nothing: only the user's own main counts.
    permissions:
      main?.is_main && main.user_id === authUser.id
        ? await getAgentPermissionsResolved(main, registeredGroups)
        : {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP mount
// ─────────────────────────────────────────────────────────────────────────────

/** Run an MCP transport request while keeping its SSE stream alive. */
async function handleWithKeepAlive(
  transport: StreamableHTTPServerTransport,
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const keepalive = startSseKeepAlive(res);
  const stop = () => clearInterval(keepalive);
  res.on('close', stop);
  res.on('finish', stop);
  try {
    await transport.handleRequest(req, res, req.body);
  } finally {
    stop();
  }
}

const MCP_SESSION_IDLE_TTL_MS = 30 * 60_000;
const MCP_SESSION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Create a Streamable HTTP session handler for a given server factory.
 * Each path gets its own session map so sessions are isolated per server tier.
 */
export function createMcpHandler(
  deps: McpServerDeps,
  serverFactory: (
    deps: McpServerDeps,
    scope?: TokenScope,
  ) => McpServer | Promise<McpServer>,
  label: string,
): express.RequestHandler {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  // Token scope captured at initialize; later requests must present the same one.
  const sessionScopes = new Map<string, TokenScope | undefined>();
  const activity = new Map<string, { lastUsed: number; active: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, state] of activity) {
      if (
        state.active === 0 &&
        now - state.lastUsed >= MCP_SESSION_IDLE_TTL_MS
      ) {
        const transport = sessions.get(id);
        sessions.delete(id);
        sessionScopes.delete(id);
        activity.delete(id);
        if (transport)
          void transport
            .close()
            .catch((error) =>
              logger.warn(
                { error, session_id: id },
                'MCP idle session close failed',
              ),
            );
      }
    }
  }, MCP_SESSION_SWEEP_INTERVAL_MS);
  sweep.unref();

  return async (req: express.Request, res: express.Response) => {
    const startedAt = Date.now();
    const session_id = req.headers['mcp-session-id'] as string | undefined;
    const rpc_method =
      typeof req.body?.method === 'string' ? req.body.method : undefined;
    const tool =
      typeof req.body?.params?.name === 'string'
        ? req.body.params.name
        : undefined;
    let completionLogged = false;
    const logCompletion = (event: string) => {
      if (completionLogged) return;
      completionLogged = true;
      const fields = {
        event,
        http_method: req.method,
        path: req.path,
        rpc_method,
        tool,
        session_id,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      };
      if (res.statusCode >= 500) {
        logger.error(fields, 'MCP request failed');
      } else if (res.statusCode >= 400) {
        logger.warn(fields, 'MCP request rejected');
      } else {
        logger.debug(fields, 'MCP request completed');
      }
    };
    logger.debug(
      {
        http_method: req.method,
        path: req.path,
        rpc_method,
        tool,
        session_id,
      },
      'MCP request started',
    );
    res.once('finish', () => logCompletion('finish'));
    res.once('close', () => logCompletion('close'));

    // Compat: inject text/event-stream if missing (some MCP clients omit it)
    if (
      req.method === 'GET' &&
      !req.headers.accept?.includes('text/event-stream')
    ) {
      req.headers.accept = 'text/event-stream';
    }

    await resolveHumanTokenScope(req);

    if (session_id && sessions.has(session_id)) {
      // A resumed session keeps its initialize-time scope, so a different
      // token (revoked, narrowed or another project's) must not reach it.
      if (!sameTokenScope(sessionScopes.get(session_id), req.tokenScope)) {
        logger.warn(
          { server: label, session_id },
          'MCP session rejected: token scope differs from initialize',
        );
        const transport = sessions.get(session_id)!;
        sessions.delete(session_id);
        sessionScopes.delete(session_id);
        activity.delete(session_id);
        await transport.close();
        res.status(404).json({ error: 'MCP session not found; reinitialize' });
        return;
      }
      const state = activity.get(session_id)!;
      state.active++;
      state.lastUsed = Date.now();
      let requestDone = false;
      let responseDone = res.writableFinished || res.destroyed;
      let released = false;
      const release = () => {
        if (!released && requestDone && responseDone) {
          released = true;
          state.active--;
          state.lastUsed = Date.now();
        }
      };
      const responseClosed = () => {
        responseDone = true;
        release();
      };
      res.once('finish', responseClosed);
      res.once('close', responseClosed);
      try {
        await handleWithKeepAlive(sessions.get(session_id)!, req, res);
      } finally {
        requestDone = true;
        release();
      }
      return;
    }

    // A board restart or transport close invalidates the in-memory session.
    // Do not treat a request carrying that stale ID as a new initialization:
    // the SDK can otherwise wait on an uninitialized transport indefinitely.
    if (session_id) {
      res.status(404).json({ error: 'MCP session not found; reinitialize' });
      return;
    }

    // New session — only POST initialize is valid here
    if (req.method !== 'POST') {
      res
        .status(400)
        .json({ error: 'Session not found. Send POST initialize first.' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const server = await serverFactory(deps, req.tokenScope);

    let closed = false;
    transport.onclose = () => {
      closed = true;
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        sessionScopes.delete(transport.sessionId);
        activity.delete(transport.sessionId);
        logger.debug(
          {
            server: label,
            session_id: transport.sessionId,
            activeTransportCount: sessions.size,
          },
          'MCP session closed',
        );
      }
    };

    await server.connect(transport);

    try {
      await handleWithKeepAlive(transport, req, res);
    } catch (error) {
      await transport.close();
      throw error;
    }

    if (transport.sessionId && !closed) {
      sessions.set(transport.sessionId, transport);
      sessionScopes.set(transport.sessionId, req.tokenScope);
      activity.set(transport.sessionId, { lastUsed: Date.now(), active: 0 });
      logger.debug(
        {
          server: label,
          session_id: transport.sessionId,
          activeTransportCount: sessions.size,
        },
        'MCP session started',
      );
    } else if (!closed) {
      await transport.close();
    }
  };
}

/**
 * Mount MCP Streamable HTTP routes on the Express app.
 *
 * Agent server (safe tools only):
 *   GET/POST/DELETE /mcp/carapa-board
 *
 * Orchestrator server (all tools including structural):
 *   GET/POST/DELETE /mcp/carapa-orchestrator
 */
export function mountMcpRoutes(
  app: express.Application,
  deps: McpServerDeps,
): void {
  const agentHandler = createMcpHandler(
    deps,
    createCarapaMcpServer,
    'carapa-agent',
  );
  const orchestratorHandler = createMcpHandler(
    deps,
    createCarapaMcpServer,
    'carapa-orchestrator',
  );

  // Agent server — coding agents (safe tools only)
  app.get('/mcp/carapa-board', agentHandler);
  app.post('/mcp/carapa-board', agentHandler);
  app.delete('/mcp/carapa-board', agentHandler);

  // Orchestrator server — main coordinator (all tools)
  app.get('/mcp/carapa-orchestrator', orchestratorHandler);
  app.post('/mcp/carapa-orchestrator', orchestratorHandler);
  app.delete('/mcp/carapa-orchestrator', orchestratorHandler);

  logger.info(
    'MCP servers mounted: /mcp/carapa-board (agent), /mcp/carapa-orchestrator (orchestrator)',
  );
}
