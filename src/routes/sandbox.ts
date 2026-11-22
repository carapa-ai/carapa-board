import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { getSandboxClient } from '../lib/mcp-client.js';
import { registeredGroups, getGroupByFolder } from '../state-manager.js';
import {
  DATA_DIR,
  ENABLE_GITNEXUS,
  GITNEXUS_REGISTRY_PATH,
} from '../config.js';
import { finalizeSandboxBrowsers } from '../sandbox/browser-lifecycle.js';
import { prepareSandboxIpcRunsDir } from '../sandbox/ipc-directories.js';
import { buildSandboxEnv } from '../sandbox/sandbox-env.js';
import { broadcast } from '../modules/objectives/ws-events.js';
import { logger } from '../logger.js';
import {
  resolveBrainContainer,
  refreshBrainPortCache,
} from '../modules/objectives/brain-client.js';
import {
  isSafeIdentifier,
  canAccessProject,
  userHasExplicitGroupAccess,
  isAdminUser,
  isAgentCredential,
  isTaskRunCredential,
} from './_helpers.js';
import { generateAgentToken, revokeGroupTokens } from '../mcp/auth-tokens.js';
import { getAgentPermissionsResolved, hasPermission } from '../mcp/auth.js';
import {
  cancelIdleRestart,
  getIdleRestartWaitingOn,
  getPendingIdleRestart,
  requestIdleRestart,
  supersedeIdleRestart,
} from '../sandbox/idle-restart.js';
import { performSandboxRestart } from '../sandbox/restart.js';
import {
  effectiveRemoteUrl,
  lifecycleSandboxInstance,
  resolveEffectiveSandbox,
} from '../sandbox/effective-settings.js';
import {
  interruptSandboxChatRuns,
  interruptSandboxTaskRuns,
} from '../sandbox/run-interruption.js';
import { readSandboxSsh, setSandboxSsh } from '../sandbox/ssh-settings.js';
import {
  isSandboxRunning,
  runningStackNamesForInstance,
} from '../sandbox/status.js';

export { runningStackNamesForInstance };
import {
  ConversationWorktreeInUseError,
  transitionConversationsFromRemovedWorktree,
} from '../db.js';
import { escapeRegex } from '../utils.js';

const router = Router();

const VERSIONS_CACHE_TTL = 30_000; // 30 seconds
let versionsCache: { data: unknown; ts: number } | null = null;

/** Parse sandbox_status JSON output into per-service entries with UpToDate flag. */
function parseStatusEntries(raw: string): Array<{
  Service: string;
  UpToDate?: boolean;
  ImageID?: string;
  State?: string;
  Status?: string;
}> {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Parse raw MCP sandbox_status stdout into a normalized object */
export function parseStatus(raw: { stdout: string; isError: boolean }): {
  status: 'running' | 'degraded' | 'stopped' | 'error';
  raw: string;
  containers?: Array<{
    service: string;
    upToDate: boolean | null;
    imageId?: string;
    state?: string;
    statusText?: string;
  }>;
} {
  if (raw.isError) return { status: 'error', raw: raw.stdout };
  const s = raw.stdout;

  // Extract per-container UpToDate info from the JSON output
  let containers:
    | Array<{
        service: string;
        upToDate: boolean | null;
        imageId?: string;
        state?: string;
        statusText?: string;
      }>
    | undefined;
  try {
    const entries = parseStatusEntries(s);
    if (entries.length > 0) {
      containers = entries.map((e) => ({
        service: (e.Service as string) || 'unknown',
        upToDate: e.UpToDate != null ? e.UpToDate === true : null,
        imageId: (e.ImageID as string) || undefined,
        state: (e.State as string) || undefined,
        // `Status` is the human-readable docker compose status, e.g. "Up 2 minutes"
        // or "Exited (0) 3 minutes ago". Used by the UI to derive uptime.
        statusText: (e.Status as string) || undefined,
      }));
    }
  } catch {
    /* keep undefined */
  }

  if (isSandboxRunning(raw)) {
    // One running service (e.g. nginx) must not hide a crash-looping peer.
    const degraded = containers?.some(
      (c) => c.state === 'restarting' || c.state === 'dead',
    );
    return { status: degraded ? 'degraded' : 'running', raw: s, containers };
  }
  return { status: 'stopped', raw: s, containers };
}

/** GET /api/sandbox/status
 * Get sandbox status for a specific group instance.
 * Query params:
 *   ?group=<folder>  — check the sandbox instance for this group
 * Without params, returns status for all registered group instances.
 */
router.get('/sandbox/status', async (req: any, res) => {
  const client = getSandboxClient();
  const requestedGroup = req.query.group as string | undefined;

  try {
    if (requestedGroup) {
      if (!(await userHasExplicitGroupAccess(req, requestedGroup))) {
        return res.status(403).json({ error: 'Access denied to this group' });
      }
      // Find the group's stack config
      const group = getGroupByFolder(requestedGroup);
      if (!group) return res.status(404).json({ error: 'Group not found' });
      const effective = resolveEffectiveSandbox(group);
      const result = await client.sandboxStatus(
        effective.stack,
        effective.instance,
        undefined,
        { observe: true },
      );
      return res.json({ [requestedGroup]: parseStatus(result) });
    }

    // Return status for registered group instances the caller can see.
    // Resolve access checks and MCP status calls in parallel — sequential
    // awaits made this O(group_count) round-trips and dominated /sandbox/status
    // latency on installs with many groups.
    const groups = Object.values(registeredGroups);
    const accessFlags = await Promise.all(
      groups.map((g) => userHasExplicitGroupAccess(req, g.folder)),
    );
    const visibleGroups = groups.filter((_, i) => accessFlags[i]);
    const statuses = await Promise.allSettled(
      visibleGroups.map(async (g) => {
        const effective = resolveEffectiveSandbox(g);
        let result: Awaited<ReturnType<typeof client.sandboxStatus>>;
        try {
          result = await client.sandboxStatus(
            effective.stack,
            effective.instance,
            undefined,
            { observe: true },
          );
        } catch (error) {
          return { status: 'error' as const, raw: String(error) };
        }
        return parseStatus(result);
      }),
    );
    // Connection failures are settled above; an entirely rejected batch means
    // resolving or parsing the lookups failed, so surface the server error.
    if (statuses.length > 0 && statuses.every((s) => s.status === 'rejected')) {
      throw (statuses[0] as PromiseRejectedResult).reason;
    }
    const statusPairs = statuses.map((s, i) => [
      visibleGroups[i].folder,
      s.status === 'fulfilled'
        ? s.value
        : { status: 'error', raw: String(s.reason) },
    ]);
    res.json(Object.fromEntries(statusPairs));
  } catch (err) {
    logger.error({ error: String(err) }, 'Failed to get sandbox status');
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/sandbox/ps
 * List all running sandbox instances with their services.
 */
router.get('/sandbox/ps', async (req: any, res) => {
  const client = getSandboxClient();
  const instance =
    typeof req.query.instance === 'string' ? req.query.instance : undefined;
  if (!isSafeIdentifier(instance)) {
    return res.status(400).json({ error: 'Invalid instance name' });
  }
  try {
    // Instance-filtered calls bypass CarapaBox's polling cache. The sidebar
    // uses this after lifecycle events so stopped services disappear and
    // newly assigned ports show up without waiting for the global ps poll.
    const result = await client.sandboxPs(instance);
    if (result.isError) {
      return res.status(500).json({ error: result.stdout });
    }
    // stdout is JSON array or "No running sandboxes found."
    let instances: any[] = [];
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed)) instances = parsed;
    } catch {
      instances = [];
    }
    if (!isAdminUser(req)) {
      // Filter to instances that map to a group the caller can access.
      const filtered: any[] = [];
      for (const inst of instances) {
        const folder =
          inst?.instance ?? inst?.Instance ?? inst?.group ?? inst?.Group;
        if (folder) {
          const matchingGroups = Object.values(registeredGroups).filter(
            (group) =>
              resolveEffectiveSandbox(group).instance === String(folder),
          );
          const access = await Promise.all(
            matchingGroups.map((group) =>
              userHasExplicitGroupAccess(req, group.folder),
            ),
          );
          if (access.some(Boolean)) filtered.push(inst);
        }
      }
      instances = filtered;
    }
    res.json(instances);
  } catch (err) {
    logger.error({ error: String(err) }, 'Failed to list sandbox instances');
    res.status(500).json({ error: String(err) });
  }
});

interface LifecycleTargetDeps {
  userHasExplicitGroupAccess: typeof userHasExplicitGroupAccess;
  getGroupByFolder: typeof getGroupByFolder;
}

/**
 * Sandbox lifecycle changes are not available to task runs, and other agent
 * tokens need `sandbox:restart` on the target project (as the
 * `sandbox_restart_when_idle` MCP tool does). Human users are unaffected. Returns the 403 message, or null when allowed.
 */
function agentLifecycleDenial(req: any, group?: string): string | null {
  if (!isAgentCredential(req)) return null;
  const scope = req.tokenScope;
  if (isTaskRunCredential(req)) {
    return 'Sandbox lifecycle is not available to task runs';
  }
  if (group && !hasPermission(scope?.permissions, group, 'sandbox:restart')) {
    return 'Missing "sandbox:restart" permission for this project';
  }
  return null;
}

export async function resolveLifecycleTarget(
  req: any,
  res: any,
  requestedStack: string,
  deps: LifecycleTargetDeps = { userHasExplicitGroupAccess, getGroupByFolder },
  allowInheritedOperation = false,
  write = true,
) {
  const requestedGroup =
    typeof req.query.group === 'string'
      ? req.query.group
      : typeof req.body?.group === 'string'
        ? req.body.group
        : undefined;
  if (write) {
    const denial = agentLifecycleDenial(req, requestedGroup);
    if (denial) {
      res.status(403).json({ error: denial });
      return null;
    }
  }
  if (!requestedGroup) return undefined;
  if (!isSafeIdentifier(requestedGroup)) {
    res.status(400).json({ error: 'Invalid group name' });
    return null;
  }
  if (
    !(await deps.userHasExplicitGroupAccess(req, requestedGroup, { write }))
  ) {
    res.status(403).json({ error: 'Access denied to this group' });
    return null;
  }
  const group = deps.getGroupByFolder(requestedGroup);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return null;
  }
  const effective = resolveEffectiveSandbox(group, deps.getGroupByFolder);
  // A child may use the running shared sandbox, but it never owns its
  // lifecycle. Requiring parent access is not sufficient: a user acting on a
  // child could still tear down sibling runs accidentally. Lifecycle callers
  // must address the owner project explicitly.
  if (effective.inherited && !allowInheritedOperation) {
    res.status(409).json({
      error: `Sandbox lifecycle is owned by parent project "${effective.owner.folder}"`,
    });
    return null;
  }
  if (requestedStack !== effective.stack) {
    res.status(403).json({ error: 'Access denied to this stack' });
    return null;
  }
  return effective;
}

router.get('/sandbox/:stack/ssh', async (req: any, res) => {
  if (!isSafeIdentifier(req.params.stack))
    return res.status(400).json({ error: 'Invalid stack' });
  const target = await resolveLifecycleTarget(
    req,
    res,
    req.params.stack,
    undefined,
    true,
    false,
  );
  if (target === null) return;
  if (!target)
    return res.status(400).json({ error: 'Project group is required' });
  try {
    const status = await readSandboxSsh(target);
    res.json({
      ...status,
      enabled: target.owner.settings?.sshEnabled === true,
    });
  } catch (error) {
    res.status(502).json({ error: String(error) });
  }
});

router.post('/sandbox/:stack/ssh', async (req: any, res) => {
  if (
    !isSafeIdentifier(req.params.stack) ||
    typeof req.body?.enabled !== 'boolean'
  ) {
    return res
      .status(400)
      .json({ error: 'A valid stack and boolean enabled are required' });
  }
  // Exposing SSH is a user-owned capability, never an agent action.
  if (!req.authUser || isAgentCredential(req)) {
    return res
      .status(403)
      .json({ error: 'Only users can change sandbox SSH access' });
  }
  const target = await resolveLifecycleTarget(req, res, req.params.stack);
  if (target === null) return;
  if (!target)
    return res.status(400).json({ error: 'Project group is required' });
  if (rejectFixedInstanceLifecycle(res, target)) return;
  try {
    const status = await setSandboxSsh(target, req.body.enabled);
    res.json({ ...status, enabled: req.body.enabled });
  } catch (error) {
    res.status(502).json({ error: String(error) });
  } finally {
    broadcast({
      type: 'sandbox_status',
      payload: {
        stack: target.stack,
        instance: target.instance,
        group: target.owner.folder,
        action: 'ssh_changed',
      },
    });
  }
});

export function rejectFixedInstanceLifecycle(res: any, target: any): boolean {
  if (!target?.fixedInstance) return false;
  res
    .status(409)
    .json({ error: 'This sandbox instance is externally managed' });
  return true;
}

/**
 * POST /api/sandbox/:stack/start
 * Start a sandbox stack. Use ?group=<project-folder> for a project's instance.
 */
router.post('/sandbox/:stack/start', async (req: any, res) => {
  const client = getSandboxClient();
  const requestedStack = req.params.stack as string;

  if (!isSafeIdentifier(requestedStack)) {
    return res.status(400).json({ error: 'Invalid stack name' });
  }
  const target = await resolveLifecycleTarget(req, res, requestedStack);
  if (target === null) return;
  if (rejectFixedInstanceLifecycle(res, target)) return;
  if (!target && !isAdminUser(req)) {
    return res
      .status(403)
      .json({ error: 'Admin required to start a stack without an instance' });
  }
  const stack = target?.stack ?? requestedStack;
  const instance = target ? lifecycleSandboxInstance(target) : undefined;

  try {
    logger.info({ stack, instance }, 'Starting sandbox via API');

    // Pre-create the host-side IPC directory BEFORE the sandbox starts.
    // If Docker creates the bind-mount target first, it will be root-owned
    // and the board process won't be able to write to it.
    if (instance) {
      const ipcDir = path.join(DATA_DIR, 'ipc', `${stack}-${instance}`);
      await prepareSandboxIpcRunsDir(ipcDir, client, stack, instance);
    }

    const env = target
      ? await (async () => {
          const baseEnv = buildSandboxEnv(target.owner, stack);

          await revokeGroupTokens(target.owner.folder);
          const perms = await getAgentPermissionsResolved(
            target.owner,
            registeredGroups,
          );
          const token = await generateAgentToken(
            {
              group_folder: target.owner.folder,
              permissions: perms,
            },
            null,
          );

          return { ...baseEnv, CARAPA_BOARD_API_TOKEN: token };
        })()
      : undefined;

    const result = await client.sandboxStart(
      stack,
      env,
      instance,
      target?.service,
    );
    if (result.isError) {
      throw new Error(result.stdout || 'CarapaBox failed to start the sandbox');
    }

    broadcast({
      type: 'sandbox_status',
      payload: { stack, instance, action: 'started', result },
    });

    await refreshBrainPortCache();

    res.json({ ok: true, stack, instance, result });
  } catch (err) {
    logger.error(
      { stack, instance, error: String(err) },
      'Failed to start sandbox',
    );
    res.status(500).json({ error: String(err) });
  }
});

/**
 * Stop and immediate restart interrupt every run on the sandbox, so human
 * callers need owner access on the project. Agent/system callers (no
 * `authUser`) are unchanged. Sends the 403 and returns true when denied.
 */
async function denyNonOwnerInterruption(
  req: any,
  res: any,
  target: Awaited<ReturnType<typeof resolveLifecycleTarget>>,
  action: 'stop' | 'restart',
): Promise<boolean> {
  if (
    !target ||
    !req.authUser ||
    (await canAccessProject(req.authUser, target.group.folder, {
      min: 'owner',
    }))
  ) {
    return false;
  }
  res.status(403).json({
    error:
      action === 'stop'
        ? 'Only the project owner can stop the sandbox'
        : 'Only the project owner can restart the sandbox immediately; use restart when idle',
  });
  return true;
}

/**
 * POST /api/sandbox/:stack/stop
 * Stop a sandbox stack. Use ?group=<project-folder> for a project's instance.
 */
router.post('/sandbox/:stack/stop', async (req: any, res) => {
  const client = getSandboxClient();
  const requestedStack = req.params.stack as string;

  if (!isSafeIdentifier(requestedStack)) {
    return res.status(400).json({ error: 'Invalid stack name' });
  }
  const target = await resolveLifecycleTarget(req, res, requestedStack);
  if (target === null) return;
  if (rejectFixedInstanceLifecycle(res, target)) return;
  if (!target && !isAdminUser(req)) {
    return res
      .status(403)
      .json({ error: 'Admin required to stop a stack without an instance' });
  }
  if (await denyNonOwnerInterruption(req, res, target, 'stop')) return;
  const stack = target?.stack ?? requestedStack;
  const instance = target ? lifecycleSandboxInstance(target) : undefined;

  try {
    logger.info({ stack, instance }, 'Stopping sandbox via API');
    await finalizeSandboxBrowsers(stack, instance);
    const result = await client.sandboxStop(stack, instance);
    if (result.isError) {
      throw new Error(result.stdout || 'CarapaBox failed to stop the sandbox');
    }
    await interruptSandboxChatRuns(instance).catch((error) =>
      logger.error(
        { stack, instance, error },
        'Failed to finalize chat runs after sandbox stop',
      ),
    );
    await interruptSandboxTaskRuns(instance, 'stop').catch((error) =>
      logger.error(
        { stack, instance, error },
        'Failed to interrupt task runs after sandbox stop',
      ),
    );

    // Terminal stop — revoke the group's no-expiry tokens so they don't
    // outlive the sandbox.
    if (target) await revokeGroupTokens(target.owner.folder);

    broadcast({
      type: 'sandbox_status',
      payload: { stack, instance, action: 'stopped', result },
    });

    await refreshBrainPortCache();

    res.json({ ok: true, stack, instance, result });
  } catch (err) {
    logger.error(
      { stack, instance, error: String(err) },
      'Failed to stop sandbox',
    );
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/sandbox/:stack/restart
 * Stop then start a sandbox stack. Use ?group=<project-folder> for a project's instance.
 */
router.post('/sandbox/:stack/restart', async (req: any, res) => {
  const requestedStack = req.params.stack as string;

  if (!isSafeIdentifier(requestedStack)) {
    return res.status(400).json({ error: 'Invalid stack name' });
  }
  const target = await resolveLifecycleTarget(req, res, requestedStack);
  if (target === null) return;
  if (rejectFixedInstanceLifecycle(res, target)) return;
  if (!target && !isAdminUser(req)) {
    return res
      .status(403)
      .json({ error: 'Admin required to restart a stack without an instance' });
  }
  const stack = target?.stack ?? requestedStack;
  const instance = target ? lifecycleSandboxInstance(target) : undefined;

  if (req.query.when === 'idle') {
    if (!target || !instance) {
      return res.status(400).json({
        error: 'Restart when idle requires a project sandbox instance',
      });
    }
    await requestIdleRestart({
      stack,
      instance,
      service: target.service,
      requestedBy: String(req.authUser?.id ?? 'unknown'),
      target,
    });
    return res
      .status(202)
      .json({ ok: true, stack, instance, status: 'restart_pending' });
  }

  // An immediate restart interrupts running work, so human callers need owner
  // access; editors use restart-when-idle. Agent tokens keep their own
  // `sandbox:restart` check (resolveLifecycleTarget).
  if (await denyNonOwnerInterruption(req, res, target, 'restart')) return;

  // Respond immediately — restart runs in the background to avoid fetch timeouts
  res.json({ ok: true, stack, instance, status: 'restarting' });

  // An immediate restart supersedes a pending one: its task hold lasts until
  // this restart ends, then its brain leases are released and work resumes.
  // The target was resolved before this waited for any maintenance holding the
  // instance (a parent change): resolve it again when it runs, and skip a
  // restart of a sandbox the project no longer owns.
  const restart = (): Promise<boolean> => {
    const folder = target?.group.folder;
    const group = folder ? getGroupByFolder(folder) : undefined;
    const current = group ? resolveEffectiveSandbox(group) : target;
    if (
      current &&
      (lifecycleSandboxInstance(current) !== instance ||
        current.stack !== stack)
    ) {
      logger.warn(
        { stack, instance, folder },
        'Skipped restart: the project no longer uses this sandbox',
      );
      return Promise.resolve(false);
    }
    return performSandboxRestart({ stack, instance, target: current });
  };
  if (instance) await supersedeIdleRestart(instance, restart);
  else await restart();
});

/** Shared auth/target resolution for the pending-restart endpoints. */
async function resolvePendingRestartInstance(
  req: any,
  res: any,
  write: boolean,
) {
  const requestedStack = req.params.stack as string;
  if (!isSafeIdentifier(requestedStack)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return undefined;
  }
  const target = await resolveLifecycleTarget(
    req,
    res,
    requestedStack,
    undefined,
    false,
    write,
  );
  if (target === null) return undefined;
  if (rejectFixedInstanceLifecycle(res, target)) return undefined;
  if (!target) {
    res.status(400).json({ error: 'Project group is required' });
    return undefined;
  }
  return { stack: target.stack, instance: lifecycleSandboxInstance(target) };
}

/**
 * GET /api/sandbox/:stack/restart-pending
 * Whether a restart-when-idle is pending and what it is still waiting on.
 */
router.get('/sandbox/:stack/restart-pending', async (req: any, res) => {
  const resolved = await resolvePendingRestartInstance(req, res, false);
  if (!resolved) return;
  const pending = getPendingIdleRestart(resolved.instance);
  if (!pending) return res.json({ pending: false });
  try {
    res.json({
      pending: true,
      requestedAt: pending.requestedAt,
      waitingOn: await getIdleRestartWaitingOn(pending),
    });
  } catch (err) {
    logger.error({ error: String(err) }, 'Failed to read pending restart');
    res.status(500).json({ error: String(err) });
  }
});

/**
 * DELETE /api/sandbox/:stack/restart-pending
 * Cancel a pending restart-when-idle and resume held task runs.
 */
router.delete('/sandbox/:stack/restart-pending', async (req: any, res) => {
  const resolved = await resolvePendingRestartInstance(req, res, true);
  if (!resolved) return;
  try {
    const cancelled = await cancelIdleRestart(resolved.instance);
    res.json({ ok: true, cancelled });
  } catch (err) {
    logger.error({ error: String(err) }, 'Failed to cancel pending restart');
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/sandbox/:stack/worktree/remove
 * Remove a single git worktree (and its nginx preview) for a group instance.
 * Body: { group: <project-folder>, branch: <worktree-slug> }
 *
 * The actual removal — including the optional .agent/worktree-teardown.sh hook —
 * is performed by CarapaBox via the sandbox_worktree tool. The board only
 * authorizes the request and forwards the identifying branch/slug.
 */
router.post('/sandbox/:stack/worktree/remove', async (req: any, res) => {
  const client = getSandboxClient();
  const requestedStack = req.params.stack as string;
  const requestedGroup = (req.body?.group ?? req.query.group) as
    | string
    | undefined;
  const branch = (req.body?.branch ?? req.query.branch) as string | undefined;

  if (!isSafeIdentifier(requestedStack) || !isSafeIdentifier(requestedGroup)) {
    return res.status(400).json({ error: 'Invalid stack or group name' });
  }
  // Branch names may legitimately contain '/' (e.g. feat/x), so they don't fit
  // isSafeIdentifier. Allow git-ref-safe characters but block traversal and
  // shell metacharacters.
  if (
    !branch ||
    branch.length > 200 ||
    branch.includes('..') ||
    branch.startsWith('/') ||
    !/^[a-zA-Z0-9._/-]+$/.test(branch)
  ) {
    return res.status(400).json({ error: 'Invalid or missing branch' });
  }
  const target = await resolveLifecycleTarget(
    req,
    res,
    requestedStack,
    undefined,
    true,
  );
  if (target === null) return;
  if (!target && !isAdminUser(req)) {
    return res.status(403).json({
      error: 'Admin required to remove a worktree without an instance',
    });
  }

  const stack = target?.stack ?? requestedStack;
  const instance = target?.instance;
  let failedRemoval: { stdout: string; isError: boolean } | undefined;
  try {
    const group = target?.group;
    logger.info({ stack, instance, branch }, 'Removing worktree via API');
    const remove = async () => {
      const result = await client.sandboxWorktree(stack, 'remove', {
        branch,
        instance,
        localRepo: group?.settings?.repositoryLocation,
        repoPath: target?.inherited === true ? target.workspaceRoot : undefined,
        service: target?.service,
        remoteUrl: target ? effectiveRemoteUrl(target) : undefined,
      });
      if (result.isError) {
        failedRemoval = result;
        throw new Error('CarapaBox could not remove the worktree');
      }
      return result;
    };
    const transition = group
      ? await transitionConversationsFromRemovedWorktree(
          group.folder,
          branch,
          remove,
        )
      : { result: await remove(), affectedConversationIds: [] };
    const { result, affectedConversationIds } = transition;

    if (group) {
      broadcast({
        type: 'conversations_changed',
        payload: { folder: group.folder },
      });
    }

    broadcast({
      type: 'sandbox_status',
      payload: {
        stack,
        instance,
        group: group?.folder,
        action: 'worktree_removed',
        branch,
        affectedConversationIds,
        result,
      },
    });

    res.json({
      ok: true,
      stack,
      instance,
      branch,
      affectedConversationIds,
      result,
    });
  } catch (err) {
    if (err instanceof ConversationWorktreeInUseError) {
      return res.status(409).json({
        error: err.message,
        conversationIds: err.conversationIds,
      });
    }
    if (failedRemoval) {
      return res.status(500).json({ error: failedRemoval.stdout });
    }
    logger.error(
      { stack, instance, branch, error: String(err) },
      'Failed to remove worktree',
    );
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/sandbox/versions
 * Returns version status for brain containers via sandbox_status (image ID comparison).
 * Cached for 30 seconds.
 */
router.get('/sandbox/versions', async (_req, res) => {
  const now = Date.now();
  if (versionsCache && now - versionsCache.ts < VERSIONS_CACHE_TTL) {
    return res.json(versionsCache.data);
  }

  const client = getSandboxClient();
  const results: Array<{
    service: string;
    upToDate: boolean;
    running: string;
    latest: string;
  }> = [];
  const seen = new Set<string>();

  // Check each group that has a brain container
  for (const group of Object.values(registeredGroups)) {
    const brainContainer = resolveBrainContainer(group);
    if (!brainContainer) continue;

    // brainContainer is the full Docker container name, e.g. "carapa-brain-carapa-agent-1"
    // which follows compose naming: {project}-{service}-{replica}
    // where project = {stack}-{instance}. Extract the stack name by stripping
    // the group folder (instance) and service suffix from the container name.
    const instance = group.folder;
    const escapedInstance = escapeRegex(instance);
    const instanceSuffix = `-${escapedInstance}-`;
    const suffixIdx = brainContainer.indexOf(instanceSuffix);
    const stack =
      group.settings?.deployService ||
      (suffixIdx !== -1
        ? brainContainer.slice(0, suffixIdx)
        : brainContainer) ||
      brainContainer;
    const key = `${stack}-${instance}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const raw = await client.callTool('sandbox_status', {
        name: stack,
        instance,
        // Without it CarapaBox skips the image comparison and omits UpToDate.
        checkUpdates: true,
      });
      logger.debug(
        { stack, instance, stdout: raw.stdout.substring(0, 200) },
        'versions: sandbox_status result',
      );
      const entries = parseStatusEntries(raw.stdout);
      for (const entry of entries) {
        const imageId = (entry.ImageID as string) || '';
        const shortId = imageId.replace('sha256:', '').substring(0, 12);
        results.push({
          service: entry.Service || stack,
          upToDate: entry.UpToDate === true,
          running: shortId || 'unknown',
          latest: entry.UpToDate === true ? shortId : 'newer image available',
        });
      }
    } catch (err) {
      logger.warn(
        { stack, instance, err: String(err) },
        'versions: sandbox_status failed',
      );
    }
  }

  versionsCache = { data: results, ts: now };
  return res.json(results);
});

/**
 * GET /api/gitnexus/repos
 * List all repositories indexed in the mounted GitNexus registry.
 */
router.get('/gitnexus/repos', async (_req, res) => {
  if (!ENABLE_GITNEXUS) {
    return res.json([]);
  }
  try {
    logger.debug(
      { path: GITNEXUS_REGISTRY_PATH },
      'Fetching GitNexus repos from registry',
    );
    if (!fs.existsSync(GITNEXUS_REGISTRY_PATH)) {
      logger.warn(
        { path: GITNEXUS_REGISTRY_PATH },
        'GitNexus registry file not found',
      );
      return res.json([]);
    }
    const content = await fsp.readFile(GITNEXUS_REGISTRY_PATH, 'utf8');
    const registry = JSON.parse(content);
    logger.debug({ count: registry.length }, 'Loaded GitNexus repos');
    res.json(registry);
  } catch (err) {
    logger.error({ err }, 'Failed to read GitNexus registry');
    res.status(500).json({ error: 'Failed to load GitNexus repositories' });
  }
});

export default router;
