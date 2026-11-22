import { Router } from 'express';
import { sha256Hex } from '../lib/hash.js';
import fs from 'fs';
import path from 'path';
import { getActiveRunById, userCanAccessConversation } from '../db.js';
import { getGroupByFolder, registeredGroups } from '../state-manager.js';
import { tryExtendRun, isExtendable } from '../sandbox/stall-registry.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import { getTmuxClient } from '../lib/tmux-client.js';
import {
  getOnDemandSandboxes,
  onDemandRecordKey,
  type OnDemandSandboxRecord,
} from '../lib/on-demand-sandboxes.js';
import { buildSandboxEnv } from '../sandbox/sandbox-env.js';
import { generateAgentToken, revokeAgentToken } from '../mcp/auth-tokens.js';
import { revokePendingShellTokens } from '../lib/pending-shell-tokens.js';
import { getAgentPermissionsResolved } from '../mcp/auth.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import { logger } from '../logger.js';
import { DATA_DIR } from '../config.js';
import { refreshBrainPortCache } from '../modules/objectives/brain-client.js';
import {
  lifecycleSandboxInstance,
  resolveEffectiveSandbox,
} from '../sandbox/effective-settings.js';
import { isSandboxRunning } from '../sandbox/status.js';
import { requireAuth } from './auth-helpers.js';
import { canAccessProject, userHasExplicitGroupAccess } from './_helpers.js';

const router = Router();

/**
 * Outcome of a sandbox status probe.
 *
 * - `running`: the container is conclusively up.
 * - `stopped`: the container is conclusively down (safe to start).
 * - `status-error`: the box answered, but with an error (unknown state).
 * - `unavailable`: the status call itself failed (unknown state).
 */
type SandboxStatusProbe =
  | { state: 'running' }
  | { state: 'stopped'; stdout: string }
  | { state: 'status-error'; stdout: string }
  | { state: 'unavailable'; error: string };

/**
 * Probe whether a sandbox container is running. Never throws: an unknown
 * state is reported as such so callers can fail closed instead of
 * restarting a container that may still be alive.
 */
async function probeSandboxStatus(
  stack: string,
  instance: string,
): Promise<SandboxStatusProbe> {
  const client = getSandboxClient();
  try {
    const status = await client.sandboxStatus(stack, instance);
    if (status.isError) return { state: 'status-error', stdout: status.stdout };
    if (isSandboxRunning(status)) return { state: 'running' };
    return { state: 'stopped', stdout: status.stdout };
  } catch (err) {
    return { state: 'unavailable', error: String(err) };
  }
}

type RunUser = { id: string; role?: string };

/**
 * Read-level access to a project's runs and shells: admins (except on another
 * user's personal main) and explicit members of any level. Implicit chat-only
 * access and stray member rows on a foreign main are refused.
 */
async function canReadProjectRuns(
  user: RunUser,
  group_folder: string,
): Promise<boolean> {
  return canAccessProject(user, group_folder, { min: 'viewer' });
}

/**
 * Write-level access for "Keep waiting": admins (except on a foreign main),
 * explicit owners/editors, or an editor/owner of the run's conversation.
 */
async function canExtendRun(
  user: RunUser,
  run: { group_folder: string; conversation_id?: string | null },
): Promise<boolean> {
  if (await canAccessProject(user, run.group_folder, { min: 'editor' })) {
    return true;
  }
  if (!run.conversation_id) return false;
  if (
    !(await canAccessProject(user, run.group_folder, {
      min: 'viewer',
      implicit: true,
    }))
  ) {
    return false;
  }
  const level = await userCanAccessConversation(user.id, run.conversation_id);
  return level === 'editor' || level === 'owner';
}

router.get(
  '/active-runs/:runId/location',
  requireAuth,
  async (req: any, res) => {
    const run = await getActiveRunById(req.params.runId);
    if (!run) return res.status(404).json({ error: 'run not found' });
    if (!(await canReadProjectRuns(req.authUser, run.group_folder))) {
      return res.status(403).json({ error: 'No access to this project' });
    }
    return res.json({
      runId: run.id,
      projectId: run.group_folder,
      taskId: run.task_id ?? null,
      conversationId: run.conversation_id ?? null,
    });
  },
);

/**
 * Reset the stall watchdog on a live run. Cancels any pending grace-period
 * kill and rearms the idle timer. Returns 404 if the run has already exited
 * (no longer in the in-memory registry) or 403 if the caller doesn't have
 * access to the underlying project.
 *
 * Currently the chat-mode UI is expected to be the primary caller; kanban
 * background tasks have no UI affordance but the endpoint works there too.
 */
router.post(
  '/active-runs/:runId/extend',
  requireAuth,
  async (req: any, res) => {
    const { runId } = req.params;
    if (!runId) return res.status(400).json({ error: 'runId required' });

    if (!isExtendable(runId)) {
      return res
        .status(404)
        .json({ error: 'run not active or not extendable' });
    }

    const run = await getActiveRunById(runId);
    if (!run) return res.status(404).json({ error: 'run not found' });

    if (!(await canExtendRun(req.authUser, run))) {
      return res.status(403).json({ error: 'No access to this project' });
    }

    const ok = tryExtendRun(runId);
    if (!ok) return res.status(404).json({ error: 'run no longer extendable' });
    res.json({ ok: true });
  },
);

// ─── Project-scoped on-demand shell ───────────────────────────────────────────

/**
 * Tmux session name for a per-tab shell inside the project's shared
 * sandbox. Each tab gets its own session so its scrollback / cursor /
 * keystrokes stay isolated from sibling tabs. Names are short, valid
 * tmux identifiers, and uniquely derived from the UI-supplied tabId so
 * the box side can keep multiple sessions alive in parallel inside
 * one container.
 */
export function projectShellTmuxSession(tabId: string): string {
  const canonical = tabId.toLowerCase();
  const safe = canonical.replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  // Removing characters is lossy: `ab` and `a.b` would otherwise share a
  // tmux session, so closing one tab could kill the other tab's shell. Keep
  // the historical short names for ordinary IDs, and add a stable suffix
  // whenever sanitization or truncation could make IDs collide.
  if (tabId !== canonical || safe !== canonical) {
    const suffix = sha256Hex(tabId).slice(0, 12);
    return safe ? `shell-${safe}-${suffix}` : `shell-${suffix}`;
  }
  return `shell-${safe}`;
}

/**
 * POST /api/projects/:projectId/shells
 * Resolve (or lazily create) the project's shared chat-shell sandbox and
 * record a shell tab against it. This deliberately has no conversation
 * dependency: terminals belong to a project, including before its first chat.
 *
 * The shared sandbox is one CarapaBox container per project — every
 * shell tab in every conversation of that project reuses the same
 * `(stack, service, instance)` triple, with a unique tmux session name
 * per tab. This means opening N tabs only ever starts one container;
 * subsequent tabs are a cheap tracker-record write plus the in-box
 * `tmux new-session` call (already cheap).
 *
 * The container is started lazily on the first POST that observes no
 * existing shared record for the project; later POSTs reuse it. The
 * caller's optional `tabId` is recorded separately under
 * `${projectId}:${shellTabId}` so the UI can rehydrate its tab strip
 * across reloads.
 *
 * Mint a scoped per-group token, build the env, and call
 * `client.sandboxStart` with the project's `defaultSandboxService`.
 */
const shellOpenInFlight = new Map<string, Promise<void>>();

const postProjectShell = async (req: any, res: any) => {
  const { projectId } = req.params;
  if (!projectId) return res.status(400).json({ error: 'project id required' });

  // Optional per-shell discriminator. The chat bash tab sends one so
  // each tab gets its own tmux session name; the tab record survives
  // across reloads so the strip rehydrates with the same labels.
  const rawTabId =
    typeof req.body?.tabId === 'string' ? req.body.tabId.trim() : '';
  if (rawTabId.length > 64) {
    return res.status(400).json({ error: 'tabId is too long' });
  }
  const shellTabId = rawTabId || undefined;

  const group = getGroupByFolder(projectId);
  if (!group) {
    return res
      .status(404)
      .json({ error: 'No registered group for this project' });
  }
  if (!(await userHasExplicitGroupAccess(req, group.folder, { write: true }))) {
    return res.status(403).json({ error: 'No access to this project' });
  }

  const effective = resolveEffectiveSandbox(group);
  const stack = effective.stack;
  const service = effective.service;
  const instance = lifecycleSandboxInstance(effective);
  const sandboxProjectId = effective.owner.folder;

  const tracker = getOnDemandSandboxes();

  // Serialize the whole probe-and-record path for an effective sandbox owner.
  // Install our tail before waiting so simultaneous callers cannot overtake us.
  const previous = shellOpenInFlight.get(sandboxProjectId);
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = (previous ?? Promise.resolve()).then(() => done);
  shellOpenInFlight.set(sandboxProjectId, tail);
  await previous;
  try {
    // A previous failed or interrupted start owns its credential until its
    // deletion is durable. Never adopt or replace that pending record.
    await revokePendingShellTokens(sandboxProjectId);
    // Find (or start) the project's shared sandbox. We do this BEFORE
    // checking for a per-tab record because the shared record is what
    // owns the container — the tab record is just a thin pointer to it.
    let sharedRecord = tracker.getByProject(sandboxProjectId);
    if (
      sharedRecord &&
      (sharedRecord.stack !== stack ||
        sharedRecord.service !== (service || 'agent') ||
        sharedRecord.instance !== instance)
    ) {
      // Revoke while the tracker still owns the tokens: if revocation fails,
      // retain the records so a retry can complete the invalidation.
      const records = tracker.list();
      const tokens = new Set(
        Object.entries(records)
          .filter(
            ([key]) =>
              key === sandboxProjectId ||
              key.startsWith(`${sandboxProjectId}:`),
          )
          .map(([, record]) => record.agentToken)
          .filter((token): token is string => !!token),
      );
      for (const token of tokens) {
        await revokeAgentToken(token, { requirePersistence: true });
      }
      const stale = await tracker.forgetProject(sandboxProjectId);
      logger.info(
        {
          project_id: group.folder,
          sandbox_owner: sandboxProjectId,
          previous: {
            stack: sharedRecord.stack,
            service: sharedRecord.service,
            instance: sharedRecord.instance,
          },
          effective: { stack, service: service || 'agent', instance },
          invalidated_records: stale.length,
        },
        'Invalidated project shell cache after sandbox settings changed',
      );
      sharedRecord = undefined;
    }
    // The persisted shell tracker can be missing while the container is
    // healthy: the normal chat/task path auto-starts sandboxes without
    // writing a tracker record, and restart/stop paths clear the record.
    // Blindly calling `sandboxStart` in that case recreates a live
    // container (the box stops the stack before compose up), which kills
    // every in-flight run inside it. So probe the status first and adopt
    // a conclusively running sandbox instead of recreating it.
    const adoptRunningSandbox = async (): Promise<void> => {
      await tracker.record({
        projectId: sandboxProjectId,
        stack,
        service: service || 'agent',
        instance,
        // Deliberately no `agentToken`: the running container already
        // carries the token minted when it was started, and minting a
        // new one here would strand it.
        createdAt: Date.now(),
      });
    };

    let adoptedSharedNow = false;
    if (!sharedRecord && effective.inherited) {
      // A child must adopt the running parent-owned instance, not call
      // compose-start with new env and risk recreating it under sibling runs.
      const probe = await probeSandboxStatus(stack, instance);
      if (probe.state === 'running') {
        await adoptRunningSandbox();
        sharedRecord = tracker.getByProject(sandboxProjectId);
        logger.info(
          {
            project_id: group.folder,
            sandbox_owner: sandboxProjectId,
            instance,
          },
          'Child shell adopted running parent-owned sandbox without recreating it',
        );
      } else if (probe.state === 'unavailable') {
        logger.warn(
          {
            err: probe.error,
            project_id: group.folder,
            sandbox_owner: sandboxProjectId,
            instance,
          },
          'Child shell could not verify parent-owned sandbox status',
        );
        return res.status(503).json({
          error: `Parent-owned sandbox status is unavailable; retry or start it through project "${sandboxProjectId}"`,
          ownerProjectId: sandboxProjectId,
        });
      } else {
        logger.warn(
          {
            project_id: group.folder,
            sandbox_owner: sandboxProjectId,
            instance,
            statusError: probe.state === 'status-error',
            status: probe.stdout.slice(0, 200),
          },
          'Child shell cannot start unavailable parent-owned sandbox',
        );
        return res.status(probe.state === 'status-error' ? 503 : 409).json({
          error: `Parent-owned sandbox is unavailable; start it through project "${sandboxProjectId}"`,
          ownerProjectId: sandboxProjectId,
        });
      }
    } else if (!sharedRecord) {
      // Standalone project: the sandbox may already be running (auto-started
      // by the chat/task path, or left over from a cleared tracker record).
      // Adopt it instead of restarting it; a restart would kill in-flight
      // agent runs living in that container.
      const probe = await probeSandboxStatus(stack, instance);
      if (probe.state === 'running') {
        await adoptRunningSandbox();
        sharedRecord = tracker.getByProject(sandboxProjectId);
        adoptedSharedNow = true;
        logger.info(
          {
            project_id: group.folder,
            sandbox_owner: sandboxProjectId,
            instance,
          },
          'Project shell adopted running sandbox without recreating it',
        );
      } else if (probe.state !== 'stopped') {
        // Unknown status: fail closed. Restarting a possibly-running sandbox
        // is worse than asking the caller to retry.
        logger.warn(
          {
            project_id: group.folder,
            sandbox_owner: sandboxProjectId,
            instance,
            statusError: probe.state === 'status-error',
            ...(probe.state === 'status-error'
              ? { status: probe.stdout.slice(0, 200) }
              : { err: probe.error }),
          },
          'Project shell could not verify sandbox status',
        );
        return res
          .status(503)
          .json({ error: 'Sandbox status is unavailable; retry' });
      }
      // Conclusively stopped: fall through to the start path below.
    }
    let startedSharedNow = false;
    if (!sharedRecord) {
      let mintedToken: string | undefined;
      try {
        // Pre-create the host-side IPC directory BEFORE the sandbox
        // starts (mirrors the auto-start path so Docker doesn't claim
        // root ownership).
        const ipcDir = path.join(DATA_DIR, 'ipc', `${stack}-${instance}`);
        await fs.promises.mkdir(path.join(ipcDir, 'runs'), { recursive: true });

        // Mint a scoped per-group token. Do NOT call `revokeGroupTokens`
        // here — that would revoke the running agent's token (if any)
        // and 401 it on its next board API call, interrupting the
        // chat/task agent. The minted token is recorded in the
        // on-demand tracker and revoked individually on DELETE instead.
        const perms = await getAgentPermissionsResolved(
          effective.owner,
          registeredGroups,
        );
        const token = await generateAgentToken(
          { group_folder: effective.owner.folder, permissions: perms },
          null,
          async (pendingToken) => {
            await tracker.record({
              projectId: sandboxProjectId,
              stack,
              service: service || 'agent',
              instance,
              agentToken: pendingToken,
              pendingStart: true,
              createdAt: Date.now(),
            });
          },
        );

        mintedToken = token;
        const client = getSandboxClient();
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
              project_id: group.folder,
              instance,
              stdoutLength: result.stdout.length,
            },
            'On-demand sandbox start failed (project shell)',
          );
          return res.status(502).json({
            error: 'Failed to start on-demand sandbox',
            detail: result.stdout,
          });
        }

        await tracker.record({
          projectId: sandboxProjectId,
          stack,
          service: service || 'agent',
          instance,
          // Stash the minted token's plaintext so the matching DELETE can
          // revoke exactly this one token. Revoking by token (rather than
          // by group folder) is what keeps a running DirectLLM chat agent
          // alive when an on-demand shell is started in the same group.
          agentToken: token,
          createdAt: Date.now(),
        });
        mintedToken = undefined;
        startedSharedNow = true;

        broadcast({
          type: 'sandbox_status',
          payload: {
            stack,
            instance,
            action: 'started',
            source: 'project-shell',
          },
        });

        await refreshBrainPortCache();

        logger.info(
          { project_id: group.folder, stack, instance },
          'On-demand sandbox started for project shell',
        );
      } catch (err) {
        logger.error(
          { project_id: projectId, error: String(err) },
          'On-demand sandbox start threw (project shell)',
        );
        return res.status(500).json({ error: String(err) });
      } finally {
        if (mintedToken) {
          try {
            await revokeAgentToken(mintedToken, { requirePersistence: true });
            const pending = tracker.getByProject(sandboxProjectId);
            if (pending?.pendingStart && pending.agentToken === mintedToken) {
              await tracker.forget(sandboxProjectId);
            }
          } catch (err) {
            // Keep the pending record for the next open or startup recovery.
            logger.error(
              { err, project_id: sandboxProjectId },
              'Pending shell token cleanup failed',
            );
          }
        }
      }
    }

    // Refresh the local view of the shared record (we may have just
    // written it, or it was already there).
    const shared = tracker.getByProject(sandboxProjectId);
    if (!shared) {
      // Should not happen — we just ensured it above — but bail safely
      // rather than crash on a missing field below.
      return res
        .status(500)
        .json({ error: 'Failed to resolve shared chat shell' });
    }

    // If the caller identified a tab, record it under the effective sandbox
    // owner's namespace so the parent and every child inheriting that shared
    // sandbox rehydrate the same tmux tabs. Standalone projects remain keyed by
    // their own folder because they are their own effective owner.
    //
    // tab record stores the per-tab tmux session name so DELETE knows
    // which `tmux kill-session` to issue (each tab has its own session
    // inside the shared container).
    let tabTmuxSession: string | undefined;
    if (shellTabId) {
      tabTmuxSession = projectShellTmuxSession(shellTabId);
      const existingTab = tracker.getByProjectTab(sandboxProjectId, shellTabId);
      if (!existingTab) {
        await tracker.record({
          shellTabId,
          projectId: sandboxProjectId,
          stack: shared.stack,
          service: shared.service,
          instance: shared.instance,
          tmuxSession: tabTmuxSession,
          createdAt: Date.now(),
        });
      }
    }

    return res.status(startedSharedNow || adoptedSharedNow ? 201 : 200).json({
      stack: shared.stack,
      service: shared.service,
      instance: shared.instance,
      projectId: shared.projectId,
      ...(tabTmuxSession ? { tmuxSession: tabTmuxSession } : {}),
      reused: !startedSharedNow,
    });
  } finally {
    release();
    if (shellOpenInFlight.get(sandboxProjectId) === tail)
      shellOpenInFlight.delete(sandboxProjectId);
  }
};
router.post('/projects/:projectId/shells', requireAuth, postProjectShell);

/**
 * DELETE /api/projects/:projectId/shells/:tabId
 *
 * Close a single chat bash tab. Contract:
 *
 *   1. `body.tabId` is REQUIRED. A missing tabId is a 400 — closing
 *      the whole project's shared container is not a supported
 *      operation. The container (sandbox) is persistent by design:
 *      it stays alive across tab open/close cycles within a project
 *      so sibling tabs (and the next tab the user opens) keep
 *      reusing it. Only the per-tab tmux session inside it is
 *      transient.
 *   2. On a hit, this route:
 *        a. Fires a best-effort `tmux-tool.sh kill <tmuxSession>`
 *           against the box (fire-and-forget; failures are logged
 *           but do not block the response). This is the **server-
 *           side** kill — the React cleanup hook in `bash-tab.tsx`
 *           does NOT also call the tmux DELETE endpoint; this route
 *           is the single source of truth for close-tab cleanup.
 *        b. Forgets the per-tab tracker record so the UI strip
 *           rehydrates without it.
 *      The shared project record is left in place. The shared
 *      sandbox container is NEVER touched by this endpoint.
 *   3. Idempotent: a second DELETE for the same tabId returns 200
 *      with `stopped:false, reason:'no on-demand sandbox'` rather
 *      than 404, so retries from a flaky client are safe.
 */
const deleteProjectShell = async (req: any, res: any) => {
  try {
    return await handleDeleteProjectShell(req, res);
  } catch (err) {
    logger.error({ err }, 'DELETE /projects/:projectId/shells/:tabId crashed');
    return res.status(500).json({ error: String(err) });
  }
};
router.delete(
  '/projects/:projectId/shells/:tabId',
  requireAuth,
  deleteProjectShell,
);

async function handleDeleteProjectShell(req: any, res: any): Promise<any> {
  const { projectId } = req.params;
  if (!projectId) return res.status(400).json({ error: 'project id required' });
  const rawTabId =
    typeof req.params.tabId === 'string' ? req.params.tabId.trim() : '';
  if (rawTabId.length === 0) {
    return res.status(400).json({
      error:
        'tabId required — closing the project-wide shared sandbox is not supported',
    });
  }
  if (rawTabId.length > 64) {
    return res.status(400).json({ error: 'tabId is too long' });
  }
  const shellTabId = rawTabId;
  const group = getGroupByFolder(projectId);
  if (!group)
    return res
      .status(404)
      .json({ error: 'No registered group for this project' });
  const resolvedProjectId = group.folder;
  if (
    !(await userHasExplicitGroupAccess(req, resolvedProjectId, { write: true }))
  ) {
    return res.status(403).json({ error: 'No access to this project' });
  }
  const shellOwnerProjectId = resolveEffectiveSandbox(group).owner.folder;

  const tracker = getOnDemandSandboxes();

  // Look up the per-tab record. Idempotent: a missing record is a
  // 200 with `stopped:false` so a retry after a flaky network is
  // safe (the per-tab tmux session, if it was still alive, will be
  // reaped by the box's tmux-session TTL or the next reconcile
  // sweep).
  // Prefer the shared-owner namespace. Fall back to the requested project's
  // namespace for tabs persisted before shared-owner inheritance was added.
  const tabRecord =
    tracker.getByProjectTab(shellOwnerProjectId, shellTabId) ??
    (shellOwnerProjectId !== resolvedProjectId
      ? tracker.getByProjectTab(resolvedProjectId, shellTabId)
      : undefined);
  if (!tabRecord) {
    return res.json({
      ok: true,
      stopped: false,
      reason: 'no on-demand sandbox',
    });
  }

  // Server-side tmux kill. Fire-and-forget — the network round-trip
  // to the box is slow enough that blocking the response would feel
  // laggy, and a failure here just leaves an orphan session that
  // the box's tmux session TTL eventually reaps. The `tmux-tool.sh`
  // wrapper is a no-op when the session is already gone, so this is
  // safe to call twice in a race.
  if (tabRecord.tmuxSession) {
    const client = getSandboxClient();
    const cmd = `tmux-tool.sh kill ${tabRecord.tmuxSession}`;
    client
      .sandboxExec(tabRecord.stack, tabRecord.service, cmd, {
        instance: tabRecord.instance,
        timeout: 10_000,
      })
      .catch((err) => {
        logger.warn(
          {
            project_id: resolvedProjectId,
            shell_owner_project_id: shellOwnerProjectId,
            tabId: shellTabId,
            tmuxSession: tabRecord.tmuxSession,
            error: String(err),
          },
          'failed to kill per-tab tmux session during project-shell DELETE',
        );
      });

    // Also clean up the board's tmux session index entry so it
    // doesn't accumulate as an orphan in tmux-sessions.json. The
    // box-side kill above handles the actual tmux session; this
    // just removes the persisted lookup record. Fire-and-forget
    // (same as the kill) — a failure here just means the entry
    // gets reaped by the 24h TTL reconcile.
    getTmuxClient()
      .forgetBySession({
        stack: tabRecord.stack,
        service: tabRecord.service,
        instance: tabRecord.instance,
        session: tabRecord.tmuxSession,
      })
      .catch((err) => {
        logger.warn(
          {
            project_id: resolvedProjectId,
            shell_owner_project_id: shellOwnerProjectId,
            tabId: shellTabId,
            tmuxSession: tabRecord.tmuxSession,
            error: String(err),
          },
          'failed to forget tmux session index entry during project-shell DELETE',
        );
      });
  }

  // Forget the per-tab record. The shared project record (no
  // shellTabId) is intentionally preserved: the container stays up
  // and is reusable by future tabs in the same project.
  const tabKey = onDemandRecordKey(tabRecord);
  if (tabKey) await tracker.forget(tabKey);

  logger.info(
    {
      project_id: resolvedProjectId,
      shell_owner_project_id: shellOwnerProjectId,
      tab_id: shellTabId,
      tmux_session: tabRecord.tmuxSession,
      instance: tabRecord.instance,
    },
    'Project shell tab closed (sandbox retained)',
  );

  return res.json({
    ok: true,
    stopped: false,
    tmuxSession: tabRecord.tmuxSession ?? null,
    instance: tabRecord.instance,
    reason: 'tab closed; container retained',
  });
}

/**
 * GET /api/projects/:projectId/shells
 * Enumerate on-demand shells alive for a project's effective sandbox. Used by
 * the chat bash tab to rehydrate independently of whether a conversation is
 * selected. A child that inherits a parent-owned shared sandbox therefore sees
 * the same open tmux tabs as its parent and sibling projects.
 *
 * Returns `{shells: OnDemandSandboxRecord[]}` containing only actual
 * per-tab shell records (those with `shellTabId`). The shared project
 * record has no tab and merely keeps the container reusable, so it must
 * never rehydrate a closed shell tab. Returns an empty array when the project
 * has no open shell tabs — NOT a 404. A missing project is 404; unauthorized
 * callers receive 403.
 */
const listProjectShells = async (req: any, res: any) => {
  const { projectId } = req.params;
  if (!projectId) return res.status(400).json({ error: 'project id required' });
  const group = getGroupByFolder(projectId);
  if (!group)
    return res
      .status(404)
      .json({ error: 'No registered group for this project' });
  const resolvedProjectId = group.folder;
  if (!(await canReadProjectRuns(req.authUser, resolvedProjectId))) {
    return res.status(403).json({ error: 'No access to this project' });
  }
  const shellOwnerProjectId = resolveEffectiveSandbox(group).owner.folder;

  const tracker = getOnDemandSandboxes();
  const shellsByTabId = new Map<string, OnDemandSandboxRecord>();
  for (const shell of tracker
    .listByProject(shellOwnerProjectId)
    .filter((entry) => Boolean(entry.shellTabId))) {
    shellsByTabId.set(shell.shellTabId!, shell);
  }
  // Preserve sessions created by children on older releases. Owner records
  // win on a tab-id collision because they are the canonical shared namespace.
  if (shellOwnerProjectId !== resolvedProjectId) {
    for (const shell of tracker
      .listByProject(resolvedProjectId)
      .filter((entry) => Boolean(entry.shellTabId))) {
      if (!shellsByTabId.has(shell.shellTabId!)) {
        shellsByTabId.set(shell.shellTabId!, shell);
      }
    }
  }
  return res.json({ shells: [...shellsByTabId.values()] });
};
router.get('/projects/:projectId/shells', requireAuth, listProjectShells);

export default router;
