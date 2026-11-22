import { resolveChatAgent } from '../agent-runner.js';
import {
  getChatAgents,
  getDefaultRuntimeSelection,
  resolveRuntimeSelection,
  runtimeSessionKey,
  type ChatAgentOption,
  type RuntimeSelection,
} from './chat-agents.js';
import type { RegisteredGroup } from '../types.js';

export interface ResolveAgentConfigDependencies {
  getChatAgents: typeof getChatAgents;
  getDefaultRuntimeSelection: typeof getDefaultRuntimeSelection;
  resolveRuntimeSelection: typeof resolveRuntimeSelection;
  runtimeSessionKey: typeof runtimeSessionKey;
  resolveChatAgent: typeof resolveChatAgent;
}

const defaultDependencies: ResolveAgentConfigDependencies = {
  getChatAgents,
  getDefaultRuntimeSelection,
  resolveRuntimeSelection,
  runtimeSessionKey,
  resolveChatAgent,
};

/**
 * Resolve the effective v2 runtime and return its catalog entry.
 */
export function getResolvedAgentConfig(
  group: RegisteredGroup,
  rawAgentCmd?: string | null,
  dependencies: ResolveAgentConfigDependencies = defaultDependencies,
): ChatAgentOption | undefined {
  // An explicit runtime reference must name a materialized catalog binding.
  // Do not turn invalid legacy IDs into the configured default: callers use
  // this result to decide both execution and native-session identity.
  if (rawAgentCmd)
    return dependencies
      .getChatAgents()
      .find((agent) => agent.id === rawAgentCmd);
  return dependencies.resolveRuntimeSelection(
    group.settings?.chatRuntimeSelection ||
      dependencies.getDefaultRuntimeSelection('chat'),
  );
}

export function getResolvedRuntimeConfig(
  group: RegisteredGroup,
  selection?: RuntimeSelection | null,
  rawAgentCmd?: string | null,
  dependencies: ResolveAgentConfigDependencies = defaultDependencies,
): ChatAgentOption | undefined {
  if (selection) return dependencies.resolveRuntimeSelection(selection);
  if (!rawAgentCmd && group.settings?.chatRuntimeSelection) {
    return dependencies.resolveRuntimeSelection(
      group.settings.chatRuntimeSelection,
    );
  }
  return getResolvedAgentConfig(group, rawAgentCmd, dependencies);
}

/** Match the interactive chat precedence shared by every conversation route. */
export function resolveConversationRuntimeSelection(
  requestedSelection?: RuntimeSelection | null,
  storedSelection?: RuntimeSelection | null,
  rawAgentCmd?: string | null,
): RuntimeSelection | undefined {
  return (
    requestedSelection ??
    (!rawAgentCmd ? (storedSelection ?? undefined) : undefined)
  );
}

/**
 * Convert a materialized runtime back into a catalog-facing selection.
 * `reasoning_effort` is the transport value after the binding's reasoning map
 * has been applied, so it must never be persisted as `RuntimeSelection.reasoning`.
 */
export function runtimeSelectionFromResolvedAgent(
  agent?: ChatAgentOption,
): RuntimeSelection | undefined {
  if (!agent?.harnessId || !agent.modelId) return undefined;
  return {
    harnessId: agent.harnessId,
    modelId: agent.modelId,
    ...(agent.reasoningDefault ? { reasoning: agent.reasoningDefault } : {}),
  };
}

/**
 * Resolve the key used to store/look up a conversation's native session.
 * v2 uses explicit sessionFamily; v1 falls back to the underlying agentCmd.
 *
 * Why the binary and not the profile id: two profiles that share the same
 * `agentCmd` (e.g. claude-llama and claude-ollama-m3, both `claude`) drive the
 * same CLI binary against the same on-disk transcript. Keying the session by
 * the binary lets a switch between such profiles resume the SAME session —
 * the new profile's warm daemon `--resume`s the shared transcript under its
 * own model+env, instead of starting fresh with a compressed handoff summary.
 *
 * Profiles with no `agentCmd` (LLM agents, custom .sh entries whose id is the
 * command) fall back to the resolved id, so their keying is unchanged.
 *
 * This also matches `recovery.ts`, which has always keyed recovered sessions
 * by `active_runs.agent_name` — and `agent_name` is the binary `agent_cmd`.
 * Unifying here closes a latent mismatch between the normal run path and the
 * recovery path.
 */
export function resolveSessionAgentKey(
  group: RegisteredGroup,
  override?: string | null,
  selection?: RuntimeSelection | null,
  dependencies: ResolveAgentConfigDependencies = defaultDependencies,
): string {
  const cfg = getResolvedRuntimeConfig(
    group,
    selection,
    override,
    dependencies,
  );
  const resolvedId = cfg?.id || dependencies.resolveChatAgent(group, override);
  if (cfg) return dependencies.runtimeSessionKey(cfg);
  return resolvedId;
}

export function resolvedAgentSupportsNativeAudio(
  group: RegisteredGroup,
  rawAgentCmd?: string | null,
  selection?: RuntimeSelection | null,
  dependencies: ResolveAgentConfigDependencies = defaultDependencies,
): boolean {
  return (
    getResolvedRuntimeConfig(group, selection, rawAgentCmd, dependencies)
      ?.audio === true
  );
}
