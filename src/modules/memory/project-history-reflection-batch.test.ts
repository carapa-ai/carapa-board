import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getGroupDir } from '../../group-dir.js';
import {
  HISTORY_CANDIDATE_PROMPT_VERSION,
  HISTORY_MANIFEST_VERSION,
  HISTORY_REFLECTOR_PROMPT_VERSION,
  type HistoryReflectionManifest,
} from './history-reflector-core.js';
import {
  acquireProjectHistoryBatchLease,
  discoverNativeMemoryProjects,
  discoverProjectHistory,
  historyReviewFingerprint,
  resolveProjectHistoryManifestPath,
} from './project-history-reflection-batch.js';

const PROJECT = 'native-memory-batch-test';
const CONVERSATION_PROJECT = 'conversation-history-batch-test';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeNativeFile(
  origin: string,
  filename: string,
  content: string,
  sourceMtime: string,
): void {
  const directory = path.join(
    getGroupDir(PROJECT),
    '.agent',
    'memories',
    'native',
    origin,
  );
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), content);
  fs.writeFileSync(
    path.join(directory, '.native-memory-import.json'),
    JSON.stringify({
      [filename]: {
        provider: 'claude',
        sourceLabel: origin,
        nativeProject: PROJECT,
        sourcePath: `/native/${filename}`,
        relativePath: filename,
        sourceBirthtime: sourceMtime,
        sourceMtime,
        sha256: sha256(content),
      },
    }),
  );
}

afterEach(() => {
  fs.rmSync(getGroupDir(PROJECT), { recursive: true, force: true });
  fs.rmSync(getGroupDir(CONVERSATION_PROJECT), {
    recursive: true,
    force: true,
  });
});

describe('native memory reflection batch discovery', () => {
  test('groups verified native manifests into one deterministic project source set', async () => {
    writeNativeFile(
      'claude-host',
      'choice.md',
      'Use deterministic fixtures.',
      '2026-01-01T00:00:00.000Z',
    );
    writeNativeFile(
      'codex-host',
      'constraint.md',
      'Physical hardware is required.',
      '2026-01-02T00:00:00.000Z',
    );

    const first = await discoverNativeMemoryProjects([
      {
        folder: PROJECT,
        name: PROJECT,
        trigger: '!',
        added_at: 'now',
      },
    ]);
    const second = await discoverNativeMemoryProjects([
      {
        folder: PROJECT,
        name: PROJECT,
        trigger: '!',
        added_at: 'now',
      },
    ]);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      project_id: PROJECT,
      declared_entries: 2,
      errors: [],
    });
    expect(first[0]!.import_manifests).toHaveLength(2);
    expect(first[0]!.memory_file_paths).toEqual([
      '.agent/memories/native/claude-host/choice.md',
      '.agent/memories/native/codex-host/constraint.md',
    ]);
    expect(first[0]!.source_fingerprint).toBe(second[0]!.source_fingerprint);
  });

  test('rejects changed or escaping files instead of reflecting them', async () => {
    writeNativeFile(
      'claude-host',
      'choice.md',
      'Original durable fact.',
      '2026-01-01T00:00:00.000Z',
    );
    const directory = path.join(
      getGroupDir(PROJECT),
      '.agent',
      'memories',
      'native',
      'claude-host',
    );
    fs.writeFileSync(
      path.join(directory, 'choice.md'),
      'Changed after import.',
    );
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(directory, '.native-memory-import.json'),
        'utf8',
      ),
    );
    manifest.escape = {
      relativePath: '../escape.md',
      sourceMtime: '2026-01-01T00:00:00.000Z',
      sha256: '0'.repeat(64),
    };
    fs.writeFileSync(
      path.join(directory, '.native-memory-import.json'),
      JSON.stringify(manifest),
    );

    const [result] = await discoverNativeMemoryProjects([
      {
        folder: PROJECT,
        name: PROJECT,
        trigger: '!',
        added_at: 'now',
      },
    ]);
    expect(result!.memory_file_paths).toEqual([]);
    expect(result!.errors.join(' ')).toContain('sha256 does not match');
    expect(result!.errors.join(' ')).toContain('unsafe or unsupported');
    expect(result!.errors.join(' ')).toContain('No verified');
  });

  test('combines native memories and conversations into one project inventory', async () => {
    writeNativeFile(
      'claude-host',
      'decision.md',
      'Use deterministic fixtures.',
      '2026-01-01T00:00:00.000Z',
    );
    const groups = [PROJECT, CONVERSATION_PROJECT].map((folder) => ({
      folder,
      name: folder,
      trigger: '!',
      added_at: 'now',
    }));
    const listConversations = async (projectId: string) =>
      projectId === PROJECT
        ? [
            {
              id: 'combined-conversation',
              group_folder: PROJECT,
              preview: 'history',
              title: 'History',
              created_at: '2026-01-02T00:00:00.000Z',
              objective_id: null,
            },
          ]
        : [
            {
              id: 'conversation-only',
              group_folder: CONVERSATION_PROJECT,
              preview: 'history',
              title: 'History',
              created_at: '2026-01-03T00:00:00.000Z',
              objective_id: null,
            },
          ];

    const result = await discoverProjectHistory(
      groups,
      {
        includeConversations: true,
        includeNativeMemories: true,
      },
      listConversations,
    );

    expect(result.map((project) => project.project_id)).toEqual([
      CONVERSATION_PROJECT,
      PROJECT,
    ]);
    expect(
      result.find((project) => project.project_id === PROJECT),
    ).toMatchObject({
      conversation_count: 1,
      memory_file_paths: ['.agent/memories/native/claude-host/decision.md'],
      sources: { conversations: true, native_memories: true },
      errors: [],
    });
    expect(
      result.find((project) => project.project_id === CONVERSATION_PROJECT),
    ).toMatchObject({
      conversation_count: 1,
      memory_file_paths: [],
    });
  });

  test('ignores conversations after the batch cutoff when resuming inventory', async () => {
    const groups = [
      {
        folder: CONVERSATION_PROJECT,
        name: CONVERSATION_PROJECT,
        trigger: '!',
        added_at: 'now',
      },
    ];
    const originalConversation = {
      id: 'before-cutoff',
      group_folder: CONVERSATION_PROJECT,
      preview: 'history',
      title: 'History',
      created_at: '2026-01-01T00:00:00.000Z',
      objective_id: null,
    };
    const afterCutoffConversation = {
      ...originalConversation,
      id: 'after-cutoff',
      created_at: '2026-01-03T00:00:00.000Z',
    };
    const options = {
      includeConversations: true,
      includeNativeMemories: false,
      cutoffAt: '2026-01-02T00:00:00.000Z',
    };

    const original = await discoverProjectHistory(groups, options, async () => [
      originalConversation,
    ]);
    const resumed = await discoverProjectHistory(groups, options, async () => [
      originalConversation,
      afterCutoffConversation,
    ]);

    expect(original[0]!.conversation_count).toBe(1);
    expect(resumed[0]!.conversation_count).toBe(1);
    expect(resumed[0]!.source_fingerprint).toBe(
      original[0]!.source_fingerprint,
    );
  });

  test('uses the chronologically earlier offset bound for discovery', async () => {
    const groups = [
      {
        folder: CONVERSATION_PROJECT,
        name: CONVERSATION_PROJECT,
        trigger: '!',
        added_at: 'now',
      },
    ];

    const result = await discoverProjectHistory(
      groups,
      {
        includeConversations: true,
        includeNativeMemories: false,
        until: '2024-12-31T20:00:00-05:00',
        cutoffAt: '2025-01-01T00:00:00.000Z',
      },
      async () => [
        {
          id: 'after-cutoff',
          group_folder: CONVERSATION_PROJECT,
          preview: 'history',
          title: 'History',
          created_at: '2025-01-01T00:30:00.000Z',
          objective_id: null,
        },
      ],
    );

    expect(result).toEqual([]);
  });

  test('counts only conversations with evidence inside the selected window', async () => {
    const groups = [
      {
        folder: CONVERSATION_PROJECT,
        name: CONVERSATION_PROJECT,
        trigger: '!',
        added_at: 'now',
      },
    ];
    const inRange = {
      id: 'in-range',
      group_folder: CONVERSATION_PROJECT,
      preview: 'in range',
      title: 'In range',
      created_at: '2020-01-01T00:00:00.000Z',
      objective_id: null,
    };
    const outsideRange = {
      ...inRange,
      id: 'outside-range',
      preview: 'outside range',
      title: 'Outside range',
    };

    const result = await discoverProjectHistory(
      groups,
      {
        includeConversations: true,
        includeNativeMemories: false,
        since: '2024-01-01T00:00:00.000Z',
        until: '2024-12-31T23:59:59.999Z',
      },
      async () => [inRange, outsideRange],
      async (_groupFolder, conversation) =>
        conversation.id === inRange.id
          ? [
              {
                id: 'inside-range',
                type: 'message',
                role: 'assistant',
                content: 'Inside the selected period.',
                created_at: '2024-06-01T00:00:00.000Z',
              },
            ]
          : [
              {
                id: 'outside-range',
                type: 'message',
                role: 'assistant',
                content: 'Outside the selected period.',
                created_at: '2023-06-01T00:00:00.000Z',
              },
            ],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      project_id: CONVERSATION_PROJECT,
      conversation_count: 1,
      source_fingerprint: expect.any(String),
    });
  });

  test('fingerprints conversation inventory independently of query order', async () => {
    const groups = [
      {
        folder: CONVERSATION_PROJECT,
        name: CONVERSATION_PROJECT,
        trigger: '!',
        added_at: 'now',
      },
    ];
    const earlier = {
      id: 'conversation-a',
      group_folder: CONVERSATION_PROJECT,
      preview: 'earlier',
      created_at: '2026-01-01T00:00:00.000Z',
      objective_id: null,
    };
    const later = {
      ...earlier,
      id: 'conversation-b',
      preview: 'later',
      created_at: '2026-01-02T00:00:00.000Z',
    };
    const options = {
      includeConversations: true,
      includeNativeMemories: false,
      cutoffAt: '2026-01-03T00:00:00.000Z',
    };

    const forward = await discoverProjectHistory(groups, options, async () => [
      earlier,
      later,
    ]);
    const reverse = await discoverProjectHistory(groups, options, async () => [
      later,
      earlier,
    ]);

    expect(reverse[0]!.source_fingerprint).toBe(forward[0]!.source_fingerprint);
  });

  test('resolves portable and legacy container manifest references', () => {
    const relative =
      'artifacts/history-reflection/project-history-2026-01-01.json';
    const expected = path.join(getGroupDir(PROJECT), ...relative.split('/'));
    expect(
      resolveProjectHistoryManifestPath({
        project_id: PROJECT,
        reflection_manifest: relative,
      }),
    ).toBe(expected);
    expect(
      resolveProjectHistoryManifestPath({
        project_id: PROJECT,
        reflection_manifest: `/app/groups/${PROJECT}/${relative}`,
      }),
    ).toBe(expected);
    expect(() =>
      resolveProjectHistoryManifestPath({
        project_id: PROJECT,
        reflection_manifest: '../../outside.json',
      }),
    ).toThrow('Unsafe');
  });

  test('allows only one active writer for a batch index', () => {
    const batchPath = path.join(
      getGroupDir(PROJECT),
      'artifacts',
      'history-reflection',
      'project-history-batch-lease-test.json',
    );
    const first = acquireProjectHistoryBatchLease(batchPath, {
      heartbeatMs: 60_000,
    });
    expect(() => acquireProjectHistoryBatchLease(batchPath)).toThrow(
      'already active',
    );
    first.release();
    const resumed = acquireProjectHistoryBatchLease(batchPath);
    resumed.release();
  });
});

describe('native memory review fingerprint', () => {
  test('ignores apply bookkeeping but detects reviewed operation changes', () => {
    const preview: HistoryReflectionManifest = {
      manifest_version: HISTORY_MANIFEST_VERSION,
      candidate_prompt_version: HISTORY_CANDIDATE_PROMPT_VERSION,
      reflector_prompt_version: HISTORY_REFLECTOR_PROMPT_VERSION,
      project_id: PROJECT,
      created_at: '2026-01-02T00:00:00.000Z',
      cutoff_at: '2026-01-02T00:00:00.000Z',
      filters: { since: null, until: null },
      sources: {
        conversations: false,
        memory_files: true,
        memory_file_paths: ['.agent/memories/native/fact.md'],
      },
      memory_baseline: 'baseline',
      conversations: [],
      memory_files: [],
      envelope: { memory_ops: [], skipped_candidates: [] },
      errors: [],
      status: 'preview',
    };
    const applied = {
      ...preview,
      status: 'applied' as const,
      applied_at: '2026-01-03T00:00:00.000Z',
    };
    expect(historyReviewFingerprint(applied)).toBe(
      historyReviewFingerprint(preview),
    );

    const changed = {
      ...preview,
      envelope: {
        memory_ops: [],
        skipped_candidates: [
          { candidate_ids: ['candidate'], reason: 'duplicate' },
        ],
      },
    };
    expect(historyReviewFingerprint(changed)).not.toBe(
      historyReviewFingerprint(preview),
    );
  });
});
