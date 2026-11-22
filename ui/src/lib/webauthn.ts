import { base64ToBytes, bytesToBase64 } from './base64';

// WebAuthn ceremonies and PRF-derived AES-GCM key material.
//
// The flow:
//   1. `webauthnRegister` provisions a credential bound to the current
//      origin (Touch ID / Face ID / Windows Hello / hardware key) with the
//      PRF extension. The authenticator generates a non-extractable
//      private key inside the OS secure enclave or hardware element.
//   2. `webauthnAssertWithPRF` prompts the user for that credential and
//      returns 32 bytes of PRF output. The PRF output is HKDF-SHA256'd
//      into an AES-GCM key in `deriveWrapKey`.
//   3. Callers wrap small JSON payloads (the session vault) with the AES
//      key and persist the ciphertext. Unwrap is the inverse.
//
// The hard-coded salt is fine: PRF inputs are mixed with the
// credential-internal secret by the authenticator, so two different apps
// using the same input produce different outputs. We just need a
// stable string for the lifetime of the deployment.

const PRF_SALT_INPUT = 'carapa-vault-v1';
const PRF_OUTPUT_LEN = 32;
const HKDF_INFO = 'carapa-vault-aes-gcm';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function prfSaltBytes(): Promise<ArrayBuffer> {
  // Hash the static input down to 32 bytes so it's a fixed length the
  // authenticator can mix in. The actual security property comes from
  // the credential-bound HMAC the authenticator performs over it.
  return await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(PRF_SALT_INPUT),
  );
}

function randomChallenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export interface WebauthnBlob {
  iv: string;
  ciphertext: string;
}

/**
 * True if this device exposes a user-verifying platform authenticator
 * (Touch ID, Face ID, Windows Hello, Android device credential). On a
 * desktop with no biometric, the user can still complete the ceremony
 * with a hardware key — but we surface platform availability separately
 * so the UI can give a meaningful "not available" message.
 */
export async function webauthnPlatformAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function webauthnSupported(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}

export interface RegisterArgs {
  /** Stable user identifier (we use the AuthUser.id). Bytes shown to the platform UI as the account anchor. */
  userId: string;
  /** Username shown in the OS picker (e.g. "john"). */
  userName: string;
  /** Display name shown in the OS picker (e.g. "John Doe"). */
  displayName: string;
}

export interface RegisterResult {
  /** Base64 of the credential id; persist this so we can re-target the same credential at unlock time. */
  credentialId: string;
  /** PRF output from the registration ceremony, if the authenticator returned it. */
  prfOutput: ArrayBuffer | null;
}

/**
 * Provision a new platform credential bound to this origin, with PRF
 * enabled. Returns the credentialId for storage. PRF output is included
 * when the authenticator supports it on create (Chrome 147+, Firefox 148+);
 * otherwise the caller must follow up with `webauthnAssertWithPRF`.
 */
export async function webauthnRegister(
  args: RegisterArgs,
): Promise<RegisterResult> {
  if (!webauthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser');
  }
  const salt = await prfSaltBytes();
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: randomChallenge() as BufferSource,
    rp: {
      // Default to the current origin's host. Omitting `id` lets the
      // browser pick the registrable suffix it will accept on assertion.
      name: 'CarapaBoard',
    },
    user: {
      id: textEncoder.encode(args.userId) as BufferSource,
      name: args.userName,
      displayName: args.displayName,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256
      { type: 'public-key', alg: -257 }, // RS256
    ],
    authenticatorSelection: {
      userVerification: 'required',
      // 'preferred' lets desktops with no platform authenticator fall
      // back to a hardware key; on phones the platform authenticator
      // wins automatically.
      residentKey: 'preferred',
    },
    timeout: 60_000,
    attestation: 'none',
    extensions: {
      // Type-cast: PRF isn't in lib.dom.d.ts at the time of writing.
      prf: { eval: { first: salt } },
    } as AuthenticationExtensionsClientInputs,
  };

  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Registration was cancelled');

  const ext = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const prfOutput = ext?.prf?.results?.first ?? null;

  return {
    credentialId: bytesToBase64(new Uint8Array(credential.rawId)),
    prfOutput,
  };
}

/**
 * Prompt the user for the previously-registered credential and return
 * the PRF output. Throws on cancel or unsupported.
 */
export async function webauthnAssertWithPRF(
  credentialId: string,
): Promise<ArrayBuffer> {
  if (!webauthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser');
  }
  const salt = await prfSaltBytes();
  const idBytes = base64ToBytes(credentialId);
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: randomChallenge() as BufferSource,
    timeout: 60_000,
    userVerification: 'required',
    allowCredentials: [
      {
        id: idBytes as BufferSource,
        type: 'public-key',
      },
    ],
    extensions: {
      prf: { eval: { first: salt } },
    } as AuthenticationExtensionsClientInputs,
  };
  const assertion = (await navigator.credentials.get({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error('Authentication was cancelled');

  const ext = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const prf = ext?.prf?.results?.first;
  if (!prf || prf.byteLength !== PRF_OUTPUT_LEN) {
    throw new Error('PRF extension is not supported by this authenticator');
  }
  return prf;
}

/**
 * Derive an AES-GCM 256 wrapping key from PRF output. The `info` string
 * domain-separates this key from any other PRF use of the same credential.
 */
export async function deriveWrapKey(
  prfOutput: ArrayBuffer,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    prfOutput,
    'HKDF',
    false,
    ['deriveKey'],
  );
  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: textEncoder.encode(HKDF_INFO),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function aesEncrypt(
  key: CryptoKey,
  plaintext: string,
): Promise<WebauthnBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    textEncoder.encode(plaintext),
  );
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ct)),
  };
}

export async function aesDecrypt(
  key: CryptoKey,
  blob: WebauthnBlob,
): Promise<string> {
  const iv = base64ToBytes(blob.iv);
  const ct = base64ToBytes(blob.ciphertext);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return textDecoder.decode(pt);
}
