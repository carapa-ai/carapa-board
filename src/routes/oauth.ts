/**
 * MCP OAuth 2.1 authorization server for remote MCP clients (backend only).
 *
 * Hand-written rather than mounting the MCP SDK's `mcpAuthRouter`: the SDK
 * router binds one issuer URL at construction and fixed endpoint paths, while
 * this server derives its issuer per request from an origin allowlist
 * (`CARAPA_BOARD_PUBLIC_ORIGINS`), gates approval on a fresh device signature,
 * and revokes a grant when a rotated refresh token is replayed.
 *
 *   getOAuthPublicRouter()  /.well-known/*, /oauth/{register,authorize,token,revoke}, /auth.md
 *   getOAuthApiRouter()     /api/oauth/* (session-authenticated consent + grants APIs)
 */
import { randomUUID } from 'node:crypto';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { z } from 'zod';
import {
  createOAuthGrant,
  deleteOAuthToken,
  findOAuthRefreshToken,
  findOAuthTokenForRevocation,
  getLiveOAuthGrant,
  getOAuthAuthorizationRequest,
  getOAuthClient,
  insertOAuthAuthorizationCode,
  insertOAuthAuthorizationRequest,
  insertOAuthClient,
  listOAuthGrantsForUser,
  revokeOAuthGrant,
  rotateOAuthRefreshToken,
  takeOAuthAuthorizationCode,
  takeOAuthAuthorizationRequest,
  updateOAuthGrant,
  type OAuthGrantRow,
  type OAuthTokenInsert,
} from '../db/oauth.js';
import { GRANT_DAYS } from '../lib/device-auth/scopes.js';
import { verifyFreshSignature } from '../lib/device-auth/fresh-signature.js';
import {
  configuredPublicOrigins,
  isValidResourceForOrigin,
  originOfResource,
  resolvePublicOrigin,
  resourceUrl,
} from '../lib/oauth/origins.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_MS,
  AUTH_REQUEST_TTL_MS,
  SCOPES_SUPPORTED,
  effectiveGrantEntries,
  entryFolder,
  grantAccessLevel,
  hashSecret,
  isValidCodeChallenge,
  isValidRedirectUri,
  listGrantableTargets,
  mainFolderFor,
  newAccessToken,
  newAuthorizationCode,
  newClientId,
  newRefreshToken,
  newRequestId,
  scopeString,
  userMayGrant,
  verifyPkceS256,
  type OAuthGrantTargetEntry,
} from '../lib/oauth/service.js';
import {
  oauthAuthorizeLimiter,
  oauthRegisterLimiter,
  oauthTokenLimiter,
} from '../lib/rate-limit.js';
import { logger } from '../logger.js';
import { getUserById } from '../modules/knowledge/db-kb.js';
import { getGroupByFolder } from '../state-manager.js';
import { renderAuthGuide } from './oauth-guide.js';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const notFound = (res: Response) => {
  res.status(404).json({ error: 'Not found' });
};

/** 404 unless the request host is an allowlisted public origin. */
const withOrigin =
  (
    handler: (req: Request, res: Response, origin: string) => unknown,
  ): RequestHandler =>
  async (req, res, next) => {
    try {
      const origin = resolvePublicOrigin(req);
      if (!origin) return notFound(res);
      await handler(req, res, origin);
    } catch (err) {
      next(err);
    }
  };

function oauthError(
  res: Response,
  status: number,
  error: string,
  description?: string,
) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.status(status).json({
    error,
    ...(description ? { error_description: description } : {}),
  });
}

// ── Discovery ────────────────────────────────────────────────────────────────

function protectedResourceMetadata(origin: string, name: string) {
  return {
    resource: resourceUrl(origin, name),
    authorization_servers: [origin],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'CarapaBoard MCP',
  };
}

function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: SCOPES_SUPPORTED,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

function sendMetadata(res: Response, body: unknown) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.vary('Host').vary('X-Forwarded-Host');
  res.json(body);
}

// ── Dynamic client registration (RFC 7591, public clients) ───────────────────

const registrationSchema = z.object({
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.unknown()).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .optional(),
  response_types: z.array(z.literal('code')).optional(),
});

const cleanName = (name: string | undefined) =>
  (name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 100) || 'MCP client';

// ── Authorization endpoint ───────────────────────────────────────────────────

function redirectWith(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

// ── Token endpoint ───────────────────────────────────────────────────────────

function mintTokens(
  grantId: string,
  grantExpiresAt: string,
): {
  access: string;
  refresh: string;
  expiresIn: number;
  rows: OAuthTokenInsert[];
} | null {
  const now = Date.now();
  const remainingMs = Date.parse(grantExpiresAt) - now;
  if (remainingMs < 1000) return null;
  const accessTtlMs = Math.min(ACCESS_TOKEN_TTL_SECONDS * 1000, remainingMs);
  const access = newAccessToken();
  const refresh = newRefreshToken();
  return {
    access,
    refresh,
    expiresIn: Math.floor(accessTtlMs / 1000),
    rows: [
      {
        id: randomUUID(),
        grant_id: grantId,
        kind: 'access',
        token_hash: hashSecret(access),
        created_at: iso(now),
        expires_at: iso(now + accessTtlMs),
      },
      {
        id: randomUUID(),
        grant_id: grantId,
        kind: 'refresh',
        token_hash: hashSecret(refresh),
        created_at: iso(now),
        // Refresh never outlives the grant's approved duration.
        expires_at: grantExpiresAt,
      },
    ],
  };
}

function sendTokens(
  res: Response,
  minted: NonNullable<ReturnType<typeof mintTokens>>,
  access: string,
) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.json({
    access_token: minted.access,
    token_type: 'Bearer',
    expires_in: minted.expiresIn,
    refresh_token: minted.refresh,
    scope: scopeString(access),
  });
}

async function handleAuthorizationCodeGrant(
  body: Record<string, unknown>,
  res: Response,
  clientId: string,
) {
  const code = str(body.code);
  const verifier = str(body.code_verifier);
  const redirectUri = str(body.redirect_uri);
  if (!code || !verifier || !redirectUri) {
    return oauthError(
      res,
      400,
      'invalid_request',
      'code, code_verifier and redirect_uri are required',
    );
  }
  // Consume first: a code works once, even when the rest of the check fails.
  const row = await takeOAuthAuthorizationCode(hashSecret(code));
  if (
    !row ||
    row.client_id !== clientId ||
    row.redirect_uri !== redirectUri ||
    !verifyPkceS256(verifier, row.code_challenge)
  ) {
    return oauthError(res, 400, 'invalid_grant', 'Invalid authorization code');
  }
  const resource = str(body.resource);
  if (resource !== undefined && resource !== row.resource) {
    return oauthError(res, 400, 'invalid_target', 'resource does not match');
  }
  const user = await getUserById(row.user_id);
  if (
    !user ||
    user.disabled ||
    (await effectiveGrantEntries(row.targets, user)).length === 0
  ) {
    return oauthError(res, 400, 'invalid_grant', 'Grant is no longer valid');
  }
  const grantId = randomUUID();
  const minted = mintTokens(grantId, row.grant_expires_at);
  if (!minted) {
    return oauthError(res, 400, 'invalid_grant', 'Grant has expired');
  }
  await createOAuthGrant(
    {
      id: grantId,
      user_id: row.user_id,
      client_id: row.client_id,
      resource: row.resource,
      targets: row.targets,
      created_at: iso(),
      expires_at: row.grant_expires_at,
    },
    minted.rows,
  );
  logger.info(
    {
      event: 'oauth_grant_created',
      user_id: row.user_id,
      client_id: row.client_id,
      grant_id: grantId,
      targets: describeTargets(row.targets),
    },
    'MCP OAuth grant created',
  );
  sendTokens(res, minted, grantAccessLevel(row.targets));
}

async function handleRefreshTokenGrant(
  body: Record<string, unknown>,
  res: Response,
  clientId: string,
) {
  const refreshToken = str(body.refresh_token);
  if (!refreshToken) {
    return oauthError(res, 400, 'invalid_request', 'refresh_token is required');
  }
  const tokenHash = hashSecret(refreshToken);
  const found = await findOAuthRefreshToken(tokenHash);
  if (!found || found.grant.client_id !== clientId) {
    return oauthError(res, 400, 'invalid_grant', 'Invalid refresh token');
  }
  const { grant, user } = found;
  const resource = str(body.resource);
  if (resource !== undefined && resource !== grant.resource) {
    return oauthError(res, 400, 'invalid_target', 'resource does not match');
  }
  if (
    user.disabled ||
    (await effectiveGrantEntries(grant.targets, user)).length === 0
  ) {
    return oauthError(res, 400, 'invalid_grant', 'Grant is no longer valid');
  }
  const issued: { tokens: ReturnType<typeof mintTokens> } = { tokens: null };
  const rotation = await rotateOAuthRefreshToken(tokenHash, clientId, (g) => {
    issued.tokens = mintTokens(g.id, g.expires_at);
    return issued.tokens?.rows ?? null;
  });
  if (rotation.status === 'reused') {
    logger.warn(
      {
        event: 'oauth_refresh_reuse',
        user_id: grant.user_id,
        client_id: clientId,
        grant_id: grant.id,
      },
      'Rotated MCP OAuth refresh token reused; grant revoked',
    );
  }
  if (rotation.status !== 'ok' || !issued.tokens) {
    return oauthError(res, 400, 'invalid_grant', 'Invalid refresh token');
  }
  sendTokens(res, issued.tokens, grantAccessLevel(grant.targets));
}

const describeTargets = (targets: readonly OAuthGrantTargetEntry[]) =>
  targets.map((t) => `${t.kind}:${t.folder}:${t.access}`);

// ── Public router ────────────────────────────────────────────────────────────

export function getOAuthPublicRouter(): Router {
  const router = Router();

  router.get(
    '/.well-known/oauth-protected-resource',
    withOrigin((_req, res, origin) =>
      sendMetadata(res, protectedResourceMetadata(origin, 'carapa-board')),
    ),
  );
  router.get(
    '/.well-known/oauth-protected-resource/mcp/:name',
    withOrigin((req, res, origin) => {
      const name = String(req.params.name).toLowerCase();
      if (!isValidResourceForOrigin(resourceUrl(origin, name), origin)) {
        return notFound(res);
      }
      sendMetadata(res, protectedResourceMetadata(origin, name));
    }),
  );
  router.get(
    '/.well-known/oauth-authorization-server',
    withOrigin((_req, res, origin) =>
      sendMetadata(res, authorizationServerMetadata(origin)),
    ),
  );

  router.get(
    '/auth.md',
    withOrigin((_req, res, origin) => {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.vary('Host').vary('X-Forwarded-Host');
      res.type('text/markdown; charset=utf-8').send(renderAuthGuide(origin));
    }),
  );

  router.post(
    '/oauth/register',
    oauthRegisterLimiter,
    withOrigin(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const parsed = registrationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return oauthError(
          res,
          400,
          'invalid_client_metadata',
          'Only public clients (token_endpoint_auth_method "none") using the authorization_code and refresh_token grants are supported',
        );
      }
      const uris = parsed.data.redirect_uris;
      if (!uris.every(isValidRedirectUri)) {
        return oauthError(
          res,
          400,
          'invalid_redirect_uri',
          'redirect_uris must be https:// or loopback http://127.0.0.1 / http://localhost URIs without a fragment',
        );
      }
      const client = {
        id: newClientId(),
        client_name: cleanName(parsed.data.client_name),
        redirect_uris: [...new Set(uris as string[])],
        created_at: iso(),
      };
      if (!(await insertOAuthClient(client))) {
        return oauthError(
          res,
          503,
          'temporarily_unavailable',
          'Too many unapproved clients; try again later',
        );
      }
      res.status(201).json({
        client_id: client.id,
        client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }),
  );

  router.get(
    '/oauth/authorize',
    oauthAuthorizeLimiter,
    withOrigin(async (req, res, origin) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const q = req.query;
      const client = str(q.client_id)
        ? await getOAuthClient(str(q.client_id)!)
        : undefined;
      const redirectUri = str(q.redirect_uri);
      // Never redirect to an unverified redirect_uri: report these directly.
      if (!client) {
        return oauthError(res, 400, 'invalid_request', 'Unknown client_id');
      }
      if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
        return oauthError(
          res,
          400,
          'invalid_request',
          'redirect_uri does not exactly match a registered URI',
        );
      }
      const state = str(q.state);
      const fail = (error: string, description: string) =>
        res.redirect(
          302,
          redirectWith(redirectUri, {
            error,
            error_description: description,
            state,
          }),
        );
      if (
        q.state !== undefined &&
        (state === undefined || state.length > 512)
      ) {
        return fail('invalid_request', 'Invalid state');
      }
      if (q.response_type !== 'code') {
        return fail('unsupported_response_type', 'response_type must be code');
      }
      const challenge = str(q.code_challenge);
      if (
        !challenge ||
        !isValidCodeChallenge(challenge) ||
        q.code_challenge_method !== 'S256'
      ) {
        return fail(
          'invalid_request',
          'PKCE code_challenge with code_challenge_method=S256 is required',
        );
      }
      const resource = str(q.resource);
      if (!resource || !isValidResourceForOrigin(resource, origin)) {
        return fail(
          'invalid_target',
          'resource must be a CarapaBoard MCP endpoint on this origin',
        );
      }
      const requestId = newRequestId();
      const stored = await insertOAuthAuthorizationRequest({
        id: requestId,
        client_id: client.id,
        redirect_uri: redirectUri,
        state: state ?? null,
        code_challenge: challenge,
        resource,
        created_at: iso(),
        expires_at: iso(Date.now() + AUTH_REQUEST_TTL_MS),
      });
      if (!stored) {
        return fail('temporarily_unavailable', 'Too many pending requests');
      }
      res.redirect(
        302,
        `/oauth/consent?request=${encodeURIComponent(requestId)}`,
      );
    }),
  );

  router.post(
    '/oauth/token',
    oauthTokenLimiter,
    withOrigin(async (req, res) => {
      const body: Record<string, unknown> = req.body ?? {};
      const grantType = str(body.grant_type);
      if (!grantType) {
        return oauthError(
          res,
          400,
          'invalid_request',
          'grant_type is required',
        );
      }
      if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
        return oauthError(res, 400, 'unsupported_grant_type');
      }
      const clientId = str(body.client_id);
      const client = clientId ? await getOAuthClient(clientId) : undefined;
      if (!client) {
        return oauthError(res, 401, 'invalid_client', 'Unknown client_id');
      }
      return grantType === 'authorization_code'
        ? handleAuthorizationCodeGrant(body, res, client.id)
        : handleRefreshTokenGrant(body, res, client.id);
    }),
  );

  // RFC 7009: possession of the token is the authority; unknown tokens are a
  // silent success so the endpoint is not a token-validity oracle.
  router.post(
    '/oauth/revoke',
    oauthTokenLimiter,
    withOrigin(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const body: Record<string, unknown> = req.body ?? {};
      const token = str(body.token);
      if (!token) {
        return oauthError(res, 400, 'invalid_request', 'token is required');
      }
      const found = await findOAuthTokenForRevocation(hashSecret(token));
      const clientId = str(body.client_id);
      if (found && (!clientId || clientId === found.clientId)) {
        if (found.token.kind === 'refresh') {
          const grant = await revokeOAuthGrant(found.token.grant_id);
          if (grant) logGrantRevoked(grant);
        } else {
          await deleteOAuthToken(found.token.id);
        }
      }
      res.status(200).json({});
    }),
  );

  return router;
}

function logGrantRevoked(grant: OAuthGrantRow) {
  logger.info(
    {
      event: 'oauth_grant_revoked',
      user_id: grant.user_id,
      client_id: grant.client_id,
      grant_id: grant.id,
      targets: describeTargets(grant.targets),
    },
    'MCP OAuth grant revoked',
  );
}

// ── Session-authenticated API for the consent page and grants list ──────────

const requireUserSession: RequestHandler = (
  req: Request & { authUser?: { id: string }; authCredentialKind?: string },
  res: Response,
  next: NextFunction,
) => {
  if (!req.authUser || req.authCredentialKind !== 'user') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

const MAX_GRANT_TARGETS = 100;

const targetsSchema = z
  .array(
    z
      .object({
        kind: z.enum(['main', 'project']),
        folder: z.string().min(1).max(200).optional(),
        access: z.enum(['read', 'write']),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_GRANT_TARGETS);

const daysSchema = z
  .number()
  .refine((n) => (GRANT_DAYS as readonly number[]).includes(n));

const decisionSchema = z
  .object({
    decision: z.enum(['approve', 'deny']),
    targets: targetsSchema.optional(),
    days: daysSchema.optional(),
  })
  .strict();

const grantUpdateSchema = z
  .object({ targets: targetsSchema, days: daysSchema.optional() })
  .strict();

type ValidatedTargets =
  | { ok: true; entries: OAuthGrantTargetEntry[] }
  | { ok: false; status: number; error: string };

/**
 * Normalize requested targets to stored entries and re-validate every folder
 * with `userMayGrant` at the requested access. The list is exact: a parent
 * does not bring its children.
 */
async function validateRequestedTargets(
  user: { id: string; username: string; role: string },
  requested: z.infer<typeof targetsSchema>,
): Promise<ValidatedTargets> {
  const entries: OAuthGrantTargetEntry[] = [];
  const seen = new Set<string>();
  for (const item of requested) {
    const entry: OAuthGrantTargetEntry = {
      kind: item.kind,
      folder:
        item.kind === 'main'
          ? mainFolderFor(user.username)
          : (item.folder ?? ''),
      access: item.access,
    };
    if (seen.has(entry.folder)) {
      return { ok: false, status: 400, error: 'Duplicate project in grant' };
    }
    seen.add(entry.folder);
    if (!(await userMayGrant(user, entry, entry.access))) {
      return {
        ok: false,
        status: 403,
        error: 'You cannot grant this access to that project',
      };
    }
    entries.push(entry);
  }
  return { ok: true, entries };
}

export function getOAuthApiRouter(): Router {
  const router = Router();
  router.use(requireUserSession);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/requests/:id', async (req: any, res, next) => {
    try {
      const request = await getOAuthAuthorizationRequest(req.params.id);
      const client = request && (await getOAuthClient(request.client_id));
      const resourceOrigin = request && originOfResource(request.resource);
      if (
        !request ||
        !client ||
        !resourceOrigin ||
        !configuredPublicOrigins().includes(resourceOrigin)
      ) {
        return res
          .status(404)
          .json({ error: 'Authorization request expired or not found' });
      }
      res.json({
        id: request.id,
        client: { id: client.id, name: client.client_name },
        redirectHost: new URL(request.redirect_uri).host,
        resource: request.resource,
        expiresAt: request.expires_at,
        choices: {
          targets: await listGrantableTargets(req.authUser),
          access: ['read', 'write'],
          days: GRANT_DAYS,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Body: { decision: 'approve'|'deny', target: {kind:'main'}|{kind:'project',
  // folder}, access: 'read'|'write', days }. Answers { redirectUrl }; the SPA
  // navigates the browser there (an XHR cannot follow a client redirect URI).
  router.post('/requests/:id/decision', async (req: any, res, next) => {
    try {
      const parsed = decisionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid decision' });
      }
      const body = parsed.data;
      const user = req.authUser;
      const request = await getOAuthAuthorizationRequest(req.params.id);
      if (!request) {
        return res
          .status(404)
          .json({ error: 'Authorization request expired or not found' });
      }

      if (body.decision === 'deny') {
        if (!(await takeOAuthAuthorizationRequest(request.id))) {
          return res
            .status(404)
            .json({ error: 'Authorization request already decided' });
        }
        logger.info(
          {
            event: 'oauth_denied',
            user_id: user.id,
            client_id: request.client_id,
          },
          'MCP OAuth authorization denied',
        );
        return res.json({
          redirectUrl: redirectWith(request.redirect_uri, {
            error: 'access_denied',
            state: request.state ?? undefined,
          }),
        });
      }

      if (!body.targets || body.days === undefined) {
        return res
          .status(400)
          .json({ error: 'targets and days are required to approve' });
      }
      const resourceOrigin = originOfResource(request.resource);
      if (
        !resourceOrigin ||
        !configuredPublicOrigins().includes(resourceOrigin)
      ) {
        return res
          .status(404)
          .json({ error: 'Authorization request expired or not found' });
      }
      // High-impact action: approving needs a fresh device signature.
      const signature = await verifyFreshSignature(req);
      if (!signature.ok) {
        return res.status(signature.status).json({ error: signature.error });
      }
      const validated = await validateRequestedTargets(user, body.targets);
      if (!validated.ok) {
        return res.status(validated.status).json({ error: validated.error });
      }
      if (!(await takeOAuthAuthorizationRequest(request.id))) {
        return res
          .status(404)
          .json({ error: 'Authorization request already decided' });
      }

      const code = newAuthorizationCode();
      const now = Date.now();
      await insertOAuthAuthorizationCode({
        code_hash: hashSecret(code),
        client_id: request.client_id,
        user_id: user.id,
        redirect_uri: request.redirect_uri,
        code_challenge: request.code_challenge,
        resource: request.resource,
        targets: validated.entries,
        grant_expires_at: iso(now + body.days * 86_400_000),
        created_at: iso(now),
        expires_at: iso(now + AUTH_CODE_TTL_MS),
      });
      logger.info(
        {
          event: 'oauth_approved',
          user_id: user.id,
          client_id: request.client_id,
          targets: describeTargets(validated.entries),
          days: body.days,
        },
        'MCP OAuth authorization approved',
      );
      res.json({
        redirectUrl: redirectWith(request.redirect_uri, {
          code,
          state: request.state ?? undefined,
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/grants', async (req: any, res, next) => {
    try {
      const rows = await listOAuthGrantsForUser(req.authUser.id);
      res.json(
        rows.map(({ grant, clientName }) => ({
          id: grant.id,
          clientId: grant.client_id,
          clientName,
          resource: grant.resource,
          targets: grant.targets.map((entry) => {
            const folder = entryFolder(entry, req.authUser);
            return {
              kind: entry.kind,
              folder,
              name: getGroupByFolder(folder)?.name ?? folder,
              access: entry.access,
            };
          }),
          createdAt: grant.created_at,
          lastUsedAt: grant.last_used_at,
          expiresAt: grant.expires_at,
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  // What the grant-edit dialog may offer: same options as the consent screen.
  router.get('/grant-choices', async (req: any, res, next) => {
    try {
      res.json({
        targets: await listGrantableTargets(req.authUser),
        days: GRANT_DAYS,
      });
    } catch (err) {
      next(err);
    }
  });

  // Owner-only edit of a live grant's projects, per-project access and expiry
  // (`days` counts from now). Needs a fresh device signature like approval.
  // Scope is rebuilt per token use, so narrowing applies to the next request.
  router.patch('/grants/:id', async (req: any, res, next) => {
    try {
      const parsed = grantUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid grant update' });
      }
      const user = req.authUser;
      const existing = await getLiveOAuthGrant(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Grant not found' });
      if (existing.user_id !== user.id) {
        return res.status(403).json({ error: 'Not your grant' });
      }
      const signature = await verifyFreshSignature(req);
      if (!signature.ok) {
        return res.status(signature.status).json({ error: signature.error });
      }
      const validated = await validateRequestedTargets(
        user,
        parsed.data.targets,
      );
      if (!validated.ok) {
        return res.status(validated.status).json({ error: validated.error });
      }
      const { days } = parsed.data;
      const grant = await updateOAuthGrant(existing.id, user.id, {
        targets: validated.entries,
        ...(days !== undefined && {
          expiresAt: iso(Date.now() + days * 86_400_000),
        }),
      });
      if (!grant) return res.status(404).json({ error: 'Grant not found' });
      logger.info(
        {
          event: 'oauth_grant_updated',
          user_id: user.id,
          client_id: grant.client_id,
          grant_id: grant.id,
          targets: describeTargets(grant.targets),
          expires_at: grant.expires_at,
        },
        'MCP OAuth grant updated',
      );
      res.json({ ok: true, expiresAt: grant.expires_at });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/grants/:id', async (req: any, res, next) => {
    try {
      const grant = await revokeOAuthGrant(req.params.id, req.authUser.id);
      if (!grant) return res.status(404).json({ error: 'Grant not found' });
      logGrantRevoked(grant);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
