import { Router } from 'express';
import { CARAPA_BOX_URL, CARAPA_BOX_API_TOKEN } from '../config.js';
import { providerAccountAdmin } from './provider-accounts.js';

const BASE = '/admin/mcp-connections';
const NAME = /^[\w-]{1,128}$/;
const LOGIN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VALUE_LENGTH = 16 * 1024;

const isName = (value: unknown): value is string =>
  typeof value === 'string' && NAME.test(value);

/**
 * Field-whitelisting proxy to the CarapaBox api-relay's MCP OAuth connections
 * admin API. Admin + signed human device only; never a generic Box proxy.
 */
export function createMcpConnectionsRouter(
  request: typeof fetch = fetch,
  configuration = { url: CARAPA_BOX_URL, token: CARAPA_BOX_API_TOKEN },
) {
  const router = Router();
  router.use(BASE, providerAccountAdmin);
  const proxy = async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!configuration.token)
      return res.status(503).json({
        error: 'CarapaBox connection token is not configured',
      });
    const suffix: string = req.path.slice(BASE.length);
    const complete = /^\/login\/([^/]+)\/complete$/.exec(suffix);
    const loginId = complete?.[1] ?? /^\/login\/([^/]+)$/.exec(suffix)?.[1];
    const body = req.body;
    let forwarded: Record<string, string> | undefined;
    if (suffix === '' || suffix === '/') {
      if (req.method !== 'GET') return res.sendStatus(404);
    } else if (suffix === '/login' || suffix === '/revoke') {
      if (req.method !== 'POST') return res.sendStatus(404);
      if (!isName(body?.service) || !isName(body?.project))
        return res.status(400).json({ error: 'Invalid service or project' });
      forwarded = { service: body.service, project: body.project };
    } else if (loginId !== undefined) {
      if (!LOGIN_ID.test(loginId)) return res.sendStatus(404);
      if (complete) {
        if (req.method !== 'POST') return res.sendStatus(404);
        if (typeof body?.value !== 'string' || !body.value)
          return res.status(400).json({ error: 'Invalid value' });
        if (body.value.length > MAX_VALUE_LENGTH) return res.sendStatus(413);
        forwarded = { value: body.value };
      } else if (req.method !== 'DELETE') return res.sendStatus(404);
    } else return res.sendStatus(404);
    try {
      const upstream = await request(
        new URL(
          '/api/admin/mcp-connections' + (suffix === '/' ? '' : suffix),
          configuration.url,
        ),
        {
          method: req.method,
          headers: {
            Authorization: `Bearer ${configuration.token}`,
            'Content-Type': 'application/json',
          },
          body: forwarded ? JSON.stringify(forwarded) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!upstream.ok)
        return res.status(upstream.status).json({
          error:
            'MCP connection operation failed. Check the Box relay configuration or cancel and retry the login.',
        });
      const text = await upstream.text();
      return res.json(text ? JSON.parse(text) : { ok: true });
    } catch {
      return res
        .status(502)
        .json({ error: 'CarapaBox MCP connections are unavailable' });
    }
  };
  router.get(BASE, proxy);
  router.post(BASE + '/login', proxy);
  router.post(BASE + '/revoke', proxy);
  router.post(BASE + '/login/:id/complete', proxy);
  router.delete(BASE + '/login/:id', proxy);
  return router;
}

export default createMcpConnectionsRouter();
