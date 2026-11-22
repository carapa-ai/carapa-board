import type { Dirent } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getGroupDir } from '../../group-dir.js';
import {
  GroupFsError,
  readdirGroupPathSync,
  removeGroupPathSync,
} from '../../lib/group-fs.js';
import {
  getRuntimeCatalog,
  isDirectRuntime,
  resolveRuntimeSelection,
  validateRuntimeSelection,
  type RuntimeSelection,
} from '../../lib/chat-agents.js';
import { trackBackgroundWork } from '../../lib/background-work-gate.js';
import { isPathInside } from '../../lib/path-containment.js';
import { logger } from '../../logger.js';
import { getGroupByFolder, registeredGroups } from '../../state-manager.js';
import {
  readHistoryManifest,
  runHistoryReflectionPreview,
  writeHistoryManifest,
  type HistoryPreviewOptions,
} from './history-reflection.js';
import type { HistoryReflectionManifest } from './history-reflector-core.js';
import { HistoryReviewError } from './history-review.js';
import {
  PROJECT_HISTORY_BATCH_VERSION,
  acquireProjectHistoryBatchLease,
  discoverProjectHistory,
  historyReviewFingerprint,
  readProjectHistoryBatch,
  resolveProjectHistoryManifestPath,
  writeProjectHistoryBatch,
  type ProjectHistoryBatchManifest,
  type ProjectHistoryBatchProject,
  type ProjectHistoryDiscovery,
} from './project-history-reflection-batch.js';

const HISTORY_BATCH_PATTERN = /^project-history-batch-[a-zA-Z0-9._:-]+\.json$/;
const TOOL_PREVIEW_TRANSCRIPT_PATTERN = /^\.tool-preview-.*\.jsonl$/;
const TOOL_PREVIEW_STATE_PATTERN = /^\.tool-preview-state-.*\.json$/;
const TOOL_PREVIEW_STATE_TMP_PATTERN = /^\.tool-preview-state-.*\.tmp$/;
const RESTART_INTERRUPTION_ERROR =
  'History proposal generation was interrupted by a Board restart';

export interface StartHistoryReviewGenerationInput {
  projectId: string;
  since: string;
  until: string;
  reflectorRuntime?: RuntimeSelection;
}

export interface StartedHistoryReviewGeneration {
  batchId: string;
  /** Exposed for deterministic harnesses; the HTTP route intentionally detaches. */
  completion: Promise<void>;
}

export interface HistoryReviewGenerationRecoverySummary {
  resumed: number;
  terminalized: number;
}

interface HistoryReviewGenerationDeps {
  now(): Date;
  listGroups(): (typeof registeredGroups)[keyof typeof registeredGroups][];
  hasProject(projectId: string): boolean;
  discover(
    groups: ReturnType<HistoryReviewGenerationDeps['listGroups']>,
    options: {
      projectFilter?: string;
      includeConversations: boolean;
      includeNativeMemories: boolean;
      since?: string;
      until?: string;
      cutoffAt?: string;
    },
  ): Promise<ProjectHistoryDiscovery[]>;
  resolveRuntime(
    selection: RuntimeSelection,
  ): ReturnType<typeof resolveRuntimeSelection>;
  defaultReflector(): RuntimeSelection | undefined;
  validateRuntime(selection: RuntimeSelection): string | null;
  batchRoot(): string;
  listProjectIds(): string[];
  projectDir(projectId: string): string;
  listBatchFiles(root: string): string[];
  readBatch(filePath: string): ProjectHistoryBatchManifest;
  readManifest(filePath: string): HistoryReflectionManifest;
  acquireLease(
    filePath: string,
    options?: { staleMs?: number; heartbeatMs?: number },
  ): { release(): void };
  writeBatch(filePath: string, batch: ProjectHistoryBatchManifest): void;
  resolveManifestPath(project: ProjectHistoryBatchProject): string;
  writeManifest(filePath: string, manifest: HistoryReflectionManifest): void;
  runPreview(
    options: HistoryPreviewOptions,
  ): Promise<HistoryReflectionManifest>;
}

const defaultDeps: HistoryReviewGenerationDeps = {
  now: () => new Date(),
  listGroups: () => Object.values(registeredGroups),
  hasProject: (projectId) => !!getGroupByFolder(projectId),
  discover: discoverProjectHistory,
  resolveRuntime: resolveRuntimeSelection,
  defaultReflector: () =>
    getRuntimeCatalog({ watch: false }).defaults.reflector,
  validateRuntime: validateRuntimeSelection,
  batchRoot: () =>
    path.join(getGroupDir('main'), 'artifacts', 'history-reflection'),
  listProjectIds: () =>
    Object.values(registeredGroups).map((group) => group.folder),
  projectDir: getGroupDir,
  listBatchFiles: (root) =>
    (readdirGroupPathSync(root) ?? []).map((entry) => entry.name),
  readBatch: readProjectHistoryBatch,
  readManifest: readHistoryManifest,
  // The start path relies on the default stale window so a live lease keeps
  // rejecting double launches. Recovery passes { staleMs: 0 } explicitly: the
  // sweep runs once at process startup, before generation endpoints can
  // launch new work, so any surviving lease belongs to the stopped process.
  acquireLease: acquireProjectHistoryBatchLease,
  writeBatch: writeProjectHistoryBatch,
  resolveManifestPath: resolveProjectHistoryManifestPath,
  writeManifest: writeHistoryManifest,
  runPreview: runHistoryReflectionPreview,
};

function countCandidates(manifest: HistoryReflectionManifest): number {
  return (
    manifest.conversations.reduce(
      (sum, conversation) => sum + conversation.candidates.length,
      0,
    ) +
    manifest.memory_files.reduce((sum, file) => sum + file.candidates.length, 0)
  );
}

function normalizeBoundary(value: string, field: 'since' | 'until'): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new HistoryReviewError(400, `${field} must be an ISO date`);
  }
  return new Date(timestamp).toISOString();
}

/**
 * One detached preview generation: either a fresh start or a startup resume
 * of a batch interrupted by a Board restart.
 */
interface HistoryGenerationLaunch {
  batch: ProjectHistoryBatchManifest;
  project: ProjectHistoryBatchProject;
  batchPath: string;
  lease: { release(): void };
  previewId: string;
  stateFilePath: string;
  priorManifest: HistoryReflectionManifest | null;
  reflectorAgentId: string;
  reflectorRuntime: RuntimeSelection;
}

interface HistoryPreviewArtifactPaths {
  stateFilePath: string;
  transcriptPath: string;
}

function resolveHistoryPreviewArtifactPaths(
  deps: HistoryReviewGenerationDeps,
  project: ProjectHistoryBatchProject,
): HistoryPreviewArtifactPaths | null {
  const previewState = project.preview_state;
  if (!previewState) return null;
  if (!/^[a-zA-Z0-9._:-]+$/.test(previewState.preview_id)) return null;
  const stateFileName = `.tool-preview-state-${previewState.preview_id}.json`;
  const stored = previewState.state_file.split(path.sep).join('/');
  if (stored !== `artifacts/history-reflection/${stateFileName}`) {
    return null;
  }
  const groupRoot = path.resolve(deps.projectDir(project.project_id));
  const stateFilePath = path.resolve(groupRoot, ...stored.split('/'));
  if (!isPathInside(groupRoot, stateFilePath)) return null;
  return {
    stateFilePath,
    transcriptPath: path.join(
      path.dirname(stateFilePath),
      `.tool-preview-${previewState.preview_id}.jsonl`,
    ),
  };
}

async function launchHistoryGeneration(
  launch: HistoryGenerationLaunch,
  deps: HistoryReviewGenerationDeps,
): Promise<void> {
  const { batch, project, batchPath, lease } = launch;
  let checkpointed = false;
  try {
    if (project.status === 'error') return;
    const manifestPath = deps.resolveManifestPath(project);
    const reflection = await trackBackgroundWork('history review', () =>
      deps.runPreview({
        projectId: project.project_id,
        since: batch.filters.since ?? undefined,
        until: batch.filters.until ?? undefined,
        cutoffAt: batch.cutoff_at,
        reflectorAgentId: launch.reflectorAgentId,
        reflectorRuntime: launch.reflectorRuntime,
        previewId: launch.previewId,
        expectedSourceFingerprint: project.source_fingerprint,
        priorManifest: launch.priorManifest ?? undefined,
        includeConversations: true,
        includeMemoryFiles: false,
        memoryFilePaths: [],
        requireNativeManifest: false,
        onProgress: async (progress) => {
          if (project.status === 'error') return;
          // Recovered rows may lack progress; materialize it before mapping.
          project.progress ??= {
            conversations_processed: 0,
            conversations_total: project.conversation_count,
            memory_files_processed: 0,
            memory_files_total: 0,
          };
          if (progress.phase === 'extract-conversations') {
            project.progress!.conversations_processed = progress.completed;
            project.progress!.conversations_total = progress.total;
          } else if (progress.phase === 'reflect-conversations') {
            project.progress!.reflection = {
              completedChunks: progress.completed,
              totalChunks: progress.total,
              failedChunks: progress.failedChunks ?? 0,
              activeChunk: progress.chunk ?? null,
              updatedAt: new Date().toISOString(),
            };
          } else {
            return;
          }
          deps.writeBatch(batchPath, batch);
        },
        onCheckpoint: async (partial) => {
          checkpointed = true;
          deps.writeManifest(manifestPath, partial);
          project.candidates = countCandidates(partial);
          project.memory_ops = partial.envelope.memory_ops.length;
          project.skipped_candidates =
            partial.envelope.skipped_candidates.length;
          deps.writeBatch(batchPath, batch);
        },
      }),
    );
    if (reflection.errors.length > 0 && !checkpointed && launch.priorManifest) {
      // The resumed run never reached a new durable checkpoint, so the
      // on-disk manifest still holds the most advanced snapshot. Keep it and
      // surface the run's errors on the batch instead of regressing it.
      project.errors = [...new Set([...project.errors, ...reflection.errors])];
      project.status = 'error';
    } else {
      deps.writeManifest(manifestPath, reflection);
      project.review_fingerprint = historyReviewFingerprint(reflection);
      project.candidates = countCandidates(reflection);
      project.memory_ops = reflection.envelope.memory_ops.length;
      project.skipped_candidates =
        reflection.envelope.skipped_candidates.length;
      project.errors = [...reflection.errors];
      project.status = reflection.errors.length > 0 ? 'error' : 'preview';
    }
  } catch (error) {
    project.errors = [
      ...new Set([
        ...project.errors,
        error instanceof Error ? error.message : String(error),
      ]),
    ];
    project.status = 'error';
  } finally {
    const failed = project.status === 'error';
    batch.status = failed ? 'error' : 'preview';
    batch.errors = failed
      ? project.errors.map((error) => `${project.project_id}: ${error}`)
      : [];
    let terminalWriteFailed: unknown = null;
    try {
      deps.writeBatch(batchPath, batch);
    } catch (error) {
      terminalWriteFailed = error;
      logger.warn(
        { err: error, batchId: path.basename(batchPath) },
        'Failed to persist terminal history proposal batch state',
      );
    }
    if (!terminalWriteFailed) {
      // Release the per-chunk resume state only once the terminal batch
      // write is durable; a failed write leaves the batch resumable.
      try {
        removeGroupPathSync(launch.stateFilePath);
      } catch (error) {
        logger.warn(
          { err: error, stateFile: launch.stateFilePath },
          'Failed to release history preview resume state',
        );
      }
    }
    lease.release();
    if (terminalWriteFailed) throw terminalWriteFailed;
  }
}

/**
 * Persist a conversation-only preview batch before detaching its model work.
 * The returned completion promise exists for tests and shutdown-aware callers;
 * the route responds as soon as the durable batch index is selectable.
 */
export async function startHistoryReviewGeneration(
  input: StartHistoryReviewGenerationInput,
  overrides: Partial<HistoryReviewGenerationDeps> = {},
): Promise<StartedHistoryReviewGeneration> {
  const deps = { ...defaultDeps, ...overrides };
  if (!deps.hasProject(input.projectId)) {
    throw new HistoryReviewError(400, 'Project does not exist');
  }
  const requestedSince = normalizeBoundary(input.since, 'since');
  const requestedUntil = normalizeBoundary(input.until, 'until');
  const cutoffAt = deps.now().toISOString();
  const until =
    Date.parse(requestedUntil) < Date.parse(cutoffAt)
      ? requestedUntil
      : cutoffAt;
  if (Date.parse(requestedSince) > Date.parse(until)) {
    throw new HistoryReviewError(400, 'since must not be after until');
  }

  const reflectorRuntime = input.reflectorRuntime ?? deps.defaultReflector();
  if (!reflectorRuntime) {
    throw new HistoryReviewError(
      422,
      'No defaults.reflector runtime is configured',
    );
  }
  const runtimeError = deps.validateRuntime(reflectorRuntime);
  if (runtimeError) throw new HistoryReviewError(400, runtimeError);
  const reflector = deps.resolveRuntime(reflectorRuntime);
  if (!isDirectRuntime(reflector) || !reflector.baseUrl || !reflector.model) {
    throw new HistoryReviewError(
      422,
      'History proposal generation requires an HTTP-capable direct runtime',
    );
  }

  const discoveries = await deps.discover(deps.listGroups(), {
    projectFilter: input.projectId,
    includeConversations: true,
    includeNativeMemories: false,
    since: requestedSince,
    until,
    cutoffAt,
  });
  const discovery = discoveries.find(
    (candidate) => candidate.project_id === input.projectId,
  );
  if (!discovery) {
    throw new HistoryReviewError(
      409,
      'No conversations are available for the selected project',
    );
  }

  const createdAt = cutoffAt;
  const token = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
  const batchId = `project-history-batch-${token}.json`;
  const batchPath = path.join(deps.batchRoot(), batchId);
  const stateFilePath = path.join(
    deps.projectDir(input.projectId),
    'artifacts',
    'history-reflection',
    `.tool-preview-state-${token}.json`,
  );
  const project: ProjectHistoryBatchProject = {
    project_id: discovery.project_id,
    import_manifests: [],
    memory_file_paths: [],
    declared_entries: 0,
    source_fingerprint: discovery.source_fingerprint,
    conversation_count: discovery.conversation_count,
    sources: { conversations: true, native_memories: false },
    reflection_manifest: `artifacts/history-reflection/project-history-${token}.json`,
    review_fingerprint: null,
    candidates: 0,
    memory_ops: 0,
    skipped_candidates: 0,
    errors: [...discovery.errors],
    status: discovery.errors.length > 0 ? 'error' : 'pending',
    progress: {
      conversations_processed: 0,
      conversations_total: discovery.conversation_count,
      memory_files_processed: 0,
      memory_files_total: 0,
    },
    preview_state: {
      preview_id: token,
      state_file: `artifacts/history-reflection/.tool-preview-state-${token}.json`,
    },
  };
  const batch: ProjectHistoryBatchManifest = {
    batch_version: PROJECT_HISTORY_BATCH_VERSION,
    created_at: createdAt,
    cutoff_at: cutoffAt,
    filters: {
      project: input.projectId,
      since: requestedSince,
      until,
      sources: { conversations: true, native_memories: false },
    },
    agents: {
      observer: null,
      reflector: reflector.id,
      reflector_model: reflectorRuntime.modelId,
      reflector_runtime: reflectorRuntime,
    },
    projects: [project],
    status: project.status === 'error' ? 'error' : 'previewing',
    errors: project.errors.map((error) => `${project.project_id}: ${error}`),
  };
  const lease = deps.acquireLease(batchPath);
  try {
    deps.writeBatch(batchPath, batch);
  } catch (error) {
    lease.release();
    throw error;
  }

  const completion = launchHistoryGeneration(
    {
      batch,
      project,
      batchPath,
      lease,
      previewId: token,
      stateFilePath,
      priorManifest: null,
      reflectorAgentId: reflector.id,
      reflectorRuntime,
    },
    deps,
  );
  void completion.catch((error) => {
    logger.error(
      { err: error, batchId, projectId: input.projectId },
      'History proposal background generation failed',
    );
  });
  return { batchId, completion };
}

/**
 * Decide whether an interrupted preview batch can resume automatically.
 * Never throws: any missing or invalid recovery input becomes an actionable
 * terminal error that keeps the batch reviewable.
 */
async function projectResumeVerdict(
  deps: HistoryReviewGenerationDeps,
  batch: ProjectHistoryBatchManifest,
  project: ProjectHistoryBatchProject,
): Promise<{ resumable: true } | { resumable: false; error: string }> {
  try {
    const state = project.preview_state;
    if (!state?.preview_id || !state.state_file) {
      return { resumable: false, error: RESTART_INTERRUPTION_ERROR };
    }
    if (!resolveHistoryPreviewArtifactPaths(deps, project)) {
      return {
        resumable: false,
        error: `History proposal resume checkpoint path is invalid for project ${project.project_id}`,
      };
    }
    if (!deps.hasProject(project.project_id)) {
      return {
        resumable: false,
        error: `Project ${project.project_id} is no longer available; the interrupted history proposals cannot be resumed`,
      };
    }
    const discoveries = await deps.discover(deps.listGroups(), {
      projectFilter: project.project_id,
      includeConversations: project.sources.conversations,
      includeNativeMemories: project.sources.native_memories,
      since: batch.filters.since ?? undefined,
      until: batch.filters.until ?? undefined,
      cutoffAt: batch.cutoff_at,
    });
    const discovery = discoveries.find(
      (candidate) => candidate.project_id === project.project_id,
    );
    if (!discovery) {
      return {
        resumable: false,
        error: `Selected history for project ${project.project_id} is no longer available; existing proposals were retained and the interrupted generation cannot be resumed`,
      };
    }
    if (
      discovery.source_fingerprint !== project.source_fingerprint ||
      discovery.conversation_count !== project.conversation_count
    ) {
      return {
        resumable: false,
        error: `Selected history for project ${project.project_id} changed since generation started; existing proposals were retained and the interrupted generation cannot be resumed`,
      };
    }
    const runtime = batch.agents.reflector_runtime;
    if (!runtime) {
      return {
        resumable: false,
        error:
          'History proposal runtime selection is missing from the batch; the interrupted generation cannot be resumed',
      };
    }
    const runtimeError = deps.validateRuntime(runtime);
    if (runtimeError) {
      return {
        resumable: false,
        error: `History proposal runtime is no longer valid: ${runtimeError}`,
      };
    }
    const reflector = deps.resolveRuntime(runtime);
    if (!isDirectRuntime(reflector) || !reflector.baseUrl || !reflector.model) {
      return {
        resumable: false,
        error:
          'History proposal generation requires an HTTP-capable direct runtime',
      };
    }
    return { resumable: true };
  } catch (error) {
    return {
      resumable: false,
      error: `History proposal runtime could not be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function readPriorManifest(
  deps: HistoryReviewGenerationDeps,
  project: ProjectHistoryBatchProject,
): HistoryReflectionManifest | null {
  try {
    return deps.readManifest(deps.resolveManifestPath(project));
  } catch {
    return null;
  }
}

function captureHistoryPreviewArtifactPaths(
  deps: HistoryReviewGenerationDeps,
  projectIds: Iterable<string>,
): Set<string> {
  const artifactPaths = new Set<string>();
  for (const projectId of new Set(projectIds)) {
    const directory = path.join(
      deps.projectDir(projectId),
      'artifacts',
      'history-reflection',
    );
    let entries: Dirent[];
    try {
      entries = readdirGroupPathSync(directory) ?? [];
    } catch (error) {
      logger.warn(
        { err: error, projectId },
        'Failed to inspect history preview artifacts during recovery',
      );
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (
        !TOOL_PREVIEW_TRANSCRIPT_PATTERN.test(entry.name) &&
        !TOOL_PREVIEW_STATE_PATTERN.test(entry.name) &&
        !TOOL_PREVIEW_STATE_TMP_PATTERN.test(entry.name)
      ) {
        continue;
      }
      artifactPaths.add(path.resolve(directory, entry.name));
    }
  }
  return artifactPaths;
}

function cleanupOrphanedHistoryPreviewArtifacts(
  artifactPaths: Set<string>,
  referencedStateFiles: Set<string>,
): number {
  let removed = 0;
  for (const artifactPath of artifactPaths) {
    // A relaunched resumable run re-derives its transcript on demand, but
    // its state file is the resume checkpoint and must survive the sweep.
    if (referencedStateFiles.has(artifactPath)) continue;
    try {
      if (removeGroupPathSync(artifactPath)) removed++;
    } catch (error) {
      logger.warn(
        { err: error, artifact: artifactPath },
        'Failed to remove orphaned history preview artifact',
      );
    }
  }
  return removed;
}

/**
 * Resume detached history proposal generations interrupted by a Board
 * restart, and terminalize batches that lack resumable checkpoints. Launches
 * are detached so recovery never blocks startup.
 */
export async function recoverInterruptedHistoryReviewGenerations(
  overrides: Partial<HistoryReviewGenerationDeps> = {},
): Promise<HistoryReviewGenerationRecoverySummary> {
  const deps = { ...defaultDeps, ...overrides };
  const referencedStateFiles = new Set<string>();
  const launches: HistoryGenerationLaunch[] = [];
  let terminalized = 0;

  const root = deps.batchRoot();
  let files: string[];
  try {
    files = deps.listBatchFiles(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') files = [];
    else if (error instanceof GroupFsError) {
      logger.warn(
        { err: error },
        'Skipping unreadable history batch directory',
      );
      files = [];
    } else throw error;
  }

  // Recovery performs source discovery below, which yields to the event loop
  // while startup remains non-blocking. Capture the cleanup boundary before
  // that first await so a generation accepted by this process cannot have its
  // newly-created transcript or checkpoint swept out from under it.
  const cleanupProjectIds = new Set(deps.listProjectIds());
  for (const file of files.filter((candidate) =>
    HISTORY_BATCH_PATTERN.test(candidate),
  )) {
    const batchPath = path.join(root, file);
    try {
      const batch = deps.readBatch(batchPath);
      if (batch.batch_version !== PROJECT_HISTORY_BATCH_VERSION) continue;
      for (const project of batch.projects) {
        // Batch JSON is agent-writable: only registered groups are swept.
        if (deps.hasProject(project.project_id)) {
          cleanupProjectIds.add(project.project_id);
        }
      }
    } catch {
      // The normal recovery pass below will apply the same best-effort policy.
    }
  }
  const cleanupArtifactPaths = captureHistoryPreviewArtifactPaths(
    deps,
    cleanupProjectIds,
  );

  for (const file of files.filter((candidate) =>
    HISTORY_BATCH_PATTERN.test(candidate),
  )) {
    const batchPath = path.join(root, file);
    let initial: ProjectHistoryBatchManifest;
    try {
      initial = deps.readBatch(batchPath);
    } catch {
      continue;
    }
    if (
      initial.batch_version !== PROJECT_HISTORY_BATCH_VERSION ||
      initial.status !== 'previewing'
    ) {
      continue;
    }

    let lease: { release(): void } | null = null;
    try {
      lease = deps.acquireLease(batchPath, { staleMs: 0 });
      let batch: ProjectHistoryBatchManifest;
      try {
        batch = deps.readBatch(batchPath);
      } catch {
        continue;
      }
      if (batch.status !== 'previewing') continue;
      const pending = batch.projects.filter(
        (project) => project.status === 'pending',
      );
      if (pending.length === 0) {
        // Crashed between the last project update and the terminal batch
        // write: finalize from the projects' recorded states.
        const failed = batch.projects.filter(
          (project) => project.status === 'error',
        );
        batch.status = failed.length > 0 ? 'error' : 'preview';
        batch.errors = failed.flatMap((project) =>
          project.errors.map((error) => `${project.project_id}: ${error}`),
        );
        deps.writeBatch(batchPath, batch);
        terminalized++;
        continue;
      }

      const project = pending[0]!;
      const verdict = await projectResumeVerdict(deps, batch, project);
      if (!verdict.resumable) {
        for (const candidate of pending) {
          candidate.errors = [...new Set([...candidate.errors, verdict.error])];
          candidate.status = 'error';
        }
        const failed = batch.projects.filter(
          (candidate) => candidate.status === 'error',
        );
        batch.status = 'error';
        batch.errors = failed.flatMap((candidate) =>
          candidate.errors.map((error) => `${candidate.project_id}: ${error}`),
        );
        deps.writeBatch(batchPath, batch);
        terminalized++;
        continue;
      }

      // One writer per batch: only the first pending project resumes; the
      // rest terminalize instead of queueing behind an invisible writer.
      for (const extra of pending.slice(1)) {
        extra.errors = [
          ...new Set([...extra.errors, RESTART_INTERRUPTION_ERROR]),
        ];
        extra.status = 'error';
      }
      const previewState = project.preview_state!;
      const artifactPathsForProject = resolveHistoryPreviewArtifactPaths(
        deps,
        project,
      );
      if (!artifactPathsForProject) {
        throw new Error(
          `History proposal resume checkpoint path is invalid for project ${project.project_id}`,
        );
      }
      const launch: HistoryGenerationLaunch = {
        batch,
        project,
        batchPath,
        lease,
        previewId: previewState.preview_id,
        stateFilePath: artifactPathsForProject.stateFilePath,
        priorManifest: readPriorManifest(deps, project),
        reflectorAgentId: batch.agents.reflector ?? '',
        reflectorRuntime: batch.agents.reflector_runtime!,
      };
      referencedStateFiles.add(path.resolve(launch.stateFilePath));
      launches.push(launch);
      // The launcher's terminal write keeps holding the lease and releases
      // it there; the sweep must not release it early.
    } catch (error) {
      logger.error(
        { err: error, batchId: file },
        'History proposal generation recovery failed for batch',
      );
    } finally {
      if (
        lease &&
        !launches.some((candidate) => candidate.batchPath === batchPath)
      ) {
        lease.release();
      }
    }
  }

  const removed = cleanupOrphanedHistoryPreviewArtifacts(
    cleanupArtifactPaths,
    referencedStateFiles,
  );
  if (removed > 0) {
    logger.info(
      { removed },
      'Removed orphaned history preview artifacts during recovery',
    );
  }

  for (const launch of launches) {
    logger.info(
      {
        batchId: path.basename(launch.batchPath),
        projectId: launch.project.project_id,
        previewId: launch.previewId,
      },
      'Resuming interrupted history proposal generation',
    );
    void launchHistoryGeneration(launch, deps).catch((error) => {
      logger.error(
        { err: error, batchId: path.basename(launch.batchPath) },
        'Resumed history proposal generation failed',
      );
    });
  }
  return { resumed: launches.length, terminalized };
}
