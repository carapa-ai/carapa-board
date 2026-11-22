import type { RequestHandler } from 'express';
import { getConversation, getDeviceRecord, getUserById } from '../../db.js';
import { logger } from '../../logger.js';
import { touchDeviceLastUsed } from '../device-activity.js';
import { verifyJwt } from '../auth-jwt.js';
import { getSession } from '../meeting-recordings.js';
import {
  createSigningPayload,
  isFreshTimestamp,
  verifySignature,
} from '../../crypto-verify.js';
import {
  chatConversationReference,
  objectiveChatScopes,
  requiredDeviceScopes,
} from './policy.js';

/** Runs before ordinary session handling, including its auth-disabled shortcut. */
export const integrationAccess: RequestHandler = async (
  req: any,
  res,
  next,
) => {
  // This narrowly exempt endpoint authenticates with its own secret and pending key.
  if (req.method === 'POST' && req.path === '/api/auth/device-pairing/poll')
    return next();
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : undefined;
  const cookie = req.headers.cookie
    ?.split(';')
    .map((v: string) => v.trim())
    .find((v: string) => v.startsWith('carapa_session='))
    ?.slice('carapa_session='.length);
  const tokens = [
    bearer,
    cookie,
    typeof req.query.token === 'string' ? req.query.token : undefined,
  ].filter(Boolean);
  const payloads = tokens.map((token) => verifyJwt(token));
  const payload = bearer ? verifyJwt(bearer) : undefined;
  const headerId = req.headers['x-carapa-device-id'];
  const ids = [
    ...new Set(
      [headerId, ...payloads.map((p) => p?.did)].filter(
        (id): id is string => typeof id === 'string',
      ),
    ),
  ];
  const records = await Promise.all(ids.map(getDeviceRecord));
  const integration = records.find((r) => r?.kind === 'integration');
  if (!integration && !payloads.some((p) => p?.type === 'device'))
    return next();
  const reject = (status = 403) =>
    res.status(status).json({ error: 'Integration access denied' });
  if (
    !integration ||
    !integration.is_active ||
    !integration.is_approved ||
    (integration.expiresAt && Date.parse(integration.expiresAt) <= Date.now())
  )
    return reject(401);
  const owner = await getUserById(integration.user_id);
  if (!owner || owner.disabled || headerId !== integration.device_id)
    return reject(401);
  const exchange = req.method === 'POST' && req.path === '/api/auth/token';
  if (
    !exchange &&
    (!payload ||
      payload.type !== 'device' ||
      payload.sub !== owner.id ||
      payload.did !== integration.device_id)
  )
    return reject(401);
  // Mixing a different identity with an integration key must never select broader rights.
  if (
    payloads.some(
      (p) =>
        p &&
        (p.sub !== owner.id ||
          p.did !== integration.device_id ||
          p.type !== 'device'),
    )
  )
    return reject(401);
  const timestamp = req.headers['x-carapa-timestamp'];
  const signature = req.headers['x-carapa-signature'];
  const body =
    ['GET', 'HEAD'].includes(req.method) ||
    !req.body ||
    !Object.keys(req.body).length
      ? ''
      : JSON.stringify(req.body);
  if (
    typeof timestamp !== 'string' ||
    typeof signature !== 'string' ||
    !isFreshTimestamp(timestamp) ||
    !(await verifySignature(
      integration.public_key,
      signature,
      createSigningPayload(req.method, req.originalUrl, timestamp, body),
    ))
  )
    return reject(401);
  if (!exchange) {
    const required = requiredDeviceScopes(
      req.method,
      req.path,
      req.body,
      req.query,
    );
    const holds = (scopes: string[]) =>
      scopes.every((scope) => integration.scopes.includes(scope));
    if (!required || !holds(required)) return reject();
    // A request that only names a conversation may be an objective chat; the
    // conversation decides, so resolve it before authorizing. A conversation
    // that cannot be resolved inside the request's project, or that needs
    // objective scopes the key lacks, answers identically.
    const reference = chatConversationReference(req.path, req.body, req.query);
    // Recording IDs name an in-memory session, not a conversation. Resolve its
    // conversation independently of any caller-supplied body or query fields.
    const recordingPath =
      /^\/api\/projects\/([^/]+)\/meetings\/record\/([^/]+)(?:\/[^/]+)?\/?$/.exec(
        req.path,
      );
    if (recordingPath) {
      let projectId: string;
      let recordingId: string;
      try {
        projectId = decodeURIComponent(recordingPath[1]);
        recordingId = decodeURIComponent(recordingPath[2]);
      } catch {
        return res.status(404).json({ error: 'Recording session not found' });
      }
      const session = getSession(recordingId);
      if (session && session.group_folder === projectId) {
        const conversation = await getConversation(
          session.conversation_id,
        ).catch((err) => {
          logger.warn({ err }, 'Device conversation lookup failed');
          return undefined;
        });
        if (!conversation || conversation.group_folder !== projectId)
          return res.status(404).json({ error: 'Conversation not found' });
        if (
          conversation.objective_id &&
          !holds(objectiveChatScopes(req.method))
        )
          return reject();
      }
    }
    for (const id of reference?.conversationIds ?? []) {
      const conversation = id
        ? await getConversation(id).catch((err) => {
            logger.warn({ err }, 'Device conversation lookup failed');
            return undefined;
          })
        : undefined;
      if (
        !conversation ||
        conversation.group_folder !== reference!.projectId ||
        (conversation.objective_id && !holds(objectiveChatScopes(req.method)))
      )
        return res.status(404).json({ error: 'Conversation not found' });
    }
  }
  req.integrationGrant = integration;
  req.authUser = owner;
  req.authDeviceId = integration.device_id;
  req.authCredentialKind = 'integration';
  req.deviceState = {
    isActive: true,
    isApproved: true,
    kind: 'integration',
    scopes: integration.scopes,
    expiresAt: integration.expiresAt,
  };
  req.tokenScope = {
    kind: 'user',
    group_folder: `main-${owner.username.toLowerCase()}`,
    permissions: {},
  };
  touchDeviceLastUsed(integration.device_id, owner.id);
  return next();
};
