import {
  completeActiveRun,
  getActiveChatRunsForSandboxInstance,
  getActiveTaskRunsForSandboxInstance,
  getConversation,
} from '../db.js';
import { chatEventScope } from '../modules/chat/conversation-scope.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import { logger } from '../logger.js';
import { abortChatAgentWatcher } from './process.js';
import { interruptRun } from './stall-registry.js';

interface SandboxChatInterruptionDeps {
  getActiveRuns: typeof getActiveChatRunsForSandboxInstance;
  completeRun: typeof completeActiveRun;
  getConversation: typeof getConversation;
  abortWatcher: typeof abortChatAgentWatcher;
  broadcast: typeof broadcast;
}

const defaultDeps: SandboxChatInterruptionDeps = {
  getActiveRuns: getActiveChatRunsForSandboxInstance,
  completeRun: completeActiveRun,
  getConversation,
  abortWatcher: abortChatAgentWatcher,
  broadcast,
};

/**
 * Finalize chat runs that cannot survive a managed sandbox stop/restart.
 * This clears both persisted run state and the browser's conversation-scoped
 * running flag immediately; the released request handler persists its normal
 * failed-response message afterward.
 */
export async function interruptSandboxChatRuns(
  sandboxInstance: string | undefined,
  deps: SandboxChatInterruptionDeps = defaultDeps,
): Promise<number> {
  if (!sandboxInstance) return 0;

  const runs = await deps.getActiveRuns(sandboxInstance);
  if (runs.length === 0) return 0;

  const conversations = new Map<
    string,
    { groupFolder: string; chatJid: string }
  >();
  for (const run of runs) {
    await deps.completeRun(run.id, 'error');
    if (run.conversation_id && run.chat_jid.includes('@web')) {
      conversations.set(run.conversation_id, {
        groupFolder: run.group_folder,
        chatJid: run.chat_jid,
      });
    }
  }

  for (const [conversationId, run] of conversations) {
    deps.abortWatcher(run.groupFolder, run.chatJid, conversationId);
    const conversation = await deps.getConversation(conversationId);
    const objectiveId = conversation?.objective_id ?? undefined;
    deps.broadcast({
      type: 'chat_completed',
      payload: {
        ...chatEventScope(run.groupFolder, objectiveId),
        conversation_id: conversationId,
        failed: true,
        pending: false,
        liveState: 'failed',
        completionSummary: 'Sandbox stopped before the agent finished.',
      },
    });
  }

  logger.info(
    {
      sandboxInstance,
      runCount: runs.length,
      conversationCount: conversations.size,
    },
    'Finalized chat runs interrupted by sandbox lifecycle change',
  );
  return runs.length;
}

/**
 * Matches the pipeline's transient-error rule (`/sandbox unavailable/`), so a
 * restart-interrupted task stays in its stage and retries automatically.
 */
const SANDBOX_RESTART_TASK_ERROR =
  'Sandbox unavailable: the sandbox was restarted before the agent finished.';
/** Deliberately non-transient: a stopped sandbox must not be relaunched by a retry. */
const SANDBOX_STOP_TASK_ERROR =
  'The sandbox was stopped before the agent finished.';

interface SandboxTaskInterruptionDeps {
  getActiveRuns: typeof getActiveTaskRunsForSandboxInstance;
  interruptRun: typeof interruptRun;
}

const defaultTaskDeps: SandboxTaskInterruptionDeps = {
  getActiveRuns: getActiveTaskRunsForSandboxInstance,
  interruptRun,
};

/**
 * Fail the in-process wait of task runs whose agent died with the sandbox.
 * Without this the board keeps showing the task as running until the idle
 * stall watchdog fires. The waiter's own error path completes the run row,
 * and the task pipeline decides retry vs failure from the error text.
 */
export async function interruptSandboxTaskRuns(
  sandboxInstance: string | undefined,
  lifecycle: 'restart' | 'stop',
  deps: SandboxTaskInterruptionDeps = defaultTaskDeps,
): Promise<number> {
  if (!sandboxInstance) return 0;

  const runs = await deps.getActiveRuns(sandboxInstance);
  if (runs.length === 0) return 0;

  const reason =
    lifecycle === 'restart'
      ? SANDBOX_RESTART_TASK_ERROR
      : SANDBOX_STOP_TASK_ERROR;
  let interrupted = 0;
  for (const run of runs) {
    if (deps.interruptRun(run.id, reason)) {
      interrupted += 1;
    } else {
      logger.warn(
        { sandboxInstance, runId: run.id, task_id: run.task_id },
        'Task run on stopped sandbox has no in-process waiter to interrupt',
      );
    }
  }

  logger.info(
    { sandboxInstance, lifecycle, runCount: runs.length, interrupted },
    'Interrupted task runs after sandbox lifecycle change',
  );
  return interrupted;
}
