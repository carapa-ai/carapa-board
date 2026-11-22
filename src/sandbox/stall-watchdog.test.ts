/**
 * Stall watchdog tests for src/sandbox/process.ts (waitForRun + stall-registry).
 *
 * Strategy:
 *   - Use a real temp directory and synthesize agent output by writing to
 *     output.v1.jsonl from the test side. exit_code is written to finish the run.
 *   - Use a real :memory: DB so updateLastEventAt() writes succeed; we don't
 *     assert on the DB row (separate concern — schema test would cover that).
 *   - Advance controlled clocks and deliver file notifications explicitly.
 *
 * We deliberately do NOT mock waitForRun's dependencies via mock.module — see
 * .agent/rules/08-testing-patterns.md: top-level mock.module on shared core
 * modules leaks across files.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
} from 'bun:test';
import fs from 'node:fs';
import { mock as nodeMock } from 'node:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { initDatabase } from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import {
  waitForRun,
  StalledError,
  isBenignAgentWrapperTermination,
  isUnresumableSessionError,
  readPersistentSessionDiagnostic,
  shouldRetryUnresumableSession,
  buildOutput,
  completionStatusForRun,
  extractErrorSnippet,
  runV1ErrorText,
  type StallOpts,
} from './process.js';
import {
  tryExtendRun,
  isExtendable,
  resumeRunStallWatchdog,
} from './stall-registry.js';

let _init = false;
let tmpRoot = '';

beforeAll(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  // waitForRun pins run dirs below DATA_DIR/ipc.
  fs.mkdirSync(path.join(DATA_DIR, 'ipc'), { recursive: true });
  tmpRoot = fs.mkdtempSync(path.join(DATA_DIR, 'ipc', 'stall-test-'));
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeHostDir(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Deliver filesystem notifications explicitly while retaining real file parsing.
// OS watcher delivery is exercised by sandbox-process integration tests.
const fileNotifications = new Map<
  string,
  (event: string, filename: string) => void
>();
function notifyFile(hostDir: string, filename: string) {
  fileNotifications.get(hostDir)?.('change', filename);
}

// Grow the V1 event file with a line that no V1 harness consumes (these runs
// name none), which is still run activity.
function writeChunk(hostDir: string, line: string): void {
  fs.appendFileSync(path.join(hostDir, 'output.v1.jsonl'), line + '\n');
  notifyFile(hostDir, 'output.v1.jsonl');
}

function v1Text(...events: object[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

function writeV1(hostDir: string, ...events: object[]): void {
  fs.appendFileSync(
    path.join(hostDir, 'output.v1.jsonl'),
    events.map((event) => `${JSON.stringify(event)}\n`).join(''),
  );
  notifyFile(hostDir, 'output.v1.jsonl');
}

// A Codex run whose V1 manifest exists; the caller appends the events.
function startCodexV1Run(name: string): string {
  const hostDir = makeHostDir(name);
  fs.writeFileSync(
    path.join(hostDir, 'args.json'),
    JSON.stringify({ agentCmd: 'codex' }),
  );
  fs.writeFileSync(
    path.join(hostDir, 'output.v1.meta.json'),
    `${JSON.stringify({ format: 'carapa-run', version: 1, harness: 'codex', requestedModel: 'gpt-test' })}\n`,
  );
  return hostDir;
}

const codexInputRequest = {
  type: 'interaction',
  id: '0',
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
};
const codexRunStarted = { type: 'run', status: 'started', model: 'gpt-test' };
const codexRunCompleted = { type: 'run', status: 'completed' };

// A Plan question that the board interrupts: V1 carries the request and the
// terminal status the run ended with.
function writePlanQuestionRun(
  name: string,
  terminal: 'completed' | 'interrupted' | 'failed',
): string {
  const hostDir = startCodexV1Run(name);
  writeV1(hostDir, codexRunStarted, codexInputRequest, {
    type: 'run',
    status: terminal,
  });
  writeExit(hostDir, 1);
  return hostDir;
}

function writeStderr(hostDir: string, line: string): void {
  fs.appendFileSync(path.join(hostDir, 'agent-stderr.log'), line + '\n');
  notifyFile(hostDir, 'agent-stderr.log');
}

function writeExit(hostDir: string, code: number): void {
  fs.writeFileSync(path.join(hostDir, 'exit_code'), String(code));
  notifyFile(hostDir, 'exit_code');
}

function makeOpts(
  runId: string,
  overrides: Partial<StallOpts> = {},
): {
  opts: StallOpts;
  warnCalls: number[];
  clearCalls: number;
  killCalls: number[];
} {
  const warnCalls: number[] = [];
  let clearCalls = 0;
  const killCalls: number[] = [];
  const opts: StallOpts = {
    runId,
    stallMs: 50,
    graceMs: 30,
    onWarn: (g) => warnCalls.push(g),
    onClear: () => clearCalls++,
    onKill: (s) => killCalls.push(s),
    ...overrides,
  };
  return {
    opts,
    warnCalls,
    get clearCalls() {
      return clearCalls;
    },
    killCalls,
  };
}

describe('agent wrapper termination classification', () => {
  test('keeps unrelated non-zero exits failed even when output is usable', () => {
    expect(
      completionStatusForRun({ isError: true }, { status: 'success' }),
    ).toBe('error');
    expect(
      completionStatusForRun(
        { isError: true, intentionalUserInputInterrupt: true },
        { status: 'success' },
      ),
    ).toBe('completed');
  });

  test('recognizes SIGTERM after the wrapper already lost its pid file', () => {
    const stderr =
      'claude.ai connectors are disabled because ANTHROPIC_API_KEY is set\n' +
      '[run-agent.sh] wait returned: AGENT_PID=14161 RC=143 pid_file_alive=NO\n' +
      '[run-agent.sh] post-wait /proc tree: pid=14169 pp=14146 comm=run-agent.sh';

    expect(isBenignAgentWrapperTermination(stderr)).toBe(true);
  });

  test('does not classify other non-zero wrapper exits as benign', () => {
    expect(
      isBenignAgentWrapperTermination(
        '[run-agent.sh] wait returned: AGENT_PID=14161 RC=1 pid_file_alive=NO',
      ),
    ).toBe(false);
    expect(
      isBenignAgentWrapperTermination(
        '[run-agent.sh] wait returned: AGENT_PID=14161 RC=143 pid_file_alive=YES',
      ),
    ).toBe(false);
  });

  test('treats SIGTERM without a result event as benign when assistant text streamed', () => {
    const output = buildOutput(
      {
        events: '',
        stderr:
          '[run-agent.sh] wait returned: AGENT_PID=1 RC=143 pid_file_alive=NO',
        isError: true,
      },
      { result: 'The streamed answer.', hasAssistantText: true },
      'test-group',
    );

    expect(output.status).toBe('success');
    expect(output.result).toBe('The streamed answer.');
  });

  test('preserves user-stop classification with partial assistant output', () => {
    const output = buildOutput(
      { events: '', stderr: 'agent exited with code 137', isError: true },
      { result: 'Partial answer.', hasAssistantText: true },
      'test-group',
      undefined,
      true,
    );

    expect(output.status).toBe('error');
    expect(output.result).toBe('Partial answer.');
    expect(output.stoppedByUser).toBe(true);
  });

  test('treats a zero-exit provider error as a failed run', () => {
    const errorMessage =
      'The encrypted content gAAA...ED]= could not be verified. Reason: Encrypted content could not be decrypted or parsed.';
    const events = v1Text(codexRunStarted, {
      type: 'run',
      status: 'failed',
      error: { message: errorMessage },
    });

    const output = buildOutput(
      { events, stderr: '', isError: false },
      {
        result: errorMessage,
        hasAssistantText: false,
        agentSuccess: false,
        agentTerminalFailure: true,
      },
      'test-group',
    );

    expect(output.status).toBe('error');
    expect(output.error).toBe(errorMessage);
    expect(output.result).toContain(errorMessage);
    expect(
      completionStatusForRun({ isError: false }, { status: output.status }),
    ).toBe('error');
  });

  test('keeps a completed review successful after a failed tool call', () => {
    const reviewDecision =
      '{"decision":"reject","score":7,"issues":["fix the edge case"]}';
    const events = v1Text(
      codexRunStarted,
      {
        type: 'tool_call',
        id: 'failed-command',
        status: 'failed',
        name: 'Bash',
        error: { message: 'exit code 1' },
      },
      {
        type: 'message',
        id: 'review-decision',
        role: 'assistant',
        content: reviewDecision,
        status: 'completed',
      },
      codexRunCompleted,
    );

    const output = buildOutput(
      { events, stderr: '', isError: false },
      { result: reviewDecision, hasAssistantText: true },
      'test-group',
    );

    expect(output.status).toBe('success');
    expect(output.result).toContain(reviewDecision);
    expect(
      completionStatusForRun({ isError: false }, { status: output.status }),
    ).toBe('completed');
  });

  test('collects generated images only from the current run output', () => {
    const envelope = {
      type: 'generated_image_artifact',
      artifact: {
        provider: 'openai-codex',
        model: 'gpt-image-2',
        mimetype: 'image/png',
        filename: 'luna.png',
        relPath: 'images/luna.png',
        containerPath: '/workspace/group/artifacts/images/luna.png',
        browserUrl: '/artifacts/group/images/luna.png',
      },
    };
    const generated = buildOutput(
      {
        events: v1Text(codexRunStarted, {
          type: 'tool_call',
          id: 'image-1',
          status: 'completed',
          name: 'generate_image',
          output: JSON.stringify(envelope),
        }),
        isError: false,
      },
      { result: 'Generated Luna.', hasAssistantText: true },
      'test-group',
    );
    const laterReply = buildOutput(
      {
        events: v1Text(codexRunStarted, {
          type: 'message',
          id: 'reply-1',
          role: 'assistant',
          content: 'Hello again.',
          status: 'completed',
        }),
        isError: false,
      },
      { result: 'Hello again.', hasAssistantText: true },
      'test-group',
    );

    expect(generated.generatedArtifacts).toHaveLength(1);
    expect(laterReply.generatedArtifacts).toEqual([]);
  });

  test('keeps real errors while filtering connector and wrapper noise', () => {
    const stderr = [
      'hasTrustDialogAccepted: true in /home/ubuntu/.claude.json',
      'claude.ai connectors are disabled because ANTHROPIC_API_KEY is set',
      "Unset it to load your organization's connectors",
      '[run-agent.sh] wait returned: AGENT_PID=1 RC=1 pid_file_alive=NO',
      '[run-agent.sh] post-wait /proc tree: pid=1',
      'fatal: the agent failed to start',
    ].join('\n');

    expect(extractErrorSnippet(stderr)).toBe(
      'fatal: the agent failed to start',
    );
    const output = buildOutput(
      { events: '', stderr, isError: true },
      { result: null, hasAssistantText: false },
      'test-group',
    );
    expect(output.status).toBe('error');
    expect(output.error).toBe('fatal: the agent failed to start');
  });

  test('names a run that produced events but no error text', () => {
    const output = buildOutput(
      {
        events: v1Text(codexRunStarted, {
          type: 'usage',
          scope: 'cumulative',
          inputTokens: 24_024,
          outputTokens: 0,
        }),
        stderr: '',
        isError: true,
      },
      { result: null, hasAssistantText: false },
      'test-group',
    );

    expect(output.error).toBe(
      'Agent run ended before producing a final response.',
    );
  });

  test('reports the failed terminal run error, then an error event, then stderr', () => {
    const noise = [
      'router: error=write_stdin failed: Unknown process id 0',
      'fail to delete session: DELETE returned HTTP 404',
    ].join('\n');
    const errorOf = (events: string, stderr: string) =>
      buildOutput(
        { events, stderr, isError: true },
        { result: null, hasAssistantText: false },
        'test-group',
      ).error;

    expect(
      errorOf(
        v1Text(
          codexRunStarted,
          { type: 'error', message: 'earlier', fatal: true },
          {
            type: 'run',
            status: 'failed',
            error: { message: 'rate limited' },
          },
        ),
        noise,
      ),
    ).toBe('rate limited');
    expect(
      errorOf(
        v1Text(
          codexRunStarted,
          { type: 'error', message: 'fatal one', fatal: true },
          { type: 'error', message: 'later warning', fatal: false },
          { type: 'run', status: 'failed' },
        ),
        noise,
      ),
    ).toBe('fatal one');
    expect(
      errorOf(
        v1Text(codexRunStarted, { type: 'run', status: 'failed' }),
        noise,
      ),
    ).toBe(noise);
    // A run that wrote no V1 file reports its stderr, or nothing.
    expect(errorOf('', noise)).toBe(noise);
    expect(errorOf('', '')).toBe('(No output from agent)');
  });

  test('keeps a provider error message that is itself a JSON envelope', () => {
    const providerError =
      '{"error":{"code":400,"message":"Output of tool call should be \'Input text\'","type":"invalid_request_error"}}';
    const events = v1Text(
      codexRunStarted,
      {
        type: 'message',
        id: 'm1',
        role: 'assistant',
        content: 'Partial answer.',
        status: 'completed',
      },
      { type: 'run', status: 'failed', error: { message: providerError } },
    );
    const stderr = [
      'router: error=write_stdin failed: Unknown process id 0',
      'fail to delete session: DELETE returned HTTP 404',
    ].join('\n');

    const output = buildOutput(
      { events, stderr, isError: true },
      { result: 'Partial answer.', hasAssistantText: true },
      'test-group',
    );

    expect(output.status).toBe('error');
    expect(output.result).toBe('Partial answer.');
    expect(output.error).toBe(providerError);

    const noResultOutput = buildOutput(
      { events, stderr, isError: true },
      { result: null, hasAssistantText: false },
      'test-group',
    );

    expect(noResultOutput.status).toBe('error');
    expect(noResultOutput.error).toBe(providerError);
  });
});

describe('unresumable agent session classification', () => {
  test('recognizes Codex encrypted reasoning content failures', () => {
    const error = JSON.stringify({
      error: {
        message:
          'The encrypted content gAAA...ED]= could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
        type: 'invalid_request_error',
        code: 'invalid_encrypted_content',
      },
    });

    expect(isUnresumableSessionError(error)).toBe(true);
  });

  test('keeps ordinary agent failures out of the fresh-session fallback', () => {
    expect(
      isUnresumableSessionError(
        'fatal: tests failed because the expected output was not found',
      ),
    ).toBe(false);
  });

  test('recognizes codex thread/resume failures from an unsupported list_turns', () => {
    const error =
      'Error: ::transport::streamable_http_client: fail to delete session: unexpected server response: DELETE returned HTTP 404 session_id="572e8a63-417a-4ede-a986-f106f06efc01" Error: thread/resume: thread/resume failed: list_turns is not supported yet (code -32601)';

    expect(isUnresumableSessionError(error)).toBe(true);
  });

  test('recognizes an explicit persistent Codex resume rejection', () => {
    expect(
      isUnresumableSessionError(
        'persistent: codex thread/resume failed for thread 01abc',
      ),
    ).toBe(true);
  });

  test('recognizes an OMP session left with a pending tool result', () => {
    expect(
      isUnresumableSessionError(
        'The prior OMP process exited before recording tool result(s).',
      ),
    ).toBe(true);
  });

  test('keeps benign MCP session-cleanup 404s out of the fresh-session fallback', () => {
    expect(
      isUnresumableSessionError(
        'fail to delete session: DELETE returned HTTP 404 session_id="572e8a63-417a-4ede-a986-f106f06efc01"',
      ),
    ).toBe(false);
  });

  test('retries poisoned warm sessions without an explicit session id', () => {
    expect(
      shouldRetryUnresumableSession({
        isError: true,
        persistent: true,
        aborted: false,
        output: 'invalid_encrypted_content',
      }),
    ).toBe(true);
  });

  test('never replaces missing Antigravity native history with a fresh session', () => {
    for (const persistent of [false, true]) {
      expect(
        shouldRetryUnresumableSession({
          agentCmd: 'antigravity-acp',
          isError: true,
          persistent,
          sessionId: 'native-session',
          aborted: false,
          output: 'Session not found in the current GEMINI_HOME',
        }),
      ).toBe(false);
    }
  });

  test('retries a poisoned resumed session when only the V1 events report failure', () => {
    for (const events of [
      v1Text(codexRunStarted, {
        type: 'run',
        status: 'failed',
        error: { message: 'invalid_encrypted_content' },
      }),
      v1Text(codexRunStarted, {
        type: 'error',
        message: 'thread/resume failed',
        fatal: true,
        details: { rpc: 'no rollout found for thread id abc' },
      }),
      v1Text(codexRunStarted, {
        type: 'tool_call',
        id: 't1',
        status: 'failed',
        error: { message: 'No conversation found with session ID x' },
      }),
    ]) {
      expect(
        shouldRetryUnresumableSession({
          isError: false,
          agentTerminalFailure: true,
          sessionId: 'poisoned-session',
          persistent: false,
          aborted: false,
          output: `${runV1ErrorText(events)}\n\n`,
        }),
      ).toBe(true);
    }
    expect(runV1ErrorText(v1Text(codexRunStarted, codexRunCompleted))).toBe('');
  });

  test('does not retry a poisoned warm session after user abort', () => {
    expect(
      shouldRetryUnresumableSession({
        isError: true,
        persistent: true,
        aborted: true,
        output: 'invalid_encrypted_content',
      }),
    ).toBe(false);
  });

  test('recovers the full provider error from a warm session diagnostic', () => {
    const ipcRoot = path.join(tmpRoot, 'warm-session-current-error');
    const runDir = `${ipcRoot}/runs/run-1`;
    const sessionDir = `${ipcRoot}/sessions/conversation-variant`;
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      `${runDir}/session_dir`,
      '/workspace/ipc/sessions/conversation-variant',
    );
    fs.writeFileSync(
      `${sessionDir}/codex.appserver.out`,
      '{"method":"error","params":{"error":{"code":"invalid_encrypted_content"}}}\n',
    );

    expect(readPersistentSessionDiagnostic(runDir)).toContain(
      'invalid_encrypted_content',
    );
  });

  test('ignores provider errors from older completed warm turns', () => {
    const ipcRoot = path.join(tmpRoot, 'warm-session-stale-error');
    const runDir = `${ipcRoot}/runs/run-1`;
    const sessionDir = `${ipcRoot}/sessions/conversation-variant`;
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      `${runDir}/session_dir`,
      '/workspace/ipc/sessions/conversation-variant',
    );
    fs.writeFileSync(
      `${sessionDir}/codex.appserver.out`,
      [
        '{"method":"error","params":{"error":{"code":"invalid_encrypted_content"}}}',
        '{"method":"turn/started","params":{"turn":{"id":"current"}}}',
        '{"method":"error","params":{"error":{"message":"temporary network failure"}}}',
      ].join('\n'),
    );

    const diagnostic = readPersistentSessionDiagnostic(runDir);
    expect(diagnostic).not.toContain('invalid_encrypted_content');
    expect(diagnostic).toContain('temporary network failure');
  });
});

describe('waitForRun stall watchdog', () => {
  let watch: ReturnType<typeof spyOn>;
  beforeEach(() => {
    nodeMock.timers.enable({
      apis: ['setTimeout', 'setInterval', 'Date'],
      now: 1_000_000,
    });
    watch = spyOn(fs, 'watch').mockImplementation(((
      dir: string,
      callback: (event: string, filename: string) => void,
    ) => {
      fileNotifications.set(dir, callback);
      return Object.assign(new EventEmitter(), {
        close() {
          fileNotifications.delete(dir);
        },
      });
    }) as unknown as typeof fs.watch);
  });
  afterEach(() => {
    watch.mockRestore();
    fileNotifications.clear();
    nodeMock.timers.reset();
  });
  test('emits warning then kills with StalledError after grace expires', async () => {
    const hostDir = makeHostDir('silent');
    const { opts, warnCalls, killCalls } = makeOpts('run-silent');

    let caught: unknown = null;
    const waiting = waitForRun(
      hostDir,
      60_000,
      undefined,
      undefined,
      opts,
    ).catch((e) => {
      caught = e;
    });

    nodeMock.timers.tick(50);
    nodeMock.timers.tick(30);
    await waiting;
    expect(caught).toBeInstanceOf(StalledError);
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toBe(30); // graceMs passed through
    expect(killCalls.length).toBe(1);
    expect(killCalls[0]).toBeGreaterThanOrEqual(0);
    // Registry must be cleaned up
    expect(isExtendable('run-silent')).toBe(false);
  });

  test('activity during the stall window resets the watchdog (no warning)', async () => {
    const hostDir = makeHostDir('active');
    const { opts, warnCalls, killCalls } = makeOpts('run-active', {
      stallMs: 100,
      graceMs: 50,
    });

    // Advance past multiple stall windows, with activity before each expiry.
    const waiting = waitForRun(hostDir, 60_000, undefined, undefined, opts);
    for (let i = 0; i < 8; i++) {
      nodeMock.timers.tick(30);
      writeChunk(hostDir, `{"i":${i}}`);
    }
    writeExit(hostDir, 0);
    const result = await waiting;

    expect(result.isError).toBe(false);
    expect(warnCalls.length).toBe(0);
    expect(killCalls.length).toBe(0);
  });

  test('continues processing when heartbeat persistence rejects', async () => {
    const hostDir = makeHostDir('heartbeat-rejection');
    const { opts } = makeOpts('run-heartbeat-rejection', {
      stallMs: 200,
      graceMs: 100,
    });
    const originalDb = drizzleDbRef.current;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    let heartbeatAttemptedResolve!: () => void;
    const heartbeatAttempted = new Promise<void>((resolve) => {
      heartbeatAttemptedResolve = resolve;
    });
    let heartbeatWrites = 0;
    process.on('unhandledRejection', onUnhandled);
    // Deliberately replace only the DB boundary exercised by this test.
    drizzleDbRef.current = {
      update: () => ({
        set: () => ({
          where: () => ({
            execute: async () => {
              heartbeatWrites += 1;
              heartbeatAttemptedResolve();
              throw new Error('database unavailable');
            },
          }),
        }),
      }),
    } as unknown as typeof drizzleDbRef.current;

    try {
      // Recovery drains buffered output immediately, so no wall-clock wait is
      // needed to exercise resetActivity and its heartbeat write.
      writeChunk(hostDir, '{"heartbeat":true}');
      writeExit(hostDir, 0);
      const result = await waitForRun(
        hostDir,
        60_000,
        undefined,
        undefined,
        opts,
      );
      await heartbeatAttempted;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(result.isError).toBe(false);
      expect(heartbeatWrites).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      drizzleDbRef.current = originalDb;
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('stderr growth resets the watchdog without streaming chat output', async () => {
    const hostDir = makeHostDir('stderr-active');
    const chunks: unknown[] = [];
    const { opts, warnCalls, killCalls } = makeOpts('run-stderr-active', {
      stallMs: 100,
      graceMs: 50,
    });

    const waiting = waitForRun(
      hostDir,
      60_000,
      (chunk) => chunks.push(chunk),
      undefined,
      opts,
    );
    for (let i = 0; i < 8; i++) {
      nodeMock.timers.tick(30);
      writeStderr(hostDir, `heartbeat ${i}`);
    }
    writeExit(hostDir, 0);
    const result = await waiting;

    expect(result.isError).toBe(false);
    expect(result.stderr).toContain('heartbeat');
    expect(chunks.length).toBe(0);
    expect(warnCalls.length).toBe(0);
    expect(killCalls.length).toBe(0);
  });

  test('pid liveness gives a bounded extension before StalledError', async () => {
    const hostDir = makeHostDir('pid-bounded');
    fs.writeFileSync(path.join(hostDir, 'pid'), '12345');
    const probeCalls: string[] = [];
    const { opts, warnCalls, killCalls } = makeOpts('run-pid-bounded', {
      stallMs: 40,
      graceMs: 20,
      pidExtensionMs: 50,
      maxPidExtensions: 1,
      isPidAlive: async (pid) => {
        probeCalls.push(pid);
        return true;
      },
    });

    let warned!: () => void;
    const warning = new Promise<void>((resolve) => {
      warned = resolve;
    });
    opts.onWarn = (ms) => {
      warnCalls.push(ms);
      warned();
    };
    let caught: unknown = null;
    const waiting = waitForRun(
      hostDir,
      60_000,
      undefined,
      undefined,
      opts,
    ).catch((e) => {
      caught = e;
    });

    nodeMock.timers.tick(40);
    await warning;
    nodeMock.timers.tick(50);
    nodeMock.timers.tick(20);
    await waiting;
    expect(caught).toBeInstanceOf(StalledError);
    expect(probeCalls).toEqual(['12345']);
    expect(warnCalls).toEqual([50, 20]);
    expect(killCalls.length).toBe(1);
  });

  test('pid liveness extension resolves normally if activity resumes', async () => {
    const hostDir = makeHostDir('pid-resumes');
    fs.writeFileSync(path.join(hostDir, 'pid'), '54321');
    const { opts, warnCalls, killCalls } = makeOpts('run-pid-resumes', {
      stallMs: 40,
      graceMs: 20,
      pidExtensionMs: 80,
      maxPidExtensions: 1,
      isPidAlive: async () => true,
    });

    let warned!: () => void;
    const warning = new Promise<void>((resolve) => {
      warned = resolve;
    });
    opts.onWarn = (ms) => {
      warnCalls.push(ms);
      warned();
    };
    const waiting = waitForRun(hostDir, 60_000, undefined, undefined, opts);
    nodeMock.timers.tick(40);
    await warning;
    expect(warnCalls).toEqual([80]);
    writeChunk(hostDir, '{"resumed":true}');
    writeExit(hostDir, 0);
    const result = await waiting;

    expect(result.isError).toBe(false);
    expect(killCalls.length).toBe(0);
  });

  test('tryExtendRun during the grace window cancels the kill', async () => {
    const hostDir = makeHostDir('extended');
    const { opts, warnCalls, killCalls } = makeOpts('run-extended', {
      stallMs: 50,
      graceMs: 200, // generous grace so we have time to call extend
    });

    const waiting = waitForRun(hostDir, 60_000, undefined, undefined, opts);
    nodeMock.timers.tick(50);
    expect(warnCalls).toEqual([200]);
    expect(tryExtendRun('run-extended')).toBe(true);
    nodeMock.timers.tick(200);
    // The extension postpones the kill but must be rearmed by activity.
    writeChunk(hostDir, '{"resumed":true}');
    writeExit(hostDir, 0);
    const result = await waiting;

    expect(result.isError).toBe(false);
    expect(killCalls.length).toBe(0);
  });

  test('pauses while Codex waits for Plan-mode answers and rearms after answer', async () => {
    const hostDir = startCodexV1Run('codex-user-input');
    const { opts, warnCalls, killCalls } = makeOpts('run-codex-user-input', {
      stallMs: 60,
      graceMs: 30,
    });
    writeV1(hostDir, codexRunStarted, codexInputRequest);

    const waiting = waitForRun(hostDir, 60_000, undefined, undefined, opts);
    nodeMock.timers.tick(130);
    expect(warnCalls).toEqual([]);
    expect(resumeRunStallWatchdog('run-codex-user-input')).toBe(true);
    nodeMock.timers.tick(60);
    expect(warnCalls).toEqual([30]);
    writeV1(hostDir, codexRunCompleted);
    writeExit(hostDir, 0);
    const result = await waiting;

    expect(result.isError).toBe(false);
    expect(result.userInputRequest).toBe(true);
    expect(warnCalls).toEqual([30]);
    expect(killCalls).toEqual([]);
  });

  test('resolves normally when the Codex answer arrives after timeoutMs', async () => {
    const hostDir = startCodexV1Run('codex-user-input-late-answer');
    const { opts } = makeOpts('run-codex-user-input-late-answer', {
      stallMs: 60_000,
      graceMs: 30_000,
    });
    writeV1(hostDir, codexRunStarted, codexInputRequest);

    // Completion polls run every 2s, so the 3s timeout is crossed by several
    // polls during the 5s wait and must not fire.
    const waiting = waitForRun(hostDir, 3_000, undefined, undefined, opts);
    nodeMock.timers.tick(5_000);
    expect(resumeRunStallWatchdog('run-codex-user-input-late-answer')).toBe(
      true,
    );
    // 1s of active time passes before exit: the paused 5s must not count.
    nodeMock.timers.tick(1_000);
    writeV1(hostDir, codexRunCompleted);
    writeExit(hostDir, 0);
    nodeMock.timers.tick(2_000);
    const result = await waiting;
    expect(result.isError).toBe(false);
  });

  test('still times out on silence after the Codex answer', async () => {
    const hostDir = startCodexV1Run('codex-user-input-silent-after-answer');
    const { opts } = makeOpts('run-codex-user-input-silent-after-answer', {
      stallMs: 60_000,
      graceMs: 30_000,
    });
    writeV1(hostDir, codexRunStarted, codexInputRequest);

    // Completion polls run every 2s, so the 3s timeout is crossed by several
    // polls during the 5s wait and must not fire.
    const waiting = waitForRun(hostDir, 3_000, undefined, undefined, opts);
    nodeMock.timers.tick(5_000);
    expect(
      resumeRunStallWatchdog('run-codex-user-input-silent-after-answer'),
    ).toBe(true);
    const rejection = waiting.then(
      () => null,
      (err: Error) => err,
    );
    nodeMock.timers.tick(5_000);
    const err = await rejection;
    expect(err?.message).toContain('hard deadline exceeded');
  });

  test('treats a Plan question followed by its intentional interrupt as usable', async () => {
    const hostDir = writePlanQuestionRun(
      'codex-user-input-interrupt',
      'interrupted',
    );

    const tracker = makeOpts('run-codex-user-input-interrupt');
    tracker.opts.onUserInputRequest = () => true;
    const result = await waitForRun(
      hostDir,
      60_000,
      undefined,
      undefined,
      tracker.opts,
    );
    const output = buildOutput(
      result,
      { result: 'askuserquestion', hasAssistantText: true },
      'test',
    );

    expect(result.isError).toBe(true);
    expect(result.userInputRequest).toBe(true);
    expect(result.intentionalUserInputInterrupt).toBe(true);
    expect(output.status).toBe('success');
    expect(output.result).toContain('askuserquestion');
  });

  test('keeps a post-question completed or failed terminal as an error', async () => {
    for (const terminal of ['completed', 'failed'] as const) {
      const hostDir = writePlanQuestionRun(
        `codex-user-input-${terminal}`,
        terminal,
      );
      const tracker = makeOpts(`run-codex-user-input-${terminal}`);
      tracker.opts.onUserInputRequest = () => true;

      const result = await waitForRun(
        hostDir,
        60_000,
        undefined,
        undefined,
        tracker.opts,
      );

      expect(result.userInputRequest).toBe(true);
      expect(result.intentionalUserInputInterrupt).toBe(false);
    }
  });

  test('keeps a post-question interrupt as an error when board control fails', async () => {
    const hostDir = writePlanQuestionRun(
      'codex-user-input-unconfirmed-interrupt',
      'interrupted',
    );
    const tracker = makeOpts('run-codex-user-input-unconfirmed-interrupt');
    tracker.opts.onUserInputRequest = () => false;

    const result = await waitForRun(
      hostDir,
      60_000,
      undefined,
      undefined,
      tracker.opts,
    );
    const output = buildOutput(
      result,
      { result: null, hasAssistantText: false },
      'test',
    );

    expect(result.intentionalUserInputInterrupt).toBe(false);
    expect(output.status).toBe('error');
  });

  test('clears an existing warning when a Codex input request arrives', async () => {
    const hostDir = startCodexV1Run('codex-user-input-clears-warning');
    const tracker = makeOpts('run-codex-user-input-clears-warning', {
      stallMs: 40,
      graceMs: 200,
    });

    const waiting = waitForRun(
      hostDir,
      60_000,
      undefined,
      undefined,
      tracker.opts,
    );
    nodeMock.timers.tick(40);
    expect(tracker.warnCalls).toEqual([200]);
    writeV1(hostDir, codexRunStarted, codexInputRequest);
    nodeMock.timers.tick(240);
    expect(tracker.clearCalls).toBe(1);
    expect(tracker.killCalls).toEqual([]);
    expect(resumeRunStallWatchdog('run-codex-user-input-clears-warning')).toBe(
      true,
    );
    writeV1(hostDir, codexRunCompleted);
    writeExit(hostDir, 0);
    const result = await waiting;

    expect(result.isError).toBe(false);
  });

  describe('running background subagents', () => {
    function startClaudeV1Run(name: string): string {
      const hostDir = makeHostDir(name);
      fs.writeFileSync(
        path.join(hostDir, 'args.json'),
        JSON.stringify({ agentCmd: 'claude' }),
      );
      fs.writeFileSync(
        path.join(hostDir, 'output.v1.meta.json'),
        `${JSON.stringify({ format: 'carapa-run', version: 1, harness: 'claude', requestedModel: 'claude-test' })}\n`,
      );
      return hostDir;
    }
    const running = {
      type: 'background_tasks',
      tasks: [{ id: 'agent-1', description: 'Review the diff' }],
    };
    const none = { type: 'background_tasks', tasks: [] };

    test('suppresses the stall warning while tasks run and re-arms when the list empties', async () => {
      const hostDir = startClaudeV1Run('background-tasks');
      const { opts, warnCalls, killCalls } = makeOpts('run-background-tasks', {
        stallMs: 50,
        graceMs: 30,
        subagentMaxPauseMs: 10_000,
      });
      const waiting = waitForRun(hostDir, 60_000, undefined, undefined, opts);
      writeV1(hostDir, { type: 'run', status: 'started' }, running);

      nodeMock.timers.tick(500);
      expect(warnCalls).toEqual([]);

      writeV1(hostDir, none);
      nodeMock.timers.tick(49);
      expect(warnCalls).toEqual([]);
      nodeMock.timers.tick(1);
      expect(warnCalls).toEqual([30]);

      writeV1(hostDir, {
        type: 'run',
        status: 'completed',
        stopReason: 'stop',
      });
      writeExit(hostDir, 0);
      await waiting;
      expect(killCalls).toEqual([]);
    });

    test('a hung task falls back to the normal countdown once the pause cap expires', async () => {
      const hostDir = startClaudeV1Run('background-tasks-cap');
      const { opts, warnCalls, killCalls } = makeOpts('run-background-cap', {
        stallMs: 50,
        graceMs: 30,
        subagentMaxPauseMs: 200,
      });
      let caught: unknown = null;
      const waiting = waitForRun(
        hostDir,
        60_000,
        undefined,
        undefined,
        opts,
      ).catch((e) => {
        caught = e;
      });
      writeV1(hostDir, { type: 'run', status: 'started' }, running);

      nodeMock.timers.tick(199);
      expect(warnCalls).toEqual([]);
      nodeMock.timers.tick(1);
      expect(warnCalls).toEqual([]);
      // Another non-empty report must not restart the cap.
      writeV1(hostDir, running);
      nodeMock.timers.tick(50);
      expect(warnCalls).toEqual([30]);
      nodeMock.timers.tick(30);
      await waiting;
      expect(caught).toBeInstanceOf(StalledError);
      expect(killCalls.length).toBe(1);
    });
  });

  test('waits for canonical metrics that race just behind exit_code', async () => {
    const hostDir = makeHostDir('delayed-metrics');
    fs.writeFileSync(
      path.join(hostDir, 'args.json'),
      JSON.stringify({ metricsContract: 1 }),
    );
    writeExit(hostDir, 0);
    const waiting = waitForRun(hostDir, 60_000);
    nodeMock.timers.tick(30);
    fs.writeFileSync(
      path.join(hostDir, 'metrics.json'),
      JSON.stringify({
        version: 1,
        harness: 'codex',
        model: 'gpt-5.6-luna',
        sessionId: 'thread-1',
        durationMs: 100,
        exitCode: 0,
        status: 'success',
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 50,
          cacheWriteTokens: 0,
          reasoningOutputTokens: 0,
          raw: {},
        },
        cost: null,
        costUsd: 0.001,
        steps: 1,
        toolCalls: [],
      }),
    );
    fs.writeFileSync(path.join(hostDir, 'metrics_complete.tmp'), 'ok');
    fs.renameSync(
      path.join(hostDir, 'metrics_complete.tmp'),
      path.join(hostDir, 'metrics_complete'),
    );
    notifyFile(hostDir, 'metrics_complete');
    const result = await waiting;
    expect(result.metrics?.costUsd).toBe(0.001);
  });

  test('completes explicitly when canonical measurement fails', async () => {
    const hostDir = makeHostDir('failed-metrics');
    fs.writeFileSync(
      path.join(hostDir, 'args.json'),
      JSON.stringify({ metricsContract: 1 }),
    );
    writeExit(hostDir, 1);
    fs.writeFileSync(path.join(hostDir, 'metrics_complete'), 'error');

    const result = await waitForRun(hostDir, 60_000);
    expect(result.isError).toBe(true);
    expect(result.metrics).toBeNull();
  });
});
