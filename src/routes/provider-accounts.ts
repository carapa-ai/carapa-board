import { isIP } from 'node:net';
import { Router } from 'express';
import { CARAPA_BOX_URL, CARAPA_BOX_API_TOKEN } from '../config.js';
import { logger } from '../logger.js';
import {
  noteProviderAccounts,
  refreshModelDiscovery,
} from '../lib/model-discovery.js';
import { withOpenRouterModels } from '../modules/provider-usage/openrouter.js';
import { getGroupEntryByFolder, registeredGroups } from '../state-manager.js';
import { isOwnedByOtherUser } from '../lib/project-ownership.js';
import { resolveEffectiveSandbox } from '../sandbox/effective-settings.js';
import { LOCAL_BOX_ID } from '../modules/boxes/registry.js';
import { canAccessProject } from './_helpers.js';

const lacksHumanDevice = (req: any): boolean =>
  !req.authUser?.id ||
  !req.authDeviceId ||
  req.headers?.['x-carapa-device-id'] !== req.authDeviceId;

export function providerAccountAdmin(req: any, res: any, next: any) {
  if (lacksHumanDevice(req))
    return res
      .status(401)
      .json({ error: 'Human device authentication required' });
  // Use the credential actually accepted by the shared auth middleware.
  // A renewed cookie can be valid while apiFetch still sends an expired JWT.
  // Recognized agent tokens override this kind and remain forbidden.
  if (req.authUser.role !== 'admin' || req.authCredentialKind !== 'user') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

/** Signed-in human on an enrolled device, any role; agent and share tokens are refused. */
export function humanDeviceUser(req: any, res: any, next: any) {
  if (lacksHumanDevice(req))
    return res
      .status(401)
      .json({ error: 'Human device authentication required' });
  if (req.authCredentialKind !== 'user')
    return res.status(403).json({ error: 'Human user credential required' });
  return next();
}

function isValidExpiresAt(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
  );
}

/**
 * Ids of project keys the user may not see or change: those of a sandbox whose
 * owning project belongs to another user. An admin has no bypass there, as in
 * the project's own integrations route. Keys of no known project stay visible.
 */
function foreignProjectKeyIds(
  user: { id?: string } | undefined,
  listing: any,
): Set<string> {
  const accounts: any[] = Array.isArray(listing?.accounts)
    ? listing.accounts
    : [];
  const ownersBySandbox = new Map<string, Set<string>>();
  if (accounts.some((a) => a?.scope === 'project'))
    for (const group of Object.values(registeredGroups)) {
      const { stack, instance, ownerProjectId } =
        resolveEffectiveSandbox(group);
      const key = `${stack}\0${instance}`;
      ownersBySandbox.set(
        key,
        (ownersBySandbox.get(key) ?? new Set()).add(ownerProjectId),
      );
    }
  return new Set(
    accounts
      .filter(
        (a) =>
          a?.scope === 'project' &&
          [
            ...(ownersBySandbox.get(
              `${a.project?.stack}\0${a.project?.instance}`,
            ) ?? []),
          ].some((folder) => isOwnedByOtherUser(user?.id, folder)),
      )
      .map((a) => String(a.id)),
  );
}

export function createProviderAccountsRouter(
  request: typeof fetch = fetch,
  configuration = { url: CARAPA_BOX_URL, token: CARAPA_BOX_API_TOKEN },
  // Starts model discovery when the polled listing shows a finished login.
  onListing: (listing: any) => void = noteProviderAccounts,
  // An edited account (tier, capacity, label) can change which models it offers.
  onEdited: () => void = () =>
    void refreshModelDiscovery().catch((err) =>
      logger.warn({ err }, 'Model discovery after account edit failed'),
    ),
) {
  const router = Router();
  router.use('/admin/provider-accounts', providerAccountAdmin);
  const proxy = async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!configuration.token)
      return res.status(503).json({
        error: 'CarapaBox connection token is not configured',
      });
    const suffix = req.path.slice('/admin/provider-accounts'.length);
    const accountPath = /^\/[a-f0-9-]{36}$/.test(suffix);
    const allowed =
      req.method === 'PATCH' || (req.method === 'DELETE' && accountPath)
        ? accountPath
        : !suffix ||
          suffix === '/login' ||
          suffix === '/usage' ||
          suffix === '/order' ||
          /^\/login\/[a-f0-9-]{36}(\/complete)?$/.test(suffix);
    if (!allowed) return res.sendStatus(404);
    const ids = req.body?.ids;
    if (
      suffix === '/order' &&
      !(
        Array.isArray(ids) &&
        ids.length <= 100 &&
        ids.every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))
      )
    )
      return res
        .status(400)
        .json({ error: 'ids must be a list of account ids' });
    if (
      (suffix === '/login' &&
        req.body?.expiresAt !== undefined &&
        !isValidExpiresAt(req.body.expiresAt)) ||
      (req.method === 'PATCH' &&
        req.body &&
        Object.hasOwn(req.body, 'expiresAt') &&
        !isValidExpiresAt(req.body.expiresAt))
    )
      return res
        .status(400)
        .json({ error: 'expiresAt must be a YYYY-MM-DD date or null' });
    // Forward only the documented fields; never expose a generic Box admin proxy.
    const body =
      suffix === '/login'
        ? {
            provider: req.body?.provider,
            label: req.body?.label,
            scope: req.body?.scope,
            client: req.body?.client,
            // Present on Reconnect; absent when adding an account.
            accountId: req.body?.accountId,
            // API-key accounts: passed straight to Box, never logged or stored by Board.
            apiKey: req.body?.apiKey,
            workspaceId: req.body?.workspaceId,
            host: req.body?.host,
            expiresAt: req.body?.expiresAt,
          }
        : req.method === 'PATCH'
          ? Object.fromEntries(
              ['label', 'tier', 'capacity', 'expiresAt']
                .filter((key) => req.body && Object.hasOwn(req.body, key))
                .map((key) => [key, req.body[key]]),
            )
          : suffix === '/order'
            ? { ids }
            : suffix.endsWith('/complete')
              ? { value: req.body?.value }
              : undefined;
    if (body && JSON.stringify(body).length > 18000) return res.sendStatus(413);
    try {
      const send = (method: string, path: string, payload?: string) =>
        request(
          new URL('/api/admin/provider-accounts' + path, configuration.url),
          {
            method,
            headers: {
              Authorization: `Bearer ${configuration.token}`,
              'Content-Type': 'application/json',
            },
            body: payload,
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
          },
        );
      const loginId = /^\/login\/([a-f0-9-]{36})/.exec(suffix)?.[1];
      let foreign = new Set<string>();
      // A request naming an account or login, and the usage view, consult the listing first.
      if (
        accountPath ||
        loginId ||
        suffix === '/usage' ||
        suffix === '/order' ||
        (suffix === '/login' && req.body?.accountId !== undefined)
      ) {
        const listing = await send('GET', '');
        if (!listing.ok) throw new Error('listing');
        const view: any = await listing.json();
        foreign = foreignProjectKeyIds(req.authUser, view);
        const targets = [
          accountPath ? suffix.slice(1) : undefined,
          req.body?.accountId,
          ...(suffix === '/order' ? ids : []),
          ...(Array.isArray(view?.logins)
            ? view.logins
                .filter((l: any) => l?.id === loginId)
                .map((l: any) => l.accountId)
            : []),
        ];
        if (targets.some((id) => foreign.has(String(id))))
          return res.sendStatus(404);
      }
      const upstream = await send(
        req.method,
        suffix,
        req.method === 'POST' || req.method === 'PATCH'
          ? JSON.stringify(body)
          : undefined,
      );
      if (!upstream.ok) {
        // Box rejects invalid account edits and API keys with a message the admin needs to see.
        const boxMessage =
          (req.method === 'PATCH' ||
            accountPath ||
            suffix === '/login' ||
            suffix === '/order') &&
          upstream.status >= 400 &&
          upstream.status < 500
            ? await upstream
                .json()
                .then((b: any) =>
                  typeof b?.error === 'string'
                    ? b.error.slice(0, 300)
                    : undefined,
                )
                .catch(() => undefined)
            : undefined;
        return res.status(upstream.status).json({
          error:
            boxMessage ??
            'Provider account operation failed. Check Box configuration or cancel and retry the login.',
        });
      }
      const data: any = await upstream.json();
      if (!suffix && req.method === 'GET') onListing(data);
      if (req.method === 'PATCH' || accountPath) onEdited();
      if (!suffix && req.method === 'GET') {
        const hidden = foreignProjectKeyIds(req.authUser, data);
        return res.json({
          ...data,
          accounts: data.accounts?.filter((a: any) => !hidden.has(a?.id)),
          logins: data.logins?.filter((l: any) => !hidden.has(l?.accountId)),
        });
      }
      if (suffix === '/usage' && foreign.size) {
        const visible = (byId: any) =>
          byId &&
          Object.fromEntries(
            Object.entries(byId).filter(([id]) => !foreign.has(id)),
          );
        data.usage = visible(data.usage);
        data.apiSpendByAccount = visible(data.apiSpendByAccount);
      }
      // Box returns every OpenRouter price; the screen shows only Board's models.
      return res.json(suffix === '/usage' ? withOpenRouterModels(data) : data);
    } catch {
      return res
        .status(502)
        .json({ error: 'CarapaBox provider accounts are unavailable' });
    }
  };
  router.get('/admin/provider-accounts', proxy);
  router.get('/admin/provider-accounts/usage', proxy);
  router.post('/admin/provider-accounts/login', proxy);
  router.post('/admin/provider-accounts/order', proxy);
  router.post('/admin/provider-accounts/login/:id/complete', proxy);
  router.delete('/admin/provider-accounts/login/:id', proxy);
  router.patch('/admin/provider-accounts/:id', proxy);
  router.delete('/admin/provider-accounts/:id', proxy);
  return router;
}

export default createProviderAccountsRouter();

const INTEGRATION_PROVIDERS = ['gitlab', 'github', 'custom'];
const ACCOUNT_ID = /^[a-f0-9-]{36}$/;

/** The sandbox instance whose containers a project key serves, or why there is none. */
function projectSandbox(
  sandbox: ReturnType<typeof resolveEffectiveSandbox>,
): { stack: string; instance: string } | { error: string; status: number } {
  // Box reads the containers and the relay matches them on the local box only.
  if (sandbox.boxId && sandbox.boxId !== LOCAL_BOX_ID)
    return {
      status: 400,
      error: 'Project keys work only for sandboxes on the local CarapaBox',
    };
  return { stack: sandbox.stack, instance: sandbox.instance };
}

/**
 * Whether a non-admin may not name this host: an IP address, a host name
 * without a dot, or a port. Lexical only; a value that is not a URL is left to Box.
 */
function restrictedHost(value: unknown): boolean {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  return (
    url.port !== '' ||
    url.hostname.startsWith('[') ||
    isIP(url.hostname) !== 0 ||
    !url.hostname.includes('.')
  );
}

function validAllowInput(allow: unknown): boolean {
  return (
    Array.isArray(allow) &&
    allow.length >= 1 &&
    allow.length <= 32 &&
    allow.every(
      (rule) =>
        rule &&
        typeof rule === 'object' &&
        typeof rule.method === 'string' &&
        typeof rule.path === 'string' &&
        rule.path.length <= 512,
    )
  );
}

/**
 * A project's integrations (Project settings → Integrations). Each token and
 * its allowed calls go to CarapaBox, which keeps them with the Provider accounts;
 * Board derives the sandbox instance itself and never stores the key.
 */
export function createProjectIntegrationsRouter(
  request: typeof fetch = fetch,
  configuration = { url: CARAPA_BOX_URL, token: CARAPA_BOX_API_TOKEN },
) {
  const router = Router();
  const box = (method: string, suffix: string, body?: unknown) =>
    request(
      new URL('/api/admin/provider-accounts' + suffix, configuration.url),
      {
        method,
        headers: {
          Authorization: `Bearer ${configuration.token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
  const boxError = async (upstream: Response) =>
    upstream.status >= 400 && upstream.status < 500
      ? await upstream
          .json()
          .then((b: any) =>
            typeof b?.error === 'string' ? b.error.slice(0, 300) : undefined,
          )
          .catch(() => undefined)
      : undefined;
  /** This project's keys from the Box listing. */
  const projectKeys = async (sandbox: { stack: string; instance: string }) => {
    const upstream = await box('GET', '');
    if (!upstream.ok) throw new Error('listing');
    const listing: any = await upstream.json();
    return (Array.isArray(listing?.accounts) ? listing.accounts : []).filter(
      (a: any) =>
        a?.scope === 'project' &&
        a.project?.stack === sandbox.stack &&
        a.project?.instance === sandbox.instance,
    );
  };
  /** After a Box write was accepted: a failed re-list must not turn it into an error. */
  const relist = (sandbox: { stack: string; instance: string }) =>
    projectKeys(sandbox).catch(() => null);
  const handle =
    (
      fn: (
        req: any,
        res: any,
        sandbox: { stack: string; instance: string },
      ) => Promise<any>,
    ) =>
    async (req: any, res: any) => {
      res.setHeader('Cache-Control', 'no-store');
      const pid = String(req.params.pid);
      const entry = getGroupEntryByFolder(pid);
      if (!entry) return res.status(404).json({ error: 'Project not found' });
      const effective = resolveEffectiveSandbox(entry.group);
      // Keys belong to the project that owns the sandbox; decided before any Box call.
      if (
        !(await canAccessProject(req.authUser, effective.ownerProjectId, {
          min: 'owner',
        }))
      )
        return res.status(403).json({
          error: effective.inherited
            ? `Integrations of this project are managed on ${effective.ownerProjectId}`
            : 'Only the project owner can manage integrations',
        });
      if (!configuration.token)
        return res
          .status(503)
          .json({ error: 'CarapaBox connection token is not configured' });
      const sandbox = projectSandbox(effective);
      if ('error' in sandbox)
        return res.status(sandbox.status).json({ error: sandbox.error });
      try {
        return await fn(req, res, sandbox);
      } catch {
        return res
          .status(502)
          .json({ error: 'CarapaBox provider accounts are unavailable' });
      }
    };
  const reply = async (res: any, upstream: Response, then: () => any) =>
    upstream.ok
      ? res.json(await then())
      : res.status(upstream.status).json({
          error:
            (await boxError(upstream)) ??
            'Project key operation failed. Check the CarapaBox configuration.',
        });

  router.get(
    '/projects/:pid/integrations',
    handle(async (_req, res, sandbox) =>
      res.json({ sandbox, accounts: await projectKeys(sandbox) }),
    ),
  );
  router.post(
    '/projects/:pid/integrations',
    handle(async (req, res, sandbox) => {
      const { provider, host, route, baseUrl, auth, apiKey, allow } =
        req.body ?? {};
      if (
        !INTEGRATION_PROVIDERS.includes(provider) ||
        typeof apiKey !== 'string'
      )
        return res
          .status(400)
          .json({ error: 'Choose the service and paste the token' });
      if (!validAllowInput(allow))
        return res.status(400).json({ error: 'Add at least one allowed call' });
      if (
        req.authUser.role !== 'admin' &&
        restrictedHost(provider === 'custom' ? baseUrl : host)
      )
        return res.status(400).json({
          error:
            'Enter a public host name such as https://gitlab.example.com. An IP address, a host name without a dot or a port needs a board admin',
        });
      const name = provider === 'custom' ? route : provider;
      const label = `Project ${req.params.pid} · ${name}`.slice(0, 80);
      // Box validates every field; GitLab and GitHub fix their own route and token header.
      const upstream = await box('POST', '/login', {
        provider,
        label,
        scope: 'project',
        project: sandbox,
        apiKey,
        allow,
        ...(provider === 'custom' ? { route, baseUrl, auth } : { host }),
      });
      return reply(res, upstream, async () => ({
        sandbox,
        accounts: await relist(sandbox),
      }));
    }),
  );
  /** Edits or removes a key only after checking it belongs to this project. */
  const owned = (
    method: 'PATCH' | 'DELETE',
    body: (req: any) => unknown | null,
  ) =>
    handle(async (req, res, sandbox) => {
      const id = String(req.params.id);
      if (!ACCOUNT_ID.test(id)) return res.sendStatus(404);
      const payload = body(req);
      if (payload === null)
        return res.status(400).json({ error: 'Add at least one allowed call' });
      if (!(await projectKeys(sandbox)).some((a: any) => a.id === id))
        return res
          .status(404)
          .json({ error: 'This key does not belong to the project' });
      const upstream = await box(method, '/' + id, payload);
      return reply(res, upstream, async () => ({
        sandbox,
        accounts: await relist(sandbox),
      }));
    });
  router.patch(
    '/projects/:pid/integrations/:id',
    owned('PATCH', (req) =>
      validAllowInput(req.body?.allow) ? { allow: req.body.allow } : null,
    ),
  );
  router.delete(
    '/projects/:pid/integrations/:id',
    owned('DELETE', () => undefined),
  );
  return router;
}

export const projectIntegrationsRouter = createProjectIntegrationsRouter();
