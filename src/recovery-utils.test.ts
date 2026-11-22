/**
 * Tests for recovery-utils.ts
 *
 * These cover the pure filesystem helpers used by the boot-time sweep in
 * index.ts.  The DB-dependent sweep functions (recoverStalledRuns,
 * sweepOrphanedIpcDirs, sweepStuckConversations) cannot be unit-tested
 * without a full server bootstrap; coverage of those entry points requires
 * an end-to-end test harness.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getRecoveredScheduledRunOutcome,
  resolveGroupFolderFromIpcDir,
  resolveOrphanedRunMetadata,
} from './recovery-utils.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-recovery-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRunDir(name: string): string {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeArgs(runDir: string, args: Record<string, unknown>): void {
  fs.writeFileSync(path.join(runDir, 'args.json'), JSON.stringify(args));
}

describe('resolveGroupFolderFromIpcDir', () => {
  test('resolves warm-session groups when the default stack name contains a dash', () => {
    expect(
      resolveGroupFolderFromIpcDir('carapa-bot-my-project', ['my-project']),
    ).toBe('my-project');
  });
});

describe('resolveOrphanedRunMetadata', () => {
  test('ignores obsolete snake_case args.json fields', () => {
    const runDir = makeRunDir('run-abc');
    writeArgs(runDir, {
      group_folder: 'wrong-project',
      task_id: 'wrong-task',
      conversation_id: 'wrong-conversation',
      session_id: 'wrong-session',
    });
    expect(
      resolveOrphanedRunMetadata(runDir, 'openclaw-other', ['other']),
    ).toEqual({
      groupFolder: 'other',
      taskId: undefined,
      conversationId: undefined,
      sessionId: undefined,
    });
  });

  test('falls back to the IPC dir owner without a usable args.json groupFolder', () => {
    const missing = path.join(tmpDir, 'run-missing');
    expect(() =>
      resolveOrphanedRunMetadata(missing, 'openclaw-group', ['group']),
    ).not.toThrow();
    expect(
      resolveOrphanedRunMetadata(missing, 'openclaw-group', ['group'])
        .groupFolder,
    ).toBe('group');

    const noArgs = makeRunDir('run-no-args');
    expect(
      resolveOrphanedRunMetadata(noArgs, 'openclaw-carapa-board', [
        'carapa-board',
      ]).groupFolder,
    ).toBe('carapa-board');

    const noGroup = makeRunDir('run-no-group');
    writeArgs(noGroup, { model: 'gemini' });
    expect(
      resolveOrphanedRunMetadata(noGroup, 'sandpack-my-group', ['my-group'])
        .groupFolder,
    ).toBe('my-group');
  });

  test('prefers the longest registered group suffix of the IPC dir name', () => {
    const runDir = makeRunDir('run-longest-suffix');
    expect(
      resolveOrphanedRunMetadata(runDir, 'carapa-bot-team-project', [
        'project',
        'team-project',
      ]).groupFolder,
    ).toBe('team-project');
  });

  test('uses the camelCase groupFolder written by run launch metadata', () => {
    const runDir = makeRunDir('run-camel');
    writeArgs(runDir, { groupFolder: 'project-with-dashes' });
    expect(
      resolveOrphanedRunMetadata(runDir, 'carapa-bot-wrong-group', [
        'project-with-dashes',
      ]).groupFolder,
    ).toBe('project-with-dashes');
  });

  test('preserves task and conversation launch identity', () => {
    const taskRunDir = makeRunDir('run-task-identity');
    writeArgs(taskRunDir, {
      groupFolder: 'my-project',
      taskId: 'task-123',
      sessionId: 'session-123',
    });
    expect(
      resolveOrphanedRunMetadata(taskRunDir, 'carapa-bot-wrong', [
        'my-project',
      ]),
    ).toEqual({
      groupFolder: 'my-project',
      taskId: 'task-123',
      conversationId: undefined,
      sessionId: 'session-123',
    });

    const chatRunDir = makeRunDir('run-chat-identity');
    writeArgs(chatRunDir, {
      groupFolder: 'my-project',
      conversationId: 'conv-123',
    });
    expect(
      resolveOrphanedRunMetadata(chatRunDir, 'carapa-bot-wrong', [
        'my-project',
      ]),
    ).toEqual({
      groupFolder: 'my-project',
      taskId: undefined,
      conversationId: 'conv-123',
      sessionId: undefined,
    });
  });

  test('ignores an args.json identity for a group that does not own the IPC directory', () => {
    const forgedDir = makeRunDir('run-forged-group');
    writeArgs(forgedDir, { groupFolder: 'victim', taskId: 'task-forged' });
    // Neither the forged group nor its ids are trusted; the IPC dir owner wins.
    expect(
      resolveOrphanedRunMetadata(forgedDir, 'carapa-bot-attacker', [
        'attacker',
      ]),
    ).toEqual({ groupFolder: 'attacker' });
    // With no allowed owner there is no identity at all (fail closed).
    expect(
      resolveOrphanedRunMetadata(forgedDir, 'carapa-bot-attacker', []),
    ).toEqual({ groupFolder: undefined });
  });

  test('treats path-like task, conversation and session ids as absent', () => {
    const runDir = makeRunDir('run-unsafe-ids');
    writeArgs(runDir, {
      groupFolder: 'my-project',
      taskId: '../x',
      conversationId: 'a/b',
      sessionId: '..',
    });
    expect(
      resolveOrphanedRunMetadata(runDir, 'carapa-bot-my-project', [
        'my-project',
      ]),
    ).toEqual({
      groupFolder: 'my-project',
      taskId: undefined,
      conversationId: undefined,
      sessionId: undefined,
    });
  });

  test('routes orphaned child output from a parent-named shared IPC directory', () => {
    const childRunDir = makeRunDir('run-shared-child');
    writeArgs(childRunDir, {
      groupFolder: 'child-two',
      taskId: 'task-child-two',
      groupDir: '/workspace/group/child-two',
    });

    expect(
      resolveOrphanedRunMetadata(childRunDir, 'shared-stack-parent-instance', [
        'parent',
        'child-one',
        'child-two',
      ]),
    ).toEqual({
      groupFolder: 'child-two',
      taskId: 'task-child-two',
      conversationId: undefined,
      sessionId: undefined,
    });
  });
});

describe('getRecoveredScheduledRunOutcome', () => {
  test('records a non-zero agent exit as an error even when output has a result', () => {
    expect(
      getRecoveredScheduledRunOutcome('partial result before failure', true),
    ).toEqual({
      status: 'error',
      error: 'Agent exited with error during restart',
      resultSummary: 'partial result before failure',
    });
  });

  test('records missing recovered output as an error after a zero exit', () => {
    expect(getRecoveredScheduledRunOutcome(null, false)).toEqual({
      status: 'error',
      error: 'Recovered after restart',
      resultSummary: 'Recovered after restart',
    });
  });

  test('records a successful run', () => {
    expect(
      getRecoveredScheduledRunOutcome('x'.repeat(250), false),
    ).toMatchObject({ status: 'success', error: null });
  });
});
