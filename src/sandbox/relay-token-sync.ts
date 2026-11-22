import { CARAPA_BOX_URL, CARAPA_BOX_API_TOKEN } from '../config.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import { resolveEffectiveSandbox } from './effective-settings.js';
import { callBoxTool } from '../modules/boxes/connections.js';
import { routeSandboxCall } from '../modules/boxes/routing.js';

/**
 * Push/clear a per-project service token in carapa-box's relay-token store
 * out-of-band, so the api-relay picks up a changed token WITHOUT restarting the
 * sandbox (register.ts only writes the store at sandbox_start; this is the
 * second writer). The relay refreshes via its negative-cache expiry / 401
 * self-heal, so an already-running agent gets the new token on its next call.
 *
 * The store key MUST match what register.ts uses at sandbox_start:
 *   projectName = `${stack}-${instance}`
 *   key         = `${projectName}-${service}-1`  (real agent container hostname)
 * — which is also the candidate the relay derives from the agent's
 * agent_egress_<project> hostname, so a GET by the relay finds what we POST.
 *
 * `instance` resolves the same way the runtime launches the sandbox: a valid
 * `defaultSandboxInstance` override, else the group folder (see
 * process.ts launchAgent / sandboxInstanceName).
 */
function relayTokenKey(group: RegisteredGroup): string {
  const { stack, service, instance } = resolveEffectiveSandbox(group);
  return `${stack}-${instance}-${service}-1`;
}

/**
 * Boxes connected over the hub WebSocket cannot be reached over REST: write
 * through their `sandbox_relay_token` tool instead. Returns null when the
 * project lives on the HTTP-reachable box.
 */
async function callRelayTokenTool(
  group: RegisteredGroup,
  name: string,
  service: string,
  method: 'POST' | 'DELETE',
  value?: string,
): Promise<boolean | null> {
  const { instance } = resolveEffectiveSandbox(group);
  const boxId = routeSandboxCall('sandbox_relay_token', { instance });
  if (!boxId) return null;
  try {
    const result = (await callBoxTool(boxId, 'sandbox_relay_token', {
      name,
      ...(service ? { service } : {}),
      ...(method === 'DELETE' ? { clear: true } : { value }),
    })) as { isError?: boolean };
    if (result.isError) {
      logger.warn({ name, service, boxId }, 'relay-token sync to box failed');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(
      { name, service, boxId, err: String(err) },
      'relay-token sync to box errored',
    );
    return false;
  }
}

async function callRelayTokenApi(
  name: string,
  service: string,
  method: 'POST' | 'DELETE',
  token?: string,
): Promise<boolean> {
  if (!CARAPA_BOX_API_TOKEN) {
    logger.warn(
      { name, service },
      'relay-token sync skipped — CARAPA_BOX_API_TOKEN not configured',
    );
    return false;
  }
  const url = new URL(
    `/api/admin/relay-token/${encodeURIComponent(name)}`,
    CARAPA_BOX_URL,
  );
  url.searchParams.set('service', service);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${CARAPA_BOX_API_TOKEN}`,
        ...(token ? { 'Content-Type': 'application/json' } : {}),
      },
      body: token ? JSON.stringify({ token }) : undefined,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      logger.warn(
        { name, service, method, status: res.status },
        'relay-token sync to carapa-box failed',
      );
      return false;
    }
    return true;
  } catch (err: any) {
    logger.warn(
      { name, service, method, error: err?.message ?? String(err) },
      'relay-token sync to carapa-box errored',
    );
    return false;
  }
}

/**
 * Sync a project's carapa-mail MCP token into carapa-box's relay-token store.
 * POSTs the token when enabled+present, DELETEs it otherwise. Best-effort:
 * logs and returns false on failure (never throws into the settings route).
 * Inherited children leave the shared owner's relay token untouched.
 */
export async function syncCarapaMailRelayToken(
  group: RegisteredGroup,
): Promise<boolean> {
  if (resolveEffectiveSandbox(group).inherited) return true;
  const name = relayTokenKey(group);
  const token = group.settings?.carapaMailToken;
  const enabled = group.settings?.carapaMailEnabled;
  const method = enabled && token ? 'POST' : 'DELETE';
  const viaHub = await callRelayTokenTool(
    group,
    name,
    'carapa-mail',
    method,
    token || undefined,
  );
  if (viaHub !== null) return viaHub;
  if (method === 'POST') {
    return callRelayTokenApi(name, 'carapa-mail', 'POST', token);
  }
  return callRelayTokenApi(name, 'carapa-mail', 'DELETE');
}

/**
 * Push a freshly-minted per-group CARAPA_BOARD_API_TOKEN into carapa-box's
 * relay-token store so the running sandbox's api-relay picks it up WITHOUT
 * restarting the sandbox.
 *
 * The relay discovers per-client tokens via `resolvePerClientToken` (cache TTL
 * + 401 self-heal via `invalidatePerClientToken`), so an in-flight agent
 * transparently retries against the new token on its next call. This is the
 * hot-swap path used at board restart: we mint a new board token because the
 * in-memory map was wiped, but we MUST NOT call `sandboxStart` here because
 * that path always `stopStack`s first and would kill every running agent.
 *
 * Returns true on success; false on any failure (network, missing admin token,
 * non-2xx). Caller decides whether to fall back to a full sandbox restart.
 *
 * The service scope is left empty (= bare board token, NOT carapa-mail).
 */
export async function syncBoardRelayToken(
  group: RegisteredGroup,
  token: string,
): Promise<boolean> {
  if (!token) {
    logger.warn(
      { group: group.folder },
      'board relay-token sync skipped — empty token',
    );
    return false;
  }
  const viaHub = await callRelayTokenTool(
    group,
    relayTokenKey(group),
    '',
    'POST',
    token,
  );
  if (viaHub !== null) return viaHub;
  return callRelayTokenApi(relayTokenKey(group), '', 'POST', token);
}
