#!/usr/bin/env bun

import fs from 'fs';
import path from 'path';
import { getMemoryTimeline, initDatabase } from '../src/db.js';
import { getGroupDir, setGroupLookup } from '../src/group-dir.js';
import {
  applyHistoryReflectionManifest,
  finalizePartialHistoryReflectionManifest,
  readHistoryManifest,
  refreshAppliedManifest,
  runHistoryReflectionPreview,
  writeHistoryManifest,
} from '../src/modules/memory/history-reflection.js';
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
} from '../src/modules/memory/project-history-reflection-batch.js';
import {
  getGroupByFolder,
  loadState,
  registeredGroups,
} from '../src/state-manager.js';

function usage(): never {
  console.log(`reflect-project-history

Create one high-precision history-reflection preview per registered CarapaBoard
project from verified recovered native memories and imported conversations.
Recovered memories are reconciled first, then conversations are reflected
against that timeline. Preview is the default. Apply consumes only an already-
reviewed batch index and never calls the LLM.

Preview all projects that have either source:
  bun scripts/reflect-project-history.ts [options]

Apply a reviewed batch:
  bun scripts/reflect-project-history.ts --apply <batch-index.json>

Options:
  --project <id>             Restrict preview to one registered project
  --since <date>             Include evidence dated on or after this date
  --until <date>             Include evidence dated on or before this date
  --conversations-only       Exclude recovered native memory files
  --native-memories-only     Exclude conversations
  --resume <batch-index>     Resume/checkpoint an earlier preview batch
  --accept-partial <batch>  Keep checkpoints and skip all unfinished candidates
  --output <batch-index>     Batch index output path
  --observer-agent <id>      Candidate-extraction runtime override
  --reflector-agent <id>     History-reflector runtime override
  --chunk-tokens <number>    Candidate chunk budget (default: 5000)
  --batch-size <number>      Candidates per reflection call (default: 30)
  --apply <batch-index>      Apply exact reviewed project manifests
  --help, -h                 Show this help

The script checkpoints after every project. A native memory file is eligible
only when declared by an import manifest and its SHA-256 still matches.`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) usage();

function valueAfter(flag: string): string | undefined {
  const indexes = args.flatMap((value, index) =>
    value === flag ? [index] : [],
  );
  if (indexes.length === 0) return undefined;
  const index = indexes.at(-1)!;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function dateBoundary(
  value: string | undefined,
  endOfDay = false,
): string | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = Date.parse(
    dateOnly
      ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
      : value,
  );
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return new Date(parsed).toISOString();
}

function positiveInteger(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function defaultBatchPath(createdAt: string): string {
  return path.join(
    getGroupDir('main'),
    'artifacts',
    'history-reflection',
    `project-history-batch-${createdAt.replace(/[:.]/g, '-')}.json`,
  );
}

function projectManifestPath(batchCreatedAt: string): string {
  return path.posix.join(
    'artifacts',
    'history-reflection',
    `project-history-${batchCreatedAt.replace(/[:.]/g, '-')}.json`,
  );
}

const activeBatchLeases: Array<{ release(): void }> = [];

function releaseBatchLeases(): void {
  for (const lease of activeBatchLeases.splice(0).reverse()) lease.release();
}

function acquireBatchLeases(filePaths: string[]): void {
  const acquired: Array<{ release(): void }> = [];
  try {
    for (const filePath of [
      ...new Set(filePaths.map((filePath) => path.resolve(filePath))),
    ].sort()) {
      acquired.push(acquireProjectHistoryBatchLease(filePath));
    }
    activeBatchLeases.push(...acquired);
  } catch (error) {
    for (const lease of acquired.reverse()) lease.release();
    throw error;
  }
}

process.once('exit', releaseBatchLeases);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    releaseBatchLeases();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

function summarizeBatch(batch: ProjectHistoryBatchManifest, filePath: string) {
  return {
    mode: batch.status === 'applied' ? 'apply' : 'preview',
    status: batch.status,
    batch: path.resolve(filePath),
    projects: batch.projects.length,
    ready: batch.projects.filter((project) => project.status === 'preview')
      .length,
    applied: batch.projects.filter((project) => project.status === 'applied')
      .length,
    failed: batch.projects.filter((project) => project.status === 'error')
      .length,
    sourceFiles: batch.projects.reduce(
      (sum, project) => sum + project.memory_file_paths.length,
      0,
    ),
    conversations: batch.projects.reduce(
      (sum, project) => sum + project.conversation_count,
      0,
    ),
    candidates: batch.projects.reduce(
      (sum, project) => sum + project.candidates,
      0,
    ),
    memoryOps: batch.projects.reduce(
      (sum, project) => sum + project.memory_ops,
      0,
    ),
    skippedCandidates: batch.projects.reduce(
      (sum, project) => sum + project.skipped_candidates,
      0,
    ),
    errors: batch.errors,
    partialProjects: batch.projects.filter(
      (project) => project.partial_finalized_at,
    ).length,
    projectResults: batch.projects.map((project) => ({
      project: project.project_id,
      status: project.status,
      manifests: project.import_manifests.length,
      sourceFiles: project.memory_file_paths.length,
      conversations: project.conversation_count,
      candidates: project.candidates,
      memoryOps: project.memory_ops,
      skippedCandidates: project.skipped_candidates,
      reflectionManifest: project.reflection_manifest,
      errors: project.errors,
    })),
    applyCommand:
      batch.status === 'preview' && batch.errors.length === 0
        ? `bun scripts/reflect-project-history.ts --apply ${JSON.stringify(
            path.resolve(filePath),
          )}`
        : null,
    acceptPartialCommand:
      batch.status === 'error'
        ? `bun scripts/reflect-project-history.ts --accept-partial ${JSON.stringify(
            path.resolve(filePath),
          )}`
        : null,
  };
}

await initDatabase();
await loadState();
setGroupLookup((folder) => getGroupByFolder(folder));

const applyPath = valueAfter('--apply');
const acceptPartialPath = valueAfter('--accept-partial');
if (applyPath && acceptPartialPath) {
  throw new Error('--apply and --accept-partial are mutually exclusive');
}

if (acceptPartialPath) {
  const batchPath = path.resolve(acceptPartialPath);
  acquireBatchLeases([batchPath]);
  const batch = readProjectHistoryBatch(batchPath);
  if (batch.batch_version !== PROJECT_HISTORY_BATCH_VERSION) {
    throw new Error('Unsupported project-history batch version');
  }
  if (batch.status === 'applying' || batch.status === 'applied') {
    throw new Error(`Cannot finalize a ${batch.status} batch as partial`);
  }

  batch.status = 'previewing';
  batch.errors = [];
  writeProjectHistoryBatch(batchPath, batch);
  for (const project of batch.projects) {
    if (project.status === 'preview' || project.status === 'applied') continue;
    try {
      const manifestPath = resolveProjectHistoryManifestPath(project);
      if (!fs.existsSync(manifestPath)) {
        throw new Error('No reflection checkpoint exists for this project');
      }
      const reflection = readHistoryManifest(manifestPath);
      const timeline = await getMemoryTimeline(project.project_id);
      const finalized = finalizePartialHistoryReflectionManifest(
        {
          ...reflection,
          errors: [...new Set([...reflection.errors, ...project.errors])],
        },
        timeline,
        new Date().toISOString(),
        { allowBaselineRebase: true },
      );
      writeHistoryManifest(manifestPath, finalized);
      project.review_fingerprint = historyReviewFingerprint(finalized);
      project.candidates =
        finalized.memory_files.reduce(
          (sum, file) => sum + file.candidates.length,
          0,
        ) +
        finalized.conversations.reduce(
          (sum, conversation) => sum + conversation.candidates.length,
          0,
        );
      project.memory_ops = finalized.envelope.memory_ops.length;
      project.skipped_candidates = finalized.envelope.skipped_candidates.length;
      project.errors = [];
      project.status = 'preview';
      project.partial_finalized_at =
        finalized.partial_finalization!.finalized_at;
      console.error(
        `[project-history] ${project.project_id}: accepted partial preview, retained ${project.memory_ops} operations and skipped ${finalized.partial_finalization!.skipped_candidates} unfinished candidates`,
      );
    } catch (error) {
      project.status = 'error';
      project.errors = [
        ...new Set([
          ...project.errors,
          error instanceof Error ? error.message : String(error),
        ]),
      ];
    }
    writeProjectHistoryBatch(batchPath, batch);
  }

  const failed = batch.projects.filter((project) => project.status === 'error');
  batch.status = failed.length > 0 ? 'error' : 'preview';
  batch.errors = failed.map(
    (project) => `${project.project_id}: ${project.errors.join('; ')}`,
  );
  writeProjectHistoryBatch(batchPath, batch);
  console.log(JSON.stringify(summarizeBatch(batch, batchPath), null, 2));
  if (failed.length > 0) process.exitCode = 2;
  process.exit();
}

if (applyPath) {
  const batchPath = path.resolve(applyPath);
  acquireBatchLeases([batchPath]);
  const batch = readProjectHistoryBatch(batchPath);
  if (batch.batch_version !== PROJECT_HISTORY_BATCH_VERSION) {
    throw new Error('Unsupported project-history batch version');
  }
  if (
    batch.errors.length > 0 ||
    batch.projects.some(
      (project) =>
        project.errors.length > 0 ||
        (project.status !== 'preview' && project.status !== 'applied'),
    )
  ) {
    throw new Error(
      'Batch contains preview/discovery errors and cannot be applied',
    );
  }

  const discoveries = await discoverProjectHistory(
    Object.values(registeredGroups),
    {
      projectFilter: batch.filters.project ?? undefined,
      includeConversations: batch.filters.sources.conversations,
      includeNativeMemories: batch.filters.sources.native_memories,
      since: batch.filters.since ?? undefined,
      until: batch.filters.until ?? undefined,
      cutoffAt: batch.cutoff_at,
    },
  );
  const discoveryByProject = new Map(
    discoveries.map((discovery) => [discovery.project_id, discovery]),
  );
  const expectedProjectIds = batch.projects
    .map((project) => project.project_id)
    .sort();
  const currentProjectIds = discoveries
    .map((discovery) => discovery.project_id)
    .sort();
  if (
    JSON.stringify(expectedProjectIds) !== JSON.stringify(currentProjectIds)
  ) {
    throw new Error(
      'Project history source inventory changed; generate a new preview',
    );
  }

  // Validate every source and reviewed project manifest before applying any.
  for (const project of batch.projects) {
    const discovery = discoveryByProject.get(project.project_id);
    if (
      !discovery ||
      discovery.errors.length > 0 ||
      discovery.source_fingerprint !== project.source_fingerprint ||
      discovery.conversation_count !== project.conversation_count ||
      JSON.stringify(discovery.sources) !== JSON.stringify(project.sources) ||
      JSON.stringify(discovery.import_manifests) !==
        JSON.stringify(project.import_manifests) ||
      JSON.stringify(discovery.memory_file_paths) !==
        JSON.stringify(project.memory_file_paths)
    ) {
      throw new Error(
        `History sources changed for ${project.project_id}; generate a new preview`,
      );
    }
    const reflection = readHistoryManifest(
      resolveProjectHistoryManifestPath(project),
    );
    if (
      !project.review_fingerprint ||
      historyReviewFingerprint(reflection) !== project.review_fingerprint
    ) {
      throw new Error(
        `Reviewed reflection manifest changed for ${project.project_id}`,
      );
    }
  }

  batch.status = 'applying';
  batch.errors = [];
  writeProjectHistoryBatch(batchPath, batch);
  for (const project of batch.projects) {
    if (project.status === 'applied') continue;
    try {
      const manifestPath = resolveProjectHistoryManifestPath(project);
      const reflection = readHistoryManifest(manifestPath);
      await applyHistoryReflectionManifest(reflection);
      await refreshAppliedManifest(manifestPath, reflection);
      project.status = 'applied';
      project.applied_at = new Date().toISOString();
    } catch (error) {
      project.status = 'error';
      project.errors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
    writeProjectHistoryBatch(batchPath, batch);
  }
  const failed = batch.projects.filter((project) => project.status === 'error');
  batch.status = failed.length > 0 ? 'error' : 'applied';
  batch.errors = failed.map(
    (project) => `${project.project_id}: ${project.errors.join('; ')}`,
  );
  if (batch.status === 'applied') batch.applied_at = new Date().toISOString();
  writeProjectHistoryBatch(batchPath, batch);
  console.log(JSON.stringify(summarizeBatch(batch, batchPath), null, 2));
  if (failed.length > 0) process.exitCode = 2;
  process.exit();
}

const projectFilter = valueAfter('--project');
if (projectFilter && !getGroupByFolder(projectFilter)) {
  throw new Error(`Unknown project "${projectFilter}"`);
}
const conversationsOnly = args.includes('--conversations-only');
const nativeMemoriesOnly = args.includes('--native-memories-only');
if (conversationsOnly && nativeMemoriesOnly) {
  throw new Error(
    '--conversations-only and --native-memories-only are mutually exclusive',
  );
}
const sourceFilters = {
  conversations: !nativeMemoriesOnly,
  native_memories: !conversationsOnly,
};
const since = dateBoundary(valueAfter('--since'));
const until = dateBoundary(valueAfter('--until'), true);
if (since && until && since > until) {
  throw new Error('--since must not be after --until');
}
const observerAgent = valueAfter('--observer-agent') ?? null;
const reflectorAgent = valueAfter('--reflector-agent') ?? null;
const chunkTokens = positiveInteger(
  valueAfter('--chunk-tokens'),
  '--chunk-tokens',
);
const reflectionBatchSize = positiveInteger(
  valueAfter('--batch-size'),
  '--batch-size',
);
const resumePath = valueAfter('--resume');
const outputPath = valueAfter('--output');
const initialCreatedAt = new Date().toISOString();
const resolvedResumePath = resumePath ? path.resolve(resumePath) : undefined;
const prospectiveBatchPath = path.resolve(
  outputPath ?? resolvedResumePath ?? defaultBatchPath(initialCreatedAt),
);
acquireBatchLeases(
  resolvedResumePath
    ? [resolvedResumePath, prospectiveBatchPath]
    : [prospectiveBatchPath],
);
const priorBatch = resolvedResumePath
  ? readProjectHistoryBatch(resolvedResumePath)
  : undefined;
if (
  priorBatch &&
  (priorBatch.batch_version !== PROJECT_HISTORY_BATCH_VERSION ||
    priorBatch.filters.project !== (projectFilter ?? null) ||
    priorBatch.filters.since !== (since ?? null) ||
    priorBatch.filters.until !== (until ?? null) ||
    JSON.stringify(priorBatch.filters.sources) !==
      JSON.stringify(sourceFilters) ||
    priorBatch.agents.observer !== observerAgent ||
    priorBatch.agents.reflector !== reflectorAgent)
) {
  throw new Error('Resume batch options do not match this preview');
}

const createdAt = priorBatch?.created_at ?? initialCreatedAt;
const cutoffAt = priorBatch?.cutoff_at ?? new Date().toISOString();
const batchPath = prospectiveBatchPath;
const discoveries = await discoverProjectHistory(
  Object.values(registeredGroups),
  {
    projectFilter,
    includeConversations: sourceFilters.conversations,
    includeNativeMemories: sourceFilters.native_memories,
    since,
    until,
    cutoffAt,
  },
);
if (discoveries.length === 0) {
  throw new Error(
    projectFilter
      ? `No selected history sources found for "${projectFilter}"`
      : 'No selected history sources found',
  );
}

const priorByProject = new Map(
  (priorBatch?.projects ?? []).map((project) => [project.project_id, project]),
);
const projects: ProjectHistoryBatchProject[] = discoveries.map((discovery) => {
  const prior = priorByProject.get(discovery.project_id);
  const reflectionManifest = projectManifestPath(createdAt);
  let priorManifestPath: string | undefined;
  let priorManifest;
  if (prior) {
    try {
      priorManifestPath = resolveProjectHistoryManifestPath(prior);
      if (fs.existsSync(priorManifestPath)) {
        priorManifest = readHistoryManifest(priorManifestPath);
      }
    } catch {
      priorManifestPath = undefined;
    }
  }
  if (
    prior?.status === 'preview' &&
    prior.source_fingerprint === discovery.source_fingerprint &&
    prior.review_fingerprint &&
    priorManifest
  ) {
    if (historyReviewFingerprint(priorManifest) === prior.review_fingerprint) {
      return {
        ...prior,
        import_manifests: discovery.import_manifests,
        memory_file_paths: discovery.memory_file_paths,
        declared_entries: discovery.declared_entries,
        conversation_count: discovery.conversation_count,
        sources: discovery.sources,
        reflection_manifest: reflectionManifest,
        errors: [],
      };
    }
  }
  if (prior?.status === 'preview') {
    const reasons = [
      ...(prior.source_fingerprint !== discovery.source_fingerprint
        ? ['source inventory fingerprint changed']
        : []),
      ...(!prior.review_fingerprint ? ['review fingerprint missing'] : []),
      ...(!priorManifest ? ['reflection manifest missing or unsafe'] : []),
      ...(priorManifest &&
      prior.review_fingerprint &&
      historyReviewFingerprint(priorManifest) !== prior.review_fingerprint
        ? ['reflection manifest fingerprint changed']
        : []),
    ];
    console.error(
      `[project-history] ${discovery.project_id}: completed checkpoint invalidated (${reasons.join('; ')})`,
    );
  }
  return {
    project_id: discovery.project_id,
    import_manifests: discovery.import_manifests,
    memory_file_paths: discovery.memory_file_paths,
    declared_entries: discovery.declared_entries,
    source_fingerprint: discovery.source_fingerprint,
    conversation_count: discovery.conversation_count,
    sources: discovery.sources,
    reflection_manifest: reflectionManifest,
    review_fingerprint: null,
    candidates: 0,
    memory_ops: 0,
    skipped_candidates: 0,
    errors: [...discovery.errors],
    status: discovery.errors.length > 0 ? 'error' : 'pending',
  };
});
const batch: ProjectHistoryBatchManifest = {
  batch_version: PROJECT_HISTORY_BATCH_VERSION,
  created_at: createdAt,
  cutoff_at: cutoffAt,
  filters: {
    project: projectFilter ?? null,
    since: since ?? null,
    until: until ?? null,
    sources: sourceFilters,
  },
  agents: {
    observer: observerAgent,
    reflector: reflectorAgent,
  },
  projects,
  status: 'previewing',
  errors: [],
};
writeProjectHistoryBatch(batchPath, batch);
const resumeCommand = [
  'bun scripts/reflect-project-history.ts',
  `--resume ${JSON.stringify(batchPath)}`,
  ...(projectFilter ? [`--project ${JSON.stringify(projectFilter)}`] : []),
  ...(since ? [`--since ${JSON.stringify(since)}`] : []),
  ...(until ? [`--until ${JSON.stringify(until)}`] : []),
  ...(conversationsOnly ? ['--conversations-only'] : []),
  ...(nativeMemoriesOnly ? ['--native-memories-only'] : []),
  ...(observerAgent
    ? [`--observer-agent ${JSON.stringify(observerAgent)}`]
    : []),
  ...(reflectorAgent
    ? [`--reflector-agent ${JSON.stringify(reflectorAgent)}`]
    : []),
  ...(chunkTokens ? [`--chunk-tokens ${chunkTokens}`] : []),
  ...(reflectionBatchSize ? [`--batch-size ${reflectionBatchSize}`] : []),
].join(' ');
console.error(`[project-history] checkpoint index: ${batchPath}`);
console.error(`[project-history] resume command: ${resumeCommand}`);

for (const project of batch.projects) {
  if (project.errors.length > 0 || project.status === 'preview') continue;
  const prior = priorByProject.get(project.project_id);
  let priorReflection;
  if (prior) {
    try {
      const priorManifestPath = resolveProjectHistoryManifestPath(prior);
      if (fs.existsSync(priorManifestPath)) {
        priorReflection = readHistoryManifest(priorManifestPath);
      }
    } catch {
      priorReflection = undefined;
    }
  }
  const reflectionManifestPath = resolveProjectHistoryManifestPath(project);
  const checkpointSummary = priorReflection
    ? `, ${priorReflection.memory_files.length} native and ${priorReflection.conversations.length} conversation checkpoints available`
    : '';

  console.error(
    `[project-history] previewing ${project.project_id} (${project.memory_file_paths.length} native files, ${project.conversation_count} conversations${checkpointSummary})`,
  );
  try {
    const reflection = await runHistoryReflectionPreview({
      projectId: project.project_id,
      since,
      until,
      cutoffAt,
      priorManifest: priorReflection,
      observerAgentId: observerAgent ?? undefined,
      reflectorAgentId: reflectorAgent ?? undefined,
      maxTokensPerChunk: chunkTokens,
      batchSize: reflectionBatchSize,
      includeConversations: project.sources.conversations,
      includeMemoryFiles: project.sources.native_memories,
      memoryFilePaths: project.memory_file_paths,
      requireNativeManifest: project.sources.native_memories,
      onProgress: (progress) => {
        const phase = progress.phase.replaceAll('-', ' ');
        const state = progress.state ?? 'progress';
        const position =
          state === 'started'
            ? Math.min(progress.completed + 1, progress.total)
            : state === 'progress'
              ? Math.min(progress.completed + 1, progress.total)
              : progress.completed;
        const item = progress.item_id
          ? `item ${position}/${progress.total} ${progress.item_id}`
          : `batch ${position}/${progress.total}`;
        const chunk =
          progress.chunk && progress.chunks
            ? ` chunk ${progress.chunk}/${progress.chunks}`
            : '';
        const candidates =
          progress.candidates !== undefined
            ? `, ${progress.candidates} candidates`
            : '';
        const reused = progress.reused ? ', reused checkpoint' : '';
        const checkpointMiss = progress.checkpoint_miss_reason
          ? `, checkpoint miss: ${progress.checkpoint_miss_reason}`
          : '';
        console.error(
          `[project-history] ${project.project_id}: ${phase} ${item} ${state}${chunk}${candidates}${reused}${checkpointMiss}`,
        );
      },
      onCheckpoint: (partial) => {
        writeHistoryManifest(reflectionManifestPath, partial);
        project.candidates =
          partial.memory_files.reduce(
            (sum, file) => sum + file.candidates.length,
            0,
          ) +
          partial.conversations.reduce(
            (sum, conversation) => sum + conversation.candidates.length,
            0,
          );
        project.memory_ops = partial.envelope.memory_ops.length;
        project.skipped_candidates = partial.envelope.skipped_candidates.length;
        writeProjectHistoryBatch(batchPath, batch);
      },
    });
    writeHistoryManifest(reflectionManifestPath, reflection);
    project.review_fingerprint = historyReviewFingerprint(reflection);
    project.candidates =
      reflection.memory_files.reduce(
        (sum, file) => sum + file.candidates.length,
        0,
      ) +
      reflection.conversations.reduce(
        (sum, conversation) => sum + conversation.candidates.length,
        0,
      );
    project.memory_ops = reflection.envelope.memory_ops.length;
    project.skipped_candidates = reflection.envelope.skipped_candidates.length;
    project.errors = [...reflection.errors];
    project.status = reflection.errors.length > 0 ? 'error' : 'preview';
  } catch (error) {
    project.errors.push(error instanceof Error ? error.message : String(error));
    project.status = 'error';
  }
  writeProjectHistoryBatch(batchPath, batch);
}

const failed = batch.projects.filter((project) => project.status === 'error');
batch.status = failed.length > 0 ? 'error' : 'preview';
batch.errors = failed.map(
  (project) => `${project.project_id}: ${project.errors.join('; ')}`,
);
writeProjectHistoryBatch(batchPath, batch);
console.log(JSON.stringify(summarizeBatch(batch, batchPath), null, 2));
if (failed.length > 0) process.exitCode = 2;
