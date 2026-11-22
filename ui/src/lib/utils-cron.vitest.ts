import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { validateCron } from './utils';

// Resolve cron-parser from the repository root, as the server does, not from
// ui/node_modules (which validateCron itself uses).
const rootRequire = createRequire(
  resolve(fileURLToPath(import.meta.url), '../../../../package.json'),
);
const { CronExpressionParser } = rootRequire(
  'cron-parser',
) as typeof import('cron-parser');

describe('validateCron', () => {
  test.each(['*/0 * * * *', '30-10 * * * *', '0 9 31 2 *', '', '* * * *'])(
    'rejects %j',
    (expr) => {
      expect(validateCron(expr)).not.toBeNull();
    },
  );

  test('includes the parser reason for rejected input', () => {
    expect(validateCron('30-10 * * * *')).toContain('Invalid range');
  });

  test.each([
    '0 9 * * MON',
    '@daily',
    '*/5 * * * *',
    '0 9 * * 1-5',
    '0 0 29 2 *',
    '0 0 9 * * *',
  ])('accepts %j and the root server parser agrees', (expr) => {
    expect(validateCron(expr)).toBeNull();
    expect(() => CronExpressionParser.parse(expr)).not.toThrow();
  });
});
