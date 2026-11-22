/**
 * An MCP session keeps the token scope it was initialized with. A resumed
 * request must present an equivalent scope or be rejected before it reaches
 * any tool handler.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TokenScope } from './auth-tokens.js';
import { createMcpHandler, sameTokenScope } from './mcp-server.js';
import type { McpServerDeps } from './auth.js';

const base: TokenScope = {
  kind: 'oauth',
  group_folder: 'proj-a',
  oauth_user_id: 'alice',
  oauth_user_is_admin: false,
  oauth_access: 'write',
  permissions: { 'proj-a': ['tasks:write', 'tasks:read'] },
};

describe('sameTokenScope', () => {
  test('treats reordered permissions as equal and two missing scopes as equal', () => {
    const reordered: TokenScope = {
      ...base,
      permissions: { 'proj-a': ['tasks:read', 'tasks:write'] },
    };
    expect(sameTokenScope(base, reordered)).toBe(true);
    expect(sameTokenScope(base, { ...base })).toBe(true);
    expect(sameTokenScope(undefined, undefined)).toBe(true);
    expect(sameTokenScope(base, undefined)).toBe(false);
    expect(sameTokenScope(undefined, base)).toBe(false);
  });

  test('rejects any change in the authority a scope grants', () => {
    const changes: Array<Partial<TokenScope>> = [
      { oauth_access: 'read' },
      { group_folder: 'proj-b' },
      { kind: 'agent' },
      { oauth_user_id: 'bob' },
      { oauth_user_is_admin: true },
      { run_id: 'run-1' },
      { permissions: { 'proj-a': ['tasks:read'] } },
      { permissions: { 'proj-a': ['tasks:write', 'tasks:read', 'x:y'] } },
      { permissions: { 'proj-b': ['tasks:write', 'tasks:read'] } },
      { permissions: undefined },
    ];
    for (const change of changes) {
      expect(sameTokenScope(base, { ...base, ...change })).toBe(false);
    }
  });
});

describe('MCP session scope on resume', () => {
  const initializeMessage = {
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  };
  let probeCalls = 0;
  let server: Server;
  let baseUrl: string;
  let nextId = 0;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // Stand-in for the auth middleware: the scope arrives as a JSON header.
    app.use((req, _res, next) => {
      const raw = req.headers['x-test-scope'];
      if (typeof raw === 'string') req.tokenScope = JSON.parse(raw);
      next();
    });
    const factory = () => {
      const mcp = new McpServer(
        { name: 'session-scope-test', version: '1.0.0' },
        { capabilities: {} },
      );
      mcp.registerTool(
        'probe',
        { description: 'counts handler invocations', inputSchema: {} },
        async () => {
          probeCalls++;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      );
      return mcp;
    };
    app.post(
      '/mcp',
      createMcpHandler(
        {} as McpServerDeps,
        () => factory(),
        'session-scope-test',
      ),
    );
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function rpc(
    scope: TokenScope | undefined,
    message: Record<string, unknown>,
    session?: string,
  ) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (scope) headers['x-test-scope'] = JSON.stringify(scope);
    if (session) {
      headers['mcp-session-id'] = session;
      headers['mcp-protocol-version'] = '2025-06-18';
    }
    const isNotification = String(message.method).startsWith('notifications/');
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(isNotification ? {} : { id: ++nextId }),
        ...message,
      }),
    });
    await res.text();
    return {
      status: res.status,
      session: res.headers.get('mcp-session-id') ?? session,
    };
  }

  test('a resumed session serves only requests with the initialize-time scope', async () => {
    const init = await rpc(base, initializeMessage);
    expect(init.status).toBe(200);
    const session = init.session!;
    await rpc(base, { method: 'notifications/initialized' }, session);

    const callProbe = (scope: TokenScope | undefined) =>
      rpc(
        scope,
        { method: 'tools/call', params: { name: 'probe', arguments: {} } },
        session,
      );

    expect((await callProbe(base)).status).toBe(200);
    expect(probeCalls).toBe(1);

    // Revoked or narrowed grant, or a token for another scope: rejected, and
    // the tool handler is never reached.
    const rejected: Array<TokenScope | undefined> = [
      { ...base, oauth_access: 'read' },
      { ...base, permissions: { 'proj-a': ['tasks:read'] } },
      { ...base, group_folder: 'proj-b' },
      undefined,
    ];
    for (const scope of rejected) {
      const fresh = await rpc(base, initializeMessage);
      const res = await rpc(scope, { method: 'tools/list' }, fresh.session!);
      expect(res.status).toBe(404);
      expect(
        (await rpc(base, { method: 'tools/list' }, fresh.session!)).status,
      ).toBe(404);
    }
    expect(probeCalls).toBe(1);

    // Equivalent scope with reordered permissions still resumes the session.
    const reordered: TokenScope = {
      ...base,
      permissions: { 'proj-a': ['tasks:read', 'tasks:write'] },
    };
    expect((await callProbe(reordered)).status).toBe(200);
    expect(probeCalls).toBe(2);
  });
});
