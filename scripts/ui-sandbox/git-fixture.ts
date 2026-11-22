import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEDIA_FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'media',
);

export const SANDBOX_FIXTURE_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

export const AB_BRANCHES = {
  a: 'ui-ab-variant-a',
  b: 'ui-ab-variant-b',
} as const;

/**
 * The two done variants of an A/B experiment: committed branches that diverge
 * from the current HEAD with different diff sizes, each in its own worktree.
 */
function seedAbVariantBranches(repo: string): void {
  for (const [variant, branch] of Object.entries(AB_BRANCHES)) {
    const worktree = path.join(repo, '.worktrees', branch);
    runFixtureGit(repo, ['worktree', 'add', '-qb', branch, worktree]);
    fs.writeFileSync(
      path.join(worktree, `export-${variant}.txt`),
      `variant ${variant} contribution\n`.repeat(variant === 'a' ? 3 : 8),
    );
    if (variant === 'b') {
      fs.writeFileSync(path.join(worktree, 'export-notes.txt'), 'notes\n');
    }
    runFixtureGit(worktree, ['add', '.']);
    runFixtureGit(worktree, ['commit', '-qm', `variant ${variant}`]);
  }
}

/**
 * Seeds the `ui-ab` repository: a CLEAN default checkout (nothing tracked,
 * modified or untracked; `.worktrees/` ignored) with the two variant branches,
 * so "Merge this variant" passes the box stub's clean-checkout check. Returns
 * the commit the variants forked from.
 */
export function seedCleanAbRepository(repo: string): string {
  fs.mkdirSync(repo, { recursive: true });
  runFixtureGit(repo, ['init', '-q', '-b', 'develop']);
  runFixtureGit(repo, ['config', 'user.email', 'ui-sandbox@example.invalid']);
  runFixtureGit(repo, ['config', 'user.name', 'UI Sandbox']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\n');
  fs.writeFileSync(path.join(repo, 'export.txt'), 'export pipeline\n');
  runFixtureGit(repo, ['add', '.gitignore', 'export.txt']);
  runFixtureGit(repo, ['commit', '-qm', 'seed repository']);
  const forkCommit = runFixtureGit(repo, ['rev-parse', 'HEAD']).trim();
  seedAbVariantBranches(repo);
  return forkCommit;
}

/** Bare "remote" a fixture repository's saved `repositoryUrl` points at. */
export function fixtureRemoteUrl(repo: string): string {
  return `${repo}-remote.git`;
}

export function runFixtureGit(repo: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: path.dirname(repo),
      LANG: 'C',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) {
    throw new Error(
      `UI sandbox Git fixture failed: git ${args.join(' ')}: ${result.stderr.toString()}`,
    );
  }
  return stdout;
}

/**
 * Seeds the shared default-checkout fixture, which is intentionally left dirty
 * so the checkpoint-error paths stay walkable. Returns the commit its A/B
 * variants forked from.
 */
export function seedGitRepository(repo: string): string {
  fs.mkdirSync(repo, { recursive: true });
  runFixtureGit(repo, ['init', '-q', '-b', 'develop']);
  runFixtureGit(repo, ['config', 'user.email', 'ui-sandbox@example.invalid']);
  runFixtureGit(repo, ['config', 'user.name', 'UI Sandbox']);
  fs.mkdirSync(path.join(repo, 'tracked-dir'));
  fs.writeFileSync(
    path.join(repo, 'tracked-dir', 'fixture.txt'),
    'tracked fixture\n',
  );
  fs.writeFileSync(
    path.join(repo, '.gitignore'),
    '.worktrees/\n!.agents/\n!.agents/skills\n',
  );
  seedRepositoryMediaFixtures(repo);
  runFixtureGit(repo, [
    'add',
    '.gitignore',
    'tracked-dir/fixture.txt',
    'fixture-audio.WAV',
    'fixture-image.png',
    'fixture-video.WEBM',
    'fixture-video.mp4',
  ]);
  runFixtureGit(repo, ['commit', '-qm', 'seed repository']);
  const abForkCommit = runFixtureGit(repo, ['rev-parse', 'HEAD']).trim();

  seedAbVariantBranches(repo);

  // Integration tasks and the media conversation diverge from develop with
  // clean owned checkouts. One changes the same tracked line as develop; the
  // others add their own files.
  for (const branch of [
    'ui-merge-clean',
    'ui-merge-conflict',
    'ui-media-conversation',
  ]) {
    const worktree = path.join(repo, '.worktrees', branch);
    runFixtureGit(repo, ['worktree', 'add', '-qb', branch, worktree]);
    fs.writeFileSync(
      path.join(
        worktree,
        branch === 'ui-merge-conflict' ? 'tracked-dir/fixture.txt' : 'task.txt',
      ),
      'task contribution\n',
    );
    runFixtureGit(worktree, ['add', '.']);
    runFixtureGit(worktree, ['commit', '-qm', 'task contribution']);
  }
  fs.writeFileSync(
    path.join(repo, 'tracked-dir/fixture.txt'),
    'default branch update\n',
  );
  fs.writeFileSync(path.join(repo, 'default.txt'), 'new default branch file\n');
  runFixtureGit(repo, ['add', 'tracked-dir/fixture.txt', 'default.txt']);
  runFixtureGit(repo, ['commit', '-qm', 'local default branch update']);

  runFixtureGit(repo, [
    'worktree',
    'add',
    '-qb',
    'ui-symlink-task',
    '.worktrees/ui-symlink-task',
    'HEAD',
  ]);
  const taskWorktree = path.join(repo, '.worktrees', 'ui-symlink-task');
  fs.mkdirSync(path.join(taskWorktree, '.agents'));
  fs.symlinkSync(
    '../tracked-dir',
    path.join(taskWorktree, '.agents', 'skills'),
  );

  // Default-checkout dirt remains intentionally visible and blocks completion.
  fs.symlinkSync('tracked-dir', path.join(repo, 'external-blocker'));
  fs.writeFileSync(
    path.join(repo, 'checkout blocker.txt'),
    'external checkout dirt\n',
  );
  return abForkCommit;
}

function seedRepositoryMediaFixtures(repo: string): void {
  for (const fileName of [
    'fixture-audio.WAV',
    'fixture-video.WEBM',
    'fixture-video.mp4',
  ]) {
    fs.copyFileSync(
      path.join(MEDIA_FIXTURE_DIR, fileName),
      path.join(repo, fileName),
    );
  }
  fs.writeFileSync(path.join(repo, 'fixture-image.png'), SANDBOX_FIXTURE_IMAGE);
}
