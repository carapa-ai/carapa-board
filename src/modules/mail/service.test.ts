import { describe, expect, mock, test } from 'bun:test';
import { CARAPA_MAIL_BASE_URL, parseMailResult } from './client.js';
import {
  downloadMailAttachment,
  mailRole,
  normalizeMailSent,
  MAX_MAIL_ATTACHMENT_BYTES,
} from './service.js';

describe('mail boundaries', () => {
  test('admits explicit project members and excludes foreign main projects even for admins', () => {
    const user = { id: 'alice', role: 'user' };
    expect(mailRole(user, {}, { kind: 'explicit', level: 'viewer' })).toBe(
      'viewer',
    );
    expect(mailRole(user, {}, { kind: 'explicit', level: 'editor' })).toBe(
      'editor',
    );
    expect(() => mailRole(user, {}, { kind: 'implicit' })).toThrow('Explicit');
    expect(() =>
      mailRole(
        { ...user, role: 'admin' },
        { is_main: true, user_id: 'bob' },
        { kind: 'explicit', level: 'owner' },
      ),
    ).toThrow('Access denied');
  });
  test('admins keep mail access to ownerless and own projects but need membership on a project owned by another user', () => {
    const admin = { id: 'admin-1', role: 'admin' };
    expect(mailRole(admin, {}, null)).toBe('editor');
    expect(mailRole(admin, { user_id: 'admin-1' }, null)).toBe('editor');
    expect(() => mailRole(admin, { user_id: 'bob' }, null)).toThrow('Explicit');
    expect(
      mailRole(
        admin,
        { user_id: 'bob' },
        { kind: 'explicit', level: 'viewer' },
      ),
    ).toBe('viewer');
  });
  test('preserves MCP filter failures and rejects malformed successful responses', () => {
    expect(
      parseMailResult<{ sent: boolean }>({
        content: [{ type: 'text', text: '{"sent":true}' }],
      }),
    ).toEqual({ sent: true });
    expect(() => normalizeMailSent({ sent: false })).toThrow(
      'invalid response',
    );
    expect(() =>
      parseMailResult({
        isError: true,
        content: [{ type: 'text', text: 'Blocked by security filter' }],
      }),
    ).toThrow('Blocked by security filter');
    expect(() =>
      parseMailResult({ content: [{ type: 'text', text: 'not JSON' }] }),
    ).toThrow('invalid response');
  });
  test('downloads only from CarapaMail without following redirects and bounds streamed bytes', async () => {
    const fetcher = mock(
      async () => new Response('attachment'),
    ) as unknown as typeof fetch;
    const url = `${CARAPA_MAIL_BASE_URL}/attachments/token`;
    expect(
      (await downloadMailAttachment(url, undefined, fetcher)).toString(),
    ).toBe('attachment');
    expect(fetcher).toHaveBeenCalledWith(new URL(url), {
      signal: undefined,
      redirect: 'error',
    });
    await expect(
      downloadMailAttachment('https://other.example/file', undefined, fetcher),
    ).rejects.toThrow('Invalid mail attachment URL');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const cancelled = mock(() => {});
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MAIL_ATTACHMENT_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel: cancelled,
    });
    await expect(
      downloadMailAttachment(
        url,
        undefined,
        (async () => new Response(stream)) as unknown as typeof fetch,
      ),
    ).rejects.toThrow('25 MB');
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
