/**
 * Harnesses a project's sandbox can run. CarapaBox lists, per stack, the
 * harnesses selected with harness.py (`harnesses` in `sandbox_list`). Stacks
 * that bake their harnesses into the image report none, and then nothing is
 * hidden; the same applies when the box is offline or predates the field.
 * A native runner lists one stack for every project it runs.
 */
import { getChatAgents } from '../../lib/chat-agents.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { resolveEffectiveSandbox } from '../../sandbox/effective-settings.js';
import type { RegisteredGroup } from '../../types.js';
import { isNativeBoxInstance } from './routing.js';

/** Board agent commands whose harness.py package has a different name. */
const BOX_HARNESS_FOR_COMMAND: Record<string, string> = {
  'omp-acp': 'omp',
  'cursor-acp': 'cursor',
  'muse-acp': 'muse',
  'grok-acp': 'grok',
  'vibe-acp': 'vibe',
  'hermes-acp': 'hermes',
  'prime-agent-acp': 'prime-agent',
  'agy-sdk': 'antigravity',
};
const CACHE_TTL_MS = 30_000;
const cache = new Map<
  string,
  { at: number; installed: Promise<string[] | null> }
>();

async function stackHarnesses(
  stack: string,
  instance: string,
): Promise<string[] | null> {
  // `instance` only routes the call to the box that runs the sandbox.
  const result = await getSandboxClient().callTool('sandbox_list', {
    instance,
  });
  if (result.isError) return null;
  const stacks: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(stacks)) return null;
  const entry =
    stacks.find((item) => item?.name === stack) ??
    (isNativeBoxInstance(instance) && stacks.length === 1
      ? stacks[0]
      : undefined);
  return Array.isArray(entry?.harnesses) ? entry.harnesses : null;
}

/** Board harness ids the project's sandbox can run, or null when unrestricted. */
export async function availableHarnessIds(
  group: RegisteredGroup,
): Promise<string[] | null> {
  const { stack, instance } = resolveEffectiveSandbox(group);
  const key = `${stack}\0${instance}`;
  let cached = cache.get(key);
  if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
    cached = {
      at: Date.now(),
      installed: stackHarnesses(stack, instance).catch(() => null),
    };
    cache.set(key, cached);
  }
  const installed = await cached.installed;
  if (!installed) return null;

  const present = new Set(installed);
  const available = new Map<string, boolean>();
  for (const agent of getChatAgents()) {
    if (!agent.harnessId) continue;
    const command = agent.agentCmd || agent.harnessId;
    const runnable =
      agent.harnessKind === 'direct' ||
      present.has(BOX_HARNESS_FOR_COMMAND[command] ?? command);
    available.set(
      agent.harnessId,
      (available.get(agent.harnessId) ?? true) && runnable,
    );
  }
  return [...available].filter(([, ok]) => ok).map(([id]) => id);
}
