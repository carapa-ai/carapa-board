import { sha256Hex } from '../lib/hash.js';
import { z } from 'zod';
import { getSandboxClient, type SandboxClient } from '../lib/mcp-client.js';
import { resolveEffectiveSandbox } from './effective-settings.js';
import {
  getGroupEntryByFolder,
  applyGroupUpdateInMemory,
} from '../state-manager.js';
import { updateProjectAppPublication } from '../db.js';
import { projectChanges } from '../lib/project-changes.js';
import type { RegisteredGroup, AppPublicationSettings } from '../types.js';

export const appPublicationInput = z
  .object({
    enabled: z.boolean(),
    targetPort: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .refine(
        (port) => port !== 2222,
        'The managed SSH port cannot be published as an app',
      )
      .optional(),
    hostname: z
      .string()
      .max(253)
      .trim()
      .toLowerCase()
      .regex(
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
        'Enter a hostname without a scheme or path',
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) => !value.enabled || value.targetPort !== undefined,
    'An app port is required',
  );
export interface AppPublicationStatus {
  enabled: boolean;
  ready: boolean;
  targetPort?: number;
  hostname?: string;
  url?: string;
  ingressUrl?: string;
  host?: string;
  port?: number;
}
function appPublicationTarget(group: RegisteredGroup) {
  const effective = resolveEffectiveSandbox(group);
  return {
    stack: effective.stack,
    instance: effective.instance,
    service: effective.service,
    id: `board-${sha256Hex(group.folder).slice(0, 24)}`,
  };
}
async function command(
  client: Pick<SandboxClient, 'sandboxPublishApp'>,
  binding: AppPublicationSettings['binding'],
  action: 'status' | 'publish' | 'unpublish',
  input?: z.infer<typeof appPublicationInput>,
  aliases?: string[],
): Promise<AppPublicationStatus> {
  const result = await client.sandboxPublishApp(binding.stack, {
    instance: binding.instance,
    id: binding.id,
    action,
    service: binding.service,
    ...(action === 'publish'
      ? { targetPort: input!.targetPort, hostname: input!.hostname, aliases }
      : {}),
  });
  if (result.isError)
    throw new Error(result.stdout || 'CarapaBox app publishing failed');
  const status = JSON.parse(result.stdout);
  if (typeof status.enabled !== 'boolean' || typeof status.ready !== 'boolean')
    throw new Error('Invalid CarapaBox publication response');
  return status;
}
export async function getAppPublication(
  group: RegisteredGroup,
  client: Pick<SandboxClient, 'sandboxPublishApp'> = getSandboxClient(),
) {
  const saved = group.settings?.appPublication;
  if (!saved) return { enabled: false, ready: false };
  return command(client, saved.binding, 'status');
}

const pending = new Map<string, Promise<unknown>>();
export async function setAppPublication(
  group: RegisteredGroup,
  raw: unknown,
  client: Pick<SandboxClient, 'sandboxPublishApp'> = getSandboxClient(),
) {
  const input = appPublicationInput.parse(raw);
  const operation = async () => {
    const current = getGroupEntryByFolder(group.folder);
    if (!current) throw new Error('Project not found');
    const previous = current.group.settings?.appPublication;
    const binding = input.enabled
      ? appPublicationTarget(current.group)
      : previous?.binding;
    if (!binding) return { enabled: false, ready: false };
    if (
      input.enabled &&
      previous?.enabled &&
      JSON.stringify(previous.binding) !== JSON.stringify(binding)
    ) {
      await command(client, previous.binding, 'unpublish');
    }
    // Persist the desired setting and binding before contacting Box. A failed
    // request remains discoverable/revocable after a connection loss or restart.
    const save = async (enabled: boolean) => {
      const saved: AppPublicationSettings = {
        ...(input.enabled ? {} : previous),
        ...input,
        enabled,
        binding,
      };
      await updateProjectAppPublication(group.folder, saved);
      const latest = getGroupEntryByFolder(group.folder);
      if (!latest) throw new Error('Project disappeared while publishing');
      const settings = { ...latest.group.settings, appPublication: saved };
      latest.group.settings = settings;
      applyGroupUpdateInMemory(latest.jid, { settings });
    };
    // Keep enabled until revocation is acknowledged so a failed disable cannot
    // allow a sandbox identity change to orphan a still-live route.
    await save(input.enabled || previous?.enabled === true);
    // The admin's proxy aliases come from project settings, never from the
    // caller, so an app can use them without claiming other projects' names.
    const result = await command(
      client,
      binding,
      input.enabled ? 'publish' : 'unpublish',
      input,
      resolveEffectiveSandbox(current.group).proxyHostnameAliases,
    );
    if (!input.enabled) await save(false);
    else projectChanges.emit('changed'); // Refresh the URL after Box acknowledges publication.
    return result;
  };
  const previous = pending.get(group.folder) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  pending.set(group.folder, next);
  try {
    return await next;
  } finally {
    if (pending.get(group.folder) === next) pending.delete(group.folder);
  }
}
