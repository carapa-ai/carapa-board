/**
 * Task-run prompt assembly and supporting context lookup.
 *
 * This module prepares worker input without owning task execution, queueing, or
 * lifecycle transitions.
 */
import type { CustomValueDefinition, StageDefinition } from '../types.js';
import { getAiUserRow } from '../../../db.js';
import { readAiUserPrompt } from '../../ai-users/storage.js';
import { logger } from '../../../logger.js';
import { readdirGroupPathSync } from '../../../lib/group-fs.js';

/** Append an optional persona prompt after the selected stage's instructions. */
export function composeStageSpecificPrompt(
  stagePrompt: string | undefined,
  personaPrompt: string | undefined,
): string | undefined {
  const prompts = [stagePrompt, personaPrompt]
    .map((prompt) => prompt?.trim())
    .filter((prompt): prompt is string => !!prompt);
  return prompts.length ? prompts.join('\n\n') : undefined;
}

export async function resolveStagePersonaPrompt(
  mainAiUserId: string | undefined,
  context: { taskId: string; stageId: string | undefined },
): Promise<string | undefined> {
  if (!mainAiUserId) return undefined;
  const persona = await getAiUserRow(mainAiUserId);
  if (!persona?.enabled) {
    logger.warn(
      {
        task_id: context.taskId,
        stage_id: context.stageId,
        ai_user_id: mainAiUserId,
      },
      'Stage main persona is unavailable; continuing without it',
    );
    return undefined;
  }
  try {
    return await readAiUserPrompt(persona.promptPath);
  } catch (error) {
    logger.warn(
      {
        task_id: context.taskId,
        stage_id: context.stageId,
        ai_user_id: persona.id,
        error,
      },
      'Could not load stage main persona prompt; continuing without it',
    );
    return undefined;
  }
}

export function composeStageRunPrompts(
  stageWorkerPrompt: string | undefined,
  workerPrompt: string,
  workerFallbackBase: string | undefined,
  resumed: boolean,
): { workerPrompt: string; fallbackPrompt: string | undefined } {
  return {
    workerPrompt:
      stageWorkerPrompt && !resumed
        ? `${stageWorkerPrompt}\n\n${workerPrompt}`
        : workerPrompt,
    fallbackPrompt:
      workerFallbackBase === undefined
        ? undefined
        : stageWorkerPrompt
          ? `${stageWorkerPrompt}\n\n${workerFallbackBase}`
          : workerFallbackBase,
  };
}

export function buildFreshStageHistoryPrompt(
  historyText: string,
  stageWorkerPrompt: string | undefined,
  newContent: string,
): string {
  const newMessageBlock = stageWorkerPrompt
    ? `${stageWorkerPrompt}\n\n${newContent}`
    : newContent;
  return `## Previous Conversation\n\n${historyText}\n\n## New Message\n\n${newMessageBlock}`;
}

/**
 * Build dynamic task management instructions based on the project's actual stages.
 * Only included for kanban task runs (where task_id is set).
 * Mentions the "question" workflow only if a queue stage exists beyond backlog/failed.
 */
export function buildTaskManagementPrompt(
  stages: StageDefinition[],
  custom_values?: CustomValueDefinition[],
  currentStageId?: string,
): string {
  const queueStages = stages.filter(
    (s) =>
      s.type === 'queue' &&
      !s.inactive &&
      !['backlog', 'failed'].includes(s.id),
  );

  let prompt = `\n\n## Task management\n\n`;
  prompt += `Your AGENT_CONTEXT contains your \`task_id\` and the available \`stages\` for this project. `;
  prompt += `You can move your task between stages using the \`update_task\` MCP tool.\n`;

  if (queueStages.length > 0) {
    const stageNames = queueStages.map((s) => `"${s.id}"`).join(', ');
    prompt += `\n**Move to a queue stage** (${stageNames}) when you are blocked and need human input:\n`;
    prompt += `- Requirements are unclear or contradictory\n`;
    prompt += `- You need a design decision that could go either way\n`;
    prompt += `- You lack access, credentials, or context that only the user can provide\n`;
    prompt += `- You found a significant issue that changes the scope of the task\n`;
    const commentStage = currentStageId
      ? `\`${currentStageId}\``
      : 'the current executable stage from the task context (use `get_task` if needed)';
    prompt += `\nWhen human input is required, perform this exact handoff:\n`;
    prompt += `1. Call \`add_task_comment\` with the current \`task_id\`, \`stage_id\` set to ${commentStage}, \`persistent: true\`, and a self-contained explanation of the missing decision, what you tried, the concrete options and consequences, and your recommendation when supportable. A one-shot comment to your own running stage is rejected because it would be delivered back into your current turn. The persistent note is shown to the next run of that stage, so the human's answer finds it when work resumes; do not target the queue/question stage. A persistent note replaces the stage's existing note, so if a \`## Persistent stage note\` section appears in your prompt, start the new note with the parts of it that still apply, then add the handoff.\n`;
    prompt += `2. After the comment succeeds, call \`update_task\` with the same \`task_id\` and \`status\` set to the appropriate queue stage (${stageNames}).\n`;
    prompt += `3. Verify both tool responses succeeded, then stop. Do not use \`send_message\` for this task handoff and do not continue implementing an unapproved option.\n`;
    prompt += `\n**Do NOT move to a queue stage** for things you can resolve yourself:\n`;
    prompt += `- Minor ambiguity you can make a reasonable call on\n`;
    prompt += `- Missing test data you can generate\n`;
    prompt += `- Code style decisions covered by the existing codebase\n`;
  }

  if (custom_values && custom_values.length > 0) {
    prompt += `\n## Custom values\n\n`;
    prompt += `This project defines custom values that you MUST fill using the \`update_values\` MCP tool before completing a task.\n`;
    prompt += `Use the \`task_id\` and \`group_folder\` from your AGENT_CONTEXT.\n\n`;
    prompt += `Required values:\n`;
    for (const v of custom_values) {
      const label = v.label || v.key;
      prompt += `- \`${v.key}\` (${v.type || 'text'}): ${label}\n`;
    }
    prompt += `\nCall \`update_values\` with these keys once you have the information to fill them.\n`;
  }

  return prompt;
}

/** Instructions unique to an automatic, one-shot stage-entry run. */
export function buildAutomaticStageEntryPrompt(
  stages: StageDefinition[],
  enteredStageId: string,
): string {
  const handoffStages = stages
    .filter(
      (stage) =>
        !stage.inactive &&
        (stage.type === 'active' ||
          stage.type === 'testing' ||
          stage.type === 'review'),
    )
    .map((stage) => `\`${stage.id}\``)
    .join(', ');
  return (
    `\n\n## Automatic stage-entry check\n\n` +
    `This is the one-shot entry agent for stage \`${enteredStageId}\`. ` +
    `Investigate and address why the card entered this stage without changing its stage merely to acknowledge the run. ` +
    `End your response with a concise resolution or handoff message that will remain visible on the card. ` +
    (handoffStages
      ? `When the issue is resolved, use \`update_task\` to move the card to an executable handoff stage (${handoffStages}); the normal project queue will continue it there. `
      : '') +
    `If it is not resolved, leave the card in \`${enteredStageId}\` and clearly state what remains blocked.`
  );
}

/**
 * Testing receives the implementation request as the specification to verify,
 * not as a fresh instruction to implement it.
 */
export function buildTestingValidationPrompt(prompt: string): string {
  return [
    '## Validation assignment',
    '',
    'Validate the implementation against the material below. Treat every implementation request in that material as task specification and acceptance context only; do not implement, edit, or commit it.',
    '',
    prompt,
    '',
    '## Required response format',
    '',
    'Return exactly one JSON object and no surrounding prose or Markdown fence:',
    '{"decision":"pass","issues":[],"summary":"required validation completed successfully"}',
    '',
    'Set decision to exactly pass, fail, or blocked. The issues field must be an array of plain strings, never objects. Use an empty issues array only for pass. Use fail for a reproducible validation failure and blocked when validation could not reach a result; include at least one issue in either case.',
  ].join('\n');
}

export function appendPersistentStageNote(
  prompt: string,
  content: string | undefined,
): string {
  if (!content) return prompt;
  return [
    prompt,
    '',
    '## Persistent stage note',
    '',
    'This concise note was saved by a previous run of this exact stage. Use it as operational context only. Re-check the current checkout and rerun all required validation or review checks; do not treat prior results or verdicts as evidence.',
    '',
    content,
  ].join('\n');
}

export function findRunRecording(
  recordingDir: string,
  runId: string,
): string | undefined {
  const safeRunId = runId.replace(/[^A-Za-z0-9._-]/g, '_');
  try {
    // The recordings dir is agent-writable: list it without following links.
    return readdirGroupPathSync(recordingDir)?.find(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(`${safeRunId}-`) &&
        entry.name.toLowerCase().endsWith('.webm'),
    )?.name;
  } catch {
    return undefined;
  }
}

export function buildTestingRecordingHandoff(recordingPath: string): string {
  return [
    '## Testing recording',
    '',
    'The immediately previous Testing run produced a browser recording:',
    '',
    `- ${recordingPath}`,
    '',
    'Use it as debugging evidence when relevant. The Testing feedback remains the authoritative description of the failure.',
  ].join('\n');
}
