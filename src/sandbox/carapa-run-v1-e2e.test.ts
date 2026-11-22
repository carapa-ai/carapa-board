import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';

import {
  carapaRunV1Paths,
  projectCarapaRunV1Entries,
  readCarapaRunV1Pair,
  summarizeCarapaRunV1,
} from '../modules/transcripts/carapa-run-v1.js';
import { formatTranscriptEntries } from '../modules/transcripts/transcript-store.js';
import { initializeTranscriptSpoolSync } from '../modules/transcripts/transcript-append-service.js';
import { canonicalizeRunResult, cleanupRunDir, waitForRun } from './process.js';

// waitForRun pins run dirs below DATA_DIR/ipc, so fixtures must live there.
const ipcTmp = (prefix: string) => {
  fs.mkdirSync(path.join(DATA_DIR, 'ipc'), { recursive: true });
  return path.join(DATA_DIR, 'ipc', prefix);
};

describe('Carapa Run V1 vertical slice', () => {
  test('uses OpenCode V1 for native JSONL output and completion telemetry', async () => {
    const root = fs.mkdtempSync(ipcTmp('carapa-opencode-v1-e2e-'));
    const runDir = path.join(root, 'run-opencode-v1');
    const transcript = path.join(root, 'conversation.output.jsonl');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({ agentCmd: 'opencode', model: 'opencode/test' }),
    );
    fs.writeFileSync(
      path.join(runDir, 'output.jsonl'),
      '{"type":"step_start"}\n',
    );
    fs.writeFileSync(
      path.join(runDir, 'output.v1.meta.json'),
      `${JSON.stringify({ format: 'carapa-run', version: 1, harness: 'opencode', requestedModel: 'opencode/test' })}\n`,
    );
    fs.writeFileSync(
      path.join(runDir, 'output.v1.jsonl'),
      [
        { type: 'session', id: 'opencode-session-1', status: 'started' },
        { type: 'run', status: 'started', model: 'opencode/test' },
        {
          type: 'message_delta',
          id: 'opencode-message-1',
          role: 'assistant',
          delta: 'OpenCode answer',
        },
        {
          type: 'message',
          id: 'opencode-message-1',
          role: 'assistant',
          content: 'OpenCode answer',
          status: 'completed',
        },
        {
          type: 'tool_call',
          id: 'opencode-tool-1',
          status: 'completed',
          name: 'bash',
          category: 'execute',
          output: 'ok',
        },
        {
          type: 'usage',
          scope: 'incremental',
          inputTokens: 8,
          outputTokens: 2,
        },
        { type: 'run', status: 'completed', stopReason: 'stop' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    );
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0');
    try {
      const result = await waitForRun(runDir, 10_000);
      expect(result.isError).toBe(false);
      expect(
        summarizeCarapaRunV1(
          readCarapaRunV1Pair(carapaRunV1Paths(runDir), {
            expectedHarness: 'opencode',
            requireTerminal: true,
          })!,
        ),
      ).toMatchObject({
        result: 'OpenCode answer',
        session_id: 'opencode-session-1',
        total_tokens: 10,
        tool_usage_count: 1,
      });
      expect(canonicalizeRunResult(null, runDir).result).toBe(
        'OpenCode answer',
      );
      await cleanupRunDir(
        runDir,
        transcript,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        'opencode',
        undefined,
        undefined,
        false,
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses OMP V1 for live output, durable tool projection, and completion telemetry', async () => {
    const root = fs.mkdtempSync(ipcTmp('carapa-omp-v1-e2e-'));
    const runDir = path.join(root, 'run-omp-v1');
    const transcript = path.join(root, 'conversation.output.jsonl');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({ agentCmd: 'omp-acp', model: 'requested-omp-model' }),
    );
    fs.writeFileSync(path.join(runDir, 'output.jsonl'), 'legacy\n');
    fs.writeFileSync(
      path.join(runDir, 'output.v1.meta.json'),
      `${JSON.stringify({ format: 'carapa-run', version: 1, harness: 'omp-acp', requestedModel: 'requested-omp-model' })}\n`,
    );
    fs.writeFileSync(
      path.join(runDir, 'output.v1.jsonl'),
      [
        { type: 'session', id: 'omp-session-1', status: 'started' },
        { type: 'run', status: 'started', model: 'requested-omp-model' },
        {
          type: 'message_delta',
          id: 'omp-message-1',
          role: 'assistant',
          delta: 'OMP answer',
        },
        {
          type: 'message',
          id: 'omp-message-1',
          role: 'assistant',
          content: 'OMP answer',
          status: 'completed',
        },
        {
          type: 'tool_call',
          id: 'omp-tool-1',
          status: 'started',
          name: 'bash',
          category: 'execute',
          input: { command: 'true' },
        },
        {
          type: 'tool_call',
          id: 'omp-tool-1',
          status: 'completed',
          name: 'bash',
          category: 'execute',
          output: 'ok',
        },
        {
          type: 'usage',
          scope: 'incremental',
          inputTokens: 12,
          outputTokens: 4,
        },
        { type: 'run', status: 'completed', stopReason: 'stop' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    );
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0');
    try {
      const chunks: string[] = [];
      const result = await waitForRun(runDir, 10_000, (chunk) => {
        if (chunk.type === 'text') chunks.push(chunk.content);
      });
      expect(result.isError).toBe(false);
      expect(chunks.join('')).toContain('OMP answer');
      const document = readCarapaRunV1Pair(carapaRunV1Paths(runDir), {
        expectedHarness: 'omp-acp',
        requireTerminal: true,
      });
      expect(document).not.toBeNull();
      expect(summarizeCarapaRunV1(document!)).toMatchObject({
        result: 'OMP answer',
        session_id: 'omp-session-1',
        total_tokens: 16,
        tool_usage_count: 1,
        model_name: 'requested-omp-model',
      });
      const canonical = canonicalizeRunResult(null, runDir);
      expect(canonical.result).toBe('OMP answer');
      expect(canonical.model_name).toBe('requested-omp-model');
      await cleanupRunDir(
        runDir,
        transcript,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        'omp',
        undefined,
        undefined,
        false,
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses one Pi V1 pair for live output, durable replay, and completion telemetry', async () => {
    const requestedModel = 'freellmapi/auto';
    const effectiveModel = 'test-provider/effective-model';
    const root = fs.mkdtempSync(ipcTmp('carapa-pi-v1-e2e-'));
    const runDir = path.join(root, 'run-pi-v1');
    const transcript = path.join(root, 'conversation.output.jsonl');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({ agentCmd: 'pi', model: requestedModel }),
    );
    fs.writeFileSync(
      path.join(runDir, 'output.jsonl'),
      `${JSON.stringify({ type: 'agent_end', messages: [] })}\n`,
    );
    fs.writeFileSync(
      path.join(runDir, 'output.v1.meta.json'),
      `${JSON.stringify({
        format: 'carapa-run',
        version: 1,
        harness: 'pi',
        requestedModel,
      })}\n`,
    );
    const events = [
      { type: 'run', status: 'started', model: requestedModel },
      { type: 'session', id: 'pi-session-1', status: 'started' },
      {
        type: 'message_delta',
        id: 'message-1',
        role: 'assistant',
        delta: 'Before tool.',
      },
      {
        type: 'message',
        id: 'message-1',
        role: 'assistant',
        content: 'Before tool.',
        format: 'markdown',
        status: 'completed',
      },
      {
        type: 'run',
        status: 'in_progress',
        model: effectiveModel,
      },
      {
        type: 'tool_call',
        id: 'tool-1',
        status: 'started',
        name: 'bash',
        category: 'execute',
        input: { command: 'sleep 1' },
      },
      {
        type: 'tool_call',
        id: 'tool-1',
        status: 'completed',
        name: 'bash',
      },
      {
        type: 'message_delta',
        id: 'message-2',
        role: 'assistant',
        delta: 'After tool.',
      },
      {
        type: 'message',
        id: 'message-2',
        role: 'assistant',
        content: 'After tool.',
        format: 'markdown',
        status: 'completed',
      },
      {
        type: 'usage',
        scope: 'incremental',
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 5,
        reasoningOutputTokens: 3,
      },
      { type: 'run', status: 'completed', stopReason: 'stop' },
    ];
    fs.writeFileSync(
      path.join(runDir, 'output.v1.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0');

    try {
      const chunks: string[] = [];
      const sessions: string[] = [];
      const result = await waitForRun(runDir, 10_000, (chunk) => {
        if (chunk.type === 'text') chunks.push(chunk.content);
        if (chunk.type === 'session') sessions.push(chunk.session_id);
      });
      expect(result.isError).toBe(false);
      expect(sessions).toEqual(['pi-session-1']);

      const document = readCarapaRunV1Pair(carapaRunV1Paths(runDir), {
        expectedHarness: 'pi',
        requireTerminal: true,
      });
      expect(document).not.toBeNull();
      const projected = projectCarapaRunV1Entries(
        document!,
        {},
        initializeTranscriptSpoolSync(carapaRunV1Paths(runDir).events),
      );
      const projectedToolCalls = projected.filter(
        (entry) => entry.type === 'tool_call',
      );
      expect(projectedToolCalls).toHaveLength(2);
      expect(projectedToolCalls.map((entry) => entry.status)).toEqual([
        'started',
        'completed',
      ]);
      expect(projectedToolCalls[0].id).toBe(projectedToolCalls[1].id);
      expect(
        projected.some(
          (entry) =>
            entry.type === 'message' &&
            String(entry.content || '').includes('carapa-tool:'),
        ),
      ).toBe(false);
      const projectedDisplay = formatTranscriptEntries(projected) as Array<{
        content?: string;
      }>;
      expect(chunks.join('')).toBe(
        projectedDisplay.map((entry) => entry.content ?? '').join(''),
      );

      await cleanupRunDir(
        runDir,
        transcript,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        'pi',
        undefined,
        undefined,
        false,
        false,
      );
      const durableEntries = fs
        .readFileSync(transcript, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        durableEntries.filter((entry) => entry.type === 'tool_call'),
      ).toHaveLength(2);
      expect(
        durableEntries.some(
          (entry) =>
            entry.type === 'message' &&
            String(entry.content || '').includes('carapa-tool:'),
        ),
      ).toBe(false);
      const replay = formatTranscriptEntries(durableEntries) as Array<{
        content?: string;
      }>;
      expect(replay.map((entry) => entry.content ?? '').join('')).toBe(
        chunks.join(''),
      );

      const summary = summarizeCarapaRunV1(document!);
      expect(summary).toMatchObject({
        result: 'After tool.',
        session_id: 'pi-session-1',
        model_name: effectiveModel,
        total_tokens: 120,
        tok_cache_read: 40,
        tool_usage_count: 1,
      });
      const canonical = canonicalizeRunResult(
        {
          version: 1,
          harness: 'pi',
          model: requestedModel,
          sessionId: 'pi-session-1',
          durationMs: 10,
          exitCode: 0,
          status: 'success',
          usage: null,
          cost: null,
          costUsd: null,
          steps: 1,
          toolCalls: [],
        },
        runDir,
      );
      expect(canonical.model_name).toBe(effectiveModel);
      expect(canonical.model_name).not.toBe(requestedModel);
      expect(canonical.result).toBe('After tool.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses Codex V1 for live Plan input, durable tools, replay, and results', async () => {
    const root = fs.mkdtempSync(ipcTmp('carapa-codex-v1-e2e-'));
    const runDir = path.join(root, 'run-codex-v1');
    const transcript = path.join(root, 'conversation.output.jsonl');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({ agentCmd: 'codex', model: 'gpt-test' }),
    );
    fs.writeFileSync(
      path.join(runDir, 'output.jsonl'),
      `${JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'legacy poison' },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(runDir, 'output.v1.meta.json'),
      `${JSON.stringify({
        format: 'carapa-run',
        version: 1,
        harness: 'codex',
        requestedModel: 'gpt-test',
      })}\n`,
    );
    fs.writeFileSync(
      path.join(runDir, 'output.v1.jsonl'),
      `${[
        { type: 'session', id: 'thread-1', status: 'started' },
        { type: 'run', status: 'started', model: 'gpt-test' },
        {
          type: 'interaction',
          id: '900',
          status: 'requested',
          questions: [
            {
              id: 'q1',
              header: 'Continue',
              question: 'Continue?',
              options: [{ label: 'Yes', description: 'Continue the turn.' }],
              allowOther: true,
              secret: false,
            },
          ],
        },
        { type: 'interaction', id: '900', status: 'answered' },
        {
          type: 'tool_call',
          id: 'tool-1',
          status: 'started',
          name: 'bash',
          category: 'execute',
          input: { command: 'pwd' },
        },
        {
          type: 'tool_call',
          id: 'tool-1',
          status: 'completed',
          name: 'bash',
          output: '/workspace/project',
          exitCode: 0,
        },
        {
          type: 'message_delta',
          id: 'message-1',
          role: 'assistant',
          delta: 'Codex V1 complete.',
        },
        {
          type: 'message',
          id: 'message-1',
          role: 'assistant',
          content: 'Codex V1 complete.',
          format: 'markdown',
          status: 'completed',
        },
        {
          type: 'usage',
          scope: 'incremental',
          inputTokens: 100,
          outputTokens: 20,
        },
        { type: 'run', status: 'completed', stopReason: 'completed' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')}\n`,
    );
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0');

    try {
      const chunks: string[] = [];
      let inputRequests = 0;
      const result = await waitForRun(
        runDir,
        10_000,
        (chunk) => {
          if (chunk.type === 'text') chunks.push(chunk.content);
        },
        undefined,
        {
          runId: 'codex-v1-test',
          stallMs: 60_000,
          graceMs: 60_000,
          onWarn: () => {},
          onKill: () => {},
          onUserInputRequest: () => {
            inputRequests += 1;
            return true;
          },
        },
      );
      expect(result.isError).toBe(false);
      expect(result.userInputRequest).toBe(true);
      expect(inputRequests).toBe(1);
      expect(chunks.join('')).toContain('```askuserquestion');
      expect(chunks.join('')).toContain('"codexRequestId":"900"');
      expect(chunks.join('')).toContain('Codex V1 complete.');
      expect(chunks.join('')).not.toContain('legacy poison');

      const canonical = canonicalizeRunResult(null, runDir);
      expect(canonical).toMatchObject({
        result: 'Codex V1 complete.',
        model_name: 'gpt-test',
        session_id: 'thread-1',
        total_tokens: 120,
        tool_usage_count: 1,
      });

      await cleanupRunDir(
        runDir,
        transcript,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        'codex:gpt-test',
        undefined,
        undefined,
        false,
        false,
      );
      const durableEntries = fs
        .readFileSync(transcript, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        durableEntries.filter((entry) => entry.type === 'tool_call'),
      ).toHaveLength(2);
      expect(durableEntries.map((entry) => entry.type)).not.toContain(
        'item.completed',
      );
      expect(JSON.stringify(durableEntries)).not.toContain('legacy poison');
      const replay = formatTranscriptEntries(durableEntries) as Array<{
        content?: string;
      }>;
      expect(replay.map((entry) => entry.content ?? '').join('')).toBe(
        chunks.join(''),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('drains a Codex V1 event larger than one live read window', async () => {
    const root = fs.mkdtempSync(ipcTmp('carapa-codex-v1-large-event-'));
    const runDir = path.join(root, 'run-codex-v1-large-event');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({ agentCmd: 'codex', model: 'gpt-test' }),
    );
    fs.writeFileSync(path.join(runDir, 'output.jsonl'), 'legacy poison\n');
    fs.writeFileSync(
      path.join(runDir, 'output.v1.meta.json'),
      `${JSON.stringify({
        format: 'carapa-run',
        version: 1,
        harness: 'codex',
        requestedModel: 'gpt-test',
      })}\n`,
    );
    const largeToolDelta = 'x'.repeat(300 * 1024);
    fs.writeFileSync(
      path.join(runDir, 'output.v1.jsonl'),
      `${[
        { type: 'session', id: 'thread-large', status: 'started' },
        { type: 'run', status: 'started', model: 'gpt-test' },
        {
          type: 'tool_call',
          id: 'tool-large',
          status: 'in_progress',
          outputDelta: largeToolDelta,
        },
        {
          type: 'message_delta',
          id: 'message-large',
          role: 'assistant',
          delta: 'Large event consumed.',
        },
        {
          type: 'message',
          id: 'message-large',
          role: 'assistant',
          content: 'Large event consumed.',
          format: 'markdown',
          status: 'completed',
        },
        { type: 'run', status: 'completed', stopReason: 'completed' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')}\n`,
    );
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0');

    try {
      const chunks: string[] = [];
      const result = await waitForRun(runDir, 10_000, (chunk) => {
        if (chunk.type === 'text') chunks.push(chunk.content);
      });

      expect(result.isError).toBe(false);
      expect(chunks.join('')).toBe('Large event consumed.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('Claude turn totals replace snapshots while context includes cache creation on the last request', () => {
  const summary = summarizeCarapaRunV1({
    manifest: {
      format: 'carapa-run',
      version: 1,
      harness: 'claude',
      requestedModel: 'opus',
    },
    events: [
      {
        type: 'usage',
        scope: 'incremental',
        inputTokens: 2,
        outputTokens: 8,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 51388,
      },
      {
        type: 'usage',
        scope: 'incremental',
        inputTokens: 4,
        outputTokens: 2,
        cachedInputTokens: 42410,
        cacheWriteInputTokens: 9435,
      },
      {
        type: 'usage',
        scope: 'cumulative',
        inputTokens: 6,
        outputTokens: 67,
        cachedInputTokens: 42410,
        cacheWriteInputTokens: 60823,
      },
      { type: 'run', status: 'completed' },
    ],
  });
  expect(summary).toMatchObject({
    tok_input: 6,
    tok_output: 67,
    tok_cache_read: 42410,
    tok_cache_write: 60823,
    tok_context_last: 51849,
  });
});

describe('run V1 reads through the pinned run directory', () => {
  const question = {
    type: 'interaction' as const,
    id: 'ask-1',
    status: 'requested' as const,
    questions: [{ id: 'q1', header: 'Pick', question: 'Which?' }],
  };
  const writeRun = (harness: string, events: unknown[]) => {
    const root = fs.mkdtempSync(ipcTmp('carapa-question-count-'));
    fs.writeFileSync(
      path.join(root, 'args.json'),
      JSON.stringify({ agentCmd: harness }),
    );
    fs.writeFileSync(
      path.join(root, 'output.v1.meta.json'),
      `${JSON.stringify({ format: 'carapa-run', version: 1, harness, requestedModel: 'test-model' })}\n`,
    );
    fs.writeFileSync(
      path.join(root, 'output.v1.jsonl'),
      `${[{ type: 'run', status: 'started' }, ...events, { type: 'run', status: 'completed' }].map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    return root;
  };
  const readTool = {
    type: 'tool_call' as const,
    id: 'read-1',
    status: 'completed' as const,
    name: 'Read',
    output: 'ok',
  };

  test('counts the question only when neither V1 tool calls nor metrics give a count', () => {
    const root = writeRun('claude', [question]);
    try {
      expect(canonicalizeRunResult(null, root).tool_usage_count).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('counts a Codex Plan question the same way', () => {
    const root = writeRun('codex', [question]);
    try {
      expect(canonicalizeRunResult(null, root).tool_usage_count).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses a V1 file that links to another run, and reads past 1 MiB of launch data', () => {
    const other = writeRun('claude', [question]);
    const root = writeRun('claude', []);
    try {
      expect(
        canonicalizeRunResult(null, root).tool_usage_count,
      ).toBeUndefined();
      // A link in the shared tree must not substitute another run's pair.
      fs.rmSync(path.join(root, 'output.v1.jsonl'));
      fs.symlinkSync(
        path.join(other, 'output.v1.jsonl'),
        path.join(root, 'output.v1.jsonl'),
      );
      expect(
        canonicalizeRunResult(null, root).tool_usage_count,
      ).toBeUndefined();
      expect(canonicalizeRunResult(null, other).tool_usage_count).toBe(1);

      // A large pricing catalog in args.json must not hide the harness.
      fs.writeFileSync(
        path.join(other, 'args.json'),
        JSON.stringify({ agentCmd: 'claude', pricing: 'x'.repeat(2 << 20) }),
      );
      expect(canonicalizeRunResult(null, other).tool_usage_count).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('summarizes a valid spool larger than 64 MiB', () => {
    const delta = JSON.stringify({
      type: 'message_delta',
      id: 'm1',
      role: 'assistant',
      delta: 'x'.repeat(1 << 20),
    });
    const root = writeRun('codex', []);
    try {
      const eventsPath = path.join(root, 'output.v1.jsonl');
      const lines = [
        { type: 'run', status: 'started' },
        { type: 'session', id: 'big-session', status: 'started' },
      ].map((event) => JSON.stringify(event));
      const fd = fs.openSync(eventsPath, 'w');
      try {
        fs.writeSync(fd, `${lines.join('\n')}\n`);
        for (let i = 0; i < 70; i++) fs.writeSync(fd, `${delta}\n`);
        fs.writeSync(
          fd,
          `${[
            {
              type: 'message',
              id: 'm1',
              role: 'assistant',
              content: 'Big answer',
              status: 'completed',
            },
            { type: 'run', status: 'completed' },
          ]
            .map((event) => JSON.stringify(event))
            .join('\n')}\n`,
        );
      } finally {
        fs.closeSync(fd);
      }
      expect(fs.statSync(eventsPath).size).toBeGreaterThan(64 << 20);
      expect(canonicalizeRunResult(null, root)).toMatchObject({
        result: 'Big answer',
        session_id: 'big-session',
        agentSuccess: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the result when one event exceeds the per-event limit', () => {
    const root = writeRun('codex', []);
    try {
      const huge = JSON.stringify({
        type: 'message_delta',
        id: 'm1',
        role: 'assistant',
        delta: 'x'.repeat(17 << 20),
      });
      fs.writeFileSync(
        path.join(root, 'output.v1.jsonl'),
        `${[
          JSON.stringify({ type: 'run', status: 'started' }),
          huge,
          JSON.stringify({
            type: 'message',
            id: 'm1',
            role: 'assistant',
            content: 'Kept answer',
            status: 'completed',
          }),
          JSON.stringify({ type: 'run', status: 'completed' }),
        ].join('\n')}\n`,
      );
      expect(canonicalizeRunResult(null, root)).toMatchObject({
        result: 'Kept answer',
        agentSuccess: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses V1 files hard-linked from a sibling run', () => {
    const sibling = writeRun('claude', [question]);
    const root = writeRun('claude', []);
    try {
      fs.rmSync(path.join(root, 'output.v1.jsonl'));
      fs.linkSync(
        path.join(sibling, 'output.v1.jsonl'),
        path.join(root, 'output.v1.jsonl'),
      );
      expect(
        canonicalizeRunResult(null, root).tool_usage_count,
      ).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('an args.json FIFO yields the metrics-only base instead of blocking', () => {
    const root = writeRun('claude', [question]);
    try {
      fs.rmSync(path.join(root, 'args.json'));
      if (spawnSync('mkfifo', [path.join(root, 'args.json')]).status !== 0)
        return; // no mkfifo on this platform
      expect(canonicalizeRunResult(null, root)).toMatchObject({
        result: null,
        hasAssistantText: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the V1 tool-call count, in the summary and the result, when a tool ran too', () => {
    const root = writeRun('claude', [readTool, question]);
    try {
      const document = readCarapaRunV1Pair(carapaRunV1Paths(root), {
        expectedHarness: 'claude',
      });
      expect(summarizeCarapaRunV1(document!).tool_usage_count).toBe(1);
      expect(canonicalizeRunResult(null, root).tool_usage_count).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
