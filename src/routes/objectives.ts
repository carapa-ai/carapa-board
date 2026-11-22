/**
 * Objective CRUD and dashboard serving. Objective chats are normal chats served
 * by the conversation routes (`objective_id` selects the objective).
 */
import { createHash } from 'crypto';
import fsp, { type FileHandle } from 'fs/promises';
import path from 'path';
import { Router, type Response } from 'express';
import {
  createObjective,
  getObjective,
  getObjectivesByProject,
  getReferencedObjectiveSummaries,
  updateObjective,
  deleteObjective,
  getObjectiveChatStatusMap,
  updateObjectiveCostLimit,
  pauseCronjobsByObjective,
} from '../db.js';
import { registeredGroups, getGroupByFolder } from '../state-manager.js';
import { resolveEffectiveSandbox } from '../sandbox/effective-settings.js';
import { formatTranscriptEntries } from '../modules/transcripts/transcript-store.js';
import {
  archivedCarapaRunV1Paths,
  carapaRunV1Paths,
  parseCarapaRunV1EventText,
  parseCarapaRunV1Manifest,
  projectCarapaRunV1Entries,
  readCarapaRunV1Pair,
  summarizeCarapaRunV1,
} from '../modules/transcripts/carapa-run-v1.js';
import fs from 'fs';
import { broadcast } from '../modules/objectives/ws-events.js';
import { drainQueuesForObjective } from '../modules/objectives/drain-linked-queues.js';
import { logger } from '../logger.js';
import { validateRuntimeSelection } from '../lib/chat-agents.js';
import {
  initObjectiveFolder,
  archiveObjectiveFolders,
  getObjectiveDir,
  refreshObjectiveContext,
} from '../modules/objectives/objective-folder.js';
import {
  computeObjectiveWorkDir,
  objectiveWorkDirFor,
} from '../modules/objectives/work-dir.js';
import {
  publishEvent,
  publishObjectiveStateEvent,
  resolveBrainUrl,
  resolveBrainContainer,
  resolveBrainAuthToken,
  resolveBrainAuthTokenOwner,
  fetchBrain,
} from '../modules/objectives/brain-client.js';
import { getGroupDir } from '../group-dir.js';
import {
  MAX_LEN,
  canAccessProject,
  userCanReadProjectDashboard,
  lenError,
  userHasExplicitGroupAccess,
} from './_helpers.js';
import { lookup as lookupMime } from 'mime-types';
import { readContainedText } from '../lib/file-content.js';
import {
  GroupFsError,
  openDirAt,
  openFileAt,
  openGroupDir,
  openParentDir,
  readFileAt,
  readdirAt,
  sendPinnedFile,
  type PinnedDir,
} from '../lib/group-fs.js';
import { DATA_DIR, ENABLE_OBJECTIVES } from '../config.js';
import {
  issueDashboardPathToken,
  issueDashboardTicket,
  splitDashboardPathToken,
  verifyDashboardPathToken,
  verifyDashboardTicket,
} from '../modules/objectives/dashboard-access.js';
import { enforceProjectAccess } from './projects.js';
import { calculateModelCostUsd } from '../lib/model-pricing.js';
import { parseJsonl } from '../lib/jsonl.js';
import { sha256Hex } from '../lib/hash.js';
import {
  aggregateRunStats,
  aggregateRunStatsIfChanged,
  forgetObjectiveRunStats,
} from '../modules/objectives/objective-run-stats.js';
import { activationRefusalMessage } from '../modules/objectives/objective-budget.js';
import { notifyProjectOwner } from '../modules/tools/push-tools.js';
import { hasPermission } from '../mcp/auth.js';
import {
  moveObjective,
  ObjectiveMoveError,
} from '../modules/objectives/move-objective.js';

const router = Router();

/** Largest objective file a viewer route reads into memory. */
const MAX_OBJECTIVE_FILE_BYTES = 8 * 1024 * 1024;
/** JSONL logs grow for the objective's lifetime: an oversized one is read from its tail. */
const MAX_JSONL_BYTES = 128 * 1024 * 1024;

/**
 * Pin an objective folder without following any link: the folder lives in an
 * agent-writable tree, so every directory is opened with O_NOFOLLOW and the
 * descriptor is used from then on. Null when it does not exist; a link or a
 * non-directory throws a GroupFsError. The caller closes the result.
 */
async function openObjectiveDir(
  objectiveDir: string,
): Promise<PinnedDir | null> {
  const parent = await openParentDir(objectiveDir);
  if (!parent) return null;
  try {
    return await openDirAt(parent.dir, parent.name);
  } finally {
    await parent.dir.close();
  }
}

/**
 * Read `rel` below an objective folder through pinned descriptors. Only the
 * board's own relative links (`.claude -> .agent`) are followed, and only
 * while they stay inside the objective folder. Null when the file is missing;
 * refusals (link leaving the folder, not a regular file, too large) throw a
 * GroupFsError.
 */
async function readObjectiveFileAt(
  objectiveDir: string,
  rel: string,
  maxBytes: number,
  tail = false,
): Promise<Buffer | null> {
  const dir = await openObjectiveDir(objectiveDir);
  if (!dir) return null;
  try {
    const read = await readFileAt(dir, rel, {
      maxBytes,
      tail,
      followInternalLinks: true,
    });
    return read?.data ?? null;
  } finally {
    await dir.close();
  }
}

/**
 * Read one agent-writable file for a viewer. Responds 400 `Invalid path` when
 * the path runs through a link that leaves the objective folder and
 * `notFound` (404) when it is missing or unreadable; returns the content only
 * on success.
 */
async function readObjectiveFile(
  res: Response,
  objectiveDir: string,
  rel: string,
  notFound: string,
): Promise<string | null> {
  try {
    const data = await readObjectiveFileAt(
      objectiveDir,
      rel,
      MAX_OBJECTIVE_FILE_BYTES,
    );
    if (data) return data.toString('utf-8');
    res.status(404).json({ error: notFound });
  } catch (err) {
    if (err instanceof GroupFsError && err.code === 'unsupported') {
      logger.warn(
        { err, objectiveDir, rel },
        'Objective file read unsupported',
      );
      res.status(500).json({ error: 'Failed to read file' });
    } else if (
      err instanceof GroupFsError &&
      (err.code === 'invalid_path' || err.code === 'symlink')
    ) {
      res.status(400).json({ error: 'Invalid path' });
    } else {
      res.status(404).json({ error: notFound });
    }
  }
  return null;
}

/** Catch handler for listings: a refused path lists nothing; an unsupported platform warns once. */
function warnUnsupported(err: unknown): null {
  if (!(err instanceof GroupFsError)) throw err;
  if (err.code === 'unsupported') {
    logger.warn({ err }, 'Objective file listing unsupported');
  }
  return null;
}

/** Open `rel` below a pinned objective folder for a listing; null when missing or refused. The caller closes the handle. */
async function openContainedFile(
  objectiveDir: PinnedDir,
  rel: string,
): Promise<Awaited<ReturnType<typeof openFileAt>>> {
  return openFileAt(objectiveDir, rel, { followInternalLinks: true }).catch(
    warnUnsupported,
  );
}

/** First 500 characters of an opened file; empty when it cannot be read. */
async function readPreview(opened: {
  handle: FileHandle;
  stat: fs.Stats;
}): Promise<string> {
  // 4 bytes per character is the UTF-8 maximum.
  const buffer = Buffer.alloc(Math.min(opened.stat.size, 500 * 4));
  try {
    const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf-8').slice(0, 500);
  } catch {
    return '';
  }
}

/** Like `readJsonl`, but a missing, empty or refused file reads as empty. */
async function readContainedJsonl(
  objectiveDir: string,
  rel: string,
): Promise<Record<string, unknown>[]> {
  try {
    const data = await readObjectiveFileAt(
      objectiveDir,
      rel,
      MAX_JSONL_BYTES,
      true,
    );
    return data ? parseJsonl(data.toString('utf-8')) : [];
  } catch (err) {
    if (err instanceof GroupFsError && err.code === 'unsupported') {
      logger.warn({ err, objectiveDir, rel }, 'Objective log read unsupported');
    }
    return [];
  }
}

/** A run id is only turned into a file name when it is one plain path segment. */
function isLinkableRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId) && runId !== '.' && runId !== '..';
}

/**
 * Dashboard documents are agent-written and untrusted: confine them to an
 * opaque origin with no top-level navigation or same-origin access.
 */
function applyDashboardSecurityHeaders(res: any): void {
  res.set({
    'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
}

/** Script-free, asset-free empty state for an objective with no dashboard yet. */
const EMPTY_DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>No dashboard yet</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif;background:Canvas;color:CanvasText}
main{text-align:center;padding:24px}
h1{margin:0 0 6px;font-size:16px;font-weight:600}
p{margin:0;opacity:.65}
</style></head>
<body><main data-ui="objective-dashboard-empty"><h1>No dashboard yet</h1><p>This objective doesn't have a dashboard to show.</p></main></body></html>`;

const OBSOLETE_SMART_FIELDS = [
  'specific',
  'measurable',
  'achievable',
  'relevant',
  'time_bound',
] as const;

const MAX_PAGINATION_VALUE = 2_147_483_647;

function parseIntegerQueryValue(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseObjectivePagination(
  query: { limit?: unknown; offset?: unknown },
  defaultLimit: number,
  maxLimit: number,
): { limit: number; offset: number } {
  const parsedLimit = parseIntegerQueryValue(query.limit, defaultLimit);
  const parsedOffset = parseIntegerQueryValue(query.offset, 0);
  return {
    limit: Math.min(Math.max(1, parsedLimit), maxLimit),
    offset: Math.min(Math.max(0, parsedOffset), MAX_PAGINATION_VALUE),
  };
}

type ObjectiveEventRunStatus =
  | 'run'
  | 'skipped'
  | 'pending'
  | 'failed'
  | 'delivered'
  | 'unmatched'
  | 'unknown'
  | 'queued';
type ObjectiveEventDelivery = {
  status: 'enqueued' | 'unmatched' | 'failed';
  targetObjectiveIds: string[];
};
// Fallback when brain liveness is unknown or the objective is not active.
// Exceeds the brain's 20-minute production assessment timeout plus queue and
// cleanup time.
const OBJECTIVE_RUN_STALE_MS = 25 * 60 * 1000;
const BRAIN_STATUS_TIMEOUT_MS = 1500;
const BRAIN_STATUS_CACHE_TTL_MS = 5000;
const brainStatusCache = new Map<
  string,
  { expiresAt: number; activeObjectiveIds: Set<string> | undefined }
>();
type AnnotatedObjectiveEvent = Record<string, unknown> & {
  runStatus: ObjectiveEventRunStatus;
  linkedRunId?: string;
  runRationale?: string;
  delivery?: ObjectiveEventDelivery;
};

function objectiveEventDelivery(
  event: Record<string, unknown>,
): ObjectiveEventDelivery | undefined {
  if (event.type !== 'objective_event') return undefined;
  const delivery = event.delivery;
  if (!delivery || typeof delivery !== 'object') return undefined;
  const candidate = delivery as Record<string, unknown>;
  if (
    candidate.status !== 'enqueued' &&
    candidate.status !== 'unmatched' &&
    candidate.status !== 'failed'
  ) {
    return undefined;
  }
  if (
    !Array.isArray(candidate.targetObjectiveIds) ||
    !candidate.targetObjectiveIds.every((id) => typeof id === 'string')
  ) {
    return undefined;
  }
  return {
    status: candidate.status,
    targetObjectiveIds: candidate.targetObjectiveIds,
  };
}

type ObjectiveEventGroup = {
  timestamp: string;
  events: AnnotatedObjectiveEvent[];
  runStatus: ObjectiveEventRunStatus;
  linkedRunId?: string;
  runRationale?: string;
  delivery?: ObjectiveEventDelivery;
};

/**
 * Ask carapa-brain whether it is currently processing the objective.
 * Returns undefined when liveness cannot be determined (no group/container,
 * unreachable brain, non-2xx, timeout, bad JSON). Results are cached per brain
 * container because the UI polls the events endpoint every few seconds.
 */
async function resolveObjectiveRunActive(
  projectId: string,
  objectiveId: string,
  nowMs = Date.now(),
): Promise<boolean | undefined> {
  try {
    const group = getGroupByFolder(projectId);
    if (!group) return undefined;
    const brainContainer = resolveBrainContainer(group);
    if (!brainContainer) return undefined;
    const cached = brainStatusCache.get(brainContainer);
    if (cached && cached.expiresAt > nowMs) {
      return cached.activeObjectiveIds?.has(objectiveId);
    }
    let activeObjectiveIds: Set<string> | undefined;
    try {
      const authToken = resolveBrainAuthToken(group);
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const resp = await fetchBrain(
        brainContainer,
        '/status',
        { headers, signal: AbortSignal.timeout(BRAIN_STATUS_TIMEOUT_MS) },
        resolveBrainAuthTokenOwner(group, projectId),
      );
      if (resp?.ok) {
        const body = (await resp.json()) as {
          processor?: { activeObjectiveIds?: unknown };
        };
        const ids = body?.processor?.activeObjectiveIds;
        if (Array.isArray(ids)) {
          activeObjectiveIds = new Set(
            ids.filter((id): id is string => typeof id === 'string'),
          );
        }
      }
    } catch (err) {
      logger.debug(
        { brainContainer, err: String(err) },
        'Brain /status unavailable for objective liveness',
      );
    }
    brainStatusCache.set(brainContainer, {
      expiresAt: nowMs + BRAIN_STATUS_CACHE_TTL_MS,
      activeObjectiveIds,
    });
    return activeObjectiveIds?.has(objectiveId);
  } catch (err) {
    logger.debug({ err: String(err) }, 'Objective liveness lookup failed');
    return undefined;
  }
}

const SKIP_REASON_MAX_LENGTH = 200;

function skippedEventRationale(event: Record<string, unknown>): string {
  const reason =
    typeof event.skipReason === 'string' ? event.skipReason.trim() : '';
  if (!reason) return 'Handled by the brain without an agent run';
  return reason.length > SKIP_REASON_MAX_LENGTH
    ? `${reason.slice(0, SKIP_REASON_MAX_LENGTH - 1)}…`
    : reason;
}

export function annotateObjectiveEventRunOutcomes(
  events: Record<string, unknown>[],
  evals: Record<string, unknown>[],
  runStats: Record<string, unknown>[] = [],
  nowMs = Date.now(),
  objectiveId?: string,
  objectiveRunActive?: boolean,
): AnnotatedObjectiveEvent[] {
  const completedRunIds = new Set(
    runStats
      .map((run) => run.runId)
      .filter((runId): runId is string => typeof runId === 'string'),
  );
  const annotated: AnnotatedObjectiveEvent[] = events.map((event) => {
    const delivery = objectiveEventDelivery(event);
    const runStatus: ObjectiveEventRunStatus = delivery
      ? delivery.status === 'enqueued'
        ? 'delivered'
        : delivery.status === 'unmatched'
          ? 'unmatched'
          : 'failed'
      : 'pending';
    // The brain flags events it handled itself (e.g. a quiet board/box restart
    // auto-verify) with skipped: true and writes no eval for them. Mark them
    // here so they neither stay "Waiting" nor join the next invocation's batch.
    if (runStatus === 'pending' && event.skipped === true) {
      return {
        ...event,
        runStatus: 'skipped',
        runRationale: skippedEventRationale(event),
      };
    }
    return { ...event, runStatus };
  });
  // The brain never runs the same objective concurrently, so while it reports
  // the objective as active only the newest uncompleted invocation is live.
  let liveInvocationIndex = -1;
  if (objectiveRunActive === true) {
    let newest = -Infinity;
    annotated.forEach((event, index) => {
      if (event.type !== 'agent_invoked') return;
      const payload = event.payload as Record<string, unknown> | undefined;
      const runId = payload?.run_id;
      if (typeof runId === 'string' && completedRunIds.has(runId)) return;
      const timestamp =
        typeof event.timestamp === 'string'
          ? new Date(event.timestamp).getTime()
          : 0;
      if (timestamp >= newest) {
        newest = timestamp;
        liveInvocationIndex = index;
      }
    });
  }
  const timeline: Array<{
    timestamp: number;
    order: number;
    kind: 'event' | 'skip';
    index?: number;
    eval?: Record<string, unknown>;
  }> = annotated.map((event, index) => ({
    timestamp:
      typeof event.timestamp === 'string'
        ? new Date(event.timestamp).getTime()
        : 0,
    order: index * 2,
    kind: 'event',
    index,
  }));

  for (const evaluation of evals) {
    if (evaluation.skipped !== true) continue;
    timeline.push({
      timestamp:
        typeof evaluation.timestamp === 'string'
          ? new Date(evaluation.timestamp).getTime()
          : 0,
      order: Number.MAX_SAFE_INTEGER,
      kind: 'skip',
      eval: evaluation,
    });
  }
  timeline.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);

  let pending: number[] = [];
  for (const entry of timeline) {
    if (entry.kind === 'skip') {
      const evaluation = entry.eval!;
      const triggerType = String(evaluation.triggerType ?? '');
      const matching = pending.filter(
        (index) => annotated[index]?.type === triggerType,
      );
      const targets = matching.length > 0 ? matching : pending;
      for (const index of targets) {
        annotated[index]!.runStatus = 'skipped';
        if (typeof evaluation.runId === 'string') {
          annotated[index]!.linkedRunId = evaluation.runId;
        }
        if (typeof evaluation.rationale === 'string') {
          annotated[index]!.runRationale = evaluation.rationale;
        }
      }
      const targetIndexes = new Set(targets);
      pending = pending.filter((index) => !targetIndexes.has(index));
      continue;
    }

    const index = entry.index!;
    const event = annotated[index]!;
    if (event.type !== 'agent_invoked') {
      if (event.runStatus === 'pending') pending.push(index);
      continue;
    }

    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : {};
    const runId =
      typeof payload.run_id === 'string' ? payload.run_id : undefined;
    const invocationTimestamp =
      typeof event.timestamp === 'string'
        ? new Date(event.timestamp).getTime()
        : 0;
    const runStatus: ObjectiveEventRunStatus =
      runId && completedRunIds.has(runId)
        ? 'run'
        : index !== liveInvocationIndex &&
            invocationTimestamp > 0 &&
            nowMs - invocationTimestamp > OBJECTIVE_RUN_STALE_MS
          ? 'failed'
          : 'pending';
    // The brain logs every event of a batched queue item right before the
    // single agent_invoked, whose trigger_type names only the first event.
    for (const pendingIndex of pending) {
      annotated[pendingIndex]!.runStatus = runStatus;
      if (runId) annotated[pendingIndex]!.linkedRunId = runId;
      if (runStatus === 'failed') {
        annotated[pendingIndex]!.runRationale =
          'Agent invocation did not produce a completed run';
      }
    }
    pending = [];
    event.runStatus = runStatus;
    if (runId) event.linkedRunId = runId;
    if (runStatus === 'failed') {
      event.runRationale = 'Agent invocation did not produce a completed run';
    }
  }

  // Old source-side events predate persisted delivery metadata. Only mark
  // events that did not pair with a local invocation as unknown; this keeps
  // historical self-subscriptions linkable to the run they produced.
  if (objectiveId !== undefined) {
    for (const index of pending) {
      const event = annotated[index]!;
      const payload =
        event.payload && typeof event.payload === 'object'
          ? (event.payload as Record<string, unknown>)
          : {};
      if (
        event.type === 'objective_event' &&
        payload.source_objective_id === objectiveId
      ) {
        event.runStatus = 'unknown';
      }
    }
  }

  return annotated;
}

export function groupObjectiveEvents(
  events: AnnotatedObjectiveEvent[],
): ObjectiveEventGroup[] {
  const groups: ObjectiveEventGroup[] = [];
  const groupsByRunId = new Map<string, ObjectiveEventGroup>();

  for (const event of events) {
    const linkedRunId = event.linkedRunId;
    let group = linkedRunId ? groupsByRunId.get(linkedRunId) : undefined;
    if (!group) {
      const delivery = objectiveEventDelivery(event);
      group = {
        timestamp: typeof event.timestamp === 'string' ? event.timestamp : '',
        events: [],
        runStatus: event.runStatus,
        ...(linkedRunId ? { linkedRunId } : {}),
        ...(delivery ? { delivery } : {}),
      };
      groups.push(group);
      if (linkedRunId) groupsByRunId.set(linkedRunId, group);
    }

    group.events.push(event);
    group.runStatus = event.runStatus;
    const delivery = objectiveEventDelivery(event);
    if (delivery) group.delivery = delivery;
    if (event.runRationale) group.runRationale = event.runRationale;
    if (
      typeof event.timestamp === 'string' &&
      new Date(event.timestamp).getTime() > new Date(group.timestamp).getTime()
    ) {
      group.timestamp = event.timestamp;
    }
  }

  return groups.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

/**
 * Stable per-group ids for the Events tab: the linked run id, else a hash of
 * the group's first event (type, timestamp, payload; not the run annotations
 * that change while a run progresses). Identical keys get a numeric suffix.
 */
function withObjectiveEventGroupIds(
  groups: ObjectiveEventGroup[],
): (ObjectiveEventGroup & { id: string })[] {
  const seen = new Map<string, number>();
  return groups.map((group) => {
    const first = group.events[0];
    const base =
      group.linkedRunId ??
      sha256Hex(
        JSON.stringify([first?.type, first?.timestamp, first?.payload]),
      ).slice(0, 16);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { ...group, id: count ? `${base}-${count}` : base };
  });
}

/**
 * Events still waiting in the brain queue (`queue.json`) for this objective.
 * The brain appends them to events.jsonl only when it dequeues the item, so
 * without this they stay invisible while the objective is busy. Events the
 * brain already logged (loggedEventKeys, same hash as the brain's
 * eventLogKey) are skipped. In-flight items (`currentItems`) are already logged.
 */
export function queuedObjectiveEventGroups(
  queueState: unknown,
  objectiveId: string,
): ObjectiveEventGroup[] {
  const items = (queueState as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const groups: ObjectiveEventGroup[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (item.objectiveId !== objectiveId) continue;
    const pending = Array.isArray(item.pendingEvents) ? item.pendingEvents : [];
    const candidates = pending.length ? pending : [item.triggerEvent];
    const logged = new Set(
      Array.isArray(item.loggedEventKeys) ? item.loggedEventKeys : [],
    );
    const notBefore =
      typeof item.notBefore === 'string' ? item.notBefore : undefined;
    const events: AnnotatedObjectiveEvent[] = [];
    for (const event of candidates) {
      if (!event || typeof event !== 'object') continue;
      const key = createHash('sha1')
        .update(JSON.stringify(event))
        .digest('hex');
      if (logged.has(key)) continue;
      events.push({
        ...(event as Record<string, unknown>),
        runStatus: 'queued',
      });
    }
    if (!events.length) continue;
    const timestamp = events.reduce((latest, event) => {
      const ts = typeof event.timestamp === 'string' ? event.timestamp : '';
      return ts > latest ? ts : latest;
    }, '');
    groups.push({
      timestamp,
      events,
      runStatus: 'queued',
      ...(notBefore ? { runRationale: `Scheduled for ${notBefore}` } : {}),
    });
  }
  return groups.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

/**
 * The folder of the brain that serves `projectId`, which is where that brain
 * keeps queue.json (its GROUP_DIR): the shared-sandbox owner's folder for an
 * inherited child (same split as objectiveWorkDirFor); the parent's folder for
 * a child that has no brainContainer of its own and uses its parent's brain
 * (same fallback as resolveBrainContainer, which routes its events) or whose
 * brainContainer names exactly its parent's brainContainer; otherwise the
 * project's own folder. Owning a sandbox alone does not make a brain.
 * The folder comes only from the group registry, never from request input.
 */
function brainFolderFor(projectId: string): string {
  const group = getGroupByFolder(projectId);
  if (!group) return projectId;
  try {
    const sandbox = resolveEffectiveSandbox(group);
    if (sandbox.inherited) return sandbox.owner.folder;
  } catch {
    return projectId;
  }
  if (!group.parentId) return projectId;
  const own = group.settings?.brainContainer;
  const usesParentBrain = own
    ? own === getGroupByFolder(group.parentId)?.settings?.brainContainer
    : resolveBrainContainer(group) !== undefined;
  return usesParentBrain ? group.parentId : projectId;
}

export async function readObjectiveQueuedEvents(
  projectId: string,
  objectiveId: string,
): Promise<ObjectiveEventGroup[]> {
  const brainFolder = brainFolderFor(projectId);
  try {
    const brainDir = await openGroupDir(brainFolder);
    if (!brainDir) return [];
    try {
      const read = await readFileAt(brainDir, 'queue.json', {
        maxBytes: 8 * 1024 * 1024,
      });
      if (!read) return [];
      return queuedObjectiveEventGroups(
        JSON.parse(read.data.toString('utf-8')),
        objectiveId,
      );
    } finally {
      await brainDir.close();
    }
  } catch {
    return [];
  }
}

/**
 * The objective's in-progress brain run: the newest invocation the events
 * annotation still considers pending (same liveness rules as the Events tab).
 */
export function currentObjectiveRun(
  annotated: AnnotatedObjectiveEvent[],
  objectiveRunActive?: boolean,
): { runId: string; timestamp: string; triggerType: string | null } | null {
  // The brain says nothing runs: a pending invocation is a dead run. An
  // unknown (undefined) answer keeps the pending run so a real one is not hidden.
  if (objectiveRunActive === false) return null;
  for (let index = annotated.length - 1; index >= 0; index--) {
    const event = annotated[index]!;
    if (event.type !== 'agent_invoked' || event.runStatus !== 'pending') {
      continue;
    }
    if (!event.linkedRunId || typeof event.timestamp !== 'string') continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    return {
      runId: event.linkedRunId,
      timestamp: event.timestamp,
      triggerType:
        typeof payload.trigger_type === 'string' ? payload.trigger_type : null,
    };
  }
  return null;
}

/**
 * Host directory of a brain run while it is in progress. The brain writes it
 * to /workspace/ipc/brain-runs/runs/<runId> inside its sandbox, whose IPC
 * mount is DATA_DIR/ipc/<compose project>; the container name is
 * <compose project>-agent-<replica>.
 */
export function liveBrainRunDir(
  brainContainer: string,
  runId: string,
): string | null {
  const composeProject = brainContainer.replace(/-agent-\d+$/, '');
  if (composeProject === brainContainer) return null;
  return path.join(
    DATA_DIR,
    'ipc',
    composeProject,
    'brain-runs',
    'runs',
    runId,
  );
}

export function obsoleteObjectiveFieldsError(body: unknown): string | null {
  const record =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const fields = OBSOLETE_SMART_FIELDS.filter((field) =>
    Object.hasOwn(record, field),
  );
  const legacyRuntimeFields = ['agent_cmd', 'agent_model'].filter((field) =>
    Object.hasOwn(record, field),
  );
  if (legacyRuntimeFields.length > 0) {
    return `Legacy objective runtime fields are not supported: ${legacyRuntimeFields.join(', ')}. Use eventRuntimeSelection instead.`;
  }
  return fields.length > 0
    ? `Obsolete objective fields are not supported: ${fields.join(', ')}. Put structured values in metadata instead.`
    : null;
}

router.use('/projects/:pid/objectives', (_req, res, next) => {
  if (!ENABLE_OBJECTIVES) {
    return res.status(404).json({ error: 'Objectives feature is not enabled' });
  }
  next();
});

/**
 * Detect whether an agent is currently running for this objective.
 * Compares agent_invoked events in events.jsonl against completed run IDs
 * in run-stats.jsonl. If any invoked run ID has no matching stats entry,
 * the agent is still running.
 */
const runningCache = new Map<string, { value: boolean; ts: number }>();
const RUNNING_CACHE_TTL = 30_000; // 30 seconds

/** Invalidate running cache for a specific objective directory (or all if omitted). */
export function invalidateRunningCache(objectiveDir?: string): void {
  if (objectiveDir) {
    runningCache.delete(objectiveDir);
  } else {
    runningCache.clear();
  }
}

export async function detectAgentRunning(
  objectiveDir: string,
  runStats?: Record<string, unknown>[],
): Promise<boolean> {
  const cached = runningCache.get(objectiveDir);
  if (cached && Date.now() - cached.ts < RUNNING_CACHE_TTL) return cached.value;

  const [events, stats] = await Promise.all([
    readContainedJsonl(objectiveDir, 'events.jsonl'),
    runStats
      ? Promise.resolve(runStats)
      : readContainedJsonl(objectiveDir, 'run-stats.jsonl'),
  ]);

  // Collect all run IDs that have completed (appear in run-stats.jsonl)
  const completedRunIds = new Set<string>();
  for (const s of stats) {
    if (typeof s.runId === 'string') completedRunIds.add(s.runId);
  }

  const staleThreshold = Date.now() - 30 * 60 * 1000; // 30 minutes

  // Check if any agent_invoked event has a run ID not yet in run-stats
  // Events are chronological; stop scanning once we hit events older than the stale threshold
  let result = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'agent_invoked') continue;

    // Skip stale events — agent likely crashed without writing stats
    const ts =
      typeof e.timestamp === 'string' ? new Date(e.timestamp).getTime() : 0;
    if (ts > 0 && ts < staleThreshold) break;

    const payload = (e.payload ?? e) as Record<string, unknown>;
    const runId = typeof payload.run_id === 'string' ? payload.run_id : null;
    if (runId && !completedRunIds.has(runId)) {
      result = true;
      break;
    }
  }

  runningCache.set(objectiveDir, { value: result, ts: Date.now() });
  return result;
}

// --- Objectives ---

/**
 * GET /api/projects/:pid/objective-statuses
 * Title and status of the objectives the project's cards reference, including
 * ones owned by a parent project.
 */
router.get('/projects/:pid/objective-statuses', async (req, res) => {
  res.json(await getReferencedObjectiveSummaries(req.params.pid));
});

/**
 * GET /api/projects/:pid/objectives
 * List objectives for a project.
 */
router.get('/projects/:pid/objectives', async (req, res) => {
  const [objectives, chatStatusMap] = await Promise.all([
    getObjectivesByProject(req.params.pid),
    getObjectiveChatStatusMap(req.params.pid),
  ]);
  await Promise.all(
    objectives.map(async (obj) => {
      const objDir = getObjectiveDir(req.params.pid, obj.id);
      const runStatsEntries = await readContainedJsonl(
        objDir,
        'run-stats.jsonl',
      );
      const [runStats, isAgentRunning] = await Promise.all([
        aggregateRunStatsIfChanged(objDir, req.params.pid, obj.id, () =>
          readContainedJsonl(objDir, 'run-stats.jsonl'),
        ),
        detectAgentRunning(objDir, runStatsEntries),
      ]);
      const refreshed = await getObjective(obj.id);
      if (refreshed) Object.assign(obj, refreshed);
      (obj as any).runStats = runStats;
      (obj as any).isAgentRunning = isAgentRunning;
      (obj as any).chatStatus = chatStatusMap[obj.id] ?? null;
    }),
  );
  res.json(objectives);
});

/**
 * POST /api/projects/:pid/objectives
 * Create a new objective.
 */
export async function createObjectiveHandler(req: any, res: any) {
  const {
    title,
    description,
    status,
    priority,
    deadline,
    progress,
    metadata,
    trigger_config,
    eventRuntimeSelection,
  } = req.body || {};

  const obsoleteFieldsError = obsoleteObjectiveFieldsError(req.body);
  if (obsoleteFieldsError) {
    return res.status(400).json({ error: obsoleteFieldsError });
  }

  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  const VALID_STATUSES = ['draft', 'active', 'achieved', 'failed', 'paused'];
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  if (priority !== undefined && !Number.isInteger(priority)) {
    return res.status(400).json({ error: 'priority must be an integer' });
  }
  if (
    progress !== undefined &&
    (!Number.isInteger(progress) || progress < 0 || progress > 100)
  ) {
    return res
      .status(400)
      .json({ error: 'progress must be an integer between 0 and 100' });
  }

  const titleErr = lenError(title, MAX_LEN.title, 'title');
  if (titleErr) return res.status(400).json({ error: titleErr });
  const descErr = lenError(description, MAX_LEN.description, 'description');
  if (descErr) return res.status(400).json({ error: descErr });
  const runtimeError = validateRuntimeSelection(eventRuntimeSelection);
  if (runtimeError) return res.status(400).json({ error: runtimeError });
  if (
    metadata !== undefined &&
    JSON.stringify(metadata).length > MAX_LEN.description
  ) {
    return res.status(400).json({
      error: `metadata must be at most ${MAX_LEN.description} characters when serialized`,
    });
  }
  if (
    trigger_config !== undefined &&
    JSON.stringify(trigger_config).length > MAX_LEN.description
  ) {
    return res.status(400).json({
      error: `trigger_config must be at most ${MAX_LEN.description} characters when serialized`,
    });
  }

  const objGroup = getGroupByFolder(req.params.pid);
  const objective = await createObjective({
    project_id: req.params.pid,
    title,
    description: description || '',
    status: status || 'draft',
    priority: priority ?? 0,
    deadline: deadline ?? null,
    progress: progress ?? 0,
    metadata: metadata ?? null,
    trigger_config: trigger_config ?? null,
    eventRuntimeSelection: eventRuntimeSelection ?? null,
  });
  // Compute and persist the agent work_dir now that we have the objective ID
  objective.work_dir = objGroup
    ? objectiveWorkDirFor(objGroup, objective.id)
    : computeObjectiveWorkDir(req.params.pid, objective.id);
  await updateObjective(objective.id, { work_dir: objective.work_dir });

  // Await brain init so the dashboard folder + index.html exist before the UI navigates
  await initObjectiveFolder(
    req.params.pid,
    objective.id,
    objective,
    objGroup?.settings?.brainContainer,
    objGroup?.parentId,
    objGroup,
  );

  broadcast({
    type: 'objective_created',
    payload: { project_id: req.params.pid, objective },
  });
  publishEvent(
    resolveBrainUrl(objGroup ? resolveBrainContainer(objGroup) : undefined),
    {
      type: 'objective_created',
      project_id: req.params.pid,
      task_id: null,
      objective_id: objective.id,
      timestamp: new Date().toISOString(),
      data: {
        title: objective.title,
        status: objective.status,
        priority: objective.priority,
      },
    },
    objGroup,
  );
  res.status(201).json(objective);
}

router.post('/projects/:pid/objectives', createObjectiveHandler);

/**
 * GET /api/projects/:pid/objectives/:oid
 * Get a single objective.
 */
router.get('/projects/:pid/objectives/:oid', async (req, res) => {
  const objective = await getObjective(req.params.oid);
  if (!objective || objective.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Objective not found' });
  }
  const objDir = getObjectiveDir(req.params.pid, req.params.oid);
  const runStatsEntries = await readContainedJsonl(objDir, 'run-stats.jsonl');
  const [runStats, isAgentRunning] = await Promise.all([
    aggregateRunStats(objDir, req.params.pid, objective.id, runStatsEntries),
    detectAgentRunning(objDir, runStatsEntries),
  ]);
  const refreshed = await getObjective(objective.id);
  if (refreshed) Object.assign(objective, refreshed);
  (objective as any).runStats = runStats;
  (objective as any).isAgentRunning = isAgentRunning;
  res.json(objective);
});

/**
 * PUT /api/projects/:pid/objectives/:oid
 * Update an objective.
 */
async function updateObjectiveHandler(req: any, res: any) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'JSON body is required' });
  }
  const obsoleteFieldsError = obsoleteObjectiveFieldsError(body);
  if (obsoleteFieldsError) {
    return res.status(400).json({ error: obsoleteFieldsError });
  }

  const existing = await getObjective(req.params.oid);
  if (!existing || existing.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Objective not found' });
  }

  const allowed = [
    'title',
    'description',
    'status',
    'priority',
    'deadline',
    'progress',
    'metadata',
    'trigger_config',
    'eventRuntimeSelection',
    'cost_limit_usd',
  ] as const;
  const data: Record<string, unknown> = {};
  for (const key of allowed) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  const budgetPause = body.budget_pause;
  if (
    budgetPause !== undefined &&
    (data.status !== 'paused' ||
      typeof budgetPause !== 'object' ||
      budgetPause === null ||
      budgetPause.reason !== 'cost_limit_reached' ||
      typeof budgetPause.occurred_at !== 'string' ||
      budgetPause.occurred_at.length > MAX_LEN.short ||
      typeof budgetPause.total_cost_usd !== 'number' ||
      !Number.isFinite(budgetPause.total_cost_usd) ||
      typeof budgetPause.cost_limit_usd !== 'number' ||
      !Number.isFinite(budgetPause.cost_limit_usd))
  ) {
    return res.status(400).json({
      error:
        'budget_pause must describe a cost_limit_reached pause with finite costs and occurred_at',
    });
  }
  const runtimeError = validateRuntimeSelection(data.eventRuntimeSelection);
  if (runtimeError) return res.status(400).json({ error: runtimeError });

  const VALID_STATUSES = ['draft', 'active', 'achieved', 'failed', 'paused'];
  if (
    data.status !== undefined &&
    !VALID_STATUSES.includes(data.status as string)
  ) {
    return res
      .status(400)
      .json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  if (
    data.title !== undefined &&
    (typeof data.title !== 'string' || !data.title.trim())
  ) {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }
  if (data.priority !== undefined && !Number.isInteger(data.priority)) {
    return res.status(400).json({ error: 'priority must be an integer' });
  }
  if (
    data.progress !== undefined &&
    (!Number.isInteger(data.progress) ||
      (data.progress as number) < 0 ||
      (data.progress as number) > 100)
  ) {
    return res
      .status(400)
      .json({ error: 'progress must be an integer between 0 and 100' });
  }
  if (
    data.cost_limit_usd !== undefined &&
    data.cost_limit_usd !== null &&
    (typeof data.cost_limit_usd !== 'number' ||
      !Number.isFinite(data.cost_limit_usd) ||
      data.cost_limit_usd < 0)
  ) {
    return res.status(400).json({
      error: 'cost_limit_usd must be a non-negative finite number or null',
    });
  }

  let patchErr: string | null;
  if ((patchErr = lenError(data.title, MAX_LEN.title, 'title')))
    return res.status(400).json({ error: patchErr });
  if (
    (patchErr = lenError(data.description, MAX_LEN.description, 'description'))
  )
    return res.status(400).json({ error: patchErr });
  if (
    data.metadata !== undefined &&
    JSON.stringify(data.metadata).length > MAX_LEN.description
  ) {
    return res.status(400).json({
      error: `metadata must be at most ${MAX_LEN.description} characters when serialized`,
    });
  }
  if (
    data.trigger_config !== undefined &&
    JSON.stringify(data.trigger_config).length > MAX_LEN.description
  ) {
    return res.status(400).json({
      error: `trigger_config must be at most ${MAX_LEN.description} characters when serialized`,
    });
  }

  const { cost_limit_usd: costLimitUsd, ...objectiveData } = data;
  if (costLimitUsd !== undefined) {
    await updateObjectiveCostLimit(
      req.params.oid,
      costLimitUsd as number | null,
    );
  }
  let updated = await updateObjective(req.params.oid, objectiveData);
  let activationError: string | null = null;
  if (updated && (costLimitUsd !== undefined || data.status === 'active')) {
    const runStats = await aggregateRunStats(
      getObjectiveDir(req.params.pid, updated.id),
      req.params.pid,
      updated.id,
    );
    updated = await getObjective(updated.id);
    if (data.status === 'active' && updated?.status !== 'active') {
      activationError = activationRefusalMessage(
        updated,
        runStats?.totalCostUsd ?? 0,
      );
    }
  }
  if (updated) {
    // A budget pause must also stop objective-owned cronjobs immediately.
    // Waiting for their next scheduler sweep leaves a window in which a due
    // cronjob can still create another task after the budget is exhausted.
    if (budgetPause !== undefined) {
      await pauseCronjobsByObjective(updated.id);
    }
    await refreshObjectiveContext(req.params.pid, updated);
    if (budgetPause !== undefined) {
      const totalCostUsd = budgetPause.total_cost_usd as number;
      const costLimitUsd = budgetPause.cost_limit_usd as number;
      await notifyProjectOwner(req.params.pid, {
        summary: `Objective paused: ${updated.title}`,
        content:
          `"${updated.title}" was automatically paused after reaching its ` +
          `$${costLimitUsd.toFixed(2)} budget. Total recorded cost: ` +
          `$${totalCostUsd.toFixed(2)}.`,
        source_id: `objective-budget:${req.params.oid}:${budgetPause.occurred_at}`,
      });
    }
  }
  const updGroup = getGroupByFolder(req.params.pid);
  const updatedEvent = {
    type: 'objective_updated',
    project_id: req.params.pid,
    task_id: null,
    objective_id: req.params.oid,
    timestamp: new Date().toISOString(),
    data: {
      changes: {
        ...data,
        ...(data.status !== undefined && updated
          ? { status: updated.status }
          : {}),
      },
    },
  };
  const stateAffectingUpdate =
    data.status !== undefined ||
    data.eventRuntimeSelection !== undefined ||
    costLimitUsd !== undefined;
  if (stateAffectingUpdate) {
    await publishObjectiveStateEvent(
      resolveBrainUrl(updGroup ? resolveBrainContainer(updGroup) : undefined),
      updatedEvent,
      updGroup,
    );
  } else {
    publishEvent(
      resolveBrainUrl(updGroup ? resolveBrainContainer(updGroup) : undefined),
      updatedEvent,
      updGroup,
    );
  }
  logger.info(
    { objective_id: req.params.oid, project: req.params.pid },
    'Objective updated',
  );
  broadcast({
    type: 'objective_updated',
    payload: { project_id: req.params.pid, objective: updated },
  });
  if (existing.status !== 'active' && updated?.status === 'active') {
    await drainQueuesForObjective(req.params.oid);
  }
  if (activationError) {
    return res.status(409).json({ error: activationError });
  }
  res.json(updated);
}

router.put('/projects/:pid/objectives/:oid', updateObjectiveHandler);

/**
 * Whether the caller may write objectives in a project: owner/editor members,
 * admins (but not into another user's personal main), or an agent token with
 * `objectives:write` for it. Viewers and chat-only users are refused.
 */
async function canWriteObjectivesIn(
  req: any,
  folder: string,
): Promise<boolean> {
  if (req.authUser) {
    return canAccessProject(req.authUser, folder, { min: 'editor' });
  }
  return hasPermission(req.tokenScope?.permissions, folder, 'objectives:write');
}

/**
 * POST /api/projects/:pid/objectives/:oid/move
 * Move an objective, with its memories, folder and conversations, to another
 * project while keeping its ID. Calling it again for an objective already in the target
 * project completes the vector-store, folder and conversation steps that did
 * not finish, and moves chats an earlier move left in another project.
 */
router.post('/projects/:pid/objectives/:oid/move', async (req: any, res) => {
  const targetProject =
    typeof req.body?.target_project === 'string'
      ? req.body.target_project.trim()
      : '';
  if (!targetProject) {
    return res.status(400).json({ error: 'target_project is required' });
  }
  if (
    !(await canWriteObjectivesIn(req, req.params.pid)) ||
    !(await canWriteObjectivesIn(req, targetProject))
  ) {
    return res.status(403).json({
      error: 'Moving an objective needs write access to both projects',
    });
  }
  try {
    res.json(
      await moveObjective({
        objectiveId: req.params.oid,
        sourceProject: req.params.pid,
        targetProject,
        canWriteProject: (project) => canWriteObjectivesIn(req, project),
      }),
    );
  } catch (err) {
    if (err instanceof ObjectiveMoveError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error(
      { err, objective_id: req.params.oid },
      'Objective move failed',
    );
    res.status(500).json({ error: 'Failed to move objective' });
  }
});

/**
 * DELETE /api/projects/:pid/objectives/:oid
 * Delete an objective and clean up.
 */
router.delete('/projects/:pid/objectives/:oid', async (req, res) => {
  const existing = await getObjective(req.params.oid);
  if (!existing || existing.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Objective not found' });
  }
  archiveObjectiveFolders(existing);
  try {
    await deleteObjective(req.params.oid);
    forgetObjectiveRunStats(req.params.oid);
  } catch (err) {
    logger.error(
      { err, objective_id: req.params.oid, project: req.params.pid },
      'Objective delete failed',
    );
    return res.status(500).json({ error: 'Failed to delete objective' });
  }
  logger.info(
    { objective_id: req.params.oid, project: req.params.pid },
    'Objective deleted',
  );
  broadcast({
    type: 'objective_deleted',
    payload: { project_id: req.params.pid, objective_id: req.params.oid },
  });
  res.json({ ok: true });
});

/**
 * GET /api/projects/:pid/objectives/:oid/dashboard/*
 * Proxy requests to a per-objective dynamic dashboard app managed by carapa-brain.
 * Falls back to serving static files from the objective's dashboard/ folder when
 * no brain is configured, brain is unreachable, or objective has no dynamic app.
 */
router.post(
  '/projects/:pid/objectives/:oid/dashboard-ticket',
  enforceProjectAccess,
  async (req: any, res) => {
    const objective = await getObjective(req.params.oid);
    if (!objective || objective.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Objective not found' });
    }
    // A path token is bound to the issuing user's current access, so only a
    // signed-in user receives one.
    return res.json({
      ticket: issueDashboardTicket(req.params.pid, req.params.oid),
      pathToken: req.authUser?.id
        ? issueDashboardPathToken(
            req.params.pid,
            req.params.oid,
            req.authUser.id,
          )
        : undefined,
    });
  },
);

/**
 * True when a decoded dashboard path segment stays inside its directory, both
 * as received and after one further percent-decode.
 */
function isSafeDashboardSegment(segment: string): boolean {
  const isUnsafe = (value: string) =>
    value === '.' || value === '..' || /[/\\\0?#]/.test(value);
  if (isUnsafe(segment)) return false;
  try {
    return !isUnsafe(decodeURIComponent(segment));
  } catch {
    return false;
  }
}

router.get(
  '/projects/:pid/objectives/:oid/dashboard/*path',
  async (req, res) => {
    applyDashboardSecurityHeaders(res);
    const objective = await getObjective(req.params.oid);
    if (!objective || objective.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Objective not found' });
    }

    // Native WebViews cannot attach Authorization headers to iframe navigations.
    // Persist the short-lived dashboard ticket in a narrowly scoped cookie so
    // relative CSS/JS/image requests from the dashboard are authenticated too.
    const dashboardTicketValue =
      typeof req.query['ticket'] === 'string' ? req.query['ticket'] : null;
    if (
      dashboardTicketValue &&
      verifyDashboardTicket(
        dashboardTicketValue,
        req.params.pid,
        req.params.oid,
      )
    ) {
      res.append(
        'Set-Cookie',
        `carapa_dashboard_ticket=${dashboardTicketValue}; Path=/api/projects/${req.params.pid}/objectives/${req.params.oid}/dashboard/; HttpOnly; SameSite=None; Secure; Max-Age=60`,
      );
    }

    // Express wildcard param is an array. Drop a leading `t/<token>` pair before
    // anything else uses the path: the token authenticates this request only and
    // must never reach the brain dashboard app or the filesystem lookup.
    const rawParts = (req.params as Record<string, string | string[]>)['path'];
    const split = splitDashboardPathToken(
      Array.isArray(rawParts) ? rawParts : [rawParts || ''],
    );
    if (
      split.token !== null &&
      !(await verifyDashboardPathToken(
        split.token,
        req.params.pid,
        req.params.oid,
        userCanReadProjectDashboard,
      ))
    ) {
      return res.status(401).json({ error: 'Invalid dashboard token' });
    }
    const parts = split.segments;
    const subPath = parts.join('/');

    // Express decodes each segment once. Reject anything that could escape
    // /dashboard/<oid>/ once the brain URL is normalised, including a segment
    // that is still percent-encoded (%252e%252e) and decodes to `..` or a
    // separator on the next hop. Malformed percent-encoding is a 400, not a 500.
    if (!parts.every(isSafeDashboardSegment)) {
      return res.status(400).json({ error: 'Invalid dashboard path' });
    }

    // ── Try dynamic dashboard proxy via carapa-brain ──────────────────────────
    const group = getGroupByFolder(req.params.pid);
    if (!group) {
      logger.warn({ pid: req.params.pid }, 'Dashboard proxy: group not found');
    }
    if (group) {
      const brainContainer = resolveBrainContainer(group);
      if (!brainContainer) {
        logger.warn(
          { pid: req.params.pid },
          'Dashboard proxy: no brainContainer configured',
        );
      } else {
        const authToken = resolveBrainAuthToken(group);
        const query = new URL(req.url, 'http://localhost').searchParams;
        query.delete('ticket');
        const qs = query.toString() ? `?${query.toString()}` : '';
        const encodedPath = parts.map(encodeURIComponent).join('/');
        const pathSuffix = `/dashboard/${req.params.oid}/${encodedPath}${qs}`;
        const headers: Record<string, string> = {};
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        try {
          // fetchBrain handles URL resolution + stale-port recovery: refreshes
          // the port cache on cache miss, and on a transport-level failure
          // (brain container restarted onto a new dynamic port) it invalidates,
          // refreshes, and retries once before giving up.
          const resp = await fetchBrain(
            brainContainer,
            pathSuffix,
            { headers, signal: AbortSignal.timeout(10000) },
            resolveBrainAuthTokenOwner(group, req.params.pid),
          );
          if (!resp) {
            logger.warn(
              { pid: req.params.pid, brainContainer },
              'Dashboard proxy: brain not discoverable (port cache empty after refresh)',
            );
          } else if (resp.ok) {
            logger.info(
              {
                objective_id: req.params.oid,
                brainContainer,
                status: resp.status,
              },
              'Dashboard proxy: forwarded request via brain',
            );
            res.status(resp.status);
            // Upstream must not set cookies on the board origin or override
            // the sandbox CSP.
            const dropped = new Set([
              'transfer-encoding',
              'set-cookie',
              'content-security-policy',
            ]);
            resp.headers.forEach((v, k) => {
              if (!dropped.has(k.toLowerCase())) res.setHeader(k, v);
            });
            applyDashboardSecurityHeaders(res);
            const body = await resp.arrayBuffer();
            return res.end(Buffer.from(body));
          } else {
            // Non-OK (404 = no dynamic app) — fall through to static
            logger.warn(
              {
                objective_id: req.params.oid,
                brainContainer,
                status: resp.status,
              },
              'Dashboard proxy: brain returned non-OK',
            );
          }
        } catch (err) {
          logger.warn(
            { err, objective_id: req.params.oid, brainContainer },
            'Dashboard proxy: fetch to brain failed',
          );
        }
      }
    }
    logger.warn(
      { pid: req.params.pid, oid: req.params.oid, subPath },
      'Dashboard proxy: falling back to static file serving',
    );

    // ── Static fallback ───────────────────────────────────────────────────────
    // A missing dashboard document (brain unreachable at creation, no brain
    // container, or index.html removed) renders an empty-state page instead of
    // raw JSON inside the iframe. Other missing assets stay JSON 404s.
    const isIndexRequest = subPath === 'index.html';
    const fileNotFound = () =>
      isIndexRequest
        ? res
            .status(404)
            .set({
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            .send(EMPTY_DASHBOARD_HTML)
        : res.status(404).json({ error: 'File not found' });

    // Every directory is pinned with O_NOFOLLOW and the file is sent through
    // its descriptor, so swapping the dashboard dir or an asset for a link
    // after the open cannot redirect the response.
    const rel = path.posix.normalize(subPath).replace(/\/+$/, '');
    if (rel === '' || rel === '.') return fileNotFound();

    let opened: Awaited<ReturnType<typeof openFileAt>> = null;
    try {
      let dashboardDir: PinnedDir | null = null;
      try {
        dashboardDir = await openGroupDir(
          req.params.pid,
          `objectives/${req.params.oid}/dashboard`,
        );
      } catch (err) {
        // A dashboard dir replaced by a link or file is not a dashboard.
        if (!(err instanceof GroupFsError) || err.code === 'unsupported') {
          throw err;
        }
        return fileNotFound();
      }
      if (!dashboardDir) return fileNotFound();
      try {
        opened = await openFileAt(dashboardDir, rel);
      } finally {
        await dashboardDir.close();
      }
    } catch (err) {
      if (err instanceof GroupFsError && err.code === 'unsupported') {
        logger.warn({ err, pid: req.params.pid }, 'Dashboard file unsupported');
        return res.status(500).json({ error: 'Failed to read file' });
      }
      if (
        err instanceof GroupFsError &&
        (err.code === 'invalid_path' || err.code === 'symlink')
      ) {
        return res.status(400).json({ error: 'Invalid path' });
      }
      if (err instanceof GroupFsError) return fileNotFound();
      throw err;
    }
    if (!opened) return fileNotFound();

    // The descriptor link has no extension, so name the type from the logical
    // file name with the web-asset database (scripts stay executable).
    res.type(lookupMime(rel) || 'application/octet-stream');
    sendPinnedFile(res, opened);
  },
);

/**
 * POST /api/projects/:pid/objectives/:oid/dashboard-refresh
 * Trigger a dashboard iframe reload for a specific objective.
 * Called by carapa-brain processor after auto-generating dashboard HTML.
 */
router.post(
  '/projects/:pid/objectives/:oid/dashboard-refresh',
  async (req, res) => {
    const objective = await getObjective(req.params.oid);
    if (!objective || objective.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Objective not found' });
    }
    broadcast({
      type: 'objective_dashboard_updated',
      payload: { project_id: req.params.pid, objective_id: req.params.oid },
    });
    logger.info(
      { objective_id: req.params.oid, project_id: req.params.pid },
      'Dashboard refresh triggered via REST',
    );
    res.json({ ok: true });
  },
);

/**
 * Transcripts (task/brain prompts and runs) are readable only with explicit
 * project membership; implicit chat-only users never qualify. Admins keep
 * their ordinary-project bypass but not a foreign user's personal main group.
 * The admin denial applies regardless of `req.tokenScope`: the auth middleware
 * sets a scope for every logged-in user, so it cannot gate this rule.
 */
async function canReadGroupTranscripts(
  req: any,
  group: { folder: string; is_main?: boolean; user_id?: string | null },
): Promise<boolean> {
  return userHasExplicitGroupAccess(req, group.folder);
}

/**
 * GET /api/session-transcripts/:id
 * Serves a session or task transcript for the dashboard popup modal: a Run V1
 * pair from session-transcripts/ (brain runs), else the aggregated
 * transcripts/<id>.jsonl (task runs).
 */
router.get('/session-transcripts/:id/v1', async (req: any, res) => {
  const id = req.params.id;
  if (!/^(run|task)-[\w-]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid transcript ID' });
  }
  for (const group of Object.values(registeredGroups)) {
    if (!(await canReadGroupTranscripts(req, group))) continue;
    const directory = path.join(
      getGroupDir(group.folder),
      'session-transcripts',
    );
    const paths = archivedCarapaRunV1Paths(directory, id);
    if (!fs.existsSync(paths.events) && !fs.existsSync(paths.manifest))
      continue;
    try {
      const document = readCarapaRunV1Pair(paths, {
        requireTerminal: true,
        containedIn: getGroupDir(group.folder),
      });
      if (!document) continue;
      return res.json({
        format: 'carapa-run',
        version: 1,
        manifest: document.manifest,
        events: document.events,
        projection: {
          entries: formatTranscriptEntries(projectCarapaRunV1Entries(document)),
          summary: summarizeCarapaRunV1(document),
        },
      });
    } catch (error) {
      logger.warn(
        { err: String(error), id, group: group.folder },
        'Invalid V1 session transcript',
      );
      return res.status(422).json({
        error: 'Invalid V1 transcript',
        detail: 'Transcript could not be read',
      });
    }
  }
  return res.status(404).json({ error: 'V1 transcript not found' });
});

router.get('/session-transcripts/:id', async (req: any, res) => {
  const id = req.params.id;

  // Sanitize: only allow run-* or task-* IDs (alphanumeric, dashes, underscores)
  if (!/^(run|task)-[\w-]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid transcript ID' });
  }

  // Search registered groups, but skip ones the caller has no access to so the
  // endpoint can't be used to read transcripts from other users' projects.
  for (const group of Object.values(registeredGroups)) {
    if (!(await canReadGroupTranscripts(req, group))) continue;
    const groupDir = getGroupDir(group.folder);

    // Try session-transcripts/ first (brain agent runs, Run V1 pair)
    const v1Paths = archivedCarapaRunV1Paths(
      path.join(groupDir, 'session-transcripts'),
      id,
    );
    if (fs.existsSync(v1Paths.events) || fs.existsSync(v1Paths.manifest)) {
      try {
        const document = readCarapaRunV1Pair(v1Paths, {
          requireTerminal: true,
          containedIn: groupDir,
        });
        if (!document) throw new Error('V1 transcript pair disappeared');
        const prompt = await readContainedText(
          groupDir,
          path.join(groupDir, 'session-transcripts', `${id}.prompt.txt`),
        );
        return res.json({
          id,
          source: 'session',
          prompt,
          entries: formatTranscriptEntries(projectCarapaRunV1Entries(document)),
          format: 'carapa-run',
          version: 1,
        });
      } catch (error) {
        logger.warn(
          { err: String(error), id, group: group.folder },
          'Invalid V1 session transcript',
        );
        return res.status(422).json({
          error: 'Invalid V1 transcript',
          detail: 'Transcript could not be read',
        });
      }
    }
    // Try transcripts/ (task execution runs)
    const rawTask = await readContainedText(
      groupDir,
      path.join(groupDir, 'transcripts', `${id}.jsonl`),
    );
    if (rawTask !== null) {
      return res.json({
        id,
        source: 'task',
        prompt: null,
        entries: formatTranscriptEntries(parseJsonl(rawTask)),
      });
    }
  }

  return res.status(404).json({ error: 'Transcript not found' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Objective Artifact Endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/projects/:pid/objectives/:oid/events
 * Returns events from events.jsonl with pagination and optional filtering.
 */
router.get('/projects/:pid/objectives/:oid/events', async (req, res) => {
  const objective = await getObjective(req.params.oid);
  if (!objective || objective.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Objective not found' });
  }
  const typeFilter = req.query.type;
  const search = req.query.search;
  if (typeFilter !== undefined && typeof typeFilter !== 'string') {
    return res.status(400).json({ error: 'type must be a single string' });
  }
  if (search !== undefined && typeof search !== 'string') {
    return res.status(400).json({ error: 'search must be a single string' });
  }
  const dir = getObjectiveDir(req.params.pid, req.params.oid);
  const [rawEvents, queuedGroups] = await Promise.all([
    readContainedJsonl(dir, 'events.jsonl'),
    readObjectiveQueuedEvents(req.params.pid, req.params.oid),
  ]);

  // The type catalog only depends on the raw event records. Avoid reading and
  // annotating the auxiliary evaluation/run-stat files for this lightweight
  // request.
  if (req.query.typesOnly === 'true') {
    const types = [
      ...new Set(
        [...rawEvents, ...queuedGroups.flatMap((group) => group.events)].map(
          (e: any) => String(e.type ?? ''),
        ),
      ),
    ].sort();
    return res.json({ types });
  }

  const [evals, runStats, objectiveRunActive] = await Promise.all([
    readContainedJsonl(dir, 'evals.jsonl'),
    readContainedJsonl(dir, 'run-stats.jsonl'),
    resolveObjectiveRunActive(req.params.pid, req.params.oid),
  ]);
  const allEvents = annotateObjectiveEventRunOutcomes(
    rawEvents,
    evals,
    runStats,
    Date.now(),
    req.params.oid,
    objectiveRunActive,
  );

  // Queued (not yet dequeued) events come after everything already logged.
  let filtered = withObjectiveEventGroupIds([
    ...groupObjectiveEvents(allEvents),
    ...queuedGroups,
  ]);

  // Optional type filter
  if (typeFilter) {
    filtered = filtered.filter((group) =>
      group.events.some((event) => event.type === typeFilter),
    );
  }

  // Optional text search (searches serialized payload)
  if (search) {
    const lower = search.toLowerCase();
    filtered = filtered.filter((group) =>
      JSON.stringify(group).toLowerCase().includes(lower),
    );
  }

  // Reverse chronological
  filtered.reverse();

  const total = filtered.length;
  const { limit, offset } = parseObjectivePagination(req.query, 50, 200);

  res.json({
    groups: filtered.slice(offset, offset + limit),
    total,
  });
});

/**
 * GET /api/projects/:pid/objectives/:oid/runs/:runId/live
 * Transcript of a brain run that is still in progress, read from the brain's
 * run directory (its Run V1 event file, output.v1.jsonl, grows while the agent
 * works). The run must be an invocation of this objective. 404 once the run
 * directory is gone; the saved session transcript takes over then.
 */
router.get(
  '/projects/:pid/objectives/:oid/runs/:runId/live',
  async (req, res) => {
    const { pid, oid, runId } = req.params;
    if (!/^run-[\w-]+$/.test(runId)) {
      return res.status(400).json({ error: 'Invalid run ID' });
    }
    const objective = await getObjective(oid);
    if (!objective || objective.project_id !== pid) {
      return res.status(404).json({ error: 'Objective not found' });
    }
    const events = await readContainedJsonl(
      getObjectiveDir(pid, oid),
      'events.jsonl',
    );
    const invoked = events.some(
      (event) =>
        event.type === 'agent_invoked' &&
        (event.payload as Record<string, unknown> | undefined)?.run_id ===
          runId,
    );
    const group = getGroupByFolder(pid);
    const brainContainer = group ? resolveBrainContainer(group) : undefined;
    const runDir =
      invoked && brainContainer ? liveBrainRunDir(brainContainer, runId) : null;
    if (!runDir) return res.status(404).json({ error: 'Run not found' });
    const v1Paths = carapaRunV1Paths(runDir);
    const readRunFile = (file: string) =>
      fsp.readFile(file, 'utf-8').catch(() => null);
    const [eventText, manifestText, prompt] = await Promise.all([
      readRunFile(v1Paths.events),
      readRunFile(v1Paths.manifest),
      readRunFile(path.join(runDir, 'prompt.txt')),
    ]);
    if (eventText === null || manifestText === null) {
      return res.status(404).json({ error: 'Live output not available' });
    }
    let manifest: ReturnType<typeof parseCarapaRunV1Manifest>;
    try {
      manifest = parseCarapaRunV1Manifest(manifestText);
    } catch {
      // The agent may still be writing the manifest.
      return res.status(404).json({ error: 'Live output not available' });
    }
    // Only complete lines: the agent may be writing the last one.
    const runEvents = parseCarapaRunV1EventText(
      eventText.slice(0, eventText.lastIndexOf('\n') + 1),
    );
    return res.json({
      id: runId,
      source: 'live',
      prompt,
      entries: formatTranscriptEntries(
        projectCarapaRunV1Entries({ manifest, events: runEvents }),
      ),
    });
  },
);

/**
 * GET /api/projects/:pid/objectives/:oid/runs
 * Returns a joined view of run data: merges run-stats.jsonl, evals.jsonl,
 * and checks for session transcript and reflection existence.
 */
router.get('/projects/:pid/objectives/:oid/runs', async (req, res) => {
  const objective = await getObjective(req.params.oid);
  if (!objective || objective.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Objective not found' });
  }
  const dir = getObjectiveDir(req.params.pid, req.params.oid);
  const groupDir = getGroupDir(req.params.pid);

  // Read run stats
  const [runStats, evals, llmSteps, rawEvents, objectiveRunActive] =
    await Promise.all([
      readContainedJsonl(dir, 'run-stats.jsonl'),
      readContainedJsonl(dir, 'evals.jsonl'),
      readContainedJsonl(dir, 'llm-steps.jsonl'),
      readContainedJsonl(dir, 'events.jsonl'),
      resolveObjectiveRunActive(req.params.pid, req.params.oid),
    ]);
  const current = currentObjectiveRun(
    annotateObjectiveEventRunOutcomes(
      rawEvents,
      evals,
      runStats,
      Date.now(),
      req.params.oid,
      objectiveRunActive,
    ),
    objectiveRunActive,
  );
  const evalsByRun = new Map<string, Record<string, unknown>>();
  for (const e of evals) {
    if (e.runId) evalsByRun.set(String(e.runId), e);
  }
  const llmStepsByRun = new Map<string, Record<string, unknown>[]>();
  for (const step of llmSteps) {
    const parentRunId = String(step.parentRunId ?? '');
    if (!parentRunId) continue;
    const entries = llmStepsByRun.get(parentRunId) ?? [];
    entries.push(step);
    llmStepsByRun.set(parentRunId, entries);
  }

  // The run in progress has no run-stats line yet; it is listed first. Only
  // the run-stats rows inside the requested page get per-run filesystem work.
  const { limit, offset } = parseObjectivePagination(req.query, 50, 200);
  const currentCount = current ? 1 : 0;
  const total = runStats.length + currentCount;
  const pageRunStats = runStats
    .reverse()
    .slice(
      Math.max(0, offset - currentCount),
      Math.max(0, offset + limit - currentCount),
    );

  // Pinned once for every run's reflection probe (closed when the runs are
  // built); null when missing or refused.
  const objectiveHandle = await openObjectiveDir(dir).catch(warnUnsupported);

  // Join and build run entries (reverse chronological)
  const runs = await Promise.all(
    pageRunStats.map(async (rs) => {
      const runId = String(rs.runId ?? '');
      const ev = evalsByRun.get(runId);
      const reportedCost =
        typeof rs.costUsd === 'number' && Number.isFinite(rs.costUsd)
          ? rs.costUsd
          : null;
      const estimatedCost =
        reportedCost == null
          ? calculateModelCostUsd(
              typeof rs.model === 'string' ? rs.model : null,
              {
                inputTokens:
                  typeof rs.inputTokens === 'number' ? rs.inputTokens : 0,
                cachedInputTokens:
                  typeof rs.cacheReadTokens === 'number'
                    ? rs.cacheReadTokens
                    : 0,
                cacheWriteTokens:
                  typeof rs.cacheCreationTokens === 'number'
                    ? rs.cacheCreationTokens
                    : 0,
                outputTokens:
                  typeof rs.outputTokens === 'number' ? rs.outputTokens : 0,
              },
            )
          : null;

      // Check for linked files
      const transcriptV1Paths = archivedCarapaRunV1Paths(
        path.join(groupDir, 'session-transcripts'),
        runId,
      );
      // runId comes from the agent-written run-stats.jsonl: only a plain file
      // name is ever turned into a path.
      const linkable = isLinkableRunId(runId);
      const reflectionRel = `.agent/reflections/${runId}.md`;

      const [hasTranscript, hasReflection] = await Promise.all([
        Promise.resolve(
          linkable &&
            fs.existsSync(transcriptV1Paths.events) &&
            fs.existsSync(transcriptV1Paths.manifest),
        ),
        linkable && objectiveHandle
          ? openFileAt(objectiveHandle, reflectionRel, {
              followInternalLinks: true,
            }).then(
              async (opened) => {
                await opened?.handle.close().catch(() => {});
                return opened !== null;
              },
              () => false,
            )
          : false,
      ]);

      const runLLMSteps: Array<
        Record<string, unknown> & { costUsd: number | null }
      > = (llmStepsByRun.get(runId) ?? []).map((step) => ({
        ...step,
        costUsd: calculateModelCostUsd(
          typeof step.model === 'string' ? step.model : null,
          {
            inputTokens:
              typeof step.inputTokens === 'number' ? step.inputTokens : 0,
            outputTokens:
              typeof step.outputTokens === 'number' ? step.outputTokens : 0,
          },
        ),
      }));
      if (
        hasReflection &&
        runLLMSteps.some(
          (step) =>
            step.kind === 'reflection' && typeof step.output !== 'string',
        )
      ) {
        const persistedReflection = objectiveHandle
          ? await readFileAt(objectiveHandle, reflectionRel, {
              maxBytes: 1024 * 1024,
              followInternalLinks: true,
            }).then(
              (read) => read?.data.toString('utf8') ?? null,
              () => null,
            )
          : null;
        if (persistedReflection) {
          for (const step of runLLMSteps) {
            if (step.kind === 'reflection' && typeof step.output !== 'string') {
              step.output = persistedReflection;
            }
          }
        }
      }

      return {
        runId,
        timestamp: rs.timestamp ?? null,
        triggerType: rs.triggerType ?? null,
        duration_ms: rs.durationMs ?? rs.duration_ms ?? null,
        costUsd: reportedCost ?? estimatedCost,
        numTurns: rs.numTurns ?? null,
        numSteps: rs.numSteps ?? null,
        inputTokens: rs.inputTokens ?? 0,
        outputTokens: rs.outputTokens ?? 0,
        cacheReadTokens: rs.cacheReadTokens ?? 0,
        cacheCreationTokens:
          typeof rs.cacheCreationTokens === 'number'
            ? rs.cacheCreationTokens
            : 0,
        model: typeof rs.model === 'string' && rs.model ? rs.model : null,
        exitCode: rs.exitCode ?? null,
        rationale: ev ? (ev.rationale ?? null) : null,
        hasTranscript,
        hasReflection,
        llmSteps: runLLMSteps,
      };
    }),
  ).finally(() => objectiveHandle?.close());

  const pageRuns =
    current && offset === 0
      ? [
          {
            runId: current.runId,
            timestamp: current.timestamp,
            triggerType: current.triggerType,
            duration_ms: Math.max(
              0,
              Date.now() - Date.parse(current.timestamp),
            ),
            costUsd: null,
            numTurns: null,
            numSteps: null,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            model: null,
            exitCode: null,
            rationale: null,
            hasTranscript: true,
            hasReflection: false,
            llmSteps: (llmStepsByRun.get(current.runId) ?? []).map((step) => ({
              ...step,
              costUsd: null,
            })),
            running: true,
          },
          ...runs,
        ]
      : runs;

  res.json({ runs: pageRuns, total });
});

/**
 * GET /api/projects/:pid/objectives/:oid/reports
 * Lists report files with content preview.
 */
router.get('/projects/:pid/objectives/:oid/reports', async (req, res) => {
  const objective = await getObjective(req.params.oid);
  if (!objective || objective.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Objective not found' });
  }
  const dir = getObjectiveDir(req.params.pid, req.params.oid);
  const objectiveHandle = await openObjectiveDir(dir).catch(warnUnsupported);
  if (!objectiveHandle) return res.json({ reports: [], total: 0 });

  try {
    // Entries that are links leaving the objective folder, or are not regular
    // files, are dropped: no size, no preview of the target.
    const names = (
      (await readdirAt(objectiveHandle, 'reports').catch(warnUnsupported)) ?? []
    )
      .filter(
        (f) => f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.json'),
      )
      .sort()
      .reverse(); // newest first
    const entries = (
      await Promise.all(
        names.map(async (filename) => {
          const opened = await openContainedFile(
            objectiveHandle,
            `reports/${filename}`,
          );
          await opened?.handle.close().catch(() => {});
          return opened ? filename : null;
        }),
      )
    ).filter((f): f is string => f !== null);

    const total = entries.length;
    const { limit, offset } = parseObjectivePagination(req.query, 20, 100);

    const reports = (
      await Promise.all(
        entries.slice(offset, offset + limit).map(async (filename) => {
          const opened = await openContainedFile(
            objectiveHandle,
            `reports/${filename}`,
          );
          if (!opened) return null;
          try {
            const preview = await readPreview(opened);
            // Extract timestamp from filename
            const tsMatch = filename.match(/(\d{4}-\d{2}-\d{2}T[\d:.-]+Z?)/);
            return {
              filename,
              timestamp: tsMatch ? tsMatch[1] : null,
              sizeBytes: opened.stat.size,
              preview,
            };
          } finally {
            await opened.handle.close().catch(() => {});
          }
        }),
      )
    ).filter((r) => r !== null);

    res.json({ reports, total });
  } finally {
    await objectiveHandle.close();
  }
});

/**
 * GET /api/projects/:pid/objectives/:oid/reports/:filename
 * Returns full content of a single report file.
 */
router.get(
  '/projects/:pid/objectives/:oid/reports/:filename',
  async (req, res) => {
    const objective = await getObjective(req.params.oid);
    if (!objective || objective.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Objective not found' });
    }
    const filename = req.params.filename;
    // Sanitize: prevent path traversal
    if (filename.includes('/') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const content = await readObjectiveFile(
      res,
      getObjectiveDir(req.params.pid, req.params.oid),
      `reports/${filename}`,
      'Report not found',
    );
    if (content !== null) res.json({ filename, content });
  },
);

const BROWSABLE_FOLDERS = ['rules', 'reflections', 'prompts'] as const;
type BrowsableFolder = (typeof BROWSABLE_FOLDERS)[number];

/**
 * GET /api/projects/:pid/objectives/:oid/files
 * Browse objective files: rules, reflections, prompts.
 * Without ?folder: returns list of browsable folder names.
 * With ?folder=rules: returns files in that folder.
 */
router.get('/projects/:pid/objectives/:oid/files', async (req, res) => {
  const objective = await getObjective(req.params.oid);
  if (!objective || objective.project_id !== req.params.pid) {
    return res.status(404).json({ error: 'Objective not found' });
  }
  const dir = getObjectiveDir(req.params.pid, req.params.oid);
  const folder = req.query.folder as string | undefined;

  if (!folder) {
    return res.json({ folders: [...BROWSABLE_FOLDERS] });
  }

  if (!BROWSABLE_FOLDERS.includes(folder as BrowsableFolder)) {
    return res.status(400).json({
      error: `Invalid folder. Allowed: ${BROWSABLE_FOLDERS.join(', ')}`,
    });
  }

  const objectiveHandle = await openObjectiveDir(dir).catch(warnUnsupported);
  if (!objectiveHandle) return res.json({ folder, files: [] });
  try {
    const entries =
      (await readdirAt(objectiveHandle, `.agent/${folder}`, {
        withFileTypes: true,
      }).catch(warnUnsupported)) ?? [];
    const files = (
      await Promise.all(
        entries
          .filter((e) => e.isFile() || e.isSymbolicLink())
          .map(async (e) => {
            const opened = await openContainedFile(
              objectiveHandle,
              `.agent/${folder}/${e.name}`,
            );
            if (!opened) return null;
            await opened.handle.close().catch(() => {});
            return { filename: e.name, sizeBytes: opened.stat.size };
          }),
      )
    ).filter((f) => f !== null);
    files.sort((a, b) => a.filename.localeCompare(b.filename));

    res.json({ folder, files });
  } finally {
    await objectiveHandle.close();
  }
});

/**
 * GET /api/projects/:pid/objectives/:oid/files/:folder/:filename
 * Returns full content of a single file from rules/reflections/prompts.
 */
router.get(
  '/projects/:pid/objectives/:oid/files/:folder/:filename',
  async (req, res) => {
    const objective = await getObjective(req.params.oid);
    if (!objective || objective.project_id !== req.params.pid) {
      return res.status(404).json({ error: 'Objective not found' });
    }
    const { folder, filename } = req.params;

    if (!BROWSABLE_FOLDERS.includes(folder as BrowsableFolder)) {
      return res.status(400).json({ error: 'Invalid folder' });
    }
    if (filename.includes('/') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const content = await readObjectiveFile(
      res,
      getObjectiveDir(req.params.pid, req.params.oid),
      `.agent/${folder}/${filename}`,
      'File not found',
    );
    if (content !== null) res.json({ folder, filename, content });
  },
);

export default router;
