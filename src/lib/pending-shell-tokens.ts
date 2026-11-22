import { getOnDemandSandboxes } from './on-demand-sandboxes.js';
import { revokeAgentToken } from '../mcp/auth-tokens.js';

/** Revoke incomplete shell starts before they can be adopted or hydrated. */
export async function revokePendingShellTokens(
  projectId?: string,
): Promise<void> {
  const tracker = getOnDemandSandboxes();
  for (const [key, record] of Object.entries(tracker.list())) {
    if (!record.pendingStart || (projectId && record.projectId !== projectId))
      continue;
    if (record.agentToken) {
      await revokeAgentToken(record.agentToken, { requirePersistence: true });
    }
    await tracker.forget(key);
  }
}
