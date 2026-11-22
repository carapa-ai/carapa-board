import path from 'path';
import {
  getSandboxClient,
  type SandboxExecResult,
} from '../../lib/mcp-client.js';
import { getGroupByFolder } from '../../state-manager.js';
import { buildSandboxEnv } from '../../sandbox/sandbox-env.js';
import type { RegisteredGroup } from '../../types.js';
import { logger } from '../../logger.js';
import {
  computeEffectiveWorkspaceRoot,
  resolveEffectiveSandbox,
} from '../../sandbox/effective-settings.js';
import { isSandboxRunning } from '../../sandbox/status.js';

export { shellQuote } from '../../utils.js';

export interface ResolvedSandbox {
  group: RegisteredGroup;
  stack: string;
  service: string;
  instance: string;
  fixedInstance: boolean;
  inherited: boolean;
  /** The actual project repo root inside the container, e.g. /workspace/<slug>. */
  workspaceRoot: string;
  /**
   * Additional absolute container-side paths the fs tools may read, on top of
   * `workspaceRoot`. Sourced from `group.settings.workspaceRoots`. Normalized,
   * deduped, and stripped of any entry that equals or is contained in
   * `workspaceRoot` (which would be redundant).
   */
  extraRoots: string[];
}

/**
 * Compute the project's primary workspace root inside the sandbox container.
 *
 * - If `settings.workspacePath` is an absolute POSIX path → normalized and used (lets
 *   projects with non-default mount layouts, e.g. `/var/www/<repo>`, point the
 *   primary root at the actual mount).
 * - Otherwise → treated as a slug under `/workspace/` (legacy behavior).
 *
 * Kept in sync with `sandbox-env.ts` which derives the docker-side
 * `WORKSPACE_PATH` env var the same way.
 */
export function computeWorkspaceRoot(group: RegisteredGroup): string {
  return computeEffectiveWorkspaceRoot(group);
}

export function resolveGroupSandbox(group_folder: string): ResolvedSandbox {
  const group = getGroupByFolder(group_folder);
  if (!group) {
    throw new Error(`Group not found: ${group_folder}`);
  }
  const effective = resolveEffectiveSandbox(group);
  const {
    stack,
    service,
    fixedInstance,
    inherited,
    instance,
    workspaceRoot,
    extraRoots,
  } = effective;
  return {
    group,
    stack,
    service,
    instance,
    fixedInstance,
    inherited,
    workspaceRoot,
    extraRoots,
  };
}

export async function ensureSandboxRunning(
  resolved: ResolvedSandbox,
): Promise<void> {
  if (resolved.fixedInstance) return;

  const client = getSandboxClient();
  const status = await client.sandboxStatus(resolved.stack, resolved.instance);
  const needsStart = !isSandboxRunning(status);
  if (!needsStart) return;

  if (resolved.inherited) {
    throw new Error(
      `Parent-owned sandbox is unavailable; start it through the owner project before using child filesystem tools`,
    );
  }

  logger.info(
    {
      stack: resolved.stack,
      instance: resolved.instance,
      reason: status.stdout.slice(0, 200),
    },
    'fs tool: sandbox not running, starting...',
  );
  const env = buildSandboxEnv(resolved.group, resolved.stack);
  const startResult = await client.sandboxStart(
    resolved.stack,
    env,
    resolved.instance,
    resolved.service,
  );
  if (startResult.isError) {
    throw new Error(
      `Failed to start sandbox ${resolved.stack}/${resolved.instance}: ${startResult.stdout}`,
    );
  }
  logger.info(
    { stack: resolved.stack, instance: resolved.instance },
    'fs tool: sandbox started',
  );
}

export async function execInGroupSandbox(
  group_folder: string,
  command: string,
  options?: { timeout?: number },
): Promise<SandboxExecResult> {
  const resolved = await prepareGroupSandbox(group_folder);
  const client = getSandboxClient();
  return client.sandboxExec(resolved.stack, resolved.service, command, {
    instance: resolved.instance,
    timeout: options?.timeout,
  });
}

/** Resolve + auto-start the group's sandbox, returning the resolution for follow-up calls. */
export async function prepareGroupSandbox(
  group_folder: string,
): Promise<ResolvedSandbox> {
  const resolved = resolveGroupSandbox(group_folder);
  await ensureSandboxRunning(resolved);
  return resolved;
}

/** Use the reflector's originating checkout instead of the project's default. */
export async function prepareScopedSandbox(
  group_folder: string,
  scope?: {
    stack: string;
    service: string;
    instance: string;
    workspaceRoot: string;
  },
): Promise<ResolvedSandbox> {
  if (!scope) return prepareGroupSandbox(group_folder);
  const group = getGroupByFolder(group_folder);
  if (!group) throw new Error(`Group not found: ${group_folder}`);
  return {
    group,
    stack: scope.stack,
    service: scope.service,
    instance: scope.instance,
    fixedInstance: true,
    inherited: false,
    workspaceRoot: scope.workspaceRoot,
    extraRoots: [],
  };
}

export interface SandboxPathRoots {
  /** Primary root used as the base for relative paths and as the default search dir. */
  primary: string;
  /** Extra absolute roots accepted for absolute paths (typically from `settings.workspaceRoots`). */
  extra: string[];
}

function isUnder(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function formatRootsForError(roots: SandboxPathRoots): string {
  if (!roots.extra.length) return roots.primary;
  return [roots.primary, ...roots.extra].join(', ');
}

/**
 * Resolve a user-supplied path to its sandbox-side absolute path.
 *
 * - No `subPath` → returns the primary root.
 * - Relative `subPath` → joined to the primary root; must remain under it.
 * - Absolute `subPath` → accepted if it falls under the primary root or any extra root.
 *
 * Throws `Unauthorized: …` listing every legal root if the candidate escapes them.
 * The listing is intentional: the LLM uses the error to retry with a valid absolute path.
 */
export function resolveSandboxPath(
  roots: SandboxPathRoots,
  subPath?: string,
): string {
  if (!subPath) {
    if (roots.extra.length > 0) {
      throw new Error(
        `This project has multiple workspace roots; please pass an absolute path. Legal roots: ${formatRootsForError(roots)}`,
      );
    }
    return roots.primary;
  }
  if (path.posix.isAbsolute(subPath)) {
    const candidate = path.posix.normalize(subPath);
    if (
      isUnder(roots.primary, candidate) ||
      roots.extra.some((root) => isUnder(root, candidate))
    ) {
      return candidate;
    }
    throw new Error(
      `Unauthorized: path ${candidate} is outside the project's workspace roots (${formatRootsForError(roots)})`,
    );
  }
  const candidate = path.posix.normalize(
    path.posix.join(roots.primary, subPath),
  );
  if (!isUnder(roots.primary, candidate)) {
    throw new Error(
      `Unauthorized: path ${candidate} is outside ${roots.primary}`,
    );
  }
  return candidate;
}
