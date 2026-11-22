import {
  resolveKanbanRuntimeSelection,
  runtimeSessionKey,
} from '../../lib/chat-agents.js';
import type {
  ChatAgentOption,
  RuntimeSelection,
} from '../../lib/chat-agents.js';
import type { RegisteredGroup } from '../../types.js';

export interface ObjectiveAgentRuntime {
  /** Effective logical runtime selection. */
  selection: RuntimeSelection;
  /** Stable board_agents binding reference, e.g. codex:gpt-6.1-sol. */
  runtimeId: string;
  agentCmd: string;
  model: string | null;
  /** Provider-facing value after applying the catalog reasoning map. */
  reasoningEffort?: string | null;
  env?: Record<string, string>;
  sessionKey: string;
  /** Resolved binding, used for privacy-mode locality checks. */
  agent: ChatAgentOption;
}

export function materializeObjectiveAgentRuntime(
  selection: RuntimeSelection,
  agent: ChatAgentOption,
): ObjectiveAgentRuntime {
  const logicalReasoning = selection.reasoning ?? agent.reasoningDefault;
  const selectionWithReasoning = logicalReasoning
    ? { ...selection, reasoning: logicalReasoning }
    : selection;
  const reasoningEffort = logicalReasoning
    ? Object.hasOwn(agent.reasoningMap ?? {}, logicalReasoning)
      ? (agent.reasoningMap?.[logicalReasoning] ?? null)
      : logicalReasoning
    : undefined;
  return {
    selection: selectionWithReasoning,
    runtimeId: agent.id,
    agentCmd: agent.agentCmd || agent.id,
    model: agent.model || null,
    reasoningEffort,
    env: agent.env,
    sessionKey: runtimeSessionKey(agent),
    agent,
  };
}

function resolveLayeredSelection(
  group: RegisteredGroup | undefined,
  selection?: RuntimeSelection,
): ObjectiveAgentRuntime {
  const resolved = resolveKanbanRuntimeSelection([
    selection,
    group?.settings?.kanbanRuntimeSelection ?? undefined,
  ]);
  return materializeObjectiveAgentRuntime(resolved.selection, resolved.agent);
}

/**
 * Resolve the runtime used only by autonomous objective event handling.
 *
 * Structured overrides are layered over the project Kanban runtime, so omitted
 * reasoning inherits project/global reasoning. Historical objective
 * command/model columns are deliberately ignored: only the structured event
 * selection is a supported objective-level override.
 */
export function resolveObjectiveAgentRuntime(
  group: RegisteredGroup | undefined,
  eventRuntimeSelection?: RuntimeSelection | null,
): ObjectiveAgentRuntime {
  return resolveLayeredSelection(group, eventRuntimeSelection ?? undefined);
}
