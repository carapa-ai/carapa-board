import { boxStubToolResponse } from './box-stub-response.js';

function utcDateDaysFromNow(days: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days),
  )
    .toISOString()
    .slice(0, 10);
}

const port = Number(process.env.UI_SANDBOX_BOX_PORT);
// Disposable provider-login UI fixture. No native CLI or provider is contacted.
const providerAccounts: any[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'mistral-vibe',
    label: 'Manual 10d key',
    scope: 'shared',
    state: 'connected',
    expiresAt: utcDateDaysFromNow(10),
    expirySource: 'manual',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    provider: 'openrouter',
    label: 'Provider 2d key',
    scope: 'shared',
    state: 'connected',
    expiresAt: utcDateDaysFromNow(2),
    expirySource: 'provider',
    keyCheck: 'valid',
    keyCheckedAt: Date.now() - 3600_000,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    provider: 'openai',
    label: 'Rejected key',
    scope: 'shared',
    state: 'connected',
    keyCheck: 'rejected',
    keyCheckedAt: Date.now() - 1800_000,
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    provider: 'google',
    label: 'Plain key',
    scope: 'shared',
    state: 'connected',
  },
];
const providerLogins = new Map<string, any>();
if (!Number.isInteger(port) || port <= 0) {
  throw new Error('UI_SANDBOX_BOX_PORT must be a positive integer');
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', mode: 'ui-sandbox-stub' });
    }
    if (url.pathname.startsWith('/api/admin/provider-accounts')) {
      if (
        request.headers.get('authorization') !== 'Bearer ui-sandbox-box-token'
      )
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      if (request.method === 'GET' && url.pathname.endsWith('/usage'))
        return Response.json({ usage: {} });
      if (request.method === 'GET')
        return Response.json({
          accounts: providerAccounts,
          logins: [...providerLogins.values()],
          clients: [
            {
              name: 'private-sandbox',
              isolation: 'strict',
              patterns: ['carapa-bot-private-agent-1'],
            },
          ],
        });
      if (url.pathname.endsWith('/login') && request.method === 'POST') {
        const body: any = await request.json();
        const id = crypto.randomUUID();
        if (body.apiKey) {
          providerAccounts.push({
            id,
            provider: body.provider,
            label: body.label,
            scope: body.scope ?? 'shared',
            ...(body.client ? { client: body.client } : {}),
            ...(body.host ? { host: body.host } : {}),
            ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
            // Project integrations: Box reads the instance's container names itself.
            ...(body.scope === 'project'
              ? {
                  ...(body.provider === 'custom'
                    ? (() => {
                        const url = new URL(body.baseUrl);
                        return {
                          route: body.route,
                          host: url.hostname,
                          pathPrefix: url.pathname.replace(/\/+$/, ''),
                          auth: body.auth,
                        };
                      })()
                    : { host: String(body.host).replace(/^https:\/\//, '') }),
                  project: body.project,
                  containers: [
                    `${body.project.stack}-${body.project.instance}-agent-1`,
                  ],
                  allow: body.allow,
                }
              : {}),
            state: 'connected',
            ...(body.expiresAt
              ? { expiresAt: body.expiresAt, expirySource: 'manual' }
              : {}),
          });
          return Response.json({ id, installed: true });
        }
        providerLogins.set(id, {
          id,
          provider: body.provider,
          label: body.label,
          state: 'waiting',
          expiresAt: Date.now() + 900000,
          input: body.provider === 'antigravity' ? 'callback' : 'code',
          authorizationUrl: 'https://example.invalid/demo-provider-login',
        });
        return Response.json({ id });
      }
      const suffix = url.pathname.slice('/api/admin/provider-accounts'.length);
      const accountMatch = /^\/([a-f0-9-]{36})$/.exec(suffix);
      if (accountMatch) {
        const account = providerAccounts.find(
          (entry) => entry.id === accountMatch[1],
        );
        if (!account)
          return Response.json({ error: 'Not found' }, { status: 404 });
        if (request.method === 'PATCH') {
          const body: any = await request.json();
          if (Object.hasOwn(body, 'label')) account.label = body.label;
          if (Object.hasOwn(body, 'tier')) {
            if (body.tier === null) delete account.tier;
            else account.tier = body.tier;
          }
          if (Object.hasOwn(body, 'capacity')) {
            if (body.capacity === null) delete account.capacity;
            else account.capacity = body.capacity;
          }
          if (Object.hasOwn(body, 'allow')) account.allow = body.allow;
          if (Object.hasOwn(body, 'expiresAt')) {
            if (body.expiresAt === null) {
              delete account.expiresAt;
              delete account.expirySource;
            } else {
              account.expiresAt = body.expiresAt;
              account.expirySource = 'manual';
            }
          }
          return Response.json(account);
        }
        if (request.method === 'DELETE') {
          const index = providerAccounts.indexOf(account);
          if (index >= 0) providerAccounts.splice(index, 1);
          return Response.json({ ok: true });
        }
      }
      const match = /\/login\/([a-f0-9-]{36})(\/complete)?$/.exec(url.pathname);
      const login = match && providerLogins.get(match[1]);
      if (!login) return Response.json({ error: 'Not found' }, { status: 404 });
      if (request.method === 'POST' && match![2]) {
        providerAccounts.push({
          id: login.id,
          label: login.label,
          provider: login.provider,
          scope: 'client',
          client: 'private-sandbox',
          state: 'connected',
        });
        providerLogins.delete(login.id);
        return Response.json({ ok: true });
      }
      if (request.method === 'DELETE') {
        providerLogins.delete(login.id);
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const match = url.pathname.match(/^\/api\/tools\/([a-z_]+)$/);
    if (request.method !== 'POST' || !match) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    let args: Record<string, unknown> = {};
    try {
      args = (await request.json()) as Record<string, unknown>;
    } catch {
      args = {};
    }
    return await boxStubToolResponse(match[1], args);
  },
});

console.log(`UI sandbox CarapaBox stub listening on ${server.url}`);
