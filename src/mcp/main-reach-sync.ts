/**
 * Keeps the permissions of every live agent token of a per-user main in step
 * with the projects that user may reach.
 *
 * Tokens are minted with a snapshot of the reach resolved at mint time and the
 * sandbox-level token lives until the sandbox restarts, so a new project would
 * stay unreachable and a removed or downgraded member would keep their old
 * access. Any project change (debounced) and the liveness sweep re-resolve the
 * reach through `resolveAgentPermissions` and rewrite only `permissions` of the
 * main's agent tokens. The policy itself is unchanged.
 *
 * A request already past `verifyToken` when a rewrite lands completes with the
 * old scope; the debounce window plus recompute time bounds the lag.
 */

import { projectChanges } from '../lib/project-changes.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import { resolveAgentPermissions } from './auth.js';
import {
  hasAgentTokensForGroup,
  onTokenMinted,
  setAgentTokenPermissions,
} from './auth-tokens.js';

type GroupsSource = () => Record<string, RegisteredGroup>;

const DEBOUNCE_MS = 1000;

interface FolderRun {
  /** A change arrived during the current pass; one more pass is owed. */
  dirty: boolean;
  done: Promise<void>;
}

// Single-flight per main folder: concurrent requests collapse into the running
// pass plus exactly one more.
const running = new Map<string, FolderRun>();

let groupsSource: GroupsSource | null = null;

// A token minted while a pass runs may have been registered after the pass
// read the registry. A token whose permissions were resolved before a project
// change may register after the pass for that change finished. Either way, owe
// the folder a pass that sees the token; for a stale token the mint waits for
// that pass, so the token is never issued with the pre-change scope.
onTokenMinted((folder, stale) => {
  const run = running.get(folder);
  if (run) run.dirty = true;
  if (stale && groupsSource) return rescopeMainTokens(folder, groupsSource);
});

// Folders whose last pass failed to resolve reach; the failure is reported when
// it starts, not on every sweep while it lasts.
const failing = new Set<string>();

async function rescopeOnce(
  folder: string,
  getGroups: GroupsSource,
): Promise<void> {
  if (!hasAgentTokensForGroup(folder)) return;
  const main = Object.values(getGroups()).find(
    (g) => g.folder === folder && g.is_main && g.user_id,
  );
  if (!main) return;

  const { permissions, reachFailed } = await resolveAgentPermissions(
    main,
    getGroups(),
    { quiet: true },
  );
  // Tokens are read after the await: one revoked meanwhile is gone from the
  // registry and is not rewritten.
  const { rewritten, foldersBefore } = await setAgentTokenPermissions(
    folder,
    permissions,
  );
  if (reachFailed) {
    if (rewritten > 0 || !failing.has(folder)) {
      logger.warn(
        { event: 'main_reach_rescope_failed', folder, tokens: rewritten },
        'Per-user main reach resolution failed; tokens kept to own folder',
      );
    }
    failing.add(folder);
  } else {
    failing.delete(folder);
  }
  if (rewritten > 0) {
    logger.info(
      {
        event: 'main_reach_rescoped',
        folder,
        tokens: rewritten,
        foldersBefore,
        foldersAfter: Object.keys(permissions).length,
      },
      'Per-user main tokens re-scoped',
    );
  }
}

/** Re-scope the agent tokens of one per-user main; serialized per folder. */
export function rescopeMainTokens(
  folder: string,
  getGroups: GroupsSource,
): Promise<void> {
  const current = running.get(folder);
  if (current) {
    current.dirty = true;
    return current.done;
  }
  const run: FolderRun = { dirty: false, done: Promise.resolve() };
  run.done = (async () => {
    try {
      do {
        run.dirty = false;
        try {
          await rescopeOnce(folder, getGroups);
        } catch (err) {
          logger.error({ err, folder }, 'Per-user main token re-scope failed');
        }
      } while (run.dirty);
    } finally {
      running.delete(folder);
    }
  })();
  running.set(folder, run);
  return run.done;
}

/** Re-scope the agent tokens of every per-user main that has any. */
export async function rescopeAllMainTokens(
  getGroups: GroupsSource,
): Promise<void> {
  const folders = new Set(
    Object.values(getGroups())
      .filter((g) => g.is_main && g.user_id)
      .map((g) => g.folder),
  );
  await Promise.all(
    [...folders]
      .filter(hasAgentTokensForGroup)
      .map((folder) => rescopeMainTokens(folder, getGroups)),
  );
}

/**
 * Re-scope after project changes, coalesced: the first change arms a timer and
 * later changes before it fires ride on it, so a steady stream of changes
 * cannot postpone a re-scope past `debounceMs`. Changes are emitted after their
 * data is written, so the pass the timer starts sees all of them. Returns a
 * function that stops listening.
 */
export function startMainReachSync(
  getGroups: GroupsSource,
  debounceMs = DEBOUNCE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  groupsSource = getGroups;
  const onChange = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      rescopeAllMainTokens(getGroups).catch((err) =>
        logger.error({ err }, 'Per-user main token re-scope failed'),
      );
    }, debounceMs);
    timer.unref?.();
  };
  projectChanges.on('changed', onChange);
  return () => {
    projectChanges.off('changed', onChange);
    if (groupsSource === getGroups) groupsSource = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
