import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { isPathInside, resolveInside } from './path-containment.js';

describe('isPathInside', () => {
  test('a child is inside', () => {
    expect(isPathInside('/srv/root', '/srv/root/a/b.txt')).toBe(true);
  });

  test('the root itself follows allowRoot (default true)', () => {
    expect(isPathInside('/srv/root', '/srv/root')).toBe(true);
    expect(isPathInside('/srv/root/', '/srv/root')).toBe(true);
    expect(isPathInside('/srv/root', '/srv/root', { allowRoot: true })).toBe(
      true,
    );
    expect(isPathInside('/srv/root', '/srv/root', { allowRoot: false })).toBe(
      false,
    );
  });

  test('the parent and its descendants are outside', () => {
    expect(isPathInside('/srv/root', '/srv')).toBe(false);
    expect(isPathInside('/srv/root', '/srv/root/..')).toBe(false);
    expect(isPathInside('/srv/root', '/srv/root/../x')).toBe(false);
  });

  test('a child named `..foo` is inside', () => {
    expect(isPathInside('/srv/root', '/srv/root/..foo')).toBe(true);
    expect(isPathInside('/srv/root', '/srv/root/..foo/bar')).toBe(true);
  });

  test('a sibling sharing the root prefix is outside', () => {
    expect(isPathInside('/srv/root', '/srv/root-evil')).toBe(false);
    expect(isPathInside('/srv/root', '/srv/root-evil/a')).toBe(false);
  });

  test('a filesystem root contains everything below it', () => {
    expect(isPathInside('/', '/etc')).toBe(true);
    expect(isPathInside('/', '/etc/passwd')).toBe(true);
  });

  test('an un-normalized candidate is normalized before the test', () => {
    expect(isPathInside('/srv/root', '/srv/root/a/../../x')).toBe(false);
    expect(isPathInside('/srv/root', '/srv/root/a/../b')).toBe(true);
  });

  test('a non-absolute root or candidate fails closed', () => {
    expect(isPathInside('/srv/root', 'a/b')).toBe(false);
    expect(isPathInside('srv/root', '/srv/root/a')).toBe(false);
    expect(isPathInside('', '/srv/root/a')).toBe(false);
  });
});

describe('resolveInside', () => {
  test('returns the normalized path of a child', () => {
    expect(resolveInside('/srv/root', 'a/./b/../c.txt')).toBe(
      '/srv/root/a/c.txt',
    );
  });

  test('allows the root by default and rejects it with allowRoot false', () => {
    expect(resolveInside('/srv/root', '')).toBe('/srv/root');
    expect(() => resolveInside('/srv/root', '.', { allowRoot: false })).toThrow(
      'Path escapes base directory',
    );
  });

  test('throws on escape', () => {
    expect(() => resolveInside('/srv/root', '../etc/passwd')).toThrow(
      'Path escapes base directory',
    );
    expect(() => resolveInside('/srv/root', '../root-evil/x')).toThrow(
      'Path escapes base directory',
    );
    expect(() => resolveInside('/srv/root', '/etc/passwd')).toThrow(
      'Path escapes base directory',
    );
  });

  test('resolves a relative root against the working directory', () => {
    expect(resolveInside('rel-root', 'a')).toBe(path.resolve('rel-root', 'a'));
  });
});
