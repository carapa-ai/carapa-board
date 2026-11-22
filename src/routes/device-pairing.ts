import { Router, type RequestHandler } from 'express';
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { sha256Hex } from '../lib/hash.js';
import { z } from 'zod';
import * as db from '../db.js';
import {
  createSigningPayload,
  importPublicKey,
  isFreshTimestamp,
  verifySignature,
} from '../crypto-verify.js';
import { buildLimiter } from '../lib/rate-limit.js';
import {
  DEVICE_SCOPES,
  DEVICE_SCOPE_IDS,
  GRANT_DAYS,
} from '../lib/device-auth/scopes.js';

const scopesSchema = z
  .array(z.string().refine((s) => DEVICE_SCOPE_IDS.has(s)))
  .min(1)
  .max(100)
  .transform((s) => [...new Set(s)]);
const durationSchema = z.union([
  z.literal(null),
  z.number().refine((n) => (GRANT_DAYS as readonly number[]).includes(n)),
]);
const expiry = (days: number | null) =>
  days === null ? null : new Date(Date.now() + days * 86400000).toISOString();
function codeHash(code: string) {
  const secret = process.env.CARAPA_BOARD_ENCRYPTION_KEY;
  if (!secret || secret.length < 32)
    throw new Error('Pairing requires a configured Board encryption key');
  return createHmac('sha256', secret)
    .update(code.replace(/[\s-]/g, '').toUpperCase())
    .digest('hex');
}
async function signed(req: any, publicKey: string) {
  const timestamp = req.headers['x-carapa-timestamp'];
  const signature = req.headers['x-carapa-signature'];
  return (
    typeof timestamp === 'string' &&
    typeof signature === 'string' &&
    isFreshTimestamp(timestamp) &&
    (await verifySignature(
      publicKey,
      signature,
      createSigningPayload(
        req.method,
        req.originalUrl,
        timestamp,
        req.body && Object.keys(req.body).length
          ? JSON.stringify(req.body)
          : '',
      ),
    ))
  );
}
const safe =
  (fn: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      if (error instanceof z.ZodError)
        res.status(400).json({ error: 'Invalid pairing request' });
      else next(error);
    }
  };
const admin: RequestHandler = safe(async (req: any, res, next) => {
  if (
    req.integrationGrant ||
    req.authUser?.role !== 'admin' ||
    !req.authDeviceId
  ) {
    res
      .status(403)
      .json({ error: 'An approved administrator device is required' });
    return;
  }
  const device = await db.getDeviceRecord(req.authDeviceId);
  if (
    !device ||
    device.kind !== 'interactive' ||
    device.user_id !== req.authUser.id ||
    !device.is_active ||
    !device.is_approved ||
    req.headers['x-carapa-device-id'] !== req.authDeviceId ||
    !(await signed(req, device.public_key))
  ) {
    res
      .status(403)
      .json({ error: 'An approved administrator signature is required' });
    return;
  }
  next();
});
export function getDevicePairingRouter() {
  const router = Router();
  const startLimit = buildLimiter({ max: 5, windowMs: 60000 });
  const pollLimit = buildLimiter({ max: 60, windowMs: 60000 });
  const resolveLimit = buildLimiter({
    max: 10,
    windowMs: 60000,
    skipSuccessfulRequests: true,
  });
  router.post(
    '/auth/device-pairing',
    startLimit,
    safe(async (req, res) => {
      const body = z
        .object({
          publicKey: z.string().max(300),
          label: z.string().trim().min(1).max(64),
          scopes: scopesSchema,
          nonce: z.string().min(32).max(128),
        })
        .strict()
        .parse(req.body);
      try {
        await importPublicKey(body.publicKey);
      } catch {
        res.status(400).json({ error: 'A P-256 public key is required' });
        return;
      }
      if (!(await signed(req, body.publicKey))) {
        res.status(401).json({ error: 'Key possession proof required' });
        return;
      }
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const userCode = Array.from(
        randomBytes(8),
        (byte) => alphabet[byte % alphabet.length],
      ).join('');
      const pollingSecret = randomBytes(32).toString('base64url');
      const id = randomUUID(),
        deviceId = `integration-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 600000).toISOString();
      await db.createDevicePairing({
        id,
        deviceId,
        publicKey: body.publicKey,
        label: body.label,
        requestedScopes: body.scopes,
        codeHash: codeHash(userCode),
        secretHash: sha256Hex(pollingSecret),
        expiresAt,
        createdAt: new Date().toISOString(),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        id,
        deviceId,
        userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
        pollingSecret,
        verificationUrl: '/admin/devices',
        expiresAt,
        interval: 5,
      });
    }),
  );
  router.post(
    '/auth/device-pairing/poll',
    pollLimit,
    safe(async (req, res) => {
      const body = z
        .object({
          id: z.string().uuid(),
          pollingSecret: z.string().min(32).max(100),
        })
        .strict()
        .parse(req.body);
      const row = await db.getDevicePairing(body.id);
      if (
        !row ||
        !timingSafeEqual(
          Buffer.from(row.secretHash, 'hex'),
          Buffer.from(sha256Hex(body.pollingSecret), 'hex'),
        ) ||
        !(await signed(req, row.publicKey))
      ) {
        res.status(401).json({ error: 'Invalid pairing credentials' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      const status = await db.pollDevicePairing(body.id);
      if (status === 'slow_down') {
        res.setHeader('Retry-After', '5');
        res.status(429).json({ status, interval: 5 });
        return;
      }
      res.json({ status, deviceId: row.deviceId });
    }),
  );
  router.post('/admin/device-pairing/scopes', admin, (_req, res) => {
    res.json(DEVICE_SCOPES);
  });
  router.post(
    '/admin/device-pairing/resolve',
    admin,
    resolveLimit,
    safe(async (req, res) => {
      const { code } = z
        .object({ code: z.string().min(8).max(20) })
        .strict()
        .parse(req.body);
      const row = await db.resolveDevicePairing(codeHash(code));
      if (!row) {
        res
          .status(404)
          .json({ error: 'Code is invalid, expired, or already used' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        id: row.id,
        label: row.label,
        requestedScopes: row.requestedScopes,
        expiresAt: row.expiresAt,
        fingerprint: sha256Hex(Buffer.from(row.publicKey, 'base64')),
      });
    }),
  );
  router.post(
    '/admin/device-pairing/:id/decision',
    admin,
    safe(async (req: any, res) => {
      const body = z
        .object({
          decision: z.enum(['approved', 'denied']),
          ownerId: z.string().min(1),
          scopes: scopesSchema,
          days: durationSchema.default(30),
        })
        .strict()
        .parse(req.body);
      const status = await db.decideDevicePairing(
        req.params.id,
        req.authUser.id,
        body.decision,
        body.ownerId,
        body.scopes,
        expiry(body.days),
      );
      res.status(['approved', 'denied'].includes(status) ? 200 : 409).json({
        status,
        ...(!['approved', 'denied'].includes(status)
          ? {
              error:
                'Pairing expired, was already decided, or requested permissions are invalid. Start a new pairing if needed.',
            }
          : {}),
      });
    }),
  );
  router.post(
    '/admin/devices/:id/grant',
    admin,
    safe(async (req: any, res) => {
      const body = z
        .object({ scopes: scopesSchema, days: durationSchema.optional() })
        .strict()
        .parse(req.body);
      const status = await db.updateIntegrationGrant(
        req.params.id,
        req.authUser.id,
        body.scopes,
        body.days === undefined ? undefined : expiry(body.days),
      );
      res
        .status(status === 'ok' ? 200 : status === 'not_found' ? 404 : 400)
        .json({
          status,
          ...(status !== 'ok'
            ? {
                error:
                  'Integration not found or permissions cannot be increased. Pair again to add permissions.',
              }
            : {}),
        });
    }),
  );
  return router;
}
