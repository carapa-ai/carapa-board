import { Router } from 'express';
import {
  upsertDevicePushToken,
  deletePushTokenByDevice,
  getDevicePushTokenRow,
  getUserIdByDevice,
  getUndeliveredPayloads,
  ackDuplicateUnreadMemoryReviewPayloads,
  getUnreadPayloads,
  countUnreadPayloads,
  getPayloadById,
  ackPayload,
  ackUnreadPayloads,
  persistFormResponse,
  getPushTokensForUser,
  deleteStalePushTokens,
  getConversation,
  getMessageSpeechAsset,
  userCanAccessConversation,
} from '../db.js';
import { getUserById } from '../modules/knowledge/db-kb.js';
import {
  deliverFormResponse,
  cancelPending,
} from '../modules/push/pending-responses.js';
import { routeFormResponse } from '../modules/push/form-response-router.js';
import {
  compileFormValidator,
  formatAjvErrors,
} from '../modules/push/payload-store.js';
import { sendPing } from '../modules/push/fcm-sender.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import { logger } from '../logger.js';
import { isRecord } from '../lib/type-guards.js';
import { serveTtsAsset } from '../modules/tts/audio-response.js';
import {
  ensurePersonaMessageSpeech,
  preparePersonaDeviceSpeechText,
  resolvePersonaSpeechSource,
} from '../modules/tts/message-speech.js';
import { getPersonaLiveOwner } from '../modules/ai-users/playback-gate.js';
import { startLiveQueueMessage } from '../modules/ai-users/live-queue.js';

/**
 * Fan a data-only `ack_dismiss` FCM ping out to every push token the user
 * has registered. This is the killed-app fallback: the in-app WS path
 * dismisses live clients instantly, but devices whose app process has been
 * reclaimed by the OS only learn about the ack via FCM. The native
 * CarapaMessagingService handles `kind=ack_dismiss` by cancelling the
 * system-tray notification keyed by `ref.hashCode()`.
 *
 * Fire-and-forget: never blocks the ACK response.
 */
async function dispatchDismissPing(
  user_id: string,
  payload_id: string,
): Promise<void> {
  try {
    const tokens = await getPushTokensForUser(user_id);
    if (tokens.length === 0) return;
    const result = await sendPing(tokens, payload_id, 'ack_dismiss', {
      user_id,
    });
    if (result.stale.length > 0) {
      await deleteStalePushTokens(result.stale).catch(() => undefined);
    }
  } catch (err) {
    logger.warn(
      { user_id, payload_id, err: String(err) },
      '[push:ack] dismiss-ping dispatch failed',
    );
  }
}

const router = Router();

function getDeviceId(req: any, res: any): string | null {
  const id = req.headers['x-carapa-device-id'] as string | undefined;
  if (!id) {
    res.status(400).json({ error: 'Missing X-Carapa-Device-ID header' });
    return null;
  }
  return id;
}

async function getUserId(
  req: any,
  res: any,
): Promise<{ device_id: string; user_id: string } | null> {
  const device_id = getDeviceId(req, res);
  if (!device_id) return null;
  const user_id = await getUserIdByDevice(device_id);
  if (!user_id) {
    res.status(401).json({ error: 'Unknown device' });
    return null;
  }
  // Signed-only routes skip the session gate, so refuse disabled owners here.
  const user = await getUserById(user_id);
  if (!user || user.disabled) {
    res.status(401).json({ error: 'Account disabled' });
    return null;
  }
  return { device_id, user_id };
}

// One log line per POST/DELETE /devices/push-token, including rejections and
// their reason. Never logs the token value.
router.use('/devices/push-token', (req: any, res: any, next: any) => {
  if (req.method !== 'POST' && req.method !== 'DELETE') return next();
  let error: unknown;
  const json = res.json.bind(res);
  res.json = (body: any) => {
    error = body?.error;
    return json(body);
  };
  res.on('finish', () => {
    const fields = {
      method: req.method,
      device_id: req.headers['x-carapa-device-id'],
      ...res.locals.pushToken,
      status: res.statusCode,
    };
    if (res.statusCode < 400) {
      logger.info(fields, '[push:token] request accepted');
    } else {
      logger.warn(
        { ...fields, reason: error },
        '[push:token] request rejected',
      );
    }
  });
  next();
});

router.post('/devices/push-token', async (req: any, res: any) => {
  const ctx = await getUserId(req, res);
  if (!ctx) return;
  const { token, platform } = req.body || {};
  res.locals.pushToken = { user_id: ctx.user_id, platform };
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'token is required' });
  }
  if (platform !== 'android' && platform !== 'ios' && platform !== 'web') {
    return res
      .status(400)
      .json({ error: 'platform must be android, ios, or web' });
  }
  await upsertDevicePushToken(ctx.device_id, ctx.user_id, platform, token);
  return res.json({ ok: true });
});

router.delete('/devices/push-token', async (req: any, res: any) => {
  const device_id = getDeviceId(req, res);
  if (!device_id) return;
  const row = await getDevicePushTokenRow(device_id);
  res.locals.pushToken = {
    user_id: row?.user_id,
    platform: row?.platform,
    registered: !!row,
  };
  await deletePushTokenByDevice(device_id);
  return res.json({ ok: true });
});

// Lets the app re-register only when needed. The device sends its current FCM
// token in a header (not the URL, which request logs may capture); the token is
// compared server-side and never echoed or logged.
router.get('/devices/push-token/status', async (req: any, res: any) => {
  const ctx = await getUserId(req, res);
  if (!ctx) return;
  const row = await getDevicePushTokenRow(ctx.device_id);
  const current = req.headers['x-carapa-fcm-token'];
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    registered: !!row,
    token_matches:
      row && typeof current === 'string' ? row.token === current : null,
  });
});

/**
 * Device auth, Live Mode session and conversation access shared by the
 * native speech routes. `manual=1` is a user-requested replay; otherwise the
 * request must belong to the conversation's active Live Mode session.
 */
async function authorizeNativeSpeech(req: any, res: any) {
  const ctx = await getUserId(req, res);
  if (!ctx) return null;
  const sessionId =
    typeof req.query?.liveModeSessionId === 'string'
      ? req.query.liveModeSessionId
      : '';
  const manualReplay = req.query?.manual === '1';
  if (!manualReplay) {
    const owner = getPersonaLiveOwner(req.params.cid);
    // Every authorized device watching the conversation may mirror the active
    // speech session. Only the owner's completion endpoint below can advance
    // the server-side talking-stick gate.
    if (!sessionId || !owner || owner.sessionId !== sessionId) {
      res.status(409).json({ error: 'Stale Live Mode session' });
      return null;
    }
  }
  const conversation = await getConversation(req.params.cid);
  const access = conversation
    ? await userCanAccessConversation(ctx.user_id, conversation.id)
    : null;
  if (!conversation || !access) {
    res.status(404).json({ error: 'Speech not found' });
    return null;
  }
  return { conversation, manualReplay };
}

/**
 * GET /api/native/tts/conversations/:cid/messages/:messageId/text
 * The normalized text and language the server would synthesize, for devices
 * that speak replies with their own TTS engine.
 */
export async function handleNativeSpeechText(req: any, res: any) {
  const authorized = await authorizeNativeSpeech(req, res);
  if (!authorized) return;
  // Live Mode also speaks main-agent replies; manual replay is persona-only,
  // like the project speech route.
  const source = await resolvePersonaSpeechSource(
    authorized.conversation.id,
    req.params.messageId,
    { includeMainAgent: !authorized.manualReplay },
  );
  if (!source) return res.status(404).json({ error: 'Speech not found' });
  const speech = await preparePersonaDeviceSpeechText(source);
  if (!speech.text) return res.status(404).json({ error: 'Speech not found' });
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(speech);
}

router.get(
  '/native/tts/conversations/:cid/messages/:messageId/text',
  handleNativeSpeechText,
);

router.get(
  '/native/tts/conversations/:cid/messages/:messageId',
  async (req: any, res: any) => {
    const authorized = await authorizeNativeSpeech(req, res);
    if (!authorized) return;
    const { conversation, manualReplay } = authorized;
    let asset = await getMessageSpeechAsset(
      conversation.id,
      req.params.messageId,
    );
    if (!asset && !manualReplay) {
      // A device-speech Live run has no server audio; generate it only for a
      // device whose own engine could not speak this reply.
      const source = await resolvePersonaSpeechSource(
        conversation.id,
        req.params.messageId,
        { includeMainAgent: true },
      );
      if (source)
        asset = await ensurePersonaMessageSpeech(source).catch(() => undefined);
    }
    if (!asset) return res.status(404).json({ error: 'Speech not ready' });
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    await serveTtsAsset(req, res, asset);
  },
);

router.post(
  '/native/tts/conversations/:cid/messages/:messageId/complete',
  async (req: any, res: any) => {
    const ctx = await getUserId(req, res);
    if (!ctx) return;
    const sessionId =
      typeof req.body?.liveModeSessionId === 'string'
        ? req.body.liveModeSessionId
        : '';
    const owner = getPersonaLiveOwner(req.params.cid);
    if (!sessionId || !owner || owner.sessionId !== sessionId) {
      return res.status(409).json({ error: 'Stale Live Mode session' });
    }
    const conversation = await getConversation(req.params.cid);
    const access = conversation
      ? await userCanAccessConversation(ctx.user_id, conversation.id)
      : null;
    if (!conversation || !access)
      return res.status(404).json({ error: 'Speech not found' });
    if (req.body?.outcome === 'started') {
      const snapshot = await startLiveQueueMessage(
        req.params.cid,
        req.params.messageId,
        sessionId,
        {
          userId: ctx.user_id,
          deviceId: ctx.device_id,
          // Device-spoken clips have no server asset to time the item by.
          durationMs:
            typeof req.body?.durationMs === 'number'
              ? req.body.durationMs
              : undefined,
        },
      );
      if (!snapshot)
        return res
          .status(409)
          .json({ error: 'Stale or unreleased Live Mode item' });
      return res.json({ ok: true, outcome: 'started', snapshot });
    }
    return res.status(400).json({ error: 'Unsupported outcome' });
  },
);

router.get('/notifications/payloads', async (req: any, res: any) => {
  const ctx = await getUserId(req, res);
  if (!ctx) return;
  const items = await getUndeliveredPayloads(ctx.user_id);
  return res.json({ items });
});

// In-app bell endpoint. Mounted separately in http-service.ts (NOT under the
// pushRouter's requireFreshSignature chain) so the web client can hit it via
// session cookie. The signed-request flow is FCM-service-only — the in-app
// UI authenticates the same way every other web endpoint does.
export async function handleUnreadNotifications(
  req: any,
  res: any,
): Promise<any> {
  const user_id: string | undefined = req.authUser?.id;
  if (!user_id)
    return res.status(401).json({ error: 'Authentication required' });
  await ackDuplicateUnreadMemoryReviewPayloads(user_id);
  const [items, count] = await Promise.all([
    getUnreadPayloads(user_id),
    countUnreadPayloads(user_id),
  ]);
  return res.json({ items, count });
}

export async function handleAckUnreadNotifications(
  req: any,
  res: any,
): Promise<any> {
  const user_id: string | undefined = req.authUser?.id;
  if (!user_id)
    return res.status(401).json({ error: 'Authentication required' });

  // Optional `ids` limits the ack to those payloads; without it all unread
  // payloads are acked.
  const ids: unknown = req.body?.ids;
  if (
    ids !== undefined &&
    (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string'))
  )
    return res.status(400).json({ error: 'Invalid ids' });
  const payloads = await ackUnreadPayloads(user_id, ids);
  for (const payload of payloads) {
    if (payload.kind === 'json_form') {
      cancelPending(payload.id, 'cancelled');
    }
    broadcast({
      type: 'notification_acked',
      payload: { user_id, payload_id: payload.id },
    });
    void dispatchDismissPing(user_id, payload.id);
  }
  return res.json({
    ok: true,
    payloads: payloads.map(({ id, kind }) => ({ id, kind })),
  });
}

async function runGetPayloadById(
  req: any,
  res: any,
  user_id: string,
): Promise<any> {
  const item = await getPayloadById(req.params.id, user_id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  return res.json({ item });
}

async function runAckPayload(
  req: any,
  res: any,
  user_id: string,
): Promise<any> {
  const payload = await getPayloadById(req.params.id, user_id);
  if (!payload) return res.status(404).json({ error: 'Not found' });

  const formResponse = req.body?.form_response;
  const isForm = payload.kind === 'json_form';
  const hasValues = isRecord(formResponse);

  logger.info(
    {
      payload_id: payload.id,
      kind: payload.kind,
      is_form: isForm,
      has_values: hasValues,
      respond_to_kind: payload.respond_to_kind,
      body_form_response_type: typeof formResponse,
    },
    '[push:ack] received',
  );

  if (hasValues) {
    const values = formResponse as Record<string, unknown>;

    // Re-validate the response against the original JSON Schema. The client
    // already validates via HTML5 attributes, but re-checking server-side
    // means a malicious or buggy client can't slip past required/format/
    // pattern constraints — same posture as Bearer-or-signature.
    if (isForm) {
      try {
        const validate = compileFormValidator(payload.content);
        if (!validate(values)) {
          const message = formatAjvErrors(validate.errors);
          logger.warn(
            {
              payload_id: payload.id,
              errorCount: validate.errors?.length ?? 0,
            },
            '[push:ack] form_response failed schema validation',
          );
          return res
            .status(400)
            .json({ error: 'Invalid form response', details: message });
        }
      } catch (err) {
        logger.warn(
          { payload_id: payload.id, err: String(err) },
          '[push:ack] schema compile failed; rejecting response',
        );
        return res
          .status(400)
          .json({ error: 'Stored schema is not validatable' });
      }
    }

    // Accept one answer per payload, and only before it expires. A DB failure
    // is logged and the answer is still delivered so a wait=true awaiter is
    // never starved.
    try {
      const stored = await persistFormResponse(payload.id, user_id, values);
      if (stored === 'already_answered') {
        return res.status(409).json({ error: 'already_answered' });
      }
      if (stored === 'expired') {
        return res.status(410).json({ error: 'expired' });
      }
    } catch (err) {
      logger.warn(
        { payload_id: payload.id, err: String(err) },
        '[push:ack] failed to persist form_response',
      );
    }
    const awaiterConsumed = deliverFormResponse(payload.id, values);
    if (payload.respond_to_kind) {
      // Best-effort: don't block the ACK if routing fails.
      routeFormResponse(payload, values, { awaiterConsumed }).catch((err) => {
        logger.warn(
          { payload_id: payload.id, err: String(err) },
          '[push:ack] form-response routing threw',
        );
      });
    }
  } else if (isForm) {
    // ACK on a form payload without values means the user dismissed the form.
    // Wake any pending awaiter so the calling agent unblocks instead of
    // sitting on the wait timeout.
    cancelPending(payload.id, 'cancelled');
  }

  await ackPayload(payload.id, user_id);
  broadcast({
    type: 'notification_acked',
    payload: { user_id, payload_id: payload.id },
  });
  // FCM fallback for devices whose app process has been killed (the WS
  // dismiss path won't reach them). Fire-and-forget — don't block the ACK.
  void dispatchDismissPing(user_id, payload.id);
  return res.json({ ok: true });
}

router.get('/notifications/payloads/:id', async (req: any, res: any) => {
  const ctx = await getUserId(req, res);
  if (!ctx) return;
  return runGetPayloadById(req, res, ctx.user_id);
});

router.post('/notifications/payloads/:id/ack', async (req: any, res: any) => {
  const ctx = await getUserId(req, res);
  if (!ctx) return;
  return runAckPayload(req, res, ctx.user_id);
});

// Session-auth wrappers, mounted in http-service.ts BEFORE pushRouter so
// in-app calls (web + mobile WebView) avoid the FCM-only signed flow. If no
// session, they call next() and the request falls through to the signed
// routes above (used by the native CarapaMessagingService).
export async function handlePayloadByIdSession(
  req: any,
  res: any,
  next: any,
): Promise<any> {
  const user_id: string | undefined = req.authUser?.id;
  if (!user_id) return next();
  return runGetPayloadById(req, res, user_id);
}

export async function handleAckPayloadSession(
  req: any,
  res: any,
  next: any,
): Promise<any> {
  const user_id: string | undefined = req.authUser?.id;
  if (!user_id) return next();
  return runAckPayload(req, res, user_id);
}

export default router;
