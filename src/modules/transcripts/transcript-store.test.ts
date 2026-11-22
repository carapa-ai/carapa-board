import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { groupFsTestHooks } from '../../lib/group-fs.js';
import { eraseChatTranscript } from './chat-transcript-erase.js';

import {
  readChatTranscript,
  readChatTranscriptAsync,
  readLiveChatTranscriptAsync,
  appendChatTranscriptEntry,
  appendChatTranscriptEntryAsync,
  chatTranscriptPath,
  datedTranscriptName,
} from '../../group-dir.js';

import {
  appendTaskMessage,
  flushTaskOutputChunks,
  queueTaskOutputChunk,
  readTaskMessages,
  readTaskMessagesPage,
  appendTaskMessageAsync,
  readTaskMessagesAsync,
  readTaskOutputPage,
  deleteTaskTranscript,
  copyTaskMessages,
  formatTranscriptEntries,
  getAgentContextGap,
  getAgentInterleavedContextGap,
  getPersonaHandoffMessages,
  getLlmHistory,
  stripPersonaHandoffToolTrace,
  persistRecordings,
  applySteeringBoundaries,
  archiveOldTranscripts,
  clearTaskOutputRun,
} from './transcript-store.js';
import { formatToolUse } from '../../stream/parsers.js';

function appendChunk(
  projectId: string,
  taskId: string,
  runId: string | null,
  content: string,
  entryId?: string,
  entryComplete?: boolean,
  canonicalEntry?: boolean,
): void {
  queueTaskOutputChunk(
    projectId,
    taskId,
    runId,
    content,
    entryId,
    entryComplete,
    canonicalEntry,
  );
  flushTaskOutputChunks(taskId);
}

describe('Transcript Store (optimized)', () => {
  const testProjectId = 'test-transcript-project-opt';

  beforeAll(() => {
    fs.mkdirSync(path.join(GROUPS_DIR, testProjectId, 'transcripts'), {
      recursive: true,
    });
  });

  afterAll(() => {
    try {
      fs.rmSync(path.join(GROUPS_DIR, testProjectId), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('async task append ignores archives older than a new task', async () => {
    const group_folder = 'test-task-new-append-group';
    const task_id = `task-${Date.now()}-new-append`;
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const memberName = datedTranscriptName(`${task_id}.jsonl`, task_id);
    const livePath = path.join(projectTranscriptsDir, memberName);
    const oldTarPath = path.join(archiveDirPath, '2020-01-01.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(archiveDirPath, { recursive: true });
    fs.writeFileSync(
      livePath,
      JSON.stringify({
        id: 'stale',
        task_id,
        role: 'user',
        content: 'stale archive entry',
      }) + '\n',
    );
    execFileSync(
      'tar',
      ['-czf', oldTarPath, '-C', projectTranscriptsDir, memberName],
      {
        stdio: 'ignore',
      },
    );
    fs.unlinkSync(livePath);

    await appendTaskMessageAsync(group_folder, {
      task_id,
      role: 'user',
      content: 'first new task message',
      created_at: new Date().toISOString(),
    });

    const messages = await readTaskMessagesAsync(group_folder, task_id);
    expect(messages.map((message) => message.content)).toEqual([
      'first new task message',
    ]);

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('bounded task-message pages keep an oversized semantic entry whole', () => {
    const taskId = 'task-1777812859778-complete-bootstrap-entry';
    const toolBlock = `\n\n<details data-tool-call>\n${'tool-output'.repeat(4_000)}\n</details>\n\n`;
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: toolBlock,
      run_id: 'run-complete-bootstrap-entry',
      created_at: new Date().toISOString(),
    });

    const page = readTaskMessagesPage(testProjectId, taskId, 1, 0);
    expect(Buffer.byteLength(toolBlock)).toBeGreaterThan(32 * 1024);
    expect(page.messages[0].content).toBe(toolBlock);
    expect(page.messages[0].contentTruncated).toBeUndefined();
  });
  test('readTaskOutputPage uses a soft target between complete messages', () => {
    const taskId = 'task-1777812859778-output-page';
    const first = 'a'.repeat(1_100_000);
    const second = 'b'.repeat(10);
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: first,
      run_id: 'run-old',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: second,
      run_id: 'run-old',
      created_at: '2026-01-02T00:00:00.000Z',
    });

    const newest = readTaskOutputPage(testProjectId, taskId, 4, 0, 'run-old');
    const older = readTaskOutputPage(
      testProjectId,
      taskId,
      4,
      0,
      'run-old',
      undefined,
      newest.next_cursor,
    );
    expect(newest).toMatchObject({
      total: first.length + second.length,
      run_id: 'run-old',
      content: second,
    });
    expect(newest.entries).toHaveLength(1);
    expect(older.content).toBe(first);
    expect(older.entries).toHaveLength(1);
  });
  test('pages the durable live stream beyond one megabyte by run', () => {
    const taskId = 'task-1777812859778-durable-stream';
    const content = 'z'.repeat(1_100_000);
    appendChunk(testProjectId, taskId, 'run-durable', content);

    const newest = readTaskOutputPage(
      testProjectId,
      taskId,
      32 * 1024,
      0,
      'run-durable',
    );
    const older = readTaskOutputPage(
      testProjectId,
      taskId,
      32 * 1024,
      0,
      'run-durable',
      undefined,
      newest.next_cursor,
    );

    expect(newest.total).toBe(content.length);
    expect(newest.content).toBe(content);
    expect(newest.entries).toHaveLength(1);
    expect(newest.next_cursor).toBe(0);
    expect(older.content).toBe('');
  });
  test('does not discard non-overlapping stream bytes for canonical results', () => {
    const taskId = 'task-1777812859778-canonical-anchor';
    appendChunk(
      testProjectId,
      taskId,
      'run-anchor',
      'tool output that is distinct from the canonical answer',
    );
    const canonical = appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: 'final answer',
      entry_type: 'run_result',
      run_id: 'run-anchor',
      created_at: new Date().toISOString(),
    });

    const page = readTaskOutputPage(
      testProjectId,
      taskId,
      32,
      0,
      'run-anchor',
      canonical.id,
    );
    expect(page.content).toBe('final answer');
    const older = readTaskOutputPage(
      testProjectId,
      taskId,
      32,
      0,
      'run-anchor',
      canonical.id,
      page.next_cursor,
    );
    expect(older.content).toBe(
      'tool output that is distinct from the canonical answer',
    );
  });
  test('does not repeat an answer streamed under a different id than its terminal marker', () => {
    const taskId = 'task-1777812859778-canonical-split-ids';
    const answer = '```json\n{"decision":"approve"}\n```';
    // pi streamed deltas under a provisional id and closed the provider id.
    appendChunk(
      testProjectId,
      taskId,
      'run-split',
      answer,
      'message:pi-message-7',
    );
    appendChunk(
      testProjectId,
      taskId,
      'run-split',
      '',
      'message:resp_1',
      true,
      true,
    );
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: answer,
      entry_type: 'run_result',
      run_id: 'run-split',
      created_at: new Date().toISOString(),
    });

    const page = readTaskOutputPage(
      testProjectId,
      taskId,
      1024,
      0,
      'run-split',
    );
    expect(page.content).toBe(answer);
    expect(page.entries).toHaveLength(1);
  });
  test('does not repeat a canonical result projected by several stream entries', () => {
    const taskId = 'task-1777812859778-canonical-stream-projection';
    appendChunk(
      testProjectId,
      taskId,
      'run-projection',
      'first semantic entry',
      'message:first',
    );
    appendChunk(
      testProjectId,
      taskId,
      'run-projection',
      'second semantic entry',
      'message:second',
    );
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: 'first semantic entrysecond semantic entry',
      entry_type: 'run_result',
      run_id: 'run-projection',
      created_at: new Date().toISOString(),
    });

    const page = readTaskOutputPage(
      testProjectId,
      taskId,
      64,
      0,
      'run-projection',
    );
    expect(page.content).toBe('first semantic entrysecond semantic entry');
    expect(page.entries.map((entry) => entry.id)).toEqual([
      'message:first',
      'message:second',
    ]);
  });
  test('reconciles a V1 terminal message with its generated task-message identity', () => {
    const taskId = 'task-1777812859778-canonical-v1-message';
    appendChunk(
      testProjectId,
      taskId,
      'run-v1-message',
      'tool output: final answer',
      'tool_call:A',
    );
    appendChunk(
      testProjectId,
      taskId,
      'run-v1-message',
      'final answer',
      'message:event-final',
      true,
      true,
    );
    const canonical = appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: 'final answer',
      entry_type: 'run_result',
      run_id: 'run-v1-message',
      created_at: new Date().toISOString(),
    });

    const page = readTaskOutputPage(
      testProjectId,
      taskId,
      64,
      0,
      'run-v1-message',
    );
    expect(page.content).toBe('tool output: final answerfinal answer');
    expect(page.entries.map((entry) => entry.id)).toEqual([
      'tool_call:A',
      `message:${canonical.id}`,
    ]);
    expect(page.entries.at(-1)?.message_id).toBe(canonical.id);
  });
  test('reconciles an extended V1 terminal message by provider provenance', () => {
    const taskId = 'task-1777812859778-extended-v1-message';
    appendChunk(
      testProjectId,
      taskId,
      'run-extended-v1',
      'final ',
      'message:event-extended',
      false,
    );
    appendChunk(
      testProjectId,
      taskId,
      'run-extended-v1',
      'answer',
      'message:event-extended',
      true,
      true,
    );
    const canonical = appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: 'final answer',
      entry_type: 'run_result',
      run_id: 'run-extended-v1',
      created_at: new Date().toISOString(),
    });

    const page = readTaskOutputPage(
      testProjectId,
      taskId,
      64,
      0,
      'run-extended-v1',
    );
    expect(page.content).toBe('final answer');
    expect(page.entries).toEqual([
      expect.objectContaining({
        id: `message:${canonical.id}`,
        message_id: canonical.id,
      }),
    ]);
  });
  test('keeps interleaved tool calls and results in the same semantic page entry', () => {
    const taskId = 'task-1777812859778-interleaved-tool-entries';
    appendChunk(
      testProjectId,
      taskId,
      'run-interleaved',
      'A-start',
      'tool_call:A',
    );
    appendChunk(
      testProjectId,
      taskId,
      'run-interleaved',
      'B-start',
      'tool_call:B',
    );
    appendChunk(
      testProjectId,
      taskId,
      'run-interleaved',
      'A-result',
      'tool_call:A',
    );
    appendChunk(
      testProjectId,
      taskId,
      'run-interleaved',
      'B-result',
      'tool_call:B',
    );

    const newest = readTaskOutputPage(
      testProjectId,
      taskId,
      1,
      0,
      'run-interleaved',
    );
    const older = readTaskOutputPage(
      testProjectId,
      taskId,
      1,
      0,
      'run-interleaved',
      undefined,
      newest.next_cursor,
    );

    expect(newest.entries.map((entry) => entry.id)).toEqual(['tool_call:B']);
    expect(newest.content).toBe('B-startB-result');
    expect(older.entries.map((entry) => entry.id)).toEqual(['tool_call:A']);
    expect(older.content).toBe('A-startA-result');
  });
  test('keeps a distinct canonical answer when legacy tool output ends with the same text', () => {
    const taskId = 'task-1777812859778-canonical-legacy-suffix';
    appendChunk(
      testProjectId,
      taskId,
      'run-legacy-suffix',
      'tool output before ',
    );
    appendChunk(testProjectId, taskId, 'run-legacy-suffix', 'final answer');
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: 'final answer',
      entry_type: 'run_result',
      run_id: 'run-legacy-suffix',
      created_at: new Date().toISOString(),
    });

    const page = readTaskOutputPage(
      testProjectId,
      taskId,
      64,
      0,
      'run-legacy-suffix',
    );
    expect(page.content).toBe('tool output before final answerfinal answer');
    expect(page.entries.map((entry) => entry.id)).toEqual([
      'legacy-stream:run-legacy-suffix',
      expect.stringMatching(/^message:/),
    ]);
  });
  test('deduplicates a canonical stopped-run aggregate only when the legacy stream is exactly equal', () => {
    const taskId = 'task-1777812859778-canonical-legacy-aggregate';
    appendChunk(
      testProjectId,
      taskId,
      'run-legacy-aggregate',
      'partial tool output',
    );
    appendChunk(
      testProjectId,
      taskId,
      'run-legacy-aggregate',
      ' and stopped reply',
    );
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: 'partial tool output and stopped reply',
      entry_type: 'run_result',
      run_id: 'run-legacy-aggregate',
      created_at: new Date().toISOString(),
    });

    const page = readTaskOutputPage(
      testProjectId,
      taskId,
      64,
      0,
      'run-legacy-aggregate',
    );
    expect(page.content).toBe('partial tool output and stopped reply');
    expect(page.entries.map((entry) => entry.id)).toEqual([
      'legacy-stream:run-legacy-aggregate',
    ]);
  });
  test('keeps entry-boundary cursors stable when a later live entry grows', () => {
    const taskId = 'task-1777812859778-cursor-growth';
    appendChunk(
      testProjectId,
      taskId,
      'run-growth',
      'A'.repeat(100),
      'message:first',
    );
    appendChunk(
      testProjectId,
      taskId,
      'run-growth',
      'B'.repeat(100),
      'message:second',
    );
    const first = readTaskOutputPage(
      testProjectId,
      taskId,
      20,
      0,
      'run-growth',
      undefined,
      undefined,
    );
    appendChunk(
      testProjectId,
      taskId,
      'run-growth',
      'C'.repeat(100),
      'message:second',
    );
    const stable = readTaskOutputPage(
      testProjectId,
      taskId,
      20,
      0,
      'run-growth',
      undefined,
      first.next_cursor,
    );

    expect(first.content).toBe('B'.repeat(100));
    expect(stable.content).toBe('A'.repeat(100));
    expect(stable.total).toBe(300);
  });
  test('flushes many buffered live chunks without losing order', () => {
    const taskId = 'task-1777812859778-stream-cadence';
    const chunks = Array.from({ length: 200 }, (_, index) => `${index}|`);
    for (const chunk of chunks)
      queueTaskOutputChunk(testProjectId, taskId, 'run-cadence', chunk);
    flushTaskOutputChunks(taskId);

    const page = readTaskOutputPage(
      testProjectId,
      taskId,
      Buffer.byteLength(chunks.join('')),
      0,
      'run-cadence',
    );
    expect(page.content).toBe(chunks.join(''));
  });
  test('restores archived sidecar before paging instead of switching sources', () => {
    const group_folder = 'test-task-archived-sidecar-group';
    const taskId = 'task-1767225600000-archived-sidecar';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const taskMember = datedTranscriptName(`${taskId}.jsonl`, taskId);
    const streamMember = `${taskId}.stream.jsonl`;
    const taskPath = path.join(projectTranscriptsDir, taskMember);
    const streamPath = path.join(projectTranscriptsDir, streamMember);
    const tarPath = path.join(archiveDirPath, '2026-01-01.tar.gz');
    fs.rmSync(path.join(GROUPS_DIR, group_folder), {
      recursive: true,
      force: true,
    });
    fs.mkdirSync(archiveDirPath, { recursive: true });
    appendTaskMessage(group_folder, {
      task_id: taskId,
      role: 'assistant',
      content: 'canonical answer',
      run_id: 'run-archived',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    appendChunk(group_folder, taskId, 'run-archived', 'durable stream answer');
    execFileSync(
      'tar',
      ['-czf', tarPath, '-C', projectTranscriptsDir, taskMember, streamMember],
      { stdio: 'ignore' },
    );
    fs.unlinkSync(taskPath);
    fs.unlinkSync(streamPath);

    const page = readTaskOutputPage(
      group_folder,
      taskId,
      64,
      0,
      'run-archived',
    );
    expect(page.content).toBe('durable stream answercanonical answer');
    expect(page.total).toBe(page.content.length);
    appendChunk(group_folder, taskId, 'run-rerun', 'new rerun output');
    const rerunPage = readTaskOutputPage(
      group_folder,
      taskId,
      64,
      0,
      'run-rerun',
    );
    const oldPage = readTaskOutputPage(
      group_folder,
      taskId,
      64,
      0,
      'run-archived',
    );
    expect(rerunPage.content).toBe('new rerun output');
    expect(oldPage.content).toBe('durable stream answercanonical answer');
    fs.rmSync(path.join(GROUPS_DIR, group_folder), {
      recursive: true,
      force: true,
    });
  });

  test('deleteTaskTranscript clears the transcript files', async () => {
    const taskId5 = 'task-1777812859778-opt5';
    appendTaskMessage(testProjectId, {
      task_id: taskId5,
      role: 'user',
      content: 'Message delete',
      created_at: new Date().toISOString(),
    });

    expect(readTaskMessages(testProjectId, taskId5)).toHaveLength(1);

    await deleteTaskTranscript(testProjectId, taskId5);
    expect(readTaskMessages(testProjectId, taskId5)).toHaveLength(0);
  });

  test('readTaskMessages preserves file/insertion order when created_at ties', () => {
    // Two messages appended in the same tick (e.g. a `run_start` marker
    // and the assistant message) must keep file order — not the random
    // `id` suffix. `Array.prototype.sort` is stable in V8/JSC, so
    // returning 0 from the comparator preserves the input order. This
    // is the contract the page boundary relies on: the next page's
    // leading messages will not shuffle relative to the previous page
    // when they share a millisecond.
    const taskId = 'task-1777812859778-order3';
    const sameTs = '2026-03-01T00:00:00.000Z';

    const first = appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'system',
      entry_type: 'run_start',
      run_id: 'run-xyz',
      content: '',
      created_at: sameTs,
    });
    const second = appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: 'Hello',
      created_at: sameTs,
    });

    const messages = readTaskMessages(testProjectId, taskId);
    expect(messages).toHaveLength(2);
    // Insertion order wins on equal created_at.
    expect(messages[0].id).toBe(first.id);
    expect(messages[1].id).toBe(second.id);

    // Re-read and assert the order is stable across calls.
    const messages2 = readTaskMessages(testProjectId, taskId);
    expect(messages2.map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  test('readTaskMessagesPage applies chronological sort before paginating', () => {
    const taskId = 'task-1777812859778-order4';
    // Append in scrambled order with three turns (3 user, 3 assistant).
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: 'A2',
      created_at: '2026-04-02T00:00:00.000Z',
    });
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'user',
      content: 'U1',
      created_at: '2026-04-01T00:00:00.000Z',
    });
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'user',
      content: 'U3',
      created_at: '2026-04-03T00:00:00.000Z',
    });
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: 'A3',
      created_at: '2026-04-03T00:00:01.000Z',
    });
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'assistant',
      content: 'A1',
      created_at: '2026-04-01T00:00:01.000Z',
    });
    appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'user',
      content: 'U2',
      created_at: '2026-04-02T00:00:01.000Z',
    });

    // Request the last 1 turn (newest). Should be turn 3: U3 + A3.
    const page = readTaskMessagesPage(testProjectId, taskId, 1, 0);
    expect(page.total).toBe(3);
    expect(page.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(page.messages[0].content).toBe('U3');
    expect(page.messages[1].content).toBe('A3');
  });

  test('copyTaskMessages preserves stage prompt delivery metadata', () => {
    const taskId = 'task-1777812859778-stage-prompt';
    const prompt = appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'system',
      entry_type: 'stage_prompt',
      target_stage: 'in_progress',
      content: 'Fix it',
      created_at: new Date().toISOString(),
    });
    const original = appendTaskMessage(testProjectId, {
      task_id: taskId,
      role: 'system',
      entry_type: 'stage_prompt_delivery',
      target_stage: 'in_progress',
      prompt_id: prompt.id,
      run_id: 'run-1',
      content: '',
      created_at: new Date().toISOString(),
    });

    const [clonedPrompt, clonedReceipt] = copyTaskMessages(
      testProjectId,
      taskId,
      'task-target-stage-prompt',
      original.id,
    );
    expect(clonedReceipt.entry_type).toBe('stage_prompt_delivery');
    expect(clonedReceipt.target_stage).toBe('in_progress');
    expect(clonedReceipt.prompt_id).toBe(clonedPrompt.id);
    expect(clonedReceipt.prompt_id).not.toBe(prompt.id);
    expect(clonedReceipt.run_id).toBe('run-1');
  });

  test('projects trusted historical task events into ordered visible milestones', () => {
    const formatted = formatTranscriptEntries([
      {
        type: 'task_event',
        trusted: true,
        id: 'milestone-1',
        eventId: 'event-1',
        taskId: 'task-a',
        payload: { eventType: 'task_started' },
        created_at: '2026-08-30T10:00:00.000Z',
      },
      {
        type: 'task_event',
        trusted: false,
        id: 'untrusted',
        taskId: 'task-b',
        payload: { eventType: 'failed' },
        created_at: '2026-08-30T10:00:01.000Z',
      },
      {
        type: 'task_event',
        trusted: true,
        id: 'milestone-2',
        eventId: 'event-2',
        taskId: 'task-b',
        payload: { eventType: 'status_changed', status: 'review' },
        created_at: '2026-08-30T10:00:02.000Z',
      },
    ]) as Array<Record<string, unknown>>;
    expect(formatted).toHaveLength(2);
    expect(formatted[0]).toMatchObject({
      type: 'system_milestone',
      id: 'milestone-1',
      taskId: 'task-a',
      content: 'Task task-a: task started',
    });
    expect(formatted[1]).toMatchObject({
      type: 'system_milestone',
      id: 'milestone-2',
      taskId: 'task-b',
      content: 'Task task-b: status changed → review',
    });
  });

  test('keeps persona queue records out of the visible transcript', () => {
    const queuedMessage = {
      type: 'queued_user_message',
      id: 'pending-after-refresh',
      role: 'user',
      content: 'Delete this restored prompt',
      source: 'web',
      created_at: '2026-09-09T04:00:00.000Z',
      conversation_id: 'conversation-1',
    };
    const canonicalMessage = {
      ...queuedMessage,
      type: 'message',
    };
    const projectedPrompt = (entries: unknown[]) =>
      (formatTranscriptEntries(entries) as Array<Record<string, unknown>>).find(
        (entry) => entry.id === queuedMessage.id,
      );

    expect(projectedPrompt([queuedMessage])).toBeUndefined();
    expect(
      projectedPrompt([
        queuedMessage,
        { type: 'queued_user_withdrawn', messageId: queuedMessage.id },
      ]),
    ).toBeUndefined();
    expect(projectedPrompt([queuedMessage, canonicalMessage])).toMatchObject({
      type: 'message',
      id: queuedMessage.id,
    });
  });
  test('orders timestamped milestones consistently around legacy rows', () => {
    const formatted = formatTranscriptEntries([
      {
        id: 'newer-message',
        type: 'message',
        role: 'assistant',
        content: 'Newer response',
        created_at: '2026-08-30T10:00:00.000Z',
      },
      {
        id: 'legacy-row',
        type: 'message',
        role: 'user',
        content: 'Legacy row without timestamp',
      },
      {
        type: 'task_event',
        trusted: true,
        id: 'older-milestone',
        eventId: 'older-event',
        taskId: 'task-a',
        payload: { eventType: 'failed' },
        created_at: '2026-08-30T09:59:00.000Z',
      },
    ]) as Array<Record<string, unknown>>;
    expect(formatted.map((entry) => entry.id)).toEqual([
      'older-milestone',
      'newer-message',
      'legacy-row',
    ]);
  });

  test('formatTranscriptEntries hides conversation cost records from chat bubbles', () => {
    const formatted = formatTranscriptEntries([
      {
        type: 'message',
        role: 'assistant',
        content: 'Visible response',
      },
      {
        type: 'conversation_cost',
        role: 'assistant',
        content: '',
        telemetry: {
          operation: 'conversation_rename',
          cost_usd: 0.001,
        },
      },
    ]) as Array<{ content?: string; telemetry?: Record<string, unknown> }>;

    expect(formatted).toHaveLength(1);
    expect(formatted[0].content).toBe('Visible response');
    expect(formatted[0].telemetry).toBeNull();
  });

  test('formatTranscriptEntries splits an assistant turn at acknowledged steering boundaries', () => {
    expect(
      formatTranscriptEntries([
        {
          type: 'message',
          role: 'user',
          content: 'Original prompt',
          id: 'user-1',
        },
        {
          type: 'message',
          role: 'user',
          content: 'Change direction',
          id: 'steer-1',
        },
        {
          type: 'steering_delivery',
          messageId: 'steer-1',
          delivery: 'steered',
          contentOffset: 6,
        },
        {
          type: 'message',
          role: 'assistant',
          content: 'BeforeAfter',
          id: 'assistant-1',
        },
      ]),
    ).toEqual([
      expect.objectContaining({ role: 'user', content: 'Original prompt' }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Before',
        telemetry: null,
      }),
      expect.objectContaining({
        role: 'user',
        content: 'Change direction',
        steeringDelivery: 'steered',
      }),
      expect.objectContaining({ role: 'assistant', content: 'After' }),
    ]);
  });

  test('assigns the terminal provider identity only to the post-steering replay segment', () => {
    const terminalMessageId = 'msg_terminal';
    const visible = formatTranscriptEntries([
      {
        type: 'message',
        role: 'user',
        content: 'Original prompt',
        id: 'user-1',
      },
      {
        type: 'message',
        role: 'user',
        content: 'Change direction',
        id: 'steer-1',
      },
      {
        type: 'steering_delivery',
        messageId: 'steer-1',
        delivery: 'steered',
        contentOffset: 6,
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'BeforeTail',
        id: 'run-v1-5-msg_first',
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'Final',
        id: `run-v1-9-${terminalMessageId}`,
      },
      {
        id: terminalMessageId,
        type: 'telemetry',
        role: 'assistant',
        telemetry: { tok_output: 2 },
      },
      {
        id: `${terminalMessageId}-outcome`,
        messageId: terminalMessageId,
        type: 'turn_outcome',
        failed: false,
      },
      {
        id: terminalMessageId,
        type: 'ai_user_attribution',
        role: 'assistant',
        content: '',
        agent_name: 'ai-main:angy',
      },
    ]) as Array<Record<string, unknown>>;

    const assistant = visible.filter(
      (entry) => entry.type === 'message' && entry.role === 'assistant',
    );
    expect(assistant).toHaveLength(2);
    expect(assistant[0]).toMatchObject({
      content: 'Before',
      canonicalMessageId: undefined,
    });
    expect(assistant[1]).toMatchObject({
      content: 'TailFinal',
      canonicalMessageId: terminalMessageId,
      telemetry: { tok_output: 2 },
    });
  });

  test('formatTranscriptEntries splits multiple steers across native harness metadata', () => {
    const visible = formatTranscriptEntries([
      {
        type: 'message',
        role: 'user',
        content: 'Original prompt',
        id: 'user-1',
      },
      { type: 'message', role: 'user', content: 'First steer', id: 'steer-1' },
      {
        type: 'steering_delivery',
        messageId: 'steer-1',
        delivery: 'steered',
        contentOffset: 6,
      },
      { type: 'message', role: 'user', content: 'Second steer', id: 'steer-2' },
      {
        type: 'steering_delivery',
        messageId: 'steer-2',
        delivery: 'steered',
        contentOffset: 11,
      },
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'assistant', message: { content: [] } },
      {
        type: 'message',
        role: 'assistant',
        content: 'BeforeMiddleAfter',
        id: 'assistant-1',
      },
    ]).filter((entry: any) => entry.role && entry.content);

    expect(visible).toEqual([
      expect.objectContaining({ role: 'user', content: 'Original prompt' }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Before',
        telemetry: null,
      }),
      expect.objectContaining({
        role: 'user',
        content: 'First steer',
        steeringDelivery: 'steered',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Middl',
        telemetry: null,
      }),
      expect.objectContaining({
        role: 'user',
        content: 'Second steer',
        steeringDelivery: 'steered',
      }),
      expect.objectContaining({ role: 'assistant', content: 'eAfter' }),
    ]);
  });

  test('formatTranscriptEntries splits the persona that accepted steering', () => {
    expect(
      formatTranscriptEntries([
        {
          type: 'message',
          role: 'user',
          content: 'Original prompt',
          id: 'user-1',
        },
        {
          type: 'message',
          role: 'user',
          content: 'Focus on the bug',
          id: 'steer-1',
        },
        {
          type: 'steering_delivery',
          messageId: 'steer-1',
          delivery: 'steered',
          contentOffset: 6,
          targetMessageId: 'persona-1',
        },
        {
          type: 'message',
          role: 'assistant',
          content: 'BeforeAfter',
          id: 'persona-1',
          senderUserId: 'ai:morgan',
        },
      ]),
    ).toEqual([
      expect.objectContaining({ role: 'user', content: 'Original prompt' }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Before',
        senderUserId: 'ai:morgan',
      }),
      expect.objectContaining({
        role: 'user',
        content: 'Focus on the bug',
        steeringDelivery: 'steered',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'After',
        senderUserId: 'ai:morgan',
      }),
    ]);
  });

  test('formatTranscriptEntries drops cursor injected user prompt echoes', () => {
    const entries = [
      {
        type: 'message',
        role: 'user',
        content: 'hello',
        created_at: new Date().toISOString(),
      },
      {
        type: 'user',
        agent_name: 'cursor',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '[AGENT_CONTEXT: group_folder=aaaaa]\n\n> **App preview URL for this run:** http://nginx/\n\nhello',
            },
          ],
        },
      },
      {
        type: 'assistant',
        agent_name: 'cursor',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello!' }],
        },
      },
    ];

    const formatted = formatTranscriptEntries(entries) as Array<{
      type?: string;
      role?: string;
      content?: string;
    }>;
    expect(formatted).toHaveLength(2);
    expect(formatted[0].role).toBe('user');
    expect(formatted[0].content).toBe('hello');
    expect(formatted[1].role).toBe('assistant');
    expect(formatted[1].content).toBe('Hello!');
    expect(
      formatted.some((e) => String(e.content || '').includes('AGENT_CONTEXT')),
    ).toBe(false);
  });

  test('formatTranscriptEntries deduplicates identical consecutive user messages', () => {
    const entries = [
      {
        type: 'message',
        role: 'user',
        content: 'duplicate msg',
        created_at: new Date().toISOString(),
      },
      {
        type: 'message',
        role: 'user',
        content: 'duplicate msg',
        created_at: new Date().toISOString(),
      },
    ];

    const formatted = formatTranscriptEntries(entries);
    expect(formatted).toHaveLength(1);
  });

  test('formatTranscriptEntries uses stable fallback IDs for events without IDs', () => {
    const entries = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first tool result' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'second tool result' }] },
      },
    ];

    const first = formatTranscriptEntries(entries) as Array<{ id: string }>;
    const second = formatTranscriptEntries(entries) as Array<{ id: string }>;

    expect(first.map((entry) => entry.id)).toEqual(
      second.map((entry) => entry.id),
    );
  });

  test('formatTranscriptEntries drops the result echo when assistant text already emitted', () => {
    const entries = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Here is the answer.' }] },
        uuid: 'a1',
      },
      // SDK final result echo repeating the assistant text — must NOT duplicate
      {
        type: 'result',
        subtype: 'success',
        result: 'Here is the answer.',
        uuid: 'r1',
      },
    ];

    const formatted = formatTranscriptEntries(entries) as Array<{
      content?: string;
    }>;
    expect(formatted).toHaveLength(1);
    expect(formatted[0].content).toBe('Here is the answer.');
  });

  test('formatTranscriptEntries keeps result text as a fallback when no assistant text emitted', () => {
    const entries = [
      {
        type: 'result',
        subtype: 'success',
        result: 'Only output is the result.',
        uuid: 'r1',
      },
    ];

    const formatted = formatTranscriptEntries(entries) as Array<{
      type?: string;
      role?: string;
      content?: string;
    }>;
    expect(formatted).toHaveLength(1);
    expect(formatted[0].type).toBe('message');
    expect(formatted[0].role).toBe('assistant');
    expect(formatted[0].content).toBe('Only output is the result.');
  });

  test('formatTranscriptEntries merges Codex turn.completed tokens and companion telemetry meta into the assistant message', () => {
    // Codex emits a turn.completed (real cumulative usage, no meta) plus the
    // board's companion type:"telemetry" line (duration/context/model, possibly
    // a stale chars/3 token estimate). Both must merge onto the preceding
    // assistant message instead of rendering as stray empty bubbles, with the
    // real token counts from turn.completed winning over any estimate.
    const entries = [
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'hello world' },
        uuid: 'a1',
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 14243310,
          cached_input_tokens: 13263872,
          output_tokens: 48554,
          reasoning_output_tokens: 10368,
        },
      },
      {
        type: 'telemetry',
        telemetry: {
          duration_ms: 186300,
          context_size: 256000,
          model_name: 'gpt-5.2-codex',
          usageSource: 'reported',
          rawUsage: {
            input_tokens: 14243310,
            cached_input_tokens: 13263872,
            output_tokens: 48554,
            reasoning_output_tokens: 10368,
          },
          // Stale chars/3 estimate — must NOT overwrite the real tokens above.
          tok_input: 4883,
        },
      },
    ];
    const formatted = formatTranscriptEntries(entries) as Array<{
      type?: string;
      role?: string;
      content?: string;
      telemetry?: Record<string, unknown>;
    }>;
    // Only the assistant message remains — no stray content-less bubbles.
    expect(formatted).toHaveLength(1);
    expect(formatted[0].type).toBe('message');
    expect(formatted[0].role).toBe('assistant');
    expect(formatted[0].content).toContain('hello world');
    const t = formatted[0].telemetry!;
    // Real cumulative tokens from turn.completed win over the estimate.
    expect(t.tok_input).toBe(14243310);
    expect(t.tok_output).toBe(48554);
    expect(t.tok_cache_read).toBe(13263872);
    expect(t.tok_reasoning).toBe(10368);
    // Meta from the companion telemetry line fills in.
    expect(t.duration_ms).toBe(186300);
    expect(t.context_size).toBe(256000);
    expect(t.model_name).toBe('gpt-5.2-codex');
    expect(t.usageSource).toBe('reported');
    expect(t.rawUsage).toEqual({
      input_tokens: 14243310,
      cached_input_tokens: 13263872,
      output_tokens: 48554,
      reasoning_output_tokens: 10368,
    });
  });

  test('formatTranscriptEntries merges companion telemetry then turn.completed regardless of order', () => {
    // Order is not guaranteed: the companion line may land before turn.completed.
    // turn.completed must still overwrite token estimates with real values.
    const entries = [
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'second' },
        uuid: 'a2',
      },
      {
        type: 'telemetry',
        telemetry: {
          duration_ms: 5000,
          model_name: 'codex',
          tok_input: 100, // estimate
          tok_output: 10, // estimate
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 999, output_tokens: 50 },
      },
    ];
    const formatted = formatTranscriptEntries(entries) as Array<{
      telemetry?: Record<string, unknown>;
    }>;
    expect(formatted).toHaveLength(1);
    const t = formatted[0].telemetry!;
    expect(t.tok_input).toBe(999);
    expect(t.tok_output).toBe(50);
    expect(t.duration_ms).toBe(5000);
    expect(t.model_name).toBe('codex');
  });

  test('formatTranscriptEntries prefers consolidated telemetry over interleaved app-server usage snapshots', () => {
    const entries = [
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Starting implementation.\n' },
      },
      {
        type: 'turn.usage',
        usage: {
          input_tokens: 127706,
          cached_input_tokens: 126720,
          output_tokens: 718,
          reasoning_output_tokens: 516,
        },
      },
      {
        type: 'item.completed',
        item: { type: 'command_execution', command: 'bun test', exit_code: 0 },
      },
      {
        type: 'turn.usage',
        usage: {
          input_tokens: 140929,
          cached_input_tokens: 139008,
          output_tokens: 157,
          reasoning_output_tokens: 0,
        },
      },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Done.' },
      },
      {
        type: 'telemetry',
        telemetry: {
          tok_input: 25270,
          tok_output: 4245,
          tok_cache_read: 1721088,
          tok_reasoning: 1486,
          duration_ms: 152229,
          cost_usd: 1.114244,
          usageSource: 'reported',
        },
      },
    ];

    const formatted = formatTranscriptEntries(entries) as Array<{
      type?: string;
      role?: string;
      content?: string;
      telemetry?: Record<string, unknown>;
    }>;

    expect(formatted).toHaveLength(1);
    expect(formatted[0].content).toContain('Starting implementation.');
    expect(formatted[0].content).toContain('Done.');
    expect(formatted[0].telemetry).toMatchObject({
      tok_input: 25270,
      tok_output: 4245,
      tok_cache_read: 1721088,
      tok_reasoning: 1486,
      cost_usd: 1.114244,
      duration_ms: 152229,
    });
  });

  test('formatTranscriptEntries retains the latest app-server usage as an interrupted-run fallback', () => {
    const formatted = formatTranscriptEntries([
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Partial response' },
      },
      {
        type: 'turn.usage',
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      {
        type: 'turn.usage',
        usage: { input_tokens: 140, output_tokens: 20 },
      },
    ]) as Array<{ telemetry?: Record<string, unknown> }>;

    expect(formatted).toHaveLength(1);
    expect(formatted[0].telemetry).toMatchObject({
      tok_input: 140,
      tok_output: 20,
    });
  });

  test('persona replay drops legacy runtime prompts and keeps persona replies', () => {
    const formatted = formatTranscriptEntries([
      {
        id: 'human',
        type: 'message',
        role: 'user',
        content: 'Please discuss this.',
      },
      {
        type: 'message',
        role: 'user',
        content: 'Internal persona prompt',
        agent_name: 'ai:luna',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Internal CLI persona prompt' }],
        },
        agent_name: 'ai-main:maya',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Legacy persisted reply' }],
        },
        agent_name: 'ai:luna',
      },
      {
        type: 'ai_user_attribution',
        role: 'assistant',
        content: '',
        agent_name: 'ai:luna',
      },
      {
        id: 'canonical',
        type: 'message',
        role: 'assistant',
        content: 'Canonical persona reply',
        agent_name: 'ai:luna',
        senderUserId: 'ai:luna',
      },
    ]) as Array<{ role?: string; content?: string }>;

    expect(
      formatted
        .filter((entry) => entry.role === 'user')
        .map((entry) => entry.content),
    ).toEqual(['Please discuss this.']);
    expect(
      formatted
        .filter((entry) => entry.role === 'assistant' && entry.content)
        .map((entry) => entry.content),
    ).toEqual(['Legacy persisted reply', 'Canonical persona reply']);
  });

  test('replays hidden provider context to the LLM without rendering it', async () => {
    const conversationId = 'provider-context-continuity';
    const entries = [
      { type: 'message', role: 'user', content: 'Visible human prompt' },
      {
        type: 'message',
        role: 'developer',
        content: 'Hidden persona identity',
        agent_name: 'ai:luna',
        provider_context: true,
      },
      {
        type: 'message',
        role: 'user',
        content: 'Hidden turn prompt',
        agent_name: 'ai:luna',
        provider_context: true,
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'Visible persona reply',
        sender_name: 'Luna',
        senderUserId: 'ai:luna',
      },
    ];
    for (const entry of entries) {
      appendChatTranscriptEntry(testProjectId, conversationId, entry as any);
    }

    const formatted = formatTranscriptEntries(entries) as Array<{
      content?: string;
    }>;
    expect(formatted.map((entry) => entry.content)).not.toContain(
      'Hidden persona identity',
    );
    expect(formatted.map((entry) => entry.content)).not.toContain(
      'Hidden turn prompt',
    );

    const history = await getLlmHistory(testProjectId, conversationId);
    expect(history.map(({ role, content }) => [role, content])).toEqual([
      ['user', 'Visible human prompt'],
      ['developer', 'Hidden persona identity'],
      ['user', 'Hidden turn prompt'],
      ['assistant', '[Persona Luna]: Visible persona reply'],
    ]);
  });

  test('replays the exact DirectLLM user input in place of its clean visible row', async () => {
    const conversationId = 'direct-provider-input-continuity';
    const decoratedPrompt = [
      'and in js',
      '',
      '[CHANNEL: direct]',
      '[CURRENT HUMAN CONTEXT]',
      'Display name: Alex',
    ].join('\n');
    const entries = [
      {
        id: 'human-turn',
        type: 'message',
        role: 'user',
        content: 'and in js',
      },
      {
        type: 'message',
        role: 'user',
        content: decoratedPrompt,
        agent_name: 'llm:direct:qwen',
        provider_context: true,
        replacesMessageId: 'human-turn',
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'Here is the JavaScript version.',
      },
      {
        id: 'next-human-turn',
        type: 'message',
        role: 'user',
        content: 'done',
      },
    ];
    for (const entry of entries) {
      appendChatTranscriptEntry(testProjectId, conversationId, entry as any);
    }

    const formatted = formatTranscriptEntries(entries) as Array<{
      content?: string;
    }>;
    expect(formatted.map((entry) => entry.content)).toEqual([
      'and in js',
      'Here is the JavaScript version.',
      'done',
    ]);

    const history = await getLlmHistory(testProjectId, conversationId, true);
    expect(history.map(({ role, content }) => [role, content])).toEqual([
      ['user', decoratedPrompt],
      ['assistant', 'Here is the JavaScript version.'],
    ]);
  });

  test('preserves the persona identity that separates a handoff from the default agent', () => {
    const formatted = formatTranscriptEntries([
      {
        id: 'human',
        type: 'message',
        role: 'user',
        content: 'Please discuss this.',
      },
      {
        id: 'main',
        type: 'message',
        role: 'assistant',
        content: 'Default agent response.',
      },
      {
        id: 'main-outcome',
        type: 'turn_outcome',
        role: 'assistant',
        content: '',
      },
      {
        id: 'persona',
        type: 'message',
        role: 'assistant',
        content: 'Invited persona response.',
        sender_name: 'Reviewer',
        senderUserId: 'ai:reviewer',
        emote: 'thoughtful',
        speechText: 'Spoken persona response.',
      },
      {
        id: 'persona-attribution',
        type: 'ai_user_attribution',
        role: 'assistant',
        content: '',
        agent_name: 'ai:reviewer',
        senderUserId: 'ai:reviewer',
      },
    ]) as Array<Record<string, unknown>>;

    const replies = formatted.filter(
      (entry) => entry.type === 'message' && entry.role === 'assistant',
    );
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({
      id: 'main',
      content: 'Default agent response.',
    });
    expect(replies[1]).toMatchObject({
      id: 'persona',
      content: 'Invited persona response.',
      sender_name: 'Reviewer',
      senderUserId: 'ai:reviewer',
      emote: 'thoughtful',
      speechText: 'Spoken persona response.',
    });
  });

  test('restores the canonical main-persona id and identity from legacy attribution bookkeeping', () => {
    const formatted = formatTranscriptEntries([
      {
        type: 'message',
        role: 'assistant',
        content: 'First line.\n\nSecond line.',
        agent_name: 'ai-main:main-persona',
        created_at: '2026-08-20T11:10:17.282Z',
      },
      {
        id: 'chat-1787224217282-tlgv2v',
        type: 'telemetry',
        role: 'assistant',
        telemetry: { tok_output: 4 },
        created_at: '2026-08-20T11:10:17.282Z',
      },
      {
        id: 'chat-1787224217282-tlgv2v-outcome',
        messageId: 'chat-1787224217282-tlgv2v',
        type: 'turn_outcome',
        failed: false,
        created_at: '2026-08-20T11:10:17.282Z',
      },
      {
        type: 'ai_user_attribution',
        role: 'assistant',
        content: '',
        agent_name: 'ai-main:main-persona',
        sender_name: 'Main persona',
        senderUserId: 'ai:main-persona',
        speechText: 'First line. Second line.',
        created_at: '2026-08-20T11:10:17.282Z',
      },
    ]) as Array<Record<string, unknown>>;

    const message = formatted.find(
      (entry) => entry.type === 'message' && entry.role === 'assistant',
    );
    expect(message).toMatchObject({
      id: 'chat-1787224217282-tlgv2v',
      content: 'First line.\n\nSecond line.',
      sender_name: 'Main persona',
      senderUserId: 'ai:main-persona',
      speechText: 'First line. Second line.',
    });
    expect(
      formatted.filter(
        (entry) =>
          entry.type === 'message' &&
          entry.role === 'assistant' &&
          entry.content === 'First line.\n\nSecond line.',
      ),
    ).toHaveLength(1);
  });

  test('keeps Live narration as structured replay entries without merging it into prose', () => {
    const formatted = formatTranscriptEntries([
      { id: 'a', type: 'message', role: 'assistant', content: 'Before' },
      {
        id: 'status',
        type: 'live_status',
        content: 'Checking the next step',
        created_at: '2026-08-02T00:00:00.000Z',
        agent_name: 'ai:reviewer',
        sender_name: 'Reviewer',
        senderUserId: 'ai:reviewer',
      },
      { id: 'b', type: 'message', role: 'assistant', content: 'After' },
    ]) as Array<Record<string, unknown>>;

    expect(formatted).toEqual([
      expect.objectContaining({
        id: 'a',
        type: 'message',
        role: 'assistant',
        content: 'Before',
      }),
      expect.objectContaining({
        id: 'status',
        type: 'live_status',
        role: 'assistant',
        content: 'Checking the next step',
        agent_name: 'ai:reviewer',
        sender_name: 'Reviewer',
        senderUserId: 'ai:reviewer',
      }),
      expect.objectContaining({
        id: 'b',
        type: 'message',
        role: 'assistant',
        content: 'After',
      }),
    ]);
  });

  test('recovers a legacy unattributed Live status from the following persona message', () => {
    const formatted = formatTranscriptEntries([
      {
        id: 'main',
        type: 'message',
        role: 'assistant',
        content: 'Default agent response.',
      },
      {
        id: 'status',
        type: 'live_status',
        content: 'Reviewing the implementation',
      },
      { id: 'usage', type: 'telemetry', role: 'assistant', content: '' },
      {
        id: 'persona',
        type: 'message',
        role: 'assistant',
        content: 'Persona response.',
        sender_name: 'Morgan',
        senderUserId: 'ai:morgan',
      },
    ]) as Array<Record<string, unknown>>;

    expect(
      formatted.find((entry) => entry.type === 'live_status'),
    ).toMatchObject({
      id: 'status',
      sender_name: 'Morgan',
      senderUserId: 'ai:morgan',
    });
  });

  test('reconciles legacy duplicated CLI narration at its archived event position', () => {
    const first = 'Inspecting the failing path';
    const second = 'The targeted repair is ready';
    const formatted = formatTranscriptEntries([
      { id: 'user', type: 'message', role: 'user', content: 'Fix it' },
      { id: 'status-1', type: 'live_status', content: first },
      { id: 'status-2', type: 'live_status', content: second },
      {
        type: 'item.completed',
        item: {
          id: 'msg-1',
          type: 'agent_message',
          text: `[[live: ${first}]]`,
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'rg -n bug src',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'rg -n bug src',
          exit_code: 0,
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'msg-2',
          type: 'agent_message',
          text: `[[live: ${second}]]\n\nFixed.`,
        },
      },
    ]) as Array<{ type?: string; content?: string }>;

    const rendered = formatted.map((entry) => entry.content || '').join('\n');
    expect(rendered.match(new RegExp(first, 'g'))).toHaveLength(1);
    expect(rendered.match(new RegExp(second, 'g'))).toHaveLength(1);
    expect(
      formatted.filter((entry) => entry.type === 'live_status'),
    ).toHaveLength(0);
    expect(rendered.indexOf(first)).toBeLessThan(
      rendered.indexOf('rg -n bug src'),
    );
    expect(rendered.indexOf(second)).toBeGreaterThan(
      rendered.indexOf('rg -n bug src'),
    );
  });

  test('formatTranscriptEntries keeps parallel Cursor calls at start and attaches stuck shell errors', () => {
    const bashCmd =
      'cd /workspace/carapa-board && GIT_PAGER=cat git log --oneline -10 -- ui/src/hooks/use-smart-scroll.ts';
    const entries = [
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'grep-1',
        tool_call: {
          grepToolCall: {
            args: {
              pattern: 'streamKey',
              path: '/workspace/carapa-board/ui/src/components/chat/chat-page.tsx',
            },
          },
        },
      },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'read-1',
        tool_call: {
          readToolCall: {
            args: {
              path: '/workspace/carapa-board/ui/src/hooks/use-smart-scroll.ts',
            },
          },
        },
      },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'bash-1',
        tool_call: { shellToolCall: { args: { command: bashCmd } } },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'grep-1',
        tool_call: {
          grepToolCall: {
            args: {
              pattern: 'streamKey',
              path: '/workspace/carapa-board/ui/src/components/chat/chat-page.tsx',
            },
            result: {
              success: {
                workspaceResults: {
                  '/workspace/carapa-board': {
                    content: {
                      matches: [{ file: 'chat-page.tsx', matches: [{}] }],
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'read-1',
        tool_call: {
          readToolCall: {
            args: {
              path: '/workspace/carapa-board/ui/src/hooks/use-smart-scroll.ts',
            },
            result: { success: { content: 'export function useSmartScroll' } },
          },
        },
      },
      {
        type: 'error',
        message: 'Shell tool did not complete. Stuck on: ' + bashCmd,
      },
    ];

    const formatted = formatTranscriptEntries(entries) as Array<{
      content?: string;
    }>;
    expect(formatted).toHaveLength(1);
    const text = formatted[0].content || '';
    expect(text.indexOf('**Grep**')).toBeLessThan(text.indexOf('**Read**'));
    expect(text.indexOf('**Read**')).toBeLessThan(text.indexOf('**Bash**'));
    expect(text.indexOf('**Bash**')).toBeLessThan(text.indexOf('1 matches'));
    expect(text.indexOf('1 matches')).toBeLessThan(
      text.indexOf('useSmartScroll'),
    );
    expect(text.indexOf('**Bash**')).toBeLessThan(
      text.indexOf('did not complete'),
    );
    expect(text.match(/\*\*Grep\*\*/g)).toHaveLength(1);
    expect(text.match(/\*\*Read\*\*/g)).toHaveLength(1);
    expect(text.match(/\*\*Bash\*\*/g)).toHaveLength(1);
    expect(text).not.toContain('**Error**');
  });

  test('getLlmHistory extracts tool use and tool result correctly without formatTranscriptEntries conversion', async () => {
    const group_folder = 'test-getllmhistory-group';
    const conversation_id = 'test-conv';

    // Clear old files
    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}

    appendChatTranscriptEntry(group_folder, conversation_id, {
      type: 'message',
      role: 'user',
      content: 'search please',
      created_at: new Date().toISOString(),
    });

    appendChatTranscriptEntry(group_folder, conversation_id, {
      type: 'message',
      role: 'assistant',
      content: 'Sure.',
      created_at: new Date().toISOString(),
    });

    appendChatTranscriptEntry(group_folder, conversation_id, {
      type: 'tool_use',
      id: 'tc-1',
      part: {
        type: 'tool',
        tool: 'search_knowledge',
        state: {
          status: 'completed',
          input: { query: 'something' },
          output: 'KB Result Text',
        },
      },
      created_at: new Date().toISOString(),
    });

    const history = await getLlmHistory(group_folder, conversation_id);
    expect(history).toHaveLength(3);

    expect(history[0].role).toBe('user');

    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('Sure.');
    expect(history[1].tool_calls).toBeDefined();
    expect(history[1].tool_calls).toHaveLength(1);
    expect(history[1].tool_calls![0].function.name).toBe('search_knowledge');

    expect(history[2].role).toBe('tool');
    expect(history[2].tool_call_id).toBe('tc-1');
    expect(history[2].content).toBe('KB Result Text');
  });

  test('formatTranscriptEntries drops pi streaming noise on reload (agent_end kept, everything else dropped)', () => {
    // Simulate an OLD pi transcript written before the write-side filter
    // existed — every per-turn event is present, plus the agent_end snapshot.
    const entries = [
      { type: 'system', subtype: 'init', agent_name: 'pi' },
      { type: 'agent_start', agent_name: 'pi' },
      { type: 'turn_start', agent_name: 'pi' },
      { type: 'message_start', agent_name: 'pi' },
      { type: 'message_update', agent_name: 'pi' },
      { type: 'message_end', agent_name: 'pi' },
      { type: 'tool_execution_start', agent_name: 'pi' },
      { type: 'tool_execution_end', agent_name: 'pi' },
      { type: 'turn_end', agent_name: 'pi' },
      {
        type: 'agent_end',
        agent_name: 'pi',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'list logs' }] },
          { role: 'assistant', content: [{ type: 'text', text: '42 files' }] },
        ],
      },
    ];
    const parsed = formatTranscriptEntries(entries as unknown[]);
    // One assistant entry (the agent_end snapshot's assistant text), no
    // message_update / turn_* / tool_execution_* noise rendered.
    const types = parsed.map((e: any) => `${e.type}:${e.role}`);
    expect(types).toEqual(['message:assistant']);
    expect((parsed[0] as any).content).toContain('42 files');
  });

  test('archive sweep keeps the previous bundle and sources when recompression fails', async () => {
    const group_folder = 'test-archive-sweep-atomic-group';
    const convOld = 'conv-1767225600000-sweep-old';
    const convNew = 'conv-1767225600000-sweep-new';
    const transcriptsDir = path.join(GROUPS_DIR, group_folder, 'transcripts');
    const archiveDirPath = path.join(transcriptsDir, 'archive');
    const tarPath = path.join(archiveDirPath, '2026-01-01.tar.gz');
    const oldPath = chatTranscriptPath(group_folder, undefined, convOld);
    const newPath = chatTranscriptPath(group_folder, undefined, convNew);
    const fakeBin = fs.mkdtempSync(path.join(GROUPS_DIR, '.fake-tar-'));
    const realPath = process.env.PATH;
    const mtime = new Date('2026-01-01T12:00:00.000Z');

    fs.rmSync(path.join(GROUPS_DIR, group_folder), {
      recursive: true,
      force: true,
    });
    fs.mkdirSync(archiveDirPath, { recursive: true });
    try {
      for (const [conv, content] of [
        [convOld, 'already archived msg'],
        [convNew, 'newly swept msg'],
      ]) {
        appendChatTranscriptEntry(group_folder, conv, {
          type: 'message',
          role: 'user',
          content,
          created_at: '2026-01-01T10:00:00.000Z',
        });
      }
      // convOld's original is gone: the bundle is its only copy.
      execFileSync(
        'tar',
        ['-czf', tarPath, '-C', transcriptsDir, path.basename(oldPath)],
        { stdio: 'ignore' },
      );
      fs.unlinkSync(oldPath);
      fs.utimesSync(newPath, mtime, mtime);
      const before = fs.readFileSync(tarPath);

      // Fake tar: create mode writes junk to the -f target, then fails.
      const realTar = execFileSync('which', ['tar'], {
        encoding: 'utf-8',
      }).trim();
      const fakeTar = path.join(fakeBin, 'tar');
      fs.writeFileSync(
        fakeTar,
        `#!/bin/sh\nif [ "$1" = "-czf" ]; then printf junk > "$2"; exit 1; fi\nexec ${realTar} "$@"\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${fakeBin}:${realPath}`;
      try {
        await archiveOldTranscripts();
      } finally {
        process.env.PATH = realPath;
      }

      expect(fs.readFileSync(tarPath).equals(before)).toBe(true);
      expect(fs.existsSync(newPath)).toBe(true);
      expect(
        fs.readdirSync(archiveDirPath).filter((f) => f !== '2026-01-01.tar.gz'),
      ).toEqual([]);

      // Normal path: sweep archives the file and both transcripts restore.
      expect(await archiveOldTranscripts()).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(newPath)).toBe(false);
      expect(fs.readdirSync(archiveDirPath)).toEqual(['2026-01-01.tar.gz']);
      const restoredNew = readChatTranscript(group_folder, convNew);
      expect((restoredNew[0] as any).content).toBe('newly swept msg');
      const restoredOld = readChatTranscript(group_folder, convOld);
      expect((restoredOld[0] as any).content).toBe('already archived msg');
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    }
  });

  // Security (D-438): tar must never work inside the agent-writable project
  // folder, and a live file that changes after it was copied must survive.
  test('archive sweep and erase work in board temp space, never under the group', async () => {
    const group_folder = 'test-archive-board-temp-group';
    const convKeep = 'conv-1767225600000-temp-keep';
    const convRace = 'conv-1767225600000-temp-race';
    const groupDir = path.join(GROUPS_DIR, group_folder);
    const archiveDirPath = path.join(groupDir, 'transcripts', 'archive');
    const tarPath = path.join(archiveDirPath, '2026-01-01.tar.gz');
    const keepPath = chatTranscriptPath(group_folder, undefined, convKeep);
    const racePath = chatTranscriptPath(group_folder, undefined, convRace);
    const mtime = new Date('2026-01-01T12:00:00.000Z');
    const boardTemp = path.join(DATA_DIR, 'tmp', 'transcripts');
    const listBundle = () =>
      execFileSync('tar', ['-tzf', tarPath], { encoding: 'utf8' });
    // Extraction/packing scratch dirs used to be created inside archive/.
    const strayTmp = () =>
      fs.readdirSync(archiveDirPath).filter((n) => n.startsWith('.tmp-'));
    const seenStray: string[] = [];
    let swapped = false;

    fs.rmSync(groupDir, { recursive: true, force: true });
    try {
      for (const conv of [convKeep, convRace]) {
        appendChatTranscriptEntry(group_folder, conv, {
          type: 'message',
          role: 'user',
          content: `original ${conv}`,
          created_at: '2026-01-01T10:00:00.000Z',
        });
      }
      // A pre-existing bundle makes the sweep extract before it packs.
      fs.mkdirSync(archiveDirPath, { recursive: true });
      execFileSync(
        'tar',
        [
          '-czf',
          tarPath,
          '-C',
          path.dirname(keepPath),
          path.basename(keepPath),
        ],
        { stdio: 'ignore' },
      );
      fs.utimesSync(keepPath, mtime, mtime);
      fs.utimesSync(racePath, mtime, mtime);

      groupFsTestHooks.beforeOpen = (_label, segment) => {
        seenStray.push(...strayTmp());
        // Once the bundle holds the copy, replace the live file under the sweep.
        if (
          !swapped &&
          segment === path.basename(racePath) &&
          listBundle().includes(path.basename(racePath))
        ) {
          swapped = true;
          fs.rmSync(racePath);
          fs.writeFileSync(racePath, '{"content":"replaced"}\n');
        }
      };
      expect(await archiveOldTranscripts()).toBe(2);
      groupFsTestHooks.beforeOpen = undefined;

      expect(swapped).toBe(true);
      expect(seenStray).toEqual([]);
      expect(strayTmp()).toEqual([]);
      expect(fs.existsSync(boardTemp) ? fs.readdirSync(boardTemp) : []).toEqual(
        [],
      );
      // The replaced file is kept; the unchanged one was archived and removed.
      expect(fs.readFileSync(racePath, 'utf8')).toContain('replaced');
      expect(fs.existsSync(keepPath)).toBe(false);
      expect(listBundle()).toContain(path.basename(keepPath));
      expect(listBundle()).toContain(path.basename(racePath));

      // Erase rebuilds the bundle without extracting anything under the group.
      groupFsTestHooks.beforeOpen = () => {
        seenStray.push(...strayTmp());
      };
      await eraseChatTranscript(group_folder, convKeep);
      groupFsTestHooks.beforeOpen = undefined;
      expect(seenStray).toEqual([]);
      expect(strayTmp()).toEqual([]);
      expect(listBundle()).not.toContain(path.basename(keepPath));
      expect(listBundle()).toContain(path.basename(racePath));
      expect(fs.existsSync(boardTemp) ? fs.readdirSync(boardTemp) : []).toEqual(
        [],
      );
    } finally {
      groupFsTestHooks.beforeOpen = undefined;
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  test('readChatTranscript restores an archived chat transcript round-trip', async () => {
    // Mirror of the task round-trip test, but for chat. After a sweep
    // (archive + delete live file), readChatTranscript must transparently
    // extract the JSONL from the project archive and write it back to the
    // live path so subsequent calls (incl. append) hit the fast path and
    // don't lose history.
    const group_folder = 'test-chat-restore-group';
    const conversation_id = 'conv-1767225600000-restore';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const livePath = chatTranscriptPath(
      group_folder,
      undefined,
      conversation_id,
    );
    const tarPath = path.join(archiveDirPath, '2026-01-01.tar.gz');

    // Clean slate.
    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(archiveDirPath, { recursive: true });

    // Write a live chat transcript, then archive + delete the live file.
    appendChatTranscriptEntry(group_folder, conversation_id, {
      type: 'message',
      role: 'user',
      content: 'archived user msg',
      created_at: '2026-01-01T10:00:00.000Z',
    });
    appendChatTranscriptEntry(group_folder, conversation_id, {
      type: 'message',
      role: 'assistant',
      content: 'archived assistant reply',
      created_at: '2026-01-01T10:00:01.000Z',
    });
    expect(fs.existsSync(livePath)).toBe(true);

    // Move it to the archive as a tar.gz with the legacy undated name.
    const legacyName = path.basename(livePath);
    execFileSync(
      'tar',
      ['-czf', tarPath, '-C', projectTranscriptsDir, legacyName],
      { stdio: 'ignore' },
    );
    fs.unlinkSync(livePath);
    expect(fs.existsSync(livePath)).toBe(false);

    // Sidebar metadata reads must not restore archived transcripts. Doing so
    // for every row in an older page blocks pagination on tar extraction.
    expect(
      await readLiveChatTranscriptAsync(group_folder, conversation_id),
    ).toEqual([]);
    expect(fs.existsSync(livePath)).toBe(false);

    // HTTP/background readers must restore through the yielding path so an
    // archive lookup cannot block unrelated Board requests.
    const asyncEntries = await readChatTranscriptAsync(
      group_folder,
      conversation_id,
    );
    expect(asyncEntries).toHaveLength(2);
    expect((asyncEntries[0] as any).content).toBe('archived user msg');
    fs.unlinkSync(livePath);

    // First read triggers round-trip restore.
    const entries = readChatTranscript(group_folder, conversation_id);
    expect(entries).toHaveLength(2);
    expect((entries[0] as any).content).toBe('archived user msg');
    expect((entries[1] as any).content).toBe('archived assistant reply');

    // The live file should exist on disk now.
    expect(fs.existsSync(livePath)).toBe(true);
    const onDisk = fs.readFileSync(livePath, 'utf-8');
    expect(onDisk).toContain('archived user msg');
    expect(onDisk).toContain('archived assistant reply');

    // A new append lands on the restored history, not a fresh file.
    appendChatTranscriptEntry(group_folder, conversation_id, {
      type: 'message',
      role: 'user',
      content: 'continuation after archive',
      created_at: '2026-07-02T10:00:00.000Z',
    });
    const after = readChatTranscript(group_folder, conversation_id);
    expect(after).toHaveLength(3);
    expect((after[2] as any).content).toBe('continuation after archive');

    // Cleanup.
    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('async append does not scan archives older than a new conversation', async () => {
    const group_folder = 'test-chat-new-append-group';
    const conversation_id = `conv-${Date.now()}-new-append`;
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const livePath = chatTranscriptPath(
      group_folder,
      undefined,
      conversation_id,
    );
    const memberName = path.basename(livePath);
    const oldTarPath = path.join(archiveDirPath, '2020-01-01.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(archiveDirPath, { recursive: true });
    fs.writeFileSync(
      livePath,
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: 'stale archive entry',
      }) + '\n',
    );
    execFileSync(
      'tar',
      ['-czf', oldTarPath, '-C', projectTranscriptsDir, memberName],
      {
        stdio: 'ignore',
      },
    );
    fs.unlinkSync(livePath);

    await appendChatTranscriptEntryAsync(group_folder, conversation_id, {
      type: 'message',
      role: 'user',
      content: 'first new message',
    });

    const entries = readChatTranscript(group_folder, conversation_id) as Array<{
      content?: string;
    }>;
    expect(entries.map((entry) => entry.content)).toEqual([
      'first new message',
    ]);

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('readChatTranscript restores the newest bundle copy, not the creation-date bundle', () => {
    const group_folder = 'test-chat-newest-bundle-group';
    const conversation_id = 'conv-1767225600000-chat-newest';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const livePath = chatTranscriptPath(
      group_folder,
      undefined,
      conversation_id,
    );
    const memberName = path.basename(livePath);
    const staleTarPath = path.join(archiveDirPath, '2026-01-01.tar.gz');
    const newerTarPath = path.join(archiveDirPath, '2026-07-01.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(projectTranscriptsDir, { recursive: true });
    fs.mkdirSync(archiveDirPath, { recursive: true });

    fs.writeFileSync(
      livePath,
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: 'stale creation-date chat copy',
        created_at: '2026-01-01T10:00:00.000Z',
      }) + '\n',
    );
    execFileSync(
      'tar',
      ['-czf', staleTarPath, '-C', projectTranscriptsDir, memberName],
      {
        stdio: 'ignore',
      },
    );

    fs.writeFileSync(
      livePath,
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: 'newest bundle chat copy',
        created_at: '2026-07-01T10:00:00.000Z',
      }) + '\n',
    );
    execFileSync(
      'tar',
      ['-czf', newerTarPath, '-C', projectTranscriptsDir, memberName],
      {
        stdio: 'ignore',
      },
    );
    fs.unlinkSync(livePath);

    const entries = readChatTranscript(group_folder, conversation_id);
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).content).toBe('newest bundle chat copy');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('readChatTranscript falls forward to newer archives but skips older ones', () => {
    const group_folder = 'test-chat-forward-archive-group';
    const conversation_id = 'conv-1782971398064-forward-archive';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const livePath = chatTranscriptPath(
      group_folder,
      undefined,
      conversation_id,
    );
    const memberName = path.basename(livePath);
    const olderTarPath = path.join(archiveDirPath, '2026-06-01.tar.gz');
    const newerTarPath = path.join(archiveDirPath, '2026-07-06.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(projectTranscriptsDir, { recursive: true });
    fs.mkdirSync(archiveDirPath, { recursive: true });

    fs.writeFileSync(
      livePath,
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: 'older archive should be skipped',
        created_at: '2026-06-01T10:00:00.000Z',
      }) + '\n',
    );
    execFileSync(
      'tar',
      ['-czf', olderTarPath, '-C', projectTranscriptsDir, memberName],
      {
        stdio: 'ignore',
      },
    );

    fs.writeFileSync(
      livePath,
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: 'newer archive hit',
        created_at: '2026-07-06T10:00:00.000Z',
      }) + '\n',
    );
    execFileSync(
      'tar',
      ['-czf', newerTarPath, '-C', projectTranscriptsDir, memberName],
      {
        stdio: 'ignore',
      },
    );
    fs.unlinkSync(livePath);

    const entries = readChatTranscript(
      group_folder,
      conversation_id,
      '2026-07-02T00:00:00.000Z',
    );
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).content).toBe('newer archive hit');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('readChatTranscript restores archive members dated by archive day', () => {
    const group_folder = 'test-chat-archive-day-member-group';
    const conversation_id = 'conv-1783009615514-archive-day-member';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const livePath = chatTranscriptPath(
      group_folder,
      undefined,
      conversation_id,
    );
    const archiveDayMemberName = `2026-07-06-chat-${conversation_id}.output.jsonl`;
    const archiveDayMemberPath = path.join(
      projectTranscriptsDir,
      archiveDayMemberName,
    );
    const tarPath = path.join(archiveDirPath, '2026-07-06.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(projectTranscriptsDir, { recursive: true });
    fs.mkdirSync(archiveDirPath, { recursive: true });

    fs.writeFileSync(
      archiveDayMemberPath,
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: 'archive day member hit',
        created_at: '2026-07-06T10:00:00.000Z',
      }) + '\n',
    );
    execFileSync(
      'tar',
      ['-czf', tarPath, '-C', projectTranscriptsDir, archiveDayMemberName],
      {
        stdio: 'ignore',
      },
    );
    fs.unlinkSync(archiveDayMemberPath);

    const entries = readChatTranscript(
      group_folder,
      conversation_id,
      '2026-07-02T00:00:00.000Z',
    );
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).content).toBe('archive day member hit');
    expect(fs.existsSync(livePath)).toBe(true);

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('readChatTranscript restores archived chat transcript larger than exec default buffer', () => {
    const group_folder = 'test-chat-large-archive-restore-group';
    const conversation_id = 'conv-1767225600000-large-archive';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const livePath = chatTranscriptPath(
      group_folder,
      undefined,
      conversation_id,
    );
    const memberName = path.basename(livePath);
    const tarPath = path.join(archiveDirPath, '2026-01-01.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(projectTranscriptsDir, { recursive: true });
    fs.mkdirSync(archiveDirPath, { recursive: true });

    const bigContent = 'x'.repeat(1024 * 1024 + 128);
    fs.writeFileSync(
      livePath,
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: bigContent,
        created_at: '2026-01-01T10:00:00.000Z',
      }) + '\n',
    );
    execFileSync(
      'tar',
      ['-czf', tarPath, '-C', projectTranscriptsDir, memberName],
      {
        stdio: 'ignore',
      },
    );
    fs.unlinkSync(livePath);

    const entries = readChatTranscript(group_folder, conversation_id);
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).content).toHaveLength(bigContent.length);
    expect(fs.statSync(livePath).size).toBeGreaterThan(1024 * 1024);

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('readChatTranscript restores when a stale live file is empty', () => {
    const group_folder = 'test-chat-empty-live-restore-group';
    const conversation_id = 'conv-1767225600000-empty-live';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const livePath = chatTranscriptPath(
      group_folder,
      undefined,
      conversation_id,
    );
    const memberName = path.basename(livePath);
    const tarPath = path.join(archiveDirPath, '2026-01-01.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(projectTranscriptsDir, { recursive: true });
    fs.mkdirSync(archiveDirPath, { recursive: true });

    fs.writeFileSync(
      livePath,
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: 'restored over empty live file',
        created_at: '2026-01-01T10:00:00.000Z',
      }) + '\n',
    );
    execFileSync(
      'tar',
      ['-czf', tarPath, '-C', projectTranscriptsDir, memberName],
      {
        stdio: 'ignore',
      },
    );

    fs.writeFileSync(livePath, '');
    const entries = readChatTranscript(group_folder, conversation_id);
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).content).toBe('restored over empty live file');
    expect(fs.statSync(livePath).size).toBeGreaterThan(0);

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('readChatTranscript restores dot-prefixed tar members', () => {
    const group_folder = 'test-chat-dot-member-restore-group';
    const conversation_id = 'conv-1767225600000-dot-member';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const livePath = chatTranscriptPath(
      group_folder,
      undefined,
      conversation_id,
    );
    const tarPath = path.join(archiveDirPath, '2026-01-01.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(projectTranscriptsDir, { recursive: true });
    fs.mkdirSync(archiveDirPath, { recursive: true });

    const stagingDir = path.join(GROUPS_DIR, `${group_folder}-staging`);
    const stagingFile = path.join(stagingDir, path.basename(livePath));
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    fs.mkdirSync(stagingDir, { recursive: true });

    fs.writeFileSync(
      stagingFile,
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: 'dot member archive hit',
        created_at: '2026-01-01T10:00:00.000Z',
      }) + '\n',
    );
    execFileSync('tar', ['-czf', tarPath, '-C', stagingDir, '.'], {
      stdio: 'ignore',
    });

    const entries = readChatTranscript(group_folder, conversation_id);
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).content).toBe('dot member archive hit');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
  });

  test('readTaskMessagesAsync restores via the date-key hint fast path (async)', async () => {
    // Same as the sync test, but exercising the async path.
    const group_folder = 'test-task-date-hint-async-group';
    const taskId = 'task-1767225600000-date-hint-async-1';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const livePath = path.join(
      projectTranscriptsDir,
      `2026-01-01-${taskId}.jsonl`,
    );
    const tarPath = path.join(archiveDirPath, '2026-01-01.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(archiveDirPath, { recursive: true });

    await appendTaskMessageAsync(group_folder, {
      task_id: taskId,
      role: 'user',
      content: 'date-hint async hit',
      created_at: '2026-01-01T10:00:00.000Z',
    });
    expect(fs.existsSync(livePath)).toBe(true);

    execFileSync(
      'tar',
      [
        '-czf',
        tarPath,
        '-C',
        projectTranscriptsDir,
        `2026-01-01-${taskId}.jsonl`,
      ],
      { stdio: 'ignore' },
    );
    fs.unlinkSync(livePath);
    expect(fs.existsSync(livePath)).toBe(false);

    const messages = await readTaskMessagesAsync(group_folder, taskId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('date-hint async hit');
    expect(fs.existsSync(livePath)).toBe(true);

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('readTaskMessages falls back to scan when the date hint misses', () => {
    // Hint-miss: the task's creation date is 2026-01-01, but the
    // archive lives under 2026-05-15. The hint should not match
    // (the 2026-01-01 bundle doesn't exist), so the primitive must
    // fall through to the full newest-first scan and still find the
    // transcript.
    const group_folder = 'test-task-hint-miss-group';
    const taskId = 'task-1767225600000-hint-miss-1';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    const livePath = path.join(
      projectTranscriptsDir,
      `2026-01-01-${taskId}.jsonl`,
    );
    const wrongDateTarPath = path.join(archiveDirPath, '2026-05-15.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(archiveDirPath, { recursive: true });

    appendTaskMessage(group_folder, {
      task_id: taskId,
      role: 'user',
      content: 'hint-miss fallback hit',
      created_at: '2026-01-01T10:00:00.000Z',
    });

    execFileSync(
      'tar',
      [
        '-czf',
        wrongDateTarPath,
        '-C',
        projectTranscriptsDir,
        `2026-01-01-${taskId}.jsonl`,
      ],
      { stdio: 'ignore' },
    );
    fs.unlinkSync(livePath);
    expect(fs.existsSync(livePath)).toBe(false);

    // The hint will be `2026-01-01.tar.gz` (does not exist), so the
    // primitive scans and finds the file inside `2026-05-15.tar.gz`.
    const messages = readTaskMessages(group_folder, taskId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hint-miss fallback hit');
    expect(fs.existsSync(livePath)).toBe(true);

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('readTaskMessages falls back to scan when task id has no parseable date', () => {
    // No-hint case: the task id is uuid-style (no 13-digit epoch), so
    // `dateFromId` returns null, `taskArchiveHint` returns null, and
    // the shared primitive must scan all archives newest-first.
    const group_folder = 'test-task-no-hint-group';
    const taskId = 'no-epoch-uuid-style-task-id-001';
    const projectTranscriptsDir = path.join(
      GROUPS_DIR,
      group_folder,
      'transcripts',
    );
    const archiveDirPath = path.join(projectTranscriptsDir, 'archive');
    // No epoch → resolveTranscriptFile returns the legacy basename.
    const livePath = path.join(projectTranscriptsDir, `${taskId}.jsonl`);
    const tarPath = path.join(archiveDirPath, '2026-04-01.tar.gz');

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
    fs.mkdirSync(archiveDirPath, { recursive: true });

    appendTaskMessage(group_folder, {
      task_id: taskId,
      role: 'user',
      content: 'no-hint scan hit',
      created_at: '2026-04-01T10:00:00.000Z',
    });

    execFileSync(
      'tar',
      ['-czf', tarPath, '-C', projectTranscriptsDir, `${taskId}.jsonl`],
      { stdio: 'ignore' },
    );
    fs.unlinkSync(livePath);
    expect(fs.existsSync(livePath)).toBe(false);

    // No hint → full scan finds the file.
    const messages = readTaskMessages(group_folder, taskId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('no-hint scan hit');
    expect(fs.existsSync(livePath)).toBe(true);

    try {
      fs.rmSync(path.join(GROUPS_DIR, group_folder), {
        recursive: true,
        force: true,
      });
    } catch {}
  });
});

describe('task transcript reads refuse planted symlinks and FIFOs', () => {
  const group = 'test-transcript-planted-links';
  const dir = path.join(GROUPS_DIR, group, 'transcripts');
  const foreignDir = path.join(GROUPS_DIR, `${group}-foreign`);
  const message = (task_id: string, content: string) =>
    JSON.stringify({
      id: `m-${task_id}`,
      task_id,
      role: 'user',
      content,
      created_at: '2026-01-01T10:00:00.000Z',
    }) + '\n';
  let fifoOk = true;

  beforeAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, group), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(foreignDir, { recursive: true });
    try {
      execFileSync('mkfifo', [path.join(dir, '.probe')]);
    } catch {
      fifoOk = false;
    }
  });

  afterAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, group), { recursive: true, force: true });
    fs.rmSync(foreignDir, { recursive: true, force: true });
  });

  test('regular task transcript is read; symlink to a foreign JSONL yields nothing', async () => {
    const real = 'task-1767225600000-real01';
    fs.writeFileSync(
      path.join(dir, datedTranscriptName(`${real}.jsonl`, real)),
      message(real, 'mine'),
    );
    expect(readTaskMessages(group, real).map((m) => m.content)).toEqual([
      'mine',
    ]);

    const linked = 'task-1767225600000-link01';
    const foreign = path.join(foreignDir, 'secret.jsonl');
    fs.writeFileSync(foreign, message(linked, 'foreign secret'));
    fs.symlinkSync(
      foreign,
      path.join(dir, datedTranscriptName(`${linked}.jsonl`, linked)),
    );
    expect(readTaskMessages(group, linked)).toEqual([]);
    expect(await readTaskMessagesAsync(group, linked)).toEqual([]);
  });

  test('a FIFO task transcript returns [] without blocking', async () => {
    if (!fifoOk) return;
    const task_id = 'task-1767225600000-fifo01';
    execFileSync('mkfifo', [
      path.join(dir, datedTranscriptName(`${task_id}.jsonl`, task_id)),
    ]);
    expect(readTaskMessages(group, task_id)).toEqual([]);
    expect(await readTaskMessagesAsync(group, task_id)).toEqual([]);
  }, 2000);
});

describe('task output stream reads refuse planted symlinks and FIFOs', () => {
  const group = 'test-stream-planted-links';
  const dir = path.join(GROUPS_DIR, group, 'transcripts');
  const foreignDir = path.join(GROUPS_DIR, `${group}-foreign`);
  const chunk = (content: string) =>
    JSON.stringify({ run_id: 'run-1', content }) + '\n';
  const output = (task_id: string) =>
    readTaskOutputPage(group, task_id, 10, 0, 'run-1')
      .entries.map((e) => e.content)
      .join('');

  beforeAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, group), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(foreignDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, group), { recursive: true, force: true });
    fs.rmSync(foreignDir, { recursive: true, force: true });
  });

  test('regular stream is read; symlinked or FIFO stream yields nothing', () => {
    const real = 'task-1767225600000-strm01';
    fs.writeFileSync(path.join(dir, `${real}.stream.jsonl`), chunk('mine'));
    expect(output(real)).toBe('mine');

    const linked = 'task-1767225600000-strm02';
    const foreign = path.join(foreignDir, 'stream.jsonl');
    fs.writeFileSync(foreign, chunk('FOREIGN-SECRET'));
    fs.symlinkSync(foreign, path.join(dir, `${linked}.stream.jsonl`));
    expect(output(linked)).toBe('');

    const fifo = 'task-1767225600000-strm03';
    try {
      execFileSync('mkfifo', [path.join(dir, `${fifo}.stream.jsonl`)]);
    } catch {
      return; // mkfifo unavailable
    }
    expect(output(fifo)).toBe('');
  }, 2000);
});

describe('clearTaskOutputRun on an agent-writable stream file', () => {
  const group = 'test-clear-stream-planted-link';
  const dir = path.join(GROUPS_DIR, group, 'transcripts');
  const foreignDir = path.join(GROUPS_DIR, `${group}-foreign`);

  afterAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, group), { recursive: true, force: true });
    fs.rmSync(foreignDir, { recursive: true, force: true });
  });

  test('a stream file symlinked to a foreign file is neither read nor copied', () => {
    fs.rmSync(path.join(GROUPS_DIR, group), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(foreignDir, { recursive: true });
    const task = 'task-1767225600000-clear1';
    const foreign = path.join(foreignDir, 'stream.jsonl');
    const secret =
      JSON.stringify({ run_id: 'other-run', content: 'FOREIGN-SECRET' }) + '\n';
    fs.writeFileSync(foreign, secret);
    const streamFile = path.join(dir, `${task}.stream.jsonl`);
    fs.symlinkSync(foreign, streamFile);

    clearTaskOutputRun(group, task, 'run-1');

    expect(fs.readFileSync(foreign, 'utf8')).toBe(secret);
    expect(fs.lstatSync(streamFile).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([`${task}.stream.jsonl`]);
  });
});

describe('persistRecordings', () => {
  const folder = `recordings-${process.pid}-${Date.now()}`;
  const target = path.join(GROUPS_DIR, folder, 'recordings', 'task-t1');
  const tmpDirs: string[] = [];
  const srcDirWith = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync('/tmp/carapa-recordings-');
    tmpDirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
  };

  afterAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('keeps recordings from earlier runs and assigns run-specific names', () => {
    const first = srcDirWith({ 'session.webm': 'first' });
    const second = srcDirWith({ 'session.webm': 'second' });

    expect(persistRecordings(folder, 't1', first, 'run-100-a')).toHaveLength(1);
    expect(persistRecordings(folder, 't1', second, 'run-200-b')).toHaveLength(
      1,
    );
    expect(fs.readdirSync(target).sort()).toEqual([
      'run-100-a-session.webm',
      'run-200-b-session.webm',
    ]);
    expect(
      fs.readFileSync(path.join(target, 'run-100-a-session.webm'), 'utf8'),
    ).toBe('first');
    expect(
      fs.readFileSync(path.join(target, 'run-200-b-session.webm'), 'utf8'),
    ).toBe('second');
    // The moved sources are gone from the transient dir.
    expect(fs.readdirSync(first)).toEqual([]);
  });

  test('a symlinked source recording copies nothing', () => {
    const outside = srcDirWith({ 'secret.txt': 'top-secret-bytes' });
    const src = srcDirWith({});
    fs.symlinkSync(
      path.join(outside, 'secret.txt'),
      path.join(src, 'planted.webm'),
    );

    expect(persistRecordings(folder, 't2', src, 'run-300-c')).toEqual([]);
    const copied = path.join(
      GROUPS_DIR,
      folder,
      'recordings',
      'task-t2',
      'run-300-c-planted.webm',
    );
    expect(fs.existsSync(copied)).toBe(false);
  });
});

describe('agent display formatting on replay', () => {
  test('preserves identities for reversed delayed results without steering', () => {
    const formatted = formatTranscriptEntries([
      { type: 'message', role: 'user', content: 'Run both', id: 'user-1' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'plain-a',
          type: 'command_execution',
          command: 'bun test repeated',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'plain-prose',
          type: 'agent_message',
          text: 'Between calls.',
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'plain-b',
          type: 'command_execution',
          command: 'bun test repeated',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'plain-b',
          type: 'command_execution',
          command: 'bun test repeated',
          exit_code: 1,
          aggregated_output: 'plain B result',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'plain-a',
          type: 'command_execution',
          command: 'bun test repeated',
          exit_code: 0,
          aggregated_output: 'plain A result',
        },
      },
    ]) as Array<Record<string, unknown>>;
    const content = String(
      formatted.find((entry) => entry.role === 'assistant')?.content || '',
    );

    expect(content).toContain('<!-- carapa-tool:request tool-id="plain-a" -->');
    expect(content).toContain('<!-- carapa-tool:result tool-id="plain-a" -->');
    expect(content).toContain('<!-- carapa-tool:request tool-id="plain-b" -->');
    expect(content).toContain('<!-- carapa-tool:error tool-id="plain-b" -->');
    expect(content.match(/plain A result/g)).toHaveLength(1);
    expect(content.match(/plain B result/g)).toHaveLength(1);
  });

  test('keeps reversed delayed Codex results with their calls across steering replay', () => {
    const callA = {
      type: 'item.started',
      item: {
        id: 'delayed-a',
        type: 'command_execution',
        command: 'bun test repeated',
      },
    };
    const callB = {
      type: 'item.started',
      item: {
        id: 'delayed-b',
        type: 'command_execution',
        command: 'bun test repeated',
      },
    };
    const preSteeringContent =
      formatToolUse(
        'Bash',
        { command: 'bun test repeated' },
        undefined,
        undefined,
        'delayed-a',
      ) +
      'Intervening explanation.' +
      formatToolUse(
        'Bash',
        { command: 'bun test repeated' },
        undefined,
        undefined,
        'delayed-b',
      );
    const visible = formatTranscriptEntries([
      { type: 'message', role: 'user', content: 'Run checks', id: 'user-1' },
      {
        type: 'message',
        role: 'user',
        content: 'Adjust the rest',
        id: 'steer-1',
      },
      {
        type: 'steering_delivery',
        messageId: 'steer-1',
        delivery: 'steered',
        contentOffset: preSteeringContent.length,
        contentOffsetMarkerVersion: 2,
      },
      { type: 'turn.started' },
      callA,
      {
        type: 'item.completed',
        item: {
          id: 'prose-before',
          type: 'agent_message',
          text: 'Intervening explanation.',
        },
      },
      callB,
      {
        type: 'item.completed',
        item: {
          id: 'delayed-b',
          type: 'command_execution',
          command: 'bun test repeated',
          exit_code: 1,
          aggregated_output: 'result owned by B',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'delayed-a',
          type: 'command_execution',
          command: 'bun test repeated',
          exit_code: 0,
          aggregated_output: 'result owned by A',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'prose-after',
          type: 'agent_message',
          text: 'Subsequent explanation.',
        },
      },
    ]) as Array<Record<string, unknown>>;

    const assistant = visible.filter((entry) => entry.role === 'assistant');
    expect(visible.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(assistant[0].content).toContain('Intervening explanation.');
    expect(assistant[0].content).toContain('result owned by A');
    expect(assistant[0].content).toContain('result owned by B');
    expect(assistant[1].content).toContain('Subsequent explanation.');
    expect(assistant[1].content).not.toContain('result owned by');
    expect(
      visible.filter(
        (entry) => entry.role === 'user' && entry.content === 'Adjust the rest',
      ),
    ).toHaveLength(1);
    expect(
      String(assistant[0].content).match(/result owned by A/g),
    ).toHaveLength(1);
    expect(
      String(assistant[0].content).match(/result owned by B/g),
    ).toHaveLength(1);
  });
});

describe('cross-runtime context handoff', () => {
  const groupFolder = 'test-transcript-handoff';

  beforeAll(() => {
    fs.mkdirSync(path.join(GROUPS_DIR, groupFolder, 'transcripts'), {
      recursive: true,
    });
  });

  afterAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, groupFolder), {
      recursive: true,
      force: true,
    });
  });

  const rawAssistantEvents = {
    claude: {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Claude context' }] },
      session_id: 'claude-native',
    },
    codex: {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Codex context' },
      thread_id: 'codex-native',
    },
    opencode: {
      type: 'text',
      part: { type: 'text', text: 'OpenCode context' },
      session_id: 'opencode-native',
    },
    pi: {
      type: 'agent_end',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Latest prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Pi context' }] },
      ],
      session_id: 'pi-native',
    },
    direct: {
      type: 'message',
      role: 'assistant',
      content: 'Direct LLM context',
      session_id: 'direct-native',
    },
    gemini: {
      type: 'message',
      role: 'assistant',
      content: 'Gemini context',
      session_id: 'gemini-native',
    },
    cursor: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Cursor context' }],
      },
      session_id: 'cursor-native',
    },
  } as const;

  function handoffFor(
    source: keyof typeof rawAssistantEvents,
    target: string,
  ): string {
    const conversationId = `handoff-${source}-to-${target}-${Math.random().toString(36).slice(2)}`;
    appendChatTranscriptEntry(groupFolder, conversationId, {
      type: 'message',
      role: 'user',
      content: `Earlier request for ${source}`,
    });
    appendChatTranscriptEntry(
      groupFolder,
      conversationId,
      rawAssistantEvents[source],
    );
    appendChatTranscriptEntry(groupFolder, conversationId, {
      type: 'message',
      role: 'user',
      content: 'Latest prompt',
    });
    return getAgentContextGap(groupFolder, conversationId, target, null) || '';
  }

  test.each(['codex'] as const)(
    'Direct LLM → %s receives prior Direct LLM context once',
    (target) => {
      const summary = handoffFor('direct', target);
      expect(summary).toContain('Direct LLM context');
      expect(summary).not.toContain('Latest prompt');
      expect(summary).not.toContain('direct-native');
    },
  );

  test('Direct LLM history normalizes raw CLI responses and omits only the current prompt', async () => {
    const conversationId = `direct-history-${Math.random().toString(36).slice(2)}`;
    appendChatTranscriptEntry(groupFolder, conversationId, {
      type: 'message',
      role: 'user',
      content: 'Earlier request',
    });
    appendChatTranscriptEntry(
      groupFolder,
      conversationId,
      rawAssistantEvents.claude,
    );
    appendChatTranscriptEntry(
      groupFolder,
      conversationId,
      rawAssistantEvents.codex,
    );
    appendChatTranscriptEntry(
      groupFolder,
      conversationId,
      rawAssistantEvents.opencode,
    );
    appendChatTranscriptEntry(
      groupFolder,
      conversationId,
      rawAssistantEvents.pi,
    );
    appendChatTranscriptEntry(groupFolder, conversationId, {
      type: 'message',
      role: 'user',
      content: 'Latest prompt',
    });

    const history = await getLlmHistory(groupFolder, conversationId, true);
    expect(history.map((message) => message.content).join('\n')).toContain(
      'Claude context',
    );
    expect(history.map((message) => message.content).join('\n')).toContain(
      'Codex context',
    );
    expect(history.map((message) => message.content).join('\n')).toContain(
      'OpenCode context',
    );
    expect(history.map((message) => message.content).join('\n')).toContain(
      'Pi context',
    );
    expect(history.some((message) => message.content === 'Latest prompt')).toBe(
      false,
    );
  });

  test('CarapaRun V1 tools stay structured on disk and become tool history only at projection boundaries', async () => {
    const conversationId = `carapa-v1-tools-${Math.random().toString(36).slice(2)}`;
    appendChatTranscriptEntry(groupFolder, conversationId, {
      type: 'message',
      role: 'user',
      content: 'Demonstrate a tool call',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      id: 'run-1-v1-tool-call-1',
      type: 'tool_call',
      status: 'started',
      name: 'bash',
      category: 'execute',
      input: { command: 'pwd' },
      agent_name: 'pi:gpt-test',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      id: 'run-1-v1-tool-call-1',
      type: 'tool_call',
      status: 'in_progress',
      outputDelta: '/workspace/project\n',
      agent_name: 'pi:gpt-test',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      id: 'run-1-v1-tool-call-1',
      type: 'tool_call',
      status: 'completed',
      name: 'bash',
      output: '/workspace/project\n',
      agent_name: 'pi:gpt-test',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      type: 'message',
      role: 'assistant',
      content: 'The current directory is `/workspace/project`.',
      agent_name: 'pi:gpt-test',
    });

    const stored = readChatTranscript(groupFolder, conversationId) as Array<
      Record<string, unknown>
    >;
    expect(stored.filter((entry) => entry.type === 'tool_call')).toHaveLength(
      3,
    );
    expect(
      stored.some(
        (entry) =>
          entry.type === 'message' &&
          String(entry.content || '').includes('carapa-tool:'),
      ),
    ).toBe(false);

    const formatted = formatTranscriptEntries(stored) as Array<{
      role?: string;
      content?: string;
    }>;
    const display = formatted
      .filter((entry) => entry.role === 'assistant')
      .map((entry) => entry.content || '')
      .join('');
    expect(display).toContain('> **Bash** `pwd`');
    expect(display).toContain('> /workspace/project');
    expect(display).toContain('The current directory is');

    const history = await getLlmHistory(groupFolder, conversationId);
    expect(history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(history[1].content).toBe('');
    expect(history[1].tool_calls?.[0]).toMatchObject({
      id: 'run-1-v1-tool-call-1',
      function: { name: 'bash', arguments: '{"command":"pwd"}' },
    });
    expect(history[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'run-1-v1-tool-call-1',
      content: '/workspace/project\n',
    });
  });

  test.each(['claude', 'codex', 'opencode', 'pi', 'gemini', 'cursor'] as const)(
    '%s → Direct LLM receives prior CLI context once',
    (source) => {
      const summary = handoffFor(source, 'llm:direct:qwen');
      expect(summary).toContain(
        `${source === 'opencode' ? 'OpenCode' : source[0].toUpperCase() + source.slice(1)} context`,
      );
      expect(summary).not.toContain('Latest prompt');
      expect(summary).not.toContain(`${source}-native`);
    },
  );

  test.each([
    [
      'Codex',
      { type: 'thread.started', thread_id: 'codex-resume' },
      'codex-resume',
    ],
    [
      'OpenCode',
      { type: 'step_start', sessionID: 'opencode-resume' },
      'opencode-resume',
    ],
    ['Pi', { type: 'session', id: 'pi-resume' }, 'pi-resume'],
  ])(
    '%s native session marker stops the gap before already-known context',
    (_runtime, marker, sessionId) => {
      const conversationId = `handoff-boundary-${sessionId}`;
      appendChatTranscriptEntry(groupFolder, conversationId, {
        type: 'message',
        role: 'assistant',
        content: 'Already known target-runtime context',
      });
      appendChatTranscriptEntry(groupFolder, conversationId, marker);
      appendChatTranscriptEntry(groupFolder, conversationId, {
        type: 'message',
        role: 'user',
        content: 'Interleaved request',
      });
      appendChatTranscriptEntry(groupFolder, conversationId, {
        type: 'message',
        role: 'assistant',
        content: 'Interleaved runtime context',
      });
      appendChatTranscriptEntry(groupFolder, conversationId, {
        type: 'message',
        role: 'user',
        content: 'Latest prompt',
      });

      const summary = getAgentContextGap(
        groupFolder,
        conversationId,
        'target-runtime',
        sessionId,
      );
      expect(summary).toContain('Interleaved runtime context');
      expect(summary).toContain('Interleaved request');
      expect(summary).not.toContain('Already known target-runtime context');
      expect(summary).not.toContain('Latest prompt');
    },
  );

  test('persona handoff keeps the full visible reply and excludes provider tool events', async () => {
    const conversationId = `persona-handoff-${Math.random().toString(36).slice(2)}`;
    appendChatTranscriptEntry(groupFolder, conversationId, {
      type: 'message',
      role: 'user',
      content: 'Original human prompt',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      type: 'item.completed',
      item: { type: 'command_execution', output: 'private tool result' },
      agent_name: 'ai:morgan',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      id: 'morgan-visible',
      type: 'message',
      role: 'assistant',
      content: [
        '> **ripgrep** _handoff internals_',
        '',
        '> internal match',
        '',
        '> **Read** `src/private.ts`',
        '',
        '> private file contents',
        '',
        "Morgan's complete visible response.",
      ].join('\n'),
      sender_name: 'Morgan',
      senderUserId: 'ai:morgan',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      id: 'morgan-visible',
      type: 'ai_user_attribution',
      role: 'assistant',
      content: '',
      sender_name: 'Morgan',
      senderUserId: 'ai:morgan',
    });

    expect(getPersonaHandoffMessages(groupFolder, conversationId)).toEqual([
      {
        senderName: 'Morgan',
        content: "Morgan's complete visible response.",
      },
    ]);
    const history = await getLlmHistory(groupFolder, conversationId);
    const historyText = history.map((message) => message.content).join('\n');
    expect(historyText).toContain(
      "[Persona Morgan]: Morgan's complete visible response.",
    );
    expect(historyText).not.toContain('private tool result');
    expect(historyText).not.toContain('handoff internals');
    expect(historyText).not.toContain('private file contents');
    expect(
      stripPersonaHandoffToolTrace('A real answer.\n\n> A quoted conclusion.'),
    ).toBe('A real answer.\n\n> A quoted conclusion.');
  });

  test('resumed native session receives interleaved human and persona turns without its own output', () => {
    const conversationId = `persona-native-gap-${Math.random().toString(36).slice(2)}`;
    appendChatTranscriptEntry(groupFolder, conversationId, {
      type: 'thread.started',
      thread_id: 'native-session',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      type: 'message',
      role: 'assistant',
      content: 'Output already known by the native session.',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      id: 'queued-one',
      type: 'message',
      role: 'user',
      content: 'First queued human prompt.',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      id: 'morgan-gap',
      type: 'message',
      role: 'assistant',
      content: 'Morgan response for the handoff.',
      sender_name: 'Morgan',
      senderUserId: 'ai:morgan',
    });
    appendChatTranscriptEntry(groupFolder, conversationId, {
      id: 'queued-two',
      type: 'message',
      role: 'user',
      content: 'Second queued human prompt.',
    });

    const gap = getAgentInterleavedContextGap(
      groupFolder,
      conversationId,
      'native-session',
    );
    expect(gap).toContain('User: First queued human prompt.');
    expect(gap).toContain(
      'Assistant (Morgan): Morgan response for the handoff.',
    );
    expect(gap).toContain('User: Second queued human prompt.');
    expect(gap).not.toContain('Output already known by the native session.');
  });
});

describe('archive restore returns the newest bundle copy', () => {
  const group_folder = 'test-newest-bundle-group';
  const transcriptsDir = path.join(GROUPS_DIR, group_folder, 'transcripts');
  const archiveDirPath = path.join(transcriptsDir, 'archive');
  const staging = path.join(transcriptsDir, 'staging');
  const created = Date.parse('2026-01-01T00:00:00.000Z');

  beforeAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, group_folder), {
      recursive: true,
      force: true,
    });
    fs.mkdirSync(archiveDirPath, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(path.join(GROUPS_DIR, group_folder), {
      recursive: true,
      force: true,
    });
  });

  function jsonlLines(count: number): string {
    return Array.from({ length: count }, (_, i) =>
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: `line ${i}`,
        created_at: `2026-01-01T10:00:0${i}.000Z`,
      }),
    )
      .map((line) => `${line}\n`)
      .join('');
  }

  /** Stale creation-date bundle (2 lines) plus a newer bundle (5 lines). */
  function seedTwoBundles(member: string): void {
    for (const [bundle, count] of [
      ['2026-01-01', 2],
      ['2026-07-01', 5],
    ] as const) {
      fs.writeFileSync(path.join(staging, member), jsonlLines(count));
      execFileSync(
        'tar',
        [
          '-czf',
          path.join(archiveDirPath, `${bundle}.tar.gz`),
          '-C',
          staging,
          member,
        ],
        { stdio: 'ignore' },
      );
    }
    fs.rmSync(path.join(staging, member));
  }

  function lineCount(file: string): number {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  }

  let seq = 0;
  function chatFixture() {
    const conversation_id = `conv-${created}-newest-${seq++}`;
    const live = chatTranscriptPath(group_folder, undefined, conversation_id);
    seedTwoBundles(path.basename(live));
    return { conversation_id, live };
  }
  function taskFixture(suffix = '.jsonl') {
    const taskId = `task-${created}-newest-${seq++}`;
    const member = `2026-01-01-${taskId}${suffix}`;
    seedTwoBundles(member);
    // Stream files restore to the undated `<task>.stream.jsonl` path.
    const liveName = suffix === '.jsonl' ? member : `${taskId}${suffix}`;
    return { taskId, live: path.join(transcriptsDir, liveName) };
  }

  test('chat sync read', () => {
    const { conversation_id, live } = chatFixture();
    expect(readChatTranscript(group_folder, conversation_id)).toHaveLength(5);
    expect(lineCount(live)).toBe(5);
  });

  test('chat async read', async () => {
    const { conversation_id, live } = chatFixture();
    expect(
      await readChatTranscriptAsync(group_folder, conversation_id),
    ).toHaveLength(5);
    expect(lineCount(live)).toBe(5);
  });

  test('chat append lands on the newest copy', () => {
    const { conversation_id, live } = chatFixture();
    appendChatTranscriptEntry(group_folder, conversation_id, {
      type: 'message',
      role: 'user',
      content: 'appended',
    });
    expect(lineCount(live)).toBe(6);
  });

  test('task sync read', () => {
    const { taskId, live } = taskFixture();
    expect(readTaskMessages(group_folder, taskId)).toHaveLength(5);
    expect(lineCount(live)).toBe(5);
  });

  test('task async read', async () => {
    const { taskId, live } = taskFixture();
    expect(await readTaskMessagesAsync(group_folder, taskId)).toHaveLength(5);
    expect(lineCount(live)).toBe(5);
  });

  test('task stream file', () => {
    const { taskId, live } = taskFixture('.stream.jsonl');
    readTaskOutputPage(group_folder, taskId, 10, 0);
    expect(lineCount(live)).toBe(5);
  });
});
