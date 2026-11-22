/** Node/Bun client; deliberately independent of Board config and server modules. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sleep } from './async.js';
import type { PairingStarted } from './device-auth/scopes.js';
export type DeviceCredentials = {
  board: string;
  deviceId: string;
  privKeyB64: string;
  pubKeyB64: string;
  pairing?: PairingStarted;
};
const credentialPath = (file: string) =>
  path.resolve(file.replace(/^~(?=\/|$)/, os.homedir()));
function boardOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Use a Board origin without credentials, path or query');
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  )
    throw new Error('Remote Board connections require HTTPS');
  return url.origin;
}
function save(file: string, credentials: DeviceCredentials) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(credentials, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.renameSync(`${file}.tmp`, file);
  fs.chmodSync(file, 0o600);
}
export class CarapaDeviceClient {
  private token?: string;
  private tokenExpiresAt = 0;
  private key?: CryptoKey;
  constructor(readonly credentials: DeviceCredentials) {}
  async signedRequest(
    route: string,
    method = 'GET',
    body?: unknown,
    token?: string,
  ): Promise<Response> {
    if (
      !route.startsWith('/') ||
      route.startsWith('//') ||
      new URL(route, this.credentials.board).origin !== this.credentials.board
    )
      throw new Error('Expected a same-origin API path');
    this.key ??= await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(this.credentials.privKeyB64, 'base64'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const multipart = body instanceof FormData;
    const text = body === undefined || multipart ? '' : JSON.stringify(body);
    const timestamp = new Date().toISOString();
    const signature = Buffer.from(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.key,
        new TextEncoder().encode(
          `${timestamp}:${method}:${route}:${text === '{}' ? '' : text}`,
        ),
      ),
    ).toString('base64');
    return fetch(this.credentials.board + route, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
      headers: {
        ...(multipart ? {} : { 'Content-Type': 'application/json' }),
        'x-carapa-device-id': this.credentials.deviceId,
        'x-carapa-timestamp': timestamp,
        'x-carapa-signature': signature,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(multipart ? { body: body as FormData } : text ? { body: text } : {}),
    });
  }
  async request(route: string, method = 'GET', body?: unknown) {
    if (!this.token || this.tokenExpiresAt <= Date.now()) {
      const response = await this.signedRequest('/api/auth/token', 'POST');
      if (!response.ok)
        throw new Error(
          `Device authentication: HTTP ${response.status}; check approval, expiry and revocation`,
        );
      const { token } = (await response.json()) as { token: unknown };
      if (typeof token !== 'string')
        throw new Error('Invalid authentication response');
      this.token = token;
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString(),
      );
      this.tokenExpiresAt = Number(payload.exp) * 1000 - 30000;
    }
    const response = await this.signedRequest(route, method, body, this.token);
    if (!response.ok)
      throw new Error(
        `${method} ${route.split('?')[0]}: HTTP ${response.status}`,
      );
    return response;
  }
  static load(board: string, file: string) {
    const credentials = JSON.parse(
      fs.readFileSync(credentialPath(file), 'utf8'),
    ) as DeviceCredentials;
    if (credentials.board !== boardOrigin(board))
      throw new Error('Device file belongs to another Board');
    if (credentials.pairing)
      throw new Error(
        'Device pairing is not completed; run the pairing command again',
      );
    return new CarapaDeviceClient(credentials);
  }
}
export async function pairCarapaDevice(options: {
  board: string;
  file: string;
  name: string;
  scopes: string[];
  onCode: (pairing: PairingStarted) => void;
  signal?: AbortSignal;
}) {
  const board = boardOrigin(options.board),
    file = credentialPath(options.file);
  let credentials: DeviceCredentials;
  if (fs.existsSync(file)) {
    credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (credentials.board !== board)
      throw new Error('Device file belongs to another Board');
    if (!credentials.pairing && credentials.deviceId)
      throw new Error(
        'Credentials already exist; use another file for a new pairing',
      );
  } else {
    const keys = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    credentials = {
      board,
      deviceId: '',
      pubKeyB64: Buffer.from(
        await crypto.subtle.exportKey('spki', keys.publicKey),
      ).toString('base64'),
      privKeyB64: Buffer.from(
        await crypto.subtle.exportKey('pkcs8', keys.privateKey),
      ).toString('base64'),
    };
    save(file, credentials);
  }
  const client = new CarapaDeviceClient(credentials);
  // Approval may have succeeded before the client lost its polling response.
  // Prove the saved key is registered before replacing an expired request.
  if (credentials.pairing && credentials.deviceId) {
    const registered = await client.signedRequest('/api/auth/token', 'POST');
    if (registered.ok) {
      delete credentials.pairing;
      save(file, credentials);
      return client;
    }
    await registered.body?.cancel();
  }
  if (
    !credentials.pairing ||
    Date.parse(credentials.pairing.expiresAt) <= Date.now()
  ) {
    const response = await client.signedRequest(
      '/api/auth/device-pairing',
      'POST',
      {
        publicKey: credentials.pubKeyB64,
        label: options.name,
        scopes: options.scopes,
        nonce: crypto.randomUUID(),
      },
    );
    if (!response.ok) throw new Error(`Start pairing: HTTP ${response.status}`);
    const pairing = (await response.json()) as PairingStarted;
    credentials.deviceId = pairing.deviceId;
    credentials.pairing = pairing;
    save(file, credentials);
  }
  const pairing = credentials.pairing;
  options.onCode({
    ...pairing,
    verificationUrl: new URL(pairing.verificationUrl, board).href,
  });
  while (Date.parse(pairing.expiresAt) > Date.now()) {
    options.signal?.throwIfAborted();
    await sleep(pairing.interval * 1000);
    options.signal?.throwIfAborted();
    const response = await client.signedRequest(
      '/api/auth/device-pairing/poll',
      'POST',
      { id: pairing.id, pollingSecret: pairing.pollingSecret },
    );
    if (response.status === 429) continue;
    if (!response.ok) throw new Error(`Poll pairing: HTTP ${response.status}`);
    const { status } = (await response.json()) as { status: string };
    if (status === 'approved') {
      delete credentials.pairing;
      save(file, credentials);
      return client;
    }
    if (status !== 'pending')
      throw new Error(
        `Pairing ${status}; use a new credentials file to start again`,
      );
  }
  throw new Error('Pairing code expired; run the pairing command again');
}
