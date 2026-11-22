import path from 'node:path';
import type { RegisteredGroup } from '../types.js';
import type { ContainerInput } from './process.js';
import type { SandboxClient } from '../lib/mcp-client.js';
import {
  effectiveGitArgs,
  effectiveRemoteUrl,
  resolveEffectiveSandbox,
} from './effective-settings.js';
type ResolvedSandbox = ReturnType<typeof resolveEffectiveSandbox>;
import { updateTask, updateConversationWorktreePath } from '../db.js';
import { acquireSharedCheckoutLease } from '../concurrency/shared-checkout-lease.js';
import { withProjectGitLock } from '../lib/git-ops.js';

export const ISOLATED_WORKTREE_REQUIRED_ERROR =
  'An isolated task worktree is required but none could be prepared (a local repository is needed to create worktrees); refusing to use the shared checkout.';

/**
 * Launch error for a required dependency commit missing from the task
 * checkout. Names the dependency (when known) and the remedy.
 */
export function dependencyCommitMissingMessage(
  input: Pick<ContainerInput, 'dependencyByCommit'>,
  commit: string,
  checkoutLabel: 'task checkout' | 'direct task checkout',
  defaultBranch: string,
): string {
  const dependency = input.dependencyByCommit?.[commit];
  const subject = dependency
    ? `Dependency ${dependency.id} ("${dependency.title}") commit ${commit}`
    : `Dependency commit ${commit}`;
  return `${subject} is not present in the ${checkoutLabel}: the task branch predates this dependency. Use Start over, or merge ${defaultBranch} into the task branch.`;
}

/** True for the launch error `dependencyCommitMissingMessage` produces. */
export function isDependencyCommitMissingError(error: string): boolean {
  return / is not present in the (?:direct )?task checkout: /.test(error);
}

export function branchCheckoutStateIsSafe(
  status: { stdout: string; isError: boolean },
  branch: { stdout: string; isError: boolean },
  defaultBranch: string,
  taskBranch: string,
): boolean {
  if (status.isError || branch.isError) return false;
  const currentBranch = branch.stdout.trim();
  if (currentBranch === taskBranch) return true;
  return currentBranch === defaultBranch && status.stdout.trim() === '';
}

function listedWorktreePathForBranch(
  output: string,
  branch: string,
): string | undefined {
  for (const block of output.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    // A registered path can outlive the sandbox/container filesystem that held
    // it. Git reports that record as prunable; treating it as live restores a
    // path that does not exist and skips the idempotent worktree repair path.
    if (lines.some((line) => line.startsWith('prunable'))) continue;
    const listedBranch = lines
      .find((line) => line.startsWith('branch '))
      ?.slice('branch '.length)
      .replace(/^refs\/heads\//, '')
      .trim();
    const listedPath = lines
      .find((line) => line.startsWith('worktree '))
      ?.slice('worktree '.length)
      .trim();
    if (listedBranch === branch && listedPath?.includes('/.worktrees/')) {
      return listedPath;
    }
  }
  return undefined;
}

export async function recoverExistingWorktreePath(
  group: RegisteredGroup,
  input: ContainerInput,
  client: SandboxClient,
  effectiveSandbox: ResolvedSandbox,
  stack: string,
  service: string,
  instance: string,
): Promise<boolean> {
  if (
    input.worktree_path ||
    !input.branch_name ||
    (group.settings?.taskCheckoutMode !== 'worktree' &&
      !input.worktreeRequested)
  ) {
    return false;
  }
  const listed = await client.sandboxWorktree(stack, 'list', {
    instance,
    localRepo: input.localRepo,
    repoPath: effectiveSandbox.inherited
      ? effectiveSandbox.workspaceRoot
      : undefined,
    service,
    remoteUrl: effectiveRemoteUrl(effectiveSandbox),
  });
  if (listed.isError) return false;
  const containerPath = listedWorktreePathForBranch(
    listed.stdout,
    input.branch_name,
  );
  if (!containerPath) return false;

  const marker = '/.worktrees/';
  const containerRepo = containerPath.slice(0, containerPath.indexOf(marker));
  const relativeRepo = path.posix.relative(
    effectiveSandbox.containerWorkspaceRoot,
    containerRepo,
  );
  const hostRoot = effectiveSandbox.hostWorkspaceLocation || input.localRepo;
  const hostPath =
    hostRoot &&
    relativeRepo !== '..' &&
    !relativeRepo.startsWith('../') &&
    !path.posix.isAbsolute(relativeRepo)
      ? path.join(hostRoot, relativeRepo, '.worktrees', input.branch_name)
      : containerPath;

  input.worktree_path = hostPath;
  input.skipBaseBranchSync = true;
  if (input.task_id) {
    await updateTask(input.task_id, { worktree_path: hostPath });
  } else if (input.checkoutConversationId || input.conversation_id) {
    await updateConversationWorktreePath(
      (input.checkoutConversationId || input.conversation_id)!,
      hostPath,
    );
  }
  return true;
}

export async function prepareDirectTaskCheckout(
  group: RegisteredGroup,
  input: ContainerInput,
  client: SandboxClient,
  effectiveSandbox: ResolvedSandbox,
  stack: string,
  service: string,
  instance: string,
): Promise<void> {
  const hasTaskCheckout =
    !!input.branch_name &&
    (group.settings?.taskCheckoutMode === 'branch' ||
      group.settings?.taskCheckoutMode === 'worktree' ||
      !!input.worktreeRequested);
  if (!hasTaskCheckout) return;

  await recoverExistingWorktreePath(
    group,
    input,
    client,
    effectiveSandbox,
    stack,
    service,
    instance,
  );

  const defaultBranch = group.settings?.defaultBranch || 'develop';
  const baseRef =
    input.branchBaseCommit || input.branchBaseName || defaultBranch;
  const usesWorktree =
    group.settings?.taskCheckoutMode === 'worktree' ||
    input.worktreeRequested === true;
  const mutatesMainCheckout =
    !usesWorktree && !input.skipBaseBranchSync && !input.worktree_path;
  const lease =
    input.task_id && mutatesMainCheckout && !input.skipSharedCheckoutLease
      ? await acquireSharedCheckoutLease(input.group_folder, {
          type: 'task',
          id: input.task_id,
        })
      : undefined;
  const leaseHeartbeat = lease
    ? setInterval(() => {
        void lease.heartbeat();
      }, 10_000)
    : undefined;
  // skipSharedCheckoutLease is also used when the caller already holds the
  // project lease for the whole task pipeline. That caller retains heartbeat
  // and release responsibility, but this preparation still owns any checkout
  // mutation it performs while the caller's lease is held.
  const hasCallerOwnedLease =
    mutatesMainCheckout && input.skipSharedCheckoutLease === true;
  let checkoutSucceeded = false;
  let mainCheckoutChanged = false;
  let expectedMainCheckoutBranch: string | undefined;
  try {
    await withProjectGitLock(input.group_folder, async () => {
      let reuseExistingTaskBranch = false;
      if (!usesWorktree && !input.skipBaseBranchSync && !input.worktree_path) {
        const status = await client.sandboxGit(
          stack,
          effectiveGitArgs(effectiveSandbox, 'status --porcelain=v1'),
          instance,
          service,
        );
        const branch = await client.sandboxGit(
          stack,
          effectiveGitArgs(effectiveSandbox, 'branch --show-current'),
          instance,
          service,
        );
        if (
          !branchCheckoutStateIsSafe(
            status,
            branch,
            defaultBranch,
            input.branch_name!,
          )
        ) {
          throw new Error(
            `Shared checkout drift detected before direct task checkout (branch=${branch.stdout.trim() || 'detached'})`,
          );
        }
        reuseExistingTaskBranch = branch.stdout.trim() === input.branch_name;
        // Branch-only mode uses the existing local base. Remote credentials
        // are not required merely to isolate a task in a local branch.
        if (
          group.settings?.taskCheckoutMode === 'worktree' ||
          input.worktreeRequested
        ) {
          const fetched = await client.sandboxGit(
            stack,
            effectiveGitArgs(effectiveSandbox, 'fetch origin'),
            instance,
            service,
            { remoteUrl: effectiveRemoteUrl(effectiveSandbox) },
          );
          if (fetched.isError)
            throw new Error(`Unable to fetch base branch ${defaultBranch}`);
          const pulled = await client.sandboxGit(
            stack,
            effectiveGitArgs(effectiveSandbox, `pull origin ${defaultBranch}`),
            instance,
            service,
            { remoteUrl: effectiveRemoteUrl(effectiveSandbox) },
          );
          if (pulled.isError)
            throw new Error(`Unable to update base branch ${defaultBranch}`);
        }
      }

      if (
        usesWorktree &&
        !input.worktree_path &&
        !input.localRepo &&
        input.requireIsolatedWorktree
      ) {
        throw new Error(ISOLATED_WORKTREE_REQUIRED_ERROR);
      }
      if (usesWorktree && !input.worktree_path && input.localRepo) {
        const result = await client.sandboxWorktree(stack, 'add', {
          branch: input.branch_name!,
          // Conversation worktrees intentionally use the current HEAD. A
          // task may supply an explicit dependency/default-branch base.
          base: input.task_id ? baseRef : undefined,
          instance,
          localRepo: input.localRepo,
          repoPath: effectiveSandbox.inherited
            ? effectiveSandbox.workspaceRoot
            : undefined,
          symlinkFiles: input.worktreeFiles,
          service,
          remoteUrl: effectiveRemoteUrl(effectiveSandbox),
        });
        if (result.isError)
          throw new Error(
            `Worktree creation failed for branch "${input.branch_name}": ${result.stdout}`,
          );
        const pathMatch = result.stdout.match(/^worktree_path=(.+)$/m)?.[1];
        if (!pathMatch)
          throw new Error('Worktree creation returned no worktree_path');
        if (pathMatch) {
          input.worktree_path = pathMatch;
          if (input.task_id) {
            await updateTask(input.task_id, { worktree_path: pathMatch });
          } else if (input.checkoutConversationId || input.conversation_id) {
            await updateConversationWorktreePath(
              (input.checkoutConversationId || input.conversation_id)!,
              pathMatch,
            );
          }
        }
      } else if (!usesWorktree && !reuseExistingTaskBranch) {
        const checkout = await client.sandboxGit(
          stack,
          effectiveGitArgs(effectiveSandbox, `checkout ${baseRef}`),
          instance,
          service,
        );
        if (checkout.isError)
          throw new Error(`Unable to checkout base ${baseRef}`);
        if (baseRef !== defaultBranch) {
          mainCheckoutChanged = true;
          expectedMainCheckoutBranch = input.branchBaseCommit ? '' : baseRef;
        }
        const taskCheckout = await client.sandboxGit(
          stack,
          effectiveGitArgs(effectiveSandbox, `checkout ${input.branch_name!}`),
          instance,
          service,
        );
        if (taskCheckout.isError) {
          const created = await client.sandboxGit(
            stack,
            effectiveGitArgs(
              effectiveSandbox,
              `checkout -b ${input.branch_name!}`,
            ),
            instance,
            service,
          );
          if (created.isError)
            throw new Error(
              `Unable to create task branch ${input.branch_name}`,
            );
        }
        mainCheckoutChanged = true;
        expectedMainCheckoutBranch = input.branch_name!;
      }

      const prefix = input.worktree_path
        ? `-C .worktrees/${input.branch_name} `
        : '';
      for (const commit of input.requiredDependencyCommits ?? []) {
        const check = await client.sandboxGit(
          stack,
          effectiveGitArgs(
            effectiveSandbox,
            `${prefix}merge-base --is-ancestor ${commit} HEAD`,
          ),
          instance,
          service,
        );
        if (check.isError)
          throw new Error(
            dependencyCommitMissingMessage(
              input,
              commit,
              'direct task checkout',
              defaultBranch,
            ),
          );
      }
    });
    checkoutSucceeded = true;
  } finally {
    clearInterval(leaseHeartbeat);
    try {
      if (
        !checkoutSucceeded &&
        mainCheckoutChanged &&
        expectedMainCheckoutBranch !== undefined &&
        (hasCallerOwnedLease ||
          (lease && (await lease.heartbeat().catch(() => false))))
      ) {
        await withProjectGitLock(input.group_folder, async () => {
          const status = await client.sandboxGit(
            stack,
            effectiveGitArgs(effectiveSandbox, 'status --porcelain=v1'),
            instance,
            service,
          );
          const branch = await client.sandboxGit(
            stack,
            effectiveGitArgs(effectiveSandbox, 'branch --show-current'),
            instance,
            service,
          );
          if (
            status.isError ||
            branch.isError ||
            status.stdout.trim() !== '' ||
            branch.stdout.trim() !== expectedMainCheckoutBranch
          ) {
            return;
          }
          await client.sandboxGit(
            stack,
            effectiveGitArgs(effectiveSandbox, `checkout ${defaultBranch}`),
            instance,
            service,
          );
        }).catch(() => undefined);
      }
    } finally {
      await lease?.release();
    }
  }
}
