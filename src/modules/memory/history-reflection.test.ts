import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  conversations,
  memories,
  memoryTranscriptEvidence,
  objectives,
  projects,
} from '../../db/schema.js';
import {
  getMemory,
  getMemoryTimeline,
  getConversationsForHistoryReflection,
  initDatabase,
  insertMemory,
  recordPrivacyErasure,
} from '../../db.js';
import { eraseMemoryDurably } from './privacy-erasure.js';
import { chatTranscriptPath, getGroupDir } from '../../group-dir.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  HISTORY_CANDIDATE_PROMPT_VERSION,
  HISTORY_MANIFEST_VERSION,
  HISTORY_REFLECTOR_PROMPT_VERSION,
  applyHistoryEnvelopeToShadow,
  hashHistoryTranscript,
  hashHistoryMemoryFile,
  memoryBaselineFingerprint,
  normalizeHistoryMemoryFile,
  normalizeHistoryMessages,
  parseHistoryCandidates,
  parseHistoryReflectionEnvelope,
  plannedHistoryMemoryId,
  sourceRefForCandidates,
  type HistoryCandidate,
  type HistoryReflectionManifest,
} from './history-reflector-core.js';
import {
  applyRelocatedHistoryCreate,
  defaultDeps,
  applyHistoryReflectionManifest,
  finalizePartialHistoryReflectionManifest,
  listProjectMemoryFiles,
  runHistoryReflectionPreview,
} from './history-reflection.js';
import type { Memory } from './types.js';
import { withMemoryLifecycleLock } from './lifecycle-lock.js';
import {
  setVectorStoreHooks,
  type VectorStoreHooks,
} from '../vector-store/hooks.js';
import {
  checkpointHistoryApplyReceipt,
  prepareHistoryApplyReceipts,
} from './history-apply-state.js';

const PROJECT = 'history-reflection-test';
const TARGET_PROJECT = 'history-reflection-target-test';

function candidate(
  suffix: string,
  effectiveAt: string,
  claim = `Decision ${suffix}`,
): HistoryCandidate {
  const id = `candidate-${suffix}`;
  return {
    id,
    planned_memory_id: plannedHistoryMemoryId(id),
    memory_type: 'decision',
    claim,
    change_kind: 'assert',
    effective_at: effectiveAt,
    confidence: 0.95,
    importance: 0.8,
    tags: ['architecture'],
    evidence: [
      {
        source_kind: 'conversation',
        conversation_id: `conversation-${suffix}`,
        message_id: `message-${suffix}`,
        role: 'user',
        created_at: effectiveAt,
        date_basis: 'message_timestamp',
        excerpt: claim,
      },
    ],
  };
}

function memory(
  id: string,
  content: string,
  validFrom: string,
  overrides: Partial<Memory> = {},
): Memory {
  return {
    id,
    group_folder: PROJECT,
    objective_id: null,
    content,
    memory_type: 'decision',
    importance: 0.8,
    source: 'observer',
    sourceRef: 'test',
    tags: [],
    created_at: validFrom,
    updated_at: validFrom,
    last_accessed_at: validFrom,
    access_count: 0,
    valid_from: validFrom,
    valid_to: null,
    ...overrides,
  };
}

describe('history evidence and envelope validation', () => {
  test('normalizes only canonical conversation messages with stable provenance', () => {
    const messages = normalizeHistoryMessages(
      { id: 'conv-1', created_at: '2024-01-01T00:00:00.000Z' },
      [
        {
          id: 'user-1',
          type: 'message',
          role: 'user',
          content: 'Use queues between the services.',
          created_at: '2024-01-02T09:00:00Z',
          source: 'codex-native',
        },
        { type: 'telemetry', role: 'assistant', content: 'not dialogue' },
        {
          type: 'message',
          role: 'assistant',
          content: '[CONTEXT_SUMMARY: hidden]',
        },
      ],
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'user-1',
      conversation_id: 'conv-1',
      role: 'user',
      created_at: '2024-01-02T09:00:00.000Z',
      source: 'codex-native',
    });
  });

  test('rejects candidate evidence that does not exist in the source chunk', () => {
    const messages = normalizeHistoryMessages(
      { id: 'conv-1', created_at: '2024-01-01T00:00:00.000Z' },
      [
        {
          id: 'real-message',
          type: 'message',
          role: 'user',
          content: 'Choose SQLite.',
          created_at: '2024-01-02T09:00:00.000Z',
        },
      ],
    );
    const result = parseHistoryCandidates(
      JSON.stringify({
        candidates: [
          {
            memory_type: 'decision',
            claim: 'Use SQLite',
            change_kind: 'assert',
            effective_at: '2024-01-02T09:00:00.000Z',
            confidence: 0.9,
            importance: 0.8,
            evidence_message_ids: ['invented-message'],
          },
        ],
      }),
      'conv-1',
      messages,
      '2025-01-01T00:00:00.000Z',
    );
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(' ')).toContain('unknown invented-message');
  });

  test('uses memory-file mtime as the only accepted date and durable provenance', () => {
    const modifiedAt = '2024-02-03T04:05:06.000Z';
    const relativePath = '.agent/memories/native/claude/project-choice.md';
    const messages = normalizeHistoryMemoryFile(
      relativePath,
      'The project deliberately uses SQLite for its local metadata store.',
      modifiedAt,
    );
    const wrongDate = parseHistoryCandidates(
      JSON.stringify({
        candidates: [
          {
            memory_type: 'decision',
            claim: 'The project uses SQLite for its local metadata store',
            change_kind: 'assert',
            effective_at: '2024-01-01T00:00:00.000Z',
            confidence: 0.9,
            importance: 0.8,
            evidence_message_ids: [messages[0]!.id],
          },
        ],
      }),
      messages[0]!.conversation_id,
      messages,
      '2025-01-01T00:00:00.000Z',
      0,
      modifiedAt,
    );
    expect(wrongDate.candidates).toEqual([]);
    expect(wrongDate.errors.join(' ')).toContain('must equal source timestamp');

    const accepted = parseHistoryCandidates(
      JSON.stringify({
        candidates: [
          {
            memory_type: 'decision',
            claim: 'The project uses SQLite for its local metadata store',
            change_kind: 'assert',
            effective_at: modifiedAt,
            confidence: 0.9,
            importance: 0.8,
            evidence_message_ids: [messages[0]!.id],
          },
        ],
      }),
      messages[0]!.conversation_id,
      messages,
      '2025-01-01T00:00:00.000Z',
      0,
      modifiedAt,
    );
    expect(accepted.errors).toEqual([]);
    expect(accepted.candidates[0]!.evidence[0]).toMatchObject({
      source_kind: 'memory_file',
      memory_file_path: relativePath,
      date_basis: 'file_mtime',
    });
    expect(
      sourceRefForCandidates(
        [accepted.candidates[0]!.id],
        new Map([[accepted.candidates[0]!.id, accepted.candidates[0]!]]),
      ),
    ).toBe(
      `memory-file:${relativePath}#${accepted.candidates[0]!.evidence[0]!.message_id}`,
    );
  });

  test('requires every candidate to be accounted for and rejects low importance', () => {
    const item = candidate('a', '2024-01-01T00:00:00.000Z');
    const missing = parseHistoryReflectionEnvelope(
      '{"memory_ops":[],"skipped_candidates":[]}',
      [item],
      [],
      '2025-01-01T00:00:00.000Z',
    );
    expect(missing.envelope).toBeNull();
    expect(missing.errors.join(' ')).toContain('not accounted');

    const low = parseHistoryReflectionEnvelope(
      JSON.stringify({
        memory_ops: [
          {
            op: 'create',
            candidate_ids: [item.id],
            memory_type: 'decision',
            content: item.claim,
            valid_from: item.effective_at,
            importance: 0.69,
          },
        ],
        skipped_candidates: [],
      }),
      [item],
      [],
      '2025-01-01T00:00:00.000Z',
    );
    expect(low.envelope).toBeNull();
    expect(low.errors.join(' ')).toContain('0.7..1');
  });
});

describe('history shadow timeline', () => {
  test('preserves A → B → C without displacing the newer current memory', () => {
    const a = candidate('a', '2024-01-01T00:00:00.000Z', 'Use SQLite');
    const b = candidate('b', '2024-02-01T00:00:00.000Z', 'Use Postgres');
    const c = memory('memory-c', 'Use CockroachDB', '2024-03-01T00:00:00.000Z');
    const envelope = {
      memory_ops: [
        {
          op: 'create' as const,
          candidate_ids: [a.id],
          new_memory_id: a.planned_memory_id,
          memory_type: 'decision' as const,
          content: a.claim,
          valid_from: a.effective_at,
          importance: 0.8,
          tags: [],
          precedes_id: c.id,
        },
        {
          op: 'supersede' as const,
          candidate_ids: [b.id],
          new_memory_id: b.planned_memory_id,
          supersedes_id: a.planned_memory_id,
          memory_type: 'decision' as const,
          correction_content: b.claim,
          valid_from: b.effective_at,
          importance: 0.8,
          tags: [],
          precedes_id: c.id,
        },
      ],
      skipped_candidates: [],
    };

    const result = applyHistoryEnvelopeToShadow(
      [c],
      envelope,
      new Map([
        [a.id, a],
        [b.id, b],
      ]),
    );
    expect(result.errors).toEqual([]);
    const byId = new Map(result.timeline.map((item) => [item.id, item]));
    expect(byId.get(a.planned_memory_id)).toMatchObject({
      valid_to: b.effective_at,
      superseded_by: b.planned_memory_id,
    });
    expect(byId.get(b.planned_memory_id)).toMatchObject({
      valid_to: c.valid_from,
      superseded_by: c.id,
    });
    expect(byId.get(c.id)?.valid_to).toBeNull();
    expect(byId.get(c.id)?.superseded_by).toBeUndefined();
  });

  test('materializes a planned successor before an older create that references it', () => {
    const older = candidate('older-forward-link', '2024-01-01T00:00:00.000Z');
    const predecessor = candidate(
      'successor-predecessor',
      '2024-02-01T00:00:00.000Z',
    );
    const successor = candidate(
      'planned-successor',
      '2024-03-01T00:00:00.000Z',
    );
    const envelope = {
      memory_ops: [
        {
          op: 'create' as const,
          candidate_ids: [predecessor.id],
          new_memory_id: predecessor.planned_memory_id,
          memory_type: 'decision' as const,
          content: predecessor.claim,
          valid_from: predecessor.effective_at,
          importance: 0.8,
          tags: [],
        },
        {
          op: 'supersede' as const,
          candidate_ids: [successor.id],
          new_memory_id: successor.planned_memory_id,
          supersedes_id: predecessor.planned_memory_id,
          memory_type: 'decision' as const,
          correction_content: successor.claim,
          valid_from: successor.effective_at,
          importance: 0.8,
          tags: [],
        },
        {
          op: 'create' as const,
          candidate_ids: [older.id],
          new_memory_id: older.planned_memory_id,
          memory_type: 'decision' as const,
          content: older.claim,
          valid_from: older.effective_at,
          importance: 0.8,
          tags: [],
          precedes_id: successor.planned_memory_id,
        },
      ],
      skipped_candidates: [],
    };

    const result = applyHistoryEnvelopeToShadow(
      [],
      envelope,
      new Map([older, predecessor, successor].map((item) => [item.id, item])),
    );

    expect(result.errors).toEqual([]);
    const byId = new Map(result.timeline.map((item) => [item.id, item]));
    expect(byId.get(older.planned_memory_id)).toMatchObject({
      valid_to: successor.effective_at,
      superseded_by: successor.planned_memory_id,
    });
    expect(byId.get(predecessor.planned_memory_id)).toMatchObject({
      valid_to: successor.effective_at,
      superseded_by: successor.planned_memory_id,
    });
  });
});

describe('history preview', () => {
  test('stamps the privacy checkpoint before the baseline timeline is read', async () => {
    let baselineReadAt = Infinity;
    const manifest = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        cutoffAt: '2025-01-01T00:00:00.000Z',
        includeConversations: false,
        includeMemoryFiles: false,
      },
      {
        getTimeline: async () => {
          baselineReadAt = Date.now();
          return [];
        },
        getRules: async () => [],
      },
    );
    expect(Date.parse(manifest.privacy_checkpoint_at!)).toBeLessThanOrEqual(
      baselineReadAt,
    );
  });

  test('applies since and until to authoritative message timestamps', async () => {
    let selectedMessageIds: string[] = [];
    let progressTotal: number | undefined;
    const manifest = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        since: '2025-01-01T00:00:00.000Z',
        until: '2025-12-31T23:59:59.999Z',
        cutoffAt: '2027-01-01T00:00:00.000Z',
        includeMemoryFiles: false,
        onProgress: (progress) => {
          if (progress.phase === 'extract-conversations') {
            progressTotal = progress.total;
          }
        },
      },
      {
        listConversations: async () => [
          {
            id: 'conv-date-bounds',
            group_folder: PROJECT,
            preview: 'long-running conversation',
            title: 'Date bounds',
            created_at: '2024-01-01T00:00:00.000Z',
            objective_id: null,
          },
          {
            id: 'conv-no-date-bounds',
            group_folder: PROJECT,
            preview: 'outside the selected window',
            title: 'Outside window',
            created_at: '2024-01-02T00:00:00.000Z',
            objective_id: null,
          },
        ],
        readConversation: async (conversation) =>
          conversation.id === 'conv-date-bounds'
            ? [
                {
                  id: 'before-since',
                  type: 'message',
                  role: 'user',
                  content: 'Before the selected range.',
                  created_at: '2024-12-31T23:59:59.999Z',
                },
                {
                  id: 'inside-range',
                  type: 'message',
                  role: 'user',
                  content: 'Inside the selected range.',
                  created_at: '2025-06-01T12:00:00.000Z',
                },
                {
                  id: 'after-until',
                  type: 'message',
                  role: 'assistant',
                  content: 'After the selected range.',
                  created_at: '2026-01-01T00:00:00.000Z',
                },
              ]
            : [
                {
                  id: 'outside-window',
                  type: 'message',
                  role: 'assistant',
                  content: 'Outside the selected range.',
                  created_at: '2023-06-01T00:00:00.000Z',
                },
              ],
        getTimeline: async () => [],
        getRules: async () => [],
        previewConversations: async (_project, messages) => {
          selectedMessageIds = messages.map((item) => item.message.id);
          return { candidates: [], operations: [] };
        },
      },
    );

    expect(selectedMessageIds).toEqual(['inside-range']);
    expect(progressTotal).toBe(1);
    expect(manifest.conversations).toHaveLength(1);
    expect(manifest.conversations[0]!.message_count).toBe(1);
    expect(manifest.errors).toEqual([]);
  });

  test('uses the chronologically earlier offset bound for message selection', async () => {
    let selectedMessageIds: string[] = [];
    await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        until: '2024-12-31T20:00:00-05:00',
        cutoffAt: '2025-01-01T00:00:00.000Z',
        includeMemoryFiles: false,
      },
      {
        listConversations: async () => [
          {
            id: 'conv-offset-bound',
            group_folder: PROJECT,
            preview: 'offset boundary',
            title: 'Offset boundary',
            created_at: '2024-01-01T00:00:00.000Z',
            objective_id: null,
          },
        ],
        readConversation: async () => [
          {
            id: 'before-cutoff',
            type: 'message',
            role: 'user',
            content: 'This message is before the processing cutoff.',
            created_at: '2024-12-31T23:59:00.000Z',
          },
          {
            id: 'after-cutoff',
            type: 'message',
            role: 'user',
            content: 'This message is after the processing cutoff.',
            created_at: '2025-01-01T00:30:00.000Z',
          },
        ],
        getTimeline: async () => [],
        getRules: async () => [],
        previewConversations: async (_project, messages) => {
          selectedMessageIds = messages.map((item) => item.message.id);
          return { candidates: [], operations: [] };
        },
      },
    );

    expect(selectedMessageIds).toEqual(['before-cutoff']);
  });

  test('routes selected conversations through reviewable tool-preview operations', async () => {
    const effectiveAt = '2024-03-01T10:00:00.000Z';
    const toolCandidate = candidate(
      'tool-preview',
      effectiveAt,
      'Services communicate through a durable queue',
    );
    toolCandidate.evidence[0]!.conversation_id = 'conv-tool-preview';
    toolCandidate.evidence[0]!.message_id = 'message-tool-preview';
    const lowImportance = {
      ...candidate('low-importance', effectiveAt),
      importance: 0.62,
      evidence: toolCandidate.evidence,
    };
    let previewCalls = 0;

    const manifest = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        cutoffAt: '2025-01-01T00:00:00.000Z',
        includeMemoryFiles: false,
      },
      {
        listConversations: async () => [
          {
            id: 'conv-tool-preview',
            group_folder: PROJECT,
            preview: 'queue',
            title: 'Queue decision',
            created_at: effectiveAt,
            objective_id: null,
          },
        ],
        readConversation: async () => [
          {
            id: 'message-tool-preview',
            type: 'message',
            role: 'user',
            content: toolCandidate.claim,
            created_at: effectiveAt,
          },
        ],
        getTimeline: async () => [],
        getRules: async () => [],
        previewConversations: async (_project, messages) => {
          previewCalls++;
          expect(messages[0]).toMatchObject({
            conversationId: 'conv-tool-preview',
            toolId: 'history:conv-tool-preview:message-tool-preview',
            objectiveId: null,
          });
          return {
            candidates: [toolCandidate, lowImportance],
            operations: [
              {
                op: 'create',
                candidate_ids: [toolCandidate.id],
                new_memory_id: toolCandidate.planned_memory_id,
                memory_type: 'decision',
                content: toolCandidate.claim,
                valid_from: effectiveAt,
                importance: 0.8,
                tags: ['architecture'],
              },
              {
                op: 'create',
                candidate_ids: [lowImportance.id],
                new_memory_id: lowImportance.planned_memory_id,
                memory_type: lowImportance.memory_type,
                content: lowImportance.claim,
                valid_from: effectiveAt,
                importance: lowImportance.importance,
                tags: [],
              },
            ],
          };
        },
      },
    );

    expect(previewCalls).toBe(1);
    expect(manifest.errors).toEqual([]);
    expect(manifest.conversations[0]!.candidates).toEqual([
      toolCandidate,
      lowImportance,
    ]);
    expect(manifest.envelope.memory_ops).toHaveLength(1);
    expect(manifest.envelope.skipped_candidates).toEqual([
      {
        candidate_ids: [lowImportance.id],
        reason: expect.stringContaining('importance'),
      },
    ]);
  });

  test('replaces a planted tool-preview transcript link instead of writing through it', async () => {
    const projectId = 'history-preview-planted-link';
    const previewId = 'planted-preview-id';
    const artifacts = path.join(
      getGroupDir(projectId),
      'artifacts',
      'history-reflection',
    );
    fs.mkdirSync(artifacts, { recursive: true });
    const victimDir = fs.mkdtempSync(
      path.join(path.dirname(getGroupDir(projectId)), 'preview-victim-'),
    );
    const victim = path.join(victimDir, 'rule.md');
    fs.writeFileSync(victim, 'original rule');
    fs.symlinkSync(
      victim,
      path.join(artifacts, `.tool-preview-${previewId}.jsonl`),
    );
    try {
      // The reflector has no model configured here; only the file handling matters.
      await defaultDeps({ projectId })
        .previewConversations(
          projectId,
          [
            {
              toolId: 'history:conv:message',
              conversationId: 'conv',
              objectiveId: null,
              message: {
                id: 'message',
                role: 'user',
                content: 'PREVIEW-SECRET',
                created_at: '2024-03-01T10:00:00.000Z',
              } as never,
            },
          ],
          [],
          { projectId, previewId },
        )
        .catch(() => undefined);
      expect(fs.readFileSync(victim, 'utf8')).toBe('original rule');
      expect(
        fs.existsSync(path.join(artifacts, `.tool-preview-${previewId}.jsonl`)),
      ).toBe(false);
    } finally {
      fs.rmSync(victimDir, { recursive: true, force: true });
      fs.rmSync(getGroupDir(projectId), { recursive: true, force: true });
    }
  });

  test('checkpoints and resumes extraction and reflection within a project', async () => {
    const conversations = ['one', 'two'].map((suffix, index) => ({
      id: `conv-${suffix}`,
      group_folder: PROJECT,
      preview: suffix,
      title: suffix,
      created_at: `2024-01-0${index + 1}T00:00:00.000Z`,
      objective_id: null,
    }));
    const entriesByConversation = new Map(
      conversations.map((conversation) => [
        conversation.id,
        [
          {
            id: `message-${conversation.id}`,
            type: 'message',
            role: 'user',
            content: `Keep durable decision ${conversation.id}.`,
            created_at: conversation.created_at,
          },
        ],
      ]),
    );
    const checkpoints: HistoryReflectionManifest[] = [];
    const deps = {
      listConversations: async () => conversations,
      readConversation: async (conversation: (typeof conversations)[number]) =>
        entriesByConversation.get(conversation.id)!,
      getTimeline: async () => [],
      getRules: async () => [],
      extractCandidates: async (_prompt: string, userMessage: string) => {
        const messageId = userMessage.match(/"id":"(message-conv-[^"]+)"/)?.[1];
        const suffix = messageId?.replace('message-conv-', '');
        return JSON.stringify({
          candidates: [
            {
              memory_type: 'decision',
              claim: `Durable decision ${suffix}`,
              change_kind: 'assert',
              effective_at:
                suffix === 'one'
                  ? '2024-01-01T00:00:00.000Z'
                  : '2024-01-02T00:00:00.000Z',
              confidence: 0.95,
              importance: 0.8,
              tags: ['architecture'],
              evidence_message_ids: [messageId],
            },
          ],
        });
      },
      reflect: async (_prompt: string, userMessage: string) => {
        const candidateId = userMessage.match(
          /"id":"(hist-candidate-[^"]+)"/,
        )?.[1];
        const effectiveAt = userMessage.includes('Durable decision one')
          ? '2024-01-01T00:00:00.000Z'
          : '2024-01-02T00:00:00.000Z';
        return JSON.stringify({
          memory_ops: [
            {
              op: 'create',
              candidate_ids: [candidateId],
              memory_type: 'decision',
              content: `Durable decision ${effectiveAt}`,
              valid_from: effectiveAt,
              importance: 0.8,
              tags: ['architecture'],
            },
          ],
          skipped_candidates: [],
        });
      },
    };

    await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        cutoffAt: '2025-01-01T00:00:00.000Z',
        includeMemoryFiles: false,
        batchSize: 1,
        onCheckpoint: (manifest) => {
          checkpoints.push(structuredClone(manifest));
        },
      },
      deps,
    );

    const extractionCheckpoint = checkpoints.find(
      (manifest) =>
        manifest.conversations.length === 1 &&
        manifest.envelope.memory_ops.length === 0,
    )!;
    let resumedExtractionCalls = 0;
    const extractionResume = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        cutoffAt: '2025-01-01T00:00:00.000Z',
        includeMemoryFiles: false,
        batchSize: 1,
        priorManifest: extractionCheckpoint,
      },
      {
        ...deps,
        extractCandidates: async (...args) => {
          resumedExtractionCalls++;
          return deps.extractCandidates(...args);
        },
      },
    );
    expect(resumedExtractionCalls).toBe(1);
    expect(extractionResume.conversations).toHaveLength(2);

    const reflectionCheckpoint = checkpoints.find(
      (manifest) =>
        manifest.conversations.length === 2 &&
        manifest.envelope.memory_ops.length === 1,
    )!;
    let resumedReflectionCalls = 0;
    const resumedReflectionCheckpoints: HistoryReflectionManifest[] = [];
    const reflectionResume = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        cutoffAt: '2025-01-01T00:00:00.000Z',
        includeMemoryFiles: false,
        batchSize: 1,
        priorManifest: reflectionCheckpoint,
        onCheckpoint: (manifest) => {
          resumedReflectionCheckpoints.push(structuredClone(manifest));
        },
      },
      {
        ...deps,
        extractCandidates: async () => {
          throw new Error('completed extraction should have been reused');
        },
        reflect: async (...args) => {
          resumedReflectionCalls++;
          return deps.reflect(...args);
        },
      },
    );
    expect(resumedReflectionCalls).toBe(1);
    expect(
      resumedReflectionCheckpoints.every(
        (manifest) => manifest.envelope.memory_ops.length >= 1,
      ),
    ).toBe(true);
    expect(reflectionResume.envelope.memory_ops).toHaveLength(2);
  });

  test('finalizes a failed checkpoint without another LLM call', () => {
    const completed = candidate('completed', '2024-01-01T00:00:00.000Z');
    const unfinished = candidate('unfinished', '2024-01-02T00:00:00.000Z');
    const failed: HistoryReflectionManifest = {
      manifest_version: HISTORY_MANIFEST_VERSION,
      candidate_prompt_version: HISTORY_CANDIDATE_PROMPT_VERSION,
      reflector_prompt_version: HISTORY_REFLECTOR_PROMPT_VERSION,
      project_id: PROJECT,
      created_at: '2025-01-01T00:00:00.000Z',
      cutoff_at: '2025-01-01T00:00:00.000Z',
      privacy_checkpoint_at: '2024-12-31T00:00:00.000Z',
      filters: { since: null, until: null },
      sources: { conversations: true, memory_files: false },
      memory_baseline: memoryBaselineFingerprint([]),
      conversations: [
        {
          conversation_id: 'conversation-partial',
          objective_id: null,
          title: 'Partial',
          created_at: '2024-01-01T00:00:00.000Z',
          transcript_hash: 'partial-hash',
          message_count: 2,
          candidates: [completed, unfinished],
          errors: ['chunk 2: unknown evidence message'],
        },
      ],
      memory_files: [],
      envelope: {
        memory_ops: [
          {
            op: 'create',
            candidate_ids: [completed.id],
            new_memory_id: completed.planned_memory_id,
            memory_type: completed.memory_type,
            content: completed.claim,
            valid_from: completed.effective_at,
            importance: completed.importance,
            tags: completed.tags,
          },
        ],
        skipped_candidates: [],
      },
      errors: [
        'conversation-partial: chunk 2: unknown evidence message',
        'reflect conversations batch 2: invalid response',
      ],
      status: 'preview',
    };

    const finalized = finalizePartialHistoryReflectionManifest(
      failed,
      [],
      '2025-02-01T00:00:00.000Z',
    );
    expect(finalized.errors).toEqual([]);
    expect(finalized.privacy_checkpoint_at).toBe(failed.privacy_checkpoint_at);
    expect(finalized.envelope.memory_ops).toEqual(failed.envelope.memory_ops);
    expect(finalized.envelope.skipped_candidates).toEqual([
      {
        candidate_ids: [unfinished.id],
        reason: expect.any(String),
      },
    ]);
    expect(finalized.partial_finalization).toEqual({
      finalized_at: '2025-02-01T00:00:00.000Z',
      ignored_errors: failed.errors,
      skipped_candidates: 1,
    });

    const repeated = finalizePartialHistoryReflectionManifest(
      finalized,
      [],
      '2025-02-02T00:00:00.000Z',
    );
    expect(repeated.envelope.skipped_candidates).toHaveLength(1);
    expect(repeated.partial_finalization?.skipped_candidates).toBe(1);

    // Older checkpoints can contain tool-accepted scores below the history
    // threshold. Preserve the independent valid create and skip its invalid peers.
    const invalid = candidate('invalid-score', '2024-01-03T00:00:00.000Z');
    const dependent = candidate('dependent', '2024-01-04T00:00:00.000Z');
    failed.conversations[0]!.candidates.push(invalid, dependent);
    failed.envelope.memory_ops.push(
      {
        op: 'create',
        candidate_ids: [invalid.id],
        new_memory_id: invalid.planned_memory_id,
        memory_type: 'task',
        content: invalid.claim,
        valid_from: invalid.effective_at,
        importance: 0.62,
        tags: [],
      },
      {
        op: 'supersede',
        candidate_ids: [dependent.id],
        new_memory_id: dependent.planned_memory_id,
        supersedes_id: invalid.planned_memory_id,
        memory_type: 'task',
        correction_content: dependent.claim,
        valid_from: dependent.effective_at,
        importance: 0.78,
        tags: [],
      },
    );
    const recovered = finalizePartialHistoryReflectionManifest(failed, []);
    expect(recovered.envelope.memory_ops).toEqual(
      finalized.envelope.memory_ops,
    );
    expect(
      recovered.envelope.skipped_candidates.flatMap(
        (item) => item.candidate_ids,
      ),
    ).toEqual([unfinished.id, invalid.id, dependent.id]);
    expect(recovered.partial_finalization?.ignored_errors.join(' ')).toContain(
      'importance',
    );
    expect(recovered.errors).toEqual([]);
    expect(
      parseHistoryReflectionEnvelope(
        JSON.stringify(recovered.envelope),
        recovered.conversations[0]!.candidates,
        [],
        recovered.cutoff_at,
      ).errors,
    ).toEqual([]);

    // An independent forget is ready before the supersede/invalidate chain
    // during dependency traversal, but must stay in its original review slot.
    const successor = candidate('successor', '2024-02-01T00:00:00.000Z');
    const cessation = candidate('cessation', '2024-03-01T00:00:00.000Z');
    const erasure = candidate('erasure', '2024-04-01T00:00:00.000Z');
    const obsolete = memory(
      'obsolete',
      'Obsolete fact',
      '2023-01-01T00:00:00.000Z',
    );
    const orderedInput = structuredClone(recovered);
    orderedInput.memory_baseline = memoryBaselineFingerprint([obsolete]);
    orderedInput.conversations[0]!.candidates.push(
      successor,
      cessation,
      erasure,
    );
    orderedInput.envelope.memory_ops.push(
      {
        op: 'supersede',
        candidate_ids: [successor.id],
        new_memory_id: successor.planned_memory_id,
        supersedes_id: completed.planned_memory_id,
        memory_type: 'decision',
        correction_content: successor.claim,
        valid_from: successor.effective_at,
        importance: 0.8,
        tags: [],
      },
      {
        op: 'invalidate',
        candidate_ids: [cessation.id],
        memory_id: successor.planned_memory_id,
        effective_at: cessation.effective_at,
        reason: 'No longer valid',
      },
      {
        op: 'forget',
        candidate_ids: [erasure.id],
        memory_id: obsolete.id,
        target: obsolete.content,
      },
    );
    const orderedRecovery = finalizePartialHistoryReflectionManifest(
      orderedInput,
      [obsolete],
    );
    expect(orderedRecovery.envelope.memory_ops).toEqual(
      orderedInput.envelope.memory_ops,
    );
    expect(orderedRecovery.errors).toEqual([]);
  });

  test('rejects a selected native file when its import-manifest verification is missing', async () => {
    const relativePath = '.agent/memories/native/claude/fact.md';
    let extractionCalls = 0;
    const manifest = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        cutoffAt: '2026-01-02T00:00:00.000Z',
        includeConversations: false,
        memoryFilePaths: [relativePath],
        requireNativeManifest: true,
      },
      {
        listMemoryFiles: async () => [
          {
            sourceId: `memory-file:${relativePath}`,
            relativePath,
            modifiedAt: '2026-01-01T00:00:00.000Z',
            timestampSource: 'filesystem_mtime',
            content: 'Changed after native import.',
            byteCount: 28,
          },
        ],
        getTimeline: async () => [],
        getRules: async () => [],
        extractCandidates: async () => {
          extractionCalls++;
          return '{"candidates":[]}';
        },
        reflect: async () => '{"memory_ops":[],"skipped_candidates":[]}',
      },
    );

    expect(extractionCalls).toBe(0);
    expect(manifest.memory_files).toEqual([]);
    expect(manifest.errors.join(' ')).toContain(
      'missing or no longer verified',
    );
  });

  test('reconciles recovered memories before conversations in one preview', async () => {
    const relativePath = '.agent/memories/native/claude/decision.md';
    const modifiedAt = '2024-01-01T00:00:00.000Z';
    const conversation = {
      id: 'conv-after-memory',
      group_folder: PROJECT,
      preview: 'same decision',
      title: 'Same decision',
      created_at: '2024-01-02T00:00:00.000Z',
      objective_id: null,
    };
    const reflectionSources: string[] = [];
    const manifest = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        cutoffAt: '2025-01-01T00:00:00.000Z',
      },
      {
        listConversations: async () => [conversation],
        readConversation: async () => [
          {
            id: 'conversation-evidence',
            type: 'message',
            role: 'user',
            content: 'We require deterministic certificate fixtures.',
            created_at: '2024-01-02T00:00:00.000Z',
          },
        ],
        listMemoryFiles: async () => [
          {
            sourceId: `memory-file:${relativePath}`,
            relativePath,
            modifiedAt,
            timestampSource: 'filesystem_mtime',
            content: 'Certificate fixtures must be deterministic.',
            byteCount: 43,
          },
        ],
        getTimeline: async () => [],
        getRules: async () => [],
        extractCandidates: async (_prompt, userMessage) => {
          const evidenceId = userMessage.match(/"id":"([^"]+)"/)?.[1];
          const isFile = userMessage.includes(
            'Evidence source kind: recovered memory file',
          );
          return JSON.stringify({
            candidates: [
              {
                memory_type: 'decision',
                claim: 'Certificate fixtures must be deterministic',
                change_kind: 'assert',
                effective_at: isFile ? modifiedAt : '2024-01-02T00:00:00.000Z',
                confidence: 0.9,
                importance: 0.8,
                tags: ['testing'],
                evidence_message_ids: [evidenceId],
              },
            ],
          });
        },
        reflect: async (_prompt, userMessage) => {
          const sourceKind = userMessage.match(/"source_kind":"([^"]+)"/)?.[1];
          reflectionSources.push(sourceKind ?? 'missing');
          const candidateId = userMessage.match(
            /"id":"(hist-candidate-[^"]+)"/,
          )?.[1];
          if (sourceKind === 'memory_file') {
            return JSON.stringify({
              memory_ops: [
                {
                  op: 'create',
                  candidate_ids: [candidateId],
                  memory_type: 'decision',
                  content: 'Certificate fixtures must be deterministic',
                  valid_from: modifiedAt,
                  importance: 0.8,
                  tags: ['testing'],
                },
              ],
              skipped_candidates: [],
            });
          }
          expect(userMessage).toContain(
            'Certificate fixtures must be deterministic',
          );
          return JSON.stringify({
            memory_ops: [],
            skipped_candidates: [
              { candidate_ids: [candidateId], reason: 'duplicate' },
            ],
          });
        },
      },
    );

    expect(manifest.errors).toEqual([]);
    expect(reflectionSources).toEqual(['memory_file', 'conversation']);
    expect(manifest.envelope.memory_ops).toHaveLength(1);
    expect(manifest.envelope.skipped_candidates).toHaveLength(1);
  });
});

describe('history manifest apply', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
  });

  beforeEach(async () => {
    await truncateTestDb();
    fs.rmSync(getGroupDir(PROJECT), { recursive: true, force: true });
    await drizzleDbRef.current.insert(projects).values({
      id: PROJECT,
      jid: `${PROJECT}@test`,
      name: PROJECT,
      folder: PROJECT,
      trigger: '!',
      added_at: new Date().toISOString(),
      is_main: 0,
    });
    await drizzleDbRef.current.insert(projects).values({
      id: TARGET_PROJECT,
      jid: `${TARGET_PROJECT}@test`,
      name: TARGET_PROJECT,
      folder: TARGET_PROJECT,
      trigger: '!',
      added_at: new Date().toISOString(),
      is_main: 0,
    });
  });

  afterAll(() => {
    fs.rmSync(getGroupDir(PROJECT), { recursive: true, force: true });
    fs.rmSync(getGroupDir(TARGET_PROJECT), { recursive: true, force: true });
  });

  async function manifestFor(
    item: HistoryCandidate,
    timeline: Memory[],
    envelope: HistoryReflectionManifest['envelope'],
  ): Promise<HistoryReflectionManifest> {
    const conversationId = item.evidence[0]!.conversation_id;
    await drizzleDbRef.current.insert(conversations).values({
      id: conversationId,
      group_folder: PROJECT,
      preview: item.claim,
      title: 'History',
      created_at: item.effective_at,
      pinned: 0,
      use_worktree: 0,
      brain_managed: 0,
    });
    const entry = {
      id: item.evidence[0]!.message_id,
      type: 'message',
      role: item.evidence[0]!.role,
      content: item.claim,
      created_at: item.evidence[0]!.created_at,
    };
    const transcriptPath = chatTranscriptPath(
      PROJECT,
      undefined,
      conversationId,
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);
    const normalized = normalizeHistoryMessages(
      { id: conversationId, created_at: item.effective_at },
      [entry],
    );
    return {
      manifest_version: HISTORY_MANIFEST_VERSION,
      candidate_prompt_version: HISTORY_CANDIDATE_PROMPT_VERSION,
      reflector_prompt_version: HISTORY_REFLECTOR_PROMPT_VERSION,
      project_id: PROJECT,
      created_at: '2025-01-01T00:00:00.000Z',
      cutoff_at: '2025-01-01T00:00:00.000Z',
      filters: { since: null, until: null },
      sources: { conversations: true, memory_files: true },
      memory_baseline: memoryBaselineFingerprint(timeline),
      conversations: [
        {
          conversation_id: item.evidence[0]!.conversation_id,
          objective_id: null,
          title: 'History',
          created_at: item.effective_at,
          transcript_hash: hashHistoryTranscript(normalized),
          message_count: 1,
          candidates: [item],
          errors: [],
        },
      ],
      memory_files: [],
      envelope,
      errors: [],
      status: 'preview',
    };
  }

  test('applies a relocated standalone create idempotently', async () => {
    const item = candidate('relocated', '2024-01-01T00:00:00.000Z');
    await drizzleDbRef.current.insert(objectives).values({
      id: 'source-objective',
      project_id: PROJECT,
      title: 'Source objective',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    });
    const operation = {
      op: 'create' as const,
      candidate_ids: [item.id],
      new_memory_id: item.planned_memory_id,
      objective_id: 'source-objective',
      memory_type: 'decision' as const,
      content: item.claim,
      valid_from: item.effective_at,
      importance: 0.8,
      tags: ['application'],
    };

    const first = await applyRelocatedHistoryCreate(
      TARGET_PROJECT,
      operation,
      [item],
      '2025-01-01T00:00:00.000Z',
    );
    const second = await applyRelocatedHistoryCreate(
      TARGET_PROJECT,
      operation,
      [item],
      '2025-01-01T00:00:00.000Z',
    );

    expect(first).toMatchObject({
      alreadyApplied: false,
      applied: { created: 1 },
    });
    expect(second).toMatchObject({
      alreadyApplied: true,
      applied: { created: 0 },
    });
    expect(await getMemory(item.planned_memory_id)).toMatchObject({
      group_folder: TARGET_PROJECT,
      objective_id: null,
      content: item.claim,
      tags: ['application'],
    });
  });

  test('applies a backdated prepend with provenance and is idempotent', async () => {
    const current = await insertMemory({
      id: 'memory-current',
      group_folder: PROJECT,
      objective_id: null,
      content: 'Use Postgres',
      memory_type: 'decision',
      importance: 0.8,
      source: 'agent',
      valid_from: '2024-03-01T00:00:00.000Z',
    });
    const timeline = [current];
    const item = candidate('old', '2024-01-01T00:00:00.000Z', 'Use SQLite');
    const manifest = await manifestFor(item, timeline, {
      memory_ops: [
        {
          op: 'create',
          candidate_ids: [item.id],
          new_memory_id: item.planned_memory_id,
          memory_type: 'decision',
          content: item.claim,
          valid_from: item.effective_at,
          importance: 0.8,
          tags: ['architecture'],
          precedes_id: current.id,
        },
      ],
      skipped_candidates: [],
    });

    const first = await applyHistoryReflectionManifest(manifest);
    expect(first).toMatchObject({
      alreadyApplied: false,
      applied: { created: 1 },
    });
    expect(await getMemory(item.planned_memory_id)).toMatchObject({
      valid_from: item.effective_at,
      valid_to: current.valid_from,
      superseded_by: current.id,
      sourceRef: 'conversation:conversation-old#message-old',
    });
    expect(await getMemory(current.id)).toMatchObject({
      valid_to: null,
      superseded_by: null,
    });

    const second = await applyHistoryReflectionManifest(manifest);
    expect(second.alreadyApplied).toBe(true);
  });

  test('resumes a multi-operation apply after a secondary-store failure', async () => {
    const firstItem = candidate(
      'resume-first',
      '2024-01-01T00:00:00.000Z',
      'Use signed release manifests',
    );
    const secondItem = candidate(
      'resume-second',
      '2024-02-01T00:00:00.000Z',
      'Retain deployment attestations',
    );
    const firstManifest = await manifestFor(firstItem, [], {
      memory_ops: [],
      skipped_candidates: [{ candidate_ids: [firstItem.id], reason: 'seed' }],
    });
    const secondManifest = await manifestFor(secondItem, [], {
      memory_ops: [],
      skipped_candidates: [{ candidate_ids: [secondItem.id], reason: 'seed' }],
    });
    const createOperation = (item: HistoryCandidate) => ({
      op: 'create' as const,
      candidate_ids: [item.id],
      new_memory_id: item.planned_memory_id,
      memory_type: item.memory_type,
      content: item.claim,
      valid_from: item.effective_at,
      importance: item.importance,
      tags: item.tags,
    });
    const manifest: HistoryReflectionManifest = {
      ...firstManifest,
      conversations: [
        ...firstManifest.conversations,
        ...secondManifest.conversations,
      ],
      envelope: {
        memory_ops: [createOperation(firstItem), createOperation(secondItem)],
        skipped_candidates: [],
      },
    };
    const embedded: string[] = [];
    let failSecond = true;
    const hooks: VectorStoreHooks = {
      embedAndStore: async (memoryId) => {
        embedded.push(memoryId);
        if (memoryId === secondItem.planned_memory_id && failSecond) {
          throw new Error('vector store unavailable');
        }
      },
      enhanceRecall: async () => null,
      eraseMemory: async () => {},
      invalidateMemory: async () => {},
      eraseGraphFactsMatchingTarget: async () => {},
      upsertEntity: () => {},
      upsertRelation: async () => {},
      expandEntities: async () => null,
      isAvailable: () => true,
      isVectorOnlyRecall: () => false,
      minScore: () => 0.5,
    };
    setVectorStoreHooks(hooks);
    try {
      await expect(applyHistoryReflectionManifest(manifest)).rejects.toThrow(
        /vector store unavailable/,
      );
      expect(await getMemory(firstItem.planned_memory_id)).toBeDefined();
      expect(await getMemory(secondItem.planned_memory_id)).toBeDefined();

      const concurrent = await insertMemory({
        id: 'memory-concurrent-after-partial-apply',
        group_folder: PROJECT,
        objective_id: null,
        content: 'A concurrent automatic memory',
        memory_type: 'project',
        source: 'agent',
      });
      await expect(applyHistoryReflectionManifest(manifest)).rejects.toThrow(
        /baseline changed after the partial History Review apply/,
      );
      await drizzleDbRef.current
        .delete(memories)
        .where(eq(memories.id, concurrent.id));

      failSecond = false;
      const resumed = await applyHistoryReflectionManifest(manifest);
      expect(resumed).toMatchObject({
        alreadyApplied: false,
        applied: { created: 1 },
      });
      expect(embedded).toEqual([
        firstItem.planned_memory_id,
        secondItem.planned_memory_id,
        secondItem.planned_memory_id,
      ]);
      expect(await applyHistoryReflectionManifest(manifest)).toMatchObject({
        alreadyApplied: true,
      });
    } finally {
      setVectorStoreHooks(null!);
    }
  });

  test('reconciles a committed operation whose receipt checkpoint was lost', async () => {
    const firstItem = candidate(
      'crash-first',
      '2024-01-01T00:00:00.000Z',
      'Use signed release manifests',
    );
    const secondItem = candidate(
      'crash-second',
      '2024-02-01T00:00:00.000Z',
      'Retain deployment attestations',
    );
    const firstManifest = await manifestFor(firstItem, [], {
      memory_ops: [],
      skipped_candidates: [{ candidate_ids: [firstItem.id], reason: 'seed' }],
    });
    const secondManifest = await manifestFor(secondItem, [], {
      memory_ops: [],
      skipped_candidates: [{ candidate_ids: [secondItem.id], reason: 'seed' }],
    });
    const createOperation = (item: HistoryCandidate) => ({
      op: 'create' as const,
      candidate_ids: [item.id],
      new_memory_id: item.planned_memory_id,
      memory_type: item.memory_type,
      content: item.claim,
      valid_from: item.effective_at,
      importance: item.importance,
      tags: item.tags,
    });
    const operations = [
      createOperation(firstItem),
      createOperation(secondItem),
    ];
    const manifest: HistoryReflectionManifest = {
      ...firstManifest,
      conversations: [
        ...firstManifest.conversations,
        ...secondManifest.conversations,
      ],
      envelope: { memory_ops: operations, skipped_candidates: [] },
    };
    const { status: _status, applied_at: _appliedAt, ...reviewed } = manifest;
    const manifestId = createHash('sha256')
      .update(JSON.stringify(reviewed))
      .digest('base64url');
    const receipts = await prepareHistoryApplyReceipts(
      manifestId,
      PROJECT,
      operations,
      [],
    );
    const candidates = new Map(
      [firstItem, secondItem].map((item) => [item.id, item]),
    );
    const insertAppliedCreate = (item: HistoryCandidate) =>
      insertMemory({
        id: item.planned_memory_id,
        group_folder: PROJECT,
        objective_id: null,
        content: item.claim,
        memory_type: item.memory_type,
        importance: item.importance,
        source: 'observer',
        sourceRef: sourceRefForCandidates([item.id], candidates),
        tags: item.tags,
        valid_from: item.effective_at,
      });

    await insertAppliedCreate(firstItem);
    await checkpointHistoryApplyReceipt(
      receipts[0]!.id,
      'completed',
      memoryBaselineFingerprint(await getMemoryTimeline(PROJECT)),
    );
    // This is the crash boundary: operation 2 committed in SQL, but its
    // pending receipt still has no baseline checkpoint.
    await insertAppliedCreate(secondItem);

    const resumed = await applyHistoryReflectionManifest(manifest);

    expect(resumed).toMatchObject({
      alreadyApplied: true,
      applied: { created: 0, superseded: 0, invalidated: 0, forgotten: 0 },
    });
    expect(await getMemory(firstItem.planned_memory_id)).toBeDefined();
    expect(await getMemory(secondItem.planned_memory_id)).toBeDefined();
    expect(
      await drizzleDbRef.current
        .select()
        .from(memoryTranscriptEvidence)
        .where(
          eq(memoryTranscriptEvidence.memoryId, secondItem.planned_memory_id),
        ),
    ).toHaveLength(1);
  });

  test('revalidates the reviewed baseline after entering the lifecycle lock', async () => {
    const target = await insertMemory({
      id: 'memory-concurrent-review-target',
      group_folder: PROJECT,
      objective_id: null,
      content: 'Deployments use the reviewed release process',
      memory_type: 'decision',
      source: 'agent',
      valid_from: '2024-01-01T00:00:00.000Z',
    });
    const item = candidate(
      'concurrent-invalidate',
      '2024-03-01T00:00:00.000Z',
      'The release process was retired',
    );
    const manifest = await manifestFor(item, [target], {
      memory_ops: [
        {
          op: 'invalidate',
          candidate_ids: [item.id],
          memory_id: target.id,
          effective_at: item.effective_at,
          reason: 'The reviewed transcript says the process was retired',
        },
      ],
      skipped_candidates: [],
    });
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let markWriterEntered!: () => void;
    const writerEntered = new Promise<void>((resolve) => {
      markWriterEntered = resolve;
    });
    const writer = withMemoryLifecycleLock(PROJECT, async () => {
      markWriterEntered();
      await writerGate;
      await drizzleDbRef.current
        .update(memories)
        .set({
          content: 'A concurrent writer revised the release process',
          updated_at: '2025-02-01T00:00:00.000Z',
        })
        .where(eq(memories.id, target.id));
    });
    await writerEntered;
    const applying = applyHistoryReflectionManifest(manifest, {
      trustStoredSources: true,
    });
    releaseWriter();
    await writer;

    await expect(applying).rejects.toThrow(/Memory baseline changed/);
    expect(await getMemory(target.id)).toMatchObject({
      content: 'A concurrent writer revised the release process',
      valid_to: null,
    });
  });

  test('conversation inventory includes regular and objective histories chronologically', async () => {
    await drizzleDbRef.current.insert(conversations).values([
      {
        id: 'conv-objective',
        group_folder: PROJECT,
        preview: 'objective',
        created_at: '2024-02-01T00:00:00.000Z',
        objective_id: 'objective-1',
      },
      {
        id: 'conv-regular',
        group_folder: PROJECT,
        preview: 'regular',
        created_at: '2024-01-01T00:00:00.000Z',
        objective_id: null,
      },
    ]);
    const rows = await getConversationsForHistoryReflection(PROJECT);
    expect(rows.map((row) => [row.id, row.objective_id])).toEqual([
      ['conv-regular', null],
      ['conv-objective', 'objective-1'],
    ]);
  });

  test('prefers verified native import metadata over a copied file timestamp', async () => {
    const nativeDir = path.join(
      getGroupDir(PROJECT),
      '.agent',
      'memories',
      'native',
      'claude',
      'sandbox',
      'project',
    );
    const filePath = path.join(nativeDir, 'decision.md');
    const content = 'The project deliberately uses SQLite.';
    const sourceMtime = '2024-02-03T04:05:06.000Z';
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.writeFileSync(filePath, content);
    fs.writeFileSync(
      path.join(nativeDir, '.native-memory-import.json'),
      JSON.stringify({
        'decision.md': {
          provider: 'claude',
          sourceLabel: 'sandbox',
          nativeProject: '-workspace-project',
          sourcePath: '/original/memory/decision.md',
          relativePath: 'decision.md',
          sourceBirthtime: '2024-02-03T04:00:00.000Z',
          sourceMtime,
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      }),
    );

    const [file] = await listProjectMemoryFiles(PROJECT);
    expect(file).toMatchObject({
      modifiedAt: sourceMtime,
      timestampSource: 'native_import_manifest',
      nativeOrigin: {
        provider: 'claude',
        source_label: 'sandbox',
        source_mtime: sourceMtime,
        source_path: '/original/memory/decision.md',
      },
    });

    fs.writeFileSync(filePath, `${content}\nChanged after import.`);
    const [changed] = await listProjectMemoryFiles(PROJECT);
    expect(changed!.timestampSource).toBe('filesystem_mtime');
    expect(changed!.nativeOrigin).toBeUndefined();
  });

  test('imports an old recovered memory file as a still-current fact with file provenance', async () => {
    const modifiedAt = '2024-02-03T04:05:06.000Z';
    const relativePath =
      '.agent/memories/native/claude/host/project/project-choice.md';
    const filePath = path.join(getGroupDir(PROJECT), relativePath);
    const content =
      'The project deliberately uses SQLite for local metadata because deployments must remain self-contained.';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    fs.utimesSync(filePath, new Date(modifiedAt), new Date(modifiedAt));

    const discovered = await listProjectMemoryFiles(PROJECT);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      relativePath,
      modifiedAt,
      timestampSource: 'filesystem_mtime',
    });

    const manifest = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        cutoffAt: '2025-01-01T00:00:00.000Z',
        includeConversations: false,
      },
      {
        getTimeline: async () => [],
        getRules: async () => [],
        extractCandidates: async (_prompt, userMessage) => {
          expect(userMessage).toContain('Date basis: file_mtime');
          const evidenceId = userMessage.match(
            /"id":"(memory-file-content-[^"]+)"/,
          )?.[1];
          return JSON.stringify({
            candidates: [
              {
                memory_type: 'decision',
                claim:
                  'The project uses SQLite for self-contained local metadata',
                change_kind: 'assert',
                effective_at: modifiedAt,
                confidence: 0.95,
                importance: 0.8,
                tags: ['architecture'],
                evidence_message_ids: [evidenceId],
              },
            ],
          });
        },
        reflect: async (_prompt, userMessage) => {
          const candidateId = userMessage.match(
            /"id":"(hist-candidate-[^"]+)"/,
          )?.[1];
          return JSON.stringify({
            memory_ops: [
              {
                op: 'create',
                candidate_ids: [candidateId],
                memory_type: 'decision',
                content:
                  'The project uses SQLite for self-contained local metadata',
                valid_from: modifiedAt,
                importance: 0.8,
                tags: ['architecture'],
              },
            ],
            skipped_candidates: [],
          });
        },
      },
    );

    expect(manifest.conversations).toEqual([]);
    expect(manifest.memory_files).toHaveLength(1);
    expect(manifest.memory_files[0]).toMatchObject({
      relative_path: relativePath,
      modified_at: modifiedAt,
      file_hash: hashHistoryMemoryFile(relativePath, content, modifiedAt),
    });

    const result = await applyHistoryReflectionManifest(manifest);
    expect(result.applied.created).toBe(1);
    const createdId = (
      manifest.envelope.memory_ops[0] as { new_memory_id: string }
    ).new_memory_id;
    expect(await getMemory(createdId)).toMatchObject({
      valid_from: modifiedAt,
      valid_to: null,
      sourceRef: expect.stringContaining(
        `memory-file:${relativePath}#memory-file-content-`,
      ),
    });
  });

  test('rejects a reviewed manifest when a recovered memory file changes', async () => {
    const modifiedAt = '2024-02-03T04:05:06.000Z';
    const relativePath = '.agent/memories/native/claude/fact.md';
    const filePath = path.join(getGroupDir(PROJECT), relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'A durable project fact.');
    fs.utimesSync(filePath, new Date(modifiedAt), new Date(modifiedAt));

    const manifest = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        cutoffAt: '2025-01-01T00:00:00.000Z',
        includeConversations: false,
      },
      {
        getTimeline: async () => [],
        getRules: async () => [],
        extractCandidates: async () => '{"candidates":[]}',
        reflect: async () => {
          throw new Error('no candidates should skip reflection');
        },
      },
    );
    fs.writeFileSync(filePath, 'The source changed after preview.');
    fs.utimesSync(filePath, new Date(modifiedAt), new Date(modifiedAt));

    await expect(applyHistoryReflectionManifest(manifest)).rejects.toThrow(
      /Memory file changed after preview/,
    );

    const trusted = await applyHistoryReflectionManifest(manifest, {
      trustStoredSources: true,
    });
    expect(trusted.applied).toEqual({
      created: 0,
      superseded: 0,
      invalidated: 0,
      forgotten: 0,
    });
  });

  test('safely rebases reviewed operations after unrelated memory changes', async () => {
    const item = candidate('reviewed-rebase', '2024-01-01T00:00:00.000Z');
    const manifest = await manifestFor(item, [], {
      memory_ops: [
        {
          op: 'create',
          candidate_ids: [item.id],
          new_memory_id: item.planned_memory_id,
          memory_type: item.memory_type,
          content: item.claim,
          valid_from: item.effective_at,
          importance: item.importance,
          tags: item.tags,
        },
      ],
      skipped_candidates: [],
    });
    await insertMemory({
      group_folder: PROJECT,
      objective_id: null,
      content: 'An unrelated memory written during human review',
      memory_type: 'project',
      source: 'agent',
    });

    const result = await applyHistoryReflectionManifest(manifest, {
      allowBaselineRebase: true,
    });

    expect(result.baselineRebased).toBe(true);
    expect(result.applied.created).toBe(1);
    expect((await getMemory(item.planned_memory_id))?.content).toBe(item.claim);
  });

  test('imports an approved create after its baseline successor was deleted', async () => {
    const missingSuccessor = memory(
      'memory-deleted-successor',
      'A later fact that was removed during review',
      '2024-06-01T00:00:00.000Z',
    );
    const item = candidate(
      'deleted-successor',
      '2024-01-01T00:00:00.000Z',
      'Approved historical fact',
    );
    const manifest = await manifestFor(item, [missingSuccessor], {
      memory_ops: [
        {
          op: 'create',
          candidate_ids: [item.id],
          new_memory_id: item.planned_memory_id,
          memory_type: item.memory_type,
          content: item.claim,
          valid_from: item.effective_at,
          importance: item.importance,
          tags: item.tags,
          precedes_id: missingSuccessor.id,
        },
      ],
      skipped_candidates: [],
    });

    const first = await applyHistoryReflectionManifest(manifest, {
      allowBaselineRebase: true,
    });
    expect(first).toMatchObject({
      alreadyApplied: false,
      baselineRebased: true,
      applied: { created: 1 },
    });
    expect(await getMemory(item.planned_memory_id)).toMatchObject({
      content: item.claim,
      valid_to: null,
    });

    const second = await applyHistoryReflectionManifest(manifest, {
      allowBaselineRebase: true,
    });
    expect(second).toMatchObject({
      alreadyApplied: true,
      baselineRebased: true,
    });
  });

  describe('privacy erasure after preview', () => {
    const ERASED_TEXT = 'Alex home address is 12 Example Street Bucharest';
    const ERASURE_ERROR =
      /privacy erasure ran in project .* after this preview/;

    async function erasedFixture(opts: {
      supersede?: boolean;
      checkpoint?: string;
    }) {
      const erased = await insertMemory({
        id: 'memory-to-erase',
        group_folder: PROJECT,
        objective_id: null,
        content: ERASED_TEXT,
        memory_type: 'decision',
        importance: 0.8,
        source: 'agent',
        valid_from: '2024-01-01T00:00:00.000Z',
      });
      const item = candidate(
        `erased-${opts.supersede ? 'supersede' : 'create'}`,
        '2024-04-01T00:00:00.000Z',
        ERASED_TEXT,
      );
      const base = {
        candidate_ids: [item.id],
        new_memory_id: item.planned_memory_id,
        memory_type: item.memory_type,
        valid_from: item.effective_at,
        importance: item.importance,
        tags: item.tags,
      };
      const manifest = await manifestFor(
        item,
        await getMemoryTimeline(PROJECT),
        {
          memory_ops: [
            opts.supersede
              ? {
                  op: 'supersede' as const,
                  ...base,
                  supersedes_id: erased.id,
                  correction_content: item.claim,
                }
              : { op: 'create' as const, ...base, content: item.claim },
          ],
          skipped_candidates: [],
        },
      );
      if (opts.checkpoint) manifest.privacy_checkpoint_at = opts.checkpoint;
      await eraseMemoryDurably(erased.id, PROJECT, ERASED_TEXT);
      expect(await getMemory(erased.id)).toBeFalsy();
      return { manifest, plannedId: item.planned_memory_id };
    }

    const BEFORE_ERASURE = () => new Date(Date.now() - 60_000).toISOString();

    test('refuses a rebased create that would restore erased content', async () => {
      const { manifest, plannedId } = await erasedFixture({
        checkpoint: BEFORE_ERASURE(),
      });
      await expect(
        applyHistoryReflectionManifest(manifest, { allowBaselineRebase: true }),
      ).rejects.toThrow(ERASURE_ERROR);
      expect(await getMemory(plannedId)).toBeFalsy();
      expect(await getMemoryTimeline(PROJECT)).toEqual([]);
    });

    test('refuses a supersede of an erased target that the rebase would turn into a create', async () => {
      const { manifest, plannedId } = await erasedFixture({
        supersede: true,
        checkpoint: BEFORE_ERASURE(),
      });
      await expect(
        applyHistoryReflectionManifest(manifest, { allowBaselineRebase: true }),
      ).rejects.toThrow(ERASURE_ERROR);
      expect(await getMemory(plannedId)).toBeFalsy();
    });

    test('refuses without baseline rebase and for legacy manifests without a checkpoint', async () => {
      // manifestFor stamps created_at/cutoff_at in 2025 and no checkpoint, so
      // the legacy min(cutoff_at, created_at) fallback applies.
      const { manifest, plannedId } = await erasedFixture({});
      expect(manifest.privacy_checkpoint_at).toBeUndefined();
      await expect(applyHistoryReflectionManifest(manifest)).rejects.toThrow();
      await expect(
        applyHistoryReflectionManifest(manifest, { allowBaselineRebase: true }),
      ).rejects.toThrow(ERASURE_ERROR);
      expect(await getMemory(plannedId)).toBeFalsy();
    });

    test('does not block on an erasure before the checkpoint or in another project', async () => {
      const item = candidate('erasure-unrelated', '2024-01-01T00:00:00.000Z');
      const manifest = await manifestFor(item, [], {
        memory_ops: [
          {
            op: 'create',
            candidate_ids: [item.id],
            new_memory_id: item.planned_memory_id,
            memory_type: item.memory_type,
            content: item.claim,
            valid_from: item.effective_at,
            importance: item.importance,
            tags: item.tags,
          },
        ],
        skipped_candidates: [],
      });
      await recordPrivacyErasure(PROJECT);
      await recordPrivacyErasure(TARGET_PROJECT);
      manifest.privacy_checkpoint_at = new Date(
        Date.now() + 60_000,
      ).toISOString();
      await insertMemory({
        group_folder: PROJECT,
        objective_id: null,
        content: 'An unrelated memory written during human review',
        memory_type: 'project',
        source: 'agent',
      });
      const result = await applyHistoryReflectionManifest(manifest, {
        allowBaselineRebase: true,
      });
      expect(result.applied.created).toBe(1);

      const other = candidate(
        'erasure-other-project',
        '2024-01-01T00:00:00.000Z',
      );
      const operation = {
        op: 'create' as const,
        candidate_ids: [other.id],
        new_memory_id: other.planned_memory_id,
        memory_type: other.memory_type,
        content: other.claim,
        valid_from: other.effective_at,
        importance: other.importance,
        tags: other.tags,
      };
      // A target erasure at or after the checkpoint refuses; one before does not.
      await expect(
        applyRelocatedHistoryCreate(
          TARGET_PROJECT,
          operation,
          [other],
          '2000-01-01T00:00:00.000Z',
        ),
      ).rejects.toThrow(ERASURE_ERROR);
      expect(await getMemory(other.planned_memory_id)).toBeFalsy();
      await expect(
        applyRelocatedHistoryCreate(
          TARGET_PROJECT,
          operation,
          [other],
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ).resolves.toMatchObject({ applied: { created: 1 } });
    });
  });

  test('splices a backdated correction into an existing closed interval', async () => {
    const old = await insertMemory({
      id: 'memory-old',
      group_folder: PROJECT,
      objective_id: null,
      content: 'Use SQLite',
      memory_type: 'decision',
      importance: 0.8,
      source: 'agent',
      valid_from: '2024-01-01T00:00:00.000Z',
    });
    const current = await insertMemory({
      id: 'memory-new',
      group_folder: PROJECT,
      objective_id: null,
      content: 'Use CockroachDB',
      memory_type: 'decision',
      importance: 0.8,
      source: 'agent',
      valid_from: '2024-06-01T00:00:00.000Z',
    });
    const { supersedeMemory, getMemoryTimeline } = await import('../../db.js');
    await supersedeMemory(old.id, current.id, current.valid_from!);
    const baseline = await getMemoryTimeline(PROJECT);
    const item = candidate(
      'middle',
      '2024-04-01T00:00:00.000Z',
      'Use Postgres',
    );
    const manifest = await manifestFor(item, baseline, {
      memory_ops: [
        {
          op: 'supersede',
          candidate_ids: [item.id],
          new_memory_id: item.planned_memory_id,
          supersedes_id: old.id,
          memory_type: 'decision',
          correction_content: item.claim,
          valid_from: item.effective_at,
          importance: 0.8,
          tags: ['data'],
        },
      ],
      skipped_candidates: [],
    });

    await applyHistoryReflectionManifest(manifest);
    expect(await getMemory(old.id)).toMatchObject({
      valid_to: item.effective_at,
      superseded_by: item.planned_memory_id,
    });
    expect(await getMemory(item.planned_memory_id)).toMatchObject({
      valid_from: item.effective_at,
      valid_to: current.valid_from,
      superseded_by: current.id,
      sourceRef: 'conversation:conversation-middle#message-middle',
    });
    expect(await getMemory(current.id)).toMatchObject({
      valid_to: null,
      superseded_by: null,
    });
    expect(
      await drizzleDbRef.current
        .select()
        .from(memoryTranscriptEvidence)
        .where(eq(memoryTranscriptEvidence.memoryId, item.planned_memory_id)),
    ).toMatchObject([
      {
        messageId: 'message-middle',
        messageCreatedAt: item.effective_at,
        excerpt: item.claim,
      },
    ]);
  });

  test('persists reviewed invalidation evidence on the affected memory', async () => {
    const target = await insertMemory({
      id: 'memory-invalidated-from-history',
      group_folder: PROJECT,
      objective_id: null,
      content: 'Deployments require a weekly freeze',
      memory_type: 'decision',
      importance: 0.8,
      source: 'agent',
      valid_from: '2024-01-01T00:00:00.000Z',
    });
    const item = candidate(
      'invalidate-reviewed',
      '2024-04-01T00:00:00.000Z',
      'The weekly deployment freeze ended',
    );
    const manifest = await manifestFor(item, [target], {
      memory_ops: [
        {
          op: 'invalidate',
          candidate_ids: [item.id],
          memory_id: target.id,
          effective_at: item.effective_at,
          reason: item.claim,
        },
      ],
      skipped_candidates: [],
    });

    await applyHistoryReflectionManifest(manifest);

    expect(await getMemory(target.id)).toMatchObject({
      valid_to: item.effective_at,
    });
    expect(
      await drizzleDbRef.current
        .select()
        .from(memoryTranscriptEvidence)
        .where(eq(memoryTranscriptEvidence.memoryId, target.id)),
    ).toMatchObject([
      {
        messageId: 'message-invalidate-reviewed',
        messageCreatedAt: item.effective_at,
        excerpt: item.claim,
      },
    ]);
  });

  test('routes explicit historical forget operations through privacy erasure', async () => {
    const forgotten = await insertMemory({
      id: 'memory-forgotten',
      group_folder: PROJECT,
      objective_id: null,
      content: 'Old private deployment token',
      memory_type: 'project',
      importance: 0.8,
      source: 'agent',
      valid_from: '2024-01-01T00:00:00.000Z',
    });
    const baseline = [forgotten];
    const item = {
      ...candidate(
        'forget',
        '2024-02-01T00:00:00.000Z',
        'Forget the old deployment token',
      ),
      change_kind: 'forget' as const,
    };
    const manifest = await manifestFor(item, baseline, {
      memory_ops: [
        {
          op: 'forget',
          candidate_ids: [item.id],
          memory_id: forgotten.id,
          target: 'old private deployment token',
        },
      ],
      skipped_candidates: [],
    });

    const result = await applyHistoryReflectionManifest(manifest);
    expect(result.applied.forgotten).toBe(1);
    expect(await getMemory(forgotten.id)).toBeUndefined();
  });

  test('applies a date-bounded preview from an older conversation using only in-range messages', async () => {
    const conversationId = 'conversation-long-lived';
    const selectedAt = '2024-06-01T00:00:00.000Z';
    await drizzleDbRef.current.insert(conversations).values({
      id: conversationId,
      group_folder: PROJECT,
      preview: 'Long-lived conversation',
      title: 'History',
      created_at: '2020-01-01T00:00:00.000Z',
      pinned: 0,
      use_worktree: 0,
      brain_managed: 0,
    });
    const transcriptPath = chatTranscriptPath(
      PROJECT,
      undefined,
      conversationId,
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(
      transcriptPath,
      [
        {
          id: 'message-before-range',
          type: 'message',
          role: 'user',
          content: 'This old message is outside the selected range.',
          created_at: '2020-01-02T00:00:00.000Z',
        },
        {
          id: 'message-in-range',
          type: 'message',
          role: 'user',
          content: 'Certificate fixtures must be deterministic.',
          created_at: selectedAt,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );

    const manifest = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        since: '2024-01-01T00:00:00.000Z',
        until: '2024-12-31T23:59:59.999Z',
        cutoffAt: '2025-01-01T00:00:00.000Z',
        includeMemoryFiles: false,
      },
      {
        getTimeline: async () => [],
        getRules: async () => [],
        extractCandidates: async (_prompt, userMessage) => {
          expect(userMessage).toContain('message-in-range');
          expect(userMessage).not.toContain('message-before-range');
          return JSON.stringify({
            candidates: [
              {
                memory_type: 'decision',
                claim: 'Certificate fixtures must be deterministic',
                change_kind: 'assert',
                effective_at: selectedAt,
                confidence: 0.95,
                importance: 0.8,
                tags: ['testing'],
                evidence_message_ids: ['message-in-range'],
              },
            ],
          });
        },
        reflect: async (_prompt, userMessage) => {
          const candidateId = userMessage.match(
            /"id":"(hist-candidate-[^"]+)"/,
          )?.[1];
          return JSON.stringify({
            memory_ops: [
              {
                op: 'create',
                candidate_ids: [candidateId],
                memory_type: 'decision',
                content: 'Certificate fixtures must be deterministic',
                valid_from: selectedAt,
                importance: 0.8,
                tags: ['testing'],
              },
            ],
            skipped_candidates: [],
          });
        },
      },
    );

    expect(manifest.conversations).toHaveLength(1);
    expect(manifest.conversations[0]).toMatchObject({
      conversation_id: conversationId,
      created_at: '2020-01-01T00:00:00.000Z',
      message_count: 1,
    });

    const result = await applyHistoryReflectionManifest(manifest);
    expect(result.applied.created).toBe(1);
  });

  test('applies one tool-preview candidate supported by multiple conversations', async () => {
    const firstConversationId = 'conversation-cross-evidence-first';
    const secondConversationId = 'conversation-cross-evidence-second';
    const firstAt = '2024-05-01T00:00:00.000Z';
    const secondAt = '2024-05-02T00:00:00.000Z';
    const sources = [
      {
        conversationId: firstConversationId,
        messageId: 'message-cross-evidence-first',
        createdAt: firstAt,
        content: 'Production releases use signed manifests.',
      },
      {
        conversationId: secondConversationId,
        messageId: 'message-cross-evidence-second',
        createdAt: secondAt,
        content: 'The signature is verified before promotion.',
      },
    ];
    await drizzleDbRef.current.insert(conversations).values(
      sources.map((source) => ({
        id: source.conversationId,
        group_folder: PROJECT,
        preview: source.content,
        title: 'Release evidence',
        created_at: source.createdAt,
        pinned: 0,
        use_worktree: 0,
        brain_managed: 0,
      })),
    );
    for (const source of sources) {
      const transcriptPath = chatTranscriptPath(
        PROJECT,
        undefined,
        source.conversationId,
      );
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          id: source.messageId,
          type: 'message',
          role: 'user',
          content: source.content,
          created_at: source.createdAt,
        })}\n`,
      );
    }
    const item = candidate(
      'cross-conversation-evidence',
      secondAt,
      'Production release signatures are verified before promotion',
    );
    item.evidence = sources.map((source) => ({
      source_kind: 'conversation',
      conversation_id: source.conversationId,
      message_id: source.messageId,
      role: 'user',
      created_at: source.createdAt,
      date_basis: 'message_timestamp',
      excerpt: source.content,
    }));

    const manifest = await runHistoryReflectionPreview(
      {
        projectId: PROJECT,
        cutoffAt: '2025-01-01T00:00:00.000Z',
        includeMemoryFiles: false,
      },
      {
        getTimeline: async () => [],
        getRules: async () => [],
        previewConversations: async () => ({
          candidates: [item],
          operations: [
            {
              op: 'create',
              candidate_ids: [item.id],
              new_memory_id: item.planned_memory_id,
              memory_type: item.memory_type,
              content: item.claim,
              valid_from: item.effective_at,
              importance: item.importance,
              tags: item.tags,
            },
          ],
        }),
      },
    );

    expect(manifest.errors).toEqual([]);
    expect(manifest.conversations[0]!.candidates).toEqual([item]);
    expect(manifest.conversations[1]!.candidates).toEqual([]);
    const result = await applyHistoryReflectionManifest(manifest);
    expect(result.applied.created).toBe(1);
    expect(await getMemory(item.planned_memory_id)).toMatchObject({
      content: item.claim,
      sourceRef: `conversation:${firstConversationId}#${sources[0]!.messageId}`,
    });
    expect(
      (
        await drizzleDbRef.current
          .select()
          .from(memoryTranscriptEvidence)
          .where(eq(memoryTranscriptEvidence.memoryId, item.planned_memory_id))
      ).map((row) => ({
        sourceRef: row.sourceRef,
        messageId: row.messageId,
        messageCreatedAt: row.messageCreatedAt,
        excerpt: row.excerpt,
      })),
    ).toEqual(
      sources.map((source) => ({
        sourceRef: `conversation:${source.conversationId}`,
        messageId: source.messageId,
        messageCreatedAt: source.createdAt,
        excerpt: source.content,
      })),
    );
  });

  test('rejects a reviewed manifest when its source transcript changed', async () => {
    const item = candidate('changed', '2024-01-01T00:00:00.000Z');
    const manifest = await manifestFor(item, [], {
      memory_ops: [
        {
          op: 'create',
          candidate_ids: [item.id],
          new_memory_id: item.planned_memory_id,
          memory_type: 'decision',
          content: item.claim,
          valid_from: item.effective_at,
          importance: 0.8,
          tags: [],
        },
      ],
      skipped_candidates: [],
    });
    const transcriptPath = chatTranscriptPath(
      PROJECT,
      undefined,
      item.evidence[0]!.conversation_id,
    );
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        id: item.evidence[0]!.message_id,
        type: 'message',
        role: 'user',
        content: 'The source was edited after preview.',
        created_at: item.effective_at,
      })}\n`,
    );

    await expect(applyHistoryReflectionManifest(manifest)).rejects.toThrow(
      /transcript changed/,
    );
  });
});
