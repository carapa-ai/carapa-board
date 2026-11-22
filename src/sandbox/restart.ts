import path from 'node:path';
import { getSandboxClient } from '../lib/mcp-client.js';
import { getTmuxClient } from '../lib/tmux-client.js';
import { getOnDemandSandboxes } from '../lib/on-demand-sandboxes.js';
import { registeredGroups } from '../state-manager.js';
import { DATA_DIR } from '../config.js';
import { finalizeSandboxBrowsers } from './browser-lifecycle.js';
import { prepareSandboxIpcRunsDir } from './ipc-directories.js';
import { buildSandboxEnv } from './sandbox-env.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import { logger } from '../logger.js';
import { refreshBrainPortCache } from '../modules/objectives/brain-client.js';
import { generateAgentToken, revokeGroupTokens } from '../mcp/auth-tokens.js';
import { getAgentPermissionsResolved } from '../mcp/auth.js';
import type { resolveEffectiveSandbox } from './effective-settings.js';
import {
  interruptSandboxChatRuns,
  interruptSandboxTaskRuns,
} from './run-interruption.js';
import { runningStackNamesForInstance } from './status.js';

export interface SandboxRestartRequest {
  stack: string;
  instance: string | undefined;
  target: ReturnType<typeof resolveEffectiveSandbox> | undefined;
  /**
   * Stacks to start once everything on the instance is stopped, each with the
   * Compose service to start (`null` starts the whole stack). Defaults to
   * `stack` with the target's configured service. All of them are started
   * after a single stop, so an earlier start is never stopped by a later one.
   */
  start?: Array<{ stack: string; service: string | null }>;
}

/**
 * Stop then start a managed sandbox, broadcasting `sandbox_status` progress.
 * Shared by the immediate-restart route and the restart-when-idle poller.
 * Never throws: failures are broadcast as `restart_failed` and reported by
 * resolving to `false`.
 */
export async function performSandboxRestart({
  stack,
  instance,
  target,
  start,
}: SandboxRestartRequest): Promise<boolean> {
  const client = getSandboxClient();

  broadcast({
    type: 'sandbox_status',
    payload: { stack, instance, action: 'restarting' },
  });

  try {
    logger.info({ stack, instance }, 'Restarting sandbox via API');
    let runningStacks: string[] = [];
    if (target && instance) {
      // Instance-filtered sandbox_ps calls are fresh (not served from the
      // polling cache), so a restart sees the actual current runtime.
      const psResult = await client.sandboxPs(instance);
      if (!psResult.isError) {
        runningStacks = runningStackNamesForInstance(psResult.stdout, instance);
      } else {
        logger.warn(
          { stack, instance, stdoutLength: psResult.stdout.length },
          'Could not discover running sandbox stack; using configured stack',
        );
      }
    }

    // sandbox_ps reports the actual stack that owns this managed instance.
    // This may differ from the freshly-saved defaultSandbox setting.
    const stacksToStop = runningStacks.length > 0 ? runningStacks : [stack];
    for (const runningStack of stacksToStop) {
      logger.info(
        { runningStack, targetStack: stack, instance },
        'Stopping sandbox before restart',
      );
      await finalizeSandboxBrowsers(runningStack, instance);
      const stopResult = await client.sandboxStop(runningStack, instance);
      if (stopResult.isError) {
        throw new Error(
          `Failed to stop sandbox before restart: ${stopResult.stdout}`,
        );
      }
    }
    await interruptSandboxChatRuns(instance).catch((error) =>
      logger.error(
        { stack, instance, error },
        'Failed to finalize chat runs during sandbox restart',
      ),
    );
    await interruptSandboxTaskRuns(instance, 'restart').catch((error) =>
      logger.error(
        { stack, instance, error },
        'Failed to interrupt task runs during sandbox restart',
      ),
    );
    if (instance) {
      await getTmuxClient().forgetByInstance(instance);
      await getOnDemandSandboxes().forgetByInstance(instance);
    }
    await refreshBrainPortCache();

    // One token for every stack of the instance: minting a second one would
    // revoke the one the first container was started with.
    const token = target
      ? await (async () => {
          await revokeGroupTokens(target.owner.folder);
          const perms = await getAgentPermissionsResolved(
            target.owner,
            registeredGroups,
          );
          return generateAgentToken(
            {
              group_folder: target.owner.folder,
              permissions: perms,
            },
            null,
          );
        })()
      : undefined;

    let result: Awaited<ReturnType<typeof client.sandboxStart>> | undefined;
    for (const entry of start ?? [
      { stack, service: target?.service ?? null },
    ]) {
      // Pre-create the host-side IPC directory BEFORE the sandbox starts.
      // If Docker creates the bind-mount target first, it will be root-owned
      // and the board process won't be able to write to it.
      const ipcDir = path.join(
        DATA_DIR,
        'ipc',
        `${entry.stack}-${instance || 'default'}`,
      );
      await prepareSandboxIpcRunsDir(ipcDir, client, entry.stack, instance);

      const env =
        target && token
          ? {
              ...buildSandboxEnv(target.owner, entry.stack),
              CARAPA_BOARD_API_TOKEN: token,
            }
          : undefined;
      result = await client.sandboxStart(
        entry.stack,
        env,
        instance,
        entry.service ?? undefined,
      );
      if (result.isError) {
        throw new Error(
          result.stdout || `CarapaBox failed to start ${entry.stack}`,
        );
      }
    }

    broadcast({
      type: 'sandbox_status',
      payload: { stack, instance, action: 'restarted', result },
    });

    await refreshBrainPortCache();

    logger.info({ stack, instance }, 'Sandbox restarted successfully');
    return true;
  } catch (err) {
    logger.error(
      { stack, instance, error: String(err) },
      'Failed to restart sandbox',
    );
    broadcast({
      type: 'sandbox_status',
      payload: {
        stack,
        instance,
        action: 'restart_failed',
        error: String(err),
      },
    });
    return false;
  }
}
