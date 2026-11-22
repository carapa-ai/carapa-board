/**
 * Reflect workflow — out-of-band `/reflect` command (DirectLLM runtimes).
 *
 * `/reflect` runs the transcript-memory tool loop in preview mode;
 * `/reflect apply` enables validated memory writes. The workflow only
 * orchestrates the tool-driven reflector — there is no separate
 * observation/reconciliation pass.
 *
 * Only the user's command and the concise final result land in the chat
 * transcript; intermediate reflector prompts and outputs are kept in logs
 * (`logger.info` on the `reflect` channel), not in the conversation.
 */

import { randomUUID } from 'node:crypto';
import { getMemoryConfig } from './config.js';
import { logger } from '../../logger.js';
import { runToolDrivenReflector } from './tool-reflector.js';

export interface ReflectWorkflowOptions {
  group_folder: string;
  transcriptPath: string;
  objectiveId?: string | null;
  conversationId?: string;
  /** When true, enable validated memory writes. When false (default), preview only. */
  apply?: boolean;
  /** Override the agent used for the reflector (eval). Defaults to defaults.reflector. */
  reflectorAgentId?: string;
}

export interface ReflectWorkflowDependencies {
  getMemoryConfig: typeof getMemoryConfig;
}

const defaultDependencies: ReflectWorkflowDependencies = {
  getMemoryConfig,
};

interface ReflectPreviewEntry {
  kind: 'memory' | 'rule';
  op: string;
  /** Stable identifier the user can reference. */
  label: string;
  /** Human-readable one-liner (memory content / rule filename + body preview). */
  summary: string;
  /** Source memory ids the LLM cited — surfaced for traceability. */
  source_memory_ids?: string[];
}

export interface ReflectWorkflowResult {
  ok: boolean;
  applied: boolean;
  message: string;
  preview: ReflectPreviewEntry[];
  envelopeSummary: ReflectPreviewEntry[];
  /** Errors from the reflector (parse/validation/LLM). */
  errors: string[];
  /** Agents that ended up being used. */
  usedAgents: { observer: string | null; reflector: string | null };
}

/**
 * Run the out-of-band reflect workflow for a single conversation.
 *
 * - `apply: false` (default) → reflector in preview mode; the user
 *   gets a preview they can confirm. The conversation transcript is
 *   unchanged beyond the user's `/reflect` line.
 * - `apply: true` → runs the same flow with validated memory writes enabled
 *   and returns a concise summary of the completed operations.
 */
export async function runReflectWorkflow(
  options: ReflectWorkflowOptions,
  dependencies: ReflectWorkflowDependencies = defaultDependencies,
): Promise<ReflectWorkflowResult> {
  const config = dependencies.getMemoryConfig();
  if (!config.enabled) {
    return {
      ok: false,
      applied: false,
      message:
        '⚠️ Memory system is disabled (`ENABLE_MEMORY_REFLECTOR=false`). Cannot reflect.',
      preview: [],
      envelopeSummary: [],
      errors: ['memory_disabled'],
      usedAgents: { observer: null, reflector: null },
    };
  }

  const reflectorId = options.reflectorAgentId ?? config.reflector.llm.agentId;
  const usedAgents = { observer: null, reflector: reflectorId ?? null };
  if (!reflectorId) {
    return {
      ok: false,
      applied: false,
      message:
        '⚠️ Configure `defaults.reflector` in `data/board_agents.jsonc` and retry.',
      preview: [],
      envelopeSummary: [],
      errors: ['no_memory_agent'],
      usedAgents,
    };
  }
  const apply = options.apply === true;
  try {
    const result = await runToolDrivenReflector(
      options.group_folder,
      options.transcriptPath,
      {
        mode: apply ? 'live' : 'preview',
        profile: 'direct-llm-conversation',
        explicitReview: true,
        minimumTranscriptLength: 1,
        ...(apply ? {} : { previewId: randomUUID() }),
        ...(options.reflectorAgentId
          ? { agentIdOverride: options.reflectorAgentId }
          : {}),
        ...(options.objectiveId !== undefined
          ? { objectiveId: options.objectiveId }
          : {}),
        ...(options.conversationId
          ? { conversationId: options.conversationId }
          : {}),
      },
    );
    const preview: ReflectPreviewEntry[] = (
      result?.previewOperations ?? []
    ).map((operation) => {
      const summary =
        operation.content ??
        operation.targetContent ??
        operation.memoryId ??
        operation.operationKey;
      return {
        kind: 'memory',
        op: operation.operation,
        label: `${operation.operation}: ${truncate(summary, 160)}`,
        summary,
      };
    });
    const error =
      result && !result.completed
        ? (result.error ?? 'Reflection did not complete')
        : undefined;
    const count = result?.operationCount ?? 0;
    return {
      ok: !error,
      applied: apply && count > 0,
      message: error
        ? `❌ **Reflect incomplete**: ${error}${apply && count > 0 ? ` (${count} memory operations already applied.)` : ''}`
        : apply
          ? `✅ **Reflect applied**: ${count} memory operations.`
          : renderPreviewMessage(preview),
      preview,
      envelopeSummary: preview,
      errors: error ? [error] : [],
      usedAgents,
    };
  } catch (err) {
    logger.error(
      { err, group_folder: options.group_folder },
      'Reflect workflow: tool reflector failed',
    );
    const error = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      applied: false,
      message: `❌ **Reflect failed**: ${error}`,
      preview: [],
      envelopeSummary: [],
      errors: [error],
      usedAgents,
    };
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function renderPreviewMessage(preview: ReflectPreviewEntry[]): string {
  if (preview.length === 0) {
    return '✅ Reflect preview: no memory or rule changes proposed. Nothing to apply.';
  }
  const lines: string[] = ['🪞 **Reflect preview** — proposed changes:'];
  const memory = preview.filter((p) => p.kind === 'memory');
  const rules = preview.filter((p) => p.kind === 'rule');
  if (memory.length > 0) {
    lines.push('', `**Memory** (${memory.length}):`);
    for (const entry of memory) lines.push(`- ${entry.label}`);
  }
  if (rules.length > 0) {
    lines.push('', `**Rules** (${rules.length}):`);
    for (const entry of rules) lines.push(`- ${entry.label}`);
  }
  lines.push(
    '',
    '_Reply `/reflect apply` to commit. Internal prompts and raw LLM outputs are in the logs, not in this conversation._',
  );
  return lines.join('\n');
}
