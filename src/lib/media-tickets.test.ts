import { describe, expect, test } from 'bun:test';
import { issueMediaTicket, resolveMediaTicket } from './media-tickets.js';

const now = Date.parse('2026-10-26T12:00:00.000Z');
const fileUrl = '/api/projects/proj/files/group/content?path=media%2Fdemo.webm';
const ticket = issueMediaTicket(
  `https://board.example${fileUrl}`,
  'user-1',
  'dev-1',
  now,
)!;
const withTicket = (url: string, value = ticket) =>
  `${url}${url.includes('?') ? '&' : '?'}mediaTicket=${value}`;

describe('media tickets', () => {
  test('stand in for the issuing user and device on exactly the issued file URL', () => {
    const issuer = { userId: 'user-1', deviceId: 'dev-1' };
    expect(resolveMediaTicket('GET', withTicket(fileUrl), now)).toEqual(issuer);
    expect(resolveMediaTicket('HEAD', withTicket(fileUrl), now)).toEqual(
      issuer,
    );
    const recording = '/api/projects/proj/tasks/task-1/recordings/run-1.webm';
    const recordingTicket = issueMediaTicket(recording, 'user-1', null, now)!;
    expect(
      resolveMediaTicket('GET', withTicket(recording, recordingTicket), now),
    ).toEqual({ userId: 'user-1', deviceId: undefined });
  });

  test('grant nothing for other methods, URLs, expiry or tampering', () => {
    const [payload, signature] = ticket.split('.');
    const forged = Buffer.from(
      JSON.stringify({ url: fileUrl, sub: 'admin', did: null, exp: now + 1 }),
    ).toString('base64url');
    const refused: [string, string, number][] = [
      ['DELETE', withTicket(fileUrl), now],
      [
        'GET',
        withTicket('/api/projects/proj/files/group/content?path=secret.webm'),
        now,
      ],
      ['GET', withTicket('/api/projects/other/files/group/content'), now],
      ['GET', withTicket('/api/projects/proj/tasks/task-1/output'), now],
      [
        'GET',
        withTicket(
          '/api/users/x/../../projects/proj/files/group/content?path=media%2Fdemo.webm',
        ),
        now,
      ],
      ['GET', withTicket(fileUrl), now + 8 * 60 * 60 * 1000],
      ['GET', withTicket(fileUrl, `${forged}.${signature}`), now],
      ['GET', withTicket(fileUrl, `${payload}.${signature}x`), now],
    ];
    for (const [method, url, at] of refused) {
      expect(resolveMediaTicket(method, url, at)).toBeNull();
    }
    expect(issueMediaTicket('/api/auth/token', 'user-1', null, now)).toBeNull();
  });
});
