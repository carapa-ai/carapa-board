/**
 * Parks a kanban task whose resolved runtime is refused by the project's
 * privacy mode. The card moves to the blocked (Question) stage with the reason
 * instead of failing or being retried, and the user is notified.
 */

import { updateTask, getTask } from '../../../db.js';
import { logger } from '../../../logger.js';
import type { PrivacyRefusal } from '../../../lib/privacy-policy.js';
import type { RegisteredGroup } from '../../../types.js';
import { notifyEntityLifecycle } from '../../tools/push-tools.js';
import { broadcast } from '../../objectives/ws-events.js';
import { appendTaskMessageDurableAsync } from '../../transcripts/transcript-store.js';
import { getGroupStages, getTestingBlockedStage } from '../stages.js';
import type { Task } from '../types.js';

export async function parkTaskForPrivacyRefusal(
  task: Task,
  group: RegisteredGroup,
  refusal: PrivacyRefusal,
): Promise<void> {
  const blocked = getTestingBlockedStage(getGroupStages(group));
  await updateTask(
    task.id,
    {
      ...(blocked ? { status: blocked.id } : {}),
      error: refusal.message,
    },
    { suppressStageEntryEvent: true },
  );

  const message = await appendTaskMessageDurableAsync(task.project_id, {
    task_id: task.id,
    role: 'system',
    entry_type: 'system_notice',
    content: `Privacy mode "${refusal.mode}" blocks this run: runtime "${refusal.target}" is not local. Choose a local runtime (and a local or no fallback model) for this stage, or change the project privacy mode.`,
    created_at: new Date().toISOString(),
  });
  broadcast({
    type: 'task_message',
    payload: { task_id: task.id, project_id: task.project_id, message },
  });
  await notifyEntityLifecycle({
    group_folder: task.project_id,
    task_id: task.id,
    // One source per refusal, so a repeated refusal notifies again.
    run_id: `privacy-refusal-${message.id}`,
    event: 'needs_input',
    title: `Task needs input: ${task.title}`,
  });
  logger.info(
    { task_id: task.id, mode: refusal.mode, target: refusal.target },
    'Task parked by privacy mode',
  );
  const updated = await getTask(task.id);
  if (updated) broadcast({ type: 'task_updated', payload: updated });
}
