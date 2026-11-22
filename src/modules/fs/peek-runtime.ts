export interface PeekRuntimeCandidate {
  id: string;
  harnessKind?: 'direct' | 'cli';
  baseUrl?: string;
}

function isHttpDirectRuntime<T extends PeekRuntimeCandidate>(
  candidate: T | undefined,
): candidate is T {
  return candidate?.harnessKind === 'direct' && !!candidate.baseUrl;
}

/** Resolve peek_files without mistaking a synthetic persona ID for a catalog binding. */
export function selectPeekFilesRuntime<T extends PeekRuntimeCandidate>(args: {
  agents: T[];
  configured?: T;
  currentAgentId?: string;
  defaultChat?: T;
}): T | undefined {
  if (isHttpDirectRuntime(args.configured)) return args.configured;
  const current = args.agents.find((agent) => agent.id === args.currentAgentId);
  if (isHttpDirectRuntime(current)) return current;

  // Invited personas use ai:<persona-id>, which is an authorization/runtime
  // identity rather than a materialized board_agents binding. Only that
  // synthetic case falls through to a catalog default; ordinary CLI runtimes
  // still require an explicit peekFiles binding.
  if (!args.currentAgentId?.startsWith('ai:')) return undefined;
  if (isHttpDirectRuntime(args.defaultChat)) return args.defaultChat;
  return args.agents.find(isHttpDirectRuntime);
}
