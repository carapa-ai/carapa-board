/**
 * MCP OAuth 2.1 for remote MCP clients, exercised through the real
 * http-service app against an in-memory DB: origin allowlist, discovery,
 * registration → authorize → signed consent → token → MCP, refresh rotation,
 * and the places an OAuth token must NOT work.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { and, eq, isNotNull } from 'drizzle-orm';
import { createSigningPayload } from './crypto-verify.js';
import { initDatabase, registerDeviceKey } from './db.js';
import { drizzleDbRef } from './db/drizzle-client.js';
import { oauthGrants, oauthTokens, projects, users } from './db/schema.js';
import { signUserJwt } from './lib/auth-jwt.js';
import { loadState, registerGroup, unregisterGroup } from './state-manager.js';
import { TOOLSET_MODULES, registerTools } from './modules/tools/registry.js';
import * as knowledgeTools from './modules/knowledge/tools.js';

const previousEnv = {
  origins: process.env.CARAPA_BOARD_PUBLIC_ORIGINS,
};
const now = () => new Date().toISOString();
const P = 'oauth-proj-p';
const Q = 'oauth-proj-q';
const R = 'oauth-proj-r';
const MAIN = 'main-oauth-alice';
const DEVICE = 'oauth-alice-device';

const previousKnowledgeTools = TOOLSET_MODULES.knowledge;
let server: Server;
let port: number;
let A: string; // http://127.0.0.1:port
let B: string; // http://localhost:port
let signingKey: CryptoKey;
const jwt: Record<string, string> = {};
const REDIRECT = 'http://127.0.0.1:8765/callback';

const sha256b64 = (s: string) =>
  createHash('sha256').update(s).digest('base64url');

async function http(
  base: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(base + path, {
    ...init,
    headers,
    body,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function api(
  method: string,
  path: string,
  json?: unknown,
  opts: { sign?: boolean; user?: string } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt[opts.user ?? 'alice']}`,
  };
  const bodyStr = json === undefined ? '' : JSON.stringify(json);
  if (opts.sign) {
    const ts = new Date().toISOString();
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      new TextEncoder().encode(createSigningPayload(method, path, ts, bodyStr)),
    );
    headers['x-carapa-device-id'] = DEVICE;
    headers['x-carapa-timestamp'] = ts;
    headers['x-carapa-signature'] = Buffer.from(sig).toString('base64');
  }
  return http(A, path, {
    method,
    headers,
    ...(json === undefined
      ? {}
      : {
          body: bodyStr,
          headers: { ...headers, 'Content-Type': 'application/json' },
        }),
  });
}

async function register(base = A, redirectUri = REDIRECT) {
  const r = await http(base, '/oauth/register', {
    method: 'POST',
    json: {
      client_name: 'Test MCP client',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    },
  });
  return r;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: sha256b64(verifier) };
}

interface Choice {
  target?: { kind: 'main' } | { kind: 'project'; folder: string };
  access?: 'read' | 'write';
  /** Several projects, each with its own access (overrides target/access). */
  targets?: Array<
    ({ kind: 'main' } | { kind: 'project'; folder: string }) & {
      access: 'read' | 'write';
    }
  >;
  days?: number;
  base?: string;
}

/** register → authorize → signed approve; returns what the client needs next. */
async function authorizeFlow(choice: Choice = {}) {
  const base = choice.base ?? A;
  const client = (await register(base)).json.client_id as string;
  const { verifier, challenge } = pkce();
  const resource = `${base}/mcp/carapa-board`;
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: REDIRECT,
    state: 'st-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
  });
  const authz = await http(base, `/oauth/authorize?${q}`);
  const consent = new URL(authz.headers.get('location') ?? '', base);
  const requestId = consent.searchParams.get('request') ?? '';
  const decisionPath = `/api/oauth/requests/${requestId}/decision`;
  const decision = await api(
    'POST',
    decisionPath,
    {
      decision: 'approve',
      targets: choice.targets ?? [
        {
          ...(choice.target ?? { kind: 'main' }),
          access: choice.access ?? 'write',
        },
      ],
      days: choice.days ?? 7,
    },
    { sign: true },
  );
  const redirect = decision.json?.redirectUrl
    ? new URL(decision.json.redirectUrl)
    : null;
  return {
    client,
    verifier,
    challenge,
    resource,
    authz,
    consent,
    requestId,
    decisionPath,
    decision,
    code: redirect?.searchParams.get('code') ?? '',
    state: redirect?.searchParams.get('state'),
  };
}

function tokenRequest(base: string, params: Record<string, string>) {
  return http(base, '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

/** Full flow to an access + refresh token pair. */
async function connect(choice: Choice = {}) {
  const f = await authorizeFlow(choice);
  const base = choice.base ?? A;
  const token = await tokenRequest(base, {
    grant_type: 'authorization_code',
    client_id: f.client,
    code: f.code,
    redirect_uri: REDIRECT,
    code_verifier: f.verifier,
    resource: f.resource,
  });
  return {
    ...f,
    token,
    access: token.json?.access_token as string,
    refresh: token.json?.refresh_token as string,
  };
}

let rpcId = 0;
async function mcp(
  token: string,
  message: Record<string, unknown>,
  opts: { base?: string; path?: string; session?: string } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (opts.session) {
    headers['mcp-session-id'] = opts.session;
    headers['mcp-protocol-version'] = '2025-06-18';
  }
  const res = await http(opts.base ?? A, opts.path ?? '/mcp/carapa-board', {
    method: 'POST',
    headers,
    json: { jsonrpc: '2.0', id: ++rpcId, ...message },
  });
  const data = res.text
    .split('\n')
    .find((l) => l.startsWith('data: '))
    ?.slice(6);
  return {
    ...res,
    rpc: data ? JSON.parse(data) : res.json,
    session: res.headers.get('mcp-session-id') ?? opts.session,
  };
}

const initializeMessage = {
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

async function openSession(token: string, path = '/mcp/carapa-board') {
  const init = await mcp(token, initializeMessage, { path });
  expect(init.status).toBe(200);
  await http(A, path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'mcp-session-id': init.session!,
      'mcp-protocol-version': '2025-06-18',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    json: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  return init.session!;
}

async function callTool(
  token: string,
  session: string,
  name: string,
  args: Record<string, unknown>,
) {
  const r = await mcp(
    token,
    { method: 'tools/call', params: { name, arguments: args } },
    { session },
  );
  return r.rpc;
}

const toolFailed = (rpc: any) => !!rpc?.error || rpc?.result?.isError === true;

beforeAll(async () => {
  // The knowledge module registers its tools at boot; do the same so the
  // read-only checks below exercise tools that carry no requiredPermissions.
  registerTools('knowledge', knowledgeTools);
  await initDatabase(':memory:');
  const db = drizzleDbRef.current;
  for (const [id, username] of [
    ['oauth-alice', 'oauth-alice'],
    ['oauth-bob', 'oauth-bob'],
  ] as const) {
    await db.insert(users).values({
      id,
      username,
      password_hash: 'unused',
      role: 'user',
      created_at: now(),
      disabled: 0,
    });
    jwt[id.replace('oauth-', '')] = signUserJwt(id);
  }
  const keys = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  signingKey = keys.privateKey;
  await registerDeviceKey(
    DEVICE,
    'oauth-alice',
    Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString(
      'base64',
    ),
    'test',
    true,
  );
  const rows = [
    [P, 'oauth-alice', 0],
    [Q, 'oauth-alice', 0],
    [R, 'oauth-bob', 0],
    [MAIN, 'oauth-alice', 1],
  ] as const;
  for (const [folder, owner, isMain] of rows) {
    await db.insert(projects).values({
      id: folder,
      jid: `${folder}@oauth`,
      name: folder,
      folder,
      trigger: '!',
      added_at: now(),
      is_main: isMain,
      user_id: owner,
    });
  }
  await loadState();
  for (const [folder, owner, isMain] of rows) {
    await registerGroup(`${folder}@oauth`, {
      name: folder,
      folder,
      jid: `${folder}@oauth`,
      trigger: '!',
      added_at: now(),
      user_id: owner,
      ...(isMain ? { is_main: true } : {}),
    });
  }
  const httpService = await import('./http-service.js');
  await new Promise<void>((resolve) => {
    server = httpService.app.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
  A = `http://127.0.0.1:${port}`;
  B = `http://localhost:${port}`;
  process.env.CARAPA_BOARD_PUBLIC_ORIGINS = `${A},${B}`;
});

afterAll(async () => {
  TOOLSET_MODULES.knowledge = previousKnowledgeTools;
  if (server) await new Promise<void>((r) => server.close(() => r()));
  for (const f of [P, Q, R, MAIN]) await unregisterGroup(`${f}@oauth`);
  for (const [key, value] of [
    ['CARAPA_BOARD_PUBLIC_ORIGINS', previousEnv.origins],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('origin allowlist and discovery', () => {
  test('metadata is served on an allowlisted origin', async () => {
    const prm = await http(A, '/.well-known/oauth-protected-resource');
    expect(prm.status).toBe(200);
    expect(prm.json.authorization_servers).toEqual([A]);
    expect(prm.json.bearer_methods_supported).toEqual(['header']);

    const suffixed = await http(
      A,
      '/.well-known/oauth-protected-resource/mcp/carapa-board',
    );
    expect(suffixed.json.resource).toBe(`${A}/mcp/carapa-board`);
    expect(suffixed.json.scopes_supported.length).toBeGreaterThan(0);
    expect(suffixed.json.resource_name).toBeTruthy();

    const as = await http(A, '/.well-known/oauth-authorization-server');
    expect(as.json).toMatchObject({
      issuer: A,
      authorization_endpoint: `${A}/oauth/authorize`,
      token_endpoint: `${A}/oauth/token`,
      registration_endpoint: `${A}/oauth/register`,
      revocation_endpoint: `${A}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    // The second allowlisted hostname gets its own issuer.
    const asB = await http(B, '/.well-known/oauth-authorization-server');
    expect(asB.json.issuer).toBe(B);

    const guide = await http(A, '/auth.md');
    expect(guide.status).toBe(200);
    expect(guide.headers.get('content-type')).toContain('text/markdown');
    expect(guide.text).toContain(
      `${A}/.well-known/oauth-protected-resource/mcp/carapa-board`,
    );
    expect(guide.text.split('\n').length).toBeLessThan(120);
  });

  test('unlisted or spoofed hosts and an unset allowlist fail closed', async () => {
    const spoof = { 'X-Forwarded-Host': 'evil.example' };
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp/carapa-board',
      '/.well-known/oauth-authorization-server',
      '/auth.md',
    ]) {
      expect((await http(A, path, { headers: spoof })).status).toBe(404);
    }
    const reg = await http(A, '/oauth/register', {
      method: 'POST',
      headers: spoof,
      json: { redirect_uris: [REDIRECT] },
    });
    expect(reg.status).toBe(404);
    const mcpUnauth = await http(A, '/mcp/carapa-board', {
      method: 'POST',
      headers: spoof,
      json: initializeMessage,
    });
    expect(mcpUnauth.status).toBe(401);
    expect(mcpUnauth.headers.get('www-authenticate')).toBeNull();

    const saved = process.env.CARAPA_BOARD_PUBLIC_ORIGINS;
    delete process.env.CARAPA_BOARD_PUBLIC_ORIGINS;
    try {
      for (const path of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-authorization-server',
        '/auth.md',
      ]) {
        expect((await http(A, path)).status).toBe(404);
      }
      expect(
        (await http(A, '/oauth/token', { method: 'POST', json: {} })).status,
      ).toBe(404);
      const noOrigin = await http(A, '/mcp/carapa-board', {
        method: 'POST',
        json: initializeMessage,
      });
      expect(noOrigin.status).toBe(401);
      expect(noOrigin.headers.get('www-authenticate')).toBeNull();
    } finally {
      process.env.CARAPA_BOARD_PUBLIC_ORIGINS = saved;
    }
  });

  test('401 on the agent MCP endpoints points to the protected resource metadata', async () => {
    const res = await http(A, '/mcp/carapa-board', {
      method: 'POST',
      json: initializeMessage,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${A}/.well-known/oauth-protected-resource/mcp/carapa-board"`,
    );
    const bad = await http(B, '/mcp/carapa-board', {
      method: 'POST',
      headers: { Authorization: `Bearer cmo_${'x'.repeat(43)}` },
      json: initializeMessage,
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain(
      `${B}/.well-known/oauth-protected-resource/mcp/carapa-board`,
    );
  });
});

describe('registration and authorization checks', () => {
  test('only https or loopback redirect URIs are accepted', async () => {
    for (const uri of [
      'http://example.com/cb',
      'http://127.0.0.1.evil.example/cb',
      'cursor://anysphere/oauth',
      'javascript:alert(1)',
      'https://example.com/cb#frag',
    ]) {
      const r = await register(A, uri);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('invalid_redirect_uri');
    }
    for (const uri of [
      'http://localhost:9999/cb',
      'http://127.0.0.1:1234/cb',
      'https://client.example/cb',
    ]) {
      expect((await register(A, uri)).status).toBe(201);
    }
    const confidential = await http(A, '/oauth/register', {
      method: 'POST',
      json: {
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    });
    expect(confidential.status).toBe(400);
  });

  test('authorize rejects redirect mismatch, missing PKCE and foreign resources', async () => {
    const client = (await register()).json.client_id;
    const { challenge } = pkce();
    const base = {
      response_type: 'code',
      client_id: client,
      redirect_uri: REDIRECT,
      state: 's',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${A}/mcp/carapa-board`,
    };
    const go = (over: Record<string, string | undefined>) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...base, ...over })) {
        if (v !== undefined) q.set(k, v);
      }
      return http(A, `/oauth/authorize?${q}`);
    };
    // Unverified redirect_uri: reported directly, never redirected to.
    const mismatch = await go({ redirect_uri: 'http://127.0.0.1:1/other' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.headers.get('location')).toBeNull();
    expect((await go({ client_id: 'cmcl_unknown' })).status).toBe(400);

    const errorOf = (r: Awaited<ReturnType<typeof go>>) =>
      new URL(r.headers.get('location') ?? 'http://x/').searchParams.get(
        'error',
      );
    expect(errorOf(await go({ code_challenge: undefined }))).toBe(
      'invalid_request',
    );
    expect(errorOf(await go({ code_challenge_method: 'plain' }))).toBe(
      'invalid_request',
    );
    expect(errorOf(await go({ response_type: 'token' }))).toBe(
      'unsupported_response_type',
    );
    for (const resource of [
      `${B}/mcp/carapa-board`,
      'https://evil.example/mcp/carapa-board',
      `${A}/mcp/carapa-orchestrator`,
      `${A}/api/projects`,
      undefined,
    ]) {
      expect(errorOf(await go({ resource }))).toBe('invalid_target');
    }
    const ok = await go({});
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toStartWith('/oauth/consent?request=');
  });

  test('consent API describes the request and approval needs a fresh signature', async () => {
    const f = await authorizeFlow();
    expect(f.decision.status).toBe(200);
    expect(f.state).toBe('st-1');

    // A second request: unsigned approval is rejected and the request survives.
    const client = f.client;
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: client,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: f.resource,
    });
    const loc = (await http(A, `/oauth/authorize?${q}`)).headers.get(
      'location',
    )!;
    const id = new URL(loc, A).searchParams.get('request');
    const info = await api('GET', `/api/oauth/requests/${id}`);
    expect(info.status).toBe(200);
    expect(info.json.client.name).toBe('Test MCP client');
    expect(info.json.redirectHost).toBe('127.0.0.1:8765');
    const folders = info.json.choices.targets.map((t: any) => t.folder);
    expect(folders).toContain(MAIN);
    expect(folders).toContain(P);
    expect(folders).not.toContain(R);

    const body = {
      decision: 'approve',
      targets: [{ kind: 'main', access: 'write' }],
      days: 7,
    };
    const unsigned = await api(
      'POST',
      `/api/oauth/requests/${id}/decision`,
      body,
    );
    expect(unsigned.status).toBe(401);
    const forbiddenTarget = await api(
      'POST',
      `/api/oauth/requests/${id}/decision`,
      { ...body, targets: [{ kind: 'project', folder: R, access: 'read' }] },
      { sign: true },
    );
    expect(forbiddenTarget.status).toBe(403);
    const adminDays = await api(
      'POST',
      `/api/oauth/requests/${id}/decision`,
      { ...body, days: 9999 },
      { sign: true },
    );
    expect(adminDays.status).toBe(400);

    // Deny needs no signature and redirects with access_denied.
    const denied = await api('POST', `/api/oauth/requests/${id}/decision`, {
      decision: 'deny',
    });
    expect(denied.status).toBe(200);
    expect(new URL(denied.json.redirectUrl).searchParams.get('error')).toBe(
      'access_denied',
    );
    expect((await api('GET', `/api/oauth/requests/${id}`)).status).toBe(404);
  });
});

/** Grant id of the client's (single) grant, read straight from the DB. */
async function grantIdFor(clientId: string): Promise<string> {
  const [grant] = await drizzleDbRef.current
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(eq(oauthGrants.client_id, clientId));
  return grant.id;
}

/** Simulate time passing: rewrite the used refresh rows of the client's grant. */
async function setUsedRefreshRows(
  clientId: string,
  patch: { used_at?: string; expires_at?: string },
) {
  await drizzleDbRef.current
    .update(oauthTokens)
    .set(patch)
    .where(
      and(
        eq(oauthTokens.grant_id, await grantIdFor(clientId)),
        eq(oauthTokens.kind, 'refresh'),
        isNotNull(oauthTokens.used_at),
      ),
    );
}

async function refreshRowCount(clientId: string): Promise<number> {
  return (
    await drizzleDbRef.current
      .select({ id: oauthTokens.id })
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.grant_id, await grantIdFor(clientId)),
          eq(oauthTokens.kind, 'refresh'),
        ),
      )
  ).length;
}

describe('token endpoint', () => {
  test('full flow ends in a working MCP session, then refresh rotates', async () => {
    const c = await connect();
    expect(c.token.status).toBe(200);
    expect(c.token.headers.get('cache-control')).toBe('no-store');
    expect(c.token.json).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:read mcp:write',
    });
    expect(c.access).toStartWith('cmo_');

    const init = await mcp(c.access, initializeMessage);
    expect(init.status).toBe(200);
    expect(init.rpc.result.serverInfo.name).toBe('carapa-agent');
    // The removed paths are not mounted.
    for (const path of ['/mcp/carapa-agent', '/mcp/carapa-board/sse']) {
      expect((await mcp(jwt.alice, initializeMessage, { path })).status).toBe(
        404,
      );
      expect((await mcp(c.access, initializeMessage, { path })).status).toBe(
        403,
      );
    }
    expect(
      (await http(A, '/.well-known/oauth-protected-resource/mcp/carapa-agent'))
        .status,
    ).toBe(404);

    const refreshed = await tokenRequest(A, {
      grant_type: 'refresh_token',
      client_id: c.client,
      refresh_token: c.refresh,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.refresh_token).not.toBe(c.refresh);
    expect(
      (await mcp(refreshed.json.access_token, initializeMessage)).status,
    ).toBe(200);

    // Replaying the rotated token revokes the whole grant, new tokens included.
    const replay = await tokenRequest(A, {
      grant_type: 'refresh_token',
      client_id: c.client,
      refresh_token: c.refresh,
    });
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe('invalid_grant');
    expect(
      (await mcp(refreshed.json.access_token, initializeMessage)).status,
    ).toBe(401);
    expect((await mcp(c.access, initializeMessage)).status).toBe(401);
    const afterRevoke = await tokenRequest(A, {
      grant_type: 'refresh_token',
      client_id: c.client,
      refresh_token: refreshed.json.refresh_token,
    });
    expect(afterRevoke.json.error).toBe('invalid_grant');
  });

  test('replaying a used refresh token of a live grant revokes it after 8 days', async () => {
    const c = await connect({ days: 30 });
    const second = await tokenRequest(A, {
      grant_type: 'refresh_token',
      client_id: c.client,
      refresh_token: c.refresh,
    });
    expect(second.status).toBe(200);
    await setUsedRefreshRows(c.client, {
      used_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    // Another rotation runs the cleanup that used to drop the first token's row.
    const third = await tokenRequest(A, {
      grant_type: 'refresh_token',
      client_id: c.client,
      refresh_token: second.json.refresh_token,
    });
    expect(third.status).toBe(200);

    const replay = await tokenRequest(A, {
      grant_type: 'refresh_token',
      client_id: c.client,
      refresh_token: c.refresh,
    });
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe('invalid_grant');
    expect((await mcp(third.json.access_token, initializeMessage)).status).toBe(
      401,
    );
  });

  test('a used refresh row is removed by rotation once its own expiry has passed', async () => {
    const c = await connect({ days: 30 });
    const second = await tokenRequest(A, {
      grant_type: 'refresh_token',
      client_id: c.client,
      refresh_token: c.refresh,
    });
    expect(second.status).toBe(200);
    expect(await refreshRowCount(c.client)).toBe(2);

    await setUsedRefreshRows(c.client, {
      expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const third = await tokenRequest(A, {
      grant_type: 'refresh_token',
      client_id: c.client,
      refresh_token: second.json.refresh_token,
    });
    expect(third.status).toBe(200);
    // The expired used row (the first token) is gone; the live used row stays.
    expect(await refreshRowCount(c.client)).toBe(2);
  });

  test('wrong verifier, code reuse, redirect and resource mismatch are rejected', async () => {
    const exchange = (
      f: Awaited<ReturnType<typeof authorizeFlow>>,
      over: Record<string, string> = {},
    ) =>
      tokenRequest(A, {
        grant_type: 'authorization_code',
        client_id: f.client,
        code: f.code,
        redirect_uri: REDIRECT,
        code_verifier: f.verifier,
        resource: f.resource,
        ...over,
      });

    const wrongVerifier = await authorizeFlow();
    const r1 = await exchange(wrongVerifier, {
      code_verifier: pkce().verifier,
    });
    expect(r1.status).toBe(400);
    expect(r1.json.error).toBe('invalid_grant');
    // The failed attempt consumed the code.
    expect((await exchange(wrongVerifier)).json.error).toBe('invalid_grant');

    const reuse = await authorizeFlow();
    expect((await exchange(reuse)).status).toBe(200);
    expect((await exchange(reuse)).json.error).toBe('invalid_grant');

    const redirect = await authorizeFlow();
    expect(
      (await exchange(redirect, { redirect_uri: 'http://127.0.0.1:1/x' })).json
        .error,
    ).toBe('invalid_grant');

    const resource = await authorizeFlow();
    expect(
      (await exchange(resource, { resource: `${B}/mcp/carapa-board` })).json
        .error,
    ).toBe('invalid_target');

    const other = await authorizeFlow();
    expect(
      (await exchange(other, { client_id: 'cmcl_unknown' })).json.error,
    ).toBe('invalid_client');
    expect((await tokenRequest(A, { grant_type: 'password' })).json.error).toBe(
      'unsupported_grant_type',
    );
    expect((await tokenRequest(A, {})).json.error).toBe('invalid_request');
  });
});

describe('where an OAuth token works', () => {
  test('only on the agent MCP endpoints of the origin it was bound to', async () => {
    const c = await connect();
    const bearer = { Authorization: `Bearer ${c.access}` };
    expect((await http(A, '/api/projects', { headers: bearer })).status).toBe(
      403,
    );
    expect(
      (await http(A, '/api/oauth/grants', { headers: bearer })).status,
    ).toBe(403);
    expect(
      (
        await mcp(c.access, initializeMessage, {
          path: '/mcp/carapa-orchestrator',
        })
      ).status,
    ).toBe(403);
    // Same server, different public origin: bound to A only.
    const wrongOrigin = await mcp(c.access, initializeMessage, { base: B });
    expect(wrongOrigin.status).toBe(401);
    // Query-string tokens are never accepted for OAuth tokens.
    const queryUrl = '/mcp/carapa-board?token=' + c.access;
    const viaQuery = await http(A, queryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      json: initializeMessage,
    });
    expect(viaQuery.status).toBe(401);
  });

  test('read grants cannot write; project grants cannot reach other projects', async () => {
    const read = await connect({ access: 'read' });
    expect(read.token.json.scope).toBe('mcp:read');
    const readSession = await openSession(read.access);
    const readTools = await mcp(
      read.access,
      { method: 'tools/list', params: {} },
      { session: readSession },
    );
    const readNames = readTools.rpc.result.tools.map((t: any) => t.name);
    expect(readNames).not.toContain('create_task');
    // Knowledge write tools declare no requiredPermissions; read grants must
    // still be refused, while the knowledge read tools stay available.
    expect(readNames).toContain('search_knowledge');
    for (const name of ['save_to_knowledge', 'update_knowledge_document']) {
      expect(readNames).not.toContain(name);
      expect(
        toolFailed(
          await callTool(read.access, readSession, name, {
            content: 'x',
            kb_id: 'kb',
            filename: 'f.md',
          }),
        ),
      ).toBe(true);
    }
    expect(
      toolFailed(
        await callTool(read.access, readSession, 'create_task', {
          title: 'nope',
        }),
      ),
    ).toBe(true);

    const proj = await connect({
      target: { kind: 'project', folder: P },
      access: 'write',
    });
    const session = await openSession(proj.access);
    const tools = await mcp(
      proj.access,
      { method: 'tools/list', params: {} },
      { session },
    );
    const writeNames = tools.rpc.result.tools.map((t: any) => t.name);
    expect(writeNames).toContain('create_task');
    expect(writeNames).toContain('save_to_knowledge');
    for (const other of [Q, R, MAIN]) {
      expect(
        toolFailed(
          await callTool(proj.access, session, 'create_task', {
            title: 'cross-project',
            target_project: other,
          }),
        ),
      ).toBe(true);
    }
    expect(
      toolFailed(
        await callTool(proj.access, session, 'create_task', {
          title: 'in scope',
        }),
      ),
    ).toBe(false);
  });
});

describe('revocation and invalidation', () => {
  test('grants list, owner-only revoke, and /oauth/revoke', async () => {
    const byApi = await connect();
    const listed = await api('GET', '/api/oauth/grants');
    const grant = listed.json.find((g: any) => g.clientId === byApi.client);
    expect(grant).toMatchObject({
      clientName: 'Test MCP client',
      targets: [{ kind: 'main', folder: MAIN, access: 'write' }],
    });
    expect(grant.createdAt && grant.expiresAt).toBeTruthy();
    expect((await mcp(byApi.access, initializeMessage)).status).toBe(200);
    const lastUsed = (await api('GET', '/api/oauth/grants')).json.find(
      (g: any) => g.id === grant.id,
    ).lastUsedAt;
    expect(lastUsed).toBeTruthy();

    expect(
      (
        await api('DELETE', `/api/oauth/grants/${grant.id}`, undefined, {
          user: 'bob',
        })
      ).status,
    ).toBe(404);
    expect((await api('DELETE', `/api/oauth/grants/${grant.id}`)).status).toBe(
      200,
    );
    expect((await mcp(byApi.access, initializeMessage)).status).toBe(401);

    // RFC 7009: a refresh token revokes the grant, an access token only itself.
    const viaRefresh = await connect();
    const revokeRefresh = await http(A, '/oauth/revoke', {
      method: 'POST',
      json: { token: viaRefresh.refresh, client_id: viaRefresh.client },
    });
    expect(revokeRefresh.status).toBe(200);
    expect((await mcp(viaRefresh.access, initializeMessage)).status).toBe(401);

    const viaAccess = await connect();
    await http(A, '/oauth/revoke', {
      method: 'POST',
      json: { token: viaAccess.access },
    });
    expect((await mcp(viaAccess.access, initializeMessage)).status).toBe(401);
    const stillRefreshable = await tokenRequest(A, {
      grant_type: 'refresh_token',
      client_id: viaAccess.client,
      refresh_token: viaAccess.refresh,
    });
    expect(stillRefreshable.status).toBe(200);
    const unknown = await http(A, '/oauth/revoke', {
      method: 'POST',
      json: { token: 'not-a-token' },
    });
    expect(unknown.status).toBe(200);
  });

  test('disabled owner and expired grant stop working immediately', async () => {
    const db = drizzleDbRef.current;
    const disabled = await connect();
    expect((await mcp(disabled.access, initializeMessage)).status).toBe(200);
    await db
      .update(users)
      .set({ disabled: 1 })
      .where(eq(users.id, 'oauth-alice'));
    try {
      expect((await mcp(disabled.access, initializeMessage)).status).toBe(401);
      const refresh = await tokenRequest(A, {
        grant_type: 'refresh_token',
        client_id: disabled.client,
        refresh_token: disabled.refresh,
      });
      expect(refresh.json.error).toBe('invalid_grant');
    } finally {
      await db
        .update(users)
        .set({ disabled: 0 })
        .where(eq(users.id, 'oauth-alice'));
    }
    // Re-enabled owner: the grant itself was not destroyed.
    expect((await mcp(disabled.access, initializeMessage)).status).toBe(200);

    const expired = await connect();
    expect((await mcp(expired.access, initializeMessage)).status).toBe(200);
    await db
      .update(oauthGrants)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await mcp(expired.access, initializeMessage)).status).toBe(401);
    const refresh = await tokenRequest(A, {
      grant_type: 'refresh_token',
      client_id: expired.client,
      refresh_token: expired.refresh,
    });
    expect(refresh.json.error).toBe('invalid_grant');
  });
});

describe('editing a grant', () => {
  const patch = (
    id: string,
    json: unknown,
    opts: { sign?: boolean; user?: string } = { sign: true },
  ) => api('PATCH', `/api/oauth/grants/${id}`, json, opts);

  test('narrowing access applies to the next request; extra projects are added', async () => {
    const c = await connect({
      targets: [
        { kind: 'project', folder: P, access: 'write' },
        { kind: 'project', folder: Q, access: 'write' },
      ],
    });
    const id = await grantIdFor(c.client);
    let session = await openSession(c.access);
    const createIn = (target: string) =>
      callTool(c.access, session, 'create_task', {
        title: 'edit-flow',
        target_project: target,
      });
    expect(toolFailed(await createIn(Q))).toBe(false);

    const edited = await patch(id, {
      targets: [
        { kind: 'project', folder: P, access: 'write' },
        { kind: 'project', folder: Q, access: 'read' },
      ],
    });
    expect(edited.status).toBe(200);
    // A session opened under the old scope is refused; a new one sees the edit.
    expect(toolFailed(await createIn(P))).toBe(true);
    session = await openSession(c.access);
    expect(toolFailed(await createIn(Q))).toBe(true);
    expect(toolFailed(await createIn(P))).toBe(false);

    const listed = (await api('GET', '/api/oauth/grants')).json.find(
      (g: any) => g.id === id,
    );
    expect(listed.targets).toEqual([
      { kind: 'project', folder: P, name: P, access: 'write' },
      { kind: 'project', folder: Q, name: Q, access: 'read' },
    ]);

    // Dropping a project removes it from the scope entirely.
    expect(
      (
        await patch(id, {
          targets: [{ kind: 'project', folder: P, access: 'read' }],
        })
      ).status,
    ).toBe(200);
    session = await openSession(c.access);
    expect(toolFailed(await createIn(P))).toBe(true);
    expect((await mcp(c.access, initializeMessage)).status).toBe(200);
  });

  test('expiry is counted from now and caps the existing tokens', async () => {
    const c = await connect({ days: 30 });
    const id = await grantIdFor(c.client);
    const targets = [{ kind: 'main', access: 'write' }];
    const before = Date.now();
    const shortened = await patch(id, { targets, days: 1 });
    expect(shortened.status).toBe(200);
    const expiresAt = Date.parse(shortened.json.expiresAt);
    expect(expiresAt).toBeGreaterThan(before + 86_000_000);
    expect(expiresAt).toBeLessThan(Date.now() + 86_400_000 + 1000);
    const tokens = await drizzleDbRef.current
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.grant_id, id));
    expect(tokens.length).toBe(2);
    for (const token of tokens) {
      expect(Date.parse(token.expires_at)).toBeLessThanOrEqual(expiresAt);
    }
    // Omitting `days` keeps the expiry.
    const kept = await patch(id, { targets });
    expect(kept.json.expiresAt).toBe(shortened.json.expiresAt);
  });

  test('rejects non-owners, unsigned requests, unreachable folders and bad bodies', async () => {
    const c = await connect({ target: { kind: 'project', folder: P } });
    const id = await grantIdFor(c.client);
    const ok = [{ kind: 'project', folder: P, access: 'read' }];

    expect(
      (await patch(id, { targets: ok }, { user: 'bob', sign: false })).status,
    ).toBe(403);
    expect((await patch(id, { targets: ok }, { sign: false })).status).toBe(
      401,
    );
    expect(
      (
        await patch(id, {
          targets: [{ kind: 'project', folder: R, access: 'read' }],
        })
      ).status,
    ).toBe(403);
    for (const bad of [
      { targets: [] },
      { targets: [...ok, ...ok] },
      { targets: ok, days: 5 },
      { targets: ok, access: 'write' },
      { targets: [{ kind: 'master', access: 'read' }] },
    ]) {
      expect((await patch(id, bad)).status).toBe(400);
    }
    expect((await patch('no-such-grant', { targets: ok })).status).toBe(404);
    // Nothing above changed the grant.
    const listed = (await api('GET', '/api/oauth/grants')).json.find(
      (g: any) => g.id === id,
    );
    expect(listed.targets).toEqual([
      { kind: 'project', folder: P, name: P, access: 'write' },
    ]);
  });

  test('a read-only first project does not block writes to a later project it names', async () => {
    const c = await connect({
      targets: [
        { kind: 'project', folder: P, access: 'read' },
        { kind: 'project', folder: Q, access: 'write' },
      ],
    });
    const session = await openSession(c.access);
    const createIn = (target?: string) =>
      callTool(c.access, session, 'create_task', {
        title: 'mixed-access',
        ...(target && { target_project: target }),
      });
    expect(toolFailed(await createIn(Q))).toBe(false);
    expect(toolFailed(await createIn(P))).toBe(true);
    // The home folder stays the first selection (read-only P).
    expect(toolFailed(await createIn())).toBe(true);
  });

  test('task-ID tools are authorized against the task project, not the read-only home', async () => {
    const c = await connect({
      targets: [
        { kind: 'project', folder: P, access: 'write' },
        { kind: 'project', folder: Q, access: 'write' },
      ],
    });
    const idOf = (rpc: any) => JSON.parse(rpc.result.content[0].text).id;
    let session = await openSession(c.access);
    const inP = idOf(
      await callTool(c.access, session, 'create_task', {
        title: 'task in P',
        target_project: P,
      }),
    );
    const inQ = idOf(
      await callTool(c.access, session, 'create_task', {
        title: 'task in Q',
        target_project: Q,
      }),
    );
    const edited = await api(
      'PATCH',
      `/api/oauth/grants/${await grantIdFor(c.client)}`,
      {
        targets: [
          { kind: 'project', folder: P, access: 'read' },
          { kind: 'project', folder: Q, access: 'write' },
        ],
      },
      { sign: true },
    );
    expect(edited.status).toBe(200);

    session = await openSession(c.access);
    const update = (task_id: string) =>
      callTool(c.access, session, 'update_task', {
        task_id,
        title: 'renamed',
      });
    expect(toolFailed(await update(inQ))).toBe(false);
    expect(toolFailed(await update(inP))).toBe(true);
    const archive = (task_id: string) =>
      callTool(c.access, session, 'archive_task', { task_id });
    expect(toolFailed(await archive(inP))).toBe(true);
  });

  test('offers the same grantable projects as the consent screen', async () => {
    const choices = await api('GET', '/api/oauth/grant-choices');
    expect(choices.status).toBe(200);
    const folders = choices.json.targets.map((t: any) => t.folder);
    expect(folders).toContain(MAIN);
    expect(folders).toContain(P);
    expect(folders).not.toContain(R);
    expect(choices.json.days).toEqual([1, 7, 30, 90]);
  });
});
