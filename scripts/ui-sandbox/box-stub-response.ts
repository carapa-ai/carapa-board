import path from 'node:path';
import { createHash } from 'node:crypto';

import { shellQuote } from '../../src/utils.js';
import { AB_BRANCHES, fixtureRemoteUrl } from './git-fixture.js';

// Simulated publications only: this fixture never opens a network port.
const appPublications = new Map<string, Record<string, unknown>>();
const readResults: Record<string, string> = {
  sandbox_status: '[]',
  sandbox_ps: '[]',
  sandbox_versions: '{}',
};

/** UI_SANDBOX_BUILD_FORCE_FAIL accepts 1/true/yes (case-insensitive). */
function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes)$/i.test(value.trim());
}

/**
 * Repository behind a fixture instance. `ui-ab` owns a clean default checkout
 * (UI_SANDBOX_AB_GIT_REPO); `ui-running` and `ui-ab-dirty` share the
 * intentionally dirty one (UI_SANDBOX_GIT_REPO).
 */
function fixtureGitRepo(args: Record<string, unknown>): string | null {
  const instance = typeof args.instance === 'string' ? args.instance : '';
  if (
    /^ui-ab-dirty(?:-|$)/.test(instance) ||
    /^ui-running(?:-|$)/.test(instance)
  )
    return process.env.UI_SANDBOX_GIT_REPO ?? null;
  if (/^ui-ab(?:-|$)/.test(instance))
    return process.env.UI_SANDBOX_AB_GIT_REPO ?? null;
  return null;
}

const FIXTURE_AB_BRANCHES: readonly string[] = Object.values(AB_BRANCHES);

/** Variant checkpoints commit in their own worktree; all others use the symlink one. */
function fixtureCommitWorktree(args: Record<string, unknown>): string {
  return typeof args.branch === 'string' &&
    FIXTURE_AB_BRANCHES.includes(args.branch)
    ? `.worktrees/${args.branch}`
    : FIXTURE_WORKTREE;
}

const FIXTURE_WORKTREE = '.worktrees/ui-symlink-task';
const fixtureBranches = [
  'ui-symlink-task',
  'ui-merge-clean',
  'ui-merge-conflict',
  'ui-media-conversation',
  ...Object.values(AB_BRANCHES),
];

const fixtureMediaPaths = [
  'fixture-audio.WAV',
  'fixture-image.png',
  'fixture-video.WEBM',
  'fixture-video.mp4',
] as const;

function fixtureRepoPageCommand(worktreeDirectory?: string): string {
  const directory = '';
  const limit = 50;
  const offset = 0;
  const pathspec = directory || '.';
  const worktree = worktreeDirectory
    ? `-C ${shellQuote(worktreeDirectory)} `
    : '';
  const script = `if [ ${shellQuote(pathspec)} != '.' ] && ! test -d ${shellQuote(pathspec)}; then echo __INVALID_DIRECTORY__; exit 2; fi; { git ls-files --cached --others --exclude-standard -- ${shellQuote(pathspec)} | sed 's/^/0\\t/'; git ls-files --others --ignored --exclude-standard -- ${shellQuote(pathspec)} | sed 's/^/1\\t/'; } | awk -F '\\t' -v d=${shellQuote(directory)} '{ p=$2; if (d != "") p=substr(p,length(d)+2); n=split(p,a,"/"); kind=n>1 ? "directory" : "file"; name=a[1]; full=d != "" ? d "/" name : name; if (!(full in seen) || kind == "directory") { seen[full]=1; ignored[full]=($1 == "1" && kind == "file"); kinds[full]=kind; names[full]=name } } END { for (full in seen) print (kinds[full] == "directory" ? "0" : "1") "\\t" names[full] "\\t" full "\\t" ignored[full] }' | sort -t $'\\t' -k1,1 -k2,2 | awk -F '\\t' 'NR > ${offset} && NR <= ${offset + limit + 1} { print }'`;
  return `${worktree}-c alias.carapa-file-explorer=${shellQuote(`!${script}`)} carapa-file-explorer`;
}

function fixtureMediaContentCommand(
  worktreeDirectory: string | undefined,
  operation: 'show' | 'size',
  fileName: (typeof fixtureMediaPaths)[number],
): string {
  const worktree = worktreeDirectory
    ? `-C ${shellQuote(worktreeDirectory)} `
    : '';
  const ref = shellQuote(`HEAD:${fileName}`);
  return operation === 'show'
    ? `${worktree}show ${ref} | base64 -w 0`
    : `${worktree}cat-file -s ${ref}`;
}

function isAllowedFixtureMediaRepoCommand(command: string): boolean {
  for (const worktree of [undefined, '.worktrees/ui-media-conversation']) {
    if (command === fixtureRepoPageCommand(worktree)) return true;
    for (const fileName of fixtureMediaPaths) {
      if (
        command === fixtureMediaContentCommand(worktree, 'show', fileName) ||
        command === fixtureMediaContentCommand(worktree, 'size', fileName)
      ) {
        return true;
      }
    }
  }
  return false;
}

// Fingerprints of the reviewed production shell aliases in task-default-branch.ts:
// status, merge, receipt recovery, receipt cleanup. Normalize only hex object IDs,
// receipt UUIDs and the fixed fixture branch names; every other byte must match.
// Merely allowing the alias name would allow arbitrary shell/filesystem access.
// A production script change intentionally fails closed until re-verified here.
const defaultBranchCommands = new Set([
  '22cd4414ebb8b1addf1f0e2c0f2bf376f962b90aa7201bcf3de6b501ffdea300',
  '18c27bb121cf3d624233fcef6c9c1d9e4431aa3c37d06371d335f9e4c25b8a77',
  'b2791a5bd57b3363a68ded3d529b4a89501d2164ba6e0db880bb354e95a043ab',
  '7486364376bfe7bf351fb185c025787b382ecd8e07f9cb13dd90ebda51d598a9',
]);

function isDefaultBranchCommand(command: string): boolean {
  const normalized = command
    .replace(
      /carapa-default-branch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      'carapa-default-branch-RECEIPT',
    )
    .replace(/\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b/g, 'COMMIT')
    .replace(
      /ui-(?:merge-clean|merge-conflict|symlink-task)/g,
      'FIXTURE_BRANCH',
    );
  return defaultBranchCommands.has(
    createHash('sha256').update(normalized).digest('hex'),
  );
}
export function fixtureMetadataCommand(
  gitPrefix: string,
  fixturePaths: string[],
): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const script = fixturePaths
    .map((fixturePath) => {
      const quotedPath = quote(fixturePath);
      return `if [ -L ${quotedPath} ]; then printf 'symlink\\0'; readlink -n -- ${quotedPath}; printf '\\0'; elif [ -e ${quotedPath} ]; then printf 'file\\0\\0'; else printf 'missing\\0\\0'; fi`;
    })
    .join('; ');
  return `${gitPrefix}-c alias.carapa-inspect=${quote(`!${script}`)} carapa-inspect`;
}

/**
 * The default-branch sync row (Changes tab): its local-only status reads, the
 * shared-checkout diff it is shown beside, and fetch/pull/push against the
 * fixture's own bare remote. Exact production command shapes only.
 */
function isAllowedFixtureSyncCommand(command: string): boolean {
  const local = 'refs/heads/develop';
  const tracking = 'refs/remotes/carapa-sync/develop';
  const remotes = [
    process.env.UI_SANDBOX_GIT_REPO,
    process.env.UI_SANDBOX_AB_GIT_REPO,
  ]
    .filter((repo): repo is string => !!repo)
    .map(fixtureRemoteUrl);
  const exact = new Set([
    'diff --no-color HEAD',
    'diff --no-color --numstat HEAD',
    'ls-files --others --exclude-standard -z',
    'symbolic-ref --quiet HEAD',
    'status --porcelain=v1 --untracked-files=all',
    `for-each-ref --format='%(refname)' ${shellQuote(local)} ${shellQuote(tracking)}`,
    `rev-list --left-right --count ${shellQuote(`${local}...${tracking}`)}`,
    `merge --ff-only ${shellQuote(tracking)}`,
    `rev-parse --verify ${shellQuote(`${local}^{commit}`)}`,
    ...remotes.map(
      (url) =>
        `fetch --no-tags -- ${shellQuote(url)} ${shellQuote(`+${local}:${tracking}`)}`,
    ),
  ]);
  if (exact.has(command)) return true;
  const sha = '[0-9a-f]{40}';
  return (
    new RegExp(`^update-ref ${shellQuote(tracking)} '${sha}'$`).test(command) ||
    remotes.some((url) =>
      new RegExp(
        `^push -- ${shellQuote(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} '${sha}:${local}'$`,
      ).test(command),
    )
  );
}

/**
 * Read-only commands of the merge risk gate (merge-risk-gate.ts) and of the
 * merge path around it (git-ops.ts), for fixture branches only. The fixture
 * repositories carry no `.agent/merge-risk.json`, so the gate ends after its
 * `ls-tree` probe; the later gate commands stay allowed so its other branches
 * remain runnable. Exact production command shapes only: the default branch is
 * `develop`, refs are fixture branches, object IDs are 40 hex digits and the
 * only path is the rules file. The per-file diff (`-- <path>`) is not allowed.
 */
function isAllowedFixtureMergeRiskCommand(command: string): boolean {
  const rules = shellQuote('.agent/merge-risk.json');
  const exact = new Set([
    `ls-tree --name-only ${shellQuote('develop')} -- ${rules}`,
    `show ${shellQuote('develop:.agent/merge-risk.json')}`,
    'rev-parse develop',
    ...fixtureBranches.flatMap((branch) => [
      `rev-parse --verify ${shellQuote(`refs/heads/${branch}`)}`,
      `rev-parse --verify ${branch}^{commit}`,
      `-C .worktrees/${branch} rev-parse --verify ${branch}^{commit}`,
      `merge-base develop ${branch}`,
    ]),
  ]);
  if (exact.has(command)) return true;
  const sha = '[0-9a-f]{40}';
  return [
    `merge-base ${shellQuote('develop')} ${sha}`,
    `diff --name-only --no-renames -z ${sha} ${sha}`,
    `diff -U0 --text --no-ext-diff --no-textconv --no-color --no-renames ${sha} ${sha}`,
  ].some((pattern) => new RegExp(`^${pattern}$`).test(command));
}

// Symlink inspection of the changed files in each A/B variant worktree (the
// task Changes tab); the paths are the files seeded by git-fixture.ts.
const abVariantMetadataCommands = new Set([
  fixtureMetadataCommand(`-C .worktrees/${AB_BRANCHES.a} `, ['export-a.txt']),
  fixtureMetadataCommand(`-C .worktrees/${AB_BRANCHES.b} `, [
    'export-b.txt',
    'export-notes.txt',
  ]),
]);

export function isAllowedFixtureGitCommand(command: string): boolean {
  if (isAllowedFixtureSyncCommand(command)) return true;
  if (isAllowedFixtureMergeRiskCommand(command)) return true;
  if (isAllowedFixtureMediaRepoCommand(command)) return true;
  if (isDefaultBranchCommand(command)) return true;
  if (
    command ===
      fixtureMetadataCommand(`-C ${FIXTURE_WORKTREE} `, ['.agents/skills']) ||
    command ===
      fixtureMetadataCommand('-C .worktrees/ui-merge-clean ', ['task.txt']) ||
    command ===
      fixtureMetadataCommand('-C .worktrees/ui-merge-conflict ', [
        'tracked-dir/fixture.txt',
      ]) ||
    command ===
      fixtureMetadataCommand('-C .worktrees/ui-merge-conflict ', [
        'default.txt',
        'tracked-dir/fixture.txt',
      ]) ||
    command ===
      fixtureMetadataCommand('', [
        'checkout blocker.txt',
        'external-blocker',
      ]) ||
    abVariantMetadataCommands.has(command)
  ) {
    return true;
  }
  const args = command.trim().split(/\s+/).filter(Boolean);
  let offset = 0;
  if (args[0] === '-C') {
    if (!fixtureBranches.some((branch) => args[1] === `.worktrees/${branch}`))
      return false;
    offset = 2;
  }
  const scoped = args.slice(offset);
  const exact = (...expected: string[]) =>
    scoped.length === expected.length &&
    scoped.every((value, index) => value === expected[index]);

  if (exact('branch', '--show-current') || exact('status', '--porcelain=v1')) {
    return offset === 0;
  }
  if (exact('status', '--porcelain=v1', '-z', '--untracked-files=all')) {
    return offset === 0;
  }
  if (
    fixtureBranches.some((branch) => exact('merge-base', 'develop', branch))
  ) {
    return offset === 2 && args[1] === `.worktrees/${scoped[2]}`;
  }
  if (exact('ls-files', '--others', '--exclude-standard', '-z')) {
    return offset === 2;
  }
  // Merged task diff (tasks.ts): recorded base and merge commit, no worktree.
  if (
    /^diff --no-color (?:--numstat )?[0-9a-f]{7,40} [0-9a-f]{7,40}$/.test(
      command,
    )
  )
    return true;
  if (
    scoped[0] === 'diff' &&
    scoped[1] === '--no-color' &&
    (scoped.length === 3 ||
      (scoped.length === 4 && scoped[2] === '--numstat')) &&
    /^[0-9a-f]{7,40}$/.test(scoped.at(-1) ?? '')
  ) {
    return offset === 2;
  }
  return false;
}

function runFixtureGit(
  repo: string,
  command: string,
): {
  stdout: string;
  isError: boolean;
} {
  const result = Bun.spawnSync(['sh', '-c', `git ${command}`], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: path.dirname(repo),
      LANG: 'C',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: result.stdout.toString() || result.stderr.toString(),
    isError: result.exitCode !== 0,
  };
}

/**
 * Tool responses for the disposable UI sandbox CarapaBox stub.
 *
 * `build_service` and `restart_service` are the two lifecycle tools the
 * server/web build + restart flow needs. Builds are simulated with a
 * configurable delay so the UI's "building" window is observable. Restarts
 * delegate to the sandbox control endpoint (see start.ts), which really
 * re-spawns the backend process so `started_at` genuinely changes.
 *
 * `UI_SANDBOX_BUILD_FORCE_FAIL` makes `build_service` report a failure
 * instead, so the failed-build UI (failure feedback, no enabled Restart)
 * can be exercised end to end in the browser.
 */
export async function boxStubToolResponse(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<Response> {
  if (
    tool === 'sandbox_publish_app' &&
    typeof args.instance === 'string' &&
    args.instance.startsWith('ui-')
  ) {
    const key = JSON.stringify([args.name, args.instance, args.id]);
    if (args.action === 'publish')
      appPublications.set(key, {
        enabled: true,
        ready: true,
        targetPort: args.targetPort,
        hostname: args.hostname,
        url: 'https://app.ui-sandbox.invalid/',
      });
    else if (args.action === 'unpublish') appPublications.delete(key);
    else if (args.action !== 'status')
      return Response.json({ result: 'Invalid fixture action', isError: true });
    return Response.json({
      result: JSON.stringify(
        appPublications.get(key) ?? { enabled: false, ready: false },
      ),
      isError: false,
    });
  }
  if (tool in readResults) {
    return Response.json({ result: readResults[tool], isError: false });
  }
  const repo = fixtureGitRepo(args);
  if (tool === 'sandbox_git' && repo) {
    const command = typeof args.command === 'string' ? args.command : '';
    if (!isAllowedFixtureGitCommand(command)) {
      return Response.json({
        result: 'UI sandbox: fixture Git command is not allowed.',
        isError: true,
      });
    }
    const result = runFixtureGit(repo, command);
    return Response.json({ result: result.stdout, isError: result.isError });
  }
  if (tool === 'sandbox_branch' && repo) {
    const action = typeof args.action === 'string' ? args.action : '';
    if (action === 'inspect') {
      return Response.json({
        result: JSON.stringify({ repositories: [] }),
        isError: false,
      });
    }
    if (action === 'commit') {
      const worktree = fixtureCommitWorktree(args);
      const staged = runFixtureGit(repo, `-C ${worktree} add -A`);
      if (staged.isError) {
        return Response.json({ result: staged.stdout, isError: true });
      }
      const committed = runFixtureGit(
        repo,
        `-C ${worktree} commit -m 'feat: committed task symlink'`,
      );
      return Response.json({
        result: committed.stdout,
        isError: committed.isError,
      });
    }
    if (action === 'merge') {
      const status = runFixtureGit(
        repo,
        'status --porcelain=v1 -z --untracked-files=all',
      );
      return status.stdout
        ? Response.json({
            result: '[env] default checkout is dirty',
            isError: true,
          })
        : Response.json({
            result: JSON.stringify({ merged: true }),
            isError: false,
          });
    }
  }
  if (tool === 'build_service') {
    const delayMs = Number(process.env.UI_SANDBOX_BUILD_DELAY_MS ?? 5000);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await Bun.sleep(delayMs);
    }
    if (isTruthyEnv(process.env.UI_SANDBOX_BUILD_FORCE_FAIL)) {
      return Response.json({
        result: [
          ...Array.from(
            { length: 40 },
            (_, i) => `#${i + 1} RUN simulated build step ${i + 1}`,
          ),
          `UI sandbox: simulated ${String(
            args.name ?? 'service',
          )} build failed (UI_SANDBOX_BUILD_FORCE_FAIL)`,
        ].join('\n'),
        isError: true,
      });
    }
    return Response.json({
      result: `UI sandbox: simulated ${String(args.name ?? 'service')} build succeeded`,
      isError: false,
    });
  }
  if (tool === 'restart_service') {
    const controlUrl = process.env.UI_SANDBOX_CONTROL_URL;
    if (!controlUrl) {
      return Response.json(
        {
          result:
            'UI sandbox: restart_service has no control endpoint configured.',
          isError: true,
        },
        { status: 503 },
      );
    }
    try {
      const response = await fetch(`${controlUrl}/restart-board`, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = await response.text();
        return Response.json(
          {
            result: `UI sandbox: control restart failed: ${body}`,
            isError: true,
          },
          { status: 500 },
        );
      }
      return Response.json({
        result: `UI sandbox: restarted ${String(args.name ?? 'service')}`,
        isError: false,
      });
    } catch (error) {
      return Response.json(
        {
          result: `UI sandbox: control restart failed: ${String(error)}`,
          isError: true,
        },
        { status: 500 },
      );
    }
  }
  return Response.json(
    {
      result: `UI sandbox: ${tool} requires CarapaBox and is unavailable.`,
      isError: true,
    },
    { status: 503 },
  );
}
