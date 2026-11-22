import type { Project } from '../types.js';
import { getHostGroupDir } from '../group-dir.js';
import { resolveEffectiveSandbox } from './effective-settings.js';
import { ENABLE_NGINX_PROXY } from '../config.js';

/**
 * Build env overrides for starting a group's sandbox instance.
 * Sets GROUP_DIR to the sandbox owner's group directory.
 * Only sets LOCAL_REPO/GIT_REPO when explicitly configured —
 * custom stacks have their own .env with these values.
 *
 * All paths here must be HOST-side paths because they become Docker bind mount sources.
 */
export function buildSandboxEnv(
  project: Project,
  _stack?: string,
): Record<string, string> {
  const effective = resolveEffectiveSandbox(project);
  const envOwner = effective.owner;
  // A main mounts only its own folder and reaches other permitted projects
  // through MCP tools. A project placed on a remote CarapaBox has its group directory on that
  // box: send logical references the box resolves under its own roots.
  // Host paths in project settings (repositoryLocation, extra mounts) already
  // describe the host that runs the project.
  const remoteBox =
    !!envOwner.settings?.boxId && envOwner.settings.boxId !== 'local';
  const groupDir = remoteBox
    ? `@group/${envOwner.folder}`
    : getHostGroupDir(envOwner.folder);
  const env: Record<string, string> = {
    CARAPA_SSH_ENABLED: envOwner.settings?.sshEnabled === true ? '1' : '0',
    GROUP_DIR: groupDir,
  };

  if (effective.hostWorkspaceLocation) {
    env.LOCAL_REPO = effective.hostWorkspaceLocation;
  } else if (envOwner.settings?.repositoryLocation) {
    env.LOCAL_REPO = envOwner.settings.repositoryLocation;
  } else {
    // Default: mount the group's host directory as the workspace repo.
    // Custom stacks can still override via their own .env, but env-passthrough
    // injection takes precedence when set.
    env.LOCAL_REPO = groupDir;
  }

  if (project.settings?.repositoryUrl) {
    env.GIT_REPO = project.settings.repositoryUrl;
  }

  // WORKSPACE_PATH — primary repo path inside the container.
  // Absolute `workspacePath` (e.g. /var/www/<repo>) is used verbatim so projects
  // with non-default mount layouts can point the primary root at the actual mount.
  // Otherwise treated as a slug under /workspace/ (legacy behavior).
  // Kept in sync with `modules/fs/sandbox-fs.ts:computeWorkspaceRoot`.
  env.WORKSPACE_PATH = effective.containerWorkspaceRoot;
  env.DEFAULT_BRANCH = project.settings?.defaultBranch || 'develop';
  // One web server belongs to the effective sandbox owner. In shared
  // multi-repository sandboxes, resolve its document root relative to the
  // owner's workspace rather than allowing whichever child starts the stack
  // to change the site being served.
  env.WEB_ROOT_PATH = effective.webRootPath;
  // Controller-only metadata consumed by CarapaBox when generating the
  // host-nginx route. Always send an array, including [] so a restart clears
  // aliases removed from project settings.
  if (ENABLE_NGINX_PROXY) {
    env.NGINX_PROXY_ALIASES = JSON.stringify(effective.proxyHostnameAliases);
  }

  // Read-only extra host folders, mounted by the stack at /workspace/<name>.
  // CarapaBox validates the sources against its mount allowlist and the names
  // against the other /workspace mounts.
  for (const mount of effective.extraMounts) {
    env[`EXTRA_MOUNT_${mount.slot}`] = mount.hostPath;
    env[`EXTRA_MOUNT_${mount.slot}_NAME`] = mount.name;
  }

  // GIT_REPO mode — switch to git compose file (uses named volume instead of bind mount)
  if (!env.LOCAL_REPO && env.GIT_REPO) {
    env.COMPOSE_FILE = 'docker-compose.git.yml';
  }

  // Per-project carapa-mail MCP token. carapa-box stores this under the
  // "carapa-mail" relay-token scope so api-relay injects it when this
  // sandbox's agents hit /carapa-mail/mcp. Only set when explicitly enabled
  // and present (settings hold the plaintext token in memory).
  if (
    project.settings?.carapaMailEnabled &&
    project.settings?.carapaMailToken
  ) {
    env.CARAPA_MAIL_MCP_TOKEN = project.settings.carapaMailToken;
  }

  return env;
}
