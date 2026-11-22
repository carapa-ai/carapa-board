import { expect, test } from 'bun:test';
import { z } from 'zod';
import { findUnknownArgKeys, formatUnknownArgsError } from './unknown-args.js';

const targetShape = { target_project: z.string().optional() };
const idShape = { project_id: z.string().optional() };

test('findUnknownArgKeys returns only undeclared keys and tolerates non-objects', () => {
  expect(
    findUnknownArgKeys(targetShape, { target_project: 'a', x: 1 }),
  ).toEqual(['x']);
  expect(findUnknownArgKeys(targetShape, {})).toEqual([]);
  for (const args of [undefined, null, 'x', 3, ['a']]) {
    expect(findUnknownArgKeys(targetShape, args)).toEqual([]);
  }
  expect(findUnknownArgKeys({}, { a: 1 })).toEqual(['a']);
  expect(findUnknownArgKeys({}, { toString: 1 })).toEqual(['toString']);
});

test('formatUnknownArgsError names keys, accepted keys and project hints', () => {
  expect(
    formatUnknownArgsError('get_project_setup', ['project_id'], targetShape),
  ).toBe(
    'Unknown parameter(s) project_id for get_project_setup. Accepted: target_project. Did you mean target_project?',
  );
  for (const key of ['group_folder', 'project', 'projectId']) {
    expect(formatUnknownArgsError('t', [key], targetShape)).toContain(
      'Did you mean target_project?',
    );
  }
  for (const key of ['target_project', 'project']) {
    expect(formatUnknownArgsError('t', [key], idShape)).toContain(
      'Did you mean project_id?',
    );
  }
  expect(formatUnknownArgsError('t', ['project_id'], idShape)).not.toContain(
    'Did you mean',
  );
  expect(formatUnknownArgsError('t', ['other'], targetShape)).not.toContain(
    'Did you mean',
  );
  expect(formatUnknownArgsError('t', ['a'], {})).toContain('Accepted: (none).');
});

test('formatUnknownArgsError truncates long keys and caps the listed keys', () => {
  const long = 'k'.repeat(200);
  const text = formatUnknownArgsError('t', [long], targetShape);
  expect(text).toContain('k'.repeat(64));
  expect(text).not.toContain('k'.repeat(65));
  const many = Array.from({ length: 15 }, (_, i) => `key${i}`);
  const capped = formatUnknownArgsError('t', many, targetShape);
  expect(capped).toContain('key9');
  expect(capped).not.toContain('key10');
  expect(capped).toContain('(+5 more)');
});
