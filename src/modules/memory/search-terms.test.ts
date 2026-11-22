import { describe, test, expect } from 'bun:test';
import { termOverlap, tokenizeQueryTerms } from './search-terms.js';

describe('tokenizeQueryTerms', () => {
  test('drops stopwords but keeps the keyword', () => {
    expect(tokenizeQueryTerms('the reflector')).toEqual(['reflector']);
  });

  test('a stopword-only query keeps its terms', () => {
    expect(tokenizeQueryTerms('the')).toEqual(['the']);
  });

  test('identifiers stay whole', () => {
    expect(tokenizeQueryTerms('task-1791836412964-8phica')).toEqual([
      'task-1791836412964-8phica',
    ]);
    expect(tokenizeQueryTerms('db-memories.ts')).toEqual(['db-memories.ts']);
  });
});

describe('termOverlap', () => {
  const overlap = (query: string, text: string) =>
    termOverlap(tokenizeQueryTerms(query), text);

  test('matches query words against pieces of a hyphenated/dotted token', () => {
    expect(
      overlap('lxbwjc', 'Merged task-1791836412964-lxbwjc'),
    ).toBeGreaterThan(0);
    expect(overlap('pg-backend', 'in pg-backend.ts')).toBeGreaterThan(0);
    expect(overlap('backend', 'in pg-backend.ts')).toBeGreaterThan(0);
    expect(overlap('creation', 'rule task-creation')).toBeGreaterThan(0);
    expect(overlap('memories', 'see db-memories.ts')).toBeGreaterThan(0);
    expect(
      overlap('1791836412964-lxbwjc', 'task-1791836412964-lxbwjc'),
    ).toBeGreaterThan(0);
    expect(overlap('task-1-abc', 'Tracked in `task-1-abc`')).toBeGreaterThan(0);
  });

  test('does not match prefixes, plurals or unrelated words', () => {
    expect(overlap('release', 'Production releases require a manifest')).toBe(
      0,
    );
    expect(overlap('task-creation', 'task-creationx')).toBe(0);
    expect(overlap('zzzqqq', 'pg-backend.ts')).toBe(0);
  });

  test('stays within 0..1 when several query terms hit one token', () => {
    expect(termOverlap(['pg-backend', 'backend'], 'pg-backend.ts')).toBe(1);
  });
});
