import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { RegisteredGroup } from '../types.js';
import {
  appendUntrackedDiffFromList,
  getDefaultCheckoutBlockers,
  getWorkingTreeDiff,
} from './git-ops.js';

let repo = '';
let externalRoot = '';
const group = { folder: 'symlink-diff-test', settings: {} } as RegisteredGroup;

const gitEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? tmpdir(),
  LANG: 'C',
};

function git(args: string[], cwd = repo): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

const runLocalGit = async (
  _group: RegisteredGroup,
  command: string,
  _instance?: string | null,
  options?: { okIfStdoutMatches?: RegExp },
) => {
  const result = spawnSync('sh', ['-c', `git ${command}`], {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  });
  const output = result.stdout || '';
  return {
    ok: result.status === 0 || !!options?.okIfStdoutMatches?.test(output),
    output,
  };
};

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'carapa-symlink-diff-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Carapa Test']);
  mkdirSync(path.join(repo, 'tracked-dir'));
  writeFileSync(path.join(repo, 'tracked-dir', 'tracked.txt'), 'tracked\n');
  writeFileSync(path.join(repo, 'deleted-after-commit.txt'), 'deleted\n');
  writeFileSync(path.join(repo, '.gitignore'), 'ignored-link\n');
  git([
    'add',
    '.gitignore',
    'tracked-dir/tracked.txt',
    'deleted-after-commit.txt',
  ]);
  git(['commit', '-qm', 'base']);

  rmSync(path.join(repo, 'deleted-after-commit.txt'));
  mkdirSync(path.join(repo, '.agents'));
  mkdirSync(path.join(repo, 'untracked-dir'));
  writeFileSync(
    path.join(repo, 'untracked-dir', 'secret.txt'),
    'UNTRACKED_DIRECTORY_SECRET\n',
  );
  externalRoot = mkdtempSync(path.join(tmpdir(), 'carapa-external-link-'));
  writeFileSync(
    path.join(externalRoot, 'secret.txt'),
    'EXTERNAL_TARGET_SECRET\n',
  );
  symlinkSync('../tracked-dir', path.join(repo, '.agents', 'skills'));
  symlinkSync('untracked-dir', path.join(repo, 'untracked-dir-link'));
  symlinkSync('missing-target', path.join(repo, 'dangling-link'));
  symlinkSync('tracked-dir/tracked.txt', path.join(repo, 'file-link'));
  symlinkSync(externalRoot, path.join(repo, 'external-link'));
  symlinkSync('tracked-dir', path.join(repo, 'ignored-link'));
  symlinkSync(
    'tracked-dir',
    path.join(repo, "link with 'quote';$(touch should-not-exist)"),
  );
  symlinkSync('tracked-dir', path.join(repo, 'line\nbreak'));
  writeFileSync(path.join(repo, 'ordinary.txt'), 'ordinary text\n');
  writeFileSync(path.join(repo, 'odd name;still-safe.txt'), 'odd text\n');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(externalRoot, { recursive: true, force: true });
});

describe('untracked symlink diff inspection', () => {
  test('renders link targets without traversing any target and keeps every other row', async () => {
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
    const commands: string[] = [];
    const result = await appendUntrackedDiffFromList(
      group,
      undefined,
      '',
      '',
      [],
      untracked,
      200,
      async (...args) => {
        commands.push(args[1]);
        return runLocalGit(...args);
      },
    );

    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.agents/skills',
          kind: 'symlink',
          linkTarget: '../tracked-dir',
        }),
        expect.objectContaining({
          path: 'untracked-dir-link',
          kind: 'symlink',
          linkTarget: 'untracked-dir',
        }),
        expect.objectContaining({
          path: 'dangling-link',
          kind: 'symlink',
          linkTarget: 'missing-target',
        }),
        expect.objectContaining({
          path: 'file-link',
          kind: 'symlink',
          linkTarget: 'tracked-dir/tracked.txt',
        }),
        expect.objectContaining({
          path: 'external-link',
          kind: 'symlink',
          linkTarget: expect.stringContaining('carapa-external-link-'),
        }),
        expect.objectContaining({ path: 'ordinary.txt', kind: 'file' }),
        expect.objectContaining({
          path: 'odd name;still-safe.txt',
          kind: 'file',
        }),
        expect.objectContaining({
          path: "link with 'quote';$(touch should-not-exist)",
          kind: 'symlink',
          linkTarget: 'tracked-dir',
        }),
        expect.objectContaining({
          path: 'line\nbreak',
          kind: 'symlink',
          linkTarget: 'tracked-dir',
          renderError: expect.stringContaining('line-breaking'),
        }),
      ]),
    );
    expect(result.files.some((file) => file.path === 'ignored-link')).toBe(
      false,
    );
    expect(existsSync(path.join(repo, 'should-not-exist'))).toBe(false);
    expect(result.patch).toContain('new file mode 120000');
    expect(result.patch).toContain('+../tracked-dir');
    expect(result.patch).toContain('+ordinary text');
    expect(result.patch).not.toContain('untracked-dir-link/secret.txt');
    expect(result.patch).not.toContain('EXTERNAL_TARGET_SECRET');
    expect(result.patch).not.toContain('line\nbreak');
    const diffCommands = commands.filter((command) =>
      command.includes('diff --no-color --no-index'),
    );
    expect(diffCommands).toHaveLength(3);
    expect(
      diffCommands.some(
        (command) =>
          command.includes("'ordinary.txt'") &&
          command.includes("'odd name;still-safe.txt'"),
      ),
    ).toBe(false);
  });

  test('reports exact default-checkout blockers while ignored links remain absent', async () => {
    const blockers = await getDefaultCheckoutBlockers(
      group,
      undefined,
      runLocalGit,
    );

    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.agents/skills',
          status: '??',
          source: 'default-checkout-blocker',
          kind: 'symlink',
          linkTarget: '../tracked-dir',
        }),
        expect.objectContaining({
          path: 'odd name;still-safe.txt',
          status: '??',
        }),
        expect.objectContaining({
          path: "link with 'quote';$(touch should-not-exist)",
          status: '??',
          kind: 'symlink',
          linkTarget: 'tracked-dir',
        }),
      ]),
    );
    expect(blockers.some((file) => file.path === 'ignored-link')).toBe(false);
  });

  test('keeps an isolated worktree symlink in task-attributable scope', async () => {
    mkdirSync(path.join(repo, '.worktrees'), { recursive: true });
    git([
      'worktree',
      'add',
      '-qb',
      'task-link',
      '.worktrees/task-link',
      'HEAD',
    ]);
    symlinkSync(
      '../tracked-dir',
      path.join(repo, '.worktrees', 'task-link', 'task-link'),
    );
    const untracked = git(
      ['ls-files', '--others', '--exclude-standard', '-z'],
      path.join(repo, '.worktrees', 'task-link'),
    );

    const result = await appendUntrackedDiffFromList(
      group,
      undefined,
      '-C .worktrees/task-link ',
      '',
      [],
      untracked,
      200,
      runLocalGit,
    );

    expect(result.files).toContainEqual(
      expect.objectContaining({
        path: 'task-link',
        kind: 'symlink',
        linkTarget: '../tracked-dir',
      }),
    );
  });
});

describe('initial working-tree diff', () => {
  test('shows staged edits and untracked files before the first commit without mutating Git', async () => {
    const initialRepo = mkdtempSync(
      path.join(tmpdir(), 'carapa-initial-diff-'),
    );
    const runGit = async (
      _group: RegisteredGroup,
      command: string,
      _instance?: string | null,
      options?: { okIfStdoutMatches?: RegExp },
    ) => {
      const result = spawnSync('sh', ['-c', `git ${command}`], {
        cwd: initialRepo,
        encoding: 'utf8',
        env: gitEnv,
      });
      const output = result.stdout || result.stderr || '';
      return {
        ok: result.status === 0 || !!options?.okIfStdoutMatches?.test(output),
        output,
      };
    };
    try {
      expect(
        (await getWorkingTreeDiff(group, undefined, runGit))?.repositoryState,
      ).toBe('not-initialized');
      git(['init', '--initial-branch=develop'], initialRepo);
      writeFileSync(path.join(initialRepo, '.gitignore'), 'secret.txt\n');
      writeFileSync(path.join(initialRepo, 'secret.txt'), 'DO_NOT_INCLUDE\n');
      writeFileSync(path.join(initialRepo, 'staged.txt'), 'old version\n');
      git(['add', 'staged.txt'], initialRepo);
      writeFileSync(path.join(initialRepo, 'staged.txt'), 'current version\n');
      writeFileSync(path.join(initialRepo, 'untracked.txt'), 'new file\n');
      const before = git(['status', '--porcelain'], initialRepo);
      const diff = await getWorkingTreeDiff(group, undefined, runGit);
      expect(diff?.repositoryState).toBe('unborn');
      expect(diff?.branch).toBe('develop');
      expect(diff?.files.map((file) => file.path).sort()).toEqual([
        '.gitignore',
        'staged.txt',
        'untracked.txt',
      ]);
      expect(diff?.patch).toContain('+current version');
      expect(diff?.patch).toContain('+new file');
      expect(diff?.patch).not.toContain('DO_NOT_INCLUDE');
      expect(git(['status', '--porcelain'], initialRepo)).toBe(before);
      expect(git(['show', ':staged.txt'], initialRepo)).toBe('old version\n');
      git(
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-m',
          'Initial commit',
        ],
        initialRepo,
      );
      expect(
        (await getWorkingTreeDiff(group, undefined, runGit))?.repositoryState,
      ).toBeUndefined();
      const failed = await getWorkingTreeDiff(group, undefined, async () => ({
        ok: false,
        output: 'Sandbox unavailable',
      }));
      expect(failed).toBeNull();
    } finally {
      rmSync(initialRepo, { recursive: true, force: true });
    }
  });
});
