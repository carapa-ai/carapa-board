/**
 * Objective folder lifecycle helpers.
 *
 * Folder initialisation is delegated to the brain container via POST /init-objective.
 * The brain creates the scaffold, copies styles, writes identity/context, and runs fixmcp.sh.
 *
 * This module retains helpers for:
 *   - resolving objective paths (getObjectiveDir)
 *   - updating context after edits (writeObjectiveContext)
 *   - archiving on delete (archiveObjectiveFolder)
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { STORE_DIR } from '../../config.js';
import { getGroupDir } from '../../group-dir.js';
import { logger } from '../../logger.js';
import {
  copyTreeSync,
  GroupFsError,
  lstatAtSync,
  mkdirAtSync,
  openDirAtSync,
  openGroupDir,
  openGroupDirSync,
  renameAtSync,
  removeAtSync,
  splitRelPath,
  writeFileAt,
} from '../../lib/group-fs.js';
import type { PinnedDir } from '../../lib/group-fs.js';
import {
  fetchBrain,
  objectiveAgentRuntimeEventData,
  resolveBrainContainer,
  resolveBrainAuthToken,
  resolveBrainAuthTokenOwner,
} from './brain-client.js';
import type { Objective } from './types.js';
import { ObjectiveMoveInProgressError } from './db-objectives.js';
import type { RegisteredGroup } from '../../types.js';
import { resolveObjectiveAgentRuntime } from './objective-agent.js';
import { refreshProjectAgentView } from '../../sandbox/disabled-skills.js';

export { computeObjectiveWorkDir } from './work-dir.js';

// ── Objective directory helpers ───────────────────────────────────────────────

/** Return the filesystem path for an objective folder. */
export function getObjectiveDir(
  project_id: string,
  objective_id: string,
): string {
  return path.join(getGroupDir(project_id), 'objectives', objective_id);
}

/** Whether `id` is a single, plain path segment (no separators, `.` or `..`). */
function isObjectiveIdSegment(id: string): boolean {
  try {
    return splitRelPath(id).length === 1;
  } catch {
    return false;
  }
}

const OBJECTIVE_CONTEXT_FILE = '.claude/rules/objective-context.md';

/*
 * Write (or overwrite) the objective context rule file so the agent
 * automatically picks up the objective definition when running in this folder.
 *
 * The project folder is agent-writable, so every directory is opened through a
 * descriptor with O_NOFOLLOW and the file is replaced atomically. Only the
 * board's own relative link (`.claude -> .agent`) is followed, and only while
 * it stays inside the objective folder; anything else is refused.
 * Returns false when refused.
 */
export async function writeObjectiveContext(
  project_id: string,
  objective: Objective,
): Promise<boolean> {
  const refuse = (refused: string, err?: unknown): false => {
    logger.warn(
      { project_id, objective_id: objective.id, path: refused, err },
      'Refusing objective context write through symlink',
    );
    return false;
  };
  if (!isObjectiveIdSegment(objective.id)) {
    return refuse(objective.id);
  }

  const lines: string[] = [
    '---',
    'trigger: always_on',
    'description: Objective identity, status, progress, description, deadline, and metadata.',
    '---',
    '',
    `# Objective: ${objective.title}`,
    '',
    `- **Project ID**: \`${project_id}\``,
    `- **Objective ID**: \`${objective.id}\``,
    `- **Status**: ${objective.status}`,
    `- **Progress**: ${objective.progress}%`,
  ];
  if (objective.description)
    lines.push('', `## Description`, '', objective.description);
  if (objective.deadline) lines.push('', `Deadline: ${objective.deadline}`);
  if (objective.metadata && typeof objective.metadata === 'object') {
    lines.push('', '## Metadata');
    for (const [key, value] of Object.entries(objective.metadata)) {
      if (value === null || value === undefined || value === '') continue;
      const text = typeof value === 'object' ? JSON.stringify(value) : value;
      lines.push(`- **${key}**: ${text}`);
    }
  }
  lines.push('');

  const contextFile = path.join(
    getObjectiveDir(project_id, objective.id),
    OBJECTIVE_CONTEXT_FILE,
  );
  try {
    const objectiveDir = await openGroupDir(
      project_id,
      `objectives/${objective.id}`,
      { create: true },
    );
    if (!objectiveDir) return refuse(contextFile);
    try {
      await writeFileAt(
        objectiveDir,
        OBJECTIVE_CONTEXT_FILE,
        lines.join('\n'),
        { mkdirs: true, followInternalLinks: true },
      );
    } finally {
      await objectiveDir.close();
    }
  } catch (err) {
    if (err instanceof GroupFsError) return refuse(contextFile, err);
    throw err;
  }
  return true;
}

/**
 * Initialise an objective folder by calling the brain's POST /init-objective endpoint.
 * Awaits the brain response so the caller can broadcast only after the dashboard exists.
 * Returns the outcome with a human-readable reason on failure (never throws).
 *
 * project_id is sent to the brain only when the brain's GROUP_DIR is a superset
 * of this project's folder (i.e. the brain serves multiple projects):
 *   - Main brain (serves all groups) → send project_id
 *   - Parent brain where this project is a child → send project_id
 *   - Project's own brain (GROUP_DIR = project folder) → omit project_id
 */
export type ObjectiveInitResult = { ok: true } | { ok: false; reason: string };

async function runObjectiveFolderInit(
  project_id: string,
  objective_id: string,
  objective: Objective | undefined,
  brainContainer?: string,
  parentId?: string,
  group?: { settings?: RegisteredGroup['settings']; parentId?: string },
): Promise<ObjectiveInitResult> {
  const resolvedBrainContainer = resolveBrainContainer({
    settings: { brainContainer },
    parentId,
  });
  if (!resolvedBrainContainer) {
    logger.warn(
      { project_id, objective_id, brainContainer },
      'No brain container configured — skipping objective folder init',
    );
    return {
      ok: false,
      reason:
        'this project has no CarapaBrain container configured, so nothing can create the objective folder',
    };
  }

  const authToken = resolveBrainAuthToken(group);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const brainProjectId = parentId ? project_id : undefined;

  const body: Record<string, unknown> = { objective_id };
  if (brainProjectId) body.project_id = brainProjectId;
  if (objective) {
    const eventRuntime = resolveObjectiveAgentRuntime(
      group as RegisteredGroup | undefined,
      objective.eventRuntimeSelection,
    );
    body.objective = {
      title: objective.title,
      id: objective.id,
      status: objective.status,
      progress: objective.progress,
      description: objective.description || undefined,
      deadline: objective.deadline ?? undefined,
      metadata: objective.metadata ?? undefined,
      ...objectiveAgentRuntimeEventData(eventRuntime),
    };
  }

  try {
    // Use the shared brain fetch helper so a sandbox restart between cache
    // refreshes self-heals: it refreshes on a cache miss and retries once when
    // the cached dynamic host port refuses the connection.
    const res = await fetchBrain(
      resolvedBrainContainer,
      '/init-objective',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
      resolveBrainAuthTokenOwner(group, project_id),
    );
    if (!res) {
      logger.error(
        { project_id, objective_id, brainContainer: resolvedBrainContainer },
        'Brain container not found after port cache refresh',
      );
      return {
        ok: false,
        reason: `the CarapaBrain container "${resolvedBrainContainer}" is not running or not reachable`,
      };
    }
    if (!res.ok) {
      logger.error(
        { project_id, objective_id, status: res.status },
        'Brain init-objective failed',
      );
      return {
        ok: false,
        reason:
          res.status === 401 || res.status === 403
            ? `CarapaBrain refused the request (HTTP ${res.status}) because this project's Brain auth token is wrong. Open the project settings, go to Integrations → Brain, and enter the correct Brain Auth Token (the one whose hash is CARAPA_BRAIN_AUTH_TOKEN_SHA256 in the Brain stack's .env)`
            : `CarapaBrain answered the setup request with HTTP ${res.status}`,
      };
    }
    logger.info(
      { project_id, objective_id },
      'Objective folder initialised by brain',
    );
    // Link the new objective's template skills/rules in a running container.
    void refreshProjectAgentView(project_id);
    return { ok: true };
  } catch (err) {
    logger.error(
      { err, project_id, objective_id },
      'Failed to call brain init-objective',
    );
    return {
      ok: false,
      reason: `CarapaBoard could not reach CarapaBrain (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/** Returns true on success, false on failure (never throws). */
export async function initObjectiveFolder(
  ...args: Parameters<typeof runObjectiveFolderInit>
): Promise<boolean> {
  return (await runObjectiveFolderInit(...args)).ok;
}

/**
 * Make sure an objective's folder was initialised by the brain (template
 * `.agent/` rules and skills, state.json, dashboard) before an agent runs in it.
 * Objective creation ignores a failed init, which leaves a missing or partial
 * folder; the brain's init is idempotent, so retry it here. A folder that
 * cannot be initialised is only fatal when it does not exist at all, because
 * the sandbox cannot launch without it.
 */
export async function ensureObjectiveFolderInitialised(
  project_id: string,
  objective: Objective,
  group: { settings?: RegisteredGroup['settings']; parentId?: string },
): Promise<void> {
  if (objective.move_source_project) {
    // Initialising now could create the folder before the move brings the real
    // one over, which would leave both and block the move.
    throw new ObjectiveMoveInProgressError(objective);
  }
  const dir = getObjectiveDir(project_id, objective.id);
  if (fs.existsSync(path.join(dir, 'state.json'))) return;

  const result = await runObjectiveFolderInit(
    project_id,
    objective.id,
    objective,
    group.settings?.brainContainer,
    group.parentId,
    group,
  );
  if (result.ok) return;
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Objective "${objective.title}" (${objective.id}) was never set up: its folder does not exist, and the automatic setup failed because ${result.reason}. Fix that, then send your message again.`,
    );
  }
  logger.warn(
    { project_id, objective_id: objective.id, reason: result.reason },
    'Objective folder is not fully initialised and automatic setup failed',
  );
}

/**
 * Archive an objective folder to store/objectives/{archive_name}/ (default
 * the objective id) then delete it.
 * Mirrors the task-transcript archival pattern. The folder is first renamed to
 * a hidden sibling inside the pinned `objectives/` directory, so a later swap
 * of the original path cannot redirect the copy or the removal.
 */
export function archiveObjectiveFolder(
  project_id: string,
  objective_id: string,
  entry: string = objective_id,
  archive_name: string = objective_id,
): void {
  if (!isObjectiveIdSegment(objective_id)) {
    logger.warn(
      { project_id, objective_id },
      'Refusing to archive objective folder with an invalid id',
    );
    return;
  }
  let objectives: PinnedDir | null = null;
  // The entry holding the folder; becomes the hidden name once renamed.
  let current = objective_id;
  try {
    objectives = openGroupDirSync(project_id, 'objectives');
    if (!objectives) return;
    const hidden = `.archiving-${randomUUID()}`;
    try {
      renameAtSync(objectives, entry, objectives, hidden);
    } catch (err) {
      if (err instanceof GroupFsError && err.code === 'not_found') return;
      throw err;
    }
    current = hidden;

    const archiveDest = path.join(STORE_DIR, 'objectives', archive_name);
    const folder = openDirAtSync(objectives, hidden);
    if (!folder)
      throw new Error('Objective folder disappeared while archiving');
    try {
      copyTreeSync(folder, archiveDest);
    } finally {
      folder.closeSync();
    }
    removeAtSync(objectives, hidden, { recursive: true });
    logger.info(
      { project_id, objective_id, archiveDest },
      'Objective folder archived',
    );
  } catch (err) {
    logger.error(
      { err, project_id, objective_id },
      'Failed to archive objective folder; removing directly',
    );
    try {
      if (objectives) removeAtSync(objectives, current, { recursive: true });
    } catch (rmErr) {
      logger.error(
        { rmErr, project_id, objective_id },
        'Failed to remove objective folder',
      );
    }
  } finally {
    objectives?.closeSync();
  }
}

/**
 * Archive an objective's folder on delete, including what an unfinished move
 * left behind: the folder and a `.moving-out` copy in the source project, and a
 * partial `.moving-in` copy in the target project. Left alone they would stay
 * orphaned and visible to that project's agent. Each copy gets its own archive
 * folder so they do not overwrite each other.
 */
export function archiveObjectiveFolders(
  objective: Pick<Objective, 'id' | 'project_id' | 'move_source_project'>,
): void {
  const { id } = objective;
  archiveObjectiveFolder(objective.project_id, id);
  archiveObjectiveFolder(
    objective.project_id,
    id,
    `${id}.moving-in`,
    `${id}.moving-in`,
  );
  const source = objective.move_source_project;
  if (!source) return;
  archiveObjectiveFolder(source, id, id, `${id}.from-${source}`);
  archiveObjectiveFolder(
    source,
    id,
    `${id}.moving-out`,
    `${id}.moving-out-from-${source}`,
  );
}

/**
 * Whether `objectives/<objective_id>` is a real directory in a project. A path
 * through a link or a non-directory counts as not in place.
 */
export function isObjectiveFolderInPlace(
  project_id: string,
  objective_id: string,
): boolean {
  try {
    return (
      lstatObjectiveFolder(project_id, objective_id)?.isDirectory() === true
    );
  } catch (err) {
    if (!(err instanceof GroupFsError)) throw err;
    return false;
  }
}

/**
 * Rewrite the objective context file after an edit. An unfinished move
 * (`move_source_project` set) skips it only while the folder is not yet in place
 * at `project_id`: writing then would create the target folder and block the
 * repeated move, which writes the file itself. Once the folder is there (for
 * example the Brain registration failed after it moved) the file is rewritten,
 * so the agent does not keep reading stale status.
 */
export async function refreshObjectiveContext(
  project_id: string,
  objective: Objective,
): Promise<boolean> {
  if (objective.move_source_project) {
    if (!isObjectiveFolderInPlace(project_id, objective.id)) return false;
  }
  return writeObjectiveContext(project_id, objective);
}

/**
 * lstat of `objectives/<objective_id>` in a project, without following links.
 * Null when the folder (or the project's `objectives/`) does not exist; throws
 * `GroupFsError` when the path runs through a link or a non-directory.
 */
export function lstatObjectiveFolder(
  project_id: string,
  objective_id: string,
): fs.Stats | null {
  const objectives = openGroupDirSync(project_id, 'objectives');
  if (!objectives) return null;
  try {
    return lstatAtSync(objectives, objective_id);
  } finally {
    objectives.closeSync();
  }
}

const isRealDir = (dir: PinnedDir, name: string): boolean =>
  lstatAtSync(dir, name)?.isDirectory() === true;

/**
 * Whether a folder move out of `project_id` is unfinished there: the objective
 * folder is still in place, or a copied-out `.moving-out` folder was not removed.
 * A path that cannot be verified counts as unfinished.
 */
export function hasObjectiveFolderLeftover(
  project_id: string,
  objective_id: string,
): boolean {
  try {
    const objectives = openGroupDirSync(project_id, 'objectives');
    if (!objectives) return false;
    try {
      return (
        isRealDir(objectives, objective_id) ||
        isRealDir(objectives, `${objective_id}.moving-out`)
      );
    } finally {
      objectives.closeSync();
    }
  } catch (err) {
    if (!(err instanceof GroupFsError)) throw err;
    logger.warn(
      { err, project_id, objective_id },
      'Cannot verify objective folder leftover; treating it as unfinished',
    );
    return true;
  }
}

/**
 * Move an objective folder to another project: rename, falling back to a copy
 * on another filesystem. The fallback copies into `<target>.moving-in`, hides
 * the source by renaming it to `<source>.moving-out`, renames the copy into
 * place and only then deletes the hidden source. The real source and target
 * paths therefore only ever hold a whole folder, and a failed step leaves the
 * source intact (or restores it). A leftover `.moving-out` folder is deleted
 * on the next call once the target exists. A call that finds the process was
 * interrupted after hiding the source (neither path present) renames the
 * finished copy into place, or restores the source if no copy exists.
 *
 * `moved` is true when this call moved or finished moving the folder;
 * `leftover` is true while the source folder or a `.moving-out` copy still
 * exists, so the folder step is not finished. Nothing is moved when there is
 * no source or the target already exists; an existing target is never
 * overwritten or merged. Throws when the move fails, leaving the source in
 * place.
 */
export function moveObjectiveFolder(
  source_project: string,
  target_project: string,
  objective_id: string,
): { moved: boolean; leftover: boolean } {
  const moved = moveFolderSteps(source_project, target_project, objective_id);
  return {
    moved,
    leftover: hasObjectiveFolderLeftover(source_project, objective_id),
  };
}

function moveFolderSteps(
  source_project: string,
  target_project: string,
  objective_id: string,
): boolean {
  if (!isObjectiveIdSegment(objective_id)) {
    throw new Error(`Invalid objective id: ${objective_id}`);
  }
  // Both `objectives/` directories are pinned: every later step names its
  // entries through them, so a swapped path cannot redirect the move.
  const src = openGroupDirSync(source_project, 'objectives');
  if (!src) return false;
  let dst: PinnedDir | null = null;
  try {
    dst = openGroupDirSync(target_project, 'objectives', { create: true });
    if (!dst) throw new Error(`Cannot open objectives of ${target_project}`);
    return moveWithinPinned(
      src,
      dst,
      source_project,
      target_project,
      objective_id,
    );
  } finally {
    dst?.closeSync();
    src.closeSync();
  }
}

function moveWithinPinned(
  src: PinnedDir,
  dst: PinnedDir,
  source_project: string,
  target_project: string,
  objective_id: string,
): boolean {
  const hiddenSource = `${objective_id}.moving-out`;
  const partialTarget = `${objective_id}.moving-in`;
  const remove = (dir: PinnedDir, name: string) =>
    removeAtSync(dir, name, { recursive: true });

  let targetExists = lstatAtSync(dst, objective_id) !== null;
  // True when this call completed folder work even though no rename happened.
  let finishedEarlierMove = false;
  if (
    !targetExists &&
    !isRealDir(src, objective_id) &&
    isRealDir(src, hiddenSource)
  ) {
    // Interrupted between hiding the source and renaming the copy into place,
    // so neither normal path exists. The copy was whole before the source was
    // hidden: finish the rename, or put the source back if there is no copy.
    if (lstatAtSync(dst, partialTarget)) {
      renameAtSync(dst, partialTarget, dst, objective_id);
      targetExists = true;
      finishedEarlierMove = true;
    } else {
      renameAtSync(src, hiddenSource, src, objective_id);
    }
  }
  if (targetExists && isRealDir(src, hiddenSource)) {
    try {
      remove(src, hiddenSource);
      finishedEarlierMove = true;
    } catch (err) {
      logger.warn({ err, hiddenSource }, 'Could not remove moved-out folder');
    }
  }
  if (!isRealDir(src, objective_id)) return finishedEarlierMove;
  if (targetExists) {
    logger.warn(
      {
        source: getObjectiveDir(source_project, objective_id),
        target: getObjectiveDir(target_project, objective_id),
      },
      'Objective folder exists in both projects; leaving both untouched',
    );
    return false;
  }

  try {
    renameAtSync(src, objective_id, dst, objective_id);
    return true;
  } catch (renameErr) {
    logger.warn(
      { err: renameErr, source_project, target_project, objective_id },
      'Objective folder rename failed; copying instead',
    );
  }

  remove(dst, partialTarget);
  try {
    const from = openDirAtSync(src, objective_id);
    if (!from) throw new Error('Objective folder disappeared during move');
    try {
      const to = mkdirAtSync(dst, partialTarget);
      try {
        copyTreeSync(from, to);
      } finally {
        to.closeSync();
      }
    } finally {
      from.closeSync();
    }
    renameAtSync(src, objective_id, src, hiddenSource);
  } catch (err) {
    remove(dst, partialTarget);
    throw err;
  }
  try {
    renameAtSync(dst, partialTarget, dst, objective_id);
  } catch (err) {
    renameAtSync(src, hiddenSource, src, objective_id);
    remove(dst, partialTarget);
    throw err;
  }
  try {
    remove(src, hiddenSource);
  } catch (err) {
    logger.warn({ err, hiddenSource }, 'Could not remove moved-out folder');
  }
  return true;
}
