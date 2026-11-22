/**
 * Warn when a dependency is added to a task whose branch/worktree already
 * exists. The launch guard in the sandbox runner stays fail-closed and rejects
 * a checkout that lacks a dependency commit; this surfaces the same problem at
 * edit time, while stop -> add dependency -> Start over is still possible.
 */
import type { RegisteredGroup } from '../../../types.js';
import type { Task } from '../types.js';
import { getTask } from '../../../db.js';
import { logger } from '../../../logger.js';
import { runGitInRepo, taskUsesBranch } from '../../../lib/git-ops.js';
import { appendTaskMessage } from '../../transcripts/transcript-store.js';
import { broadcast } from '../../objectives/ws-events.js';
import { findStage, getGroupStages } from '../stages.js';
import { taskSandboxGitRunner } from './pipeline.js';

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

async function uncontainedDependencyWarning(
  task: Task,
  group: RegisteredGroup,
  depId: string,
  runGit: typeof runGitInRepo,
): Promise<string | undefined> {
  const declared = await getTask(depId);
  if (!declared) return undefined;
  const branch = task.branch_name || `task-${task.id}`;
  const defaultBranch = group.settings?.defaultBranch || 'develop';
  // An unfinished dependency has no integrated result yet, and the queue holds
  // the task until it is done, even if Testing already recorded a head commit.
  // The next launch still reuses this branch, which cannot contain a result
  // that does not exist yet, so the launch guard would fail it.
  if (findStage(getGroupStages(group), declared.status)?.type !== 'done') {
    const head = await runGit(group, `rev-parse --verify ${branch}^{commit}`);
    if (!head.ok || !FULL_COMMIT.test(head.output.trim())) {
      logger.debug(
        { taskId: task.id, depId },
        '[dependency-warning] branch lookup inconclusive; skipping warning',
      );
      return undefined;
    }
    return `Dependency ${depId} ("${declared.title}") is not finished yet and this task's branch ${branch} already exists, so it cannot contain the dependency's result. After ${depId} finishes, use Start over (or merge ${defaultBranch} into the task branch) before this task runs again. If this work should not wait on the existing branch, remove the dependency and create a new task instead.`;
  }
  // Same resolution as resolveDependencyCheckout: an A/B parent's content is
  // its picked winner's, and the tested/completed commit outranks merge_commit.
  const dependency =
    (declared.ab_winner_task_id
      ? await getTask(declared.ab_winner_task_id)
      : undefined) ?? declared;
  const values = dependency.custom_values ?? {};
  const recorded =
    typeof values.testing_head_sha === 'string'
      ? values.testing_head_sha
      : typeof values.completed_commit_sha === 'string'
        ? values.completed_commit_sha
        : dependency.merge_commit;
  if (!recorded) return undefined;

  const commit = await runGit(group, `rev-parse --verify ${recorded}^{commit}`);
  const head = await runGit(group, `rev-parse --verify ${branch}^{commit}`);
  const commitSha = commit.output.trim();
  const headSha = head.output.trim();
  // Count the dependency commits missing from the branch head. Unlike
  // `merge-base --is-ancestor`, this exits 0 for both answers, so a git or
  // sandbox failure is distinguishable from confirmed missing ancestry.
  const missing =
    commit.ok &&
    head.ok &&
    FULL_COMMIT.test(commitSha) &&
    FULL_COMMIT.test(headSha)
      ? await runGit(group, `rev-list --count ${headSha}..${commitSha}`)
      : undefined;
  if (!missing?.ok || !/^\d+$/.test(missing.output.trim())) {
    logger.debug(
      { taskId: task.id, depId },
      '[dependency-warning] ancestry check inconclusive; skipping warning',
    );
    return undefined;
  }
  if (missing.output.trim() === '0') return undefined;

  return `Dependency ${depId} ("${declared.title}") is not contained in this task's branch ${branch}: the branch predates it, so the next launch will fail. Use Start over, or merge ${defaultBranch} into the task branch.`;
}

/**
 * Returns a warning per newly added dependency of a started task whose
 * recorded commit is not contained in the task branch, and posts them as one
 * system notice on the task. Never throws: a git or lookup failure yields no
 * warning so the update that triggered the check still succeeds.
 */
export async function warnOnUncontainedDependencies(
  task: Task,
  group: RegisteredGroup | undefined,
  nextDependsOnIds: readonly string[] | undefined,
  runGit: typeof runGitInRepo = runGitInRepo,
): Promise<string[]> {
  if (!group || !nextDependsOnIds) return [];
  if (!task.branch_name && !task.worktree_path) return [];
  // Same exemptions as resolveDependencyCheckout: no launch guard applies to
  // an A/B fork or to a project that does not use task branches.
  if (!taskUsesBranch(group)) return [];
  if (task.ab_fork_commit) return [];
  const existing = new Set(task.depends_on_ids ?? []);
  const added = [...new Set(nextDependsOnIds)].filter(
    (id) => !existing.has(id),
  );
  if (added.length === 0) return [];
  const taskGit = taskSandboxGitRunner(task, runGit);
  const warnings: string[] = [];
  try {
    if (
      task.ab_parent_task_id &&
      (await getTask(task.ab_parent_task_id))?.ab_fork_commit
    )
      return [];
    for (const depId of added) {
      const warning = await uncontainedDependencyWarning(
        task,
        group,
        depId,
        taskGit,
      );
      if (warning) warnings.push(warning);
    }
    if (warnings.length > 0) {
      const message = appendTaskMessage(task.project_id, {
        task_id: task.id,
        role: 'system',
        entry_type: 'system_notice',
        content: `**Dependency added to a started task**\n\n${warnings
          .map((warning) => `- ${warning}`)
          .join('\n')}`,
        created_at: new Date().toISOString(),
      });
      broadcast({
        type: 'task_message',
        payload: { task_id: task.id, project_id: task.project_id, message },
      });
    }
  } catch (error) {
    logger.debug(
      { taskId: task.id, error: String(error) },
      '[dependency-warning] containment check failed; skipping warning',
    );
    return [];
  }
  return warnings;
}
