import { describe, expect, test } from 'bun:test';
import { isSafeRepositoryUrl, isValidGitBranchName } from './git-ref-name.js';

describe('isValidGitBranchName', () => {
  test.each(['develop', 'feature/a-b', 'release-1.2'])('accepts %j', (name) => {
    expect(isValidGitBranchName(name)).toBe(true);
  });

  test.each([
    '',
    'bad branch name..',
    '-x',
    'a..b',
    'a b',
    'x.lock',
    'a/x.lock/b',
    '/x',
    'x/',
    'x.',
    'a//b',
    'a/.b',
    '@',
    'a@{b',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a\u0007b',
  ])('rejects %j', (name) => {
    expect(isValidGitBranchName(name)).toBe(false);
  });
});

describe('isSafeRepositoryUrl', () => {
  test.each([
    'https://github.com/o/r',
    'git@github.com:o/r.git',
    '/home/user/repo',
  ])('accepts %j', (url) => {
    expect(isSafeRepositoryUrl(url)).toBe(true);
  });

  test.each(['not a url', 'https://x\n', 'a\tb', '-oProxyCommand=x'])(
    'rejects %j',
    (url) => {
      expect(isSafeRepositoryUrl(url)).toBe(false);
    },
  );
});
