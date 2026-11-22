import { describe, expect, it } from 'vitest';
import {
  buildNotificationReplyDraft,
  parseNotificationReplyTarget,
} from './notification-reply';

describe('parseNotificationReplyTarget', () => {
  it('parses objective, chat and board URLs', () => {
    expect(parseNotificationReplyTarget('/objective/p%201/obj-1')).toEqual({
      projectId: 'p 1',
      objectiveId: 'obj-1',
    });
    expect(
      parseNotificationReplyTarget('/objective/p/obj-1?report=a.md'),
    ).toEqual({ projectId: 'p', objectiveId: 'obj-1' });
    expect(parseNotificationReplyTarget('/chat/p?conversationId=c1')).toEqual({
      projectId: 'p',
    });
    expect(parseNotificationReplyTarget('/board/p?taskId=t1')).toEqual({
      projectId: 'p',
    });
  });

  it('rejects missing, malformed and traversal URLs', () => {
    for (const url of [
      null,
      undefined,
      '',
      'https://evil.test/chat/p',
      '//evil.test/chat/p',
      '/objective/p',
      '/objective/p/o/extra',
      '/objective/p/..',
      '/objective/p/%2e%2e',
      '/objective/p%2Fq/o',
      '/objective/p%5Cq/o',
      '/objective/%E0%A4%A/o',
      '/settings',
    ]) {
      expect(parseNotificationReplyTarget(url)).toBeNull();
    }
  });
});

describe('buildNotificationReplyDraft', () => {
  it('quotes every content line under the header', () => {
    expect(
      buildNotificationReplyDraft({
        summary: 'Escalation',
        content: 'line one\nline two',
        created_at: '2026-10-17T00:00:00.000Z',
      }),
    ).toBe(
      'Re: notification "Escalation" (2026-10-17T00:00:00.000Z)\n> line one\n> line two\n\n',
    );
  });

  it('omits the time when unavailable and truncates long content', () => {
    const draft = buildNotificationReplyDraft({
      summary: 'S',
      content: 'x'.repeat(2500),
    });
    expect(draft.startsWith('Re: notification "S"\n> ')).toBe(true);
    expect(draft).toBe(`Re: notification "S"\n> ${'x'.repeat(2000)}…\n\n`);
  });
});
