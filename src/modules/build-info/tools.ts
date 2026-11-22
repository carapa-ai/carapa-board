import {
  BUILD_TIME,
  BUILD_VERSION,
  CARAPA_BOX_URL,
  BOARD_SELF_DEPLOY_ENABLED,
  CARAPA_BOARD_DEPLOY_SERVICE,
} from '../../config.js';
import { getGroupByFolder } from '../../state-manager.js';
import { scrubSecretText } from '../../logger.js';
import {
  extractBuildFailureLines,
  getServerWebBuildStatus,
} from '../../lib/server-web-build-status.js';
import {
  resolveBrainContainer,
  resolveBrainUrl,
} from '../objectives/brain-client.js';
import type { McpServerDeps } from '../../mcp/auth.js';
import type { ToolDefinition } from '../tools/types.js';

/** Captured once at module load so repeated calls report the same process start. */
const STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/** Board build identity as reported by `get_build_info` and `board_started`. */
export function boardBuildInfo(): {
  version: string;
  buildTime: string | null;
  startedAt: string;
} {
  return {
    version: BUILD_VERSION,
    buildTime: BUILD_TIME ?? null,
    startedAt: STARTED_AT,
  };
}

const SERVICE_TIMEOUT_MS = 3000;

type ServiceError = { error: string };

const errorReason = (err: unknown): string => {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `timed out after ${SERVICE_TIMEOUT_MS}ms`;
  }
  return (err instanceof Error ? err.message : String(err)).slice(0, 120);
};

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body !== 'object') throw new Error('invalid response');
  return body as Record<string, unknown>;
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

async function brainInfo(groupFolder: string): Promise<
  | {
      commit: string | null;
      buildTime: string | null;
      startedAt: string | null;
      url: string;
    }
  | ServiceError
> {
  const group = getGroupByFolder(groupFolder);
  const url = group ? resolveBrainUrl(resolveBrainContainer(group)) : null;
  if (!url) return { error: `no brain configured for ${groupFolder}` };
  try {
    const body = await fetchJson(`${url}/version`);
    return {
      commit: stringOrNull(body.commit),
      buildTime: stringOrNull(body.buildTime),
      startedAt: stringOrNull(body.startedAt),
      url,
    };
  } catch (err) {
    return { error: errorReason(err) };
  }
}

export type BoxInfo = {
  version: string | null;
  buildTime: string | null;
  startedAt: string | null;
};

/**
 * Whether the caller may read the failing lines of the last administrator-
 * requested server & web build.
 *
 * The fresh signature on the admin route protects actions (triggering a build)
 * and the raw 20 KB output. `failureLines` is bounded, scrubbed and read-only,
 * and it is derived from the repository's own code and test output, which the
 * board-repo projects' sandboxes already mount and can reproduce by running
 * the same tests. Every other project gets the build status only.
 *
 * This gate deliberately does not use `hasPermission(..., '*:*')`: every
 * logged-in user's HTTP session and the master token hold that permission, so
 * it is not an administrator marker. The gate fails closed on every error.
 */
export function canReadBoardBuildOutput(
  context: {
    group_folder: string;
    kind?: string;
    oauth_user_is_admin?: boolean;
  },
  deps?: Partial<McpServerDeps> | null,
): boolean {
  try {
    if (context.kind === 'oauth') {
      return context.oauth_user_is_admin === true;
    }
    const folder = context.group_folder;
    if (!folder || !BOARD_SELF_DEPLOY_ENABLED) return false;
    if (typeof deps?.getRegisteredGroups !== 'function') return false;
    const groups = Object.values(deps.getRegisteredGroups() ?? {});
    return groups.some(
      (group) =>
        group?.settings?.deployService === CARAPA_BOARD_DEPLOY_SERVICE &&
        (group.folder === folder || group.parentId === folder),
    );
  } catch {
    return false;
  }
}

/** CarapaBox `/health` build info, or `{ error }` when it is unreachable. */
export async function boxInfo(): Promise<BoxInfo | ServiceError> {
  try {
    const body = await fetchJson(`${CARAPA_BOX_URL}/health`);
    let startedAt = stringOrNull(body.startedAt);
    if (!startedAt && typeof body.uptime === 'number') {
      const derived = new Date(Date.now() - body.uptime * 1000);
      if (!Number.isNaN(derived.getTime())) startedAt = derived.toISOString();
    }
    return {
      version: stringOrNull(body.version),
      buildTime: stringOrNull(body.buildTime),
      startedAt,
    };
  } catch (err) {
    return { error: errorReason(err) };
  }
}

export const getBuildInfoTool: ToolDefinition = {
  name: 'get_build_info',
  description:
    'Read-only: identifies the running Board, Brain and Box builds. Returns JSON ' +
    '`{ version, buildTime, startedAt, services: { board, brain, box }, serverWebBuild }`. ' +
    'Top-level `version`, `buildTime` and `startedAt` describe the Board: `version` is the configured build version ' +
    '(may be a file fingerprint rather than a git sha, or "development"); `buildTime` is the ISO build timestamp or null when unknown; ' +
    '`startedAt` is the ISO time this Board process started. ' +
    '`services.board` repeats `{ version, buildTime, startedAt }`. ' +
    "`services.brain` is `{ commit, buildTime, startedAt, url }` for the calling project's Brain (from its /version endpoint; " +
    '`buildTime` and `startedAt` are null when the Brain does not report them) ' +
    'or `{ error }` when none is configured or it is unreachable. ' +
    '`services.box` is `{ version, buildTime, startedAt }` from CarapaBox /health (fields are null when the Box does not report them; ' +
    '`startedAt` is derived from its uptime when absent) or `{ error }`. A failing service never fails the call. ' +
    '`serverWebBuild` is `{ status }` (idle|building|ready|failed) of the last administrator-requested server & web build; ' +
    "for the CarapaBoard repository's project, its parent and admin OAuth users a failed build also carries `error` and " +
    '`failureLines` (secret-scrubbed failing lines, max 40); call this when a board build failed instead of asking for the log. ' +
    'Inference limits: `buildTime` only proves that a commit is live if the deploy built develop HEAD after that commit was merged; ' +
    'a manual build from another checkout can mislead; do not assume `version` is a git sha; ' +
    '`commit` values are git short shas only when the build supplied one ("unknown" or a fingerprint otherwise).',
  inputSchema: {},
  requiredPermissions: ['tasks:read'],
  handler: async (_args, deps, context) => {
    const board = boardBuildInfo();
    const [brain, box] = await Promise.all([
      brainInfo(context.group_folder),
      boxInfo(),
    ]);
    const buildState = getServerWebBuildStatus();
    const serverWebBuild: Record<string, unknown> = {
      status: buildState.status,
    };
    if (
      buildState.status === 'failed' &&
      canReadBoardBuildOutput(context, deps)
    ) {
      serverWebBuild.error = scrubSecretText(buildState.error ?? '');
      serverWebBuild.failureLines = extractBuildFailureLines(
        buildState.output ?? '',
      );
    }
    return JSON.stringify({
      ...board,
      services: { board, brain, box },
      serverWebBuild,
    });
  },
};
