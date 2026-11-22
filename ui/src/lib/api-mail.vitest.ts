import { createPublicKey, verify, webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { mailRequest } from './api';
import {
  exportPrivateKey,
  exportPublicKey,
  generateDeviceKeyPair,
} from './crypto';
import * as vault from './session-vault';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('authenticates desktop mail reads and mutations with the server signing payload', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const keys = await generateDeviceKeyPair();
  const publicKey = createPublicKey({
    key: Buffer.from(await exportPublicKey(keys.publicKey), 'base64'),
    format: 'der',
    type: 'spki',
  });
  vi.spyOn(vault, 'vaultGetDeviceCreds').mockReturnValue({
    deviceId: 'desktop-mail-test',
    privKeyB64: await exportPrivateKey(keys.privateKey),
  });
  // Fixed wire-protocol expectations keep this UI test independent of backend
  // source files and catch signing an empty trailing '?' on desktop.
  const expectedPayloads = [
    'GET:/api/projects/project-a/mail/accounts:',
    'GET:/api/projects/project-a/mail/messages?accountId=account-a&folder=Inbox+%26+work&search=a%2Bb%3F&page=1:',
    'POST:/api/projects/project-a/mail/send:{"accountId":"account-a","to":"recipient@example.com","subject":"Hello","body":"Draft"}',
  ];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    expect(headers.get('X-Carapa-Device-ID')).toBe('desktop-mail-test');
    const payload = `${headers.get('X-Carapa-Timestamp')}:${expectedPayloads.shift()}`;
    const valid = verify(
      'sha256',
      Buffer.from(payload),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(headers.get('X-Carapa-Signature')!, 'base64'),
    );
    return Response.json(
      valid ? { ok: true } : { error: 'Invalid biometric signature' },
      {
        status: valid ? 200 : 401,
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(mailRequest('project-a', 'accounts')).resolves.toEqual({
    ok: true,
  });
  await expect(
    mailRequest('project-a', 'messages', {
      accountId: 'account-a',
      folder: 'Inbox & work',
      search: 'a+b?',
      page: 1,
    }),
  ).resolves.toEqual({ ok: true });
  await expect(
    mailRequest(
      'project-a',
      'send',
      {},
      {
        accountId: 'account-a',
        to: 'recipient@example.com',
        subject: 'Hello',
        body: 'Draft',
      },
    ),
  ).resolves.toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
