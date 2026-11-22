import { getBoardBuildFailureProject } from '../../config.js';
import { logger, scrubSecretText } from '../../logger.js';
import { sha256Hex } from '../../lib/hash.js';
import { getGroupByFolder } from '../../state-manager.js';
import { getLastActiveRunForTask } from '../../db/active-runs.js';
import { appendTaskMessageDurableAsync } from '../transcripts/transcript-store.js';
import { extractBuildFailureLines } from '../../lib/server-web-build-status.js';
import { broadcast } from '../objectives/ws-events.js';
import {
  createTask,
  getTask,
  getTasksByProject,
  updateTask,
} from './db-kanban.js';
import {
  findStage,
  getFirstExecutableStage,
  getGroupStages,
  isActiveStage,
} from './stages.js';
import { appendTaskStagePrompt, drainProjectQueue } from './task-executor.js';

const FIX_INSTRUCTION =
  "Fix the cause on develop so this Docker build step passes; reproduce with the step's command in the coder sandbox.";
const STEP_COMMAND_TITLE_CHARS = 100;
const BUILD_FAILURE_MARKER = 'board_build_failure';
// Negative = ahead of every normal card, which are >= 0 (lower number first).
const BUILD_FAILURE_PRIORITY = -100;

/**
 * Stable fingerprint of failure lines: BuildKit step numbers, per-line
 * timestamps and elapsed-time summaries differ on every run of the same
 * failure, so they are removed before hashing.
 */
function failureFingerprint(lines: string[]): string {
  const stable = lines.map((line) =>
    line
      .replace(/^#\d+\s+(?:\d+(?:\.\d+)?\s+)?/, '')
      .replace(/\[\+\] Building \d+(?:\.\d+)?s(?: \([^)]*\))?/g, '[+] Building')
      .replace(/\b(DONE|CACHED)\s+\d+(?:\.\d+)?s\b/g, '$1'),
  );
  return sha256Hex(stable.join('\n')).slice(0, 12);
}

/**
 * Open (or update) a fix card in `BOARD_BUILD_FAILURE_PROJECT` for a failed
 * administrator-requested CarapaBoard build. Never throws: the build flow
 * must continue when the card cannot be created.
 */
export async function reportBuildFailureCard(
  output: string,
  userId: string,
): Promise<void> {
  const projectId = getBoardBuildFailureProject();
  if (!projectId) return;
  try {
    const group = getGroupByFolder(projectId);
    if (!group) throw new Error(`Project "${projectId}" not found`);
    const stages = getGroupStages(group);
    const stage = getFirstExecutableStage(stages);
    if (!stage) throw new Error(`Project "${projectId}" has no active stage`);

    // The log is scanned in full: BuildKit interleaves parallel stages, so
    // the real error can sit before the tail kept for the dialog.
    const lines = extractBuildFailureLines(output);
    const commit = output.match(/\bGIT_COMMIT=([0-9a-f]{7,40})\b/i)?.[1];
    const shortCommit = commit?.slice(0, 7) ?? 'unknown commit';
    const scrubbedOutput = scrubSecretText(output);
    const process = scrubbedOutput.match(
      /process "([^\r\n]*)" did not complete successfully/,
    )?.[1];
    const command = process
      ?.replace(/^\/bin\/sh -c /, '')
      .trim()
      .slice(0, STEP_COMMAND_TITLE_CHARS);
    const title = `Build failed at ${shortCommit}: ${command || `unidentified step ${failureFingerprint(lines)}`}`;
    const failure = `\`\`\`\n${lines.join('\n')}\n\`\`\``;

    const projectTasks = await getTasksByProject(projectId);
    const existing = projectTasks.find(
      (task) =>
        !task.archived &&
        task.title === title &&
        findStage(stages, task.status)?.type !== 'done',
    );
    if (existing) {
      const delivery = await appendTaskStagePrompt(
        projectId,
        existing.id,
        `The build failed again at ${shortCommit}:\n\n${failure}`,
        stage.id,
      );
      broadcast({
        type: 'task_message',
        payload: {
          task_id: existing.id,
          project_id: projectId,
          message: delivery.message,
        },
      });
      if (delivery.receipt) {
        broadcast({
          type: 'task_message',
          payload: {
            task_id: existing.id,
            project_id: projectId,
            message: delivery.receipt,
          },
        });
      }
      if (delivery.continuationDrainRequired) {
        void drainProjectQueue(projectId, group);
      }
      return;
    }

    // Successive open failure cards count up from -100 (capped at -1), so they
    // stay ahead of normal cards and the oldest is handled first.
    const openNegative = projectTasks
      .filter(
        (candidate) =>
          !candidate.archived &&
          candidate.custom_values?.[BUILD_FAILURE_MARKER] === 1 &&
          candidate.priority < 0 &&
          findStage(stages, candidate.status)?.type !== 'done',
      )
      .map((candidate) => candidate.priority);
    const priority = openNegative.length
      ? Math.min(Math.max(...openNegative) + 1, -1)
      : BUILD_FAILURE_PRIORITY;

    const task = await createTask({
      project_id: projectId,
      title,
      description: [
        `Commit: ${shortCommit}`,
        command ? `Failing step: ${command}` : '',
        failure,
        FIX_INSTRUCTION,
      ]
        .filter(Boolean)
        .join('\n\n'),
      status: stage.id,
      priority,
      custom_values: { [BUILD_FAILURE_MARKER]: 1 },
      author: 'user',
      ownerUserId: userId,
      lastTriggeredByUserId: userId,
      lastTriggerSource: 'user',
      lastTriggeredAt: new Date().toISOString(),
    });
    broadcast({ type: 'task_created', payload: task });
    void drainProjectQueue(projectId, group);
  } catch (error) {
    logger.warn(
      { project: projectId, error: String(error) },
      'Build-failure card creation failed',
    );
  }
}

/** Resolve only cards created by the build-failure reporter after a green build. */
export async function resolveBuildFailureCards(output: string): Promise<void> {
  const projectId = getBoardBuildFailureProject();
  if (!projectId) return;
  try {
    const group = getGroupByFolder(projectId);
    if (!group) throw new Error(`Project "${projectId}" not found`);
    const stages = getGroupStages(group);
    const candidates = (await getTasksByProject(projectId))
      .filter(
        (task) =>
          !task.archived &&
          task.custom_values?.[BUILD_FAILURE_MARKER] === 1 &&
          findStage(stages, task.status)?.type !== 'done',
      )
      .slice(0, 10);
    // Pre-read every candidate before mutations. appendTaskStagePrompt also reads
    // internally, so a later mutation failure can leave earlier cards changed.
    const cards = await Promise.all(
      candidates.map(async (candidate) => {
        const [task, lastRun] = await Promise.all([
          getTask(candidate.id),
          getLastActiveRunForTask(candidate.id),
        ]);
        if (!task) throw new Error(`Task "${candidate.id}" not found`);
        return { task, lastRun };
      }),
    );
    const commit =
      output.match(/\bGIT_COMMIT=([0-9a-f]{7,40})\b/i)?.[1]?.slice(0, 7) ??
      'develop HEAD';
    for (const { task, lastRun } of cards) {
      try {
        if (!task.started_at && !lastRun) {
          const message = await appendTaskMessageDurableAsync(projectId, {
            task_id: task.id,
            role: 'system',
            content: `Resolved: a later build succeeded at ${commit} at ${new Date().toISOString()}; archived without a run.`,
            created_at: new Date().toISOString(),
          });
          broadcast({
            type: 'task_message',
            payload: { task_id: task.id, project_id: projectId, message },
          });
          await updateTask(task.id, { archived: true });
          broadcast({
            type: 'task_updated',
            payload: { ...task, archived: true },
          });
        } else {
          const targetStage = isActiveStage(stages, task.status)
            ? task.status
            : lastRun?.stage && isActiveStage(stages, lastRun.stage)
              ? lastRun.stage
              : getFirstExecutableStage(stages)?.id;
          if (!targetStage) continue;
          const delivery = await appendTaskStagePrompt(
            projectId,
            task.id,
            `A later build succeeded at ${commit}. If develop already passes the failing step, finish without changes; otherwise continue.`,
            targetStage,
          );
          broadcast({
            type: 'task_message',
            payload: {
              task_id: task.id,
              project_id: projectId,
              message: delivery.message,
            },
          });
          if (delivery.receipt)
            broadcast({
              type: 'task_message',
              payload: {
                task_id: task.id,
                project_id: projectId,
                message: delivery.receipt,
              },
            });
          if (delivery.continuationDrainRequired)
            void drainProjectQueue(projectId, group);
        }
      } catch (error) {
        logger.warn(
          { project: projectId, task: task.id, error: String(error) },
          'Build-failure card resolve failed',
        );
      }
    }
  } catch (error) {
    logger.warn(
      { project: projectId, error: String(error) },
      'Build-failure card resolve failed',
    );
  }
}
