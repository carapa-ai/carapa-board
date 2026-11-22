/**
 * Persists a rejection's feedback and runs the first-rejection / progress
 * comparison for `handleReviewDecision`.
 */
import { AGENT_CMD } from '../../../config.js';
import { getTask, updateTask } from '../../../db.js';
import type {
  ContainerInput,
  runContainerAgent,
} from '../../../mcp/mcp-runner.js';
import { broadcast } from '../../objectives/ws-events.js';
import {
  appendRunStartMarker,
  appendTaskMessage,
} from '../../transcripts/transcript-store.js';
import type { Task } from '../types.js';
import {
  buildFirstRejectionComparison,
  buildReviewComparisonPrompt,
  formatReviewIssues,
  isFirstReviewRejection,
  parseReviewComparison,
  readReviewHistory,
} from '../review.js';
import type {
  RejectionComparison,
  ReviewDecision,
  ReviewerVerdictSummary,
} from '../review.js';
import { PENDING_REVIEW_REVIEWERS_KEY } from './review-chain.js';

/**
 * Persists a rejection's feedback and runs the normal first-rejection /
 * progress comparison; resolves the comparison for `handleReviewDecision`.
 */
export type PrepareReviewRejection = (input: {
  reviewDecision: ReviewDecision;
  assistantContent: string;
  sessionId?: string;
  /** Commit the rejection applies to; defaults to this run's review head. */
  head?: string;
  /** Every reviewer's verdict, kept for a recovered comparison. */
  reviewers?: ReviewerVerdictSummary[];
}) => Promise<{
  rejectionComparison?: RejectionComparison;
  sessionId?: string;
}>;

export type AuxiliaryWorkerInput = Pick<
  ContainerInput,
  | 'prompt'
  | 'fallbackPrompt'
  | 'session_id'
  | 'stage_id'
  | 'activeRunStageId'
  | 'injectAgentContext'
  | 'onSlotAcquired'
  | 'onActiveRunCreated'
>;

export interface ReviewRejectionDeps {
  task: Task;
  targetStatus: string;
  /** Read at call time: the model is only known once the run has started. */
  getAgentName(): string | null;
  getModelName(): string | null;
  getRunId(): string | null;
  /** Read at call time: the review head is reassigned during the run. */
  getReviewHead(): string | undefined;
  /** Ends the task's live stream (it depends on pipeline-local buffers). */
  clearTaskStream(runId: string | null): void;
  runAuxiliary(
    input: AuxiliaryWorkerInput,
    onChunk: Parameters<typeof runContainerAgent>[2],
  ): ReturnType<typeof runContainerAgent>;
}

export function createReviewRejectionPreparer(
  deps: ReviewRejectionDeps,
): PrepareReviewRejection {
  const { task, targetStatus } = deps;
  return async ({
    reviewDecision,
    assistantContent,
    sessionId,
    head = deps.getReviewHead(),
    reviewers,
  }) => {
    let reviewSessionId = sessionId;
    let rejectionComparison: RejectionComparison | undefined;
    const reviewHead = head;
    if (assistantContent.trim()) {
      const feedback = appendTaskMessage(task.project_id, {
        task_id: task.id,
        role: 'assistant',
        agent_name: deps.getAgentName(),
        model_name: deps.getModelName(),
        // Preserve exactly what was streamed by the reviewer. The live
        // stream is cleared before comparison starts, so this persisted
        // message is what remains after re-rendering.
        content: assistantContent,
        created_at: new Date().toISOString(),
      });
      broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: feedback,
        },
      });
    }
    const issueLines = formatReviewIssues(reviewDecision.issues);
    const summary = appendTaskMessage(task.project_id, {
      task_id: task.id,
      role: 'system',
      entry_type: 'review_feedback',
      content: `**Review rejected** (score: ${reviewDecision.score}/10)\n\n${reviewDecision.summary}\n\n**Issues:**\n${issueLines}`,
      created_at: new Date().toISOString(),
    });
    broadcast({
      type: 'task_message',
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        message: summary,
      },
    });
    deps.clearTaskStream(deps.getRunId());
    const comparisonTask = (await getTask(task.id)) || task;
    const history = readReviewHistory(comparisonTask.custom_values);
    const firstRejection = isFirstReviewRejection(
      comparisonTask.custom_values,
      history,
    );
    if (firstRejection) {
      rejectionComparison = buildFirstRejectionComparison(reviewDecision);
    } else {
      await updateTask(task.id, {
        custom_values: {
          ...(comparisonTask.custom_values || {}),
          pending_review_decision: JSON.stringify(reviewDecision),
          pending_review_head: reviewHead || '',
          ...(reviewers
            ? { [PENDING_REVIEW_REVIEWERS_KEY]: JSON.stringify(reviewers) }
            : {}),
        },
      });
      const comparisonPrompt = buildReviewComparisonPrompt(
        comparisonTask.description,
        reviewHead || '',
        typeof comparisonTask.custom_values?.rejection_count === 'number'
          ? comparisonTask.custom_values.rejection_count + 1
          : 1,
        typeof comparisonTask.custom_values?.no_progress_count === 'number'
          ? comparisonTask.custom_values.no_progress_count
          : 0,
        history,
        reviewDecision,
      );
      const request = appendTaskMessage(task.project_id, {
        task_id: task.id,
        role: 'user',
        content: '**Review comparison requested**',
        created_at: new Date().toISOString(),
      });
      broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: request,
        },
      });
      let comparisonOutput = '';
      const comparisonResult = await deps.runAuxiliary(
        {
          prompt: comparisonPrompt,
          fallbackPrompt: comparisonPrompt,
          session_id: reviewSessionId,
          stage_id: targetStatus,
          injectAgentContext: false,
          onSlotAcquired: async (runId: string) => {
            const marker = appendRunStartMarker(
              task.project_id,
              task.id,
              runId,
              {
                agent_name: deps.getAgentName() || AGENT_CMD,
                created_at: new Date().toISOString(),
              },
            );
            broadcast({
              type: 'task_message',
              payload: {
                task_id: task.id,
                project_id: task.project_id,
                message: marker,
              },
            });
          },
        },
        (chunk) => {
          if (chunk.type === 'text') comparisonOutput += chunk.content;
          if (chunk.type === 'session') {
            reviewSessionId = chunk.session_id;
          }
        },
      );
      rejectionComparison =
        parseReviewComparison(
          comparisonOutput || comparisonResult.result || '',
        ) || undefined;
    }
    // A first rejection has nothing to compare and ran no comparison, so it
    // leaves no comparison note in the transcript.
    if (!firstRejection) {
      const comparisonMessage = appendTaskMessage(task.project_id, {
        task_id: task.id,
        role: 'assistant',
        content: rejectionComparison
          ? `**Review comparison** — ${rejectionComparison.decision}: ${rejectionComparison.reason}`
          : '**Review comparison failed** — the task will be paused for manual resolution.',
        agent_name: deps.getAgentName(),
        model_name: deps.getModelName(),
        created_at: new Date().toISOString(),
      });
      broadcast({
        type: 'task_message',
        payload: {
          task_id: task.id,
          project_id: task.project_id,
          message: comparisonMessage,
        },
      });
    }
    return { rejectionComparison, sessionId: reviewSessionId };
  };
}
