import { getActiveRunForTask } from '../db.js';
import { COMMIT_SHA_PATTERN } from './git-commit.js';
/**
 * Git operations helpers — branch checkout, commit, merge, and worktree management.
 *
 * All git commands run via CarapaBox sandbox_git (never on the host filesystem).
 */
import type { RegisteredGroup } from '../types.js';
import {
  effectiveGitArgs,
  effectiveOperationInstance,
  effectiveRemoteUrl,
  resolveEffectiveSandbox,
} from '../sandbox/effective-settings.js';
import type { Task } from '../modules/kanban/types.js';
import type { MergeFinding } from '../modules/proposals/actions.js';
import {
  ConversationWorktreeInUseError,
  getTask,
  transitionConversationsFromRemovedWorktree,
  updateTask,
} from '../db.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import { appendTaskMessage } from '../modules/transcripts/transcript-store.js';
import { logger } from '../logger.js';
import { shellQuote, slugify } from '../utils.js';
import { getSandboxClient } from './mcp-client.js';
import { mapWithConcurrency, sleep, withTimeout } from './async.js';
import {
  acquireSharedCheckoutLease,
  CheckoutBusyError,
} from '../concurrency/shared-checkout-lease.js';

// ---------------------------------------------------------------------------
// Branch naming
// ---------------------------------------------------------------------------

export function getBranchNameForTask(task: Task): string {
  // Once a branch has been derived it is persisted on the task and reused for
  // every subsequent run (restart, testing stage, deploy), so the suffix below is
  // only ever computed once per task.
  if (task.branch_name) return task.branch_name;

  // Git rejects branch names that start with `-` and ref files are limited to
  // 255 bytes, so strip edge separators and cap the slug length.
  const trimEdges = (s: string) => s.replace(/^[-_]+|[-_]+$/g, '');
  const base = trimEdges(trimEdges(slugify(task.title)).slice(0, 60));

  // Append the task id's stable random suffix (task-<ts>-<rand> → <rand>) so two
  // distinct tasks with the same title—including occurrences of one cronjob—
  // never derive the same branch. Otherwise they would share one worktree and
  // leak changes into each other's runs. Deterministic per task, so restarts
  // resolve to the identical name and reuse the existing worktree.
  const suffix = task.id.slice(-6);

  // Slug too short/invalid to be a useful prefix → the (already unique) id alone.
  if (base.length < 3) return task.id;

  return `${base}-${suffix}`;
}
export function taskCheckoutMode(
  group: RegisteredGroup,
): 'shared' | 'branch' | 'worktree' {
  const mode = group.settings?.taskCheckoutMode;
  return mode === 'branch' || mode === 'worktree' ? mode : 'shared';
}

export function taskUsesBranch(group: RegisteredGroup): boolean {
  return taskCheckoutMode(group) !== 'shared';
}

export function taskUsesWorktree(group: RegisteredGroup): boolean {
  return taskCheckoutMode(group) === 'worktree';
}

// ---------------------------------------------------------------------------
// Instance validation
// ---------------------------------------------------------------------------

/**
 * Validate a task's sandbox_instance before using it for git ops.
 * Returns undefined if the value looks like an agent executable (e.g. "claude", "agent")
 * or service name rather than a proper group folder / instance name.
 */
export function validatedInstance(
  task: Task,
  group: RegisteredGroup,
): string | undefined {
  const raw = task.sandbox_instance || undefined;
  if (!raw) return undefined;
  // Agent executables contain dots; "agent" is the default service name — neither is valid as instance
  if (raw.includes('.') || raw === 'agent' || raw === 'php84') {
    logger.warn(
      { task_id: task.id, sandbox_instance: raw, group_folder: group.folder },
      'Task sandbox_instance looks invalid (agent/service name?) — falling back to group folder',
    );
    return group.folder;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Low-level git execution
// ---------------------------------------------------------------------------

const GIT_LOG_OUTPUT_MAX = 500;

/**
 * Per-call timeout for a single `sandbox_git` MCP invocation. Generous on
 * purpose: a worktree diff with a large untracked set (e.g. 200 files batched
 * into one call) is still well under this. Tune via RUN_GIT_TIMEOUT_MS.
 * Default 60s; the previous behavior was unbounded MCP round-trips, which
 * could leave an HTTP worker waiting on a stuck sandbox indefinitely.
 */
const RUN_GIT_TIMEOUT_MS = parseInt(
  process.env.RUN_GIT_TIMEOUT_MS ?? '60000',
  10,
);

/** Keep git stdout out of info logs — ls-files/diff can be huge. */
function gitStdoutLogFields(
  stdout: string | undefined,
  includeBody: boolean,
): Record<string, unknown> {
  const text = stdout?.trim() ?? '';
  if (!text) return {};
  const fields: Record<string, unknown> = { outputBytes: text.length };
  if (!includeBody) return fields;
  if (text.length <= GIT_LOG_OUTPUT_MAX) {
    fields.output = text;
    return fields;
  }
  fields.outputPreview = `${text.slice(0, GIT_LOG_OUTPUT_MAX)}…`;
  return fields;
}

/**
 * Run a git command against a project repo via CarapaBox sandbox_git.
 * The board runs in its own container without the project repo mounted,
 * so git always runs inside the sandbox container where the code lives.
 * `instance` is the sandbox instance name (e.g. "carapa-board", "carapa-board-1").
 */
export async function runGitInRepo(
  group: RegisteredGroup,
  gitArgs: string,
  instance?: string | null,
  options?: {
    /**
     * Some git commands return non-zero for useful results. Example:
     * `git diff --no-index` exits 1 when it successfully found a diff.
     * Treat matching stdout as success so callers don't retry/log it as a
     * command failure.
     */
    okIfStdoutMatches?: RegExp;
    /** Mutations must settle before their caller releases coordination. */
    waitForCompletion?: boolean;
  },
): Promise<{ ok: boolean; output: string }> {
  const effective = resolveEffectiveSandbox(group);
  const stack = effective.stack;
  const service = effective.service;
  instance = effectiveOperationInstance(effective, instance);
  const scopedGitArgs = effectiveGitArgs(effective, gitArgs);
  logger.debug(
    { stack, instance, service, gitArgs: scopedGitArgs },
    '[git] runGitInRepo via sandboxGit',
  );
  try {
    const call = getSandboxClient().sandboxGit(
      stack,
      scopedGitArgs,
      instance ?? undefined,
      service,
      {
        ...(options?.waitForCompletion ? { waitForCompletion: true } : {}),
        remoteUrl: effectiveRemoteUrl(effective),
      },
    );
    const result = options?.waitForCompletion
      ? await call
      : await withTimeout(
          call,
          RUN_GIT_TIMEOUT_MS,
          `runGitInRepo timeout: git call did not complete within ${RUN_GIT_TIMEOUT_MS / 1000}s`,
        );
    const ok =
      !result.isError ||
      (!!options?.okIfStdoutMatches &&
        options.okIfStdoutMatches.test(result.stdout || ''));
    const logFields = {
      gitArgs: scopedGitArgs,
      isError: !ok,
      ...(ok && result.isError ? { rawIsError: true } : {}),
      ...gitStdoutLogFields(result.stdout, !ok),
    };
    if (ok) {
      logger.debug(logFields, '[git] sandboxGit result');
    } else {
      logger.warn(logFields, '[git] sandboxGit result');
    }
    return { ok, output: result.stdout };
  } catch (err) {
    logger.warn(
      {
        gitArgs: scopedGitArgs,
        stack,
        instance: instance ?? undefined,
        error: String(err),
      },
      '[git] sandboxGit threw or timed out',
    );
    return { ok: false, output: String(err) };
  }
}

export type GitDiffFile = {
  path: string;
  additions: number;
  deletions: number;
  kind?: 'file' | 'symlink';
  linkTarget?: string;
  renderError?: string;
  source?: 'task' | 'default-checkout-blocker';
  status?: string;
};

export interface LinkedRepositoryInspection {
  name: string;
  path: string;
  base: string;
  branch: string;
  head?: string;
  merge_commit?: string;
  files: GitDiffFile[];
  patch: string;
}

export interface LinkedRepositoryInspectionResult {
  repositories: LinkedRepositoryInspection[];
}

export function parseLinkedRepositoryInspection(
  output: string,
): LinkedRepositoryInspectionResult {
  try {
    const parsed = JSON.parse(
      output || '{}',
    ) as Partial<LinkedRepositoryInspectionResult>;
    return {
      repositories: Array.isArray(parsed.repositories)
        ? parsed.repositories.filter(
            (repo): repo is LinkedRepositoryInspection =>
              !!repo &&
              typeof repo.name === 'string' &&
              typeof repo.path === 'string' &&
              typeof repo.base === 'string' &&
              typeof repo.branch === 'string' &&
              Array.isArray(repo.files) &&
              typeof repo.patch === 'string',
          )
        : [],
    };
  } catch {
    return { repositories: [] };
  }
}

/**
 * Ask a project-owned worktree hook for nested repository changes. Projects
 * without `.agent/worktree-inspect.sh` return an empty list, preserving the
 * existing single-repository lifecycle.
 */
export async function inspectTaskLinkedRepositories(
  task: Task,
  group: RegisteredGroup,
): Promise<LinkedRepositoryInspectionResult> {
  if (!task.branch_name || !task.worktree_path) return { repositories: [] };
  const effective = resolveEffectiveSandbox(group);
  const instance = effectiveOperationInstance(
    effective,
    validatedInstance(task, group),
  );
  try {
    const result = await getSandboxClient().sandboxBranch(
      effective.stack,
      'inspect',
      {
        branch: task.branch_name,
        base: group.settings?.defaultBranch || 'develop',
        instance,
        localRepo: group.settings?.repositoryLocation,
        repoPath: effective.inherited ? effective.workspaceRoot : undefined,
        remoteUrl: effectiveRemoteUrl(effective),
        service: effective.service,
        worktree_path: `.worktrees/${task.branch_name}`,
      },
    );
    if (result.isError) {
      logger.warn(
        { task_id: task.id, output: result.stdout },
        'Linked repository inspection failed',
      );
      return { repositories: [] };
    }
    return parseLinkedRepositoryInspection(result.stdout);
  } catch (err) {
    logger.warn(
      { task_id: task.id, error: String(err) },
      'Linked repository inspection threw',
    );
    return { repositories: [] };
  }
}

/**
 * Decode a C-style quoted path as printed by git when `core.quotePath` applies.
 * Keep in sync with the copy in ui/src/components/chat/changes-view.tsx.
 */
function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"'))
    return path;
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
  };
  const bytes: number[] = [];
  const body = Array.from(path.slice(1, -1));
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\' || i === body.length - 1) {
      bytes.push(...Buffer.from(ch));
      continue;
    }
    const next = body[++i];
    const octal = /^[0-3][0-7]{2}$/.exec(body.slice(i, i + 3).join(''));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 2;
    } else if (next in simple) {
      bytes.push(simple[next]);
    } else {
      bytes.push(...Buffer.from(next));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Resolve git's rename notation in a numstat path (`old => new` or
 * `dir/{a => b}/file`) to the decoded destination path. Git quotes each side
 * of `old => new` on its own and never combines quoting with braces.
 */
function numstatDestinationPath(raw: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced) {
    const [, prefix, , renamed, suffix] = braced;
    const joined = `${prefix}${renamed}${suffix}`.replace(/\/{2,}/g, '/');
    // An empty side (`{a => }/f`) leaves a stray leading slash.
    return prefix ? joined : joined.replace(/^\//, '');
  }
  const arrow = raw.indexOf(' => ');
  return unquoteGitPath(arrow === -1 ? raw : raw.slice(arrow + 4));
}

/** Parse `git diff --numstat` lines into per-file stats. */
export function parseGitNumstat(output: string): GitDiffFile[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [add, del, ...rest] = line.split('\t');
      return {
        path: numstatDestinationPath(rest.join('\t')),
        additions: add === '-' ? 0 : parseInt(add, 10) || 0,
        deletions: del === '-' ? 0 : parseInt(del, 10) || 0,
      };
    })
    .filter((f) => f.path);
}

const REF_PATH_PATTERN = /^[\w./-]+$/;

type GitRunner = typeof runGitInRepo;

/** Parse `-z` output without trimming valid whitespace from Git paths. */
export function parseGitPathList(output: string): string[] {
  if (!output) return [];
  if (output.includes('\0'))
    return output.split('\0').filter((path) => path !== '');
  return output
    .split('\n')
    .filter((path) => path !== '')
    .map(unquoteGitPath);
}

function appendPatch(current: string, addition: string): string {
  if (!addition) return current;
  return current + (current && !current.endsWith('\n') ? '\n' : '') + addition;
}

function syntheticSymlinkPatch(path: string, target: string): string {
  const added = target
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 120000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${Math.max(1, target.split('\n').length)} @@`,
    added,
    '\\ No newline at end of file',
    '',
  ].join('\n');
}

type PathMetadata =
  | { kind: 'file' | 'missing' }
  | { kind: 'symlink'; linkTarget?: string };

/**
 * Byte budget for one inspect command's alias argument, measured after shell
 * quoting. Well under the 128 KiB per-argument limit.
 */
const INSPECT_CHUNK_BYTES = 64 * 1024;
const INSPECT_CHUNK_CONCURRENCY = 4;
const UNTRACKED_DIFF_CONCURRENCY = 8;

async function inspectPathMetadata(
  group: RegisteredGroup,
  instance: string | null | undefined,
  gitPrefix: string,
  paths: string[],
  runGit: GitRunner,
): Promise<Map<string, PathMetadata>> {
  const metadata = new Map<string, PathMetadata>();
  if (paths.length === 0) return metadata;

  // sandbox_git accepts a command string rather than an argv array. Build one
  // fixed shell alias per chunk whose path operands are individually
  // POSIX-quoted, and return two NUL-delimited fields per input. `-L` and
  // `readlink` inspect the directory entry itself, so dangling and
  // directory-valued links are never followed. Output order provides the
  // mapping without echoing path bytes. Chunks keep each command argument
  // under the per-argument size limit.
  const chunks: Array<{ paths: string[]; snippets: string[] }> = [];
  let current: { paths: string[]; snippets: string[] } | undefined;
  let currentBytes = 0;
  for (const path of paths) {
    const quotedPath = shellQuote(path);
    const snippet = `if [ -L ${quotedPath} ]; then printf 'symlink\\0'; readlink -n -- ${quotedPath}; printf '\\0'; elif [ -e ${quotedPath} ]; then printf 'file\\0\\0'; else printf 'missing\\0\\0'; fi`;
    const bytes = Buffer.byteLength(shellQuote(snippet)) + 2;
    if (!current || currentBytes + bytes > INSPECT_CHUNK_BYTES) {
      current = { paths: [], snippets: [] };
      chunks.push(current);
      currentBytes = 0;
    }
    current.paths.push(path);
    current.snippets.push(snippet);
    currentBytes += bytes;
  }

  const outputs = await mapWithConcurrency(
    chunks,
    INSPECT_CHUNK_CONCURRENCY,
    async (chunk) => {
      const result = await runGit(
        group,
        `${gitPrefix}-c alias.carapa-inspect=${shellQuote(`!${chunk.snippets.join('; ')}`)} carapa-inspect`,
        instance,
      );
      return !result.ok && !result.output ? null : result.output;
    },
  );

  chunks.forEach((chunk, chunkIndex) => {
    const output = outputs[chunkIndex];
    if (output === null || output === undefined) return;
    const fields = output.split('\0');
    chunk.paths.forEach((path, index) => {
      const kind = fields[index * 2];
      const linkTarget = fields[index * 2 + 1];
      if (kind === 'symlink') {
        metadata.set(path, {
          kind: 'symlink',
          ...(linkTarget !== undefined ? { linkTarget } : {}),
        });
      } else if (kind === 'file' || kind === 'missing') {
        metadata.set(path, { kind });
      }
    });
  });
  return metadata;
}

/**
 * Add symlink identity to tracked diff rows by inspecting the worktree entry
 * itself. This is needed after task changes have been committed: the path is no
 * longer returned by `ls-files --others`, but the Changes UI must still render
 * the link and its target. Missing/deleted paths remain unchanged because their
 * visual patch is still authoritative.
 */
export async function enrichTrackedDiffSymlinks(
  group: RegisteredGroup,
  instance: string | null | undefined,
  gitPrefix: string,
  files: GitDiffFile[],
  runGit: GitRunner = runGitInRepo,
): Promise<GitDiffFile[]> {
  const metadata = await inspectPathMetadata(
    group,
    instance,
    gitPrefix,
    files.map((file) => file.path),
    runGit,
  );
  return files.map((file) => {
    const inspected = metadata.get(file.path);
    return inspected?.kind === 'symlink' ? { ...file, ...inspected } : file;
  });
}

export interface GitStatusEntry extends GitDiffFile {
  source: 'default-checkout-blocker';
  status: string;
}

/** Parse machine-safe porcelain-v1 `-z` output, including rename pairs. */
export function parseGitStatusPorcelainZ(
  output: string,
): Array<{ path: string; status: string }> {
  if (!output) return [];
  const records = output.includes('\0')
    ? output.split('\0')
    : output.split('\n');
  const entries: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    entries.push({ path, status });
    if ((status.includes('R') || status.includes('C')) && output.includes('\0'))
      index += 1;
  }
  return entries;
}

export async function getDefaultCheckoutBlockers(
  group: RegisteredGroup,
  instance?: string | null,
  runGit: GitRunner = runGitInRepo,
): Promise<GitStatusEntry[]> {
  const statusResult = await runGit(
    group,
    'status --porcelain=v1 -z --untracked-files=all',
    instance,
  );
  if (!statusResult.ok) return [];
  const statusEntries = parseGitStatusPorcelainZ(statusResult.output);
  const paths = statusEntries.map((entry) => entry.path);
  const metadata = await inspectPathMetadata(
    group,
    instance,
    '',
    paths,
    runGit,
  );
  return statusEntries.map(({ path, status }) => {
    const inspected = metadata.get(path);
    return {
      path,
      status,
      source: 'default-checkout-blocker',
      additions: 0,
      deletions: 0,
      ...(inspected?.kind === 'symlink'
        ? inspected
        : inspected
          ? { kind: 'file' as const }
          : {
              kind: 'file' as const,
              renderError:
                'Could not inspect this checkout entry without following links.',
            }),
    };
  });
}

/**
 * Core helper: given the raw `ls-files --others --exclude-standard` output,
 * render every untracked path without following symbolic links.
 * Exported so the working-tree path (which fires `ls-files` in parallel with
 * `git diff HEAD`) can reuse the result without a second sandbox round-trip.
 */
export async function appendUntrackedDiffFromList(
  group: RegisteredGroup,
  instance: string | null | undefined,
  gitPrefix: string,
  patch: string,
  files: GitDiffFile[],
  untrackedListOutput: string,
  limit = 200,
  runGit: GitRunner = runGitInRepo,
): Promise<{ patch: string; files: GitDiffFile[] }> {
  const outFiles = [...files];
  let outPatch = patch;
  if (!untrackedListOutput) return { patch: outPatch, files: outFiles };

  const untracked = parseGitPathList(untrackedListOutput);
  const slice = untracked.slice(0, limit);

  const metadata = await inspectPathMetadata(
    group,
    instance,
    gitPrefix,
    slice,
    runGit,
  );
  const symlinks = slice.filter(
    (path) => metadata.get(path)?.kind === 'symlink',
  );
  for (const path of symlinks) {
    const entry = metadata.get(path);
    const linkTarget = entry?.kind === 'symlink' ? entry.linkTarget : undefined;
    const patchPathSafe = path === path.trim() && !/[\r\n\t]/.test(path);
    outFiles.push({
      path,
      additions:
        linkTarget === undefined
          ? 0
          : Math.max(1, linkTarget.split('\n').length),
      deletions: 0,
      kind: 'symlink',
      ...(linkTarget !== undefined ? { linkTarget } : {}),
      ...(linkTarget === undefined
        ? { renderError: 'Could not read symbolic link target.' }
        : !patchPathSafe
          ? {
              renderError:
                'Visual patch unavailable because the link path contains line-breaking characters.',
            }
          : {}),
    });
    if (linkTarget !== undefined && patchPathSafe) {
      outPatch = appendPatch(outPatch, syntheticSymlinkPatch(path, linkTarget));
    }
  }
  const unknown = slice.filter(
    (path) => (metadata.get(path)?.kind ?? 'missing') === 'missing',
  );
  for (const path of unknown) {
    outFiles.push({
      path,
      additions: 0,
      deletions: 0,
      renderError:
        'Could not inspect this untracked entry without following links.',
    });
  }
  const regularFiles = slice.filter(
    (path) => metadata.get(path)?.kind === 'file',
  );
  if (regularFiles.length === 0) return { patch: outPatch, files: outFiles };

  // `git diff --no-index` compares exactly two paths. Render each regular file
  // against /dev/null rather than issuing a guaranteed-invalid multi-path call
  // before falling back to these same per-file commands.
  // Run with bounded concurrency; results keep the input order.
  const singles = await mapWithConcurrency(
    regularFiles,
    UNTRACKED_DIFF_CONCURRENCY,
    (f) =>
      runGit(
        group,
        `${gitPrefix}diff --no-color --no-index -- /dev/null ${shellQuote(f)}`,
        instance,
        { okIfStdoutMatches: /^diff --git /m },
      ),
  );
  regularFiles.forEach((f, index) => {
    const single = singles[index]!;
    if (single.ok && single.output) {
      outPatch = appendPatch(outPatch, single.output);
      const additions = single.output
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      outFiles.push({ path: f, additions, deletions: 0, kind: 'file' });
    } else {
      outFiles.push({
        path: f,
        additions: 0,
        deletions: 0,
        kind: 'file',
        renderError: 'Git could not generate a visual patch for this entry.',
      });
    }
  });
  return { patch: outPatch, files: outFiles };
}

// ---------------------------------------------------------------------------
// Per-project git lock
// ---------------------------------------------------------------------------

/**
 * Per-project mutex for LOCAL_REPO git operations.
 * Serialises branch-switch + observation-commit sequences so concurrent task
 * completions don't race on the shared working tree.
 */
const projectGitLocks = new Map<string, Promise<void>>();
/** Who runs under each project's lock right now, for bounded waiters' error text. */
const projectGitLockHolders = new Map<string, string>();

/** Maximum ms a single git operation may hold the per-project lock. */
const GIT_LOCK_TIMEOUT_MS = 60_000;

export function withProjectGitLock<T = void>(
  project_id: string,
  fn: () => Promise<T>,
  options: {
    waitForCompletion?: boolean;
    /** Name shown to a bounded waiter while this operation holds the lock. */
    holder?: string;
    /** Give up with CheckoutBusyError if earlier operations still hold the lock after this many ms; fn then never runs. */
    maxWaitMs?: number;
  } = {},
): Promise<T> {
  const prev = projectGitLocks.get(project_id) ?? Promise.resolve();
  // A merge plus its durable handoff must keep completion behind the actual
  // operation, even when delivery outlasts the normal Git lock timeout.
  const guarded = options.waitForCompletion
    ? fn
    : () =>
        withTimeout(
          fn(),
          GIT_LOCK_TIMEOUT_MS,
          `Git lock timeout: operation for project "${project_id}" did not complete within ` +
            `${GIT_LOCK_TIMEOUT_MS / 1000}s. Subsequent git operations for this project have been unblocked.`,
        );
  const holder = options.holder ?? 'another git operation';
  let waiting = true;
  let abandoned = false;
  const run = () => {
    if (abandoned) return Promise.resolve(undefined as T);
    waiting = false;
    projectGitLockHolders.set(project_id, holder);
    return guarded().finally(() => {
      if (projectGitLockHolders.get(project_id) === holder)
        projectGitLockHolders.delete(project_id);
    });
  };
  // Always run fn even if the previous operation failed.
  const next = prev.then(run, run);
  // Store an always-resolving tail so the chain never permanently stalls.
  projectGitLocks.set(
    project_id,
    next.then(
      () => {},
      () => {},
    ),
  );
  if (options.maxWaitMs === undefined) return next;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!waiting) return;
      // The queued slot stays in the chain but turns into a no-op, so a lock
      // freed later does not start this request's work.
      abandoned = true;
      reject(
        new CheckoutBusyError(
          'project git lock',
          projectGitLockHolders.get(project_id) ?? 'another git operation',
        ),
      );
    }, options.maxWaitMs);
    next.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// ---------------------------------------------------------------------------
// Repo mode detection
// ---------------------------------------------------------------------------

/** Returns true when the project has a host repo path configured (LOCAL_REPO mode). */
export function isLocalRepoMode(group: RegisteredGroup): boolean {
  return Boolean(
    group.settings?.repositoryLocation ||
    group.settings?.repositoryRelativePath,
  );
}

// ---------------------------------------------------------------------------
// Branch lifecycle operations
// ---------------------------------------------------------------------------

/**
 * Record the task branch name in the DB and update UI.
 * Actual git checkout is handled by runContainerAgent via ContainerInput.branch_name.
 */
export async function checkoutTaskBranch(
  task: Task,
  group: RegisteredGroup,
): Promise<void> {
  if (!taskUsesBranch(group)) return;
  const branch_name = getBranchNameForTask(task);
  if (task.branch_name !== branch_name) {
    await updateTask(task.id, { branch_name: branch_name });
    const updated = await getTask(task.id);
    if (updated) {
      broadcast({ type: 'task_updated', payload: updated });
    }
  }
}

/**
 * A task-state database read or write failed around a Git operation. The Git
 * operation did not fail, so restart recovery must not park the card for it.
 */
export class TaskStateError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'TaskStateError';
  }
}

export async function commitTaskBranch(
  task: Task,
  group: RegisteredGroup,
  dependencies: {
    sandboxClient?: Pick<
      ReturnType<typeof getSandboxClient>,
      'sandboxBranch' | 'sandboxWorktree'
    >;
    runGit?: typeof runGitInRepo;
    persistTask?: typeof updateTask;
    wait?: (milliseconds: number) => Promise<void>;
    /** Restart recovery: throw a failed `completed_commit_sha` write as TaskStateError instead of returning false. */
    propagateStateErrors?: boolean;
  } = {},
): Promise<boolean> {
  // A persisted task branch remains authoritative even if a later project
  // settings edit disables branch-per-task. This lets legacy/in-flight
  // worktrees finish safely after a rename or settings restoration.
  if (!taskUsesBranch(group) && !task.branch_name) return true;
  const branch_name = task.branch_name || getBranchNameForTask(task);
  const effective = resolveEffectiveSandbox(group);
  const instance = effectiveOperationInstance(
    effective,
    validatedInstance(task, group),
  );
  const stack = effective.stack;
  const commitMsg = `feat: ${task.title.replace(/"/g, '\\"').replace(/`/g, '\\`')}`;
  const client = dependencies.sandboxClient ?? getSandboxClient();
  const runGit = dependencies.runGit ?? runGitInRepo;
  const persistTask = dependencies.persistTask ?? updateTask;
  const wait = dependencies.wait ?? sleep;
  const localRepo =
    group.settings?.repositoryLocation ??
    (group.settings?.repositoryRelativePath
      ? effective.hostWorkspaceLocation
      : undefined);

  // Worktree mode is authoritative even when old/recovered tasks have lost
  // their nullable host-path metadata. The deterministic branch name still
  // identifies the managed worktree inside the agent container.
  const usesWorktree = taskUsesWorktree(group) || !!task.worktree_path;
  const worktree_path = usesWorktree ? `.worktrees/${branch_name}` : undefined;
  const checkpoint = () =>
    client.sandboxBranch(stack, 'commit', {
      branch: branch_name,
      instance: instance ?? undefined,
      localRepo,
      repoPath: effective.inherited ? effective.workspaceRoot : undefined,
      remoteUrl: effectiveRemoteUrl(effective),
      service: effective.service,
      ...(worktree_path ? { worktree_path } : {}),
      commitMessage: commitMsg,
    });

  try {
    let result = await checkpoint();
    if (result.isError) {
      if (usesWorktree) {
        // Recovery/archive flows can preserve the task branch while losing the
        // nullable DB path or the physical checkout. Recreate or reassociate
        // the deterministic managed worktree before the one allowed retry.
        let repairBase = group.settings?.defaultBranch || 'develop';
        const taskForkCommit =
          task.ab_fork_commit ?? (task as any).abForkCommit;
        if (taskForkCommit) {
          repairBase = taskForkCommit;
        } else {
          const parentId =
            task.ab_parent_task_id ?? (task as any).abParentTaskId;
          if (parentId) {
            const parent = await getTask(parentId);
            const parentForkCommit =
              parent?.ab_fork_commit ?? (parent as any)?.abForkCommit;
            if (parentForkCommit) {
              repairBase = parentForkCommit;
            }
          }
        }
        const repaired = await client.sandboxWorktree(stack, 'add', {
          branch: branch_name,
          base: repairBase,
          instance: instance ?? undefined,
          localRepo,
          repoPath: effective.inherited ? effective.workspaceRoot : undefined,
          remoteUrl: effectiveRemoteUrl(effective),
          symlinkFiles: group.settings?.worktreeFiles,
          service: effective.service,
        });
        if (!repaired.isError) {
          const recoveredPath =
            repaired.stdout.match(/^worktree_path=(.+)$/m)?.[1];
          if (recoveredPath && recoveredPath !== task.worktree_path) {
            await persistTask(task.id, { worktree_path: recoveredPath });
          }
        } else {
          logger.warn(
            { task_id: task.id, output: repaired.stdout },
            'Unable to repair managed worktree before checkpoint retry',
          );
        }
      } else {
        await wait(100);
      }
      result = await checkpoint();
    }
    const output = result.stdout ?? '';
    const noChanges = /no changes|nothing to commit|working tree clean/i.test(
      output,
    );
    if (!result.isError || noChanges) {
      const prefix = usesWorktree ? `-C .worktrees/${branch_name} ` : '';
      const identity = await runGit(
        group,
        `${prefix}rev-parse --verify ${branch_name}^{commit}`,
        instance,
      );
      if (identity.ok) {
        // Merge into the stored map: `task` is a snapshot from before the
        // caller's own PATCH, the failed-stage transition and any concurrent
        // `update_values` write.
        const write = persistTask(
          task.id,
          { custom_values: { completed_commit_sha: identity.output.trim() } },
          { mergeCustomValues: true },
        );
        await (dependencies.propagateStateErrors
          ? write.catch((error) => {
              throw new TaskStateError(error);
            })
          : write);
      }
      logger.info({ task_id: task.id }, 'Committed changes to task branch');
      return true;
    }
    logger.warn(
      { task_id: task.id, output: result.stdout },
      'sandbox_branch:commit failed',
    );
    return false;
  } catch (err) {
    if (err instanceof TaskStateError) throw err;
    logger.warn(
      { err, task_id: task.id },
      'commitTaskBranch via sandbox_branch failed',
    );
    return false;
  }
}
export async function sharedCheckoutIsSafe(
  task: Task,
  group: RegisteredGroup,
  requireClean = true,
  alternativeExpectedBranches: string[] = [],
): Promise<boolean> {
  if (
    !task.branch_name &&
    !group.settings?.repositoryLocation &&
    !group.settings?.repositoryUrl &&
    !group.settings?.repositoryRelativePath
  )
    return true;
  const expectedBranch =
    task.branch_name ?? group.settings?.defaultBranch ?? 'develop';
  const expectedBranches = [expectedBranch, ...alternativeExpectedBranches];
  const instance = validatedInstance(task, group);
  const [branch, status] = await Promise.all([
    runGitInRepo(group, 'branch --show-current', instance),
    runGitInRepo(group, 'status --porcelain=v1', instance),
  ]);
  const safe =
    branch.ok &&
    status.ok &&
    expectedBranches.includes(branch.output.trim()) &&
    (!requireClean || status.output.trim() === '');
  if (!safe) {
    logger.warn(
      {
        task_id: task.id,
        expectedBranches,
        actualBranch: branch.output.trim(),
        status: status.output,
      },
      'Refusing to mutate an unexpected or dirty shared checkout',
    );
  }
  return safe;
}

/**
 * Return whether the task branch still needs to be rebased onto the requested
 * review base. A zero `HEAD..<base>` count means HEAD already contains the
 * current base tip, so calling CarapaBox's mutating `prepare_review` action
 * would be unnecessary and must be skipped to preserve the tested HEAD.
 *
 * Fail closed: an unavailable/malformed answer still requests preparation so
 * a transient inspection failure cannot silently leave Review on a stale base.
 */
export async function taskBranchNeedsReviewPreparation(
  task: Task,
  group: RegisteredGroup,
  baseBranch: string,
  runGit: typeof runGitInRepo = runGitInRepo,
): Promise<boolean> {
  if (!REF_PATH_PATTERN.test(baseBranch)) {
    logger.warn(
      { task_id: task.id, base_branch: baseBranch },
      '[review] Cannot inspect invalid base ref; prepare_review remains required',
    );
    return true;
  }

  // Branch-mode runs restore the repository root to the default branch after
  // execution. Inspect the persisted task branch ref directly instead of the
  // mutable checkout HEAD; worktree runs still inspect their worktree HEAD.
  const comparisonHead = task.worktree_path
    ? 'HEAD'
    : task.branch_name || 'HEAD';
  const wtPrefix = task.worktree_path
    ? `-C .worktrees/${task.branch_name} `
    : '';
  const result = await runGit(
    group,
    `${wtPrefix}rev-list --count ${comparisonHead}..${baseBranch}`,
    validatedInstance(task, group),
  );
  const count = result.output.trim();
  if (!result.ok || !/^\d+$/.test(count)) {
    logger.warn(
      { task_id: task.id, base_branch: baseBranch, output: result.output },
      '[review] Could not determine whether prepare_review is necessary',
    );
    return true;
  }
  return Number(count) > 0;
}

/**
 * Diff of uncommitted changes in the shared repo checkout (working-tree mode).
 * The two independent read-only calls (diff and ls-files) run in parallel —
 * saves one MCP round-trip vs. the previous sequential layout. Untracked-file
 * diffs run with bounded concurrency inside `appendUntrackedDiffFromList`.
 */
export async function getWorkingTreeDiff(
  group: RegisteredGroup,
  instance?: string | null,
  runGit: GitRunner = runGitInRepo,
): Promise<{
  files: GitDiffFile[];
  patch: string;
  repositoryState?: 'unborn' | 'not-initialized';
  branch?: string;
} | null> {
  // All three calls are independent — fan them out, then collect.
  let [patchRes, statRes, lsRes] = await Promise.all([
    runGit(group, 'diff --no-color HEAD', instance),
    runGit(group, 'diff --no-color --numstat HEAD', instance),
    runGit(group, 'ls-files --others --exclude-standard -z', instance),
  ]);
  let branch: string | undefined;
  if (!patchRes.ok) {
    if (/not a git repository/i.test(patchRes.output)) {
      return { files: [], patch: '', repositoryState: 'not-initialized' };
    }
    // An unborn HEAD is a symbolic branch with no ref yet. Do not mistake
    // transport failures or a damaged existing HEAD for an empty repository.
    const [head, refs, emptyTree] = await Promise.all([
      runGit(group, 'symbolic-ref --quiet HEAD', instance),
      runGit(group, "for-each-ref --format='%(refname)' refs/heads/", instance),
      runGit(group, 'hash-object -t tree /dev/null', instance),
    ]);
    const ref = head.output.trim();
    const tree = emptyTree.output.trim();
    if (
      !head.ok ||
      !ref.startsWith('refs/heads/') ||
      !refs.ok ||
      refs.output.trim().split('\n').includes(ref) ||
      !emptyTree.ok ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)
    )
      return null;
    branch = ref.slice('refs/heads/'.length);
    // Compare against Git's empty tree in the repository's object format.
    // This includes staged files and their current working-tree edits.
    [patchRes, statRes] = await Promise.all([
      runGit(group, `diff --no-color ${tree}`, instance),
      runGit(group, `diff --no-color --numstat ${tree}`, instance),
    ]);
  }
  if (!patchRes.ok || !statRes.ok || !lsRes.ok) return null;
  let files = parseGitNumstat(statRes.output);
  let patch = patchRes.output;
  // Reuse the ls-files output we already have so we don't issue a second one.
  ({ patch, files } = await appendUntrackedDiffFromList(
    group,
    instance,
    '',
    patch,
    files,
    lsRes.output,
    200,
    runGit,
  ));
  return {
    files,
    patch,
    ...(branch ? { repositoryState: 'unborn' as const, branch } : {}),
  };
}

/** Separate index and checkout patches for the Changes tab. */
export async function getIndexDiffSections(
  group: RegisteredGroup,
  instance?: string | null,
  gitPrefix = '',
  committedBase?: string,
): Promise<Array<{
  kind: 'committed' | 'staged' | 'unstaged';
  files: GitDiffFile[];
  patch: string;
}> | null> {
  const specs = [
    ...(committedBase
      ? [
          {
            kind: 'committed' as const,
            args: `diff --no-color ${shellQuote(committedBase)} HEAD`,
          },
        ]
      : []),
    { kind: 'staged' as const, args: 'diff --no-color --cached' },
    { kind: 'unstaged' as const, args: 'diff --no-color' },
  ];
  const results = await Promise.all(
    specs.map(async (spec) => {
      const [patch, stat] = await Promise.all([
        runGitInRepo(group, `${gitPrefix}${spec.args}`, instance),
        runGitInRepo(group, `${gitPrefix}${spec.args} --numstat`, instance),
      ]);
      return { kind: spec.kind, patch, stat };
    }),
  );
  if (results.some(({ patch, stat }) => !patch.ok || !stat.ok)) return null;
  const sections = results.map(({ kind, patch, stat }) => ({
    kind,
    patch: patch.output,
    files: parseGitNumstat(stat.output),
  }));
  const untracked = await runGitInRepo(
    group,
    `${gitPrefix}ls-files --others --exclude-standard -z`,
    instance,
  );
  if (!untracked.ok) return null;
  const unstaged = sections.find((section) => section.kind === 'unstaged')!;
  const withUntracked = await appendUntrackedDiffFromList(
    group,
    instance,
    gitPrefix,
    unstaged.patch,
    unstaged.files,
    untracked.output,
  );
  unstaged.patch = withUntracked.patch;
  unstaged.files = withUntracked.files;
  return sections.filter(
    (section) => section.kind !== 'committed' || section.files.length > 0,
  );
}

/**
 * Commit all uncommitted changes in the shared repo checkout (working-tree mode).
 * Not for per-conversation/task worktrees — use commitTaskBranch for those.
 */
export async function commitWorkingTree(
  group: RegisteredGroup,
  commitMessage: string,
  instance?: string | null,
): Promise<{ ok: boolean; output: string; noChanges: boolean }> {
  return withProjectGitLock(group.folder, () =>
    commitWorkingTreeUnlocked(group, commitMessage, instance),
  );
}

/**
 * Commit the project's shared/default checkout while the caller owns the
 * project Git lock. Task finalization already holds that lock across the
 * complete checkpoint/merge decision, so it must not call the public locking
 * wrapper above recursively.
 */
async function commitWorkingTreeUnlocked(
  group: RegisteredGroup,
  commitMessage: string,
  instance?: string | null,
): Promise<{ ok: boolean; output: string; noChanges: boolean }> {
  const effective = resolveEffectiveSandbox(group);
  const stack = effective.stack;
  const service = effective.service;
  instance = effectiveOperationInstance(effective, instance);
  const baseBranch = group.settings?.defaultBranch || 'develop';

  try {
    const result = await getSandboxClient().sandboxBranch(stack, 'commit', {
      branch: baseBranch,
      instance: instance ?? undefined,
      service,
      localRepo:
        group.settings?.repositoryLocation ??
        (group.settings?.repositoryRelativePath
          ? effective.hostWorkspaceLocation
          : undefined),
      repoPath: effective.inherited ? effective.workspaceRoot : undefined,
      remoteUrl: effectiveRemoteUrl(effective),
      commitMessage,
    });
    const output = result.stdout ?? '';
    // sandbox_branch may report git's clean-tree exit as an MCP error even
    // though there is nothing left to persist. A clean result is a valid
    // checkpoint; only real operational failures block completion.
    const noChanges = /no changes|nothing to commit|working tree clean/i.test(
      output,
    );
    const ok = !result.isError && !noChanges;
    if (ok) {
      logger.info({ project: group.folder }, 'Committed working-tree changes');
    } else if (result.isError) {
      logger.warn(
        { project: group.folder, output },
        'commitWorkingTree failed',
      );
    }
    return { ok, output, noChanges };
  } catch (err) {
    logger.warn(
      { err, project: group.folder },
      'commitWorkingTree via sandbox_branch failed',
    );
    return { ok: false, output: String(err), noChanges: false };
  }
}

/**
 * Persist a non-worktree task directly on the configured default branch.
 * A clean checkout is a valid outcome (for example, a read-only task), while
 * an operational commit failure must stop the task from being finalized.
 *
 * The caller must own the per-project Git lock.
 */
export async function checkpointTaskDefaultBranch(
  task: Task,
  group: RegisteredGroup,
): Promise<TaskBranchMergeResult> {
  if (
    task.branch_name ||
    (!group.settings?.repositoryLocation &&
      !group.settings?.repositoryRelativePath &&
      !group.settings?.repositoryUrl)
  ) {
    return { mergeOk: true, output: '' };
  }

  const instance = validatedInstance(task, group);
  const result = await commitWorkingTreeUnlocked(
    group,
    `feat: ${task.title}`,
    instance,
  );
  if (!result.ok && !result.noChanges) {
    return {
      mergeOk: false,
      output: result.output,
      failureKind: 'environment',
    };
  }

  if (result.ok) {
    const baseBranch = group.settings?.defaultBranch || 'develop';
    try {
      const shaResult = await runGitInRepo(
        group,
        `rev-parse ${baseBranch}`,
        instance,
      );
      const sha = shaResult.output.trim();
      if (shaResult.ok && COMMIT_SHA_PATTERN.test(sha)) {
        await updateTask(task.id, { merge_commit: sha });
      }
    } catch (err) {
      logger.warn(
        { task_id: task.id, error: String(err) },
        'Failed to capture shared-checkout task commit SHA (non-fatal)',
      );
    }
  }

  logger.info(
    { task_id: task.id, noChanges: result.noChanges },
    'Checkpointed task on default branch',
  );
  return { mergeOk: true, output: result.output };
}

/**
 * Remove a git worktree for a task branch via CarapaBox sandbox_worktree tool.
 * Branch mode deliberately keeps its branch in the repository root and has no
 * worktree lifecycle to clean up.
 */
export async function removeWorktreeForTask(
  task: Task,
  group: RegisteredGroup,
  options: {
    force?: boolean;
    leaseAlreadyHeld?: boolean;
    throwOnError?: boolean;
  } = {},
): Promise<void> {
  const checkoutMode = group.settings?.taskCheckoutMode;
  if (!options.force && checkoutMode && checkoutMode !== 'worktree') return;
  if (!task.branch_name) return;
  const projectId = task.project_id || group.folder;
  const lease = options.leaseAlreadyHeld
    ? undefined
    : await acquireSharedCheckoutLease(projectId, {
        type: 'task',
        id: task.id,
      });
  try {
    const client = getSandboxClient();
    const effective = resolveEffectiveSandbox(group);
    const stack = effective.stack;
    const instance = effectiveOperationInstance(
      effective,
      validatedInstance(task, group) || group.settings?.defaultSandboxInstance,
    );
    const { affectedConversationIds } =
      await transitionConversationsFromRemovedWorktree(
        projectId,
        task.branch_name,
        async () => {
          const result = await client.sandboxWorktree(stack, 'remove', {
            branch: task.branch_name!,
            instance,
            localRepo: group.settings?.repositoryLocation,
            repoPath: effective.inherited ? effective.workspaceRoot : undefined,
            remoteUrl: effectiveRemoteUrl(effective),
            service: effective.service,
          });
          if (result.isError) {
            throw new Error(
              result.stdout || 'CarapaBox could not remove worktree',
            );
          }
          return result;
        },
      );
    await updateTask(task.id, { worktree_path: null });
    if (affectedConversationIds.length > 0) {
      broadcast({
        type: 'conversations_changed',
        payload: { folder: projectId },
      });
    }
    logger.info(
      {
        task_id: task.id,
        branch: task.branch_name,
        affectedConversationIds,
      },
      'Removed worktree',
    );
  } catch (err) {
    if (err instanceof ConversationWorktreeInUseError || options.throwOnError)
      throw err;
    logger.warn(
      { task_id: task.id, error: String(err) },
      'removeWorktreeForTask failed',
    );
  } finally {
    await lease?.release();
  }
}

/**
 * Merge the task branch into the default branch before deploying.
 * Falls back to checkpointing the default branch when the task has no branch.
 */
export async function mergeTaskBranchToDefault(
  task: Task,
  group: RegisteredGroup,
  options: {
    /**
     * Runs immediately before the sandbox merge call; a returned result aborts
     * the merge and is returned as is. `sandbox_branch merge` takes a branch
     * name, not a commit, so this re-check is the tightest guard available
     * against the branch moving after the caller's own checks.
     */
    beforeMerge?: () => Promise<TaskBranchMergeResult | undefined>;
  } = {},
): Promise<TaskBranchMergeResult> {
  if (!task.branch_name) {
    return checkpointTaskDefaultBranch(task, group);
  }
  const branch_name = task.branch_name || getBranchNameForTask(task);
  const baseBranch = group.settings?.defaultBranch || 'develop';
  const effective = resolveEffectiveSandbox(group);
  const instance = effectiveOperationInstance(
    effective,
    validatedInstance(task, group),
  );
  const stack = effective.stack;
  logger.info(
    {
      task_id: task.id,
      branch_name,
      baseBranch,
      instance,
      worktree_path: task.worktree_path,
      autoPush: !!group.settings?.autoPushAfterMerge,
    },
    '[merge] Starting mergeTaskBranchToDefault via sandbox_branch',
  );
  let taskDiffBaseSha: string | null = null;
  try {
    const baseResult = await runGitInRepo(
      group,
      `merge-base ${baseBranch} ${branch_name}`,
      instance ?? undefined,
    );
    const base = baseResult.output.trim();
    if (baseResult.ok && COMMIT_SHA_PATTERN.test(base)) taskDiffBaseSha = base;
  } catch (error) {
    logger.warn(
      { task_id: task.id, error: String(error) },
      '[merge] Failed to capture task diff base SHA',
    );
  }
  try {
    const aborted: { result?: TaskBranchMergeResult } = {};
    const merge = async () => {
      aborted.result = await options.beforeMerge?.();
      if (aborted.result) return { stdout: '', isError: true };
      return getSandboxClient().sandboxBranch(stack, 'merge', {
        branch: branch_name,
        base: baseBranch,
        instance: instance ?? undefined,
        localRepo: group.settings?.repositoryLocation,
        repoPath: effective.inherited ? effective.workspaceRoot : undefined,
        remoteUrl: effectiveRemoteUrl(effective),
        service: effective.service,
        autoPush: !!group.settings?.autoPushAfterMerge,
        ...(task.worktree_path
          ? { worktree_path: `.worktrees/${branch_name}` }
          : {}),
        commitMessage: `feat: ${task.title}`,
      });
    };
    const removedWorktree = (result: {
      stdout: string;
      isError: boolean;
    }): boolean => {
      if (result.isError) return false;
      try {
        return (
          (JSON.parse(result.stdout) as { merged?: boolean }).merged === true
        );
      } catch {
        return false;
      }
    };
    const transition = task.worktree_path
      ? await transitionConversationsFromRemovedWorktree(
          task.project_id || group.folder,
          branch_name,
          merge,
          removedWorktree,
        )
      : { result: await merge(), affectedConversationIds: [] };
    const { result, affectedConversationIds } = transition;
    if (aborted.result) return aborted.result;
    let structured: {
      merged?: boolean;
      output?: string;
      repositories?: unknown;
      blockingEntries?: unknown;
      statusEntries?: unknown;
    } = {};
    let stdoutIsJson = false;
    try {
      structured = JSON.parse(result.stdout);
      stdoutIsJson = true;
    } catch {
      /* not JSON — explicit conflict signatures below still apply */
    }
    // CarapaBox reports isError when the merge landed but task-worktree
    // cleanup (or the follow-up push) failed. The default branch already
    // contains the merge, so treat `merged: true` as success.
    const mergedDespiteError = result.isError && structured?.merged === true;
    if (result.isError && !mergedDespiteError) {
      // The sandbox_branch:merge MCP labels any non-zero exit as a failure. To
      // avoid punishing the task for environmental issues (dirty main checkout,
      // leftover stash, etc.) versus real content conflicts, look at the
      // structured output:
      //   `[env] ...`     — deterministic env error, safe to auto-retry
      //   `CONFLICT(...)` — real content conflict, needs human/LLM resolution
      // Unknown output is environmental/operational, not proof of a content
      // conflict. Automatic conflict resolution is intentionally fail-closed:
      // only recognizable git conflict output may launch a coding agent.
      let kind: TaskBranchMergeFailureKind = 'environment';
      const out = structured.output ?? result.stdout ?? '';
      if (isContentMergeConflictOutput(out)) kind = 'conflict';
      const rawBlockers = Array.isArray(structured.blockingEntries)
        ? structured.blockingEntries
        : Array.isArray(structured.statusEntries)
          ? structured.statusEntries
          : [];
      let blockers = rawBlockers
        .filter(
          (entry): entry is Record<string, unknown> & { path: string } =>
            !!entry &&
            typeof entry === 'object' &&
            'path' in entry &&
            typeof entry.path === 'string',
        )
        .map(
          (entry): GitStatusEntry => ({
            path: entry.path,
            status: typeof entry.status === 'string' ? entry.status : '??',
            source: 'default-checkout-blocker',
            additions: 0,
            deletions: 0,
            kind: entry.kind === 'symlink' ? 'symlink' : 'file',
            ...(typeof entry.linkTarget === 'string'
              ? { linkTarget: entry.linkTarget }
              : {}),
          }),
        );
      if (kind === 'environment' && blockers.length === 0) {
        blockers = await getDefaultCheckoutBlockers(group, instance);
      }
      const detailedOutput = blockers.length
        ? `${out}\n\nBlocking default checkout entries:\n${blockers
            .map((entry) => `${entry.status} ${JSON.stringify(entry.path)}`)
            .join('\n')}`
        : out;
      logger.warn(
        { task_id: task.id, branch_name, kind, output: detailedOutput },
        '[merge] sandbox_branch merge failed',
      );
      return {
        mergeOk: false,
        output:
          kind === 'environment' && detailedOutput.startsWith('[env]')
            ? `[env] ${detailedOutput.replace(/^\[env\]\s*/, '')}`
            : detailedOutput,
        failureKind: kind,
        blockers,
      };
    }
    // Parse the JSON result
    let merged = false;
    let linkedRepositories: unknown[] = [];
    if (stdoutIsJson) {
      merged = !!structured.merged;
      if (Array.isArray(structured.repositories)) {
        linkedRepositories = structured.repositories;
      }
    }
    if (merged) {
      // The branch + worktree are gone after merge, but the changes live on as a
      // merge commit on the default branch. Capture its SHA so the diff endpoint
      // can still show what the task implemented (git diff <sha>^1 <sha>).
      let mergeCommit: string | null = null;
      try {
        const shaRes = await runGitInRepo(
          group,
          `rev-parse ${baseBranch}`,
          instance ?? undefined,
        );
        const sha = shaRes.output.trim();
        if (shaRes.ok && COMMIT_SHA_PATTERN.test(sha)) mergeCommit = sha;
      } catch (err) {
        logger.warn(
          { task_id: task.id, error: String(err) },
          '[merge] Failed to capture merge commit SHA (non-fatal)',
        );
      }
      // sandbox_branch already cleaned up the worktree and branch,
      // so clear both DB fields (branch_name + worktree_path).
      // The merge already landed, so a bookkeeping failure must not be reported
      // as a failed merge (the caller would park the card and retry a gone branch).
      try {
        await updateTask(task.id, {
          branch_name: null,
          worktree_path: null,
          merge_commit: mergeCommit,
          custom_values: {
            ...(task.custom_values || {}),
            ...(taskDiffBaseSha ? { task_diff_base_sha: taskDiffBaseSha } : {}),
            ...(linkedRepositories.length
              ? { linked_repository_merges: JSON.stringify(linkedRepositories) }
              : {}),
          },
        });
      } catch (err) {
        logger.error(
          {
            task_id: task.id,
            branch_name,
            baseBranch,
            merge_commit: mergeCommit,
            error: String(err),
          },
          '[merge] Merge landed but recording it on the task failed; branch_name/worktree_path/merge_commit are stale',
        );
      }
      logger.info(
        {
          task_id: task.id,
          branch_name,
          baseBranch,
          merge_commit: mergeCommit,
          affectedConversationIds,
        },
        '[merge] Merged task branch into default branch',
      );
      if (affectedConversationIds.length > 0) {
        broadcast({
          type: 'conversations_changed',
          payload: { folder: task.project_id || group.folder },
        });
      }
      if (mergedDespiteError) {
        const detail = structured.output ?? result.stdout;
        logger.warn(
          { task_id: task.id, branch_name, baseBranch, output: detail },
          '[merge] Merged, but CarapaBox reported an error (worktree cleanup failed; auto-push skipped)',
        );
        const notice = appendTaskMessage(task.project_id || group.folder, {
          task_id: task.id,
          role: 'system',
          entry_type: 'system_notice',
          content: `**Merged into \`${baseBranch}\`, but task worktree cleanup failed** — auto-push was skipped. ${detail}`,
          created_at: new Date().toISOString(),
        });
        broadcast({
          type: 'task_message',
          payload: {
            task_id: task.id,
            project_id: task.project_id || group.folder,
            message: notice,
          },
        });
      }
    }
    return { mergeOk: merged, output: result.stdout };
  } catch (err) {
    logger.warn(
      { task_id: task.id, error: String(err) },
      '[merge] mergeTaskBranchToDefault threw',
    );
    return {
      mergeOk: false,
      output: String(err),
      failureKind: 'environment',
    };
  }
}

export type TaskBranchMergeFailureKind =
  | 'conflict'
  | 'environment'
  /** The branch touches files the project's merge risk rules reserve for a human. */
  | 'approval_required';

export interface TaskBranchMergeResult {
  mergeOk: boolean;
  output: string;
  failureKind?: TaskBranchMergeFailureKind;
  blockers?: GitStatusEntry[];
  skipped?: 'ab_variant';
  /** Set with `approval_required`: the head and findings a person must approve. */
  approval?: { headSha: string; findings: MergeFinding[] };
  /**
   * The task is durably committed on its isolated branch, but integration into
   * the checked-out default branch was deferred because that shared checkout
   * contains unrelated changes. The task may complete; its branch/worktree
   * must remain available for a later integration retry.
   */
  integrationPending?: boolean;
}

/** True only for output that demonstrates git reached a content conflict. */
export function isContentMergeConflictOutput(output: string): boolean {
  if (!output || output.startsWith('[env]')) return false;
  return (
    /(^|\n)CONFLICT \([^\n]+\):/m.test(output) ||
    /(^|\n)Automatic merge failed; fix conflicts/m.test(output)
  );
}

// ---------------------------------------------------------------------------
// Route-level helper: commit & switch on stage transition
// ---------------------------------------------------------------------------

/**
 * Handle git branch commit/switch when a task leaves an active stage.
 * Extracted from route handlers to eliminate duplication between single-task
 * and bulk PATCH endpoints.
 */
export function commitBranchOnStageLeave(
  task: Task,
  group: RegisteredGroup,
): void {
  if (task.worktree_path) {
    // Worktree mode: commit changes to the branch. Worktree persists across
    // stages (review, retry, deploy) and is cleaned up after merge or task delete.
    commitTaskBranch(task, group).catch((err) =>
      logger.warn({ err }, 'worktree ops failed on stage transition'),
    );
  } else {
    // Legacy branch checkout or shared/default checkout mode.
    const gitOps = async () => {
      if (!(await sharedCheckoutIsSafe(task, group))) {
        throw new Error('Unexpected shared checkout state; checkpoint aborted');
      }
      const checkpointOk = task.branch_name
        ? await commitTaskBranch(task, group)
        : (await checkpointTaskDefaultBranch(task, group)).mergeOk;
      if (!checkpointOk) {
        throw new Error('Unable to checkpoint task changes');
      }
    };
    void (async () => {
      const activeRun = await getActiveRunForTask(task.id);
      if (activeRun?.status === 'running') {
        // The task execution already owns the project lease. Re-entering the
        // lease here would deadlock after expired-owner takeover was hardened.
        await withProjectGitLock(task.project_id, gitOps);
        return;
      }
      const lease = await acquireSharedCheckoutLease(task.project_id, {
        type: 'task',
        id: task.id,
      });
      try {
        await withProjectGitLock(task.project_id, gitOps);
      } finally {
        await lease.release();
      }
    })().catch((err) =>
      logger.warn({ err }, 'shared checkout ops failed on stage transition'),
    );
  }
}

// ---------------------------------------------------------------------------
// Default-branch sync (ahead/behind, fetch, ff-only pull)
// ---------------------------------------------------------------------------

/**
 * Board-owned remote name for the tracking ref of the default branch. The
 * project's remote is addressed by URL (like the push route), so no
 * `origin` configuration is assumed or modified.
 */
const DEFAULT_BRANCH_SYNC_REMOTE = 'carapa-sync';

function defaultBranchSyncRefs(branch: string) {
  return {
    local: `refs/heads/${branch}`,
    tracking: `refs/remotes/${DEFAULT_BRANCH_SYNC_REMOTE}/${branch}`,
  };
}

export interface DefaultBranchSyncStatus {
  available: boolean;
  reason?: 'no-repository-url' | 'no-local-branch';
  branch: string;
  ahead: number;
  behind: number;
  /** False until the first fetch has created the tracking ref. */
  fetched: boolean;
  /** Whether a fast-forward pull of the shared checkout is possible now. */
  canPull: boolean;
  pullBlockedReason?: string;
}

/**
 * Ahead/behind of the local default branch against its Board-owned tracking
 * ref, plus whether the shared checkout can fast-forward. Local git only —
 * never touches the network, so counts reflect the last fetch.
 */
export async function getDefaultBranchSyncStatus(
  group: RegisteredGroup,
  branch: string,
  instance?: string | null,
  runGit: GitRunner = runGitInRepo,
): Promise<DefaultBranchSyncStatus> {
  const { local, tracking } = defaultBranchSyncRefs(branch);
  const base = { branch, ahead: 0, behind: 0, fetched: false, canPull: false };
  if (!group.settings?.repositoryUrl?.trim()) {
    return { ...base, available: false, reason: 'no-repository-url' };
  }
  // for-each-ref succeeds with no row for a missing ref, so a failure here is
  // a real git/sandbox error rather than "not fetched yet".
  const [refsRes, headRes] = await Promise.all([
    runGit(
      group,
      `for-each-ref --format='%(refname)' ${shellQuote(local)} ${shellQuote(tracking)}`,
      instance,
    ),
    runGit(group, 'symbolic-ref --quiet HEAD', instance),
  ]);
  if (!refsRes.ok) {
    throw new Error(
      refsRes.output.trim() || 'Could not read the default branch refs',
    );
  }
  const refs = refsRes.output.trim().split('\n');
  if (!refs.includes(local)) {
    return { ...base, available: false, reason: 'no-local-branch' };
  }
  if (!refs.includes(tracking)) {
    return {
      ...base,
      available: true,
      pullBlockedReason: 'Fetch first: the remote branch has not been fetched',
    };
  }
  const counts = await runGit(
    group,
    `rev-list --left-right --count ${shellQuote(`${local}...${tracking}`)}`,
    instance,
  );
  const [ahead, behind] = counts.output.trim().split(/\s+/).map(Number);
  if (!counts.ok || !Number.isInteger(ahead) || !Number.isInteger(behind)) {
    throw new Error(
      counts.output.trim() || 'Could not compare with the remote branch',
    );
  }
  const result = { ...base, available: true, fetched: true, ahead, behind };
  const blocked = async (): Promise<string | undefined> => {
    if (!headRes.ok || headRes.output.trim() !== local)
      return `Switch the shared checkout to "${branch}" to pull`;
    if (ahead > 0 && behind > 0)
      return 'Local and remote have diverged; fast-forward is not possible';
    if (behind === 0) return 'Already up to date';
    const status = await runGit(
      group,
      'status --porcelain=v1 --untracked-files=all',
      instance,
    );
    if (!status.ok) return 'Could not read the checkout status';
    if (status.output.trim())
      return 'Commit or discard uncommitted changes in the shared checkout to pull';
    return undefined;
  };
  const pullBlockedReason = await blocked();
  return pullBlockedReason
    ? { ...result, pullBlockedReason }
    : { ...result, canPull: true };
}

/** Fetch the default branch from `repositoryUrl` into the tracking ref. */
export async function fetchDefaultBranch(
  group: RegisteredGroup,
  branch: string,
  repositoryUrl: string,
  instance?: string | null,
  runGit: GitRunner = runGitInRepo,
): Promise<{ ok: boolean; output: string }> {
  const { local, tracking } = defaultBranchSyncRefs(branch);
  return runGit(
    group,
    `fetch --no-tags -- ${shellQuote(repositoryUrl)} ${shellQuote(`+${local}:${tracking}`)}`,
    instance,
    { waitForCompletion: true },
  );
}

/**
 * Fetch, then fast-forward the shared checkout to the fetched default branch.
 * Refuses (without touching the tree) unless the status guard allows a pull.
 */
export async function pullDefaultBranchFastForward(
  group: RegisteredGroup,
  branch: string,
  repositoryUrl: string,
  instance?: string | null,
  runGit: GitRunner = runGitInRepo,
): Promise<{ ok: boolean; output: string }> {
  const fetched = await fetchDefaultBranch(
    group,
    branch,
    repositoryUrl,
    instance,
    runGit,
  );
  if (!fetched.ok) return fetched;
  const status = await getDefaultBranchSyncStatus(
    group,
    branch,
    instance,
    runGit,
  );
  if (!status.canPull) {
    return {
      ok: false,
      output: status.pullBlockedReason ?? 'Pull is not possible',
    };
  }
  return runGit(
    group,
    `merge --ff-only ${shellQuote(defaultBranchSyncRefs(branch).tracking)}`,
    instance,
    { waitForCompletion: true },
  );
}

/**
 * Pushing to a URL leaves tracking refs untouched; point the tracking ref at
 * the pushed commit so ahead/behind is correct without another fetch.
 */
export async function recordPushedDefaultBranch(
  group: RegisteredGroup,
  branch: string,
  commitSha: string,
  instance?: string | null,
  runGit: GitRunner = runGitInRepo,
): Promise<{ ok: boolean; output: string }> {
  return runGit(
    group,
    `update-ref ${shellQuote(defaultBranchSyncRefs(branch).tracking)} ${shellQuote(commitSha)}`,
    instance,
  );
}

// ---------------------------------------------------------------------------
// Update a conversation worktree from the local default branch
// ---------------------------------------------------------------------------

/**
 * Commits on the local default branch that the worktree branch lacks
 * (`<branch>..<base>`). Local git only; undefined when the refs cannot be
 * compared (for example the default branch does not exist locally).
 */
export async function countCommitsBehindDefaultBranch(
  group: RegisteredGroup,
  branch: string,
  base: string,
  instance?: string | null,
  runGit: GitRunner = runGitInRepo,
): Promise<number | undefined> {
  const res = await runGit(
    group,
    `rev-list --count ${shellQuote(`${branch}..${base}`)}`,
    instance,
  );
  const count = Number(res.output.trim());
  return res.ok && Number.isInteger(count) && count >= 0 ? count : undefined;
}

export type WorktreeUpdateResult =
  | { status: 'updated' | 'up-to-date' | 'dirty' | 'error'; output: string }
  | { status: 'conflict'; output: string; conflicts: string[] };

/**
 * Merge the local default branch into a conversation worktree. Refuses a
 * dirty worktree, and aborts a conflicting merge so the worktree is left
 * exactly as it was. Callers must hold the project git lock.
 */
export async function updateWorktreeFromDefaultBranch(
  group: RegisteredGroup,
  branch: string,
  base: string,
  instance?: string | null,
  runGit: GitRunner = runGitInRepo,
): Promise<WorktreeUpdateResult> {
  const prefix = `-C ${shellQuote(`.worktrees/${branch}`)} `;
  const status = await runGit(
    group,
    `${prefix}status --porcelain=v1 --untracked-files=all`,
    instance,
  );
  if (!status.ok) return { status: 'error', output: status.output };
  if (status.output.trim()) return { status: 'dirty', output: status.output };

  const behind = await countCommitsBehindDefaultBranch(
    group,
    branch,
    base,
    instance,
    runGit,
  );
  if (behind === undefined) {
    return {
      status: 'error',
      output: `Could not compare ${branch} with ${base}`,
    };
  }
  if (behind === 0) return { status: 'up-to-date', output: '' };

  const merge = await runGit(
    group,
    `${prefix}merge --no-edit ${shellQuote(base)}`,
    instance,
    { waitForCompletion: true },
  );
  if (merge.ok) return { status: 'updated', output: merge.output };

  const unmerged = await runGit(
    group,
    `${prefix}diff --name-only --diff-filter=U`,
    instance,
  );
  const conflicts = unmerged.ok
    ? unmerged.output.split('\n').filter(Boolean)
    : [];
  const abort = await runGit(group, `${prefix}merge --abort`, instance, {
    waitForCompletion: true,
  });
  if (!abort.ok && conflicts.length > 0) {
    return {
      status: 'error',
      output: `${merge.output}\nmerge --abort failed: ${abort.output}`.trim(),
    };
  }
  return conflicts.length > 0
    ? { status: 'conflict', output: merge.output, conflicts }
    : { status: 'error', output: merge.output };
}
