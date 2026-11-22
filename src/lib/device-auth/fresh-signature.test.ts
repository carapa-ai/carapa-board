import { beforeAll, describe, expect, test } from 'bun:test';

import { createSigningPayload } from '../../crypto-verify.js';
import { createUser, initDatabase, registerDeviceKey } from '../../db.js';
import { verifyFreshSignature } from './fresh-signature.js';

const tag = `fresh-sig-${process.pid}`;
const ownerDevice = `${tag}-owner-device`;
const url = '/api/projects/p1';
let signingKey: CryptoKey;
let ownerId: string;
let otherId: string;

async function signedRequest(
  authUser: { id: string } | undefined,
  { deviceId = ownerDevice, timestamp = new Date().toISOString() } = {},
) {
  const payload = createSigningPayload('DELETE', url, timestamp, '');
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    new TextEncoder().encode(payload),
  );
  return {
    method: 'DELETE',
    originalUrl: url,
    body: {},
    authUser,
    headers: {
      'x-carapa-device-id': deviceId,
      'x-carapa-timestamp': timestamp,
      'x-carapa-signature': Buffer.from(signature).toString('base64'),
    },
  };
}

beforeAll(async () => {
  await initDatabase(':memory:');
  ownerId = (await createUser(`${tag}-owner`, 'password', 'user')).id;
  otherId = (await createUser(`${tag}-other`, 'password', 'user')).id;
  const keys = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  signingKey = keys.privateKey;
  await registerDeviceKey(
    ownerDevice,
    ownerId,
    Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString(
      'base64',
    ),
    'test',
    true,
  );
});

describe('verifyFreshSignature device/user binding', () => {
  test("rejects a valid signature from another user's device", async () => {
    expect(
      await verifyFreshSignature(await signedRequest({ id: otherId })),
    ).toEqual({
      ok: false,
      status: 401,
      error: 'Device does not belong to user',
    });
  });

  test("accepts the session user's own device", async () => {
    expect(
      await verifyFreshSignature(await signedRequest({ id: ownerId })),
    ).toEqual({ ok: true });
  });

  test('accepts a signed-only request with no session user', async () => {
    expect(await verifyFreshSignature(await signedRequest(undefined))).toEqual({
      ok: true,
    });
  });

  test('still rejects unknown devices and stale timestamps', async () => {
    const unknown = await verifyFreshSignature(
      await signedRequest(undefined, { deviceId: `${tag}-missing` }),
    );
    expect(unknown).toEqual({
      ok: false,
      status: 401,
      error: 'Unknown device',
    });
    const stale = await verifyFreshSignature(
      await signedRequest(undefined, {
        timestamp: new Date(Date.now() - 120_000).toISOString(),
      }),
    );
    expect(stale).toEqual({
      ok: false,
      status: 401,
      error: 'Stale biometric signature',
    });
  });
});
