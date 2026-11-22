import { describe, expect, test } from 'bun:test';
import {
  ensurePublicVisitorSession,
  publicVisitorCsrf,
  publicVisitorHash,
  validatePublicVisitorRequest,
} from './public-visitor-session.js';

function request(headers: Record<string, string> = {}) {
  return {
    headers,
    secure: false,
    protocol: 'http',
    ip: '192.0.2.10',
    get(name: string) {
      if (name.toLowerCase() === 'host') return 'board.test';
      return headers[name.toLowerCase()];
    },
  } as any;
}

describe('public visitor sessions', () => {
  test('requires the signed cookie, matching origin, and derived CSRF token', () => {
    let setCookie = '';
    const first = request();
    const session = ensurePublicVisitorSession(first, {
      append(name: string, value: string) {
        if (name === 'Set-Cookie') setCookie = value;
      },
    } as any);
    const cookie = setCookie.split(';', 1)[0];
    const csrf = publicVisitorCsrf(session, 'share-token');
    const valid = request({
      cookie,
      origin: 'http://board.test',
      'x-public-csrf': csrf,
    });
    expect(validatePublicVisitorRequest(valid, 'share-token')).toEqual(session);
    expect(
      validatePublicVisitorRequest(
        request({
          cookie,
          origin: 'http://attacker.test',
          'x-public-csrf': csrf,
        }),
        'share-token',
      ),
    ).toBeNull();
    expect(
      validatePublicVisitorRequest(
        request({
          cookie,
          origin: 'http://board.test',
          'x-public-csrf': 'wrong',
        }),
        'share-token',
      ),
    ).toBeNull();
    const hash = publicVisitorHash(session, valid.ip);
    expect(hash).not.toContain(valid.ip);
    expect(hash).toBe(publicVisitorHash(session, valid.ip));
  });

  test('malformed percent-encoding in any cookie does not throw', () => {
    const res = { append() {} } as any;
    expect(() =>
      ensurePublicVisitorSession(request({ cookie: 'x=%E0%A4%A; y=1' }), res),
    ).not.toThrow();
  });
});
