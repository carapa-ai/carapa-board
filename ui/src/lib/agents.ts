import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import {
  fetchChatAgents,
  fetchRuntimeCatalog,
  type RuntimeCatalog,
  type RuntimeSelection,
} from '@/lib/api';

/**
 * Shape returned by GET /api/chat-agents. We only need id/label/agentCmd for
 * display resolution; the server returns more fields (env, model, …) that
 * the resolver ignores. Kept structural — extra fields are harmless.
 */
interface ChatAgentDisplayEntry {
  id: string;
  label: string;
  agentCmd?: string;
}

/**
 * Resolve a raw run agent value to a human label.
 *
 * Run history can contain either a materialized profile ID or its executable
 * command. This helper maps either representation to the profile `label`
 * defined in `data/board_agents.jsonc`.
 *
 * @param value The raw value from run metadata or `last_agent_name`.
 * @param agents The list of profiles returned by `fetchChatAgents()`. When
 *   the list is not yet loaded (first paint), the helper returns the raw
 *   value verbatim and the query hook will re-render once data arrives.
 */
function resolveAgentLabel(
  value: string | null | undefined,
  agents: ReadonlyArray<ChatAgentDisplayEntry> | undefined,
): string {
  if (!value) return '';
  if (!agents || agents.length === 0) return value;

  // 1) Direct id match → use that profile's label.
  const byId = agents.find((a) => a.id === value);
  if (byId) return byId.label;

  // 2) Binary command match (e.g. "claude", "codex") → use the first profile
  //    with that agentCmd. The first match wins; profiles with the same
  //    agentCmd are an intentional aliasing mechanism in board_agents.jsonc.
  const byCmd = agents.find((a) => a.agentCmd && a.agentCmd === value);
  if (byCmd) return byCmd.label;

  // 3) Unknown / legacy value → show as-is.
  return value;
}

/** Resolve a structured runtime selection to its catalog harness/model label. */
export function resolveRuntimeSelectionLabel(
  selection: RuntimeSelection | null | undefined,
  catalog: RuntimeCatalog | undefined,
): string {
  if (!selection) return '';

  const harnessLabel =
    catalog?.harnesses.find((harness) => harness.id === selection.harnessId)
      ?.label || selection.harnessId;
  const modelLabel =
    catalog?.models.find((model) => model.id === selection.modelId)?.label ||
    selection.modelId;

  return `${harnessLabel} · ${modelLabel}`;
}

/** Resolve a run's recorded model (catalog id or binding model) to its catalog label. */
function resolveModelLabel(
  value: string | null | undefined,
  catalog: RuntimeCatalog | undefined,
): string | null {
  if (!value) return null;
  const model = catalog?.models.find(
    (entry) =>
      entry.id === value ||
      entry.bindings.some((binding) => binding.model === value),
  );
  return model?.label || value;
}

/** Hook wrapper for `resolveModelLabel` using the cached runtime catalog. */
export function useResolveModelLabel(): (
  value: string | null | undefined,
) => string | null {
  const { data: catalog } = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    staleTime: Infinity,
  });
  return (value) => resolveModelLabel(value, catalog);
}

/** Resolve runtime selections while retaining raw ids during catalog loading or failure. */
export function useResolveRuntimeSelectionLabel(): (
  selection: RuntimeSelection | null | undefined,
) => string {
  const { data: catalog } = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    staleTime: Infinity,
  });
  return (selection) => resolveRuntimeSelectionLabel(selection, catalog);
}

/**
 * Hook wrapper: returns a function that resolves any agent reference using
 * the cached `chatAgents` query. The card / detail dialog use this to get a
 * stable label that survives the agent_name → last_agent_name switch.
 */
export function useResolveAgentLabel(): (
  value: string | null | undefined,
) => string {
  const { data: agents } = useQuery({
    queryKey: queryKeys.chatAgents,
    queryFn: fetchChatAgents,
    staleTime: Infinity,
  });
  return (value) => resolveAgentLabel(value, agents);
}
