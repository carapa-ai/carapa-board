import { signJwt as signIntegrationJwt } from './lib/auth-jwt.js';
import { integrationAccess } from './lib/device-auth/access.js';
import { getDevicePairingRouter } from './routes/device-pairing.js';
import { getDeviceRecord } from './db.js';
import { startRuntimeNotifications } from './runtime-notifications.js';
import { hasWebSocketClients } from './modules/objectives/ws-events.js';
import express from 'express';
import { verifyToken } from './mcp/auth-tokens.js';
import boxesRouter, { relayForwarderPolicy } from './routes/boxes.js';
import mcpConnectionsRouter from './routes/mcp-connections.js';
import providerAccountsRouter, {
  projectIntegrationsRouter,
  providerAccountAdmin,
  humanDeviceUser,
} from './routes/provider-accounts.js';
import {
  verifyJwt,
  isStaleUserSession,
  SESSION_COOKIE,
  buildSessionCookie,
} from './lib/auth-jwt.js';
import { adminBypassesProject } from './lib/project-ownership.js';
import cors from 'cors';
import fs from 'fs';
import type { Stats } from 'fs';
import fsp from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import path from 'path';

import {
  getWhatsAppStatus,
  getGroupByFolder,
  registeredGroups,
} from './state-manager.js';
import { broadcast } from './modules/objectives/ws-events.js';
import {
  registerDeviceKey,
  getDevicePublicKey,
  verifyUserCredentials,
  getUserById,
  getUserIdByDevice,
  getDeviceStateForUser,
  getDevicesForUser,
  listUsers,
  type AuthUser,
} from './db.js';
import { presentAccountIdentity } from './modules/account/profile.js';
import { touchDeviceLastUsed } from './lib/device-activity.js';
import { verifyFreshSignature } from './lib/device-auth/fresh-signature.js';
import { signUserJwt } from './lib/auth-jwt.js';
import { loginLimiter, tokenLimiter } from './lib/rate-limit.js';
import {
  isOAuthMcpPath,
  protectedResourceMetadataUrl,
  resolvePublicOrigin,
} from './lib/oauth/origins.js';
import {
  isOAuthAccessTokenShape,
  mainFolderFor,
  resolveOAuthAccessToken,
} from './lib/oauth/service.js';
import { getOAuthApiRouter, getOAuthPublicRouter } from './routes/oauth.js';
import {
  requireAdmin,
  userCanAccessGroup,
  userCanReadProjectDashboard,
} from './routes/_helpers.js';
import { requestTiming } from './lib/request-timing.js';
import {
  verifySignature,
  createSigningPayload,
  isFreshTimestamp,
} from './crypto-verify.js';
import { started_at } from './modules/objectives/ws-events.js';
import {
  DATA_DIR,
  MCP_WHATSAPP_BASE_URL,
  CARAPA_WA_LINK_TOKEN,
  CORS_ORIGIN,
  ENABLE_WHATSAPP,
  STORE_DIR,
  CARAPA_BOARD_DEPLOY_SERVICE,
  BOARD_SELF_DEPLOY_ENABLED,
  BROWSER_LOCAL_HOSTNAMES,
} from './config.js';
import {
  BUILD_SERVICE_CALL_OPTIONS,
  getSandboxClient,
} from './lib/mcp-client.js';
import {
  getServerWebBuildStatus,
  isServerWebRestartPending,
  markServerWebBuildBuilding,
  markServerWebBuildFailed,
  markServerWebBuildReady,
} from './lib/server-web-build-status.js';
import {
  pauseBackgroundWork,
  resumeBackgroundWork,
} from './lib/background-work-gate.js';
import {
  attachWebSocket,
  setSessionVerifier,
  createWsTicket,
} from './modules/objectives/ws-events.js';
import { createRestartWaiter } from './lib/restart-wait.js';
import { logger } from './logger.js';
import { buildCorsOptions, isWildcardCorsOrigin } from './lib/cors.js';
import {
  reportBuildFailureCard,
  resolveBuildFailureCards,
} from './modules/kanban/build-failure-card.js';
import {
  openDirAt,
  openFileAt,
  type PinnedDir,
  sendPinnedFile,
} from './lib/group-fs.js';
import {
  artifactThumbnailPath,
  ensureArtifactThumbnail,
} from './modules/chat/artifact-thumbnails.js';
import {
  openArtifactFile,
  openArtifactsRoot,
  sendArtifactFile,
} from './modules/chat/artifacts.js';
import {
  detectMimetypeForHandle,
  isActiveContentMimetype,
  MAX_UPLOAD_SERVE_BYTES,
  mimetypeForPath,
} from './lib/file-content.js';
import { readContainedFile } from './lib/read-contained-file.js';
import {
  hasDashboardPathTokenAccess,
  verifyDashboardTicket,
} from './modules/objectives/dashboard-access.js';
import { issueMediaTicket, resolveMediaTicket } from './lib/media-tickets.js';
import {
  effectiveContainerUploadDir,
  effectiveProjectUploadDir,
  resolveEffectiveSandbox,
} from './sandbox/effective-settings.js';
import { getProjectAccess } from './modules/knowledge/db-kb.js';
import {
  implicitUserMayReadGroupFile,
  type GroupFileReference,
} from './lib/conversation-file-references.js';

let boardBuildInProgress = false;

import projectsRouter, {
  startProjectChangeMonitor,
} from './routes/projects.js';
import publicConversationsRouter from './routes/public-conversations.js';
import { ANDROID_OTA_DIR } from './lib/android-ota.js';
import sandboxRouter from './routes/sandbox.js';
import tmuxRouter from './routes/tmux.js';
import browserRouter from './routes/browser.js';
import observationsRouter from './routes/observations.js';
import eventsRouter from './routes/events.js';
import usersRouter from './routes/users.js';
import preferencesRouter from './routes/preferences.js';
import securityRouter from './routes/security.js';
import accountRouter from './routes/account.js';
import { aiUsersAdminRouter } from './routes/ai-users.js';
import activeRunsRouter from './routes/active-runs.js';
import meetingsRouter from './routes/meetings.js';
import reportsRouter from './routes/reports.js';
import historyReviewRouter from './routes/history-review.js';
import memoryAuditsRouter from './routes/memory-audits.js';
import pushRouter, {
  handleUnreadNotifications,
  handleAckUnreadNotifications,
  handlePayloadByIdSession,
  handleAckPayloadSession,
} from './routes/push.js';
import { mountMcpRoutes } from './mcp/mcp-server.js';
import { sharedDeps } from './mcp/mcp-deps.js';

const DASHBOARD_COOKIE = 'carapa_dashboard_ticket';

// Device-key (integration) JWTs are never sessions. This is also the WebSocket
// verifier (`setSessionVerifier`) and gates `/api/ws-ticket`, so a device key
// cannot subscribe to /api/ws and receive objective chat events without
// `objectives:read`. If device keys ever get live events, filter
// objective-tagged chat events by scope first.
function verifySessionJwt(id: string): ReturnType<typeof verifyJwt> {
  const payload = verifyJwt(id);
  return payload !== null &&
    payload.type !== 'device' &&
    payload.sub !== 'anonymous'
    ? payload
    : null;
}

function isValidSession(id: string): boolean {
  return verifySessionJwt(id) !== null;
}

/** A valid session whose user has not changed their password since it was
 *  issued. Used where a session is picked by validity (auth check, WS ticket). */
async function isCurrentSession(id: string): Promise<boolean> {
  const payload = verifySessionJwt(id);
  if (!payload) return false;
  if (payload.type !== 'user' || !payload.sub) return true;
  return !isStaleUserSession(payload, await getUserById(payload.sub));
}

/** Parse cookies from a raw Cookie header string. */
function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  }
  return cookies;
}

export const app = express();

// Trust proxy hop count for X-Forwarded-* headers — needed for the rate
// limiter to see the real client IP behind a reverse proxy. Default 0 (no
// trust) so a misconfigured deploy can't be tricked into per-IP-spoof bypass
// of the auth limits. Operators behind a known proxy chain should set
// TRUST_PROXY_HOPS=1 (or the appropriate hop count).
const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10);
if (trustProxyHops > 0) {
  app.set('trust proxy', trustProxyHops);
}

// Request-level timing/observability — registered before any other middleware
// so it captures the full handler lifecycle, including auth + body parsing.
app.use(requestTiming());

if (isWildcardCorsOrigin(CORS_ORIGIN)) {
  logger.warn(
    'CORS_ORIGIN=* allows every origin to call the Board API; list the origins you use instead',
  );
}
app.use(cors(buildCorsOptions(CORS_ORIGIN)));
app.use(
  express.json({
    limit: '50mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString();
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Anonymous, token-scoped conversation sharing. Mount before the global API
// authentication and device-signature gates; every handler validates its own
// high-entropy conversation token and exposes only the public projection.
app.use('/api/public', publicConversationsRouter);

// Health check endpoint (exempt from auth)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), started_at });
});

// The web UI is built independently from deployment-specific environment
// files. Serve the non-secret LAN aliases at runtime so custom local hostnames
// are classified correctly even when CarapaBox builds the Dockerfile directly.
// Central api-relay → Board: forwarder policy lookup. Authenticated with the
// shared CARAPA_RELAY_HUB_SECRET, not user sessions.
app.get('/api/relay/forwarders/:boxId', relayForwarderPolicy);
app.get('/api/network-config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ localHostnames: BROWSER_LOCAL_HOSTNAMES });
});

// Signed Android web-bundle updates are deliberately public, like the static
// UI itself. The APK verifies the Ed25519 signature before handing a bundle to
// Capacitor Updater, so these routes must remain ahead of API authentication.
app.get('/android-updates/latest.json', (_req, res) => {
  const manifestPath = path.join(ANDROID_OTA_DIR, 'latest.json');
  if (!fs.existsSync(manifestPath)) {
    return res.status(404).json({ error: 'No Android update is published' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(manifestPath);
});

app.get('/android-updates/bundles/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[a-f0-9]{24}\.zip$/.test(file)) {
    return res.status(404).json({ error: 'Update bundle not found' });
  }
  const bundlePath = path.join(ANDROID_OTA_DIR, 'bundles', file);
  if (!fs.existsSync(bundlePath)) {
    return res.status(404).json({ error: 'Update bundle not found' });
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(bundlePath);
});

async function requireFreshSignature(
  req: any,
  res: any,
  next: any,
): Promise<any> {
  const result = await verifyFreshSignature(req);
  if (!result.ok) {
    if (req.path.toLowerCase().startsWith('/devices/push-token')) {
      logger.warn(
        {
          method: req.method,
          device_id: req.headers['x-carapa-device-id'],
          status: result.status,
          reason: result.error,
        },
        '[push:token] request rejected by signature check',
      );
    }
    return res.status(result.status).json({ error: result.error });
  }
  return next();
}

/** Like requireFreshSignature, but reads (GET/HEAD) pass through unsigned. */
function requireFreshSignatureForWrites(req: any, res: any, next: any) {
  return req.method === 'GET' || req.method === 'HEAD'
    ? next()
    : requireFreshSignature(req, res, next);
}

/** Token scope of a user's own main project (no extra permissions). */
function mainUserScope(user: { username: string }) {
  return { group_folder: mainFolderFor(user.username), permissions: {} };
}

// Security check: require a Bearer token or session cookie.
// Only protect API endpoints, not the static UI
const protectedApiPaths = ['/api/', '/uploads/', '/mcp/'];
// MCP OAuth discovery + protocol endpoints are reached before any credential
// exists. They 404 themselves unless the host is an allowlisted public origin.
const oauthPublicPaths = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp/carapa-board',
  '/.well-known/oauth-authorization-server',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/revoke',
  '/auth.md',
];
const authExemptPaths = [
  '/api/auth/check',
  '/api/auth/login',
  '/api/auth/token',
  '/api/auth/device-pairing',
  '/api/auth/device-pairing/poll',
  '/health',
  ...oauthPublicPaths,
];
// Routes that authenticate via X-Carapa-Signature (requireFreshSignature),
// not Bearer/session. The native FCM service signs without a Bearer token,
// so we must skip the upstream Bearer-or-session check for these.
const signedAuthPrefixes = [
  '/api/devices/push-token',
  '/api/notifications/',
  '/api/native/tts/',
];
app.use(integrationAccess);
app.use(async (req: any, res: any, next: any) => {
  if (req.integrationGrant) return next();
  const cookies = parseCookies(req.headers.cookie);
  const sessionValue = cookies[SESSION_COOKIE];
  const sessionPayload = sessionValue ? verifySessionJwt(sessionValue) : null;
  const sessionUser = sessionPayload?.sub
    ? await getUserById(sessionPayload.sub)
    : undefined;
  // A session issued before the user's last password change grants nothing and
  // is not re-issued below.
  const payload =
    sessionPayload && !isStaleUserSession(sessionPayload, sessionUser)
      ? sessionPayload
      : null;
  if (sessionValue && payload) {
    const authUser = sessionUser;
    // Tentatively assign — the consolidated device-state check below will
    // revoke the session if the bound device is deactivated or missing.
    const did = typeof payload.did === 'string' ? payload.did : undefined;
    req.authUser = authUser;
    req.authDeviceId = did;
    req.authCredentialKind = 'user';
    // A session whose user no longer exists (deleted) grants no scope.
    if (authUser) {
      req.tokenScope = mainUserScope(authUser);
    }

    // Sliding session: once the cookie's JWT is past half its lifetime, re-issue
    // a fresh one so an active user's session never expires mid-work. The
    // half-life threshold avoids emitting Set-Cookie on every background poll
    // while still refreshing well before the 24h expiry.
    if (
      payload.sub &&
      typeof payload.iat === 'number' &&
      typeof payload.exp === 'number'
    ) {
      const now = Math.floor(Date.now() / 1000);
      const lifetime = payload.exp - payload.iat;
      if (lifetime > 0 && now - payload.iat > lifetime / 2) {
        const fresh = signUserJwt(payload.sub, did, authUser?.tokenVersion);
        res.setHeader('Set-Cookie', buildSessionCookie(fresh, req, 31536000));
      }
    }
  }

  // Also extract from JWT if cookie/session isn't present
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : (req.query.token as string) || null;

  // MCP OAuth access tokens are accepted from the Authorization header only,
  // and replace (never merge with) any cookie identity on the same request.
  const oauthBearer =
    authHeader?.startsWith('Bearer ') &&
    bearerToken &&
    isOAuthAccessTokenShape(bearerToken)
      ? await resolveOAuthAccessToken(bearerToken)
      : null;
  if (oauthBearer) {
    req.authUser = undefined;
    req.authDeviceId = undefined;
    req.tokenScope = oauthBearer.scope;
    req.authCredentialKind = 'oauth';
    req.oauthResourceOrigin = oauthBearer.resourceOrigin;
  } else if (bearerToken) {
    const jwtPayload = verifyJwt(bearerToken);
    if (jwtPayload) {
      if (jwtPayload.type === 'user' && jwtPayload.sub) {
        const user = await getUserById(jwtPayload.sub);
        const did =
          typeof jwtPayload.did === 'string' ? jwtPayload.did : undefined;
        // A token issued before the user's last password change is refused.
        if (!isStaleUserSession(jwtPayload, user)) {
          // Tentatively assign — the consolidated device-state check below will
          // revoke if the bound device is deactivated or missing.
          req.authUser = user;
          req.authDeviceId = did;
          req.authCredentialKind = 'user';
          // Deleted user: no authUser and no scope (never fall back to main).
          if (user) {
            req.tokenScope = mainUserScope(user);
          }
        }
      } else if (jwtPayload.type === 'agent' && jwtPayload.scope) {
        req.tokenScope = jwtPayload.scope;
        req.authCredentialKind = 'agent';
      }
    } else {
      const scope = verifyToken(bearerToken);
      if (scope) {
        req.tokenScope = scope;
        req.authCredentialKind = 'agent';
      }
    }
  }

  // A media ticket stands in for its issuer's session on one file URL, so a
  // bare <video>/<audio src> can stream it on clients that authenticate with
  // headers (Android). The disabled-account, device-state, pending-device and
  // project-access checks below still apply.
  if (!req.authUser && !req.tokenScope) {
    const ticket = resolveMediaTicket(req.method, req.originalUrl);
    if (ticket) {
      const user = await getUserById(ticket.userId);
      req.authUser = user;
      req.authDeviceId = ticket.deviceId;
      req.authCredentialKind = 'user';
      if (user) {
        req.tokenScope = mainUserScope(user);
      }
    }
  }

  // Disabled accounts lose their session/token effect immediately, regardless
  // of any cached cookie or JWT. The auth/login path will already reject them
  // at credential check; this catches in-flight sessions.
  if (req.authUser?.disabled) {
    req.authUser = undefined;
    req.tokenScope = undefined;
  }

  // The header is client-supplied, so the shared touch path retains the
  // ownership scope: a spoofed header cannot update another user's row.
  const headerDeviceId = req.headers['x-carapa-device-id'] as
    | string
    | undefined;
  if (req.authUser?.id && headerDeviceId) {
    if (!req.authDeviceId) req.authDeviceId = headerDeviceId;
    touchDeviceLastUsed(headerDeviceId, req.authUser.id);
  }

  // One consolidated device-state lookup that drives both session revocation
  // (deactivated or missing device → drop session) and the pending-device
  // gate downstream (active but unapproved → 403). Stashing the row on `req`
  // means we hit the DB once per request instead of twice.
  if (req.authUser?.id && req.authDeviceId) {
    const state = await getDeviceStateForUser(
      req.authDeviceId,
      req.authUser.id,
    );
    if (!state || !state.isActive) {
      req.authUser = undefined;
      req.authDeviceId = undefined;
      req.tokenScope = undefined;
    } else {
      req.deviceState = state;
    }
  }

  // Express routing is case-insensitive, so every gate comparison must be too.
  const lowerPath = req.path.toLowerCase();
  if (authExemptPaths.includes(lowerPath)) return next();
  // Signed-request routes (push-token + notifications) authenticate via the
  // device-keypair signature middleware (requireFreshSignature) mounted on
  // the router itself. Skip the Bearer/session gate so the native FCM
  // service — which has no Bearer token — can reach them.
  // The signed-request bypass is for the native FCM service only. The in-app
  // bell endpoint (/api/notifications/unread) authenticates via session and
  // is mounted outside pushRouter, so it must NOT skip the bearer/session
  // gate here — otherwise an unauthenticated caller could reach it.
  if (
    signedAuthPrefixes.some((p) => lowerPath.startsWith(p)) &&
    lowerPath !== '/api/notifications/unread' &&
    lowerPath !== '/api/notifications/unread/ack'
  ) {
    return next();
  }

  const isProtectedApi = protectedApiPaths.some((p) => lowerPath.startsWith(p));
  const dashboardPath = req.path.match(
    /^\/api\/projects\/([^/]+)\/objectives\/([^/]+)\/dashboard(?:\/|$)/i,
  );
  // A repeated `?ticket=a&ticket=b` parses to an array; only a string counts.
  const queryTicket =
    typeof req.query.ticket === 'string' ? req.query.ticket : null;
  const dashboardTicket = cookies[DASHBOARD_COOKIE] || queryTicket || null;
  const hasDashboardAccess =
    (!!dashboardPath &&
      !!dashboardTicket &&
      verifyDashboardTicket(
        dashboardTicket,
        decodeURIComponent(dashboardPath[1]),
        decodeURIComponent(dashboardPath[2]),
      )) ||
    (await hasDashboardPathTokenAccess(
      req.method,
      req.path,
      userCanReadProjectDashboard,
    ));

  if (!isProtectedApi) return next();

  if (hasDashboardAccess) return next();

  if (req.authUser || req.tokenScope) return next();

  return unauthorized(req, res);
});

/** 401 that, on MCP endpoints of an allowlisted origin, points to the PRM. */
function unauthorized(req: express.Request, res: express.Response) {
  if (isOAuthMcpPath(req.path)) {
    const origin = resolvePublicOrigin(req);
    if (origin) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${protectedResourceMetadataUrl(origin, req.path)}"`,
      );
    }
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// OAuth-scoped credentials are valid only on the agent MCP endpoints, and only
// on the public origin their `resource` was bound to. Runs even when auth is
// otherwise disabled, so a token never widens beyond its grant.
app.use((req: any, res: any, next: any) => {
  if (req.tokenScope?.kind !== 'oauth') return next();
  if (!isOAuthMcpPath(req.path)) {
    return res
      .status(403)
      .json({ error: 'OAuth token has no access to this endpoint' });
  }
  if (resolvePublicOrigin(req) !== req.oauthResourceOrigin)
    return unauthorized(req, res);
  return next();
});

// Pending-device gate. Once a user has a device-bound session, every protected
// API call is rejected with 403 until an admin approves the device. The
// allowlist keeps the user able to discover their pending state and log out;
// everything else returns `requiresApproval: true` so the UI can render the
// waiting screen.
const pendingDeviceExemptPaths = new Set<string>([
  '/api/auth/check',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/token',
  '/api/auth/device-pairing',
  '/api/auth/device-pairing/poll',
  '/health',
  ...oauthPublicPaths,
]);
app.use((req: any, res: any, next: any) => {
  if (pendingDeviceExemptPaths.has(req.path)) return next();
  // Only gate when we have a device-bound user session. Agent tokens
  // (req.tokenScope) and password-only sessions without a device id are
  // unaffected — the goal is to block newly-enrolled-but-unapproved devices,
  // not to retroactively kick anything else out.
  if (!req.authUser?.id || !req.authDeviceId) return next();
  // `req.deviceState` is populated by the auth middleware above. Missing or
  // inactive devices have already had their session dropped, so we only see
  // approved/pending here.
  if (req.deviceState?.isApproved) return next();
  return res.status(403).json({
    error: 'This device is waiting for admin approval.',
    requiresApproval: true,
  });
});

// WhatsApp connection status
app.get(
  '/api/whatsapp/status',
  async (_req: express.Request, res: express.Response) => {
    if (!ENABLE_WHATSAPP) return res.json({ status: 'disconnected' });
    res.json(await getWhatsAppStatus());
  },
);

/**
 * True when the caller is a chat-only (implicit) user who may not read this
 * project file. They pass `userCanAccessGroup` for any project access, so the
 * file routes also require a conversation of theirs to reference the file.
 * Everyone else (members, owners, admins, agent tokens) is unchanged.
 */
async function isFileDeniedForChatOnlyUser(
  req: express.Request,
  folder: string,
  ref: GroupFileReference,
): Promise<boolean> {
  const user = (req as any).authUser as
    | { id?: string; role?: string }
    | undefined;
  if (!user?.id) return false;
  if (adminBypassesProject({ id: user.id, role: user.role }, folder))
    return false;
  const access = await getProjectAccess(user.id, folder);
  if (access?.kind !== 'implicit') return false;
  return !(await implicitUserMayReadGroupFile(user.id, folder, ref));
}

// Serve uploaded files so the browser can display thumbnails
app.get(
  '/uploads/:folder/:filename',
  async (req: express.Request, res: express.Response) => {
    const { folder, filename } = req.params;
    // Sanitise to prevent path traversal
    const safeFolder = path.basename(folder as string);
    const safeFilename = path.basename(filename as string);
    if (!(await userCanAccessGroup(req, safeFolder))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const group = getGroupByFolder(safeFolder);
    if (!group) return res.status(404).json({ error: 'Not found' });
    if (
      await isFileDeniedForChatOnlyUser(req, safeFolder, {
        needles: [
          `/uploads/${safeFolder}/${safeFilename}`,
          `${effectiveContainerUploadDir(group)}/${safeFilename}`,
        ],
      })
    ) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const effective = resolveEffectiveSandbox(group);
    const stack = effective.stack;
    const uploadRoot = effectiveProjectUploadDir(group, DATA_DIR);
    const filePath = path.join(uploadRoot, safeFilename);
    logger.debug({ safeFolder, safeFilename, stack }, 'Serving upload');
    // The upload dir is writable by the agent sandbox, so never follow a
    // symlink (even one pointing inside the dir) and never block on a FIFO.
    let data: Buffer;
    try {
      if ((await fsp.lstat(filePath)).isSymbolicLink()) {
        return res.status(404).json({ error: 'Not found' });
      }
      data = await readContainedFile(
        uploadRoot,
        filePath,
        MAX_UPLOAD_SERVE_BYTES,
      );
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }
    // Upload names come from outside (mail attachments, WhatsApp media, agents):
    // never let active content run with the board session.
    const mimetype = mimetypeForPath(safeFilename);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (isActiveContentMimetype(mimetype)) {
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.attachment(safeFilename);
    }
    res.type(mimetype).send(data);
  },
);

// Mint a media ticket that lets a bare <video>/<audio src> stream one board
// file URL (see lib/media-tickets.ts). Only a user's own session may mint one,
// and the ticket carries that same user and device.
app.post('/api/media-tickets', (req: any, res: any) => {
  if (!req.authUser || req.authCredentialKind !== 'user') {
    return res.status(403).json({ error: 'A user session is required' });
  }
  const url = req.body?.url;
  const ticket =
    typeof url === 'string' && url.length <= 4096
      ? issueMediaTicket(url, req.authUser.id, req.authDeviceId ?? null)
      : null;
  if (!ticket) return res.status(400).json({ error: 'Unsupported media URL' });
  res.json({ ticket });
});

/**
 * Send the cached JPEG thumbnail of an opened artifact, generating it first.
 * The thumbnails dir is opened below the pinned artifacts root without
 * following links, so a swapped `thumbnails` or topic dir is refused (throws).
 * False when no thumbnail could be produced. Leaves `source` open.
 */
async function sendArtifactThumbnail(
  res: express.Response,
  folder: string,
  source: { handle: FileHandle; stat: Stats; name: string },
  sourceSegs: string[],
  mimetype: string,
  cacheControl: string,
): Promise<boolean> {
  const root = await openArtifactsRoot(folder);
  if (!root) return false;
  let thumbDir: PinnedDir | null = null;
  try {
    // An empty root makes artifactThumbnailPath return the root-relative path.
    const thumbnailRel = artifactThumbnailPath('', sourceSegs.join('/'));
    thumbDir = await openDirAt(root, path.posix.dirname(thumbnailRel), {
      create: true,
    });
    if (
      !thumbDir ||
      !(await ensureArtifactThumbnail(source, thumbDir, mimetype))
    )
      return false;
    const thumbnail = await openFileAt(
      thumbDir,
      path.posix.basename(thumbnailRel),
    );
    if (!thumbnail) return false;
    res.set('Cache-Control', cacheControl);
    sendPinnedFile(res, thumbnail, {
      headers: { 'Content-Type': 'image/jpeg' },
    });
    return true;
  } finally {
    await thumbDir?.close();
    await root.close();
  }
}

// Serve topic-scoped artifacts from the group's artifacts tree
// (groups/<folder>/artifacts/<topic>/<file>, e.g. artifacts/meetings/<id>.md).
// Lives outside /api so it's not subject to requireFreshSignature — a browser
// <img>/<a> can't sign requests; access is gated by userCanAccessGroup instead
// (mirrors the /uploads route above).
app.get(
  '/artifacts/:folder/*path',
  async (req: express.Request, res: express.Response) => {
    const folder = path.basename(req.params.folder as string);
    // Express wildcard param is an array; join to reconstruct the sub-path.
    const parts = (req.params as Record<string, string | string[]>)['path'];
    const rest = Array.isArray(parts)
      ? parts.join('/')
      : (parts as string) || '';
    if (!(await userCanAccessGroup(req, folder))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Sanitise every segment of the remaining path to prevent traversal —
    // basename each so '..' can't escape the artifacts dir.
    const segs = rest
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => path.basename(s));
    if (
      segs.length === 0 ||
      segs.some((segment) => segment === '.' || segment === '..')
    )
      return res.status(404).json({ error: 'Not found' });
    // Thumbnail URLs are a lazy cache endpoint. They deliberately do not
    // exist until an image tile asks for one.
    const isThumbnailPath = segs[0] === 'thumbnails' && segs.length > 1;
    const sourceSegs = isThumbnailPath ? segs.slice(1) : segs;
    if (isThumbnailPath) {
      sourceSegs[sourceSegs.length - 1] = sourceSegs[
        sourceSegs.length - 1
      ].replace(/\.jpg$/i, '');
    }
    const requestedThumbnail =
      isThumbnailPath ||
      req.query.thumbnail === '1' ||
      req.query.thumbnail === 'true';
    const sourcePath = sourceSegs.join('/');
    if (
      await isFileDeniedForChatOnlyUser(req, folder, {
        needles: [
          `/artifacts/${folder}/${sourcePath}`,
          `/workspace/group/artifacts/${sourcePath}`,
        ],
        bareArtifactPath: sourcePath,
        uploadConversationId:
          sourceSegs[0] === 'upload' && sourceSegs.length > 2
            ? sourceSegs[1]
            : undefined,
      })
    ) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      const source = await openArtifactFile(folder, sourceSegs);
      if (!source) return res.status(404).json({ error: 'Not found' });
      let sourceHandedOff = false;
      try {
        const mimetype = requestedThumbnail
          ? await detectMimetypeForHandle(source.handle, source.name)
          : undefined;
        if (
          requestedThumbnail &&
          mimetype?.startsWith('image/') &&
          (await sendArtifactThumbnail(
            res,
            folder,
            source,
            sourceSegs,
            mimetype,
            isThumbnailPath
              ? 'public, max-age=31536000, immutable'
              : 'public, max-age=3600',
          ))
        )
          return;
        // Generation failed: a thumbnail URL has no fallback, the main URL
        // serves the original file.
        if (isThumbnailPath)
          return res.status(404).json({ error: 'Not found' });
        sourceHandedOff = true;
        await sendArtifactFile(res, source, mimetype);
      } finally {
        if (!sourceHandedOff) await source.handle.close().catch(() => {});
      }
    } catch (err) {
      logger.warn({ err, folder }, 'Artifact could not be served');
      if (!res.headersSent) res.status(404).json({ error: 'Not found' });
    }
  },
);

// Proxy media from carapa-wa-link so the browser can display WhatsApp attachments.
// Authorization model: wa-link doesn't know about board groups, so we resolve
// the messageId → chat_jid via a meta round-trip, map chat_jid → group_folder
// via registeredGroups, then enforce userCanAccessGroup before proxying. This
// keeps user A from reading user B's media by guessing a messageId.
app.get(
  '/api/wa-media/:messageId',
  async (req: express.Request, res: express.Response) => {
    if (!ENABLE_WHATSAPP)
      return res.status(404).json({ error: 'WhatsApp is not enabled' });
    const messageId = req.params.messageId;
    if (
      typeof messageId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(messageId)
    ) {
      return res.status(400).json({ error: 'Invalid message ID' });
    }
    const headers: Record<string, string> = {};
    if (CARAPA_WA_LINK_TOKEN)
      headers['Authorization'] = `Bearer ${CARAPA_WA_LINK_TOKEN}`;
    try {
      // Step 1 — resolve chat_jid for this messageId
      const metaRes = await fetch(
        `${MCP_WHATSAPP_BASE_URL}/api/media/${encodeURIComponent(messageId)}/meta`,
        {
          headers,
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!metaRes.ok) {
        return res.status(metaRes.status).json({ error: 'Media not found' });
      }
      const meta = (await metaRes.json()) as { chat_jid?: string };
      const chatJid = meta?.chat_jid;
      if (!chatJid) {
        return res.status(404).json({ error: 'Media not found' });
      }

      // Step 2 — map chat_jid → group_folder. Falling back to a 404 (not 403)
      // when no matching group is registered avoids leaking which jids exist.
      const owningGroup = registeredGroups[chatJid];
      if (!owningGroup) {
        return res.status(404).json({ error: 'Media not found' });
      }

      // Step 3 — enforce per-group access
      if (!(await userCanAccessGroup(req, owningGroup.folder))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (
        await isFileDeniedForChatOnlyUser(req, owningGroup.folder, {
          needles: [`/api/media/${messageId}`, `/api/wa-media/${messageId}`],
        })
      ) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Step 4 — proxy the actual bytes
      const upstream = await fetch(
        `${MCP_WHATSAPP_BASE_URL}/api/media/${encodeURIComponent(messageId)}`,
        {
          headers,
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: 'Media not found' });
      }
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      return res
        .status(502)
        .json({ error: 'Failed to fetch media from wa-link' });
    }
  },
);

async function presentAuthUser(user: AuthUser) {
  const identity = await presentAccountIdentity(user);
  return {
    id: identity.id,
    username: identity.username,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    role: user.role,
  };
}

app.use('/api', getDevicePairingRouter());
app.use('/api/oauth', getOAuthApiRouter());

// Auth endpoints (exempt from token check)
app.get(
  '/api/auth/check',
  async (req: express.Request, res: express.Response) => {
    const u = (req as any).authUser;
    const userPayload = u ? await presentAuthUser(u) : null;

    // If the request was signed by a device row, report its approval state so
    // the UI can show a "pending approval" banner globally without having to
    // load the full devices list. State was resolved once in the auth
    // middleware and stashed on `req.deviceState`.
    const state = (req as any).deviceState as
      | { isActive: boolean; isApproved: boolean }
      | undefined;
    const devicePayload: { isApproved: boolean } | null =
      u && state ? { isApproved: state.isApproved } : null;

    const cookies = parseCookies(req.headers.cookie);
    const sessionValue = cookies[SESSION_COOKIE];
    const authenticated =
      (!!sessionValue && (await isCurrentSession(sessionValue))) ||
      !!(req as any).authUser ||
      !!(req as any).tokenScope;

    logger.debug({ authenticated, path: req.path }, 'Auth check');
    return res.json({
      required: true,
      authenticated,
      user: userPayload,
      device: devicePayload,
    });
  },
);

function guessDeviceLabel(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  if (ua.includes('iphone')) return 'iPhone';
  if (ua.includes('ipad')) return 'iPad';
  if (ua.includes('android')) return 'Android device';
  let os = 'Computer';
  if (ua.includes('mac os') || ua.includes('macintosh')) os = 'Mac';
  else if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('linux')) os = 'Linux';
  let browser = '';
  if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('chrome')) browser = 'Chrome';
  else if (ua.includes('safari')) browser = 'Safari';
  return browser ? `${os} (${browser})` : os;
}

app.post(
  '/api/auth/login',
  loginLimiter,
  async (req: express.Request, res: express.Response) => {
    const { username, password, token, device_id, public_key, device_label } =
      req.body || {};
    logger.debug(
      {
        hasUsername: typeof username === 'string' && username.length > 0,
        passwordLength: typeof password !== 'string' ? 0 : password.length,
        tokenLength: typeof token !== 'string' ? 0 : token.length,
      },
      '[POST /api/auth/login] request received',
    );

    if (
      typeof device_id === 'string' &&
      (await getDeviceRecord(device_id))?.kind === 'integration'
    )
      return res.status(409).json({
        error: 'Integration identities cannot be used for interactive login',
      });

    if (username && password) {
      const user = await verifyUserCredentials(
        String(username),
        String(password),
      );
      logger.debug(
        { authenticated: !!user },
        '[POST /api/auth/login] credential verification completed',
      );
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });

      // First-ever device of the lone admin auto-approves. Conditions:
      //   1. user is admin AND is the only user — single-user install
      //   2. this admin has no already-approved device — i.e. this IS the
      //      first device, not a phone joining after a laptop is set up
      // Without (1) the bootstrap admin can't get in (startup creates the
      // admin row, so its first device would otherwise stay pending with no
      // one around to approve it).
      // Without (2) we'd silently trust any subsequent device the admin
      // brings along, bypassing the approval queue that's the whole point.
      const isLoneAdmin =
        user.role === 'admin' && (await listUsers()).length === 1;
      const existingDevices = isLoneAdmin
        ? await getDevicesForUser(user.id)
        : [];
      const hasApprovedDevice = existingDevices.some(
        (d) => d.isApproved && d.kind !== 'integration',
      );
      const autoApprove = isLoneAdmin && !hasApprovedDevice;

      let deviceApproved = true; // password-only logins (no device keypair) are unaffected
      if (device_id && public_key) {
        const resolvedLabel =
          (typeof device_label === 'string' && device_label.trim()) ||
          guessDeviceLabel(req.headers['user-agent'] as string | undefined);
        const result = await registerDeviceKey(
          String(device_id),
          user.id,
          String(public_key),
          resolvedLabel || null,
          autoApprove,
        );
        if (result.kind === 'reassigned') {
          // Audit-trail line: a different user with valid credentials took over
          // a previously-bound device. The new owner lands pending approval.
          logger.info(
            {
              event: 'device.reassigned',
              deviceId: String(device_id),
              previousUserId: result.previousUserId,
              newUserId: user.id,
              newUsername: user.username,
            },
            'device reassigned to new user',
          );
        }
        deviceApproved = result.isApproved;
      }

      const session_id = signUserJwt(
        user.id,
        device_id ? String(device_id) : undefined,
        user.tokenVersion,
      );
      res.setHeader(
        'Set-Cookie',
        buildSessionCookie(session_id, req, 31536000),
      );
      return res.json({
        ok: true,
        token: session_id,
        user: await presentAuthUser(user),
        device: { isApproved: deviceApproved },
      });
    }

    return res
      .status(400)
      .json({ error: 'Username and password are required' });
  },
);

app.post('/api/auth/logout', (req: express.Request, res: express.Response) => {
  const cookies = parseCookies(req.headers.cookie);
  // Sessions are stateless signed JWTs: logout only clears the cookie.
  if (cookies[SESSION_COOKIE]) {
    logger.info({ hasSession: true }, 'Logout: revoking session');
  }
  res.setHeader('Set-Cookie', buildSessionCookie('', req, 0));
  return res.json({ ok: true });
});

app.post(
  '/api/auth/token',
  tokenLimiter,
  async (req: express.Request, res: express.Response) => {
    const device_id = req.headers['x-carapa-device-id'] as string;
    const timestamp = req.headers['x-carapa-timestamp'] as string;
    const signature = req.headers['x-carapa-signature'] as string;

    if (!device_id || !signature || !timestamp) {
      return res.status(401).json({ error: 'Incomplete handshake headers' });
    }

    const public_key = await getDevicePublicKey(device_id);
    if (!public_key) {
      return res.status(401).json({ error: 'Unknown device' });
    }

    // Check timestamp (allow 5 minutes drift)
    if (!isFreshTimestamp(timestamp, 5 * 60 * 1000)) {
      return res.status(401).json({ error: 'Stale timestamp' });
    }

    // Find the user who owns this device key
    const user_id = await getUserIdByDevice(device_id);
    if (!user_id) {
      return res
        .status(401)
        .json({ error: 'Device not associated with a user' });
    }

    const method = req.method.toUpperCase();
    const bodyStr =
      req.body && Object.keys(req.body).length > 0
        ? typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body)
        : '';

    const payload = createSigningPayload(
      method,
      req.originalUrl || req.url,
      timestamp,
      bodyStr,
    );
    const isValid = await verifySignature(public_key, signature, payload);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const owner = await getUserById(user_id);
    if (!owner || owner.disabled)
      return res.status(401).json({ error: 'Account unavailable' });
    const device = await getDeviceRecord(device_id);
    const token =
      device?.kind === 'integration'
        ? signIntegrationJwt(
            { type: 'device', sub: user_id, did: device_id },
            Math.max(
              1,
              Math.min(
                3600,
                device.expiresAt
                  ? Math.floor(
                      (Date.parse(device.expiresAt) - Date.now()) / 1000,
                    )
                  : 3600,
              ),
            ),
          )
        : signUserJwt(user_id, device_id, owner.tokenVersion);
    return res.json({ token });
  },
);

// Mount Kanban + Sandbox API routes
app.get('/api/time', (_req: express.Request, res: express.Response) => {
  res.json({ iso: new Date().toISOString(), epoch: Date.now() });
});

// Building and restarting CarapaBoard itself needs CARAPA_BOARD_DEPLOY_SERVICE;
// without it the whole feature is off.
app.use(
  ['/api/admin/rebuild-board', '/api/restart'],
  (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (BOARD_SELF_DEPLOY_ENABLED) return next();
    res
      .status(404)
      .json({ error: 'CarapaBoard build and restart are not enabled' });
  },
);

app.post(
  '/api/admin/rebuild-board',
  requireFreshSignature,
  requireAdmin,
  (req: any, res) => {
    if (boardBuildInProgress) {
      return res
        .status(409)
        .json({ error: 'A CarapaBoard build is already running' });
    }
    boardBuildInProgress = true;
    // Stop starting new background LLM work for the duration of the build;
    // it stays paused after a successful build until the restart.
    pauseBackgroundWork('server-web build');
    markServerWebBuildBuilding();
    const userId = req.authUser.id as string;
    res.status(202).json({ ok: true, service: CARAPA_BOARD_DEPLOY_SERVICE });

    setImmediate(() => {
      void (async () => {
        try {
          logger.info(
            { service: CARAPA_BOARD_DEPLOY_SERVICE, userId },
            'Administrator requested a background CarapaBoard build',
          );
          const result = await getSandboxClient().callTool(
            'build_service',
            { name: CARAPA_BOARD_DEPLOY_SERVICE },
            BUILD_SERVICE_CALL_OPTIONS,
          );
          if (result.isError) {
            const output = result.stdout.slice(-20_000);
            markServerWebBuildFailed('CarapaBoard build failed', output);
            resumeBackgroundWorkUnlessRestartPending();
            logger.error(
              {
                service: CARAPA_BOARD_DEPLOY_SERVICE,
                output: output.slice(-2000),
              },
              'Administrator-requested CarapaBoard build failed',
            );
            await reportBuildFailureCard(result.stdout, userId);
            broadcast({
              type: 'deploy_failed',
              payload: {
                user_id: userId,
                target: 'server-web',
                error: 'CarapaBoard build failed',
                output,
              },
            });
            return;
          }
          markServerWebBuildReady();
          broadcast({
            type: 'deploy_ready',
            payload: { service: CARAPA_BOARD_DEPLOY_SERVICE },
          });
          await resolveBuildFailureCards(result.stdout);
        } catch (error) {
          markServerWebBuildFailed(`Build request failed: ${String(error)}`);
          resumeBackgroundWorkUnlessRestartPending();
          logger.error(
            { service: CARAPA_BOARD_DEPLOY_SERVICE, error: String(error) },
            'Administrator-requested CarapaBoard build errored',
          );
          broadcast({
            type: 'deploy_failed',
            payload: {
              user_id: userId,
              target: 'server-web',
              error: `Build request failed: ${String(error)}`,
            },
          });
        } finally {
          boardBuildInProgress = false;
        }
      })();
    });
  },
);

app.get(
  '/api/admin/rebuild-board/status',
  requireFreshSignature,
  requireAdmin,
  (_req: any, res) => res.json(getServerWebBuildStatus()),
);

let boardRestartRequested = false;

/** A failed build must not re-open the gate under a pending restart. */
function resumeBackgroundWorkUnlessRestartPending(): void {
  if (!isServerWebRestartPending()) resumeBackgroundWork();
}

// Respond before asking CarapaBox to recreate this container: the MCP call
// cannot return to a process that is being replaced. Force recreation is
// required for Docker Compose to start the newly built :latest image.
function restartBoardService(userId: string): void {
  if (boardRestartRequested) return;
  boardRestartRequested = true;
  setImmediate(() => {
    void (async () => {
      let failed = false;
      try {
        logger.info(
          { service: CARAPA_BOARD_DEPLOY_SERVICE, userId },
          'Administrator requested a CarapaBoard restart',
        );
        const result = await getSandboxClient().callTool('restart_service', {
          name: CARAPA_BOARD_DEPLOY_SERVICE,
        });
        if (result.isError) {
          failed = true;
          const output = result.stdout.slice(-20_000);
          logger.error(
            {
              service: CARAPA_BOARD_DEPLOY_SERVICE,
              output: output.slice(-2000),
            },
            'Administrator-requested CarapaBoard restart failed',
          );
          broadcast({
            type: 'deploy_failed',
            payload: {
              user_id: userId,
              target: 'server-web',
              error: 'CarapaBoard restart failed',
              output,
            },
          });
        }
      } catch (error) {
        failed = true;
        logger.error(
          { service: CARAPA_BOARD_DEPLOY_SERVICE, error: String(error) },
          'Administrator-requested CarapaBoard restart errored',
        );
        broadcast({
          type: 'deploy_failed',
          payload: {
            user_id: userId,
            target: 'server-web',
            error: `Restart request failed: ${String(error)}`,
          },
        });
      } finally {
        if (failed) {
          // This process keeps running, so it must not stay paused.
          boardRestartRequested = false;
          if (!boardBuildInProgress) resumeBackgroundWork();
        }
      }
    })();
  });
}

const restartWaiter = createRestartWaiter({ restart: restartBoardService });

app.post(
  '/api/restart',
  requireFreshSignature,
  requireAdmin,
  (req: any, res) => {
    const userId = req.authUser.id as string;
    const force = req.query.force === '1' || req.query.force === 'true';
    res.status(202).json({
      ok: true,
      service: CARAPA_BOARD_DEPLOY_SERVICE,
    });

    if (force) {
      restartWaiter.cancel();
      restartBoardService(userId);
      return;
    }
    // Repeated clicks share one waiter so restart_service is called once.
    restartWaiter.request(userId);
  },
);

app.delete(
  '/api/restart',
  requireFreshSignature,
  requireAdmin,
  (_req: any, res) => {
    const cancelled = restartWaiter.cancel();
    // Keep the gate closed while a build is still running; the build's own
    // completion decides then.
    if (cancelled && !boardBuildInProgress) resumeBackgroundWork();
    res.json({ ok: true, cancelled });
  },
);

app.delete('/api/projects/:pid', requireFreshSignature);
app.delete('/api/kanban/projects/:id', requireFreshSignature);

app.use('/api/projects/:pid/mail', requireFreshSignature);
// Conversation sharing grants access (members, up to 'owner', which implies
// project access) and publishes conversations via public links: every non-GET
// request needs a fresh device signature, same as the AZ2-1 membership gate
// below. This must sit before projectsRouter, which nests the
// conversation-shares router. Express path matching is case-insensitive, so
// these prefixes are too.
app.use(
  [
    '/api/projects/:pid/conversations/:cid/members',
    '/api/projects/:pid/conversations/:cid/public-share',
  ],
  requireFreshSignatureForWrites,
);
// Enabling/disabling sandbox SSH opens inbound ingress that persists after the
// session ends: every non-GET request needs a fresh device signature. This must
// sit before sandboxRouter. Express path matching is case-insensitive, so this
// prefix is too.
app.use('/api/sandbox/:stack/ssh', requireFreshSignatureForWrites);
app.use('/api', projectsRouter);
app.use('/api', sandboxRouter);
app.use('/api', tmuxRouter);
app.use('/api/projects/:projectId/browser', requireFreshSignature);
app.use('/api', browserRouter);
app.use('/api', observationsRouter);
app.use('/api', eventsRouter);
// User management, project/KB membership and device management (own and
// admin cross-user) mutate access control: every non-GET request needs a fresh
// device signature from the caller's own device.
// Express path matching is case-insensitive, so these prefixes are too.
app.use(
  [
    '/api/users',
    '/api/projects/:pid/members',
    '/api/knowledge-bases/:kb_id/members',
    '/api/account/devices',
    '/api/admin/devices',
  ],
  requireFreshSignatureForWrites,
);
app.use('/api', usersRouter);
app.use('/api', preferencesRouter);
app.use('/api', securityRouter);
app.use('/api', accountRouter);
// Admin + freshly signed human-device request, including reads of login URLs.
// These operations are intentionally absent from MCP/agent tools.
app.use(
  '/api/admin/provider-accounts',
  providerAccountAdmin,
  requireFreshSignature,
);
app.use('/api', providerAccountsRouter);
// A project's integrations (tokens), kept by CarapaBox with the Provider accounts:
// a freshly signed human device (any role). The router itself requires owner-level
// access to the project that owns the sandbox, so this is not admin-only.
app.use(
  '/api/projects/:pid/integrations',
  humanDeviceUser,
  requireFreshSignature,
);
app.use('/api', projectIntegrationsRouter);
// MCP OAuth connections held by the CarapaBox api-relay: same admin gate.
app.use(
  '/api/admin/mcp-connections',
  providerAccountAdmin,
  requireFreshSignature,
);
app.use('/api', mcpConnectionsRouter);
// CarapaBox registry: admin + freshly signed human device for every operation.
app.use('/api/admin/boxes', providerAccountAdmin, requireFreshSignature);
app.use('/api', boxesRouter);
// AI users and teams, memory audits and history-reflection review write
// memories and personas: every non-GET request needs a fresh device signature
// from the caller's own device, same as the users block above. GETs stay open
// (avatar <img> loads and list views cannot sign). Express path matching is
// case-insensitive, so these prefixes are too. This must sit before the routers.
app.use(
  [
    '/api/admin/ai-users',
    '/api/admin/ai-user-teams',
    '/api/history-reflection',
    '/api/memory-review',
  ],
  requireFreshSignatureForWrites,
);
app.use('/api', aiUsersAdminRouter);
app.use('/api', activeRunsRouter);
app.use('/api', meetingsRouter);
app.use('/api', reportsRouter);
app.use('/api', historyReviewRouter);
app.use('/api', memoryAuditsRouter);
// In-app endpoints: session auth, NOT signed-request. Mounted before the
// pushRouter so they don't fall under requireFreshSignature. The handlers
// fall through (next()) when no session is present, so the native
// CarapaMessagingService still reaches the signed routes in pushRouter.
app.get('/api/notifications/unread', handleUnreadNotifications);
app.post('/api/notifications/unread/ack', handleAckUnreadNotifications);
app.get('/api/notifications/payloads/:id', handlePayloadByIdSession);
app.post('/api/notifications/payloads/:id/ack', handleAckPayloadSession);
// Session-cookie auth only — must sit before requireFreshSignature so a page
// refresh can mint a WS ticket from the HttpOnly cookie even when the
// biometric vault is still locked (no signing key in memory yet).
app.get('/api/ws-ticket', async (req, res) => {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : null;
  const cookies = parseCookies(req.headers.cookie);
  const cookieSession = cookies[SESSION_COOKIE] || null;
  const querySession = (req.query.token as string) || null;

  // Native clients can retain an expired WebView cookie while carrying a
  // freshly renewed user JWT in Authorization. Select a credential by
  // validity instead of blindly preferring the cookie; otherwise the stale
  // cookie masks the valid bearer and strands the application WebSocket.
  const bearerIsSession =
    !!bearerToken && (await isCurrentSession(bearerToken));
  const bearerIsApiToken = !!bearerToken && !!verifyToken(bearerToken);
  const cookieIsValid =
    !!cookieSession && (await isCurrentSession(cookieSession));
  const queryIsValid = !!querySession && (await isCurrentSession(querySession));
  const session_id = bearerIsSession
    ? bearerToken
    : cookieIsValid
      ? cookieSession
      : bearerIsApiToken
        ? bearerToken
        : queryIsValid
          ? querySession
          : null;

  if (!session_id) {
    // Debug, not warn: this fires routinely when a browser tab reconnects
    // with a stale session cookie right after a server restart. The client
    // already gets a 401 and re-auths; it's not an operator-actionable event.
    logger.debug(
      {
        hasBearer: !!bearerToken,
        hasCookie: !!cookieSession,
        hasQuerySession: !!querySession,
      },
      'WS ticket denied: Invalid session or token',
    );
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ticket = createWsTicket(session_id);
  logger.debug({ hasSession: true }, 'WS ticket issued');
  res.json({ ticket });
});
// requireFreshSignature runs for EVERY /api request that reaches this line —
// pushRouter's routes AND everything mounted afterwards (notably the module
// router that serves objective dashboards). The SPA signs its apiFetch calls,
// but a browser-loaded dashboard document/iframe cannot produce a device
// signature. Exempt that one GET path so it can authenticate via the main gate
// (session cookie / token) instead; every other route keeps the signature gate.
// Anchored on the path only (never the query string); baseUrl is included
// because inside `app.use('/api', …)` req.path has the mount prefix stripped.
export const isDashboardDocRequest = (req: {
  method?: string;
  baseUrl?: string;
  path?: string;
}): boolean =>
  req.method === 'GET' &&
  /^\/api\/projects\/[^/]+\/objectives\/[^/]+\/dashboard\//.test(
    `${req.baseUrl || ''}${req.path || ''}`,
  );
app.use(
  '/api',
  (req: any, res: any, next: any) =>
    isDashboardDocRequest(req) ? next() : requireFreshSignature(req, res, next),
  pushRouter,
);

// Mount optional module routes via a lazy middleware.
// Modules are registered after this file is evaluated, so we resolve routers
// on each request rather than at import time.
import { getModuleRouters } from './modules/loader.js';
app.use('/api', (req, res, next) => {
  const routers = getModuleRouters();
  let idx = 0;
  const tryNext = (): void => {
    if (idx >= routers.length) return next();
    routers[idx++](req, res, tryNext);
  };
  tryNext();
});

// MCP OAuth discovery + authorization-server endpoints (allowlisted origins only)
app.use(getOAuthPublicRouter());

// Mount MCP SSE server for agent tools
mountMcpRoutes(app, sharedDeps);

// Serve static UI files (built by Vite)
const uiDistPath = path.join(
  new URL('..', import.meta.url).pathname,
  'ui',
  'dist',
);
if (fs.existsSync(uiDistPath)) {
  app.use(express.static(uiDistPath));

  // SPA fallback — serve index.html for non-API routes
  app.get('*path', (req: express.Request, res: express.Response) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (req.path.startsWith('/share/')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Referrer-Policy', 'no-referrer');
    }
    res.sendFile(path.join(uiDistPath, 'index.html'));
  });
}

import https from 'https';

export function startHttpBridge(port = 3000) {
  // Share session validator with WebSocket auth
  setSessionVerifier(isValidSession);

  const certDir = path.join(STORE_DIR, 'certs');
  const keyPath = path.join(certDir, 'server.key');
  const certPath = path.join(certDir, 'server.crt');

  logger.debug(
    { hasKey: fs.existsSync(keyPath), hasCertificate: fs.existsSync(certPath) },
    'Checking for security certificates...',
  );

  let server;
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    server = https.createServer(options, app).listen(port, () => {
      logger.info({ port, protocol: 'https' }, 'Server running with HTTPS');
    });
  } else {
    server = app.listen(port, () => {
      logger.info(
        { port, protocol: 'http' },
        'Server running with HTTP (Insecure)',
      );
    });
  }

  // Attach WebSocket server for real-time events
  attachWebSocket(server);
  const stopRuntimeNotifications = startRuntimeNotifications();
  const stopSandboxStateMonitor =
    getSandboxClient().startStateMonitor(hasWebSocketClients);
  server.once('close', () => {
    stopRuntimeNotifications();
    stopSandboxStateMonitor();
  });
  const stopProjectChangeMonitor = startProjectChangeMonitor();
  server.once('close', stopProjectChangeMonitor);

  return server;
}
