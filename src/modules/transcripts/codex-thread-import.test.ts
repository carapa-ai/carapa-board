import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { GROUPS_DIR } from '../../config.js';
import * as db from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { conversations, externalRunCosts, projects } from '../../db/schema.js';
import { chatTranscriptPath } from '../../group-dir.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  archivedCarapaRunV1Paths,
  readCarapaRunV1Pair,
} from './carapa-run-v1.js';
import {
  codexImportHomes,
  importCodexThread,
  loadCodexThread,
  parseCodexThreadDeepLink,
} from './codex-thread-import.js';
import { deterministicCodexConversationId } from './codex-session-import.js';
import * as nativeV1Import from './native-v1-import.js';
import * as transcriptAppend from './transcript-append-service.js';

let codexHome = '';
const threadId = '01a05dc5-1614-7d73-9052-92069de3177f';
const projectId = 'codex-v1-deeplink-import-test';

beforeAll(async () => {
  await db.initDatabase(':memory:');
  codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'carapa-codex-import-'));
  const sessions = path.join(codexHome, 'sessions', '2026', '09', '01');
  await fs.mkdir(sessions, { recursive: true });
  const rows = [
    {
      timestamp: '2026-09-01T10:00:00Z',
      type: 'session_meta',
      payload: { id: threadId, cwd: '/repos/app', source: 'vscode' },
    },
    {
      timestamp: '2026-09-01T10:00:00Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    },
    {
      timestamp: '2026-09-01T10:00:00Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', model: 'gpt-5.6-test' },
    },
    {
      timestamp: '2026-09-01T10:00:01Z',
      type: 'response_item',
      payload: {
        id: 'user-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Import this thread' }],
      },
    },
    {
      timestamp: '2026-09-01T10:00:02Z',
      type: 'response_item',
      payload: {
        id: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Imported' }],
      },
    },
    {
      timestamp: '2026-09-01T10:00:02Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            reasoning_output_tokens: 2,
            total_tokens: 110,
          },
          last_token_usage: { total_tokens: 110 },
          model_context_window: 200_000,
        },
      },
    },
    {
      timestamp: '2026-09-01T10:00:03Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        completed_at: '2026-09-01T10:00:03Z',
        duration_ms: 3_000,
      },
    },
  ];
  await fs.writeFile(
    path.join(sessions, `rollout-2026-09-01T10-00-00-${threadId}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
});

beforeEach(() => truncateTestDb());

afterEach(async () => {
  await fs.rm(path.join(codexHome, 'session_index.jsonl'), { force: true });
  await fs.rm(path.join(GROUPS_DIR, projectId), {
    recursive: true,
    force: true,
  });
});

afterAll(async () => {
  if (codexHome) await fs.rm(codexHome, { recursive: true, force: true });
});

describe('Codex thread link import', () => {
  test('resolves an exact deep link to its nested Codex session', async () => {
    expect(parseCodexThreadDeepLink(` codex://threads/${threadId} `)).toBe(
      threadId,
    );
    const session = await loadCodexThread(threadId, codexHome);
    expect(session).toMatchObject({
      sessionId: threadId,
      firstUserText: 'Import this thread',
      lastAssistantAt: '2026-09-01T10:00:02Z',
    });
  });

  test('rejects prose and reports a missing local session', async () => {
    expect(
      parseCodexThreadDeepLink(
        'open codex://threads/01a05dc5-1614-7d73-9052-92069de3177f',
      ),
    ).toBeNull();
    await expect(
      loadCodexThread('00000000-0000-0000-0000-000000000000', codexHome),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
  });

  test('recovers a truncated item-completion event without dropping conversation records', async () => {
    const damagedHome = path.join(codexHome, 'damaged');
    const sessionDir = path.join(damagedHome, 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    const fileName = `rollout-2026-09-01T10-00-00-${threadId}.jsonl`;
    const original = await fs.readFile(
      path.join(codexHome, 'sessions', '2026', '09', '01', fileName),
      'utf8',
    );
    const lines = original.trimEnd().split('\n');
    // A native item_completed record can be cut off inside command_actions.
    lines.splice(
      4,
      0,
      '{"timestamp":"2026-09-01T10:00:01Z","ordinal":4,"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command_actions":[{"type":"search",',
    );
    const file = path.join(sessionDir, fileName);
    await fs.writeFile(file, lines.join('\n'));
    const originalSession = await loadCodexThread(threadId, codexHome);
    expect(await loadCodexThread(threadId, damagedHome)).toEqual(
      originalSession,
    );

    // A broken message must still fail rather than silently import incomplete history.
    lines[4] =
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[';
    await fs.writeFile(file, lines.join('\n'));
    await expect(loadCodexThread(threadId, damagedHome)).rejects.toMatchObject({
      status: 400,
      message: 'The Codex thread contains invalid JSONL at line 5',
    });
  });

  test('finds agent and project history when the explicit import home is empty', async () => {
    const emptyHome = path.join(codexHome, 'empty');
    const agentHome = path.join(codexHome, 'agent');
    const projectHome = path.join(
      codexHome,
      'ipc',
      'custom-shared',
      'codex-home',
    );
    await fs.mkdir(path.join(agentHome, '.codex'), { recursive: true });
    await fs.cp(
      path.join(codexHome, 'sessions'),
      path.join(agentHome, '.codex', 'sessions'),
      { recursive: true },
    );
    const env = { CODEX_IMPORT_HOME: emptyHome, AGENT_HOME: agentHome };
    expect(
      (await loadCodexThread(threadId, codexImportHomes(projectHome, env)))
        .sessionId,
    ).toBe(threadId);

    await fs.mkdir(projectHome, { recursive: true });
    await fs.rename(
      path.join(agentHome, '.codex', 'sessions'),
      path.join(projectHome, 'sessions'),
    );
    expect(
      (await loadCodexThread(threadId, codexImportHomes(projectHome, env)))
        .sessionId,
    ).toBe(threadId);
    expect(
      (
        await loadCodexThread(
          threadId,
          codexImportHomes(undefined, { ...env, CODEX_HOME: projectHome }),
        )
      ).sessionId,
    ).toBe(threadId);
    expect(
      (
        await loadCodexThread(
          threadId,
          codexImportHomes(undefined, {
            ...env,
            CODEX_IMPORT_AGENT_HOME: projectHome,
          }),
        )
      ).sessionId,
    ).toBe(threadId);
    await expect(
      loadCodexThread(
        '00000000-0000-0000-0000-000000000000',
        codexImportHomes(projectHome, env),
      ),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining(path.join(projectHome, 'sessions')),
    });
  });

  test.each([false, true])(
    'stores durable history with native name available: %s',
    async (withNativeName) => {
      if (withNativeName) {
        await fs.writeFile(
          path.join(codexHome, 'session_index.jsonl'),
          [
            JSON.stringify({ id: threadId, thread_name: 'Original name' }),
            'invalid index entry',
            JSON.stringify({
              id: threadId,
              thread_name: ' Native conversation name ',
            }),
            JSON.stringify({
              id: 'another-thread',
              thread_name: 'Unrelated name',
            }),
            JSON.stringify({ id: threadId, thread_name: ' ' }),
          ].join('\n'),
        );
      }
      const owner = await db.createUser('codex-import-owner', 'pw', 'admin');
      await drizzleDbRef.current.insert(projects).values({
        id: projectId,
        jid: `${projectId}@board`,
        name: projectId,
        folder: projectId,
        trigger: '!',
        added_at: new Date().toISOString(),
        user_id: owner.id,
      });

      const imported = await importCodexThread({
        threadLink: `codex://threads/${threadId}`,
        projectId,
        ownerUserId: owner.id,
        codexHome,
      });
      expect(imported.imported).toBe(true);
      expect(imported.conversation.title).toBe(
        withNativeName ? 'Native conversation name' : 'Import this thread',
      );
      expect(imported.conversation.preview).toBe('Import this thread');

      const runId = `external-codex-vscode-${threadId}-turn-1`;
      const pair = archivedCarapaRunV1Paths(
        path.join(GROUPS_DIR, projectId, 'session-transcripts'),
        runId,
      );
      const document = readCarapaRunV1Pair(pair, {
        expectedHarness: 'codex-vscode',
        requireTerminal: true,
      });
      expect(document?.manifest).toEqual({
        format: 'carapa-run',
        version: 1,
        harness: 'codex-vscode',
        requestedModel: 'gpt-5.6-test',
      });
      expect(document?.events).toContainEqual({
        type: 'usage',
        scope: 'incremental',
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 20,
        reasoningOutputTokens: 2,
      });

      const transcript = (
        await fs.readFile(
          chatTranscriptPath(projectId, undefined, imported.conversation.id),
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        transcript.map((entry) => [entry.type, entry.role, entry.content]),
      ).toEqual([
        ['message', 'user', 'Import this thread'],
        ['message', 'assistant', 'Imported'],
      ]);
      expect(transcript.map((entry) => entry.id)).toEqual([
        expect.stringMatching(/^imp-[0-9a-f]{24}$/),
        expect.stringMatching(/^imp-[0-9a-f]{24}$/),
      ]);
      expect(new Set(transcript.map((entry) => entry.id)).size).toBe(2);
      expect(transcript.some((entry) => entry.type === 'telemetry')).toBe(
        false,
      );

      const [cost] = await drizzleDbRef.current.select().from(externalRunCosts);
      expect(cost).toMatchObject({
        id: runId,
        source: 'codex-vscode',
        external_session_id: threadId,
        external_turn_id: 'turn-1',
        tok_input: 100,
        tok_output: 10,
        tok_cache_read: 20,
        tok_reasoning: 2,
        model_name: 'gpt-5.6-test',
      });

      const existing = await importCodexThread({
        threadLink: `codex://threads/${threadId}`,
        projectId,
        ownerUserId: owner.id,
        codexHome,
      });
      expect(existing.imported).toBe(false);
    },
  );

  test('keeps the concurrent winner transcript when the append guard finds an existing file', async () => {
    const owner = await db.createUser('codex-import-race-owner', 'pw', 'admin');
    await drizzleDbRef.current.insert(projects).values({
      id: projectId,
      jid: `${projectId}@board`,
      name: projectId,
      folder: projectId,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: owner.id,
    });

    const transcriptPath = chatTranscriptPath(
      projectId,
      undefined,
      deterministicCodexConversationId(threadId),
    );
    const winnerContent = `${JSON.stringify({
      type: 'message',
      role: 'user',
      content: 'Import this thread',
    })}\n`;

    // The transcript precheck already passed when the native V1 pair is
    // installed, so the winner's file appears exactly in the window the
    // append guard has to detect.
    const realInstall = nativeV1Import.installNativeV1Pair;
    const installSpy = spyOn(nativeV1Import, 'installNativeV1Pair');
    installSpy.mockImplementation(async (...args) => {
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, winnerContent);
      return realInstall(...args);
    });
    try {
      await expect(
        importCodexThread({
          threadLink: `codex://threads/${threadId}`,
          projectId,
          ownerUserId: owner.id,
          codexHome,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: 'A transcript already exists for this Codex thread',
      });
    } finally {
      installSpy.mockRestore();
    }

    // The losing request must not delete the transcript it did not write.
    expect(await fs.readFile(transcriptPath, 'utf8')).toBe(winnerContent);
    const stored = await drizzleDbRef.current
      .select()
      .from(conversations)
      .where(eq(conversations.id, deterministicCodexConversationId(threadId)));
    expect(stored).toHaveLength(0);
  });

  test('deletes its own transcript when the conversation insert fails', async () => {
    const owner = await db.createUser(
      'codex-import-insert-failure-owner',
      'pw',
      'admin',
    );
    await drizzleDbRef.current.insert(projects).values({
      id: projectId,
      jid: `${projectId}@board`,
      name: projectId,
      folder: projectId,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: owner.id,
    });

    const transcriptPath = chatTranscriptPath(
      projectId,
      undefined,
      deterministicCodexConversationId(threadId),
    );
    const realAppend = transcriptAppend.appendTranscriptLines;
    let appendedLines = 0;
    const appendSpy = spyOn(transcriptAppend, 'appendTranscriptLines');
    appendSpy.mockImplementation(async (...args) => {
      const result = await realAppend(...args);
      appendedLines = result.appendedLines;
      return result;
    });
    const insertSpy = spyOn(db, 'insertImportedConversation');
    insertSpy.mockImplementation(async () => {
      throw new Error('conversation insert failed');
    });
    try {
      await expect(
        importCodexThread({
          threadLink: `codex://threads/${threadId}`,
          projectId,
          ownerUserId: owner.id,
          codexHome,
        }),
      ).rejects.toThrow('conversation insert failed');
    } finally {
      insertSpy.mockRestore();
      appendSpy.mockRestore();
    }

    // This request wrote the transcript, so its own rollback removes it.
    expect(appendedLines).toBeGreaterThan(0);
    expect(existsSync(transcriptPath)).toBe(false);
  });
});
