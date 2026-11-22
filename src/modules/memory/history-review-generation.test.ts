import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../../config.js';
import { getGroupDir } from '../../group-dir.js';
import {
  HISTORY_CANDIDATE_PROMPT_VERSION,
  HISTORY_MANIFEST_VERSION,
  HISTORY_REFLECTOR_PROMPT_VERSION,
  type HistoryReflectionManifest,
} from './history-reflector-core.js';
import {
  recoverInterruptedHistoryReviewGenerations,
  startHistoryReviewGeneration,
} from './history-review-generation.js';
import type { ProjectHistoryBatchManifest } from './project-history-reflection-batch.js';

let recoveryFixtureRoot = '';

beforeAll(() => {
  recoveryFixtureRoot = fs.mkdtempSync('.history-review-generation-recovery-');
});

afterAll(() => {
  fs.rmSync(recoveryFixtureRoot, { recursive: true, force: true });
});

function previewManifest(): HistoryReflectionManifest {
  return {
    manifest_version: HISTORY_MANIFEST_VERSION,
    candidate_prompt_version: HISTORY_CANDIDATE_PROMPT_VERSION,
    reflector_prompt_version: HISTORY_REFLECTOR_PROMPT_VERSION,
    project_id: 'carapa-board',
    created_at: '2026-09-12T12:00:00.000Z',
    cutoff_at: '2026-09-12T12:00:00.000Z',
    filters: {
      since: '2026-09-10T12:00:00.000Z',
      until: '2026-09-12T12:00:00.000Z',
    },
    sources: {
      conversations: true,
      memory_files: false,
      memory_file_paths: [],
      require_native_manifest: false,
    },
    memory_baseline: 'baseline',
    conversations: [],
    memory_files: [],
    envelope: {
      memory_ops: [],
      skipped_candidates: [],
    },
    errors: [],
    status: 'preview',
  };
}

function resumableBatchFixture(): ProjectHistoryBatchManifest {
  return {
    batch_version: 2,
    created_at: '2026-09-12T10:00:00.000Z',
    cutoff_at: '2026-09-12T10:00:00.000Z',
    filters: {
      project: 'carapa-board',
      since: '2026-09-10T10:00:00.000Z',
      until: '2026-09-12T10:00:00.000Z',
      sources: { conversations: true, native_memories: false },
    },
    agents: {
      observer: null,
      reflector: 'llm:direct:qwen-3.8',
      reflector_model: 'qwen-3.8',
      reflector_runtime: {
        harnessId: 'direct',
        modelId: 'qwen-3.8',
        reasoning: 'high',
        temperature: 0.65,
      },
    },
    projects: [
      {
        project_id: 'carapa-board',
        import_manifests: [],
        memory_file_paths: [],
        declared_entries: 0,
        source_fingerprint: 'inventory',
        conversation_count: 2,
        sources: { conversations: true, native_memories: false },
        reflection_manifest:
          'artifacts/history-reflection/project-history-resume.json',
        review_fingerprint: null,
        candidates: 1,
        memory_ops: 1,
        skipped_candidates: 0,
        errors: [],
        status: 'pending',
        progress: {
          conversations_processed: 1,
          conversations_total: 2,
          memory_files_processed: 0,
          memory_files_total: 0,
          reflection: {
            completedChunks: 1,
            totalChunks: 2,
            failedChunks: 0,
            activeChunk: null,
            updatedAt: '2026-09-12T10:05:00.000Z',
          },
        },
        preview_state: {
          preview_id: 'resume-token',
          state_file:
            'artifacts/history-reflection/.tool-preview-state-resume-token.json',
        },
      },
    ],
    status: 'previewing',
    errors: [],
  };
}

describe('Board history proposal generation', () => {
  test('detaches a conversation-only tool preview and checkpoints its batch', async () => {
    const writes: ProjectHistoryBatchManifest[] = [];
    const manifestWrites: HistoryReflectionManifest[] = [];
    let released = false;
    let previewOptions: Record<string, unknown> | undefined;
    const staged = previewManifest();

    const started = await startHistoryReviewGeneration(
      {
        projectId: 'carapa-board',
        since: '2026-09-10T12:00:00.000Z',
        until: '2026-09-12T12:00:00.000Z',
        reflectorRuntime: {
          harnessId: 'direct',
          modelId: 'qwen-3.8',
          reasoning: 'high',
          temperature: 0.65,
        },
      },
      {
        now: () => new Date('2026-09-12T12:00:00.000Z'),
        hasProject: () => true,
        listGroups: () => [],
        discover: async (_groups, options) => {
          expect(options).toMatchObject({
            projectFilter: 'carapa-board',
            includeConversations: true,
            includeNativeMemories: false,
            since: '2026-09-10T12:00:00.000Z',
            until: '2026-09-12T12:00:00.000Z',
            cutoffAt: '2026-09-12T12:00:00.000Z',
          });
          return [
            {
              project_id: 'carapa-board',
              group_dir: '/board/carapa-board',
              import_manifests: [],
              memory_file_paths: [],
              declared_entries: 0,
              source_fingerprint: 'conversation-inventory',
              errors: [],
              conversation_count: 2,
              sources: { conversations: true, native_memories: false },
            },
          ];
        },
        validateRuntime: () => null,
        resolveRuntime: () => ({
          id: 'llm:direct:qwen-3.8',
          label: 'Local Qwen 3.8',
          harnessId: 'direct',
          harnessKind: 'direct',
          modelId: 'qwen-3.8',
          baseUrl: 'http://board-owned-model.test/v1',
          model: 'qwen3.8',
        }),
        batchRoot: () => '/batch-root',
        acquireLease: () => ({
          release() {
            released = true;
          },
        }),
        writeBatch: (_filePath, batch) => writes.push(structuredClone(batch)),
        resolveManifestPath: () => '/project/history-preview.json',
        writeManifest: (_filePath, manifest) =>
          manifestWrites.push(structuredClone(manifest)),
        runPreview: async (options) => {
          previewOptions = options as unknown as Record<string, unknown>;
          await options.onProgress?.({
            phase: 'extract-conversations',
            completed: 1,
            total: 2,
            item_id: 'old-without-selected-messages',
            candidates: 0,
            state: 'completed',
          });
          await options.onCheckpoint?.(staged);
          await options.onProgress?.({
            phase: 'extract-conversations',
            completed: 2,
            total: 2,
            item_id: 'active-conversation',
            candidates: 0,
            state: 'completed',
          });
          return staged;
        },
      },
    );

    expect(started.batchId).toMatch(/^project-history-batch-.*\.json$/);
    await started.completion;
    const token = started.batchId.slice(
      'project-history-batch-'.length,
      -'.json'.length,
    );
    expect(previewOptions).toMatchObject({
      projectId: 'carapa-board',
      since: '2026-09-10T12:00:00.000Z',
      until: '2026-09-12T12:00:00.000Z',
      cutoffAt: '2026-09-12T12:00:00.000Z',
      previewId: token,
      reflectorAgentId: 'llm:direct:qwen-3.8',
      reflectorRuntime: {
        harnessId: 'direct',
        modelId: 'qwen-3.8',
        reasoning: 'high',
        temperature: 0.65,
      },
      includeConversations: true,
      includeMemoryFiles: false,
      memoryFilePaths: [],
      requireNativeManifest: false,
    });
    expect(manifestWrites).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      status: 'previewing',
      filters: {
        project: 'carapa-board',
        since: '2026-09-10T12:00:00.000Z',
        until: '2026-09-12T12:00:00.000Z',
        sources: { conversations: true, native_memories: false },
      },
      agents: {
        reflector: 'llm:direct:qwen-3.8',
        reflector_model: 'qwen-3.8',
        reflector_runtime: {
          harnessId: 'direct',
          modelId: 'qwen-3.8',
          reasoning: 'high',
          temperature: 0.65,
        },
      },
      projects: [
        {
          conversation_count: 2,
          memory_file_paths: [],
          status: 'pending',
          preview_state: {
            preview_id: token,
            state_file: `artifacts/history-reflection/.tool-preview-state-${token}.json`,
          },
        },
      ],
    });
    expect(writes.at(-1)?.status).toBe('preview');
    expect(writes.at(-1)?.projects[0]?.status).toBe('preview');
    expect(writes.at(-1)?.projects[0]?.progress).toEqual({
      conversations_processed: 2,
      conversations_total: 2,
      memory_files_processed: 0,
      memory_files_total: 0,
    });
    expect(released).toBe(true);
  });

  test('terminalizes previewing batches interrupted by a Board restart', async () => {
    let batch: ProjectHistoryBatchManifest = {
      batch_version: 2,
      created_at: '2026-09-12T10:00:00.000Z',
      cutoff_at: '2026-09-12T10:00:00.000Z',
      filters: {
        project: 'carapa-board',
        since: '2026-09-10T10:00:00.000Z',
        until: '2026-09-12T10:00:00.000Z',
        sources: { conversations: true, native_memories: false },
      },
      agents: { observer: null, reflector: 'llm:direct:qwen-3.8' },
      projects: [
        {
          project_id: 'carapa-board',
          import_manifests: [],
          memory_file_paths: [],
          declared_entries: 0,
          source_fingerprint: 'inventory',
          conversation_count: 2,
          sources: { conversations: true, native_memories: false },
          reflection_manifest:
            'artifacts/history-reflection/project-history-restart.json',
          review_fingerprint: null,
          candidates: 1,
          memory_ops: 1,
          skipped_candidates: 0,
          errors: [],
          status: 'pending',
          progress: {
            conversations_processed: 1,
            conversations_total: 2,
            memory_files_processed: 0,
            memory_files_total: 0,
          },
        },
      ],
      status: 'previewing',
      errors: [],
    };
    let released = false;

    expect(
      await recoverInterruptedHistoryReviewGenerations({
        batchRoot: () => '/history',
        listBatchFiles: () => [
          'unrelated.json',
          'project-history-batch-restart.json',
        ],
        readBatch: () => structuredClone(batch),
        writeBatch: (_path, updated) => {
          batch = structuredClone(updated);
        },
        acquireLease: () => ({
          release() {
            released = true;
          },
        }),
        listProjectIds: () => [],
      }),
    ).toEqual({ resumed: 0, terminalized: 1 });
    expect(batch.status).toBe('error');
    expect(batch.projects[0]).toMatchObject({
      status: 'error',
      candidates: 1,
      memory_ops: 1,
      progress: {
        conversations_processed: 1,
        conversations_total: 2,
      },
    });
    expect(batch.projects[0]!.errors).toContain(
      'History proposal generation was interrupted by a Board restart',
    );
    expect(released).toBe(true);
  });

  test('removes orphaned transcript copies while recovering an interrupted preview', async () => {
    const projectRoot = path.join(recoveryFixtureRoot, 'carapa-board');
    const artifactRoot = path.join(
      projectRoot,
      'artifacts',
      'history-reflection',
    );
    fs.mkdirSync(artifactRoot, { recursive: true });
    const transcriptCopy = path.join(
      artifactRoot,
      '.tool-preview-38ed6064-0351-4d15-a070-90b9af98d0e3.jsonl',
    );
    const orphanedStateFile = path.join(
      artifactRoot,
      '.tool-preview-state-orphaned-token.json',
    );
    const persistedManifest = path.join(
      artifactRoot,
      'project-history-preserved.json',
    );
    fs.writeFileSync(
      transcriptCopy,
      '{"type":"message","content":"private"}\n',
    );
    fs.writeFileSync(orphanedStateFile, '{}\n');
    fs.writeFileSync(persistedManifest, '{}\n');

    const batch: ProjectHistoryBatchManifest = {
      batch_version: 2,
      created_at: '2026-09-12T10:00:00.000Z',
      cutoff_at: '2026-09-12T10:00:00.000Z',
      filters: {
        project: 'carapa-board',
        since: '2026-09-10T10:00:00.000Z',
        until: '2026-09-12T10:00:00.000Z',
        sources: { conversations: true, native_memories: false },
      },
      agents: { observer: null, reflector: 'llm:direct:qwen-3.8' },
      projects: [
        {
          project_id: 'carapa-board',
          import_manifests: [],
          memory_file_paths: [],
          declared_entries: 0,
          source_fingerprint: 'inventory',
          conversation_count: 1,
          sources: { conversations: true, native_memories: false },
          reflection_manifest:
            'artifacts/history-reflection/project-history-restart.json',
          review_fingerprint: null,
          candidates: 0,
          memory_ops: 0,
          skipped_candidates: 0,
          errors: [],
          status: 'pending',
        },
      ],
      status: 'previewing',
      errors: [],
    };

    expect(
      await recoverInterruptedHistoryReviewGenerations({
        batchRoot: () => '/history',
        listBatchFiles: () => ['project-history-batch-restart.json'],
        readBatch: () => structuredClone(batch),
        writeBatch: () => {},
        acquireLease: () => ({ release() {} }),
        listProjectIds: () => ['carapa-board'],
        projectDir: () => projectRoot,
      }),
    ).toEqual({ resumed: 0, terminalized: 1 });
    expect(fs.existsSync(transcriptCopy)).toBe(false);
    expect(fs.existsSync(orphanedStateFile)).toBe(false);
    expect(fs.existsSync(persistedManifest)).toBe(true);
  });

  test('ignores a batch whose project_id climbs out of the groups directory', async () => {
    const root = path.join(recoveryFixtureRoot, 'traversal-batches');
    fs.mkdirSync(root, { recursive: true });
    // '../../<name>' from GROUPS_DIR is a sibling of the test data root.
    const escaped = `history-traversal-victim-${process.pid}`;
    const victimProject = path.resolve(getGroupDir(`../../${escaped}`));
    expect(victimProject.startsWith(GROUPS_DIR)).toBe(false);
    const victimArtifacts = path.join(
      victimProject,
      'artifacts',
      'history-reflection',
    );
    fs.mkdirSync(victimArtifacts, { recursive: true });
    const victim = path.join(victimArtifacts, '.tool-preview-orphan.jsonl');
    fs.writeFileSync(victim, 'outside the groups directory\n');
    const batch = resumableBatchFixture();
    batch.projects[0]!.project_id = `../../${escaped}`;
    fs.writeFileSync(
      path.join(root, 'project-history-batch-traversal.json'),
      JSON.stringify(batch),
    );

    try {
      await recoverInterruptedHistoryReviewGenerations({
        batchRoot: () => root,
        listProjectIds: () => [],
        acquireLease: () => ({ release() {} }),
      });
      expect(fs.existsSync(victim)).toBe(true);
    } finally {
      fs.rmSync(victimProject, { recursive: true, force: true });
    }
  });

  test('resumes resumable previewing batches at startup with their original selection', async () => {
    const projectRoot = path.join(recoveryFixtureRoot, 'resume-project');
    const artifactRoot = path.join(
      projectRoot,
      'artifacts',
      'history-reflection',
    );
    fs.mkdirSync(artifactRoot, { recursive: true });
    const referencedStateFile = path.join(
      artifactRoot,
      '.tool-preview-state-resume-token.json',
    );
    const orphanedTranscript = path.join(
      artifactRoot,
      '.tool-preview-38ed6064-0351-4d15-a070-90b9af98d0e3.jsonl',
    );
    const orphanedStateFile = path.join(
      artifactRoot,
      '.tool-preview-state-orphaned-token.json',
    );
    const persistedManifest = path.join(
      artifactRoot,
      'project-history-resume.json',
    );
    fs.writeFileSync(referencedStateFile, '{"preview_id":"resume-token"}\n');
    fs.writeFileSync(
      orphanedTranscript,
      '{"type":"message","content":"private"}\n',
    );
    fs.writeFileSync(orphanedStateFile, '{}\n');
    fs.writeFileSync(persistedManifest, '{}\n');

    let batch: ProjectHistoryBatchManifest = resumableBatchFixture();
    let released = false;
    let markReleased!: () => void;
    const leaseReleased = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    let previewOptions: Record<string, unknown> | undefined;
    const staged = previewManifest();

    const summary = await recoverInterruptedHistoryReviewGenerations({
      batchRoot: () => '/history',
      listBatchFiles: () => ['project-history-batch-resume.json'],
      readBatch: () => structuredClone(batch),
      writeBatch: (_path, updated) => {
        batch = structuredClone(updated);
      },
      acquireLease: () => ({
        release() {
          released = true;
          markReleased();
        },
      }),
      listProjectIds: () => ['carapa-board'],
      projectDir: () => projectRoot,
      hasProject: () => true,
      discover: async () => [
        {
          project_id: 'carapa-board',
          group_dir: projectRoot,
          import_manifests: [],
          memory_file_paths: [],
          declared_entries: 0,
          source_fingerprint: 'inventory',
          errors: [],
          conversation_count: 2,
          sources: { conversations: true, native_memories: false },
        },
      ],
      validateRuntime: () => null,
      resolveRuntime: () => ({
        id: 'llm:direct:qwen-3.8',
        label: 'Local Qwen 3.8',
        harnessId: 'direct',
        harnessKind: 'direct',
        modelId: 'qwen-3.8',
        baseUrl: 'http://board-owned-model.test/v1',
        model: 'qwen3.8',
      }),
      readManifest: () => {
        throw new Error('no durable manifest checkpoint yet');
      },
      resolveManifestPath: () => '/project/history-preview.json',
      writeManifest: () => {},
      runPreview: async (options) => {
        previewOptions = options as unknown as Record<string, unknown>;
        await options.onProgress?.({
          phase: 'reflect-conversations',
          completed: 1,
          total: 2,
          failedChunks: 0,
          chunk: 2,
          candidates: 1,
          state: 'started',
        });
        await options.onProgress?.({
          phase: 'reflect-conversations',
          completed: 2,
          total: 2,
          failedChunks: 0,
          candidates: 2,
          state: 'progress',
        });
        await options.onCheckpoint?.(staged);
        return staged;
      },
    });

    expect(summary).toEqual({ resumed: 1, terminalized: 0 });
    // The resumed run keeps the interrupted batch's original selection.
    expect(previewOptions).toMatchObject({
      projectId: 'carapa-board',
      since: '2026-09-10T10:00:00.000Z',
      until: '2026-09-12T10:00:00.000Z',
      cutoffAt: '2026-09-12T10:00:00.000Z',
      previewId: 'resume-token',
      reflectorAgentId: 'llm:direct:qwen-3.8',
      reflectorRuntime: {
        harnessId: 'direct',
        modelId: 'qwen-3.8',
        reasoning: 'high',
        temperature: 0.65,
      },
      includeConversations: true,
      includeMemoryFiles: false,
      memoryFilePaths: [],
      requireNativeManifest: false,
    });
    expect(previewOptions?.priorManifest).toBeUndefined();
    // The relaunched run's resume checkpoint survives the sweep; orphaned
    // preview artifacts are removed and reviewable findings are kept.
    expect(fs.existsSync(referencedStateFile)).toBe(true);
    expect(fs.existsSync(orphanedTranscript)).toBe(false);
    expect(fs.existsSync(orphanedStateFile)).toBe(false);
    expect(fs.existsSync(persistedManifest)).toBe(true);

    await leaseReleased;
    expect(released).toBe(true);

    expect(batch.status).toBe('preview');
    expect(batch.projects[0]).toMatchObject({
      status: 'preview',
      candidates: 0,
      memory_ops: 0,
      progress: {
        conversations_processed: 1,
        conversations_total: 2,
        memory_files_processed: 0,
        memory_files_total: 0,
        reflection: {
          completedChunks: 2,
          totalChunks: 2,
          failedChunks: 0,
          activeChunk: null,
        },
      },
    });
    // The terminal batch write is durable before the resume state releases.
    expect(fs.existsSync(referencedStateFile)).toBe(false);
  });

  test('terminalizes resumable batches whose recovery input is missing', async () => {
    const projectRoot = path.join(recoveryFixtureRoot, 'missing-input-project');
    const artifactRoot = path.join(
      projectRoot,
      'artifacts',
      'history-reflection',
    );
    fs.mkdirSync(artifactRoot, { recursive: true });
    const referencedStateFile = path.join(
      artifactRoot,
      '.tool-preview-state-resume-token.json',
    );
    fs.writeFileSync(referencedStateFile, '{"preview_id":"resume-token"}\n');

    let batch: ProjectHistoryBatchManifest = resumableBatchFixture();
    let released = false;

    expect(
      await recoverInterruptedHistoryReviewGenerations({
        batchRoot: () => '/history',
        listBatchFiles: () => ['project-history-batch-resume.json'],
        readBatch: () => structuredClone(batch),
        writeBatch: (_path, updated) => {
          batch = structuredClone(updated);
        },
        acquireLease: () => ({
          release() {
            released = true;
          },
        }),
        listProjectIds: () => ['carapa-board'],
        projectDir: () => projectRoot,
        hasProject: () => false,
      }),
    ).toEqual({ resumed: 0, terminalized: 1 });
    expect(batch.status).toBe('error');
    expect(batch.projects[0]!.errors).toContain(
      'Project carapa-board is no longer available; the interrupted history proposals cannot be resumed',
    );
    expect(released).toBe(true);
    // With no launch, the unreferenced resume state is released by cleanup.
    expect(fs.existsSync(referencedStateFile)).toBe(false);
  });
});
