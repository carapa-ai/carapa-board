// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { fileDeepLinkPath, parseFileDeepLink } from './file-deep-link';

describe('parseFileDeepLink', () => {
  it('accepts group and repo files', () => {
    expect(parseFileDeepLink('group:artifacts/plan.md')).toEqual({
      source: 'group',
      path: 'artifacts/plan.md',
    });
    expect(parseFileDeepLink('repo:src/a b.ts')).toEqual({
      source: 'repo',
      path: 'src/a b.ts',
    });
  });

  it('ignores traversal, absolute paths and unknown sources', () => {
    for (const value of ['group:../x', '/etc/passwd', 'foo:bar', 'group:/x'])
      expect(parseFileDeepLink(value)).toBeNull();
    expect(parseFileDeepLink(null)).toBeNull();
  });

  it('round-trips through the link path', () => {
    const path = fileDeepLinkPath(
      'p',
      { source: 'repo', path: 'a b/c.ts' },
      'conv1',
    );
    expect(path).toBe('/chat/p?conversationId=conv1&file=repo%3Aa+b%2Fc.ts');
    expect(
      parseFileDeepLink(new URL(path, 'http://x').searchParams.get('file')),
    ).toEqual({ source: 'repo', path: 'a b/c.ts' });
  });
});
