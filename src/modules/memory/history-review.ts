import path from 'path';
import { getMemory, getMemoryTimeline } from '../../db.js';
import { getGroupDir } from '../../group-dir.js';
import {
  GroupFsError,
  readGroupFileSync,
  readdirGroupPathSync,
  removeGroupPathSync,
  writeGroupFileSync,
} from '../../lib/group-fs.js';
import { sha256Hex } from '../../lib/hash.js';
import { serialize } from '../../lib/serial-queue.js';
import { logger } from '../../logger.js';
import { getGroupEntryByFolder } from '../../state-manager.js';
import {
  applyRelocatedHistoryCreate,
  applyHistoryReflectionManifest,
  assertNoPrivacyErasureSince,
  finalizePartialHistoryReflectionManifest,
  historyPrivacyCheckpoint,
  readHistoryManifest,
  writeHistoryManifest,
} from './history-reflection.js';
import {
  HISTORY_MIN_IMPORTANCE,
  historyOpTargetId,
  type HistoryCandidate,
  type HistoryMemoryOp,
  type HistoryReflectionManifest,
} from './history-reflector-core.js';
import { MAX_MEMORY_STATE_BYTES } from './file-limits.js';
import { withMemoryLifecycleLock } from './lifecycle-lock.js';
import type { Memory } from './types.js';
import {
  PROJECT_HISTORY_BATCH_VERSION,
  acquireProjectHistoryBatchLease,
  historyReviewFingerprint,
  readProjectHistoryBatch,
  resolveProjectHistoryManifestPath,
  writeProjectHistoryBatch,
  type ProjectHistoryBatchManifest,
  type ProjectHistoryBatchProject,
} from './project-history-reflection-batch.js';

const HISTORY_REVIEW_VERSION = 1;
const BATCH_PATTERN = /^project-history-batch-[a-zA-Z0-9._:-]+\.json$/;
const MEMORY_TYPES = new Set([
  'identity',
  'project',
  'goal',
  'decision',
  'preference',
  'contact',
  'event',
  'task',
]);

export type HistoryReviewDecision = 'approved' | 'rejected';

export interface HistoryReviewEdits {
  content?: string;
  memory_type?: string;
  importance?: number;
  tags?: string[];
  valid_from?: string;
  reason?: string;
  effective_at?: string;
}

export interface HistoryReviewItemDecision {
  decision: HistoryReviewDecision;
  mark_for_eval: boolean;
  target_project_id?: string;
  edits?: HistoryReviewEdits;
  reviewed_by: string;
  reviewed_at: string;
}

export interface HistoryReviewSidecar {
  review_version: number;
  batch_id: string;
  project_id: string;
  manifest_fingerprint: string;
  revision: number;
  decisions: Record<string, HistoryReviewItemDecision>;
  created_at: string;
  updated_at: string;
  status: 'reviewing' | 'applied';
  applied_at?: string;
}

interface HistoryReviewEvidence {
  source_kind: 'conversation' | 'memory_file';
  conversation_id: string;
  message_id: string;
  role: string;
  created_at: string;
  excerpt: string;
  memory_file_path?: string;
}

interface HistoryReviewTargetMemory {
  id: string;
  content: string;
  memory_type: string;
  valid_from: string;
}

interface HistoryReviewOperation {
  id: string;
  operation: HistoryMemoryOp;
  candidates: HistoryCandidate[];
  evidence: HistoryReviewEvidence[];
  mandatory: boolean;
  decision: HistoryReviewDecision | 'pending';
  mark_for_eval: boolean;
  target_project_id: string;
  edits?: HistoryReviewEdits;
  reviewed_by?: string;
  reviewed_at?: string;
  /** Existing memory acted on by a supersede, invalidate or forget operation. */
  target_memory?: HistoryReviewTargetMemory | null;
}

interface HistoryReviewSkippedGroup {
  candidate_ids: string[];
  reason: string;
  candidates: HistoryCandidate[];
}

export interface HistoryReviewProjectView {
  batch_id: string;
  batch_status: ProjectHistoryBatchManifest['status'];
  project_id: string;
  project_status: ProjectHistoryBatchProject['status'];
  created_at: string;
  cutoff_at: string;
  progress: {
    reflection?: NonNullable<
      ProjectHistoryBatchProject['progress']
    >['reflection'];
    conversations_processed: number;
    conversations_total: number;
    memory_files_processed: number;
    memory_files_total: number;
  };
  counts: {
    operations: number;
    pending: number;
    approved: number;
    eval: number;
    rejected: number;
    mandatory: number;
    skipped_groups: number;
  };
  operations: HistoryReviewOperation[];
  skipped_candidates: HistoryReviewSkippedGroup[];
  errors: string[];
  ignored_errors: string[];
  partial_finalized_at?: string;
  review_revision: number;
  manifest_fingerprint: string | null;
  review_stale: boolean;
  review_enabled: boolean;
  apply_enabled: boolean;
  applied_at?: string;
}

export interface HistoryReviewBatchSummary {
  id: string;
  created_at: string;
  cutoff_at: string;
  projectId: string | null;
  since: string | null;
  until: string | null;
  reflectorModel: string | null;
  status: ProjectHistoryBatchManifest['status'];
  projects: number;
  ready: number;
  applied: number;
  errors: number;
  pending_operations: number;
  reviewed_operations: number;
}

function batchSummaryMetadata(
  batch: ProjectHistoryBatchManifest,
): Pick<
  HistoryReviewBatchSummary,
  'projectId' | 'since' | 'until' | 'reflectorModel'
> {
  return {
    projectId: batch.filters.project,
    since: batch.filters.since,
    until: batch.filters.until,
    reflectorModel:
      batch.agents.reflector_model ?? batch.agents.reflector ?? null,
  };
}

export interface UpdateHistoryReviewInput {
  revision: number;
  decision: HistoryReviewDecision | 'pending';
  mark_for_eval?: boolean;
  target_project_id?: string;
  edits?: HistoryReviewEdits;
  reviewer: string;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  writeGroupFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mkdirs: true,
  });
}

async function withHistoryReviewLock<T>(
  batchId: string,
  projectId: string,
  action: () => Promise<T>,
): Promise<T> {
  return serialize(`history-review:${batchId}:${projectId}`, action);
}

function batchRoot(): string {
  return path.join(getGroupDir('main'), 'artifacts', 'history-reflection');
}

function assertBatchId(batchId: string): void {
  if (!BATCH_PATTERN.test(batchId) || path.basename(batchId) !== batchId) {
    throw new HistoryReviewError(400, 'Invalid history batch id');
  }
}

function resolveBatch(batchId: string): {
  path: string;
  manifest: ProjectHistoryBatchManifest;
} {
  assertBatchId(batchId);
  const filePath = path.join(batchRoot(), batchId);
  let manifest: ProjectHistoryBatchManifest;
  try {
    manifest = readProjectHistoryBatch(filePath);
  } catch (error) {
    if (!(error instanceof GroupFsError)) throw error;
    throw error.code === 'not_found'
      ? new HistoryReviewError(404, 'History batch not found')
      : new HistoryReviewError(409, 'History batch is not readable');
  }
  if (manifest.batch_version !== PROJECT_HISTORY_BATCH_VERSION) {
    throw new HistoryReviewError(409, 'Unsupported history batch version');
  }
  return { path: filePath, manifest };
}

function resolveProjectManifest(
  batch: ProjectHistoryBatchManifest,
  projectId: string,
): {
  project: ProjectHistoryBatchProject;
  path: string;
  manifest: HistoryReflectionManifest | null;
} {
  if (!getGroupEntryByFolder(projectId)) {
    throw new HistoryReviewError(404, 'Project not found');
  }
  const project = batch.projects.find((item) => item.project_id === projectId);
  if (!project) {
    throw new HistoryReviewError(404, 'Project is not part of this batch');
  }
  let manifestPath: string;
  try {
    manifestPath = resolveProjectHistoryManifestPath(project);
  } catch {
    throw new HistoryReviewError(409, 'Unsafe project manifest path');
  }
  let manifest: HistoryReflectionManifest | null = null;
  try {
    manifest = readHistoryManifest(manifestPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HistoryReviewError(409, 'Project manifest is not valid JSON');
    }
    if (!(error instanceof GroupFsError)) throw error;
    if (error.code !== 'not_found') {
      throw new HistoryReviewError(409, 'Unsafe project manifest path');
    }
  }
  return { project, path: manifestPath, manifest };
}

function sidecarPath(manifestPath: string): string {
  return manifestPath.replace(/\.json$/i, '.review.json');
}

function readSidecar(
  filePath: string,
  batchId: string,
  projectId: string,
): HistoryReviewSidecar | null {
  let raw: string;
  try {
    const read = readGroupFileSync(filePath, {
      maxBytes: MAX_MEMORY_STATE_BYTES,
    });
    if (!read) return null;
    raw = read.data.toString('utf8');
  } catch (error) {
    if (!(error instanceof GroupFsError)) throw error;
    throw new HistoryReviewError(409, 'History review sidecar is not readable');
  }
  let parsed: HistoryReviewSidecar;
  try {
    parsed = JSON.parse(raw) as HistoryReviewSidecar;
  } catch {
    throw new HistoryReviewError(409, 'Malformed history review sidecar');
  }
  if (
    !parsed ||
    parsed.review_version !== HISTORY_REVIEW_VERSION ||
    parsed.batch_id !== batchId ||
    parsed.project_id !== projectId ||
    !Number.isInteger(parsed.revision) ||
    !parsed.decisions ||
    typeof parsed.decisions !== 'object'
  ) {
    throw new HistoryReviewError(409, 'Malformed history review sidecar');
  }
  return parsed;
}

export function historyReviewOperationId(op: HistoryMemoryOp): string {
  return `history-op-${sha256Hex(
    JSON.stringify({
      op: op.op,
      candidate_ids: [...op.candidate_ids].sort(),
      memory_id:
        op.op === 'create' || op.op === 'supersede'
          ? op.new_memory_id
          : op.memory_id,
    }),
  ).slice(0, 24)}`;
}

function allCandidates(
  manifest: HistoryReflectionManifest,
): HistoryCandidate[] {
  return [
    ...manifest.memory_files.flatMap((file) => file.candidates),
    ...manifest.conversations.flatMap(
      (conversation) => conversation.candidates,
    ),
  ];
}

function candidatesById(
  manifest: HistoryReflectionManifest,
): Map<string, HistoryCandidate> {
  return new Map(
    allCandidates(manifest).map((candidate) => [candidate.id, candidate]),
  );
}

function evidenceFor(
  op: HistoryMemoryOp,
  candidates: Map<string, HistoryCandidate>,
): HistoryReviewEvidence[] {
  const seen = new Set<string>();
  return op.candidate_ids.flatMap((candidateId) => {
    const candidate = candidates.get(candidateId);
    if (!candidate) return [];
    return candidate.evidence.flatMap((evidence) => {
      const key = `${evidence.conversation_id}#${evidence.message_id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          source_kind: evidence.source_kind,
          conversation_id: evidence.conversation_id,
          message_id: evidence.message_id,
          role: evidence.role,
          created_at: evidence.created_at,
          excerpt: evidence.excerpt,
          ...(evidence.memory_file_path
            ? { memory_file_path: evidence.memory_file_path }
            : {}),
        },
      ];
    });
  });
}

function emptySidecar(
  batchId: string,
  projectId: string,
  fingerprint: string,
): HistoryReviewSidecar {
  const now = new Date().toISOString();
  return {
    review_version: HISTORY_REVIEW_VERSION,
    batch_id: batchId,
    project_id: projectId,
    manifest_fingerprint: fingerprint,
    revision: 0,
    decisions: {},
    created_at: now,
    updated_at: now,
    status: 'reviewing',
  };
}

function editableOperation(
  original: HistoryMemoryOp,
  edits?: HistoryReviewEdits,
): HistoryMemoryOp {
  if (!edits) return structuredClone(original);
  if (original.op === 'create') {
    return {
      ...original,
      ...(edits.content !== undefined ? { content: edits.content } : {}),
      ...(edits.memory_type !== undefined
        ? { memory_type: edits.memory_type as typeof original.memory_type }
        : {}),
      ...(edits.importance !== undefined
        ? { importance: edits.importance }
        : {}),
      ...(edits.tags !== undefined ? { tags: edits.tags } : {}),
      ...(edits.valid_from !== undefined
        ? { valid_from: edits.valid_from }
        : {}),
    };
  }
  if (original.op === 'supersede') {
    return {
      ...original,
      ...(edits.content !== undefined
        ? { correction_content: edits.content }
        : {}),
      ...(edits.memory_type !== undefined
        ? { memory_type: edits.memory_type as typeof original.memory_type }
        : {}),
      ...(edits.importance !== undefined
        ? { importance: edits.importance }
        : {}),
      ...(edits.tags !== undefined ? { tags: edits.tags } : {}),
      ...(edits.valid_from !== undefined
        ? { valid_from: edits.valid_from }
        : {}),
    };
  }
  if (original.op === 'invalidate') {
    return {
      ...original,
      ...(edits.reason !== undefined ? { reason: edits.reason } : {}),
      ...(edits.effective_at !== undefined
        ? { effective_at: edits.effective_at }
        : {}),
    };
  }
  return structuredClone(original);
}

export function validateHistoryReviewEdits(
  original: HistoryMemoryOp,
  edits: HistoryReviewEdits | undefined,
  cutoffAt: string,
): HistoryReviewEdits | undefined {
  if (!edits || Object.keys(edits).length === 0) return undefined;
  if (original.op === 'forget') {
    throw new HistoryReviewError(400, 'Forget operations cannot be edited');
  }
  const allowed =
    original.op === 'invalidate'
      ? new Set(['reason', 'effective_at'])
      : new Set(['content', 'memory_type', 'importance', 'tags', 'valid_from']);
  for (const key of Object.keys(edits)) {
    if (!allowed.has(key)) {
      throw new HistoryReviewError(400, `Field ${key} cannot be edited`);
    }
  }
  const normalized: HistoryReviewEdits = {};
  if (edits.content !== undefined) {
    if (
      typeof edits.content !== 'string' ||
      !edits.content.trim() ||
      edits.content.length > 100_000
    ) {
      throw new HistoryReviewError(400, 'Edited content is invalid');
    }
    normalized.content = edits.content.trim();
  }
  if (edits.reason !== undefined) {
    if (
      typeof edits.reason !== 'string' ||
      !edits.reason.trim() ||
      edits.reason.length > 100_000
    ) {
      throw new HistoryReviewError(400, 'Edited reason is invalid');
    }
    normalized.reason = edits.reason.trim();
  }
  if (edits.memory_type !== undefined) {
    if (
      typeof edits.memory_type !== 'string' ||
      !MEMORY_TYPES.has(edits.memory_type)
    ) {
      throw new HistoryReviewError(400, 'Edited memory type is invalid');
    }
    normalized.memory_type = edits.memory_type;
  }
  if (edits.importance !== undefined) {
    if (
      typeof edits.importance !== 'number' ||
      !Number.isFinite(edits.importance) ||
      edits.importance < HISTORY_MIN_IMPORTANCE ||
      edits.importance > 1
    ) {
      throw new HistoryReviewError(
        400,
        `Edited importance must be ${HISTORY_MIN_IMPORTANCE}..1`,
      );
    }
    normalized.importance = edits.importance;
  }
  if (edits.tags !== undefined) {
    if (
      !Array.isArray(edits.tags) ||
      edits.tags.some(
        (tag) =>
          typeof tag !== 'string' || !tag.trim() || tag.trim().length > 100,
      )
    ) {
      throw new HistoryReviewError(400, 'Edited tags are invalid');
    }
    normalized.tags = [...new Set(edits.tags.map((tag) => tag.trim()))].slice(
      0,
      12,
    );
  }
  for (const field of ['valid_from', 'effective_at'] as const) {
    const value = edits[field];
    if (value === undefined) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      throw new HistoryReviewError(400, `Edited ${field} is invalid`);
    }
    const iso = new Date(parsed).toISOString();
    if (iso > cutoffAt) {
      throw new HistoryReviewError(
        400,
        `Edited ${field} is after the processing cutoff`,
      );
    }
    normalized[field] = iso;
  }
  return normalized;
}

export function projectView(
  batchId: string,
  batch: ProjectHistoryBatchManifest,
  project: ProjectHistoryBatchProject,
  manifest: HistoryReflectionManifest | null,
  sidecar: HistoryReviewSidecar | null,
): HistoryReviewProjectView {
  const fingerprint = manifest ? historyReviewFingerprint(manifest) : null;
  const stale = !!sidecar && sidecar.manifest_fingerprint !== fingerprint;
  const decisions = stale ? {} : (sidecar?.decisions ?? {});
  const candidateMap = manifest ? candidatesById(manifest) : new Map();
  const reviewEnabled =
    project.status === 'preview' &&
    !!manifest &&
    manifest.errors.length === 0 &&
    !stale;
  const operations: HistoryReviewOperation[] = (
    manifest?.envelope.memory_ops ?? []
  ).map((operation) => {
    const id = historyReviewOperationId(operation);
    const review = decisions[id];
    return {
      id,
      operation: review?.edits
        ? editableOperation(operation, review.edits)
        : operation,
      candidates: operation.candidate_ids.flatMap((candidateId) => {
        const candidate = candidateMap.get(candidateId);
        return candidate ? [candidate] : [];
      }),
      evidence: evidenceFor(operation, candidateMap),
      mandatory: false,
      decision: review?.decision ?? 'pending',
      mark_for_eval:
        operation.op === 'forget' ? false : (review?.mark_for_eval ?? false),
      target_project_id: review?.target_project_id ?? project.project_id,
      ...(review?.edits ? { edits: review.edits } : {}),
      ...(review
        ? {
            reviewed_by: review.reviewed_by,
            reviewed_at: review.reviewed_at,
          }
        : {}),
    };
  });
  const pending = operations.filter(
    (operation) => operation.decision === 'pending',
  ).length;
  const batchActive =
    batch.status === 'previewing' || batch.status === 'applying';
  return {
    batch_id: batchId,
    batch_status: batch.status,
    project_id: project.project_id,
    project_status: project.status,
    created_at: manifest?.created_at ?? batch.created_at,
    cutoff_at: manifest?.cutoff_at ?? batch.cutoff_at,
    progress: {
      ...(project.progress?.reflection
        ? { reflection: project.progress.reflection }
        : {}),
      conversations_processed:
        project.progress?.conversations_processed ??
        manifest?.conversations.length ??
        0,
      conversations_total:
        project.progress?.conversations_total ?? project.conversation_count,
      memory_files_processed:
        project.progress?.memory_files_processed ??
        manifest?.memory_files.length ??
        0,
      memory_files_total:
        project.progress?.memory_files_total ??
        project.memory_file_paths.length,
    },
    counts: {
      operations: operations.length,
      pending,
      approved: operations.filter(
        (operation) => operation.decision === 'approved',
      ).length,
      eval: operations.filter((operation) => operation.mark_for_eval).length,
      rejected: operations.filter(
        (operation) => operation.decision === 'rejected',
      ).length,
      mandatory: operations.filter((operation) => operation.mandatory).length,
      skipped_groups: manifest?.envelope.skipped_candidates.length ?? 0,
    },
    operations,
    skipped_candidates: (manifest?.envelope.skipped_candidates ?? []).map(
      (skipped) => ({
        ...skipped,
        candidates: skipped.candidate_ids.flatMap((candidateId) => {
          const candidate = candidateMap.get(candidateId);
          return candidate ? [candidate] : [];
        }),
      }),
    ),
    errors: [...new Set([...project.errors, ...(manifest?.errors ?? [])])],
    ignored_errors: manifest?.partial_finalization?.ignored_errors ?? [],
    ...(manifest?.partial_finalization?.finalized_at
      ? {
          partial_finalized_at: manifest.partial_finalization.finalized_at,
        }
      : {}),
    review_revision: stale ? 0 : (sidecar?.revision ?? 0),
    manifest_fingerprint: fingerprint,
    review_stale: stale,
    review_enabled: reviewEnabled,
    apply_enabled:
      reviewEnabled &&
      !batchActive &&
      operations.length > 0 &&
      pending === 0 &&
      sidecar?.status !== 'applied',
    ...(sidecar?.applied_at ? { applied_at: sidecar.applied_at } : {}),
  };
}

export async function listHistoryReviewBatches(): Promise<
  HistoryReviewBatchSummary[]
> {
  let files: string[];
  try {
    files = (readdirGroupPathSync(batchRoot()) ?? []).map(
      (entry) => entry.name,
    );
  } catch (error) {
    if (!(error instanceof GroupFsError)) throw error;
    logger.warn({ err: error }, 'Skipping unreadable history batch directory');
    return [];
  }
  return files
    .filter((file) => BATCH_PATTERN.test(file))
    .flatMap((id) => {
      try {
        const batch = readProjectHistoryBatch(path.join(batchRoot(), id));
        if (batch.batch_version !== PROJECT_HISTORY_BATCH_VERSION) return [];
        let pendingOperations = 0;
        let reviewedOperations = 0;
        let resolutionErrors = 0;
        for (const project of batch.projects) {
          try {
            const resolved = resolveProjectManifest(batch, project.project_id);
            const reviewPath = sidecarPath(resolved.path);
            const sidecar = resolved.manifest
              ? readSidecar(reviewPath, id, project.project_id)
              : null;
            const view = projectView(
              id,
              batch,
              project,
              resolved.manifest,
              sidecar,
            );
            pendingOperations += view.counts.pending;
            reviewedOperations += view.counts.approved + view.counts.rejected;
          } catch {
            // Keep a partially stale batch visible in the list instead of
            // misleading the administrator with an empty batch screen. An
            // applied project is already counted as applied.
            if (project.status !== 'applied') resolutionErrors++;
          }
        }
        return [
          {
            id,
            created_at: batch.created_at,
            cutoff_at: batch.cutoff_at,
            ...batchSummaryMetadata(batch),
            status: batch.status,
            projects: batch.projects.length,
            ready: batch.projects.filter(
              (project) => project.status === 'preview',
            ).length,
            applied: batch.projects.filter(
              (project) => project.status === 'applied',
            ).length,
            errors:
              batch.projects.filter((project) => project.status === 'error')
                .length + resolutionErrors,
            pending_operations: pendingOperations,
            reviewed_operations: reviewedOperations,
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getHistoryReviewBatch(batchId: string): Promise<{
  batch: HistoryReviewBatchSummary;
  projects: HistoryReviewProjectView[];
}> {
  const { manifest } = resolveBatch(batchId);
  const projects = manifest.projects.map((project) => {
    let resolved: ReturnType<typeof resolveProjectManifest>;
    try {
      resolved = resolveProjectManifest(manifest, project.project_id);
    } catch (error) {
      if (!(error instanceof HistoryReviewError)) throw error;
      // An applied project stays applied when its project or manifest can no
      // longer be resolved; the applied work is not an error.
      if (project.status === 'applied') {
        return projectView(batchId, manifest, project, null, null);
      }
      return projectView(
        batchId,
        manifest,
        {
          ...project,
          status: 'error',
          errors: [...new Set([...project.errors, error.message])],
        },
        null,
        null,
      );
    }
    const reviewPath = sidecarPath(resolved.path);
    const sidecar = resolved.manifest
      ? readSidecar(reviewPath, batchId, project.project_id)
      : null;
    return projectView(batchId, manifest, project, resolved.manifest, sidecar);
  });
  return {
    batch: {
      id: batchId,
      created_at: manifest.created_at,
      cutoff_at: manifest.cutoff_at,
      ...batchSummaryMetadata(manifest),
      status: manifest.status,
      projects: projects.length,
      ready: projects.filter((project) => project.project_status === 'preview')
        .length,
      applied: projects.filter(
        (project) => project.project_status === 'applied',
      ).length,
      errors: projects.filter((project) => project.project_status === 'error')
        .length,
      pending_operations: projects.reduce(
        (sum, project) => sum + project.counts.pending,
        0,
      ),
      reviewed_operations: projects.reduce(
        (sum, project) =>
          sum + project.counts.approved + project.counts.rejected,
        0,
      ),
    },
    projects,
  };
}

export async function acceptPartialHistoryReviewBatch(
  batchId: string,
): Promise<Awaited<ReturnType<typeof getHistoryReviewBatch>>> {
  const initial = resolveBatch(batchId);
  const lease = acquireProjectHistoryBatchLease(initial.path);
  try {
    const resolvedBatch = resolveBatch(batchId);
    const batch = resolvedBatch.manifest;
    if (batch.status === 'previewing' || batch.status === 'applying') {
      throw new HistoryReviewError(
        409,
        'The batch writer is still active; wait for it to exit before ignoring errors',
      );
    }
    if (batch.status === 'applied') {
      throw new HistoryReviewError(409, 'The batch is already applied');
    }

    for (const project of batch.projects) {
      if (project.status !== 'error' && project.status !== 'pending') continue;
      let resolved: ReturnType<typeof resolveProjectManifest>;
      try {
        resolved = resolveProjectManifest(batch, project.project_id);
      } catch (error) {
        if (!(error instanceof HistoryReviewError)) throw error;
        project.errors = [...new Set([...project.errors, error.message])];
        project.status = 'error';
        continue;
      }
      if (!resolved.manifest) {
        project.errors = [
          ...new Set([
            ...project.errors,
            'No reflection checkpoint exists for this project',
          ]),
        ];
        project.status = 'error';
        continue;
      }
      try {
        const timeline = await getMemoryTimeline(project.project_id);
        const finalized = finalizePartialHistoryReflectionManifest(
          {
            ...resolved.manifest,
            errors: [
              ...new Set([...resolved.manifest.errors, ...project.errors]),
            ],
          },
          timeline,
          new Date().toISOString(),
          { allowBaselineRebase: true },
        );
        writeHistoryManifest(resolved.path, finalized);
        project.review_fingerprint = historyReviewFingerprint(finalized);
        project.candidates = allCandidates(finalized).length;
        project.memory_ops = finalized.envelope.memory_ops.length;
        project.skipped_candidates =
          finalized.envelope.skipped_candidates.length;
        project.errors = [];
        project.status = 'preview';
        project.partial_finalized_at =
          finalized.partial_finalization!.finalized_at;
      } catch (error) {
        project.errors = [
          ...new Set([
            ...project.errors,
            error instanceof Error ? error.message : String(error),
          ]),
        ];
        project.status = 'error';
      }
    }

    const failed = batch.projects.filter(
      (project) => project.status === 'error',
    );
    batch.errors = failed.map(
      (project) => `${project.project_id}: ${project.errors.join('; ')}`,
    );
    batch.status = failed.length > 0 ? 'error' : 'preview';
    writeProjectHistoryBatch(resolvedBatch.path, batch);
  } finally {
    lease.release();
  }
  return getHistoryReviewBatch(batchId);
}

export async function getHistoryReviewProject(
  batchId: string,
  projectId: string,
): Promise<HistoryReviewProjectView> {
  const { manifest: batch } = resolveBatch(batchId);
  const resolved = resolveProjectManifest(batch, projectId);
  const reviewPath = sidecarPath(resolved.path);
  const sidecar = resolved.manifest
    ? readSidecar(reviewPath, batchId, projectId)
    : null;
  return projectView(
    batchId,
    batch,
    resolved.project,
    resolved.manifest,
    sidecar,
  );
}

async function updateHistoryReviewItemUnlocked(
  batchId: string,
  projectId: string,
  itemId: string,
  input: UpdateHistoryReviewInput,
): Promise<HistoryReviewProjectView> {
  const { manifest: batch } = resolveBatch(batchId);
  const resolved = resolveProjectManifest(batch, projectId);
  if (
    resolved.project.status !== 'preview' ||
    !resolved.manifest ||
    resolved.manifest.errors.length > 0
  ) {
    throw new HistoryReviewError(
      409,
      'Project preview is not ready for review',
    );
  }
  const fingerprint = historyReviewFingerprint(resolved.manifest);
  const reviewPath = sidecarPath(resolved.path);
  const existing =
    readSidecar(reviewPath, batchId, projectId) ??
    emptySidecar(batchId, projectId, fingerprint);
  if (existing.manifest_fingerprint !== fingerprint) {
    throw new HistoryReviewError(
      409,
      'Reflection manifest changed; reset the stale review',
    );
  }
  if (existing.status === 'applied') {
    throw new HistoryReviewError(409, 'Project review is already applied');
  }
  if (input.revision !== existing.revision) {
    throw new HistoryReviewError(409, 'Review revision changed; reload');
  }
  const original = resolved.manifest.envelope.memory_ops.find(
    (operation) => historyReviewOperationId(operation) === itemId,
  );
  if (!original) {
    throw new HistoryReviewError(404, 'History operation not found');
  }
  if (
    input.decision !== 'pending' &&
    input.decision !== 'approved' &&
    input.decision !== 'rejected'
  ) {
    throw new HistoryReviewError(400, 'Invalid review decision');
  }
  const decisions = { ...existing.decisions };
  if (input.decision === 'pending') {
    delete decisions[itemId];
  } else if (input.decision === 'rejected') {
    decisions[itemId] = {
      decision: 'rejected',
      mark_for_eval: false,
      reviewed_by: input.reviewer,
      reviewed_at: new Date().toISOString(),
    };
  } else {
    const edits = validateHistoryReviewEdits(
      original,
      input.edits,
      resolved.manifest.cutoff_at,
    );
    const requestedTarget =
      input.target_project_id ?? decisions[itemId]?.target_project_id;
    const targetProjectId = requestedTarget?.trim() || projectId;
    if (!getGroupEntryByFolder(targetProjectId)) {
      throw new HistoryReviewError(400, 'Destination project does not exist');
    }
    if (
      targetProjectId !== projectId &&
      (original.op !== 'create' || !!original.precedes_id)
    ) {
      throw new HistoryReviewError(
        400,
        'Only standalone create operations can move to another project',
      );
    }
    decisions[itemId] = {
      decision: 'approved',
      mark_for_eval:
        original.op === 'forget' ? false : input.mark_for_eval === true,
      ...(targetProjectId !== projectId
        ? { target_project_id: targetProjectId }
        : {}),
      ...(edits ? { edits } : {}),
      reviewed_by: input.reviewer,
      reviewed_at: new Date().toISOString(),
    };
  }
  const updated: HistoryReviewSidecar = {
    ...existing,
    decisions,
    revision: existing.revision + 1,
    updated_at: new Date().toISOString(),
  };
  atomicWriteJson(reviewPath, updated);
  return projectView(
    batchId,
    batch,
    resolved.project,
    resolved.manifest,
    updated,
  );
}

export async function updateHistoryReviewItem(
  batchId: string,
  projectId: string,
  itemId: string,
  input: UpdateHistoryReviewInput,
): Promise<HistoryReviewProjectView> {
  return withHistoryReviewLock(batchId, projectId, () =>
    updateHistoryReviewItemUnlocked(batchId, projectId, itemId, input),
  );
}

async function resetHistoryReviewUnlocked(
  batchId: string,
  projectId: string,
): Promise<HistoryReviewProjectView> {
  const { manifest: batch } = resolveBatch(batchId);
  const resolved = resolveProjectManifest(batch, projectId);
  if (!resolved.manifest) {
    throw new HistoryReviewError(409, 'Project preview does not exist');
  }
  const reviewPath = sidecarPath(resolved.path);
  removeGroupPathSync(reviewPath);
  return projectView(batchId, batch, resolved.project, resolved.manifest, null);
}

export async function resetHistoryReview(
  batchId: string,
  projectId: string,
): Promise<HistoryReviewProjectView> {
  return withHistoryReviewLock(batchId, projectId, () =>
    resetHistoryReviewUnlocked(batchId, projectId),
  );
}

/**
 * Adds the existing memory that each supersede, invalidate or forget proposal
 * acts on, so a reviewer sees what they approve. Only a currently valid memory
 * of the view's own project is attached; anything else becomes `null`.
 */
export async function attachHistoryReviewTargets(
  view: HistoryReviewProjectView,
): Promise<HistoryReviewProjectView> {
  const targetIds = new Set<string>();
  for (const operation of view.operations) {
    const targetId = historyOpTargetId(operation.operation);
    if (targetId) targetIds.add(targetId);
  }
  const targets = new Map<string, HistoryReviewTargetMemory | null>();
  await Promise.all(
    [...targetIds].map(async (id) => {
      try {
        const memory = await getMemory(id);
        if (
          memory &&
          memory.group_folder === view.project_id &&
          !memory.valid_to &&
          !memory.superseded_by
        ) {
          targets.set(id, {
            id: memory.id,
            content: memory.content,
            memory_type: memory.memory_type,
            valid_from: memory.valid_from ?? memory.created_at,
          });
        } else {
          targets.set(id, null);
        }
      } catch (error) {
        logger.warn(
          { err: error, memoryId: id, projectId: view.project_id },
          'History review target memory lookup failed',
        );
      }
    }),
  );
  return {
    ...view,
    operations: view.operations.map((operation) => {
      const targetId = historyOpTargetId(operation.operation);
      if (!targetId || !targets.has(targetId)) return operation;
      return { ...operation, target_memory: targets.get(targetId) };
    }),
  };
}

export function buildReviewedHistoryManifest(
  original: HistoryReflectionManifest,
  sidecar: HistoryReviewSidecar,
): HistoryReflectionManifest {
  const operations: HistoryMemoryOp[] = [];
  const rejected = [];
  for (const operation of original.envelope.memory_ops) {
    const itemId = historyReviewOperationId(operation);
    const decision = sidecar.decisions[itemId];
    if (!decision) {
      throw new HistoryReviewError(
        409,
        'Every proposed operation must be approved or rejected',
      );
    }
    if (decision.decision === 'approved') {
      if (
        decision.target_project_id &&
        decision.target_project_id !== original.project_id
      ) {
        if (operation.op !== 'create' || operation.precedes_id) {
          throw new HistoryReviewError(
            409,
            'Only standalone create operations can move to another project',
          );
        }
        rejected.push({
          candidate_ids: operation.candidate_ids,
          reason: `human-moved-to:${decision.target_project_id}`,
        });
      } else {
        operations.push(editableOperation(operation, decision.edits));
      }
    } else {
      rejected.push({
        candidate_ids: operation.candidate_ids,
        reason: 'human-rejected',
      });
    }
  }
  const creatorById = new Map(
    original.envelope.memory_ops.flatMap((operation) =>
      operation.op === 'create' || operation.op === 'supersede'
        ? [[operation.new_memory_id, operation] as const]
        : [],
    ),
  );
  const retainedIds = new Set(
    operations.flatMap((operation) =>
      operation.op === 'create' || operation.op === 'supersede'
        ? [operation.new_memory_id]
        : [],
    ),
  );
  const plannedIds = new Set([
    ...original.conversations.flatMap((conversation) =>
      conversation.candidates.map((candidate) => candidate.planned_memory_id),
    ),
    ...original.memory_files.flatMap((file) =>
      file.candidates.map((candidate) => candidate.planned_memory_id),
    ),
  ]);
  const resolveReference = (
    id: string,
    direction: 'predecessor' | 'successor',
    seen = new Set<string>(),
  ): string | undefined => {
    if (retainedIds.has(id)) return id;
    if (!creatorById.has(id)) return plannedIds.has(id) ? undefined : id;
    if (seen.has(id)) {
      throw new HistoryReviewError(
        409,
        `Reviewed memory operations contain a dependency cycle at ${id}`,
      );
    }
    seen.add(id);
    const omitted = creatorById.get(id)!;
    const next =
      direction === 'predecessor'
        ? omitted.op === 'supersede'
          ? omitted.supersedes_id
          : undefined
        : omitted.precedes_id;
    return next ? resolveReference(next, direction, seen) : undefined;
  };
  const rebasedOperations = operations.map((operation): HistoryMemoryOp => {
    if (operation.op === 'create') {
      const precedesId = operation.precedes_id
        ? resolveReference(operation.precedes_id, 'successor')
        : undefined;
      const { precedes_id: _precedesId, ...rest } = operation;
      return { ...rest, ...(precedesId ? { precedes_id: precedesId } : {}) };
    }
    if (operation.op !== 'supersede') return operation;
    const supersedesId = resolveReference(
      operation.supersedes_id,
      'predecessor',
    );
    const precedesId = operation.precedes_id
      ? resolveReference(operation.precedes_id, 'successor')
      : undefined;
    if (!supersedesId) {
      return {
        op: 'create',
        candidate_ids: operation.candidate_ids,
        new_memory_id: operation.new_memory_id,
        memory_type: operation.memory_type,
        content: operation.correction_content,
        valid_from: operation.valid_from,
        importance: operation.importance,
        tags: operation.tags,
        ...(precedesId ? { precedes_id: precedesId } : {}),
      };
    }
    const {
      supersedes_id: _supersedesId,
      precedes_id: _precedesId,
      ...rest
    } = operation;
    return {
      ...rest,
      supersedes_id: supersedesId,
      ...(precedesId ? { precedes_id: precedesId } : {}),
    };
  });
  return {
    ...structuredClone(original),
    created_at: new Date().toISOString(),
    envelope: {
      memory_ops: rebasedOperations,
      skipped_candidates: [
        ...original.envelope.skipped_candidates,
        ...rejected,
      ],
    },
    errors: [],
    status: 'preview',
    applied_at: undefined,
  };
}

export interface HistoryMemoryEvalRecord {
  schema_version: 1;
  id: string;
  project_id: string;
  memory_id: string;
  operation: 'create' | 'supersede' | 'invalidate';
  expected_content: string | null;
  prior_content: string | null;
  effective_at: string;
  candidate_ids: string[];
  evidence: HistoryReviewEvidence[];
  manifest_fingerprint: string;
  reviewed_by: string;
  reviewed_at: string;
  applied_at: string;
}

function evalFilePath(projectId: string): string {
  return path.join(
    getGroupDir(projectId),
    '.agent',
    'evals',
    'history-memory.jsonl',
  );
}

export function readHistoryMemoryEvalRecords(
  projectId: string,
): HistoryMemoryEvalRecord[] {
  const filePath = evalFilePath(projectId);
  let raw: string;
  try {
    const read = readGroupFileSync(filePath, {
      maxBytes: MAX_MEMORY_STATE_BYTES,
    });
    if (!read) return [];
    raw = read.data.toString('utf8');
  } catch (error) {
    // A linked, oversized or non-regular (FIFO) journal reads as empty; this
    // runs on every memories GET and must neither block nor throw.
    if (!(error instanceof GroupFsError)) throw error;
    logger.warn({ err: error, projectId }, 'Skipping unreadable eval journal');
    return [];
  }
  const records: HistoryMemoryEvalRecord[] = [];
  let malformed = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as HistoryMemoryEvalRecord;
      if (record?.id && record.project_id === projectId) records.push(record);
    } catch {
      malformed = true;
    }
  }
  if (malformed)
    logger.warn({ projectId }, 'Skipping malformed eval journal lines');
  return records;
}

function replaceHistoryMemoryEvalRecords(
  projectId: string,
  records: HistoryMemoryEvalRecord[],
): void {
  const filePath = evalFilePath(projectId);
  const body = records
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((record) => JSON.stringify(record))
    .join('\n');
  writeGroupFileSync(filePath, body ? `${body}\n` : '', { mkdirs: true });
}

export function historyMemoryEvalMarkedIds(projectId: string): Set<string> {
  return new Set(
    readHistoryMemoryEvalRecords(projectId).map((record) => record.memory_id),
  );
}

/** Mark or unmark an already-stored memory in the same eval corpus as imports. */
export function setHistoryMemoryEvalMark(
  projectId: string,
  memory: Memory,
  marked: boolean,
  reviewer: string,
): void {
  const records = readHistoryMemoryEvalRecords(projectId);
  if (!marked) {
    if (!records.some((record) => record.memory_id === memory.id)) return;
    replaceHistoryMemoryEvalRecords(
      projectId,
      records.filter((record) => record.memory_id !== memory.id),
    );
    return;
  }

  const now = new Date().toISOString();
  let found = false;
  const updated = records.map((record) => {
    if (record.memory_id !== memory.id) return record;
    found = true;
    return {
      ...record,
      expected_content: memory.content,
      effective_at: memory.valid_from ?? memory.created_at,
      reviewed_by: reviewer,
      reviewed_at: now,
    };
  });
  if (!found) {
    updated.push({
      schema_version: 1,
      id: `history-eval-manual-${sha256Hex(`${projectId}:${memory.id}`).slice(0, 24)}`,
      project_id: projectId,
      memory_id: memory.id,
      operation: 'create',
      expected_content: memory.content,
      prior_content: null,
      effective_at: memory.valid_from ?? memory.created_at,
      candidate_ids: [],
      evidence: [],
      manifest_fingerprint: `manual-existing:${sha256Hex(`${memory.id}:${memory.updated_at}`)}`,
      reviewed_by: reviewer,
      reviewed_at: now,
      applied_at: now,
    });
  }
  replaceHistoryMemoryEvalRecords(projectId, updated);
}

function writeHistoryMemoryEvalRecords(
  projectId: string,
  records: HistoryMemoryEvalRecord[],
): void {
  if (records.length === 0) return;
  const byId = new Map<string, HistoryMemoryEvalRecord>();
  for (const record of readHistoryMemoryEvalRecords(projectId))
    byId.set(record.id, record);
  for (const record of records) byId.set(record.id, record);
  replaceHistoryMemoryEvalRecords(projectId, [...byId.values()]);
}

async function applyReviewedHistoryProjectUnlocked(
  batchId: string,
  projectId: string,
): Promise<{
  project: HistoryReviewProjectView;
  applied: Awaited<ReturnType<typeof applyHistoryReflectionManifest>>;
}> {
  const resolvedBatch = resolveBatch(batchId);
  const batch = resolvedBatch.manifest;
  if (batch.status === 'previewing' || batch.status === 'applying') {
    throw new HistoryReviewError(
      409,
      'The batch is still being written; wait for preview completion',
    );
  }
  const resolved = resolveProjectManifest(batch, projectId);
  const reviewPath = sidecarPath(resolved.path);
  const existingSidecar = readSidecar(reviewPath, batchId, projectId);
  if (
    resolved.project.status === 'applied' &&
    existingSidecar?.status === 'applied'
  ) {
    return {
      project: projectView(
        batchId,
        batch,
        resolved.project,
        resolved.manifest,
        existingSidecar,
      ),
      applied: {
        alreadyApplied: true,
        applied: {
          created: 0,
          superseded: 0,
          invalidated: 0,
          forgotten: 0,
        },
      },
    };
  }
  if (
    resolved.project.status !== 'preview' ||
    !resolved.manifest ||
    resolved.project.errors.length > 0 ||
    resolved.manifest.errors.length > 0
  ) {
    throw new HistoryReviewError(409, 'Project preview cannot be applied');
  }
  const fingerprint = historyReviewFingerprint(resolved.manifest);
  const sidecar = existingSidecar;
  if (!sidecar) {
    throw new HistoryReviewError(409, 'Project has not been reviewed');
  }
  if (sidecar.manifest_fingerprint !== fingerprint) {
    throw new HistoryReviewError(
      409,
      'Reflection manifest changed; reset the stale review',
    );
  }
  const derived = buildReviewedHistoryManifest(resolved.manifest, sidecar);
  const candidateMap = candidatesById(resolved.manifest);
  const sourceCandidates = allCandidates(resolved.manifest);
  const relocatedCreates = resolved.manifest.envelope.memory_ops.flatMap(
    (original) => {
      const decision = sidecar.decisions[historyReviewOperationId(original)];
      if (
        decision?.decision !== 'approved' ||
        !decision.target_project_id ||
        decision.target_project_id === projectId
      ) {
        return [];
      }
      const operation = editableOperation(original, decision.edits);
      if (operation.op !== 'create' || operation.precedes_id) {
        throw new HistoryReviewError(
          409,
          'Only standalone create operations can move to another project',
        );
      }
      return [
        {
          targetProjectId: decision.target_project_id,
          operation,
        },
      ];
    },
  );
  const priorByItem = new Map<string, string | null>();
  for (const operation of derived.envelope.memory_ops) {
    if (operation.op === 'supersede' || operation.op === 'invalidate') {
      const targetId =
        operation.op === 'supersede'
          ? operation.supersedes_id
          : operation.memory_id;
      priorByItem.set(
        historyReviewOperationId(operation),
        (await getMemory(targetId))?.content ?? null,
      );
    }
  }
  const privacyCheckpointAt = historyPrivacyCheckpoint(resolved.manifest);
  // Preflight pending relocations before any writes. Existing IDs are verified
  // by applyRelocatedHistoryCreate under the destination lock; they need no
  // new content write and can be resumed after this apply's own forgets.
  const pendingRelocations = [];
  for (const relocated of relocatedCreates) {
    const existing = await getMemory(relocated.operation.new_memory_id);
    if (existing?.group_folder !== relocated.targetProjectId) {
      pendingRelocations.push(relocated);
    }
  }
  if (pendingRelocations.length > 0) {
    await assertNoPrivacyErasureSince(
      projectId,
      privacyCheckpointAt,
      pendingRelocations.length,
    );
  }
  for (const targetProjectId of new Set(
    pendingRelocations.map((relocated) => relocated.targetProjectId),
  )) {
    await assertNoPrivacyErasureSince(
      targetProjectId,
      privacyCheckpointAt,
      pendingRelocations.filter(
        (relocated) => relocated.targetProjectId === targetProjectId,
      ).length,
    );
  }
  const relocationResults = [];
  for (const relocated of relocatedCreates) {
    // Acquire both locks in a stable order so opposite-direction relocations
    // cannot deadlock. Recheck the source before any new content write.
    const [first, second] = [projectId, relocated.targetProjectId].sort();
    const result = await withMemoryLifecycleLock(first!, () =>
      withMemoryLifecycleLock(second!, async () => {
        const existing = await getMemory(relocated.operation.new_memory_id);
        if (existing?.group_folder !== relocated.targetProjectId) {
          await assertNoPrivacyErasureSince(projectId, privacyCheckpointAt, 1);
        }
        return applyRelocatedHistoryCreate(
          relocated.targetProjectId,
          relocated.operation,
          sourceCandidates,
          privacyCheckpointAt,
        );
      }),
    );
    relocationResults.push(result);
  }
  const sourceApply = await applyHistoryReflectionManifest(derived, {
    // Human review can take hours or days. Unrelated memories may be written in
    // that time, including approved creates moved in from another project in
    // this batch. Reparse and validate the reviewed operations against the
    // current timeline instead of discarding the review wholesale.
    allowBaselineRebase: true,
    // Once an administrator has reviewed the stored proposals, importing
    // those exact decisions must not be blocked by source transcript drift.
    trustStoredSources: true,
  });
  const applied = {
    alreadyApplied: sourceApply.alreadyApplied,
    baselineRebased: sourceApply.baselineRebased,
    applied: { ...sourceApply.applied },
  };
  for (const result of relocationResults) {
    applied.alreadyApplied = applied.alreadyApplied && result.alreadyApplied;
    applied.applied.created += result.applied.created;
  }
  const appliedAt = new Date().toISOString();
  const evalRecordsByProject = new Map<string, HistoryMemoryEvalRecord[]>();
  for (const original of resolved.manifest.envelope.memory_ops) {
    if (original.op === 'forget') continue;
    const itemId = historyReviewOperationId(original);
    const decision = sidecar.decisions[itemId];
    if (decision?.decision !== 'approved' || !decision.mark_for_eval) {
      continue;
    }
    const operation = editableOperation(original, decision.edits);
    if (operation.op === 'forget') continue;
    const targetProjectId = decision.target_project_id ?? projectId;
    const evalRecord: HistoryMemoryEvalRecord = {
      schema_version: 1,
      id: `history-eval-${sha256Hex(`${fingerprint}:${itemId}:${targetProjectId}`).slice(0, 24)}`,
      project_id: targetProjectId,
      memory_id:
        operation.op === 'create' || operation.op === 'supersede'
          ? operation.new_memory_id
          : operation.memory_id,
      operation: operation.op,
      expected_content:
        operation.op === 'create'
          ? operation.content
          : operation.op === 'supersede'
            ? operation.correction_content
            : null,
      prior_content: priorByItem.get(itemId) ?? null,
      effective_at:
        operation.op === 'invalidate'
          ? operation.effective_at
          : operation.valid_from,
      candidate_ids: operation.candidate_ids,
      evidence: evidenceFor(operation, candidateMap),
      manifest_fingerprint: fingerprint,
      reviewed_by: decision.reviewed_by,
      reviewed_at: decision.reviewed_at,
      applied_at: appliedAt,
    };
    const records = evalRecordsByProject.get(targetProjectId) ?? [];
    records.push(evalRecord);
    evalRecordsByProject.set(targetProjectId, records);
  }
  for (const [targetProjectId, records] of evalRecordsByProject) {
    writeHistoryMemoryEvalRecords(targetProjectId, records);
  }

  const appliedSidecar: HistoryReviewSidecar = {
    ...sidecar,
    status: 'applied',
    applied_at: appliedAt,
    updated_at: appliedAt,
    revision: sidecar.revision + 1,
  };
  const lease = acquireProjectHistoryBatchLease(resolvedBatch.path);
  let updatedBatch: ProjectHistoryBatchManifest;
  let updatedProject: ProjectHistoryBatchProject;
  try {
    const current = resolveBatch(batchId);
    updatedBatch = current.manifest;
    const project = updatedBatch.projects.find(
      (item) => item.project_id === projectId,
    );
    if (!project)
      throw new HistoryReviewError(404, 'Project is not part of this batch');
    updatedProject = project;
    updatedProject.status = 'applied';
    updatedProject.applied_at = appliedAt;
    if (
      updatedBatch.projects.every(
        (item) => item.status === 'applied' || item.status === 'error',
      )
    ) {
      updatedBatch.status = updatedBatch.projects.some(
        (item) => item.status === 'error',
      )
        ? 'error'
        : 'applied';
      if (updatedBatch.status === 'applied')
        updatedBatch.applied_at = appliedAt;
    }
    atomicWriteJson(reviewPath, appliedSidecar);
    writeProjectHistoryBatch(current.path, updatedBatch);
  } finally {
    lease.release();
  }
  return {
    project: projectView(
      batchId,
      updatedBatch,
      updatedProject,
      resolved.manifest,
      appliedSidecar,
    ),
    applied,
  };
}

export async function applyReviewedHistoryProject(
  batchId: string,
  projectId: string,
): Promise<{
  project: HistoryReviewProjectView;
  applied: Awaited<ReturnType<typeof applyHistoryReflectionManifest>>;
}> {
  return withHistoryReviewLock(batchId, projectId, () =>
    applyReviewedHistoryProjectUnlocked(batchId, projectId),
  );
}

export class HistoryReviewError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
