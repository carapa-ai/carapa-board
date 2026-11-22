/**
 * Archive a user's personal main project (`main-<username>`).
 *
 * When a user is deleted, their main must stop being reachable under
 * `main-<username>` so that re-creating the username starts from an empty main.
 * The project is renamed to `archived-main-<username>-<timestamp>` (directory,
 * database rows, jid, in-memory state and Neo4j graph), keeps `is_main=1` and
 * loses its owner, so `isForeignMainFor` is true for every user, admins
 * included. Its schedules, cronjobs and objectives are paused. There is no
 * restore path.
 *
 * Accepted risk: a crash between the directory rename and the database commit
 * leaves the directory under the new name; the error log names both paths.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';
import { projectMoveDeps, withReparentMutex } from './reparent-project.js';
import type { PausedProjectAutomation } from '../kanban/db-kanban.js';
import type { RevokedProjectAccess } from '../knowledge/db-kb.js';

export class MainArchiveRefusedError extends Error {
  constructor(
    readonly reason: 'not_main' | 'tasks_running' | 'custom_sandbox',
    folder: string,
  ) {
    super(
      {
        not_main: `Project "${folder}" is not a personal main project`,
        tasks_running: `Cannot archive "${folder}" while tasks are running`,
        custom_sandbox:
          `Project "${folder}" uses a custom or shared sandbox instance, ` +
          'which cannot be proven private to it; remove that setting first',
      }[reason],
    );
    this.name = 'MainArchiveRefusedError';
  }
}

/** A renamed directory: `rollback` moves it back, `close` releases its parent. */
interface RenamedDir {
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface ArchiveMainDeps {
  now(): number;
  /**
   * Whether the main's sandbox is the one named after its folder
   * (`<stack>-<folder>`). A configured `defaultSandboxInstance`, a shared
   * sandbox or an inherited one may serve or be managed by something else, so
   * the archive cannot stop or move it safely and refuses instead.
   */
  usesFolderSandbox(group: RegisteredGroup): boolean;
  getEntry(folder: string): { jid: string; group: RegisteredGroup } | undefined;
  hasRunningTasks(folder: string): Promise<boolean>;
  withDescendantsIdle<T>(
    folder: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  oldDirectoryExists(folder: string): Promise<boolean>;
  /** Disables a live published app; resolves to a function that republishes it. */
  disableAppPublication(
    group: RegisteredGroup,
  ): Promise<(() => Promise<void>) | undefined>;
  stopAllProjectTasks(folder: string): Promise<number>;
  killChatAgentProcess(folder: string): Promise<unknown>;
  /**
   * Refuse new sandbox starts of the main's instance and wait for starts
   * already in flight. Resolves to the release function.
   */
  fenceRuns(group: RegisteredGroup): Promise<() => void>;
  /**
   * Stops every running sandbox of the main's instance, whatever its stack, and
   * throws unless each stop is confirmed.
   */
  stopSandbox(group: RegisteredGroup): Promise<void>;
  /**
   * Deletes the CarapaBox integration keys on the main's folder name and own
   * sandbox binding, which a re-created user of the same folder would
   * otherwise be served. Throws when Box cannot list or delete them.
   */
  deleteIntegrationKeys(group: RegisteredGroup): Promise<unknown>;
  /**
   * Move the main's persistent sandbox storage (`data/ipc/<stack>-<folder>`
   * for every stack: native agent histories, uploads, browser state) to an
   * archive identity, so a re-created main starts with empty storage. Null when
   * there is none; throws when some of it cannot be moved.
   */
  archiveIpcStorage(
    group: RegisteredGroup,
    archiveId: string,
  ): Promise<RenamedDir | null>;
  /** Revoke tokens of other projects whose permissions name `folder`. */
  revokeTokensGrantingFolder(folder: string): Promise<number>;
  revokeGroupTokens(folder: string): Promise<number>;
  /** Rename the project directory to `newName`; null when it does not exist. */
  renameDir(folder: string, newName: string): Promise<RenamedDir | null>;
  renameProjectFolder(
    oldFolder: string,
    newFolder: string,
    options: { jid: string },
  ): Promise<void>;
  rekeyGroup(oldJid: string, newJid: string, newFolder: string): void;
  migrateGroupSession(oldFolder: string, newFolder: string): void;
  rewriteRenamedProjectReferences(
    oldFolder: string,
    newFolder: string,
  ): Promise<void>;
  updateGroup(jid: string, updates: Partial<RegisteredGroup>): Promise<void>;
  /**
   * Persist an execution barrier on the archived project (status `stopped`,
   * no sandbox auto-start): startup, queue draining and stage-entry recovery
   * honor it, so a restart cannot resume its work. Resolves to an undo.
   */
  blockExecution(
    folder: string,
    originalFolder: string,
  ): Promise<() => Promise<void>>;
  /** Drops `folder` from other projects' memory sources; resolves to an undo. */
  detachMemorySources(folder: string): Promise<() => Promise<void>>;
  pauseProjectAutomation(folder: string): Promise<PausedProjectAutomation>;
  restoreProjectAutomation(paused: PausedProjectAutomation): Promise<void>;
  revokeProjectAccess(folder: string): Promise<RevokedProjectAccess>;
  restoreProjectAccess(revoked: RevokedProjectAccess): Promise<void>;
  /**
   * Retire the folder's identity: board-side memory jobs that began before now
   * (reflectors, observers) refuse further reads and writes of it, and every
   * permission map copied into a running agent (DirectLLM) stops granting it.
   * Neither may outlive the folder's identity and reach the project that
   * reuses the name.
   */
  retireFolderIdentity(folder: string): Promise<void>;
  /** Undefined when no vector store is configured. */
  renameGroupMemoryGraph?(
    oldFolder: string,
    newFolder: string,
  ): Promise<number>;
}

async function defaultDeps(): Promise<ArchiveMainDeps> {
  const [
    stateManager,
    db,
    activeRuns,
    taskExecutor,
    mcpRunner,
    appPublication,
    effectiveSettings,
    mcpClient,
    tmuxClient,
    authTokens,
    groupFs,
    groupDir,
    vectorHooks,
    projectsRoute,
    kb,
    sandboxStatus,
    lifecycleLock,
    privacyEpoch,
    folderIdentity,
    ipcFs,
    { ipcReplica },
    integrationKeys,
  ] = await Promise.all([
    import('../../state-manager.js'),
    import('../kanban/db-kanban.js'),
    import('../../db/active-runs.js'),
    import('../kanban/task-executor.js'),
    import('../../mcp/mcp-runner.js'),
    import('../../sandbox/app-publication.js'),
    import('../../sandbox/effective-settings.js'),
    import('../../lib/mcp-client.js'),
    import('../../lib/tmux-client.js'),
    import('../../mcp/auth-tokens.js'),
    import('../../lib/group-fs.js'),
    import('../../group-dir.js'),
    import('../vector-store/hooks.js'),
    import('../../routes/projects.js'),
    import('../knowledge/db-kb.js'),
    import('../../sandbox/status.js'),
    import('../memory/lifecycle-lock.js'),
    import('../memory/privacy-epoch.js'),
    import('../../lib/folder-identity.js'),
    import('../../lib/ipc-fs.js'),
    import('../../sandbox/ipc-replica.js'),
    import('./integration-keys.js'),
  ]);
  return {
    now: () => Date.now(),
    usesFolderSandbox: (group) => {
      const effective = effectiveSettings.resolveEffectiveSandbox(group);
      return (
        effective.instance === group.folder &&
        !effective.inherited &&
        effective.owner.settings?.sandboxOwnership !== 'shared'
      );
    },
    getEntry: stateManager.getGroupEntryByFolder,
    hasRunningTasks: async (folder) => {
      const projectTaskIds = (await db.getTasksByProject(folder)).map(
        (t) => t.id,
      );
      const running = new Set([
        ...taskExecutor.getRunningTaskIds(),
        ...(await activeRuns.getRunningTaskIds()),
      ]);
      return projectTaskIds.some((id) => running.has(id));
    },
    withDescendantsIdle: async (folder, operation) => {
      const move = await projectMoveDeps();
      const descendants: string[] = [];
      const seen = new Set([folder]);
      const visit = (parent: string) => {
        for (const child of move.childFolders(parent)) {
          if (seen.has(child)) continue;
          seen.add(child);
          descendants.push(child);
          visit(child);
        }
      };
      visit(folder);
      const instances = [
        ...new Set(
          descendants.map((child) => {
            const group = stateManager.getGroupByFolder(child);
            return group
              ? effectiveSettings.resolveEffectiveSandbox(group).instance
              : child;
          }),
        ),
      ];
      return move.holdRuns(instances, async () => {
        const activity = await move.findActiveRun(descendants, instances);
        if (activity)
          throw new MainArchiveRefusedError('tasks_running', folder);
        return operation();
      });
    },
    oldDirectoryExists: async (folder) => {
      const parent = await groupFs.openParentDir(groupDir.groupDirFor(folder));
      if (!parent) return false;
      try {
        return !!(await groupFs.lstatAt(parent.dir, parent.name));
      } finally {
        await parent.dir.close();
      }
    },
    disableAppPublication: async (group) => {
      const previous = group.settings?.appPublication;
      if (!previous) return undefined;
      await appPublication.setAppPublication(group, { enabled: false });
      if (!previous.enabled) return undefined;
      return async () => {
        await appPublication.setAppPublication(
          stateManager.getGroupByFolder(group.folder) ?? group,
          {
            enabled: true,
            targetPort: previous.targetPort,
            hostname: previous.hostname,
          },
        );
      };
    },
    stopAllProjectTasks: taskExecutor.stopAllProjectTasks,
    killChatAgentProcess: mcpRunner.killChatAgentProcess,
    fenceRuns: async (group) => fenceGroupRuns(group, effectiveSettings),
    deleteIntegrationKeys: (group) =>
      integrationKeys.deleteProjectKeys(
        group.folder,
        integrationKeys.ownSandboxBinding(group),
      ),
    stopSandbox: async (group) => {
      const client = mcpClient.getSandboxClient();
      // The containers hold bind mounts of the directories about to be renamed
      // and would serve them to a re-created user of the same instance. The
      // main may have run under several stacks: sandbox_ps names the ones that
      // are up for this instance.
      const targets = new Map<string, { stack: string; instance: string }>();
      const configured = effectiveSettings.projectDeletionSandboxTarget(group);
      if (configured) {
        targets.set(`${configured.stack}\0${configured.instance}`, configured);
      }
      const ps = await client.sandboxPs(group.folder);
      if (ps.isError) {
        throw new Error(
          `Could not list running sandboxes of ${group.folder}: ${ps.stdout}`,
        );
      }
      for (const stack of sandboxStatus.runningStackNamesForInstance(
        ps.stdout,
        group.folder,
      )) {
        targets.set(`${stack}\0${group.folder}`, {
          stack,
          instance: group.folder,
        });
      }
      for (const target of targets.values()) {
        try {
          const stopped = await client.sandboxStop(
            target.stack,
            target.instance,
          );
          if (stopped.isError)
            logger.warn(
              { ...target, output: stopped.stdout },
              'sandbox_stop failed',
            );
        } catch (err) {
          logger.warn({ ...target, err }, 'sandbox_stop threw');
        }
        // Only a status that shows it stopped lets the archive continue.
        const status = await client.sandboxStatus(
          target.stack,
          target.instance,
        );
        if (!sandboxStatus.isSandboxStopped(status)) {
          throw new Error(
            `Could not confirm that sandbox ${target.stack}/${target.instance} stopped`,
          );
        }
        try {
          await tmuxClient.getTmuxClient().forgetByInstance(target.instance);
        } catch (err) {
          logger.warn({ ...target, err }, 'Failed to forget tmux sessions');
        }
      }
    },
    archiveIpcStorage: async (group, archiveId) => {
      const folder = group.folder;
      // No IPC root yet means no sandbox ever started: nothing to retire.
      const root = await groupFs.openTrustedDir(ipcFs.ipcRoot());
      if (!root) return null;
      // `data/ipc/<stack>-<instance>`: every stack the main ever ran under
      // left a directory ending in its folder. A longer registered folder
      // that the name also ends with (`main-bob-main-alice`) owns it instead.
      const longerFolders = Object.values(stateManager.registeredGroups)
        .map((g) => g.folder)
        .filter((f) => f.length > folder.length && f.endsWith(`-${folder}`));
      const moves: Array<{ from: string; to: string }> = [];
      const rollback = async () => {
        for (const { from, to } of moves.splice(0).reverse())
          await groupFs.renameAt(root, to, root, from);
      };
      try {
        const names = ((await groupFs.readdirAt(root)) ?? []).filter(
          (name) =>
            name.length > folder.length + 1 &&
            name.endsWith(`-${folder}`) &&
            !longerFolders.some((f) => name.endsWith(`-${f}`)),
        );
        // Renaming Board's directory retires the storage only where that
        // directory is the box's own tree. A box that keeps a separate tree
        // would be left with the real histories under the old name.
        for (const name of names) {
          if (!(await ipcReplica.confirmSharedTree(name))) {
            throw new Error(
              `Sandbox storage ${name} is not confirmed to be shared with its box, so it cannot be archived from here`,
            );
          }
        }
        for (const from of names) {
          if (!(await groupFs.lstatAt(root, from))) continue;
          const to = `${from.slice(0, -folder.length)}${archiveId}`;
          await groupFs.renameAt(root, from, root, to);
          moves.push({ from, to });
        }
      } catch (err) {
        await rollback().catch((rollbackErr) =>
          logger.error({ folder, err: rollbackErr }, 'IPC rollback failed'),
        );
        await root.close();
        throw err;
      }
      if (moves.length === 0) {
        await root.close();
        return null;
      }
      return { rollback, close: () => root.close() };
    },
    revokeTokensGrantingFolder: authTokens.revokeTokensGrantingFolder,
    revokeGroupTokens: authTokens.revokeGroupTokens,
    renameDir: async (folder, newName) => {
      // The group folders are agent-writable: rename through the pinned parent
      // so no path is resolved again after it is opened.
      const parent = await groupFs.openParentDir(groupDir.getGroupDir(folder));
      if (!parent) return null;
      try {
        if (!(await groupFs.lstatAt(parent.dir, parent.name))) {
          await parent.dir.close();
          return null;
        }
        await groupFs.renameAt(parent.dir, parent.name, parent.dir, newName);
      } catch (err) {
        await parent.dir.close();
        throw err;
      }
      return {
        rollback: () =>
          groupFs.renameAt(parent.dir, newName, parent.dir, parent.name),
        close: () => parent.dir.close(),
      };
    },
    renameProjectFolder: db.renameProjectFolder,
    rekeyGroup: stateManager.rekeyGroup,
    migrateGroupSession: stateManager.migrateGroupSession,
    rewriteRenamedProjectReferences:
      projectsRoute.rewriteRenamedProjectReferences,
    updateGroup: stateManager.updateGroup,
    detachMemorySources: async (folder) => {
      const referrers = Object.entries(stateManager.registeredGroups)
        .filter(([, g]) => g.settings?.memorySourceProjects?.includes(folder))
        .map(([jid, g]) => ({
          jid,
          sources: [...(g.settings?.memorySourceProjects ?? [])],
        }));
      await projectsRoute.removeDeletedMemorySourceReferences(folder);
      return async () => {
        for (const { jid, sources } of referrers) {
          const current = stateManager.registeredGroups[jid];
          if (!current) continue;
          await stateManager.updateGroup(jid, {
            settings: { ...current.settings, memorySourceProjects: sources },
          });
        }
      };
    },
    blockExecution: async (folder, originalFolder) => {
      const apply = async (values: Record<string, unknown>) => {
        const previous = await db.patchProjectSettings(folder, values);
        const entry = stateManager.getGroupEntryByFolder(folder);
        if (entry) {
          const settings: Record<string, unknown> = {
            ...entry.group.settings,
            ...values,
          };
          for (const [key, value] of Object.entries(values))
            if (value === undefined) delete settings[key];
          stateManager.applyGroupUpdateInMemory(entry.jid, {
            settings: settings as RegisteredGroup['settings'],
          });
        }
        return previous;
      };
      // An archived main must not keep claiming its old folder name as its
      // sandbox name: that would block creating the username again.
      const claimed = stateManager
        .getGroupEntryByFolder(folder)
        ?.group.settings?.defaultSandboxInstance?.trim()
        .toLowerCase();
      const previous = await apply({
        status: 'stopped',
        autoStartStack: false,
        ...(claimed && claimed === originalFolder.trim().toLowerCase()
          ? { defaultSandboxInstance: undefined }
          : {}),
      });
      return async () => void (await apply(previous));
    },
    pauseProjectAutomation: db.pauseProjectAutomation,
    restoreProjectAutomation: db.restoreProjectAutomation,
    retireFolderIdentity: (folder) =>
      lifecycleLock.withMemoryLifecycleLock(folder, async () => {
        privacyEpoch.markPrivacyErasureStarted(folder);
        folderIdentity.retireFolderIdentity(folder);
      }),
    revokeProjectAccess: kb.revokeProjectAccess,
    restoreProjectAccess: kb.restoreProjectAccess,
    renameGroupMemoryGraph: vectorHooks
      .getVectorStoreHooks()
      ?.renameGroupMemoryGraph?.bind(vectorHooks.getVectorStoreHooks()),
  };
}

/**
 * Archive the main project at `folder`. Resolves to the archive id, or null
 * when no such project is registered. Throws `MainArchiveRefusedError` when the
 * project is not a main or has running tasks; any other failure rolls every
 * completed step back before it is rethrown.
 */
export async function archivePersonalMain(
  folder: string,
  overrides: Partial<ArchiveMainDeps> = {},
): Promise<string | null> {
  const deps: ArchiveMainDeps = { ...(await defaultDeps()), ...overrides };
  // One archive of a main at a time: a second request must see the first one's
  // result, not race its directory and row moves. The project is looked up
  // only once the lock is held.
  // Renaming the directory and the row re-parents the main's children: it
  // must not interleave with a parent change.
  return withMainLock(folder, () =>
    withReparentMutex(async () => {
      const entry = deps.getEntry(folder);
      if (!entry) return null;
      const { jid: oldJid, group } = entry;
      if (!group.is_main) throw new MainArchiveRefusedError('not_main', folder);
      if (!deps.usesFolderSandbox(group)) {
        throw new MainArchiveRefusedError('custom_sandbox', folder);
      }
      // No sandbox of this instance may start from here on: the user's
      // credentials stay valid until the user is deleted, so a message accepted
      // meanwhile would otherwise revive the old instance.
      const releaseRuns = await deps.fenceRuns(group);
      try {
        return await deps.withDescendantsIdle(folder, () =>
          archiveFenced(deps, folder, oldJid, group),
        );
      } finally {
        releaseRuns();
      }
    }),
  );
}

const mainLockTails = new Map<string, Promise<void>>();
const mainLocksHeld = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Serialize work on one personal main (archive, and the user deletion that
 * follows it). Re-entrant within the same async flow.
 */
export async function withMainLock<T>(
  folder: string,
  operation: () => Promise<T>,
): Promise<T> {
  const held = mainLocksHeld.getStore();
  if (held?.has(folder)) return operation();
  const previous = mainLockTails.get(folder) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  mainLockTails.set(folder, tail);
  await previous;
  try {
    return await mainLocksHeld.run(
      new Set([...(held ?? []), folder]),
      operation,
    );
  } finally {
    release();
    if (mainLockTails.get(folder) === tail) mainLockTails.delete(folder);
  }
}

async function archiveFenced(
  deps: ArchiveMainDeps,
  folder: string,
  oldJid: string,
  group: RegisteredGroup,
): Promise<string> {
  if (await deps.hasRunningTasks(folder)) {
    throw new MainArchiveRefusedError('tasks_running', folder);
  }

  const username = folder.replace(/^main-/, '');
  const id = `archived-main-${username}-${deps.now()}`;
  const ownerId = group.user_id;
  // Undo steps run last to first. The reference, owner and publication steps
  // are `unshift`ed so they run after the row, jid and directory moves are
  // undone: they address the project by its original folder and jid.
  const undo: Array<() => Promise<void>> = [];
  const moved: RenamedDir[] = [];
  const ensureOldDirectoryAbsent = async () => {
    if (await deps.oldDirectoryExists(folder)) {
      throw new Error(
        `Archive failed: the old directory for "${folder}" was recreated; manual cleanup is required`,
      );
    }
  };
  try {
    // First, so a Box failure aborts the archive before app publication is
    // disabled, a token revoked or the sandbox stopped.
    await deps.deleteIntegrationKeys(group);

    // Quiesce, as DELETE /projects/:pid does, before anything is moved.
    const republish = await deps.disableAppPublication(group);
    if (republish) undo.unshift(republish);
    await deps.stopAllProjectTasks(folder);
    try {
      await deps.killChatAgentProcess(folder);
    } catch (err) {
      logger.warn({ folder, err }, 'Failed to kill chat agent (non-fatal)');
    }
    await deps.revokeGroupTokens(folder);

    // Projects that recall this main keep a token minted with that reach, so
    // drop the references and then every token that still names the folder.
    undo.push(await deps.detachMemorySources(folder));
    await deps.revokeTokensGrantingFolder(folder);

    // Last step before the moves, so nothing restarts the sandbox in between.
    await deps.stopSandbox(group);
    for (const archive of [
      () => deps.archiveIpcStorage(group, id),
      () => deps.renameDir(folder, id),
    ]) {
      const move = await archive();
      if (!move) continue;
      moved.push(move);
      undo.push(() => move.rollback());
    }

    await deps.renameProjectFolder(folder, id, { jid: id });
    undo.push(() => deps.renameProjectFolder(id, folder, { jid: oldJid }));

    deps.rekeyGroup(oldJid, id, id);
    undo.push(async () => deps.rekeyGroup(id, oldJid, folder));

    deps.migrateGroupSession(folder, id);
    undo.push(async () => deps.migrateGroupSession(id, folder));

    await deps.rewriteRenamedProjectReferences(folder, id);
    undo.unshift(() => deps.rewriteRenamedProjectReferences(id, folder));

    await deps.updateGroup(id, { user_id: undefined });
    undo.unshift(() => deps.updateGroup(oldJid, { user_id: ownerId }));

    undo.push(await deps.blockExecution(id, folder));

    const paused = await deps.pauseProjectAutomation(id);
    undo.push(() => deps.restoreProjectAutomation(paused));

    // Nobody keeps a way into the archive: memberships and share links go.
    const revoked = await deps.revokeProjectAccess(id);
    undo.push(() => deps.restoreProjectAccess(revoked));

    await deps.renameGroupMemoryGraph?.(folder, id);

    await ensureOldDirectoryAbsent();

    // Last, so the identity moves only for an archive that stays: a job or
    // run begun earlier must not reach the project that takes the folder next.
    await deps.retireFolderIdentity(folder);
    await ensureOldDirectoryAbsent();
  } catch (err) {
    logger.error(
      { folder, archiveId: id, err },
      'Archiving personal main failed; rolling back',
    );
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (rollbackErr) {
        logger.error(
          { folder, archiveId: id, err: rollbackErr },
          'Archive rollback step failed; fix by hand',
        );
      }
    }
    throw err;
  } finally {
    await Promise.all(moved.map((move) => move.close()));
  }
  logger.info({ folder, archiveId: id }, 'Archived personal main project');
  return id;
}

/** Fence the sandbox instances of `group` (see `ArchiveMainDeps.fenceRuns`). */
async function fenceGroupRuns(
  group: RegisteredGroup,
  effectiveSettings: typeof import('../../sandbox/effective-settings.js'),
): Promise<() => void> {
  const fence = await import('../../lib/sandbox-start-fence.js');
  const instances = [
    group.folder,
    effectiveSettings.projectDeletionSandboxTarget(group)?.instance ?? '',
  ].filter(Boolean);
  const release = fence.fenceSandboxInstances(instances);
  try {
    await fence.settleSandboxStarts(instances);
  } catch (err) {
    release();
    throw err;
  }
  return release;
}

/**
 * Run `operation` with the main's sandbox starts fenced, so a caller can hold
 * the barrier across the archive and whatever must follow it (deleting the
 * user) and lift it only afterwards.
 */
export async function withMainRunsFenced<T>(
  folder: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withMainLock(folder, async () => {
    const [{ getGroupByFolder }, effectiveSettings, fence] = await Promise.all([
      import('../../state-manager.js'),
      import('../../sandbox/effective-settings.js'),
      import('../../lib/sandbox-start-fence.js'),
    ]);
    const group = getGroupByFolder(folder);
    const release = group
      ? await fenceGroupRuns(group, effectiveSettings)
      : fence.fenceSandboxInstances([folder]);
    try {
      return await operation();
    } finally {
      release();
    }
  });
}
