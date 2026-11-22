import { Router } from 'express';
import {
  getDevicesForUser,
  getAllDevices,
  activateDeviceForUser,
  deactivateDeviceIfSafe,
  deleteDeviceIfSafe,
  updateDeviceLabel,
  approveDevice,
  adminDeleteDevice,
  type DeviceMutationResult,
} from '../db.js';
import { requireAuth } from './auth-helpers.js';
import { requireAdmin } from './_helpers.js';
import { readAndroidOtaPublicKey } from '../lib/android-ota.js';
import { readPresentedCertificate } from '../lib/presented-cert.js';
import { logger } from '../logger.js';
import { closeDeviceSockets } from '../modules/objectives/ws-events.js';

const MAX_LABEL_LEN = 64;

const router = Router();

function respondToMutation(
  res: any,
  result: DeviceMutationResult,
  lastActiveMsg: string,
): any {
  switch (result) {
    case 'ok':
      return res.json({ ok: true });
    case 'not_found':
      return res.status(404).json({ error: 'Device not found' });
    case 'last_active':
      return res.status(400).json({ error: lastActiveMsg });
  }
}

router.get('/android/pairing-info', requireAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ otaPublicKey: readAndroidOtaPublicKey() });
});

// The certificate a phone would see at a pairing address. It is read from
// the address itself, not from the board's own listener, because a reverse
// proxy in front of the board presents its own certificate.
router.get('/android/presented-cert', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let url: URL;
  try {
    url = new URL(typeof req.query.url === 'string' ? req.query.url : '');
  } catch {
    return res.status(400).json({ error: 'url must be an https address' });
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return res.status(400).json({ error: 'url must be an https address' });
  }
  return res.json(
    (await readPresentedCertificate(url)) ?? {
      certSha256: null,
      trusted: false,
    },
  );
});

router.get('/account/devices', requireAuth, async (req: any, res) => {
  const devices = await getDevicesForUser(req.authUser.id);
  const currentDeviceId: string | undefined = req.authDeviceId;
  const annotated = devices.map((d) => ({
    ...d,
    isCurrent: currentDeviceId === d.deviceId,
  }));
  return res.json({
    devices: annotated,
    currentDeviceId: currentDeviceId ?? null,
  });
});

router.put('/account/devices/:deviceId', requireAuth, async (req: any, res) => {
  const body = req.body ?? {};
  const hasIsActive = body.isActive === true || body.isActive === false;
  const hasLabel = Object.prototype.hasOwnProperty.call(body, 'label');

  if (!hasIsActive && !hasLabel) {
    return res.status(400).json({ error: 'Provide isActive and/or label' });
  }

  if (hasLabel) {
    const raw = body.label;
    if (raw !== null && typeof raw !== 'string') {
      return res.status(400).json({ error: 'label must be a string or null' });
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : null;
    if (trimmed && trimmed.length > MAX_LABEL_LEN) {
      return res
        .status(400)
        .json({ error: `label must be at most ${MAX_LABEL_LEN} characters` });
    }
    const labelResult = await updateDeviceLabel(
      req.params.deviceId,
      req.authUser.id,
      trimmed || null,
    );
    if (labelResult === 'not_found') {
      return res.status(404).json({ error: 'Device not found' });
    }
  }

  if (hasIsActive) {
    // Prevent users from deactivating the device they're signed in from — would
    // immediately invalidate this very session and lock them out.
    if (
      body.isActive === false &&
      req.authDeviceId &&
      req.authDeviceId === req.params.deviceId
    ) {
      return res
        .status(400)
        .json({ error: 'Cannot deactivate the device you are signed in from' });
    }

    const result = body.isActive
      ? await activateDeviceForUser(req.params.deviceId, req.authUser.id)
      : await deactivateDeviceIfSafe(req.params.deviceId, req.authUser.id);
    if (result === 'ok' && !body.isActive)
      closeDeviceSockets(req.authUser.id, req.params.deviceId);
    if (result === 'ok')
      logger.info(
        {
          event: body.isActive ? 'device.activated' : 'device.deactivated',
          deviceId: req.params.deviceId,
          actorId: req.authUser.id,
        },
        'Device access changed',
      );
    return respondToMutation(
      res,
      result,
      'Cannot deactivate the last active device',
    );
  }

  return res.json({ ok: true });
});

router.delete(
  '/account/devices/:deviceId',
  requireAuth,
  async (req: any, res) => {
    const isSelf = !!(
      req.authDeviceId && req.authDeviceId === req.params.deviceId
    );
    const confirmed = req.body?.confirm === true;

    // Self-removal requires an explicit confirm flag. This is the API-level
    // safety net against accidental sign-out by other clients; the UI surfaces
    // the warning before sending the flag.
    if (isSelf && !confirmed) {
      return res.status(400).json({
        error:
          'Removing the device you are signed in from will sign you out. Confirm to proceed.',
        requiresConfirm: true,
      });
    }

    const result = await deleteDeviceIfSafe(
      req.params.deviceId,
      req.authUser.id,
    );
    if (result === 'ok')
      closeDeviceSockets(req.authUser.id, req.params.deviceId);
    if (result === 'ok')
      logger.info(
        {
          event: 'device.deleted',
          deviceId: req.params.deviceId,
          actorId: req.authUser.id,
        },
        'Device removed',
      );
    if (result === 'ok' && isSelf) {
      return res.json({ ok: true, signedOut: true });
    }
    return respondToMutation(
      res,
      result,
      'Cannot remove the last active device',
    );
  },
);

// --- Admin device management (cross-user) ---

router.get('/admin/devices', requireAdmin, async (_req, res) => {
  const devices = await getAllDevices();
  return res.json({ devices });
});

router.post(
  '/admin/devices/:deviceId/approve',
  requireAdmin,
  async (req: any, res) => {
    const result = await approveDevice(req.params.deviceId, req.authUser.id);
    if (result === 'not_found') {
      return res.status(404).json({ error: 'Device not found' });
    }
    return res.json({ ok: true });
  },
);

router.delete(
  '/admin/devices/:deviceId',
  requireAdmin,
  async (req: any, res) => {
    // Admin delete: no last-active guard, no self-confirm — admins can prune
    // any device including their own (they can re-enroll on next login).
    const result = await adminDeleteDevice(
      req.params.deviceId,
      req.authUser.id,
    );
    if (result === 'not_found') {
      return res.status(404).json({ error: 'Device not found' });
    }
    closeDeviceSockets(result.ownerId, req.params.deviceId);
    return res.json({ ok: true });
  },
);

export default router;
