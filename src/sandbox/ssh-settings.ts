import { getSandboxClient } from '../lib/mcp-client.js';
import { updateProjectSshPreference } from '../db.js';
import { getGroupByFolder } from '../state-manager.js';
import type { resolveEffectiveSandbox } from './effective-settings.js';

export interface SandboxSshStatus {
  supported: boolean;
  containerRunning: boolean;
  running: boolean;
  enabled?: boolean;
  pending?: boolean;
  service?: string;
  host?: string;
  port?: number;
  user?: string;
  command?: string;
  /** Connection uses the LAN ingress host and reserved port. */
  ingress?: boolean;
  /** Sandbox address for diagnostics; use host and port to connect. */
  internalHost?: string;
  error?: string;
}

type Target = ReturnType<typeof resolveEffectiveSandbox>;
const updates = new Map<string, Promise<void>>();

export async function readSandboxSsh(
  target: Target,
): Promise<SandboxSshStatus> {
  const result = await getSandboxClient().sandboxSsh(
    target.stack,
    'status',
    target.instance,
  );
  if (result.isError) throw new Error(result.stdout);
  return JSON.parse(result.stdout) as SandboxSshStatus;
}

export async function setSandboxSsh(
  target: Target,
  enabled: boolean,
  deps = {
    readSandboxSsh,
    updateProjectSshPreference,
    getGroupByFolder,
    getSandboxClient,
  },
): Promise<SandboxSshStatus> {
  const key = `${target.stack}:${target.instance}`;
  const previous = updates.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  updates.set(key, current);
  await previous;
  try {
    const status = await deps.readSandboxSsh(target);
    if (!status.supported || status.service !== target.service) {
      throw new Error('This sandbox service does not support managed SSH');
    }
    // Desired state remains authoritative if Box is unavailable during apply.
    // The API reports that failure, and the next managed start retries it.
    await deps.updateProjectSshPreference(target.owner.folder, enabled);
    const owner = deps.getGroupByFolder(target.owner.folder);
    if (owner) owner.settings = { ...owner.settings, sshEnabled: enabled };
    const result = await deps
      .getSandboxClient()
      .sandboxSsh(target.stack, enabled ? 'start' : 'stop', target.instance);
    if (result.isError)
      throw new Error(
        `SSH preference saved, but could not apply it: ${result.stdout}`,
      );
    return JSON.parse(result.stdout) as SandboxSshStatus;
  } finally {
    release();
    if (updates.get(key) === current) updates.delete(key);
  }
}
