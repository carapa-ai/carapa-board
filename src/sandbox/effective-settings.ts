import path from 'path';
import { DEFAULT_SANDBOX_SERVICE, DEFAULT_SANDBOX_STACK } from '../config.js';
import { sandboxInstanceName } from '../concurrency/semaphore.js';
import { getGroupByFolder, registeredGroups } from '../state-manager.js';
import { isPathInside } from '../lib/path-containment.js';
import { shellQuote } from '../utils.js';
import type {
  EffectiveSandboxSettings,
  ExtraMountSettings,
  ProjectSettings,
  RegisteredGroup,
} from '../types.js';

export const WORKSPACE_BASE = '/workspace';
export const PARENT_OWNED_SANDBOX_KEYS = [
  'sshEnabled',
  'defaultSandbox',
  'defaultSandboxService',
  'defaultSandboxInstance',
  'autoStartStack',
  'sandboxOwnership',
  'sharedWorkspaceHostLocation',
  'sharedWorkspaceContainerRoot',
  'webRootPath',
  'proxyHostnameAliases',
  'workspaceRoots',
  'extraMounts',
] as const satisfies readonly (keyof ProjectSettings)[];

export function validateInheritedSandboxUpdate(
  parent: RegisteredGroup | undefined,
  settings: Record<string, unknown> | undefined,
): string | undefined {
  if (
    !settings ||
    parent?.settings?.isParent !== true ||
    parent.settings.sandboxOwnership !== 'shared'
  )
    return;
  const attempted = PARENT_OWNED_SANDBOX_KEYS.find((key) => key in settings);
  if (attempted)
    return `${attempted} is owned by parent project "${parent.folder}" and cannot be overridden by a child project`;
  const workspacePath = settings.workspacePath;
  if (typeof workspacePath === 'string' && workspacePath.trim()) {
    const root = containerRoot(parent);
    const normalized = path.posix.isAbsolute(workspacePath)
      ? path.posix.normalize(workspacePath)
      : path.posix.resolve(root, workspacePath);
    if (!isPathInside(root, normalized)) {
      return `workspacePath must stay within the parent container workspace root "${root}"`;
    }
  }
  return;
}

type GroupLookup = (folder: string) => RegisteredGroup | undefined;

export function sharedSandboxOwner(
  group: RegisteredGroup,
  lookup: GroupLookup = getGroupByFolder,
): RegisteredGroup {
  // Explicit ownership wins over parent linkage. The API rejects this nested
  // combination, but preferring self keeps malformed records from
  // mixing one owner's stack coordinates with another owner's workspace env.
  if (
    group.settings?.isParent === true &&
    group.settings.sandboxOwnership === 'shared'
  ) {
    return group;
  }
  if (!group.parentId) return group;
  const parent = lookup(group.parentId);
  return parent?.settings?.isParent === true &&
    parent.settings.sandboxOwnership === 'shared'
    ? parent
    : group;
}

function normalizeWorkspaceRoot(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

function containerRoot(owner: RegisteredGroup): string {
  const configured = owner.settings?.sharedWorkspaceContainerRoot?.trim();
  return configured && path.posix.isAbsolute(configured)
    ? normalizeWorkspaceRoot(configured)
    : WORKSPACE_BASE;
}

export function computeEffectiveWorkspaceRoot(
  group: RegisteredGroup,
  lookup: GroupLookup = getGroupByFolder,
): string {
  const owner = sharedSandboxOwner(group, lookup);
  if (owner !== group) {
    const configured = group.settings?.workspacePath?.trim();
    const root = containerRoot(owner);
    if (configured) {
      const normalized = path.posix.isAbsolute(configured)
        ? normalizeWorkspaceRoot(configured)
        : path.posix.resolve(root, configured);
      if (normalized === root || normalized.startsWith(`${root}/`)) {
        return normalized;
      }
    }
    return path.posix.join(root, group.folder);
  }
  if (owner.settings?.sandboxOwnership === 'shared') {
    return containerRoot(owner);
  }
  const configured = group.settings?.workspacePath?.trim();
  if (configured && path.posix.isAbsolute(configured)) {
    return normalizeWorkspaceRoot(configured);
  }
  return normalizeWorkspaceRoot(
    path.posix.join(WORKSPACE_BASE, configured || group.folder),
  );
}

function normalizedRoots(primary: string, roots?: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of roots ?? []) {
    if (typeof value !== 'string' || !path.posix.isAbsolute(value.trim()))
      continue;
    const root = normalizeWorkspaceRoot(value.trim());
    if (
      root === '/' ||
      root === primary ||
      root.startsWith(`${primary}/`) ||
      seen.has(root)
    )
      continue;
    seen.add(root);
    result.push(root);
  }
  return result;
}

/**
 * Extra read-only host folders, mounted at /workspace/<name>. The name is the
 * source folder's leaf, suffixed with its slot number when it would collide
 * with the primary workspace, the fixed IPC/group mounts, a shared child
 * workspace, or an earlier slot. Children are enumerated from registeredGroups;
 * the injected lookup resolves ownership but does not replace that registry.
 */
function resolveExtraMounts(
  owner: RegisteredGroup,
  primaryWorkspace: string,
  lookup: GroupLookup,
): ExtraMountSettings[] {
  const taken = new Set([
    primaryWorkspace,
    '/workspace/ipc',
    '/workspace/group',
  ]);
  const shared =
    owner.settings?.isParent === true &&
    owner.settings.sandboxOwnership === 'shared';
  if (shared) {
    const ownerLookup: GroupLookup = (folder) =>
      folder === owner.folder ? owner : lookup(folder);
    for (const child of Object.values(registeredGroups)) {
      if (
        child.parentId === owner.folder &&
        sharedSandboxOwner(child, ownerLookup) === owner
      ) {
        taken.add(computeEffectiveWorkspaceRoot(child, ownerLookup));
      }
    }
  }
  const mounts: ExtraMountSettings[] = [];
  (owner.settings?.extraMounts ?? []).slice(0, 2).forEach((hostPath, i) => {
    if (!hostPath) return;
    const slot = (i + 1) as 1 | 2;
    const leaf =
      path
        .basename(hostPath)
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/^[^A-Za-z0-9]+/, '') || 'extra';
    let name = taken.has(`${WORKSPACE_BASE}/${leaf}`)
      ? `${leaf}-${slot}`
      : leaf;
    if (shared) {
      let suffix = 2;
      const base = name;
      while (taken.has(`${WORKSPACE_BASE}/${name}`))
        name = `${base}-${suffix++}`;
    }
    const containerPath = `${WORKSPACE_BASE}/${name}`;
    taken.add(containerPath);
    mounts.push({ slot, hostPath, name, containerPath });
  });
  return mounts;
}

export function resolveEffectiveSandbox(
  groupOrFolder: RegisteredGroup | string,
  lookup: GroupLookup = getGroupByFolder,
): EffectiveSandboxSettings & {
  group: RegisteredGroup;
  owner: RegisteredGroup;
  fixedInstance: boolean;
  extraRoots: string[];
} {
  const group =
    typeof groupOrFolder === 'string' ? lookup(groupOrFolder) : groupOrFolder;
  if (!group) throw new Error(`Group not found: ${groupOrFolder}`);
  const owner = sharedSandboxOwner(group, lookup);
  const inherited = owner !== group;
  const sharedManaged = owner.settings?.sandboxOwnership === 'shared';
  const rawInstance = owner.settings?.defaultSandboxInstance;
  const configuredInstance =
    rawInstance && /^[a-z0-9][a-z0-9_-]*$/.test(rawInstance)
      ? rawInstance
      : undefined;
  const fixedInstance = !!configuredInstance && !sharedManaged;
  const instance = configuredInstance || sandboxInstanceName(owner.folder, 0);
  const workspaceRoot = computeEffectiveWorkspaceRoot(group, lookup);
  const extraRoots = normalizedRoots(
    workspaceRoot,
    owner.settings?.workspaceRoots,
  );
  const root = sharedManaged ? containerRoot(owner) : workspaceRoot;
  return {
    group,
    owner,
    ownerProjectId: owner.folder,
    inherited,
    managed: !fixedInstance,
    fixedInstance,
    stack: owner.settings?.defaultSandbox || DEFAULT_SANDBOX_STACK,
    instance,
    service: owner.settings?.defaultSandboxService || DEFAULT_SANDBOX_SERVICE,
    autoStart: owner.settings?.autoStartStack !== false,
    hostWorkspaceLocation: sharedManaged
      ? owner.settings?.sharedWorkspaceHostLocation
      : owner.settings?.repositoryLocation,
    containerWorkspaceRoot: root,
    webRootPath: owner.settings?.webRootPath?.trim() || 'public',
    proxyHostnameAliases: owner.settings?.proxyHostnameAliases ?? [],
    workspaceRoot,
    extraRoots,
    workspaceRoots: [workspaceRoot, ...extraRoots],
    extraMounts: resolveExtraMounts(owner, root, lookup),
    ...(owner.settings?.boxId ? { boxId: owner.settings.boxId } : {}),
  };
}

/** Host-side IPC directory mounted into a project's effective sandbox. */
export function effectiveSandboxIpcDir(
  group: RegisteredGroup,
  dataDir: string,
  lookup: GroupLookup = getGroupByFolder,
): string {
  const effective = resolveEffectiveSandbox(group, lookup);
  return path.join(dataDir, 'ipc', `${effective.stack}-${effective.instance}`);
}

/**
 * Project-scoped upload directory inside an effective sandbox's IPC mount.
 * Shared sandboxes add the requesting project folder as a namespace so a
 * filename cannot be retrieved through a sibling project's authorized URL.
 * Standalone projects retain their existing flat uploads directory.
 */
export function effectiveProjectUploadDir(
  group: RegisteredGroup,
  dataDir: string,
  lookup: GroupLookup = getGroupByFolder,
): string {
  const effective = resolveEffectiveSandbox(group, lookup);
  const base = path.join(
    dataDir,
    'ipc',
    `${effective.stack}-${effective.instance}`,
    'uploads',
  );
  return effective.owner.settings?.sandboxOwnership === 'shared'
    ? path.join(base, group.folder)
    : base;
}

/** Upload directory as mounted inside the effective agent container. */
export function effectiveContainerUploadDir(
  group: RegisteredGroup,
  lookup: GroupLookup = getGroupByFolder,
): string {
  const effective = resolveEffectiveSandbox(group, lookup);
  return effective.owner.settings?.sandboxOwnership === 'shared'
    ? path.posix.join('/workspace/ipc/uploads', group.folder)
    : '/workspace/ipc/uploads';
}

/**
 * Project data root as seen by a run in the effective container.
 *
 * A standalone sandbox mounts that project's directory directly at
 * `/workspace/group`. A shared owner instead mounts its whole group subtree at
 * that fixed path, so direct children live one level below it. Keeping this
 * separate from `workspaceRoot` is important: the latter is repository data,
 * while this path is transcripts, artifacts, rules, and other group data.
 */
export function effectiveContainerGroupDir(
  group: RegisteredGroup,
  lookup: GroupLookup = getGroupByFolder,
): string {
  const effective = resolveEffectiveSandbox(group, lookup);
  return effective.inherited
    ? path.posix.join('/workspace/group', group.folder)
    : '/workspace/group';
}

/**
 * Resolve each distinct container represented by a group list. Shared children
 * collapse onto their owner's container so lifecycle sweeps act exactly once.
 */
export function uniqueEffectiveSandboxes(
  groups: RegisteredGroup[],
  lookup: GroupLookup = getGroupByFolder,
): ReturnType<typeof resolveEffectiveSandbox>[] {
  const seen = new Set<string>();
  const result: ReturnType<typeof resolveEffectiveSandbox>[] = [];
  for (const group of groups) {
    const effective = resolveEffectiveSandbox(group, lookup);
    const key = `${effective.stack}:${effective.instance}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(effective);
  }
  return result;
}

/** Shared owners control the runtime stack; standalone projects retain overrides. */
export function effectiveRunSandboxStack(
  effective: ReturnType<typeof resolveEffectiveSandbox>,
  requestedStack?: string,
): string {
  return effective.owner.settings?.sandboxOwnership === 'shared'
    ? effective.stack
    : requestedStack || effective.stack;
}

/** Shared ownership wins over explicit child instance arguments. */
export function effectiveOperationInstance(
  effective: ReturnType<typeof resolveEffectiveSandbox>,
  requestedInstance?: string | null,
): string | undefined {
  // Shared owners and standalone fixed instances both have an authoritative
  // configured Compose instance. Managed standalone projects still need their
  // derived instance when a task has not persisted sandbox_instance yet (for
  // example, a Testing preflight before the first active run is launched).
  // Omitting it makes CarapaBox target the stack's unqualified template project
  // instead of the running per-project Compose instance.
  return effective.owner.settings?.sandboxOwnership === 'shared' ||
    effective.fixedInstance
    ? effective.instance
    : (requestedInstance ?? effective.instance);
}

/**
 * Instance the board is allowed to manage through lifecycle operations.
 * A standalone configured instance is externally managed, so preserve the
 * project-folder lifecycle target instead of starting/stopping it.
 */
export function lifecycleSandboxInstance(
  effective: ReturnType<typeof resolveEffectiveSandbox>,
): string {
  return effective.owner.settings?.sandboxOwnership === 'shared'
    ? effective.instance
    : effective.group.folder;
}

/** Scope raw sandbox_git arguments to an inherited child's repository. */
export function effectiveGitArgs(
  effective: ReturnType<typeof resolveEffectiveSandbox>,
  gitArgs: string,
): string {
  return effective.inherited
    ? `-C ${shellQuote(effective.workspaceRoot)} ${gitArgs}`
    : gitArgs;
}

/**
 * Container cleanup owned by a project deletion. Inherited children never
 * stop or remove their parent's shared container. Standalone projects keep
 * the folder-named deletion target, including fixed external instances.
 */
export function projectDeletionSandboxTarget(
  group: RegisteredGroup,
  lookup: GroupLookup = getGroupByFolder,
): { stack: string; instance: string } | undefined {
  const effective = resolveEffectiveSandbox(group, lookup);
  if (effective.inherited) return undefined;
  if (group.settings?.sandboxOwnership === 'shared') {
    return { stack: effective.stack, instance: effective.instance };
  }
  return {
    stack: group.settings?.defaultSandbox || DEFAULT_SANDBOX_STACK,
    instance: group.folder,
  };
}

export function effectiveSandboxSettings(
  group: RegisteredGroup,
  lookup: GroupLookup = getGroupByFolder,
): EffectiveSandboxSettings {
  const {
    group: _group,
    owner: _owner,
    fixedInstance: _fixed,
    extraRoots: _extra,
    ...settings
  } = resolveEffectiveSandbox(group, lookup);
  return settings;
}

/**
 * Trusted remote URL for CarapaBox git calls: the board-held repositoryUrl of
 * the repository at `effective.workspaceRoot`. Passing it stops a repo's own
 * `.git/config`, which sandbox agents can rewrite, from choosing where the
 * host SSH keys are used.
 *
 * A project's own repositoryUrl wins. A child with none falls back to the
 * shared owner's URL only when it operates on the owner's root repository; a
 * child at a distinct sub-repository root never borrows the owner's URL, which
 * names a different remote. Undefined when no trusted URL applies.
 */
export function effectiveRemoteUrl(
  effective: Pick<
    ReturnType<typeof resolveEffectiveSandbox>,
    'group' | 'owner' | 'inherited' | 'workspaceRoot' | 'containerWorkspaceRoot'
  >,
): string | undefined {
  const own = effective.group.settings?.repositoryUrl?.trim();
  if (own) return own;
  if (
    effective.inherited &&
    effective.workspaceRoot === effective.containerWorkspaceRoot
  ) {
    return effective.owner.settings?.repositoryUrl?.trim() || undefined;
  }
  return undefined;
}
