import fs from 'node:fs';
import path from 'node:path';

import { getGroupDir } from '../../src/group-dir.js';
import { writeHistoryManifest } from '../../src/modules/memory/history-reflection.js';
import {
  HISTORY_CANDIDATE_PROMPT_VERSION,
  HISTORY_MANIFEST_VERSION,
  HISTORY_REFLECTOR_PROMPT_VERSION,
  plannedHistoryMemoryId,
  type HistoryCandidate,
  type HistoryReflectionManifest,
} from '../../src/modules/memory/history-reflector-core.js';
import {
  historyReviewFingerprint,
  PROJECT_HISTORY_BATCH_VERSION,
  writeProjectHistoryBatch,
  type ProjectHistoryBatchManifest,
} from '../../src/modules/memory/project-history-reflection-batch.js';

const BATCH_ID = 'project-history-batch-ui-sandbox.json';
const MANIFEST_FILE = 'project-history-ui-sandbox.json';
const CONVERSATION_ID = 'ui-sandbox-history-conversation';

/** Ids of seeded `memories` rows that the fixture's proposals target. */
export const MEMORY_REVIEW_TARGET_IDS = {
  supersede: 'ui-memory-deploy-window',
  forget: 'ui-memory-private-contact',
} as const;

const FIXTURE_TIMES = {
  conversation: '2026-07-20T09:00:00.000Z',
  message: '2026-07-20T09:05:00.000Z',
  created: '2026-07-28T07:30:00.000Z',
  cutoff: '2026-07-28T07:00:00.000Z',
} as const;

function candidate(
  id: string,
  fields: Pick<
    HistoryCandidate,
    'memory_type' | 'claim' | 'change_kind' | 'importance' | 'tags'
  > & { excerpt: string },
): HistoryCandidate {
  const { excerpt, ...rest } = fields;
  return {
    id,
    planned_memory_id: plannedHistoryMemoryId(id),
    effective_at: FIXTURE_TIMES.message,
    confidence: 0.9,
    ...rest,
    evidence: [
      {
        source_kind: 'conversation',
        conversation_id: CONVERSATION_ID,
        message_id: `message-${id}`,
        role: 'user',
        created_at: FIXTURE_TIMES.message,
        date_basis: 'message_timestamp',
        excerpt,
      },
    ],
  };
}

function buildManifest(projectId: string): HistoryReflectionManifest {
  const create = candidate('ui-sandbox-create', {
    memory_type: 'decision',
    claim: 'Releases are cut from the develop branch.',
    change_kind: 'assert',
    importance: 0.85,
    tags: ['release', 'git'],
    excerpt: 'From now on we cut every release from develop.',
  });
  const supersede = candidate('ui-sandbox-supersede', {
    memory_type: 'decision',
    claim: 'Deployments now happen on Wednesday mornings.',
    change_kind: 'replace',
    importance: 0.8,
    tags: ['deploy'],
    excerpt: 'We moved the deploy window to Wednesday morning.',
  });
  const forget = candidate('ui-sandbox-forget', {
    memory_type: 'contact',
    claim: 'Remove the stored private phone number.',
    change_kind: 'forget',
    importance: 0.7,
    tags: ['privacy'],
    excerpt: 'Please delete the private phone number you saved earlier.',
  });
  const skipped = candidate('ui-sandbox-skipped', {
    memory_type: 'preference',
    claim: 'The user said thanks for the answer.',
    change_kind: 'assert',
    importance: 0.7,
    tags: [],
    excerpt: 'Thanks, that works.',
  });
  return {
    manifest_version: HISTORY_MANIFEST_VERSION,
    candidate_prompt_version: HISTORY_CANDIDATE_PROMPT_VERSION,
    reflector_prompt_version: HISTORY_REFLECTOR_PROMPT_VERSION,
    project_id: projectId,
    created_at: FIXTURE_TIMES.created,
    cutoff_at: FIXTURE_TIMES.cutoff,
    filters: { since: null, until: null },
    sources: { conversations: true, memory_files: false },
    memory_baseline: 'ui-sandbox-baseline',
    conversations: [
      {
        conversation_id: CONVERSATION_ID,
        objective_id: null,
        title: 'Release and deploy conventions',
        created_at: FIXTURE_TIMES.conversation,
        transcript_hash: 'ui-sandbox-transcript-hash',
        message_count: 4,
        candidates: [create, supersede, forget, skipped],
        errors: [],
      },
    ],
    memory_files: [],
    envelope: {
      memory_ops: [
        {
          op: 'create',
          candidate_ids: [create.id],
          new_memory_id: create.planned_memory_id,
          memory_type: 'decision',
          content: create.claim,
          valid_from: create.effective_at,
          importance: create.importance,
          tags: create.tags,
        },
        {
          op: 'supersede',
          candidate_ids: [supersede.id],
          new_memory_id: supersede.planned_memory_id,
          supersedes_id: MEMORY_REVIEW_TARGET_IDS.supersede,
          memory_type: 'decision',
          correction_content: supersede.claim,
          valid_from: supersede.effective_at,
          importance: supersede.importance,
          tags: supersede.tags,
        },
        {
          op: 'forget',
          candidate_ids: [forget.id],
          memory_id: MEMORY_REVIEW_TARGET_IDS.forget,
          target: 'private phone number',
        },
      ],
      skipped_candidates: [
        { candidate_ids: [skipped.id], reason: 'low-value pleasantry' },
      ],
    },
    errors: [],
    status: 'preview',
  };
}

/**
 * Writes a reviewable history-reflection batch (and its project manifest) so
 * the Memory Review page has proposals to walk. Reruns overwrite the same
 * files and discard any review sidecar, so seeding stays idempotent.
 */
export async function seedMemoryReviewFixtures(
  projectId: string,
): Promise<{ batchId: string }> {
  const manifest = buildManifest(projectId);
  const manifestPath = path.join(
    getGroupDir(projectId),
    'artifacts',
    'history-reflection',
    MANIFEST_FILE,
  );
  writeHistoryManifest(manifestPath, manifest);
  fs.rmSync(manifestPath.replace(/\.json$/i, '.review.json'), { force: true });

  const candidates = manifest.conversations.flatMap((c) => c.candidates);
  const batch: ProjectHistoryBatchManifest = {
    batch_version: PROJECT_HISTORY_BATCH_VERSION,
    created_at: manifest.created_at,
    cutoff_at: manifest.cutoff_at,
    filters: {
      project: projectId,
      since: null,
      until: null,
      sources: { conversations: true, native_memories: false },
    },
    agents: {
      observer: null,
      reflector: null,
      reflector_model: 'ui-sandbox fixture',
    },
    projects: [
      {
        project_id: projectId,
        import_manifests: [],
        memory_file_paths: [],
        declared_entries: 0,
        source_fingerprint: 'ui-sandbox-source-fingerprint',
        conversation_count: manifest.conversations.length,
        sources: { conversations: true, native_memories: false },
        reflection_manifest: `artifacts/history-reflection/${MANIFEST_FILE}`,
        review_fingerprint: historyReviewFingerprint(manifest),
        candidates: candidates.length,
        memory_ops: manifest.envelope.memory_ops.length,
        skipped_candidates: manifest.envelope.skipped_candidates.length,
        errors: [],
        status: 'preview',
      },
    ],
    status: 'preview',
    errors: [],
  };
  writeProjectHistoryBatch(
    path.join(getGroupDir('main'), 'artifacts', 'history-reflection', BATCH_ID),
    batch,
  );
  return { batchId: BATCH_ID };
}
