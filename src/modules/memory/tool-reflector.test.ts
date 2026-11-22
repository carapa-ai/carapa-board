import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import OpenAI from 'openai';
import {
  ReflectorValidationError,
  recordReflectorToolError,
  type ReflectorMemoryExecutionContext,
} from './execution-context.js';
import { startReflectorGateScore } from './reflector-gate.js';
import {
  ReflectorChunkFailure,
  classifyReflectorChunkFailure,
  describeIncompleteReflection,
  processAutomaticTranscriptMemory,
} from './tool-reflector.js';

describe('incomplete reflection detail', () => {
  test('exposes the real reason as bounded strings', () => {
    expect(describeIncompleteReflection(new Error('boom')).detail).toBe('boom');
    expect(
      describeIncompleteReflection({
        runId: 'r',
        completed: false,
        error: 'Reflector run is already leased by another worker',
        failureReason: 'lease_lost',
      }),
    ).toEqual({
      detail: 'Reflector run is already leased by another worker',
      failureReason: 'lease_lost',
    });
    expect(describeIncompleteReflection(undefined).detail).toBe('undefined');
    expect(describeIncompleteReflection('x'.repeat(500)).detail).toHaveLength(
      300,
    );
  });
});

describe('reflector chunk failure categories', () => {
  const failedToolContext = (
    tool: string,
    error: unknown,
  ): ReflectorMemoryExecutionContext['toolErrors'] => {
    const context = { hadToolError: false } as ReflectorMemoryExecutionContext;
    recordReflectorToolError(context, tool, error);
    return context.toolErrors;
  };

  test('classifies the branch that failed, using bounded categories only', () => {
    const toolFailure = (tool: string, error: unknown) =>
      classifyReflectorChunkFailure(
        new ReflectorChunkFailure('x', 'tool_error'),
        failedToolContext(tool, error),
      );
    expect(
      toolFailure(
        'memorize',
        new ReflectorValidationError('bad date', 'k1', 'date'),
      ),
    ).toBe('tool_error:memorize:date');
    expect(
      toolFailure(
        'memorize',
        new ReflectorValidationError(
          'Memory m changed concurrently; recall again',
          'k2',
          'input',
        ),
      ),
    ).toBe('tool_error:memorize:version');
    expect(toolFailure('recall', new Error('boom'))).toBe(
      'tool_error:recall:other',
    );
    expect(toolFailure('web_search', new Error('boom'))).toBe(
      'tool_error:unknown:other',
    );
    expect(
      classifyReflectorChunkFailure(
        new ReflectorChunkFailure('x', 'no_completion'),
        undefined,
      ),
    ).toBe('no_completion');
    expect(
      classifyReflectorChunkFailure(
        new ReflectorChunkFailure('x', 'lease_lost'),
        undefined,
      ),
    ).toBe('lease_lost');
    const llmCause = (error: unknown) =>
      classifyReflectorChunkFailure(error, undefined);
    expect(llmCause(new Error('timeout'))).toBe('llm_error:timeout');
    expect(
      llmCause(Object.assign(new Error('x'), { name: 'TimeoutError' })),
    ).toBe('llm_error:timeout');
    expect(llmCause(Object.assign(new Error('rate'), { status: 429 }))).toBe(
      'llm_error:http_429',
    );
    expect(llmCause(new Error('LLM request failed (529): overloaded'))).toBe(
      'llm_error:http_529',
    );
    expect(llmCause(new OpenAI.APIUserAbortError())).toBe('llm_error:timeout');
    expect(
      llmCause(Object.assign(new Error('x'), { name: 'AbortError' })),
    ).toBe('llm_error:timeout');
    expect(llmCause(new OpenAI.APIConnectionError({}))).toBe(
      'llm_error:connection',
    );
    expect(
      llmCause(
        new Error('Connection error.', {
          cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toBe('llm_error:connection');
    expect(llmCause(new Error('boom: secret text'))).toBe('llm_error:other');
  });

  test('shadow record carries failureReason only for failed chunks, never message text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-gate-reason-'));
    const logPath = path.join(dir, 'shadow.jsonl');
    const fetchImpl = (async () =>
      new Response('{}', { status: 500 })) as unknown as typeof fetch;
    try {
      const options = {
        groupFolder: 'g',
        runId: 'r',
        shadowLogPath: logPath,
        fetchImpl,
      };
      await startReflectorGateScore({ text: 'a', index: 0 }, options).finish(
        null,
        'tool_error:memorize:date',
        'direct/test-model',
      );
      await startReflectorGateScore({ text: 'b', index: 1 }, options).finish(
        2,
        undefined,
        'direct/test-model',
        {
          llmDurationMs: 1234,
          promptTokens: 10,
          completionTokens: 5,
          chunkMessages: 3,
        },
      );
      await startReflectorGateScore({ text: 'c', index: 2 }, options).finish(
        null,
        'llm_error:other',
        'direct/test-model',
        { llmDurationMs: 77 },
      );
      const records = fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records).toHaveLength(3);
      expect(records[0].operationCount).toBeNull();
      expect(records[0].failureReason).toBe('tool_error:memorize:date');
      expect(records[0].model).toBe('direct/test-model');
      expect('failureReason' in records[1]).toBe(false);
      expect(records[1].model).toBe('direct/test-model');
      expect(records[1].llmDurationMs).toBe(1234);
      expect(records[1].promptTokens).toBe(10);
      expect(records[1].completionTokens).toBe(5);
      expect(records[1].chunkMessages).toBe(3);
      expect(records[1].operationCount).toBe(2);
      // Failed chunk with unknown usage: model + duration, no token fields.
      expect(records[2].model).toBe('direct/test-model');
      expect(records[2].llmDurationMs).toBe(77);
      expect('promptTokens' in records[2]).toBe(false);
      expect('completionTokens' in records[2]).toBe(false);
      expect('chunkMessages' in records[2]).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shadow record carries transcript path and message ids, omits them when absent, never chunk text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-gate-ref-'));
    const logPath = path.join(dir, 'shadow.jsonl');
    const fetchImpl = (async () =>
      new Response('{}', { status: 500 })) as unknown as typeof fetch;
    try {
      const options = {
        groupFolder: 'g',
        runId: 'r',
        shadowLogPath: logPath,
        fetchImpl,
      };
      await startReflectorGateScore(
        {
          text: 'SECRET-CHUNK-TEXT',
          index: 0,
          transcriptPath: 'transcripts/2026-01-01-chat-c1.output.jsonl',
          firstMessageId: 'm-first',
          lastMessageId: 'm-last',
        },
        options,
      ).finish(1);
      await startReflectorGateScore(
        { text: 'SECRET-CHUNK-TEXT', index: 1 },
        options,
      ).finish(1);
      await startReflectorGateScore(
        {
          text: 'SECRET-CHUNK-TEXT',
          index: 2,
          transcriptPath: '',
          firstMessageId: '',
        },
        options,
      ).finish(1);
      const raw = fs.readFileSync(logPath, 'utf8');
      expect(raw).not.toContain('SECRET-CHUNK-TEXT');
      const records = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records[0].transcriptPath).toBe(
        'transcripts/2026-01-01-chat-c1.output.jsonl',
      );
      expect(records[0].firstMessageId).toBe('m-first');
      expect(records[0].lastMessageId).toBe('m-last');
      for (const record of records.slice(1)) {
        expect('transcriptPath' in record).toBe(false);
        expect('firstMessageId' in record).toBe(false);
        expect('lastMessageId' in record).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('successful chunk without usage keeps model, duration and chunk size but omits token fields', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-gate-usage-'));
    const logPath = path.join(dir, 'shadow.jsonl');
    const fetchImpl = (async () =>
      new Response('{}', { status: 500 })) as unknown as typeof fetch;
    try {
      await startReflectorGateScore(
        { text: 'a', index: 0 },
        { groupFolder: 'g', runId: 'r', shadowLogPath: logPath, fetchImpl },
      ).finish(1, undefined, 'direct/test-model', {
        llmDurationMs: 321,
        promptTokens: undefined,
        completionTokens: undefined,
        chunkMessages: 4,
      });
      const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
      expect('failureReason' in record).toBe(false);
      expect(record.operationCount).toBe(1);
      expect(record.model).toBe('direct/test-model');
      expect(record.llmDurationMs).toBe(321);
      expect(record.chunkMessages).toBe(4);
      expect('promptTokens' in record).toBe(false);
      expect('completionTokens' in record).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('automatic transcript reflection of a deleted transcript', () => {
  const missing = path.join(
    os.tmpdir(),
    'carapa-missing-transcript-group',
    'transcripts',
    'missing-chat-conv-1.output.jsonl',
  );

  test('drops the job (null) when the transcript no longer exists', async () => {
    expect(fs.existsSync(missing)).toBe(false);
    await expect(
      processAutomaticTranscriptMemory(
        'carapa-missing-transcript-group',
        missing,
      ),
    ).resolves.toBeNull();
  });

  test('rethrows ENOENT while the transcript exists', async () => {
    const exists = spyOn(fs, 'existsSync').mockReturnValue(true);
    try {
      await expect(
        processAutomaticTranscriptMemory(
          'carapa-missing-transcript-group',
          missing,
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      exists.mockRestore();
    }
  });
});

describe('tool-driven reflector execution contract', () => {
  test('automatic reflection succeeds when the configured main project is absent', () => {
    const dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-tool-reflector-project-boundary-'),
    );
    const script = String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';

      const root = process.cwd();
      const project = 'reflector-source-without-main';
      const objective = 'reflector-source-objective';
      const messageId = 'source-message';
      const content =
        'The deployment process uses a signed release manifest for every production rollout. ' +
        'This decision is durable and was explicitly confirmed for the project. ' +
        'Operators verify that manifest before promotion, making the release requirement useful for future implementation and incident work.';
      let requestCount = 0;
      let legacyRequestCount = 0;
      const requestPrompts = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = await request.json();
          const serializedMessages = JSON.stringify(
            body.messages ?? body.input ?? [],
          );
          if (serializedMessages.includes('stage 2 of Carapa memory')) {
            legacyRequestCount++;
            return new Response(
              'data: ' + JSON.stringify({
                choices: [{ delta: { content: JSON.stringify({ memory_ops: [], rule_ops: [] }) } }],
              }) + '\n\n' +
                'data: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          requestPrompts.push(serializedMessages);
          const index = requestCount++;
          const delta =
            index === 0
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'memorize-source-fact',
                      function: {
                        name: 'memorize',
                        arguments: JSON.stringify({
                          operation: 'create',
                          content,
                          memory_type: 'decision',
                          validFrom: '2025-02-01T10:00:00.000Z',
                          operation_key: 'source-deployment-decision',
                          evidence: [
                            {
                              message_id: messageId,
                              excerpt: 'uses a signed release manifest',
                            },
                          ],
                        }),
                      },
                    },
                  ],
                }
              : { content: 'REFLECTION_COMPLETE' };
          return new Response(
            'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n' +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });

      try {
        const configDir = path.join(process.env.CARAPA_DATA_DIR, 'data');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
          path.join(configDir, 'board_agents.jsonc'),
          JSON.stringify({
            version: 2,
            connections: {
              probe: { baseUrl: 'http://127.0.0.1:' + server.port + '/v1' },
            },
            harnesses: { direct: { label: 'Direct', kind: 'direct' } },
            models: {
              probe: {
                label: 'Probe',
                bindings: { direct: { connection: 'probe' } },
              },
            },
            defaults: {
              chat: { harnessId: 'direct', modelId: 'probe' },
              kanban: {
                fallback: { harnessId: 'direct', modelId: 'probe' },
                stages: {},
              },
              reflector: { harnessId: 'direct', modelId: 'probe' },
            },
          }),
        );

        const db = await import(root + '/src/db.ts');
        const drizzle = await import(root + '/src/db/drizzle-client.ts');
        const schema = await import(root + '/src/db/schema.ts');
        const runtime = await import(root + '/src/lib/chat-agents.ts');
        const groupDir = await import(root + '/src/group-dir.ts');
        const state = await import(root + '/src/state-manager.ts');
        const reflector = await import(
          root + '/src/modules/memory/tool-reflector.ts'
        );
        const { automaticTranscriptReflectionQueue: reflectionQueue } =
          await import(
            root + '/src/modules/memory/automatic-reflection-queue.ts'
          );
        runtime.reloadChatAgents();
        await db.initDatabase(':memory:');
        await drizzle.drizzleDbRef.current.insert(schema.projects).values({
          id: project,
          jid: project + '@test',
          name: 'Source without main',
          folder: project,
          trigger: '!',
          added_at: '2025-01-01T00:00:00.000Z',
          is_main: 0,
        });
        await drizzle.drizzleDbRef.current.insert(schema.objectives).values({
          id: objective,
          project_id: project,
          title: 'Release objective',
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-01T00:00:00.000Z',
        });
        await state.loadState();
        const transcriptPath = groupDir.chatTranscriptPath(
          project,
          undefined,
          'automatic-reflection',
        );
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        fs.writeFileSync(
          transcriptPath,
          JSON.stringify({
            type: 'message',
            id: messageId,
            role: 'user',
            content,
            created_at: '2025-02-01T10:00:00.000Z',
          }) + '\n',
        );
        const workspaceRoot = path.join(process.env.CARAPA_DATA_DIR, 'accessible-workspace');
        const legacyJournal = path.join(
          workspaceRoot,
          '.agent',
          'reflections',
          'observations.md',
        );
        fs.mkdirSync(path.dirname(legacyJournal), { recursive: true });
        fs.writeFileSync(
          legacyJournal,
          '# Observations\n- [decision] Legacy releases use signed manifests\n',
        );

        const result = await reflector.processTranscriptMemory(
          project,
          transcriptPath,
          {
            workspaceRoot,
            objectiveId: objective,
            conversationId: 'release-conversation',
          },
        );
        assert.equal(result.completed, true);
        assert.equal(result.operationCount, 1);
        assert.equal(legacyRequestCount, 0);
        assert.equal(fs.readFileSync(legacyJournal, 'utf8'), '# Observations\n- [decision] Legacy releases use signed manifests\n');
        assert.equal(fs.existsSync(legacyJournal + '.bak'), false);
        assert.equal(requestCount, 2);
        const memories = await db.searchMemories({
          groupFolders: [project],
          objective_id: objective,
          skipTouch: true,
        });
        assert.equal(memories.length, 1);
        assert.equal(memories[0].content, content);
        assert.equal(memories[0].objective_id, objective);

        // Simulate a restart after an earlier scheduled range failed: only the
        // durable run remains, then a later transcript range triggers work.
        const baseEnd = fs.statSync(transcriptPath).size;
        const earlierContent =
          'Earlier failed range requires an attestation before deployment. '.repeat(10);
        const laterContent =
          'Later range records a separate release note after deployment. '.repeat(10);
        const line = (id, text, createdAt) =>
          JSON.stringify({
            type: 'message',
            id,
            role: 'user',
            content: text,
            created_at: createdAt,
          }) + '\n';
        fs.appendFileSync(
          transcriptPath,
          line('earlier-failed-message', earlierContent, '2025-02-02T10:00:00.000Z'),
        );
        const earlierEnd = fs.statSync(transcriptPath).size;
        fs.appendFileSync(
          transcriptPath,
          line('later-message', laterContent, '2025-02-03T10:00:00.000Z'),
        );
        const totalEnd = fs.statSync(transcriptPath).size;
        const bytes = fs.readFileSync(transcriptPath);
        const crypto = await import('node:crypto');
        const stateModule = await import(
          root + '/src/modules/memory/reflector-state.ts'
        );
        const transcriptRef = path
          .relative(groupDir.getGroupDir(project), transcriptPath)
          .split(path.sep)
          .join('/');
        const failedFingerprint =
          earlierEnd + ':' +
          crypto.createHash('sha256').update(bytes.subarray(0, earlierEnd)).digest('hex');
        const failedRunId = stateModule.reflectorRunId({
          projectId: project,
          transcriptPath: transcriptRef,
          transcriptFingerprint: failedFingerprint,
          byteOffset: baseEnd,
          profile: 'run-agent-conversation',
          mode: 'live',
        });
        await stateModule.ensureReflectorRun({
          id: failedRunId,
          projectId: project,
          transcriptPath: transcriptRef,
          transcriptFingerprint: failedFingerprint,
          byteOffset: baseEnd,
          profile: 'run-agent-conversation',
          mode: 'live',
          totalChunks: 1,
          originScopeKnown: 1,
          originObjectiveId: null,
          originConversationId: 'earlier-conversation',
        });
        await stateModule.claimReflectorRun(failedRunId, 'previous-process');
        await stateModule.failReflectorRun(
          failedRunId,
          'previous-process',
          'provider unavailable before restart',
        );

        const laterAdmission = await reflector.admitTranscriptMemory(
          project,
          transcriptPath,
          {
            byteOffset: earlierEnd,
            byteEndOffset: totalEnd,
            objectiveId: objective,
            conversationId: 'later-conversation',
          },
        );
        assert.ok(laterAdmission);
        const recovered = await reflector.runToolDrivenReflector(
          project,
          transcriptPath,
          {
            byteOffset: laterAdmission.byteOffset,
            byteEndOffset: laterAdmission.byteEndOffset,
            admittedRunId: laterAdmission.runId,
            objectiveId: objective,
            conversationId: 'later-conversation',
          },
        );
        assert.equal(recovered.completed, true);
        assert.equal(requestCount, 4);
        assert.match(requestPrompts.at(-2), /Earlier failed range/);
        assert.doesNotMatch(requestPrompts.at(-2), /Later range records/);
        assert.match(requestPrompts.at(-2), /earlier-conversation/);
        assert.match(requestPrompts.at(-2), /objective_id=\\\"project-wide\\\"/);
        assert.match(requestPrompts.at(-1), /Later range records/);
        assert.match(requestPrompts.at(-1), /later-conversation/);
        assert.match(requestPrompts.at(-1), /reflector-source-objective/);

        // Admission is durable before the idle delay. Boot recovery processes
        // even a short privacy request without requiring another append.
        const privacyOffset = fs.statSync(transcriptPath).size;
        fs.appendFileSync(
          transcriptPath,
          line('privacy-message', 'Forget my private phone number.', '2025-02-04T10:00:00.000Z'),
        );
        const privacyEnd = fs.statSync(transcriptPath).size;
        const privacyAdmission = await reflector.admitTranscriptMemory(
          project,
          transcriptPath,
          {
            byteOffset: privacyOffset,
            byteEndOffset: privacyEnd,
            objectiveId: null,
            conversationId: 'privacy-conversation',
            sandboxStack: 'origin-stack',
            sandboxService: 'origin-service',
            sandboxInstance: 'origin-instance',
            sandboxWorkspacePath: '/workspace/project/.worktrees/origin',
          },
        );
        assert.ok(privacyAdmission);
        const admittedRow = await stateModule.getReflectorRun(privacyAdmission.runId);
        assert.equal(admittedRow.status, 'pending');
        assert.equal(admittedRow.originScopeKnown, 1);
        assert.equal(admittedRow.originConversationId, 'privacy-conversation');
        assert.equal(admittedRow.sandboxWorkspacePath, '/workspace/project/.worktrees/origin');

        const beforeRecoveryRequests = requestCount;
        assert.equal(await reflector.recoverPendingTranscriptReflections(), 1);
        await reflectionQueue.whenIdle();
        assert.equal(requestCount, beforeRecoveryRequests + 1);
        assert.match(requestPrompts.at(-1), /Forget my private phone number/);
        assert.match(requestPrompts.at(-1), /objective_id=\\\"project-wide\\\"/);
        assert.equal(
          (await stateModule.getReflectorRun(privacyAdmission.runId)).status,
          'completed',
        );

        // Startup recovery observes an unexpired lease without stealing it,
        // then resumes the orphaned run as soon as that lease expires.
        const leasedOffset = fs.statSync(transcriptPath).size;
        fs.appendFileSync(
          transcriptPath,
          line('leased-message', 'Retain this restart recovery fact.', '2025-02-04T11:00:00.000Z'),
        );
        const leasedEnd = fs.statSync(transcriptPath).size;
        const leasedAdmission = await reflector.admitTranscriptMemory(
          project,
          transcriptPath,
          { byteOffset: leasedOffset, byteEndOffset: leasedEnd },
        );
        assert.ok(leasedAdmission);
        assert.ok(
          await stateModule.claimReflectorRun(
            leasedAdmission.runId,
            'previous-board-process',
            { leaseMs: 100 },
          ),
        );
        assert.equal(
          await stateModule.claimReflectorRun(
            leasedAdmission.runId,
            'concurrent-worker',
          ),
          undefined,
        );
        const postLeaseOffset = fs.statSync(transcriptPath).size;
        fs.appendFileSync(
          transcriptPath,
          line('post-lease-message', 'This fact must follow lease recovery.', '2025-02-04T11:01:00.000Z'),
        );
        const postLeaseEnd = fs.statSync(transcriptPath).size;
        const postLeaseAdmission = await reflector.admitTranscriptMemory(
          project,
          transcriptPath,
          { byteOffset: postLeaseOffset, byteEndOffset: postLeaseEnd },
        );
        assert.ok(postLeaseAdmission);
        const beforeLeaseRecoveryRequests = requestCount;
        assert.equal(await reflector.recoverPendingTranscriptReflections(), 2);
        assert.equal(requestCount, beforeLeaseRecoveryRequests);
        // The foreign lease is neither stolen nor enqueued as a doomed job.
        assert.equal(
          (await stateModule.getReflectorRun(leasedAdmission.runId)).leaseToken,
          'previous-board-process',
        );
        await reflectionQueue.whenIdle();
        assert.equal(requestCount, beforeLeaseRecoveryRequests + 2);
        assert.match(requestPrompts.at(-2), /Retain this restart recovery fact/);
        assert.doesNotMatch(requestPrompts.at(-2), /This fact must follow/);
        assert.match(requestPrompts.at(-1), /This fact must follow lease recovery/);
        assert.equal(
          (await stateModule.getReflectorRun(leasedAdmission.runId)).status,
          'completed',
        );
        assert.equal(
          (await stateModule.getReflectorRun(postLeaseAdmission.runId)).status,
          'completed',
        );

        // A later turn admitted before debounce widens the same durable range.
        const carryOffset = fs.statSync(transcriptPath).size;
        fs.appendFileSync(
          transcriptPath,
          line('carry-one', 'First short commitment.', '2025-02-05T10:00:00.000Z'),
        );
        const carryMiddle = fs.statSync(transcriptPath).size;
        const firstCarry = await reflector.admitTranscriptMemory(project, transcriptPath, {
          byteOffset: carryOffset,
          byteEndOffset: carryMiddle,
          objectiveId: null,
          conversationId: 'carry-conversation',
        });
        fs.appendFileSync(
          transcriptPath,
          line('carry-two', 'Second short commitment.', '2025-02-05T10:01:00.000Z'),
        );
        const carryEnd = fs.statSync(transcriptPath).size;
        const widenedCarry = await reflector.admitTranscriptMemory(project, transcriptPath, {
          byteOffset: carryMiddle,
          byteEndOffset: carryEnd,
          objectiveId: null,
          conversationId: 'carry-conversation',
        });
        assert.equal(widenedCarry.runId, firstCarry.runId);
        assert.equal(widenedCarry.byteOffset, carryOffset);
        const carried = await reflector.runToolDrivenReflector(project, transcriptPath, {
          byteOffset: widenedCarry.byteOffset,
          byteEndOffset: widenedCarry.byteEndOffset,
          objectiveId: null,
          conversationId: 'carry-conversation',
          admittedRunId: widenedCarry.runId,
        });
        assert.equal(carried.completed, true);
        assert.match(requestPrompts.at(-1), /First short commitment/);
        assert.match(requestPrompts.at(-1), /Second short commitment/);
        // Bookkeeping lines appended after a range's end leave a byte gap before
        // the next turn; an evidence-free gap still widens the pending run.
        const bookkeeping = () =>
          JSON.stringify({ type: 'turn_outcome', outcome: 'completed' }) + '\n' +
          JSON.stringify({
            type: 'message',
            id: 'attribution',
            role: 'assistant',
            content: '',
            ai_user_attribution: true,
          }) + '\n';
        const gapOffset = fs.statSync(transcriptPath).size;
        fs.appendFileSync(
          transcriptPath,
          line('gap-one', 'Gap claim: deploys run on Friday.', '2025-02-05T11:00:00.000Z'),
        );
        const gapMiddle = fs.statSync(transcriptPath).size;
        const gapFirst = await reflector.admitTranscriptMemory(project, transcriptPath, {
          byteOffset: gapOffset,
          byteEndOffset: gapMiddle,
          objectiveId: null,
          conversationId: 'gap-conversation',
        });
        fs.appendFileSync(transcriptPath, bookkeeping());
        const gapStart = fs.statSync(transcriptPath).size;
        assert.ok(gapStart > gapMiddle);
        fs.appendFileSync(
          transcriptPath,
          line('gap-two', 'Gap correction: deploys run on Monday.', '2025-02-05T11:03:00.000Z'),
        );
        const gapEnd = fs.statSync(transcriptPath).size;
        const gapWidened = await reflector.admitTranscriptMemory(project, transcriptPath, {
          byteOffset: gapStart,
          byteEndOffset: gapEnd,
          objectiveId: null,
          conversationId: 'gap-conversation',
        });
        assert.equal(gapWidened.runId, gapFirst.runId);
        assert.equal(gapWidened.byteOffset, gapOffset);
        assert.equal(gapWidened.byteEndOffset, gapEnd);
        const gapRun = await reflector.runToolDrivenReflector(project, transcriptPath, {
          byteOffset: gapWidened.byteOffset,
          byteEndOffset: gapWidened.byteEndOffset,
          objectiveId: null,
          conversationId: 'gap-conversation',
          admittedRunId: gapWidened.runId,
        });
        assert.equal(gapRun.completed, true);
        assert.match(requestPrompts.at(-1), /deploys run on Friday/);
        assert.match(requestPrompts.at(-1), /deploys run on Monday/);

        // A gap holding an evidence message keeps the ranges separate.
        const evidenceOffset = fs.statSync(transcriptPath).size;
        fs.appendFileSync(
          transcriptPath,
          line('evidence-one', 'Evidence first range note.', '2025-02-05T12:00:00.000Z'),
        );
        const evidenceMiddle = fs.statSync(transcriptPath).size;
        const evidenceFirst = await reflector.admitTranscriptMemory(project, transcriptPath, {
          byteOffset: evidenceOffset,
          byteEndOffset: evidenceMiddle,
          objectiveId: null,
          conversationId: 'evidence-gap-conversation',
        });
        fs.appendFileSync(
          transcriptPath,
          line('evidence-gap', 'Unadmitted message between the ranges.', '2025-02-05T12:01:00.000Z'),
        );
        const evidenceStart = fs.statSync(transcriptPath).size;
        fs.appendFileSync(
          transcriptPath,
          line('evidence-two', 'Evidence second range note.', '2025-02-05T12:02:00.000Z'),
        );
        const evidenceEnd = fs.statSync(transcriptPath).size;
        const evidenceSecond = await reflector.admitTranscriptMemory(project, transcriptPath, {
          byteOffset: evidenceStart,
          byteEndOffset: evidenceEnd,
          objectiveId: null,
          conversationId: 'evidence-gap-conversation',
        });
        assert.notEqual(evidenceSecond.runId, evidenceFirst.runId);
        assert.equal(evidenceSecond.byteOffset, evidenceStart);
        assert.equal(
          (await stateModule.getReflectorRun(evidenceFirst.runId)).status,
          'pending',
        );
        for (const admission of [evidenceFirst, evidenceSecond]) {
          const evidenceRun = await reflector.runToolDrivenReflector(project, transcriptPath, {
            byteOffset: admission.byteOffset,
            byteEndOffset: admission.byteEndOffset,
            objectiveId: null,
            conversationId: 'evidence-gap-conversation',
            admittedRunId: admission.runId,
          });
          assert.equal(evidenceRun.completed, true);
        }
        // A live run whose transcript vanished is retired once stale (>24h),
        // and left pending (and re-warned) while younger.
        const dbModule = await import(root + '/src/db/drizzle-client.ts');
        const schemaModule = await import(root + '/src/db/schema.ts');
        const orm = await import('drizzle-orm');
        const admitMissing = async (conversationId, ageMs) => {
          const missingPath = groupDir.chatTranscriptPath(
            project,
            undefined,
            conversationId,
          );
          fs.mkdirSync(path.dirname(missingPath), { recursive: true });
          fs.writeFileSync(
            missingPath,
            line(conversationId, 'Short note that will vanish.', '2025-02-06T10:00:00.000Z'),
          );
          const admission = await reflector.admitTranscriptMemory(project, missingPath, {
            byteOffset: 0,
            byteEndOffset: fs.statSync(missingPath).size,
            objectiveId: null,
            conversationId,
          });
          assert.ok(admission);
          fs.rmSync(missingPath);
          await dbModule.drizzleDbRef.current
            .update(schemaModule.memoryReflectorRuns)
            .set({ updatedAt: new Date(Date.now() - ageMs).toISOString() })
            .where(orm.eq(schemaModule.memoryReflectorRuns.id, admission.runId));
          return admission.runId;
        };
        const staleRunId = await admitMissing('stale-missing', 25 * 3600_000);
        const youngRunId = await admitMissing('young-missing', 3600_000);
        assert.equal(await reflector.recoverPendingTranscriptReflections(), 0);
        const retiredRow = await stateModule.getReflectorRun(staleRunId);
        assert.equal(retiredRow.status, 'retired');
        assert.ok(retiredRow.error.startsWith('source_unavailable:'));
        assert.equal((await stateModule.getReflectorRun(youngRunId)).status, 'pending');
        const retiredStamp = retiredRow.updatedAt;
        assert.equal(await reflector.recoverPendingTranscriptReflections(), 0);
        assert.equal(
          (await stateModule.getReflectorRun(staleRunId)).updatedAt,
          retiredStamp,
        );
        assert.equal((await stateModule.getReflectorRun(youngRunId)).status, 'pending');
        // A live run whose transcript bytes no longer match the admission
        // fingerprint follows the same age-based retirement.
        const admitChanged = async (conversationId, ageMs) => {
          const changedPath = groupDir.chatTranscriptPath(
            project,
            undefined,
            conversationId,
          );
          fs.mkdirSync(path.dirname(changedPath), { recursive: true });
          fs.writeFileSync(
            changedPath,
            line(conversationId, 'Short note that will be rewritten.', '2025-02-07T10:00:00.000Z'),
          );
          const admission = await reflector.admitTranscriptMemory(project, changedPath, {
            byteOffset: 0,
            byteEndOffset: fs.statSync(changedPath).size,
            objectiveId: null,
            conversationId,
          });
          assert.ok(admission);
          fs.writeFileSync(
            changedPath,
            line(conversationId, 'Different text replaced the original!', '2025-02-07T10:00:00.000Z') +
              line(conversationId + '-more', 'Appended after the rewrite.', '2025-02-07T10:01:00.000Z'),
          );
          await dbModule.drizzleDbRef.current
            .update(schemaModule.memoryReflectorRuns)
            .set({ updatedAt: new Date(Date.now() - ageMs).toISOString() })
            .where(orm.eq(schemaModule.memoryReflectorRuns.id, admission.runId));
          return admission.runId;
        };
        const staleChangedId = await admitChanged('stale-changed', 25 * 3600_000);
        const youngChangedId = await admitChanged('young-changed', 3600_000);
        assert.equal(await reflector.recoverPendingTranscriptReflections(), 0);
        const changedRow = await stateModule.getReflectorRun(staleChangedId);
        assert.equal(changedRow.status, 'retired');
        assert.ok(changedRow.error.startsWith('source_changed:'));
        assert.equal((await stateModule.getReflectorRun(youngChangedId)).status, 'pending');
        const changedStamp = changedRow.updatedAt;
        assert.equal(await reflector.recoverPendingTranscriptReflections(), 0);
        assert.equal(
          (await stateModule.getReflectorRun(staleChangedId)).updatedAt,
          changedStamp,
        );
        assert.equal((await stateModule.getReflectorRun(youngChangedId)).status, 'pending');
        // A queued job keeps the end it was admitted with, but a later turn may
        // widen the pending run under the same id. The helper re-reads the run
        // when the job runs. On the base commit the equivalent old call
        // (processAutomaticTranscriptMemory with A's frozen end and
        // admittedRunId) throws "Durable reflector admission transcript changed".
        const staleOffset = fs.statSync(transcriptPath).size;
        fs.appendFileSync(
          transcriptPath,
          line('stale-a', 'Stale job claim: backups run nightly.', '2025-02-08T10:00:00.000Z'),
        );
        const staleMiddle = fs.statSync(transcriptPath).size;
        const staleA = await reflector.admitTranscriptMemory(project, transcriptPath, {
          byteOffset: staleOffset,
          byteEndOffset: staleMiddle,
          objectiveId: null,
          conversationId: 'stale-job-conversation',
        });
        fs.appendFileSync(
          transcriptPath,
          line('stale-b', 'Stale job correction: backups run hourly.', '2025-02-08T10:01:00.000Z'),
        );
        const staleB = await reflector.admitTranscriptMemory(project, transcriptPath, {
          byteOffset: staleMiddle,
          byteEndOffset: fs.statSync(transcriptPath).size,
          objectiveId: null,
          conversationId: 'stale-job-conversation',
        });
        assert.equal(staleB.runId, staleA.runId);
        const staleRequests = requestCount;
        const staleResult = await reflector.processAdmittedAutomaticTranscriptMemory(
          project,
          transcriptPath,
          staleA.runId,
        );
        assert.equal(staleResult.completed, true);
        assert.equal(requestCount, staleRequests + 1);
        assert.match(requestPrompts.at(-1), /backups run nightly/);
        assert.match(requestPrompts.at(-1), /backups run hourly/);
        assert.equal((await stateModule.getReflectorRun(staleA.runId)).status, 'completed');
        assert.equal(
          await reflector.processAdmittedAutomaticTranscriptMemory(
            project,
            transcriptPath,
            staleB.runId,
          ),
          null,
        );
        assert.equal(requestCount, staleRequests + 1);

        // A run whose admitted prefix is gone from the transcript is retired
        // instead of failing on every retry.
        const rewrittenPath = groupDir.chatTranscriptPath(
          project,
          undefined,
          'rewritten-job',
        );
        fs.mkdirSync(path.dirname(rewrittenPath), { recursive: true });
        fs.writeFileSync(
          rewrittenPath,
          line('rewritten-a', 'Short note that will be rewritten.', '2025-02-09T10:00:00.000Z'),
        );
        const rewritten = await reflector.admitTranscriptMemory(project, rewrittenPath, {
          byteOffset: 0,
          byteEndOffset: fs.statSync(rewrittenPath).size,
          objectiveId: null,
          conversationId: 'rewritten-job',
        });
        assert.ok(rewritten);
        fs.writeFileSync(
          rewrittenPath,
          line('rewritten-a', 'Different text replaced the original!', '2025-02-09T10:00:00.000Z') +
            line('rewritten-b', 'Appended after the rewrite.', '2025-02-09T10:01:00.000Z'),
        );
        const rewrittenRequests = requestCount;
        assert.equal(
          await reflector.processAdmittedAutomaticTranscriptMemory(
            project,
            rewrittenPath,
            rewritten.runId,
          ),
          null,
        );
        const rewrittenRow = await stateModule.getReflectorRun(rewritten.runId);
        assert.equal(rewrittenRow.status, 'retired');
        assert.ok(rewrittenRow.error.startsWith('source_changed:'));
        assert.equal(requestCount, rewrittenRequests);
        // The periodic sweep queues idle pending rows once, through the same
        // gates as startup recovery.
        const backgroundGate = await import(root + '/src/lib/background-work-gate.ts');
        const sweepRow = async (conversationId, text, ageMs, project_ = project) => {
          const sweepPath = groupDir.chatTranscriptPath(project_, undefined, conversationId);
          fs.mkdirSync(path.dirname(sweepPath), { recursive: true });
          fs.writeFileSync(sweepPath, line(conversationId, text, '2025-03-01T10:00:00.000Z'));
          const admission = await reflector.admitTranscriptMemory(project_, sweepPath, {
            byteOffset: 0,
            byteEndOffset: fs.statSync(sweepPath).size,
            objectiveId: null,
            conversationId,
          });
          assert.ok(admission);
          const backdate = (age) =>
            dbModule.drizzleDbRef.current
              .update(schemaModule.memoryReflectorRuns)
              .set({ updatedAt: new Date(Date.now() - age).toISOString() })
              .where(orm.eq(schemaModule.memoryReflectorRuns.id, admission.runId));
          await backdate(ageMs);
          return { runId: admission.runId, sweepPath, backdate };
        };
        const sweepMinAge = 10 * 60_000;
        const idle = await sweepRow('sweep-idle', 'Sweep fixture: exports use the archive bucket.', sweepMinAge + 60_000);
        const fresh = await sweepRow('sweep-fresh', 'Sweep fixture: a chat still active.', 60_000);
        const beforeSweepRequests = requestCount;
        // (d) The fresh row is left to its own idle timer.
        assert.equal(await reflector.sweepPendingTranscriptReflections(), 1);
        await reflectionQueue.whenIdle();
        assert.equal(requestCount, beforeSweepRequests + 1);
        assert.match(requestPrompts.at(-1), /exports use the archive bucket/);
        assert.equal((await stateModule.getReflectorRun(idle.runId)).status, 'completed');
        assert.equal((await stateModule.getReflectorRun(fresh.runId)).status, 'pending');
        // (c) A completed row and the fresh row are not queued by a second sweep.
        await idle.backdate(sweepMinAge + 60_000);
        assert.equal(await reflector.sweepPendingTranscriptReflections(), 0);
        await reflectionQueue.whenIdle();
        assert.equal(requestCount, beforeSweepRequests + 1);
        assert.equal(await reflector.sweepPendingTranscriptReflections({ minAgeMs: 0 }), 1);
        await reflectionQueue.whenIdle();
        assert.equal(requestCount, beforeSweepRequests + 2);

        // (a) A row this process already holds in its queue is not queued twice.
        const held = await sweepRow('sweep-held', 'Sweep fixture: held rows run once.', sweepMinAge + 60_000);
        backgroundGate.pauseBackgroundWork('sweep-test');
        try {
          assert.equal(await reflector.recoverPendingTranscriptReflections(), 1);
          assert.equal(await reflector.sweepPendingTranscriptReflections(), 0);
        } finally {
          backgroundGate.resumeBackgroundWork();
        }
        await reflectionQueue.whenIdle();
        assert.equal(requestCount, beforeSweepRequests + 3);
        assert.equal((await stateModule.getReflectorRun(held.runId)).status, 'completed');

        // (b) A row claimed by another worker is never queued by the sweep.
        const claimed = await sweepRow('sweep-claimed', 'Sweep fixture: claimed rows stay put.', 0);
        assert.ok(
          await stateModule.claimReflectorRun(claimed.runId, 'other-process', { leaseMs: 60_000 }),
        );
        await claimed.backdate(sweepMinAge + 60_000);
        assert.equal(await reflector.sweepPendingTranscriptReflections(), 0);
        await reflectionQueue.whenIdle();
        assert.equal(requestCount, beforeSweepRequests + 3);
        assert.equal((await stateModule.getReflectorRun(claimed.runId)).status, 'processing');

        // Refusal: a row pointing outside its project's group directory is not
        // read or reflected, and a project with observations disabled makes no
        // model request.
        const otherProject = 'reflector-sweep-other';
        const disabledProject = 'reflector-sweep-disabled';
        for (const id of [otherProject, disabledProject]) {
          await drizzle.drizzleDbRef.current.insert(schema.projects).values({
            id,
            jid: id + '@test',
            name: id,
            folder: id,
            trigger: '!',
            added_at: '2025-01-01T00:00:00.000Z',
            is_main: 0,
          });
        }
        await state.loadState();
        const foreign = await sweepRow('sweep-foreign', 'Sweep fixture: foreign transcript.', 0, otherProject);
        const escaping = await sweepRow('sweep-escape', 'Sweep fixture: escaping row.', 0);
        await dbModule.drizzleDbRef.current
          .update(schemaModule.memoryReflectorRuns)
          .set({
            transcriptPath: path.relative(groupDir.getGroupDir(project), foreign.sweepPath)
              .split(path.sep)
              .join('/'),
          })
          .where(orm.eq(schemaModule.memoryReflectorRuns.id, escaping.runId));
        await escaping.backdate(sweepMinAge + 60_000);
        await foreign.backdate(60_000);
        const escapingRow = await stateModule.getReflectorRun(escaping.runId);
        assert.ok(escapingRow.transcriptPath.startsWith('../'));
        assert.equal(await reflector.sweepPendingTranscriptReflections(), 0);
        await reflectionQueue.whenIdle();
        assert.equal(requestCount, beforeSweepRequests + 3);
        assert.equal((await stateModule.getReflectorRun(escaping.runId)).status, 'pending');

        const disabled = await sweepRow(
          'sweep-disabled',
          'Sweep fixture: disabled project.',
          sweepMinAge + 60_000,
          disabledProject,
        );
        await drizzle.drizzleDbRef.current
          .update(schema.projects)
          .set({ settings: JSON.stringify({ disableObservations: true }) })
          .where(orm.eq(schema.projects.id, disabledProject));
        await state.loadState();
        await reflector.sweepPendingTranscriptReflections();
        await reflectionQueue.whenIdle();
        assert.equal(requestCount, beforeSweepRequests + 3);
        assert.equal((await stateModule.getReflectorRun(disabled.runId)).status, 'pending');
        console.log('TOOL_REFLECTOR_PROJECT_BOUNDARY_OK');
      } finally {
        server.stop(true);
      }
      process.exit(0);
    `;

    try {
      const result = spawnSync(
        process.execPath,
        ['--no-env-file', '-e', script],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            CARAPA_DATA_DIR: dataRoot,
            DATABASE_URL: '',
            DB_HOST: '',
            DB_PASSWORD: '',
            POSTGRES_PASSWORD: '',
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
          },
          encoding: 'utf8',
          timeout: 90_000,
        },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || String(result.error));
      }
      expect(result.stdout).toContain('TOOL_REFLECTOR_PROJECT_BOUNDARY_OK');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 100_000);

  test('reflector chunks come from the contained read, not a swapped-in symlink', () => {
    const dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-tool-reflector-swap-'),
    );
    const script = String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';

      const root = process.cwd();
      const attacker = 'swap-attacker';
      const victim = 'swap-victim';
      const line = (id, text) =>
        JSON.stringify({
          type: 'message',
          id,
          role: 'user',
          content: text,
          created_at: '2025-02-01T10:00:00.000Z',
        }) + '\n';

      const db = await import(root + '/src/db.ts');
      const drizzle = await import(root + '/src/db/drizzle-client.ts');
      const schema = await import(root + '/src/db/schema.ts');
      const groupDir = await import(root + '/src/group-dir.ts');
      const state = await import(root + '/src/state-manager.ts');
      const reflector = await import(root + '/src/modules/memory/tool-reflector.ts');
      const reflectorState = await import(root + '/src/modules/memory/reflector-state.ts');
      await db.initDatabase(':memory:');
      for (const id of [attacker, victim]) {
        await drizzle.drizzleDbRef.current.insert(schema.projects).values({
          id,
          jid: id + '@test',
          name: id,
          folder: id,
          trigger: '!',
          added_at: '2025-01-01T00:00:00.000Z',
          is_main: 0,
        });
      }
      await state.loadState();

      const own = groupDir.chatTranscriptPath(attacker, undefined, 'swap-conv');
      const foreign = groupDir.chatTranscriptPath(victim, undefined, 'swap-conv');
      fs.mkdirSync(path.dirname(own), { recursive: true });
      fs.mkdirSync(path.dirname(foreign), { recursive: true });
      // Long enough that the sibling's messages fall inside the admitted range.
      fs.writeFileSync(own, line('own-1', 'Own project note. ' + 'x'.repeat(600)));
      fs.writeFileSync(
        foreign,
        line('v-1', 'SIBLING-SECRET one') +
          line('v-2', 'SIBLING-SECRET two') +
          line('v-3', 'SIBLING-SECRET three'),
      );

      // Swap the transcript for a symlink to the sibling project's transcript
      // at the first database access after the contained read.
      let swapped = false;
      let armed = false;
      const realDb = drizzle.drizzleDbRef.current;
      drizzle.drizzleDbRef.current = new Proxy(realDb, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (armed && typeof value === 'function') {
            armed = false;
            swapped = true;
            fs.rmSync(own);
            fs.symlinkSync(path.relative(path.dirname(own), foreign), own);
          }
          return value;
        },
      });

      armed = true;
      const admission = await reflector.admitTranscriptMemory(attacker, own, {
        byteOffset: 0,
        maxTokensPerChunk: 1,
        conversationId: 'swap-conv',
      });
      armed = false;
      assert.equal(swapped, true);
      assert.ok(admission);
      // One chunk per message: the attacker's own file has one, the sibling three.
      const run = await reflectorState.getReflectorRun(admission.runId);
      assert.equal(run.totalChunks, 1);

      // A transcript that is a symlink from the start is skipped outright.
      assert.equal(
        await reflector.admitTranscriptMemory(attacker, own, {
          byteOffset: 0,
          conversationId: 'swap-conv',
        }),
        null,
      );
      console.log('TOOL_REFLECTOR_SWAP_OK');
      process.exit(0);
    `;

    try {
      const result = spawnSync(
        process.execPath,
        ['--no-env-file', '-e', script],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            CARAPA_DATA_DIR: dataRoot,
            DATABASE_URL: '',
            DB_HOST: '',
            DB_PASSWORD: '',
            POSTGRES_PASSWORD: '',
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
          },
          encoding: 'utf8',
          timeout: 90_000,
        },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || String(result.error));
      }
      expect(result.stdout).toContain('TOOL_REFLECTOR_SWAP_OK');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 100_000);

  test('enforces disabled toolsets and retains timeout progress at the reflector boundary', () => {
    const dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-tool-reflector-capability-boundary-'),
    );
    const script = String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';

      const root = process.cwd();
      const disabledProject = 'reflector-disabled-tools';
      const timeoutProject = 'reflector-timeout';
      const requestCounts = new Map();
      const advertised = new Map();
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = await request.json();
          const serialized = JSON.stringify(body.messages ?? body.input ?? []);
          const project = serialized.includes(disabledProject)
            ? disabledProject
            : timeoutProject;
          const count = requestCounts.get(project) ?? 0;
          requestCounts.set(project, count + 1);
          if (count === 0) {
            advertised.set(
              project,
              (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name),
            );
          }
          const delta =
            count === 0
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: project + '-recall',
                      function: {
                        name: 'recall',
                        arguments: JSON.stringify({ query: 'deployment' }),
                      },
                    },
                  ],
                }
              : { content: 'REFLECTION_COMPLETE' };
          return new Response(
            'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n' +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });

      function writeTranscript(groupDir, project) {
        const transcriptPath = groupDir.chatTranscriptPath(
          project,
          undefined,
          'automatic-reflection',
        );
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        fs.writeFileSync(
          transcriptPath,
          JSON.stringify({
            type: 'message',
            id: project + '-message',
            role: 'user',
            content:
              'The deployment process requires a signed manifest for every production rollout. '.repeat(12),
            created_at: '2025-02-01T10:00:00.000Z',
          }) + '\n',
        );
        return transcriptPath;
      }

      try {
        const configDir = path.join(process.env.CARAPA_DATA_DIR, 'data');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
          path.join(configDir, 'board_agents.jsonc'),
          JSON.stringify({
            version: 2,
            connections: {
              probe: { baseUrl: 'http://127.0.0.1:' + server.port + '/v1' },
            },
            harnesses: { direct: { label: 'Direct', kind: 'direct' } },
            models: {
              probe: {
                label: 'Probe',
                bindings: { direct: { connection: 'probe' } },
              },
            },
            defaults: {
              chat: { harnessId: 'direct', modelId: 'probe' },
              kanban: {
                fallback: { harnessId: 'direct', modelId: 'probe' },
                stages: {},
              },
              reflector: { harnessId: 'direct', modelId: 'probe' },
            },
          }),
        );

        const db = await import(root + '/src/db.ts');
        const drizzle = await import(root + '/src/db/drizzle-client.ts');
        const schema = await import(root + '/src/db/schema.ts');
        const runtime = await import(root + '/src/lib/chat-agents.ts');
        const groupDir = await import(root + '/src/group-dir.ts');
        const state = await import(root + '/src/state-manager.ts');
        const vectorHooks = await import(
          root + '/src/modules/vector-store/hooks.ts'
        );
        const reflector = await import(
          root + '/src/modules/memory/tool-reflector.ts'
        );
        runtime.reloadChatAgents();
        await db.initDatabase(':memory:');
        await drizzle.drizzleDbRef.current.insert(schema.projects).values([
          {
            id: disabledProject,
            jid: disabledProject + '@test',
            name: 'Disabled reflector tools',
            folder: disabledProject,
            trigger: '!',
            added_at: '2025-01-01T00:00:00.000Z',
            settings: JSON.stringify({ disabledToolsets: ['fs', 'memory'] }),
            is_main: 0,
          },
          {
            id: timeoutProject,
            jid: timeoutProject + '@test',
            name: 'Timeout reflector tools',
            folder: timeoutProject,
            trigger: '!',
            added_at: '2025-01-01T00:00:00.000Z',
            is_main: 0,
          },
        ]);
        await state.loadState();
        vectorHooks.setVectorStoreHooks({
          embedAndStore: async () => {},
          enhanceRecall: async () => await new Promise(() => {}),
          eraseMemory: async () => {},
          invalidateMemory: async () => {},
          eraseGraphFactsMatchingTarget: async () => {},
          upsertEntity: () => {},
          upsertRelation: async () => {},
          expandEntities: async () => null,
          isAvailable: () => true,
          isVectorOnlyRecall: () => false,
          minScore: () => 0.5,
        });

        const disabledResult = await reflector.processTranscriptMemory(
          disabledProject,
          writeTranscript(groupDir, disabledProject),
        );
        const disabledTools = advertised.get(disabledProject) ?? [];
        assert.equal(disabledResult.completed, false);
        assert.equal(disabledResult.processedChunks, 0);
        assert.equal(
          disabledTools.some((name) =>
            ['recall', 'memorize', 'forget', 'ripgrep', 'read_file', 'peek_files'].includes(name),
          ),
          false,
        );

        const timeoutResult = await reflector.processTranscriptMemory(
          timeoutProject,
          writeTranscript(groupDir, timeoutProject),
        );
        assert.equal(advertised.get(timeoutProject).includes('recall'), true);
        assert.equal(timeoutResult.completed, false);
        assert.equal(timeoutResult.processedChunks, 0);
        assert.match(timeoutResult.error, /recall: Tool "recall" timed out after 15ms/);
        assert.ok(timeoutResult.error.includes(timeoutResult.runId));
        assert.match(timeoutResult.error, /chunk 1\//);
        assert.equal(requestCounts.get(timeoutProject), 2);
        console.log('TOOL_REFLECTOR_CAPABILITY_BOUNDARY_OK');
      } finally {
        server.stop(true);
      }
      process.exit(0);
    `;

    try {
      const result = spawnSync(
        process.execPath,
        ['--no-env-file', '-e', script],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            CARAPA_DATA_DIR: dataRoot,
            DATABASE_URL: '',
            DB_HOST: '',
            DB_PASSWORD: '',
            POSTGRES_PASSWORD: '',
            MEMORY_REFLECTOR_COMPARISON_ACCEPTED: 'true',
            NODE_ENV: 'test',
            MCP_TOOL_TIMEOUT_MS: '15',
            LOG_LEVEL: 'warn',
          },
          encoding: 'utf8',
          timeout: 90_000,
        },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || String(result.error));
      }
      expect(result.stdout).toContain('TOOL_REFLECTOR_CAPABILITY_BOUNDARY_OK');
      // The warn log for the failed chunk carries the category.
      expect(
        (result.stdout + result.stderr).replace(/\u001B\[[0-9;]*m/g, ''),
      ).toContain('failureReason: "tool_error:recall:other"');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 100_000);
});

describe('tool reflector prompt', () => {
  test('keeps the size, ended-state and completion rules', () => {
    const prompt = fs.readFileSync(
      path.join(process.cwd(), 'prompts', 'tool-reflector.md'),
      'utf8',
    );
    expect(prompt).toContain('about 300 characters');
    expect(prompt).toContain('A memory must still be true next month');
    expect(prompt).toContain('Never store status or counters');
    expect(prompt).toContain('`REFLECTION_COMPLETE`');
    expect(prompt).toContain('Only a `role="user"` message can be the source');
    expect(prompt).toContain(
      "name that subject in the memory's first sentence",
    );
    expect(prompt).toContain('not the figures');
    expect(prompt).toContain("Do not store the user's name or identity");
  });
});
