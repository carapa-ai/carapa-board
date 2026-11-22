import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import type {
  RegisteredGroup,
  TaskDefaultBranchStatus,
  TaskDefaultBranchMerge,
} from '../types.js';
import type { Task } from '../modules/kanban/types.js';
import { shellQuote } from '../utils.js';
import {
  runGitInRepo,
  taskUsesWorktree,
  validatedInstance,
} from './git-ops.js';
import { sleep } from './async.js';

/** Keep the sandbox result recoverable when the transport loses its response. */
async function runRecoverableMerge(
  group: RegisteredGroup,
  instance: string,
  script: string,
  recovery: { reconcile: string; sourceCommit: string; taskHead: string },
): Promise<{ ok: boolean; output: string }> {
  const receipt = `carapa-default-branch-${randomUUID()}`;
  const location = `
common=$(git rev-parse --path-format=absolute --git-common-dir) || exit 1
receipt="$common/${receipt}"
`;
  // Unlike a PID or a directory, this lock stays owned by surviving Git
  // children and is released by the kernel when the sandbox processes die.
  const lock = `
exec 9>"$receipt.lock" || exit 1
flock -n 9 || { printf 'Waiting for the accepted Git operation to settle.'; exit 1; }
`;
  const run = (body: string) =>
    runGitInRepo(
      group,
      `-c alias.carapa-default-branch=${shellQuote(`!${body}`)} carapa-default-branch`,
      instance,
      { waitForCompletion: true },
    );
  let result = await run(`
command -v flock >/dev/null || { printf 'carapa-operation\\0%s\\0%s' 1 'Sandbox flock is unavailable; no merge was started.'; exit 0; }
${location}
${lock}
# Recovery can reserve this name first, fencing a request that arrives late.
mkdir "$receipt" 2>/dev/null || exit 1
(
${script}
) > "$receipt/output" 2>&1
code=$?
{ printf 'carapa-operation\\0%s\\0' "$code"; cat "$receipt/output"; } > "$receipt/result.tmp"
mv "$receipt/result.tmp" "$receipt/result" || exit 1
cat "$receipt/result"
`);
  // Never replay the mutation or infer a no-op from the current branch count.
  // A receipt is published only after Git has settled. If observation is also
  // unavailable, retain the caller's admission/lock and retry observation.
  let recovered = false;
  while (!result.ok || !/^carapa-operation\0\d+\0/.test(result.output)) {
    logger.warn(
      { project: group.folder, receipt, error: result.output },
      '[git] recovering default-branch merge response; coordination retained',
    );
    if (recovered) await sleep(1000);
    recovered = true;
    result = await run(`
${location}
${lock}
if [ ! -f "$receipt/result" ]; then
  # Exclusive ownership proves no producer or Git child is still running.
  # Keep the directory claim to fence a producer delayed before lock acquisition.
  mkdir -p "$receipt" || exit 1
  touch "$receipt/cancelled" || exit 1
  if [ ! -f "$receipt/attempt" ]; then
    printf 'carapa-operation\\0%s\\0%s' 1 'Merge request was not started. Refresh before retrying.' > "$receipt/result.tmp"
  else
    (
${recovery.reconcile}
    ) > "$receipt/output" 2>&1
    if [ "$?" = 0 ]; then
      { printf 'carapa-operation\\0%s\\0' 0; cat "$receipt/output"; } > "$receipt/result.tmp"
    else
      printf 'carapa-operation\\0%s\\0carapa-merge\\0%s\\0%s\\0interrupted\\0%s\\0' 0 ${shellQuote(recovery.sourceCommit)} ${shellQuote(recovery.taskHead)} "Git was interrupted and inspection failed: $(cat "$receipt/output"). Inspect the worktree before retrying." > "$receipt/result.tmp"
    fi
  fi
  mv "$receipt/result.tmp" "$receipt/result" || exit 1
fi
[ -f "$receipt/result" ] || { printf 'Waiting for the accepted Git operation to settle.'; exit 1; }
cat "$receipt/result"
`);
  }
  const [, code, ...output] = result.output.split('\0');
  // Only a confirmed result can be discarded. Retain cancelled claim names:
  // removing one would let the original delayed request start a merge later.
  await run(`
${location}
rm -f "$receipt/output" "$receipt/result" "$receipt/attempt"
if [ ! -f "$receipt/cancelled" ]; then rmdir "$receipt" && rm -f "$receipt.lock"; fi
`);
  return { ok: code === '0', output: output.join('\0') };
}

/** Runs wholly inside the repository's sandbox, including filesystem checks. */
export async function runTaskDefaultBranchOperation(
  group: RegisteredGroup,
  task: Task,
  expected?: { sourceCommit: string; taskHead: string },
): Promise<TaskDefaultBranchStatus | TaskDefaultBranchMerge> {
  const defaultBranch = group.settings?.defaultBranch || 'develop';
  const unavailable = (reason: string): TaskDefaultBranchStatus => ({
    available: false,
    defaultBranch,
    reason,
  });
  if (!taskUsesWorktree(group))
    return unavailable(
      'Default-branch integration requires worktree checkout mode.',
    );
  if (
    !group.settings?.repositoryLocation &&
    !group.settings?.repositoryRelativePath
  )
    return unavailable('No repository configured.');
  // Only the branch is required: the inspect script derives the checkout as
  // `.worktrees/<branch>` and reports a missing folder itself, so a cleared
  // `worktree_path` must not hide integration for a card that kept its branch.
  if (!task.branch_name) return unavailable('The task has no branch.');
  if (task.branch_name === defaultBranch)
    return unavailable('The task branch must differ from the default branch.');

  // A shell alias is the existing sandboxGit boundary for compound inspection.
  // Every input is quoted, refs are checked before becoming paths, and the
  // physical checkout and common Git directory must match this repository.
  const taskBranch = task.branch_name;
  // MERGE_HEAD still needs a commit even when rerere has staged every
  // resolution. Use the same classification after execution and recovery.
  const pendingMergeOutcome = `
if [ -n "$unmerged" ]; then outcome=conflicted; else outcome=uncommitted; fi
`;
  const inspect = (sourceRef: string) => `
fail() { printf '%s' "$1"; exit 1; }
branch=${shellQuote(taskBranch)}
base=${shellQuote(defaultBranch)}
git check-ref-format "refs/heads/$branch" >/dev/null 2>&1 || fail 'Invalid task branch.'
git check-ref-format "refs/heads/$base" >/dev/null 2>&1 || fail 'Invalid default branch.'
root=$(git rev-parse --show-toplevel) || fail 'Repository unavailable.'
common=$(git rev-parse --path-format=absolute --git-common-dir) || fail 'Repository unavailable.'
cd "$root/.worktrees/$branch" 2>/dev/null || fail 'Task worktree is missing. Restore its owned worktree before merging.'
[ "$(pwd -P)" = "$root/.worktrees/$branch" ] || fail 'Task worktree path does not match its owned checkout.'
[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || fail 'Task worktree is not a Git checkout.'
[ "$(git rev-parse --path-format=absolute --git-common-dir)" = "$common" ] || fail 'Task checkout belongs to a different repository.'
git rev-parse --verify "refs/heads/$branch^{commit}" >/dev/null || fail 'Task branch is unavailable.'
source=$(git rev-parse --verify ${shellQuote(`${sourceRef}^{commit}`)}) || fail 'Local source commit is unavailable.'
head=$(git rev-parse --verify HEAD) || fail 'Task HEAD is unavailable.'
count=$(git rev-list --count "$head..$source") || fail 'Could not count default-branch updates.'
state=ready
merge_head=$(git rev-parse -q --verify MERGE_HEAD 2>/dev/null) || merge_head=
merge_dir=$(git rev-parse --git-path rebase-merge) || fail 'Could not inspect rebase state.'
apply_dir=$(git rev-parse --git-path rebase-apply) || fail 'Could not inspect rebase state.'
if [ -n "$merge_head" ] || [ -d "$merge_dir" ] || [ -d "$apply_dir" ]; then state=unresolved; fi
checkout=$(git symbolic-ref -q HEAD) || checkout=
if [ "$checkout" != "refs/heads/$branch" ]; then
  rebase_branch=
  if [ -f "$merge_dir/head-name" ]; then rebase_branch=$(cat "$merge_dir/head-name");
  elif [ -f "$apply_dir/head-name" ]; then rebase_branch=$(cat "$apply_dir/head-name"); fi
  [ "$rebase_branch" = "refs/heads/$branch" ] || fail 'Task worktree is not on its task branch.'
fi
unmerged=$(git ls-files -u) || fail 'Could not inspect conflict state.'
if [ -n "$unmerged" ]; then state=unresolved; fi
dirty=$(git --no-optional-locks status --porcelain=v1 --untracked-files=all) || fail 'Could not inspect worktree changes.'
if [ "$state" = ready ] && [ -n "$dirty" ]; then state=dirty; fi
`;
  const script = `
${inspect(`refs/heads/${defaultBranch}`)}
${
  expected
    ? `
[ "$state" != unresolved ] || fail 'Finish or abort the existing merge/rebase before merging default-branch updates.'
[ "$state" != dirty ] || fail 'Commit or move tracked, staged, and untracked changes out of the task worktree before merging.'
if [ "$count" = 0 ]; then
  outcome=up-to-date
  detail=
else
  [ "$source" = ${shellQuote(expected.sourceCommit)} ] && [ "$head" = ${shellQuote(expected.taskHead)} ] || fail 'The default branch or task HEAD changed. Refresh before merging.'
  # Git checks and locks its index itself; admission does not pause agent writes.
  # Disable autostash even if the repository enables it.
  touch "$receipt/attempt" || fail 'Could not record the merge attempt; no merge was started.'
  if detail=$(git -c merge.autoStash=false merge --no-edit "$source" 2>&1); then
    outcome=merged
  else
    outcome=failed
  fi
  merge_head=$(git rev-parse -q --verify MERGE_HEAD 2>/dev/null) || merge_head=
  if [ "$merge_head" = "$source" ]; then
    if unmerged=$(git ls-files -u); then
      ${pendingMergeOutcome}
    else
      outcome=interrupted
      detail='The merge is unfinished, but its conflict state could not be inspected. Inspect the worktree before continuing.'
    fi
  fi
fi
printf 'carapa-merge\\0%s\\0%s\\0%s\\0%s\\0' "$source" "$head" "$outcome" "$detail"
`
    : `printf 'carapa-status\\0%s\\0%s\\0%s\\0%s\\0' "$source" "$head" "$count" "$state"`
}
git diff --name-only --diff-filter=U -z
`;
  const instance = validatedInstance(task, group) || group.folder;
  const result = expected
    ? await runRecoverableMerge(group, instance, script, {
        ...expected,
        reconcile: `
${inspect(expected.sourceCommit)}
outcome=interrupted
detail='Git was interrupted. Inspect the retained index, files, and merge state before retrying; finish/commit the merge when needed.'
if [ "$checkout" = "refs/heads/$branch" ] && git merge-base --is-ancestor "$source" "$head" && git merge-base --is-ancestor ${shellQuote(expected.taskHead)} "$head"; then
  outcome=merged
  detail=
elif [ "$merge_head" = "$source" ]; then
  ${pendingMergeOutcome}
  detail=
elif [ "$head" = ${shellQuote(expected.taskHead)} ] && [ "$state" = ready ] && [ ! -f "$(git rev-parse --git-path index.lock)" ]; then
  outcome=failed
  detail='Git was interrupted without merging updates. The task HEAD and worktree are unchanged; refresh before retrying.'
fi
printf 'carapa-merge\\0%s\\0%s\\0%s\\0%s\\0' "$source" ${shellQuote(expected.taskHead)} "$outcome" "$detail"
git diff --name-only --diff-filter=U -z
`,
      })
    : await runGitInRepo(
        group,
        `-c alias.carapa-default-branch=${shellQuote(`!${script}`)} carapa-default-branch`,
        instance,
      );
  if (!result.ok)
    return unavailable(result.output || 'Could not inspect the task worktree.');
  const [tag, sourceCommit, taskHead, value, detail, ...paths] =
    result.output.split('\0');
  const conflictedPaths = paths.filter(Boolean);
  if (
    tag === 'carapa-merge' &&
    [
      'merged',
      'conflicted',
      'uncommitted',
      'up-to-date',
      'failed',
      'interrupted',
    ].includes(value)
  ) {
    return {
      defaultBranch,
      sourceCommit,
      taskHead,
      outcome: value as TaskDefaultBranchMerge['outcome'],
      conflictedPaths,
      ...(value === 'failed' || value === 'interrupted'
        ? {
            error:
              detail ||
              'Git merge failed. Inspect the task worktree before retrying.',
          }
        : {}),
    };
  }
  if (
    tag !== 'carapa-status' ||
    !/^\d+$/.test(value) ||
    !['ready', 'dirty', 'unresolved'].includes(detail)
  )
    return unavailable(
      'Could not read task integration status. Inspect the worktree before retrying.',
    );
  return {
    available: true,
    defaultBranch,
    sourceCommit,
    taskHead,
    commitsBehind: Number(value),
    state: detail as 'ready' | 'dirty' | 'unresolved',
    conflictedPaths,
  };
}
