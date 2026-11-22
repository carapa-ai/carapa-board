/**
 * Group bootstrapping: sandbox startup.
 * Extracted from index.ts to isolate infrastructure bootstrapping concerns.
 */

import { buildSandboxEnv } from './sandbox/sandbox-env.js';
import { getTasksByProject } from './db.js';
import { getGroupStages } from './modules/kanban/stages.js';
import { broadcast } from './modules/objectives/ws-events.js';
import { refreshBrainPortCache } from './modules/objectives/brain-client.js';
import { logger } from './logger.js';
import { getSandboxClient } from './lib/mcp-client.js';
import { summarizeBoxFailure } from './lib/box-failure.js';
import { generateAgentToken, revokeGroupTokens } from './mcp/auth-tokens.js';
import { getAgentPermissionsResolved } from './mcp/auth.js';
import { syncBoardRelayToken } from './sandbox/relay-token-sync.js';
import { registeredGroups } from './state-manager.js';
import { resolveEffectiveSandbox } from './sandbox/effective-settings.js';
import { isSandboxRunning } from './sandbox/status.js';

export async function ensureGroupSandboxes(): Promise<void> {
  const client = getSandboxClient();
  const visitedSandboxes = new Set<string>();

  // Verify server is reachable first
  try {
    const psResult = await client.sandboxPs();
    if (psResult.isError) {
      logger.warn(
        { stdoutLength: psResult.stdout.length },
        'CarapaBox returned error',
      );
      return;
    }
    logger.info('CarapaBox is reachable');
  } catch (err) {
    logger.error(
      { err },
      'Failed to reach CarapaBox — sandboxes will start on-demand',
    );
    return;
  }

  for (const group of Object.values(registeredGroups)) {
    const effective = resolveEffectiveSandbox(group);
    const { stack, instance, service } = effective;
    const sandboxKey = `${stack}:${instance}`;
    const isChat = !group.settings?.mode || group.settings.mode === 'chat';
    // Respect per-project autoStartStack setting (default: true)
    if (!effective.autoStart || !effective.managed) {
      logger.debug(
        { instance },
        'Skipping sandbox auto-start — disabled in project settings',
      );
      continue;
    }

    let shouldStart = false;

    if (!!group.is_main || isChat) {
      // Always-on groups: main orchestrator + chat-mode WhatsApp groups
      shouldStart = true;
    } else {
      // Kanban projects: only if running and has non-done tasks
      const projectStatus = group.settings?.status || 'running';
      if (projectStatus === 'running') {
        try {
          const stages = getGroupStages(group);
          const doneStageIds = new Set(
            stages
              .filter((s) => s.type === 'done' && !s.inactive)
              .map((s) => s.id),
          );
          const tasks = await getTasksByProject(group.folder);
          shouldStart = tasks.some((f) => !doneStageIds.has(f.status));
        } catch (err) {
          logger.error(
            { err, folder: group.folder },
            'Failed to check project work for sandbox auto-start — skipping project',
          );
          continue;
        }
      }
    }

    if (!shouldStart) {
      logger.debug(
        { instance, mode: isChat ? 'chat' : 'kanban' },
        'Skipping sandbox — no work',
      );
      continue;
    }
    if (visitedSandboxes.has(sandboxKey)) continue;
    visitedSandboxes.add(sandboxKey);

    try {
      const status = await client.sandboxStatus(stack, instance);
      const running = isSandboxRunning(status);

      if (running) {
        // The sandbox outlived this board process (only carapa-board bounced).
        // Its api-relay still holds the CARAPA_BOARD_API_TOKEN that was valid for
        // the *previous* board; this board rotates tokens on boot, so that env
        // token is now stale and the next freshly-spawned agent would be rejected
        // on its first authenticated call (new chats fail until a manual sandbox
        // restart). Re-issue a fresh token and push it into carapa-box's
        // relay-token store out-of-band — the relay's per-client token cache +
        // 401 self-heal (`invalidatePerClientToken`) picks it up on the next
        // call WITHOUT restarting the sandbox. This keeps in-flight agents
        // alive across a board bounce.
        //
        // Order matters: mint and push the new token BEFORE revoking the old ones
        // so the relay is never left without a valid token if the push fails.
        logger.info(
          { instance },
          'Sandbox already running — refreshing agent token via relay (no restart)',
        );
        try {
          const perms = await getAgentPermissionsResolved(
            effective.owner,
            registeredGroups,
          );
          const token = await generateAgentToken(
            { group_folder: effective.owner.folder, permissions: perms },
            null,
          );
          const pushed = await syncBoardRelayToken(effective.owner, token);
          if (pushed) {
            // Push succeeded — now invalidate every prior sandbox-level token
            // for this group, keeping the one the relay just adopted. Run-scoped
            // tokens (reattached or already-started runs, written into their
            // .mcp.json) stay valid: their agents are still running.
            await revokeGroupTokens(effective.owner.folder, {
              exceptToken: token,
              sandboxLevelOnly: true,
            });
            logger.info(
              { instance },
              'Refreshed agent token in running sandbox via relay',
            );
            await refreshBrainPortCache();
          } else {
            // Push failed — DO NOT revoke the old token (it may still be the
            // one the running sandbox is using). The running sandbox keeps
            // working with its current token; only newly-spawned agents will
            // hit 401 until the next board restart or until carapa-box's
            // relay-token store catches up.
            logger.warn(
              { instance },
              'Board relay-token push failed — leaving existing tokens intact',
            );
          }
        } catch (err) {
          logger.error(
            { err, instance },
            'Error refreshing agent token in running sandbox',
          );
        }
        continue;
      }

      logger.info({ instance, stack }, 'Auto-starting sandbox');

      // Mint a scoped per-group token (no fixed expiry — its validity is
      // bound to this sandbox's lifecycle via revokeGroupTokens on stop and
      // the liveness sweep). Revoke any orphans first so tokens don't pile up.
      await revokeGroupTokens(effective.owner.folder);
      const perms = await getAgentPermissionsResolved(
        effective.owner,
        registeredGroups,
      );
      const token = await generateAgentToken(
        { group_folder: effective.owner.folder, permissions: perms },
        null,
      );

      const result = await client.sandboxStart(
        stack,
        {
          ...buildSandboxEnv(effective.owner, stack),
          CARAPA_BOARD_API_TOKEN: token,
        },
        instance,
        service,
      );
      if (result.isError) {
        logger.error(
          {
            instance,
            stdoutLength: result.stdout.length,
            error: summarizeBoxFailure(result.stdout),
            stack,
          },
          'Sandbox auto-start failed',
        );
      } else {
        logger.info({ instance }, 'Sandbox auto-started');
        broadcast({
          type: 'sandbox_status',
          payload: { stack, instance, action: 'started' },
        });

        await refreshBrainPortCache();
      }
    } catch (err) {
      logger.error({ err, instance }, 'Failed to check/start sandbox');
    }
  }
}
