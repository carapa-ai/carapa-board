import {
  createSigningPayload,
  isFreshTimestamp,
  verifySignature,
} from '../../crypto-verify.js';
import { getDevicePublicKey, getUserIdByDevice } from '../../db.js';
import { touchDeviceLastUsed } from '../device-activity.js';

export type FreshSignatureResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Verifies the `x-carapa-*` device signature over method, originalUrl,
 * timestamp and JSON body, with a 30 s freshness window. When the request has
 * a session user (`req.authUser`), the signing device must belong to them.
 */
export async function verifyFreshSignature(
  req: any,
): Promise<FreshSignatureResult> {
  const fail = (error: string): FreshSignatureResult => ({
    ok: false,
    status: 401,
    error,
  });
  const device_id = req.headers['x-carapa-device-id'] as string | undefined;
  const timestamp = req.headers['x-carapa-timestamp'] as string | undefined;
  const signature = req.headers['x-carapa-signature'] as string | undefined;
  if (!device_id || !timestamp || !signature) {
    return fail('Fresh signature required');
  }
  if (!isFreshTimestamp(timestamp, 30_000)) {
    return fail('Stale biometric signature');
  }
  const public_key = await getDevicePublicKey(device_id);
  if (!public_key) return fail('Unknown device');
  const method = req.method.toUpperCase();
  const bodyStr =
    method === 'GET' || method === 'HEAD'
      ? ''
      : req.body && Object.keys(req.body).length > 0
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
  const valid = await verifySignature(public_key, signature, payload);
  if (!valid) return fail('Invalid biometric signature');
  // A session-authenticated request must be signed by one of that user's own
  // devices. Signed-only routes (no session) carry no authUser to bind to.
  if (req.authUser) {
    const ownerId = await getUserIdByDevice(device_id);
    if (!ownerId || ownerId !== req.authUser.id) {
      return fail('Device does not belong to user');
    }
  }
  // Fire-and-forget: the shared throttle handles persistence failures.
  touchDeviceLastUsed(device_id);
  return { ok: true };
}
