/**
 * Tests for resolveSandboxPath — multi-root path validation for fs tools.
 */

import { describe, test, expect } from 'bun:test';
import { resolveSandboxPath } from './sandbox-fs.js';

const PRIMARY = '/workspace/proj-a';

describe('resolveSandboxPath', () => {
  test('returns primary root when no subPath given and no extra roots', () => {
    expect(resolveSandboxPath({ primary: PRIMARY, extra: [] })).toBe(PRIMARY);
  });

  test('throws with root list when no subPath given but extra roots exist', () => {
    let err: Error | undefined;
    try {
      resolveSandboxPath({
        primary: PRIMARY,
        extra: ['/srv/extra-root', '/workspace/shared'],
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain(PRIMARY);
    expect(err!.message).toContain('/srv/extra-root');
    expect(err!.message).toContain('/workspace/shared');
  });

  test('joins relative path to primary root', () => {
    expect(
      resolveSandboxPath({ primary: PRIMARY, extra: [] }, 'src/foo.ts'),
    ).toBe('/workspace/proj-a/src/foo.ts');
  });

  test('accepts absolute path under primary root', () => {
    expect(
      resolveSandboxPath(
        { primary: PRIMARY, extra: [] },
        '/workspace/proj-a/src/foo.ts',
      ),
    ).toBe('/workspace/proj-a/src/foo.ts');
  });

  test('rejects absolute path outside primary when no extra roots', () => {
    expect(() =>
      resolveSandboxPath({ primary: PRIMARY, extra: [] }, '/etc/shadow'),
    ).toThrow(/Unauthorized/);
  });

  test('accepts absolute path under an extra root', () => {
    expect(
      resolveSandboxPath(
        { primary: PRIMARY, extra: ['/srv/extra-root'] },
        '/srv/extra-root/index.php',
      ),
    ).toBe('/srv/extra-root/index.php');
  });

  test('accepts absolute path that exactly equals an extra root', () => {
    expect(
      resolveSandboxPath(
        { primary: PRIMARY, extra: ['/srv/extra-root'] },
        '/srv/extra-root',
      ),
    ).toBe('/srv/extra-root');
  });

  test('rejects path outside both primary and extra roots and lists all roots', () => {
    let err: Error | undefined;
    try {
      resolveSandboxPath(
        { primary: PRIMARY, extra: ['/srv/extra-root', '/workspace/shared'] },
        '/etc/shadow',
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
  });

  test('rejects relative path that escapes primary via ..', () => {
    expect(() =>
      resolveSandboxPath(
        { primary: PRIMARY, extra: ['/srv/extra-root'] },
        '../proj-b/secret',
      ),
    ).toThrow(/Unauthorized/);
  });

  test('rejects absolute path that almost matches a root by prefix (e.g. proj-aa)', () => {
    expect(() =>
      resolveSandboxPath(
        { primary: PRIMARY, extra: [] },
        '/workspace/proj-aaa/foo',
      ),
    ).toThrow(/Unauthorized/);
  });

  test('relative paths only resolve against primary, not extra roots', () => {
    // A relative path joins to primary; even though /srv/extra-root/foo would
    // be an absolute legal target, "foo" only joins to the primary.
    expect(
      resolveSandboxPath(
        { primary: PRIMARY, extra: ['/srv/extra-root'] },
        'foo',
      ),
    ).toBe('/workspace/proj-a/foo');
  });

  test('works with a non-/workspace primary (e.g. /srv/<repo>)', () => {
    const roots = { primary: '/srv/other-primary', extra: [] };
    expect(resolveSandboxPath(roots)).toBe('/srv/other-primary');
    expect(resolveSandboxPath(roots, 'src/index.php')).toBe(
      '/srv/other-primary/src/index.php',
    );
    expect(resolveSandboxPath(roots, '/srv/other-primary/index.php')).toBe(
      '/srv/other-primary/index.php',
    );
    expect(() => resolveSandboxPath(roots, '/etc/shadow')).toThrow(
      /Unauthorized/,
    );
  });
});
