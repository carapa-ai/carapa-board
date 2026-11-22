/**
 * Keeps board_agents.discovered.json current: the models each provider
 * account offers (from CarapaBox) and each ACP harness reports (from the
 * harness-models files its runner writes under data/ipc). The catalog loader
 * merges the file into board_agents.jsonc (see discovered-models.ts).
 */
import fs from 'fs';
import path from 'path';
import { CARAPA_BOX_API_TOKEN, CARAPA_BOX_URL, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { parseJsonc } from './jsonc.js';
import {
  fetchProviderListing,
  ingestProviderListing,
} from './provider-login-state.js';
import { checkManagedKeyNotifications } from './key-expiry-notifier.js';
import { getChatAgents } from './chat-agents.js';
import {
  DISCOVERY_FILE_NAME,
  readDiscoveryCache,
  type DiscoveredModel,
  type DiscoveryCache,
  type DiscoverySource,
} from './discovered-models.js';

const REFRESH_INTERVAL_MS = 30 * 60_000;
/** Cards held for a provider login must resume without the admin page open. */
const ACCOUNT_POLL_INTERVAL_MS = 60_000;
const cacheFile = () => path.join(DATA_DIR, DISCOVERY_FILE_NAME);

async function boxJson(suffix: string): Promise<any> {
  const response = await fetch(
    new URL('/api/admin/provider-accounts' + suffix, CARAPA_BOX_URL),
    {
      headers: { Authorization: `Bearer ${CARAPA_BOX_API_TOKEN}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`CarapaBox returned ${response.status}`);
  return response.json();
}

/** Model lists per provider; providers whose lookup failed are absent. */
async function accountModels(): Promise<Record<string, DiscoveredModel[]>> {
  if (!CARAPA_BOX_API_TOKEN) return {};
  const [{ accounts }, { models }] = await Promise.all([
    boxJson(''),
    boxJson('/models'),
  ]);
  const result: Record<string, DiscoveredModel[]> = {};
  for (const account of accounts || []) {
    const listed = models?.[account.id]?.models;
    if (!Array.isArray(listed)) continue;
    // Shared and client-scoped accounts of one provider are merged.
    const merged = new Map(
      (result[account.provider] || []).map((m) => [m.id, m]),
    );
    for (const model of listed)
      if (typeof model?.id === 'string' && !merged.has(model.id))
        merged.set(model.id, model);
    result[account.provider] = [...merged.values()];
  }
  return result;
}

/** The newest list each harness reported, across all sandbox IPC roots. */
function harnessModels(): Record<
  string,
  { at: number; models: DiscoveredModel[] }
> {
  const result: Record<string, { at: number; models: DiscoveredModel[] }> = {};
  const root = path.join(DATA_DIR, 'ipc');
  let instances: string[] = [];
  try {
    instances = fs.readdirSync(root);
  } catch {
    return result;
  }
  for (const instance of instances) {
    const dir = path.join(root, instance, 'harness-models');
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      continue;
    }
    for (const name of files) {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        const harness = name.slice(0, -'.json'.length);
        if (value?.harness !== harness || !Array.isArray(value.models))
          continue;
        const at = Number(value.observedAt) || 0;
        if (!result[harness] || at > result[harness].at)
          result[harness] = { at, models: value.models };
      } catch {
        // A half-written or foreign file is skipped until the next refresh.
      }
    }
  }
  return result;
}

/** New list for a source; models it no longer offers move to `retired`. */
function update(
  previous: DiscoverySource | undefined,
  at: number,
  models: DiscoveredModel[],
): DiscoverySource {
  const current = new Set(models.map((m) => m.id));
  const retired = new Map<string, DiscoveredModel>();
  for (const m of [...(previous?.models || []), ...(previous?.retired || [])])
    if (!current.has(m.id) && !retired.has(m.id)) retired.set(m.id, m);
  return {
    at,
    models,
    ...(retired.size ? { retired: [...retired.values()] } : {}),
  };
}

const sameModels = (a?: DiscoverySource, b?: DiscoverySource) =>
  JSON.stringify([a?.models, a?.retired]) ===
  JSON.stringify([b?.models, b?.retired]);

let inFlight: Promise<void> | null = null;

/** Refresh the cache; a failed lookup keeps that source's previous list. */
export function refreshModelDiscovery(): Promise<void> {
  inFlight ||= (async () => {
    const previous = readDiscoveryCache(cacheFile());
    const next: DiscoveryCache = {
      version: 1,
      accounts: { ...previous?.accounts },
      harnesses: { ...previous?.harnesses },
    };
    let changed = !previous;
    try {
      for (const [provider, models] of Object.entries(await accountModels())) {
        const before = previous?.accounts[provider];
        const source = update(before, Date.now(), models);
        const same = sameModels(source, before);
        if (!same) changed = true;
        next.accounts[provider] = same ? before! : source;
      }
    } catch (err) {
      logger.warn(
        { err },
        'Account model discovery failed; keeping previous lists',
      );
    }
    for (const [harness, listed] of Object.entries(harnessModels())) {
      const before = previous?.harnesses[harness];
      if (before && before.at >= listed.at) continue;
      const source = update(before, listed.at, listed.models);
      const same = sameModels(source, before);
      if (!same) changed = true;
      next.harnesses[harness] = same ? before! : source;
    }
    // Writing only on change avoids reloading the catalog every refresh.
    if (!changed) return;
    const file = cacheFile();
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
    fs.renameSync(temporary, file);
    logger.info('Discovered models updated');
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** ACP harnesses whose `discover.account` is this provider. */
function acpHarnessesFor(provider: string): string[] {
  let raw: any;
  try {
    raw = parseJsonc(
      fs.readFileSync(path.join(DATA_DIR, 'board_agents.jsonc'), 'utf8'),
    );
  } catch {
    return [];
  }
  return Object.entries<any>(raw?.harnesses || {})
    .filter(([, h]) => h?.discover?.account === provider)
    .map(([id]) => id);
}

/**
 * Start one isolated session of a harness that has not reported its models,
 * in the main group's sandbox. CARAPA_MODEL_PROBE makes the ACP runner record
 * the list and stop before prompting, so the model is never called.
 */
async function probeHarness(harnessId: string): Promise<void> {
  const [
    { registeredGroups },
    { runContainerAgent, TASK_PERSISTENT_RUNTIME_CONTRACT },
  ] = await Promise.all([
    import('../state-manager.js'),
    import('../sandbox/process.js'),
  ]);
  const agent = getChatAgents().find((a) => a.harnessId === harnessId);
  const agentCmd = agent?.agentCmd;
  if (
    !agentCmd ||
    !TASK_PERSISTENT_RUNTIME_CONTRACT.some((c) => c.agentCmd === agentCmd)
  )
    return;
  const group = Object.values(registeredGroups).find((g) => g.is_main);
  if (!group) return;
  await runContainerAgent(group, {
    prompt: 'Reply with OK.',
    group_folder: group.folder,
    chat_jid: `model-discovery:${harnessId}`,
    isMain: true,
    triggeredByUserId: null,
    triggerSource: 'system',
    agent_cmd: agentCmd,
    env: { ...agent.env, CARAPA_MODEL_PROBE: '1' },
    privacyRuntime: agent,
    privacyPurpose: 'agent',
    timeout: 300,
  });
}

/** After an account connects: refresh, then probe its harnesses with no list yet. */
async function discoverForProvider(provider: string): Promise<void> {
  await refreshModelDiscovery();
  const known = readDiscoveryCache(cacheFile())?.harnesses || {};
  for (const harnessId of acpHarnessesFor(provider)) {
    if (known[harnessId]) continue;
    try {
      await probeHarness(harnessId);
    } catch (err) {
      logger.warn({ err, harnessId }, 'Harness model probe failed');
    }
  }
  await refreshModelDiscovery();
}

let lastAccounts: Map<string, string> | null = null;
let lastLogins = new Map<string, string>();

/**
 * Called with each provider-accounts listing the admin page or the periodic
 * poll fetches. A login that finished, or an account that became connected,
 * starts discovery for that provider. Recording the listing also releases the
 * cards the queue held for a provider login that is now usable. The first
 * listing after a Board restart only sets a baseline for discovery.
 */
export function noteProviderAccounts(listing: any): void {
  ingestProviderListing(listing);
  void checkManagedKeyNotifications(listing).catch((err) =>
    logger.warn({ err }, 'Managed key notification check failed'),
  );
  const accounts = new Map<string, string>(
    (listing?.accounts || []).map((a: any) => [
      `${a.provider}:${a.id}`,
      a.state,
    ]),
  );
  const logins = new Map<string, string>(
    (listing?.logins || []).map((l: any) => [l.id, l.provider]),
  );
  const providers = new Set<string>();
  if (lastAccounts) {
    for (const [key, state] of accounts)
      if (state === 'connected' && lastAccounts.get(key) !== 'connected')
        providers.add(key.split(':')[0]);
    for (const [id, provider] of lastLogins)
      if (!logins.has(id)) providers.add(provider);
  }
  lastAccounts = accounts;
  lastLogins = logins;
  for (const provider of providers)
    void discoverForProvider(provider).catch((err) =>
      logger.warn(
        { err, provider },
        'Model discovery after account connection failed',
      ),
    );
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startModelDiscovery(): void {
  if (timer) return;
  const refresh = () =>
    void refreshModelDiscovery().catch((err) =>
      logger.warn({ err }, 'Model discovery refresh failed'),
    );
  refresh();
  timer = setInterval(refresh, REFRESH_INTERVAL_MS);
  timer.unref();
  const pollAccounts = () =>
    void fetchProviderListing().then((listing) => {
      if (listing) noteProviderAccounts(listing);
    });
  pollAccounts();
  setInterval(pollAccounts, ACCOUNT_POLL_INTERVAL_MS).unref();
}
