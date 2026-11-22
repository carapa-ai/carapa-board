import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { initDatabase } from '../../db.js';
import { getGroupDir } from '../../group-dir.js';
import {
  applyNativeConversationBatch,
  applyNativeConversationImport,
  nativeImportTranscriptPath,
} from './native-import-apply.js';
import { nativeSessionToCarapaRunV1 } from './native-run-v1.js';
import {
  nativeV1ExternalRunRows,
  projectNativeV1TranscriptEntries,
} from './native-v1-import.js';

const projectId = 'native-import-apply-test';

function fixture(sessionId: string) {
  const conversationId = `conv-gemini-${sessionId}`;
  const v1Runs = nativeSessionToCarapaRunV1({
    sessionId,
    source: 'gemini-native',
    createdAt: '2026-09-01T10:00:00Z',
    messages: [
      {
        id: 'u1',
        type: 'message',
        role: 'user',
        content: 'Question',
        created_at: '2026-09-01T10:00:00Z',
      },
      {
        id: 'a1',
        type: 'message',
        role: 'assistant',
        content: 'Answer',
        created_at: '2026-09-01T10:00:01Z',
        external_turn_id: 'turn-1',
      },
    ],
    turns: [],
  });
  return {
    projectId,
    conversationId,
    v1Runs,
    transcriptEntries: projectNativeV1TranscriptEntries(v1Runs, conversationId),
    runRows: nativeV1ExternalRunRows(v1Runs, projectId, conversationId),
    conversation: {
      id: conversationId,
      group_folder: projectId,
      preview: 'Question',
      title: 'Question',
      created_at: '2026-09-01T10:00:00Z',
    },
  };
}

beforeAll(async () => {
  await initDatabase(':memory:');
});

afterAll(async () => {
  await fs.rm(getGroupDir(projectId), { recursive: true, force: true });
});

describe('applyNativeConversationImport', () => {
  test('leaves a pre-existing transcript untouched and reports it as orphan', async () => {
    const input = fixture('orphan');
    const transcriptPath = nativeImportTranscriptPath(
      projectId,
      null,
      input.conversationId,
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, '{"id":"keep"}\n');
    await fs.writeFile(`${transcriptPath}.transcript-index.json`, 'index');
    let inserts = 0;
    const result = await applyNativeConversationImport({
      ...input,
      insertConversation: async () => {
        inserts++;
        return true;
      },
    });
    expect(result).toEqual({ status: 'orphanTranscript', transcriptPath });
    expect(inserts).toBe(0);
    expect(await fs.readFile(transcriptPath, 'utf8')).toBe('{"id":"keep"}\n');
    expect(
      await fs.readFile(`${transcriptPath}.transcript-index.json`, 'utf8'),
    ).toBe('index');
  });

  test('a failure after the transcript is written removes only this run’s files', async () => {
    const bystander = fixture('bystander');
    const bystanderPath = nativeImportTranscriptPath(
      projectId,
      null,
      bystander.conversationId,
    );
    await fs.mkdir(path.dirname(bystanderPath), { recursive: true });
    await fs.writeFile(bystanderPath, 'unrelated\n');

    const input = fixture('failing');
    const transcriptPath = nativeImportTranscriptPath(
      projectId,
      null,
      input.conversationId,
    );
    await expect(
      applyNativeConversationImport({
        ...input,
        insertConversation: async () => {
          expect(await fs.stat(transcriptPath)).toBeTruthy();
          expect(
            await fs.stat(`${transcriptPath}.transcript-index.json`),
          ).toBeTruthy();
          throw new Error('insert failed');
        },
      }),
    ).rejects.toThrow('insert failed');
    expect(await fs.stat(transcriptPath).catch(() => null)).toBeNull();
    expect(
      await fs
        .stat(`${transcriptPath}.transcript-index.json`)
        .catch(() => null),
    ).toBeNull();
    const v1Dir = path.join(getGroupDir(projectId), 'session-transcripts');
    expect(await fs.readdir(v1Dir)).toEqual([]);
    expect(await fs.readFile(bystanderPath, 'utf8')).toBe('unrelated\n');
  });

  test('a failing session does not stop later sessions in the batch', async () => {
    const first = fixture('batch-first');
    const failing = fixture('batch-failing');
    const last = fixture('batch-last');
    const ok = async () => true;
    const results = await applyNativeConversationBatch([
      { ...first, insertConversation: ok },
      {
        ...failing,
        insertConversation: async () => {
          throw new Error('insert failed');
        },
      },
      { ...last, insertConversation: ok },
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'imported',
      'failed',
      'imported',
    ]);
    const exists = async (input: ReturnType<typeof fixture>) =>
      (await fs
        .stat(nativeImportTranscriptPath(projectId, null, input.conversationId))
        .catch(() => null)) !== null;
    expect(await exists(first)).toBe(true);
    expect(await exists(failing)).toBe(false);
    expect(await exists(last)).toBe(true);
  });
});
