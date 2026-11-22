import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { projects } from '../../db/schema.js';
import {
  getMemory,
  initDatabase,
  insertMemory,
  recordPrivacyErasure,
} from '../../db.js';
import { getGroupDir } from '../../group-dir.js';
import {
  applyGroupUpdateInMemory,
  registeredGroups,
} from '../../state-manager.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  HISTORY_CANDIDATE_PROMPT_VERSION,
  HISTORY_MANIFEST_VERSION,
  HISTORY_REFLECTOR_PROMPT_VERSION,
  plannedHistoryMemoryId,
  type HistoryCandidate,
  type HistoryMemoryOp,
  type HistoryReflectionManifest,
} from './history-reflector-core.js';
import {
  applyReviewedHistoryProject,
  buildReviewedHistoryManifest,
  historyMemoryEvalMarkedIds,
  historyReviewOperationId,
  projectView,
  readHistoryMemoryEvalRecords,
  setHistoryMemoryEvalMark,
  validateHistoryReviewEdits,
  type HistoryReviewItemDecision,
  type HistoryReviewSidecar,
} from './history-review.js';
import {
  PROJECT_HISTORY_BATCH_VERSION,
  historyReviewFingerprint,
  type ProjectHistoryBatchManifest,
  type ProjectHistoryBatchProject,
} from './project-history-reflection-batch.js';

const EVAL_PROJECT = 'history-review-eval-test';

afterEach(() => {
  fs.rmSync(getGroupDir(EVAL_PROJECT), { recursive: true, force: true });
});

function candidate(id: string): HistoryCandidate {
  return {
    id,
    planned_memory_id: plannedHistoryMemoryId(id),
    memory_type: 'decision',
    claim: `Durable ${id}`,
    change_kind: 'assert',
    effective_at: '2025-01-01T00:00:00.000Z',
    confidence: 0.9,
    importance: 0.8,
    tags: ['architecture'],
    evidence: [
      {
        source_kind: 'conversation',
        conversation_id: 'conversation-a',
        message_id: `message-${id}`,
        role: 'user',
        created_at: '2025-01-01T00:00:00.000Z',
        date_basis: 'message_timestamp',
        excerpt: `Evidence ${id}`,
      },
    ],
  };
}

function manifest(): HistoryReflectionManifest {
  const createCandidate = candidate('candidate-create');
  const forgetCandidate = candidate('candidate-forget');
  const skippedCandidate = candidate('candidate-skipped');
  return {
    manifest_version: HISTORY_MANIFEST_VERSION,
    candidate_prompt_version: HISTORY_CANDIDATE_PROMPT_VERSION,
    reflector_prompt_version: HISTORY_REFLECTOR_PROMPT_VERSION,
    project_id: 'history-review-test',
    created_at: '2026-01-01T00:00:00.000Z',
    cutoff_at: '2026-01-01T00:00:00.000Z',
    filters: { since: null, until: null },
    sources: { conversations: true, memory_files: false },
    memory_baseline: 'baseline',
    conversations: [
      {
        conversation_id: 'conversation-a',
        objective_id: null,
        title: 'History',
        created_at: '2025-01-01T00:00:00.000Z',
        transcript_hash: 'hash',
        message_count: 3,
        candidates: [createCandidate, forgetCandidate, skippedCandidate],
        errors: [],
      },
    ],
    memory_files: [],
    envelope: {
      memory_ops: [
        {
          op: 'create',
          candidate_ids: [createCandidate.id],
          new_memory_id: createCandidate.planned_memory_id,
          memory_type: 'decision',
          content: 'Original durable fact',
          valid_from: '2025-01-01T00:00:00.000Z',
          importance: 0.8,
          tags: ['architecture'],
        },
        {
          op: 'forget',
          candidate_ids: [forgetCandidate.id],
          memory_id: 'existing-memory',
          target: 'private subject',
        },
      ],
      skipped_candidates: [
        {
          candidate_ids: [skippedCandidate.id],
          reason: 'low-value',
        },
      ],
    },
    errors: [],
    status: 'preview',
  };
}

function approvedForgetDecision(
  original: HistoryReflectionManifest,
): Record<string, HistoryReviewItemDecision> {
  const forget = original.envelope.memory_ops.find(
    (operation) => operation.op === 'forget',
  )!;
  return {
    [historyReviewOperationId(forget)]: {
      decision: 'approved',
      mark_for_eval: false,
      reviewed_by: 'admin',
      reviewed_at: '2026-01-02T00:00:00.000Z',
    },
  };
}

function projectBatchFor(reflection: HistoryReflectionManifest): {
  batch: ProjectHistoryBatchManifest;
  project: ProjectHistoryBatchProject;
} {
  const project: ProjectHistoryBatchProject = {
    project_id: reflection.project_id,
    import_manifests: [],
    memory_file_paths: [],
    declared_entries: 0,
    source_fingerprint: 'source',
    conversation_count: reflection.conversations.length,
    sources: { conversations: true, native_memories: false },
    reflection_manifest: 'reflection.json',
    review_fingerprint: null,
    candidates: 0,
    memory_ops: reflection.envelope.memory_ops.length,
    skipped_candidates: 0,
    errors: [],
    status: 'preview',
  };
  const batch: ProjectHistoryBatchManifest = {
    batch_version: PROJECT_HISTORY_BATCH_VERSION,
    created_at: '2026-01-01T00:00:00.000Z',
    cutoff_at: '2026-01-01T00:00:00.000Z',
    filters: {
      project: null,
      since: null,
      until: null,
      sources: { conversations: true, native_memories: false },
    },
    agents: { observer: null, reflector: null },
    projects: [project],
    status: 'preview',
    errors: [],
  };
  return { batch, project };
}

describe('history review derivation', () => {
  test('keeps privacy operations and applies approved edits', () => {
    const original = manifest();
    const create = original.envelope.memory_ops[0]!;
    const createId = historyReviewOperationId(create);
    const sidecar: HistoryReviewSidecar = {
      review_version: 1,
      batch_id: 'project-history-batch-test.json',
      project_id: original.project_id,
      manifest_fingerprint: 'fingerprint',
      revision: 1,
      decisions: {
        ...approvedForgetDecision(original),
        [createId]: {
          decision: 'approved',
          mark_for_eval: true,
          edits: {
            content: 'Reviewed durable fact',
            importance: 0.9,
          },
          reviewed_by: 'admin',
          reviewed_at: '2026-01-02T00:00:00.000Z',
        },
      },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      status: 'reviewing',
    };

    const reviewed = buildReviewedHistoryManifest(original, sidecar);
    expect(reviewed.envelope.memory_ops).toHaveLength(2);
    expect(reviewed.envelope.memory_ops[0]).toMatchObject({
      op: 'create',
      content: 'Reviewed durable fact',
      importance: 0.9,
    });
    expect(reviewed.envelope.memory_ops[1]?.op).toBe('forget');
    expect(original.envelope.memory_ops[0]).toMatchObject({
      content: 'Original durable fact',
      importance: 0.8,
    });
  });

  test('turns rejected operations into human-reviewed skips', () => {
    const original = manifest();
    const create = original.envelope.memory_ops[0]!;
    const sidecar: HistoryReviewSidecar = {
      review_version: 1,
      batch_id: 'project-history-batch-test.json',
      project_id: original.project_id,
      manifest_fingerprint: 'fingerprint',
      revision: 1,
      decisions: {
        ...approvedForgetDecision(original),
        [historyReviewOperationId(create)]: {
          decision: 'rejected',
          mark_for_eval: false,
          reviewed_by: 'admin',
          reviewed_at: '2026-01-02T00:00:00.000Z',
        },
      },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      status: 'reviewing',
    };
    const reviewed = buildReviewedHistoryManifest(original, sidecar);

    expect(
      reviewed.envelope.memory_ops.map((operation) => operation.op),
    ).toEqual(['forget']);
    expect(reviewed.envelope.skipped_candidates).toContainEqual({
      candidate_ids: ['candidate-create'],
      reason: 'human-rejected',
    });
    expect(reviewed.envelope.skipped_candidates).toContainEqual({
      candidate_ids: ['candidate-skipped'],
      reason: 'low-value',
    });
  });

  test('repairs approved timeline links around rejected planned memories', () => {
    const original = manifest();
    const first = original.envelope.memory_ops[0]!;
    if (first.op !== 'create') throw new Error('expected create');
    const middleCandidate = candidate('candidate-middle');
    const lastCandidate = candidate('candidate-last');
    original.conversations[0]!.candidates.push(middleCandidate, lastCandidate);
    const middle: HistoryMemoryOp = {
      op: 'supersede',
      candidate_ids: [middleCandidate.id],
      new_memory_id: middleCandidate.planned_memory_id,
      supersedes_id: first.new_memory_id,
      memory_type: 'decision',
      correction_content: 'Rejected middle fact',
      valid_from: '2025-02-01T00:00:00.000Z',
      importance: 0.8,
      tags: [],
      precedes_id: 'existing-current',
    };
    const last: HistoryMemoryOp = {
      op: 'supersede',
      candidate_ids: [lastCandidate.id],
      new_memory_id: lastCandidate.planned_memory_id,
      supersedes_id: middleCandidate.planned_memory_id,
      memory_type: 'decision',
      correction_content: 'Approved later fact',
      valid_from: '2025-03-01T00:00:00.000Z',
      importance: 0.8,
      tags: [],
      precedes_id: 'existing-current',
    };
    first.precedes_id = middleCandidate.planned_memory_id;
    original.envelope.memory_ops.splice(1, 0, middle, last);
    const approve = (
      operation: HistoryMemoryOp,
    ): HistoryReviewItemDecision => ({
      decision: 'approved',
      mark_for_eval: false,
      reviewed_by: 'admin',
      reviewed_at: '2026-01-02T00:00:00.000Z',
    });
    const sidecar: HistoryReviewSidecar = {
      review_version: 1,
      batch_id: 'project-history-batch-test.json',
      project_id: original.project_id,
      manifest_fingerprint: 'fingerprint',
      revision: 1,
      decisions: {
        ...approvedForgetDecision(original),
        [historyReviewOperationId(first)]: approve(first),
        [historyReviewOperationId(middle)]: {
          ...approve(middle),
          decision: 'rejected',
        },
        [historyReviewOperationId(last)]: approve(last),
      },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      status: 'reviewing',
    };

    const reviewed = buildReviewedHistoryManifest(original, sidecar);

    expect(reviewed.envelope.memory_ops[0]).toMatchObject({
      op: 'create',
      new_memory_id: first.new_memory_id,
      precedes_id: 'existing-current',
    });
    expect(reviewed.envelope.memory_ops[1]).toMatchObject({
      op: 'supersede',
      new_memory_id: lastCandidate.planned_memory_id,
      supersedes_id: first.new_memory_id,
      precedes_id: 'existing-current',
    });
  });

  test('turns an approved supersede into a create when its rejected predecessor had no ancestor', () => {
    const original = manifest();
    const first = original.envelope.memory_ops[0]!;
    if (first.op !== 'create') throw new Error('expected create');
    const nextCandidate = candidate('candidate-next');
    original.conversations[0]!.candidates.push(nextCandidate);
    const next: HistoryMemoryOp = {
      op: 'supersede',
      candidate_ids: [nextCandidate.id],
      new_memory_id: nextCandidate.planned_memory_id,
      supersedes_id: first.new_memory_id,
      memory_type: 'decision',
      correction_content: 'Approved standalone fact',
      valid_from: '2025-02-01T00:00:00.000Z',
      importance: 0.8,
      tags: [],
    };
    original.envelope.memory_ops.splice(1, 0, next);
    const sidecar: HistoryReviewSidecar = {
      review_version: 1,
      batch_id: 'project-history-batch-test.json',
      project_id: original.project_id,
      manifest_fingerprint: 'fingerprint',
      revision: 1,
      decisions: {
        ...approvedForgetDecision(original),
        [historyReviewOperationId(first)]: {
          decision: 'rejected',
          mark_for_eval: false,
          reviewed_by: 'admin',
          reviewed_at: '2026-01-02T00:00:00.000Z',
        },
        [historyReviewOperationId(next)]: {
          decision: 'approved',
          mark_for_eval: false,
          reviewed_by: 'admin',
          reviewed_at: '2026-01-02T00:00:00.000Z',
        },
      },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      status: 'reviewing',
    };

    expect(
      buildReviewedHistoryManifest(original, sidecar).envelope.memory_ops[0],
    ).toMatchObject({
      op: 'create',
      new_memory_id: nextCandidate.planned_memory_id,
      content: 'Approved standalone fact',
    });
  });

  test('removes a link to a planned candidate that has no create operation', () => {
    const original = manifest();
    const create = original.envelope.memory_ops[0]!;
    if (create.op !== 'create') throw new Error('expected create');
    const omittedCandidate = candidate('candidate-omitted-successor');
    original.conversations[0]!.candidates.push(omittedCandidate);
    create.precedes_id = omittedCandidate.planned_memory_id;
    const sidecar: HistoryReviewSidecar = {
      review_version: 1,
      batch_id: 'project-history-batch-test.json',
      project_id: original.project_id,
      manifest_fingerprint: 'fingerprint',
      revision: 1,
      decisions: {
        ...approvedForgetDecision(original),
        [historyReviewOperationId(create)]: {
          decision: 'approved',
          mark_for_eval: false,
          reviewed_by: 'admin',
          reviewed_at: '2026-01-02T00:00:00.000Z',
        },
      },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      status: 'reviewing',
    };

    expect(
      buildReviewedHistoryManifest(original, sidecar).envelope.memory_ops[0],
    ).toEqual({
      op: 'create',
      candidate_ids: create.candidate_ids,
      new_memory_id: create.new_memory_id,
      memory_type: create.memory_type,
      content: create.content,
      valid_from: create.valid_from,
      importance: create.importance,
      tags: create.tags,
    });
  });

  test('moves an approved create out of the source manifest', () => {
    const original = manifest();
    const create = original.envelope.memory_ops[0]!;
    const sidecar: HistoryReviewSidecar = {
      review_version: 1,
      batch_id: 'project-history-batch-test.json',
      project_id: original.project_id,
      manifest_fingerprint: 'fingerprint',
      revision: 1,
      decisions: {
        ...approvedForgetDecision(original),
        [historyReviewOperationId(create)]: {
          decision: 'approved',
          mark_for_eval: false,
          target_project_id: 'application-project',
          reviewed_by: 'admin',
          reviewed_at: '2026-01-02T00:00:00.000Z',
        },
      },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      status: 'reviewing',
    };

    const reviewed = buildReviewedHistoryManifest(original, sidecar);
    expect(
      reviewed.envelope.memory_ops.map((operation) => operation.op),
    ).toEqual(['forget']);
    expect(reviewed.envelope.skipped_candidates).toContainEqual({
      candidate_ids: ['candidate-create'],
      reason: 'human-moved-to:application-project',
    });
  });

  test('validates the restricted editable field set', () => {
    const original = manifest().envelope.memory_ops[0]!;
    expect(
      validateHistoryReviewEdits(
        original,
        {
          content: 'Edited',
          memory_type: 'project',
          importance: 0.75,
          tags: ['one', 'one', 'two'],
          valid_from: '2025-02-01T00:00:00Z',
        },
        '2026-01-01T00:00:00.000Z',
      ),
    ).toEqual({
      content: 'Edited',
      memory_type: 'project',
      importance: 0.75,
      tags: ['one', 'two'],
      valid_from: '2025-02-01T00:00:00.000Z',
    });
    expect(() =>
      validateHistoryReviewEdits(
        original,
        { importance: 0.2 },
        '2026-01-01T00:00:00.000Z',
      ),
    ).toThrow('importance');
    expect(() =>
      validateHistoryReviewEdits(
        original,
        { effective_at: '2025-01-01T00:00:00.000Z' },
        '2026-01-01T00:00:00.000Z',
      ),
    ).toThrow('cannot be edited');
  });

  test('enables apply only for a reviewed preview with operations', () => {
    const batchId = 'project-history-batch-test.json';
    const empty = manifest();
    empty.envelope.memory_ops = [];
    const emptyBatch = projectBatchFor(empty);
    expect(
      projectView(batchId, emptyBatch.batch, emptyBatch.project, empty, null)
        .apply_enabled,
    ).toBe(false);

    const original = manifest();
    const { batch, project } = projectBatchFor(original);
    const create = original.envelope.memory_ops[0]!;
    const sidecar: HistoryReviewSidecar = {
      review_version: 1,
      batch_id: batchId,
      project_id: original.project_id,
      manifest_fingerprint: historyReviewFingerprint(original),
      revision: 1,
      decisions: {
        ...approvedForgetDecision(original),
        [historyReviewOperationId(create)]: {
          decision: 'approved',
          mark_for_eval: false,
          reviewed_by: 'admin',
          reviewed_at: '2026-01-02T00:00:00.000Z',
        },
      },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      status: 'reviewing',
    };
    expect(
      projectView(batchId, batch, project, original, sidecar).apply_enabled,
    ).toBe(true);
  });

  test('marks, refreshes, and unmarks an existing memory for eval', () => {
    const memory = {
      id: 'memory-existing',
      group_folder: EVAL_PROJECT,
      objective_id: null,
      content: 'The existing durable fact',
      memory_type: 'project' as const,
      importance: 0.7,
      source: 'agent' as const,
      tags: ['existing'],
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      last_accessed_at: '2026-01-01T00:00:00.000Z',
      access_count: 0,
      valid_from: '2025-01-01T00:00:00.000Z',
      valid_to: null,
    };

    setHistoryMemoryEvalMark(EVAL_PROJECT, memory, true, 'admin');
    expect(historyMemoryEvalMarkedIds(EVAL_PROJECT)).toContain(memory.id);
    expect(readHistoryMemoryEvalRecords(EVAL_PROJECT)[0]).toMatchObject({
      memory_id: memory.id,
      expected_content: memory.content,
      reviewed_by: 'admin',
    });

    setHistoryMemoryEvalMark(
      EVAL_PROJECT,
      { ...memory, content: 'Corrected durable fact' },
      true,
      'reviewer',
    );
    expect(readHistoryMemoryEvalRecords(EVAL_PROJECT)).toHaveLength(1);
    expect(readHistoryMemoryEvalRecords(EVAL_PROJECT)[0]).toMatchObject({
      expected_content: 'Corrected durable fact',
      reviewed_by: 'reviewer',
    });

    setHistoryMemoryEvalMark(EVAL_PROJECT, memory, false, 'admin');
    expect(historyMemoryEvalMarkedIds(EVAL_PROJECT)).not.toContain(memory.id);
    expect(readHistoryMemoryEvalRecords(EVAL_PROJECT)).toEqual([]);
  });

  test('reads a FIFO planted as the eval journal as empty instead of blocking', () => {
    const evalDir = path.join(getGroupDir(EVAL_PROJECT), '.agent', 'evals');
    fs.mkdirSync(evalDir, { recursive: true });
    const fifo = path.join(evalDir, 'history-memory.jsonl');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);

    expect(readHistoryMemoryEvalRecords(EVAL_PROJECT)).toEqual([]);
  });
});

describe('history review apply after a privacy erasure', () => {
  const SOURCE = 'history-review-apply-source';
  const TARGET = 'history-review-apply-target';
  const BATCH_ID = 'project-history-batch-erasure-test.json';

  beforeAll(async () => {
    await initDatabase(':memory:');
  });

  afterEach(() => {
    for (const folder of [SOURCE, TARGET]) {
      fs.rmSync(getGroupDir(folder), { recursive: true, force: true });
      delete registeredGroups[`${folder}@test`];
    }
    fs.rmSync(
      path.join(
        getGroupDir('main'),
        'artifacts',
        'history-reflection',
        BATCH_ID,
      ),
      {
        force: true,
      },
    );
  });

  test('refuses before the source apply when a relocation target was erased after the preview', async () => {
    await truncateTestDb();
    for (const folder of [SOURCE, TARGET]) {
      await drizzleDbRef.current.insert(projects).values({
        id: folder,
        jid: `${folder}@test`,
        name: folder,
        folder,
        trigger: '!',
        added_at: '2026-01-01T00:00:00.000Z',
        is_main: 0,
      });
      registeredGroups[`${folder}@test`] = {
        name: folder,
        folder,
        trigger: '!',
        added_at: '2026-01-01T00:00:00.000Z',
      };
    }
    applyGroupUpdateInMemory(`${SOURCE}@test`, {});
    await insertMemory({
      id: 'existing-memory',
      group_folder: SOURCE,
      objective_id: null,
      content: 'private subject details',
      memory_type: 'decision',
      importance: 0.8,
      source: 'agent',
    });

    const reflection = { ...manifest(), project_id: SOURCE };
    const manifestRelative =
      'artifacts/history-reflection/project-history-erasure-test.json';
    const manifestPath = path.join(getGroupDir(SOURCE), manifestRelative);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(reflection));
    const { batch, project } = projectBatchFor(reflection);
    project.reflection_manifest = manifestRelative;
    const batchPath = path.join(
      getGroupDir('main'),
      'artifacts',
      'history-reflection',
      BATCH_ID,
    );
    fs.mkdirSync(path.dirname(batchPath), { recursive: true });
    fs.writeFileSync(batchPath, JSON.stringify(batch));

    const [create, forget] = reflection.envelope.memory_ops;
    const decision = {
      mark_for_eval: false,
      reviewed_by: 'admin',
      reviewed_at: '2026-01-02T00:00:00.000Z',
    };
    const sidecar: HistoryReviewSidecar = {
      review_version: 1,
      batch_id: BATCH_ID,
      project_id: SOURCE,
      manifest_fingerprint: historyReviewFingerprint(reflection),
      revision: 1,
      decisions: {
        [historyReviewOperationId(create!)]: {
          ...decision,
          decision: 'approved',
          target_project_id: TARGET,
        },
        [historyReviewOperationId(forget!)]: {
          ...decision,
          decision: 'approved',
        },
      },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      status: 'reviewing',
    };
    fs.writeFileSync(
      manifestPath.replace(/\.json$/, '.review.json'),
      JSON.stringify(sidecar),
    );

    await recordPrivacyErasure(TARGET);

    await expect(applyReviewedHistoryProject(BATCH_ID, SOURCE)).rejects.toThrow(
      /privacy erasure ran in project history-review-apply-target/,
    );
    // The approved forget in the source manifest was not applied.
    expect(await getMemory('existing-memory')).toBeTruthy();
  });
});
