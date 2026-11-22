import { describe, expect, spyOn, test } from 'bun:test';
import { recordTiming, summarizeSqlForLog } from './drizzle-client.js';
import { logger } from '../logger.js';

describe('slow-query log summaries', () => {
  test('removes inline values and comments from raw SQL', () => {
    const summary = summarizeSqlForLog(`
      /* private diagnostic comment */
      update "chat_messages"
      set "content" = 'private conversation text', "created_at" = '2026-08-30'
      where "id" = 123 -- private trailing comment
    `);

    expect(summary).toEqual({
      operation: 'update',
      tables: ['chat_messages'],
      sql: 'update "chat_messages" set "content" = ?, "created_at" = ? where "id" = ?',
    });
    expect(JSON.stringify(summary)).not.toContain('private');
  });
});

test('slow database query warn carries loopLagMs', () => {
  const warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
  try {
    recordTiming(Date.now() - 500, 'select * from tasks where id = 1');
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = warn.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(msg).toBe('slow database query');
    expect(fields.loopLagMs).toBe(0);
  } finally {
    warn.mockRestore();
  }
});
