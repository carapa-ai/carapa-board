import { describe, expect, test } from 'bun:test';

import {
  fixtureMetadataCommand,
  isAllowedFixtureGitCommand,
} from './box-stub-response.js';

describe('UI sandbox fixture Git allowlist', () => {
  test('accepts only production task diff and blocker inspection commands', () => {
    expect(
      isAllowedFixtureGitCommand(
        '-C .worktrees/ui-symlink-task merge-base develop ui-symlink-task',
      ),
    ).toBe(true);
    expect(
      isAllowedFixtureGitCommand(
        '-C .worktrees/ui-symlink-task diff --no-color 0123456789abcdef0123456789abcdef01234567',
      ),
    ).toBe(true);
    expect(
      isAllowedFixtureGitCommand(
        '-C .worktrees/ui-symlink-task ls-files --others --exclude-standard -z',
      ),
    ).toBe(true);
    expect(
      isAllowedFixtureGitCommand(
        fixtureMetadataCommand('-C .worktrees/ui-symlink-task ', [
          '.agents/skills',
        ]),
      ),
    ).toBe(true);
    expect(
      isAllowedFixtureGitCommand(
        fixtureMetadataCommand('', [
          'checkout blocker.txt',
          'external-blocker',
        ]),
      ),
    ).toBe(true);
    expect(
      isAllowedFixtureGitCommand(
        'status --porcelain=v1 -z --untracked-files=all',
      ),
    ).toBe(true);
    expect(isAllowedFixtureGitCommand('branch --show-current')).toBe(true);
    expect(isAllowedFixtureGitCommand('status --porcelain=v1')).toBe(true);
  });

  test('rejects repository escapes, arbitrary aliases, mutation, and unsafe paths', () => {
    expect(
      isAllowedFixtureGitCommand('-C /workspace/carapa-board status'),
    ).toBe(false);
    expect(
      isAllowedFixtureGitCommand(
        "-c alias.carapa-inspect='!touch escaped' carapa-inspect",
      ),
    ).toBe(false);
    expect(isAllowedFixtureGitCommand('clean -fdx')).toBe(false);
    expect(
      isAllowedFixtureGitCommand(
        '-C .worktrees/ui-symlink-task branch --show-current',
      ),
    ).toBe(false);
    expect(
      isAllowedFixtureGitCommand(
        fixtureMetadataCommand('-C .worktrees/ui-symlink-task ', [
          '../outside',
        ]),
      ),
    ).toBe(false);
    expect(
      isAllowedFixtureGitCommand(
        '-C .worktrees/ui-symlink-task diff --no-color --no-index -- /dev/null ordinary.txt',
      ),
    ).toBe(false);
  });

  describe('merge risk gate commands', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const allowed = [
      "ls-tree --name-only 'develop' -- '.agent/merge-risk.json'",
      "show 'develop:.agent/merge-risk.json'",
      "rev-parse --verify 'refs/heads/ui-ab-variant-b'",
      "rev-parse --verify 'refs/heads/ui-symlink-task'",
      `merge-base 'develop' ${sha}`,
      `diff --name-only --no-renames -z ${sha} ${sha}`,
      `diff -U0 --text --no-ext-diff --no-textconv --no-color --no-renames ${sha} ${sha}`,
      'rev-parse --verify ui-ab-variant-b^{commit}',
      '-C .worktrees/ui-ab-variant-b rev-parse --verify ui-ab-variant-b^{commit}',
      'merge-base develop ui-ab-variant-b',
      'rev-parse develop',
      `diff --no-color ${sha} ${sha}`,
      `diff --no-color --numstat ${sha.slice(0, 7)} ${sha}`,
      fixtureMetadataCommand('-C .worktrees/ui-ab-variant-a ', [
        'export-a.txt',
      ]),
      fixtureMetadataCommand('-C .worktrees/ui-ab-variant-b ', [
        'export-b.txt',
        'export-notes.txt',
      ]),
    ];

    test.each(allowed)('allows %s', (command) => {
      expect(isAllowedFixtureGitCommand(command)).toBe(true);
    });

    const refused = [
      // another path
      "ls-tree --name-only 'develop' -- '.agent/other.json'",
      "ls-tree --name-only 'develop' -- '../.agent/merge-risk.json'",
      "show 'develop:.agent/other.json'",
      // non-fixture branch or default branch
      "rev-parse --verify 'refs/heads/feature'",
      "rev-parse --verify 'refs/heads/ui-ab-variant-b-evil'",
      "ls-tree --name-only 'main' -- '.agent/merge-risk.json'",
      "show 'main:.agent/merge-risk.json'",
      `merge-base 'main' ${sha}`,
      'merge-base develop feature',
      'rev-parse --verify feature^{commit}',
      '-C .worktrees/ui-ab-variant-a rev-parse --verify ui-ab-variant-b^{commit}',
      '-C .worktrees/feature rev-parse --verify feature^{commit}',
      'rev-parse main',
      // non-hex or short SHA
      `merge-base 'develop' ${sha.replace('0', 'g')}`,
      `diff --name-only --no-renames -z ${sha.slice(0, 7)} ${sha}`,
      `diff --name-only --no-renames -z ${sha}z ${sha}`,
      // extra arguments
      "ls-tree --name-only 'develop' -- '.agent/merge-risk.json' extra",
      "rev-parse --verify 'refs/heads/ui-ab-variant-b' --git-dir",
      `merge-base 'develop' ${sha} ${sha}`,
      `diff --name-only --no-renames -z ${sha} ${sha} -- 'src/a.ts'`,
      `diff -U0 --text --no-ext-diff --no-textconv --no-color --no-renames ${sha} ${sha} --output=/tmp/x`,
      'rev-parse --verify ui-ab-variant-b^{commit} --git-dir',
      // injection
      "ls-tree --name-only 'develop' -- '.agent/merge-risk.json'; touch escaped",
      "show 'develop:.agent/merge-risk.json' | sh",
      `merge-base 'develop' ${sha}$(touch escaped)`,
      `merge-base 'develop' ${sha};touch escaped`,
      'rev-parse --verify $(touch escaped)^{commit}',
      "rev-parse --verify 'refs/heads/ui-ab-variant-b'; touch escaped",
      'rev-parse develop; touch escaped',
      `${allowed[0]}\n`,
      // merged diff and variant metadata neighbours
      `diff --no-color ${sha} ${sha} extra`,
      `diff --no-color ${sha}\n${sha}`,
      `diff --no-color --output=/tmp/x ${sha} ${sha}`,
      `diff --no-color ${sha}z ${sha}`,
      `diff --no-color ${sha} ${sha}; touch escaped`,
      fixtureMetadataCommand('-C .worktrees/ui-ab-variant-a ', [
        'export-b.txt',
      ]),
      fixtureMetadataCommand('-C .worktrees/ui-ab-variant-b ', ['../outside']),
      fixtureMetadataCommand('-C .worktrees/ui-ab-variant-b ', [
        'export-notes.txt',
        'export-b.txt',
      ]),
    ];

    test.each(refused)('refuses %s', (command) => {
      expect(isAllowedFixtureGitCommand(command)).toBe(false);
    });
  });
});
