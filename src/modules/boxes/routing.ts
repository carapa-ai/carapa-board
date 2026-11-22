/**
 * Route sandbox tool calls to the CarapaBox host that runs each project.
 *
 * Every sandbox tool call names its instance (`instance`) or IPC project
 * (`project` = `<stack>-<instance>`). The effective sandbox owner's
 * `settings.boxId` selects the box; absent means the local box, which is
 * reached over WebSocket when it connected as `local`, else over HTTP at
 * CARAPA_BOX_URL. A call for an offline remote box fails instead of silently
 * running somewhere else.
 */
import {
  forwardSandboxLog,
  getSandboxClient,
  setSandboxCallRouter,
  setSandboxReachability,
  type SandboxExecResult,
} from '../../lib/mcp-client.js';
import { setBoxFetchResolver, type BoxFetchArgs } from '../../lib/box-fetch.js';
import { logger } from '../../logger.js';
import { resolveEffectiveSandbox } from '../../sandbox/effective-settings.js';
import { replayPendingDisabledSkills } from '../../sandbox/disabled-skills.js';
import { groupReplica, ipcReplica } from '../../sandbox/ipc-replica.js';
import { registeredGroups } from '../../state-manager.js';
import {
  callBoxTool,
  connectedBoxIds,
  getBoxConnection,
  onBoxConnectionChange,
  setBoxLogSink,
} from './connections.js';
import { LOCAL_BOX_ID } from './registry.js';

interface PlacementIndex {
  byProject: Map<string, string>;
  byInstance: Map<string, string>;
  byFolder: Map<string, string>;
  builtAt: number;
}

const INDEX_TTL_MS = 2000;
let index: PlacementIndex | null = null;

function buildIndex(): PlacementIndex {
  const byProject = new Map<string, string>();
  const byInstance = new Map<string, string>();
  const byFolder = new Map<string, string>();
  const childFolders: Array<[string, string]> = [];
  for (const group of Object.values(registeredGroups)) {
    try {
      const effective = resolveEffectiveSandbox(group);
      const boxId = effective.owner.settings?.boxId || LOCAL_BOX_ID;
      byProject.set(`${effective.stack}-${effective.instance}`, boxId);
      byInstance.set(effective.instance, boxId);
      byFolder.set(group.folder, boxId);
      // Legacy callers may still pass a child folder as the instance.
      childFolders.push([group.folder, boxId]);
    } catch {
      /* unresolvable group: no placement */
    }
  }
  for (const [folder, boxId] of childFolders) {
    if (!byInstance.has(folder)) byInstance.set(folder, boxId);
  }
  return { byProject, byInstance, byFolder, builtAt: Date.now() };
}

function placement(): PlacementIndex {
  if (!index || Date.now() - index.builtAt > INDEX_TTL_MS) index = buildIndex();
  return index;
}

/** Box that owns the sandbox addressed by these tool arguments. */
function boxIdForArgs(args: Record<string, unknown>): string {
  const current = placement();
  if (args.tree === 'group' && typeof args.project === 'string') {
    return current.byFolder.get(args.project) ?? LOCAL_BOX_ID;
  }
  if (typeof args.project === 'string') {
    return current.byProject.get(args.project) ?? LOCAL_BOX_ID;
  }
  if (typeof args.instance === 'string' && args.instance) {
    return current.byInstance.get(args.instance) ?? LOCAL_BOX_ID;
  }
  return LOCAL_BOX_ID;
}

export function routeSandboxCall(
  _name: string,
  args: Record<string, unknown>,
): string | null {
  const boxId = boxIdForArgs(args);
  if (boxId === LOCAL_BOX_ID) {
    return getBoxConnection(LOCAL_BOX_ID) ? LOCAL_BOX_ID : null;
  }
  return boxId;
}

/** False when the arguments address a remote box that is not connected. */
export function isBoxReachable(args: Record<string, unknown>): boolean {
  const boxId = boxIdForArgs(args);
  return boxId === LOCAL_BOX_ID || Boolean(getBoxConnection(boxId));
}

/**
 * True when the sandbox instance runs on a connected native runner. The runner
 * owns its agents' relay addresses (they carry a per-project secret Board does
 * not know) and registers Board's MCP server itself.
 */
export function isNativeBoxInstance(instance: string): boolean {
  return getBoxConnection(boxIdForArgs({ instance }))?.kind === 'native';
}

/** Placement or box connectivity changed: rebuild routing, re-detect sharing. */
export function onPlacementChanged(): void {
  index = null;
  ipcReplica.resetStatus();
  groupReplica.resetStatus();
}

/** True when a project's group directory lives on a remote box. */
export function isRemotePlacedFolder(folder: string): boolean {
  return boxIdForArgs({ tree: 'group', project: folder }) !== LOCAL_BOX_ID;
}

/**
 * fetch for the browser viewer and tmux endpoints of the box running a
 * sandbox. The box is resolved per request, so follow-up calls survive a
 * reconnect of the same box.
 */
function boxFetch(args: BoxFetchArgs): typeof fetch {
  const boxId = boxIdForArgs({ ...args });
  if (boxId === LOCAL_BOX_ID) return globalThis.fetch.bind(globalThis);
  return ((input: string | URL | Request, init?: RequestInit) => {
    const connection = getBoxConnection(boxId);
    if (!connection)
      return Promise.reject(new Error(`CarapaBox "${boxId}" is offline`));
    if (!connection.httpTunnel)
      return Promise.reject(
        new Error(
          connection.kind === 'native'
            ? `CarapaBox "${boxId}" is a native runner without browser viewer or shell support`
            : `CarapaBox "${boxId}" cannot stream the browser viewer or shell; update it`,
        ),
      );
    return connection.httpTunnel.fetch(input, init);
  }) as typeof fetch;
}

/** Install routing, log forwarding and the replica's multi-box project lister. */
export function installBoxRouting(): void {
  setBoxFetchResolver(boxFetch);
  // Group directories replicate only for projects placed on remote boxes;
  // the local box shares GROUPS_DIR with Board.
  groupReplica.setEnabled(isRemotePlacedFolder);
  ipcReplica.setLocalCheck(
    (project) => boxIdForArgs({ project }) === LOCAL_BOX_ID,
  );
  groupReplica.setLocalCheck(
    (folder) =>
      boxIdForArgs({ tree: 'group', project: folder }) === LOCAL_BOX_ID,
  );
  groupReplica.setProjectLister(async () =>
    [...placement().byFolder.entries()]
      .filter(([, boxId]) => boxId !== LOCAL_BOX_ID && getBoxConnection(boxId))
      .map(([folder]) => folder),
  );
  setSandboxCallRouter(
    routeSandboxCall,
    (boxId, name, args, options) => callBoxTool(boxId, name, args, options),
    () => connectedBoxIds().filter((id) => id !== LOCAL_BOX_ID),
  );
  setBoxLogSink(forwardSandboxLog);
  setSandboxReachability(isBoxReachable);

  ipcReplica.setProjectLister(async () => {
    const projects = new Set<string>();
    const listOn = async (boxId: string | null) => {
      const raw = boxId
        ? await callBoxTool(boxId, 'sandbox_ipc_projects', {})
        : null;
      const result: SandboxExecResult = raw
        ? toResult(raw)
        : await getSandboxClient().callToolDirect('sandbox_ipc_projects', {});
      if (result.isError) throw new Error(result.stdout);
      const listed = (JSON.parse(result.stdout) as { projects: string[] })
        .projects;
      const own = boxId ?? LOCAL_BOX_ID;
      // Only replicate a project from the box it is placed on.
      for (const project of listed) {
        if (boxIdForArgs({ project }) === own) projects.add(project);
      }
    };
    await listOn(getBoxConnection(LOCAL_BOX_ID) ? LOCAL_BOX_ID : null).catch(
      (err) =>
        logger.warn(
          { err, boxId: LOCAL_BOX_ID },
          '[boxes] Could not list IPC projects',
        ),
    );
    for (const boxId of connectedBoxIds()) {
      if (boxId === LOCAL_BOX_ID) continue;
      await listOn(boxId).catch((err) =>
        logger.warn({ err, boxId }, '[boxes] Could not list IPC projects'),
      );
    }
    return [...projects];
  });

  // A box that (re)connects gets its projects replicated right away.
  onBoxConnectionChange(({ boxId, online }) => {
    onPlacementChanged();
    if (online) {
      void ipcReplica
        .syncAll()
        .then(() => groupReplica.syncAll())
        .then(() => replayPendingDisabledSkills())
        .catch((err) =>
          logger.warn({ err, boxId }, '[boxes] Post-connect sync failed'),
        );
    }
  });
}

function toResult(raw: unknown): SandboxExecResult {
  const result = raw as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const stdout = (result.content ?? [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text ?? '')
    .join('');
  return { stdout, isError: result.isError === true };
}
