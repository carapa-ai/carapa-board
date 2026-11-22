/**
 * Integration tests for src/sandbox/process.ts (runContainerAgent).
 *
 * Covers early-exit code paths that can be tested without a live sandbox:
 *   - pre-aborted AbortSignal → {status:'error', error:'Aborted'}
 *   - whitespace-only prompt  → {status:'error', error:'Empty prompt'}
 *   - sandbox fails to start  → {status:'error', error:'Failed to start sandbox: ...'}
 *
 * Heavy deps are mocked to keep the tests hermetic:
 *   - ./lib/mcp-client.js   — prevents real HTTP connections to carapa-box
 *   - ./transcript-store.js — prevents JSONL writes to groups/
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  onTestFinished,
  mock,
  spyOn,
} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDatabase } from '../db.js';
import {
  getActiveRunForTask,
  getActiveRunById,
  getActiveRunsByStatus,
  insertActiveRun,
  createTask,
  createConversation,
  getConversation,
} from '../db.js';
import {
  archivedCarapaRunV1Paths,
  readCarapaRunV1Pair,
} from '../modules/transcripts/carapa-run-v1.js';
import { waitForFileState } from '../test-file-events.js';
import { truncateTestDb } from '../test-helpers.js';
import { resolveEffectiveSandbox } from './effective-settings.js';
import { DATA_DIR, GROUPS_DIR, PERSISTENT_CLAUDE } from '../config.js';
import { acquireGroupSlot } from '../concurrency/semaphore.js';
import { acquireSharedCheckoutLease } from '../concurrency/shared-checkout-lease.js';
import type { RegisteredGroup } from '../types.js';
import type { ContainerInput } from './process.js';
import { runFixture, taskFixture } from '../test-helpers.js';
import {
  appendTaskMessageAsync,
  readTaskMessages,
} from '../modules/transcripts/transcript-store.js';

// ─── Filesystem shim ──────────────────────────────────────────────────────────
//
// DATA_DIR (from src/config.ts) may point at a read-only path in CI/sandbox
// environments (e.g. when CARAPA_DATA_DIR is set to a host directory).
// sandbox/process.ts calls fs.mkdirSync() to pre-create IPC run directories.
// We monkey-patch the shared `fs` module object (same reference held by all
// importers) so mkdirSync is a no-op for these tests, then restore it after.
// This is safe because all tests in this file target early-exit code paths that
// never actually use the IPC directory.

const realMkdirSync = fs.mkdirSync;
const recoveryGroupFolder = `sandbox-service-recovery-${process.pid}`;
const recoveryIpcDir = path.join(
  DATA_DIR,
  'ipc',
  `carapa-bot-${recoveryGroupFolder}`,
);
const recoveryGroupDir = path.join(GROUPS_DIR, recoveryGroupFolder);

beforeAll(() => {
  (fs as any).mkdirSync = () => undefined;
});

afterAll(() => {
  (fs as any).mkdirSync = realMkdirSync;
  fs.rmSync(recoveryIpcDir, { recursive: true, force: true });
  fs.rmSync(recoveryGroupDir, { recursive: true, force: true });
});

// ─── Configurable mock state ──────────────────────────────────────────────────
//
// sandboxStatus and sandboxStart results are declared as mutable variables so
// individual tests can change the simulated sandbox behaviour by reassigning
// them.  All other client methods use fixed no-error responses.

type ToolResult = { stdout: string; isError: boolean };

let sandboxStatusResult: ToolResult = { stdout: '"running"', isError: false };
let sandboxStartResult: ToolResult = { stdout: '', isError: false };
let sandboxExecResult: ToolResult = { stdout: '', isError: false };
let sandboxExecResults: ToolResult[] = [];
let sandboxExecObserver:
  | ((stack: string, service: string, command: string) => void)
  | undefined;
let sandboxWorktreeResult: ToolResult = { stdout: '', isError: false };
let sandboxWorktreeListResult: ToolResult = { stdout: '', isError: false };
let sandboxWorktreeReuseResult: ToolResult | undefined;
let sandboxWorktreeError: Error | null = null;
let sandboxClientError: Error | null = null;
let directLlmError: Error | null = null;
/**
 * Writes the terminal Run V1 pair a finished runner leaves in its run
 * directory; the board reads a run's result from it, not from output.jsonl.
 */
function writeRunV1Result(
  runDir: string,
  outcome: { result: string; sessionId?: string; failed?: boolean },
): void {
  // The mocked launch leaves no args.json; the board resolves the harness from it.
  const argsPath = path.join(runDir, 'args.json');
  if (!fs.existsSync(argsPath))
    fs.writeFileSync(argsPath, JSON.stringify({ agentCmd: 'claude' }));
  const harness = (
    JSON.parse(fs.readFileSync(argsPath, 'utf8')) as { agentCmd: string }
  ).agentCmd;
  fs.writeFileSync(
    path.join(runDir, 'output.v1.meta.json'),
    `${JSON.stringify({
      format: 'carapa-run',
      version: 1,
      harness,
      requestedModel: 'test-model',
    })}\n`,
  );
  const events = [
    { type: 'run', status: 'started' },
    ...(outcome.sessionId
      ? [{ type: 'session', id: outcome.sessionId, status: 'started' }]
      : []),
    outcome.failed
      ? { type: 'error', message: outcome.result, fatal: true }
      : {
          type: 'message',
          id: 'message-1',
          role: 'assistant',
          content: outcome.result,
          status: 'completed',
        },
    { type: 'run', status: outcome.failed ? 'failed' : 'completed' },
  ];
  fs.writeFileSync(
    path.join(runDir, 'output.v1.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
}

function launchedRuns(runsDir: string) {
  const buffered: string[] = [];
  const receivers: Array<(dir: string) => void> = [];
  return {
    onRunLaunched(runId: string) {
      const dir = path.join(runsDir, runId);
      const receiver = receivers.shift();
      if (receiver) receiver(dir);
      else buffered.push(dir);
    },
    next(): Promise<string> {
      const dir = buffered.shift();
      return dir
        ? Promise.resolve(dir)
        : new Promise((resolve) => receivers.push(resolve));
    },
  };
}

let directLlmWait: Promise<void> | null = null;
let directLlmStarted: (() => void) | undefined;
let branchCreateFailures = 0;
let branchCreated = false;
let sandboxGitStatus = '';
let sandboxDefaultBranch = 'develop';
let sandboxMissingDependency = false;

const mockClient = {
  sandboxStatus: mock(async () => sandboxStatusResult),
  sandboxStart: mock(async () => sandboxStartResult),
  sandboxStop: mock(
    async (): Promise<ToolResult> => ({ stdout: '', isError: false }),
  ),
  sandboxExec: mock(
    async (
      stack: string,
      service: string,
      command: string,
    ): Promise<ToolResult> => {
      sandboxExecObserver?.(stack, service, command);
      if (command.startsWith('browser-close '))
        return { stdout: '', isError: false };
      if (command === 'pwd')
        return { stdout: '/srv/service\n', isError: false };
      return sandboxExecResults.shift() ?? sandboxExecResult;
    },
  ),
  sandboxGit: mock(
    async (_stack: string, args: string): Promise<ToolResult> => {
      if (args.includes('branch --show-current')) {
        return {
          stdout: branchCreated
            ? 'task/retry-branch\n'
            : `${sandboxDefaultBranch}\n`,
          isError: false,
        };
      }
      if (args.includes('status --porcelain=v1')) {
        return { stdout: sandboxGitStatus, isError: false };
      }
      if (args.includes('merge-base --is-ancestor')) {
        return {
          stdout: sandboxMissingDependency ? 'missing dependency' : '',
          isError: sandboxMissingDependency,
        };
      }
      if (args.includes('checkout task/retry-branch') && !branchCreated) {
        return { stdout: 'branch does not exist', isError: true };
      }
      if (args.includes('checkout -b task/retry-branch')) {
        if (branchCreateFailures > 0) {
          branchCreateFailures--;
          return { stdout: 'transient checkout failure', isError: true };
        }
        branchCreated = true;
      }
      return { stdout: '', isError: false };
    },
  ),
  sandboxWorktree: mock(
    async (
      _stack: string,
      action: string,
      options?: { branch?: string },
    ): Promise<ToolResult> => {
      if (sandboxWorktreeError) throw sandboxWorktreeError;
      if (action === 'list') return sandboxWorktreeListResult;
      if (action === 'reuse')
        return (
          sandboxWorktreeReuseResult ?? {
            stdout: `worktree_path=/host/project/.worktrees/${options?.branch}\npreview_port=8083\n`,
            isError: false,
          }
        );
      return sandboxWorktreeResult;
    },
  ),
  callTool: mock(
    async (): Promise<ToolResult> => ({ stdout: '[]', isError: false }),
  ),
  stopAgent: mock(
    async (): Promise<ToolResult> => ({ stdout: '', isError: false }),
  ),
};

// ─── Module mocks ─────────────────────────────────────────────────────────────

mock.module('../lib/mcp-client.js', () => ({
  getSandboxClient: mock(() => {
    if (sandboxClientError) throw sandboxClientError;
    return mockClient;
  }),
  SandboxClient: class {},
}));

// Keep the Direct LLM run hermetic.
const runDirectLlm = mock(
  async (
    _system: string,
    prompt: string,
    model: string,
    _onChunk: unknown,
    _attachments: unknown,
    _history: unknown,
    _options: unknown,
    _deps: unknown,
    onTranscriptEntry?: (entry: unknown) => void,
  ) => {
    onTranscriptEntry?.({ type: 'message', role: 'user', content: prompt });
    if (directLlmWait) {
      onTranscriptEntry?.({
        type: 'message',
        role: 'assistant',
        content: 'durable partial direct output',
      });
      directLlmStarted?.();
      await directLlmWait;
    }
    onTranscriptEntry?.({ type: 'thinking', text: 'direct thought' });
    const toolPart = { id: 'direct-tool-1', type: 'tool', tool: 'lookup' };
    onTranscriptEntry?.({
      type: 'tool_use',
      part: { ...toolPart, state: { status: 'running', input: { q: 1 } } },
    });
    onTranscriptEntry?.({
      type: 'tool_use',
      part: {
        ...toolPart,
        state: { status: 'completed', input: { q: 1 }, output: 'found' },
      },
    });
    if (directLlmError) throw directLlmError;
    onTranscriptEntry?.({
      type: 'message',
      role: 'assistant',
      content: 'direct result',
    });
    return {
      result: 'direct result',
      model_name: model,
      total_tokens: 12,
      tok_input: 7,
      tok_output: 5,
    };
  },
);

// ─── Dynamic import (after all mocks are registered) ─────────────────────────

const {
  runContainerAgent,
  isCurrentProcessRun,
  markCurrentProcessRun,
  unmarkCurrentProcessRun,
  resolveDirectReasoningEffort,
  getTaskSlotLimit,
  isStoppedSandboxServiceError,
  parseCodexRunControlResponse,
  gracefullyInterruptRun,
  killRun,
  resolveHostRunDir,
  resolvePersistentSessionScope,
  persistentVariantTag,
  TASK_PERSISTENT_RUNTIME_CONTRACT,
} = await import('./process.js');
const { branchCheckoutStateIsSafe, prepareDirectTaskCheckout } =
  await import('./direct-checkout.js');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Minimal RegisteredGroup — only the fields actually read by the early-exit
// paths under test.  The as-any cast is needed because settings:{} doesn't
// satisfy settings?: ProjectSettings; as any avoids listing all optional ProjectSettings fields.
const group = {
  name: 'test-sandbox-group',
  folder: 'test-sandbox-proj',
  trigger: 'test',
  added_at: new Date().toISOString(),
  settings: {},
} as any;

/** Build a minimal ContainerInput for a chat run (no task_id → bypasses semaphore). */
function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'Hello, agent!',
    group_folder: group.folder,
    chat_jid: 'sandbox-test@kanban',
    isMain: false,
    ...overrides,
  };
}

describe('resolvePersistentSessionScope', () => {
  test.each(TASK_PERSISTENT_RUNTIME_CONTRACT.map(({ agentCmd }) => [agentCmd]))(
    'keeps %s coding sessions task-and-stage scoped',
    (agentCmd) => {
      const scope = resolvePersistentSessionScope({
        enabled: true,
        agentCmd,
        taskId: 'task-42',
        stageId: 'coding',
        stageType: 'active',
        model: 'openai-codex/gpt-5.6-sol',
      });
      expect(scope.eligible).toBe(true);
      expect(scope.key).toMatch(/^task-task-42-coding-[0-9a-f]{8}$/);
    },
  );

  test.each(['testing', 'review'])(
    'keeps %s ACP runs isolated',
    (stageType) => {
      expect(
        resolvePersistentSessionScope({
          enabled: true,
          agentCmd: 'prime-agent-acp',
          taskId: 'task-42',
          stageId: stageType,
          stageType,
        }),
      ).toEqual({ eligible: false });
    },
  );

  test('does not make non-ACP task agents warm', () => {
    expect(
      resolvePersistentSessionScope({
        enabled: true,
        agentCmd: 'codex',
        taskId: 'task-42',
        stageId: 'coding',
        stageType: 'active',
      }),
    ).toEqual({ eligible: false });
  });

  test.each([
    'claude',
    'codex',
    'agy-sdk',
    'antigravity-acp',
    'cursor-acp',
    'hermes-acp',
    'omp-acp',
    'prime-agent-acp',
    'pi',
  ])('applies main-persona generations to %s chat sessions', (agentCmd) => {
    const firstGeneration = resolvePersistentSessionScope({
      enabled: true,
      agentCmd,
      conversationId: 'conversation-9',
      mainPersonaGeneration: 1,
    });
    const nextGeneration = resolvePersistentSessionScope({
      enabled: true,
      agentCmd,
      conversationId: 'conversation-9',
      mainPersonaGeneration: 2,
    });
    expect(firstGeneration.eligible).toBe(true);
    expect(firstGeneration.key).toMatch(/^conversation-9-g1-[0-9a-f]{8}$/);
    expect(nextGeneration.key).toMatch(/^conversation-9-g2-[0-9a-f]{8}$/);
  });

  test('uses the latest generation for unchanged turns and never returns to an old A scope', () => {
    const keyFor = (mainPersonaGeneration: number) =>
      resolvePersistentSessionScope({
        enabled: true,
        agentCmd: 'codex',
        conversationId: 'conversation-persona-transitions',
        mainPersonaGeneration,
      }).key;

    const states = [1, 1, 2, 2, 3, 3].map(keyFor);

    for (let index = 0; index < states.length; index += 2) {
      expect(states[index + 1]).toBe(states[index]);
      if (index > 0) expect(states[index]).not.toBe(states[index - 1]);
    }
    expect(states.at(-1)).not.toBe(states[0]);
  });

  test('keeps Codex chat sessions warm while their conversation worktree is stable', () => {
    const first = resolvePersistentSessionScope({
      enabled: true,
      agentCmd: 'codex',
      conversationId: 'conversation-9',
      worktreePath: '/workspace/project/.worktrees/chat-conversation-9',
      model: 'gpt-5.6-luna',
    });
    const sameWorktree = resolvePersistentSessionScope({
      enabled: true,
      agentCmd: 'codex',
      conversationId: 'conversation-9',
      worktreePath: '/workspace/project/.worktrees/chat-conversation-9',
      model: 'gpt-5.6-luna',
    });
    const movedWorktree = resolvePersistentSessionScope({
      enabled: true,
      agentCmd: 'codex',
      conversationId: 'conversation-9',
      worktreePath: '/workspace/project/.worktrees/replacement',
      model: 'gpt-5.6-luna',
    });

    expect(first.eligible).toBe(true);
    expect(first.key).toMatch(/^conversation-9-[0-9a-f]{8}$/);
    expect(sameWorktree.key).toBe(first.key);
    expect(movedWorktree.key).not.toBe(first.key);
  });
});

let _init = false;
beforeEach(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  await truncateTestDb();

  // Reset sandbox mock results to safe defaults before each test.
  sandboxStatusResult = { stdout: '"running"', isError: false };
  sandboxStartResult = { stdout: '', isError: false };
  sandboxExecResult = { stdout: '', isError: false };
  sandboxExecResults = [];
  sandboxExecObserver = undefined;
  sandboxWorktreeResult = { stdout: '', isError: false };
  sandboxWorktreeListResult = { stdout: '', isError: false };
  sandboxWorktreeReuseResult = undefined;
  sandboxWorktreeError = null;
  sandboxClientError = null;
  directLlmError = null;
  directLlmWait = null;
  directLlmStarted = undefined;
  branchCreateFailures = 0;
  branchCreated = false;
  sandboxGitStatus = '';
  sandboxDefaultBranch = 'develop';
  sandboxMissingDependency = false;
  // Clear call history so assertions on call counts are not order-dependent.
  mockClient.sandboxStatus.mockClear();
  mockClient.sandboxStart.mockClear();
  mockClient.sandboxStop.mockClear();
  mockClient.sandboxExec.mockClear();
  mockClient.sandboxGit.mockClear();
  mockClient.sandboxWorktree.mockClear();
  mockClient.callTool.mockClear();
  mockClient.stopAgent.mockClear();
});

describe('killRun', () => {
  test('retires a warm session when the recorded wrapper PID is already dead', async () => {
    const runId = `run-dead-wrapper-${process.pid}`;
    const ipcRoot = path.join(DATA_DIR, 'ipc', 'carapa-bot-kill-test');
    const runDir = path.join(ipcRoot, 'runs', runId);
    realMkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'pid'), '424242');
    sandboxExecResults = [
      { stdout: '{"status":"already_dead","pid":424242}', isError: false },
      { stdout: '{"status":"already_dead","pid":424242}', isError: false },
    ];

    try {
      const killed = await killRun({
        id: runId,
        group_folder: 'kill-test',
        sandbox_stack: 'carapa-bot',
        sandbox_service: 'agent',
        sandbox_instance: 'kill-test',
      } as any);

      expect(killed).toBe(true);
      expect(mockClient.sandboxExec).toHaveBeenCalledTimes(2);
      const execCalls = mockClient.sandboxExec.mock.calls as unknown as Array<
        [string, string, string]
      >;
      expect(execCalls[0]?.[2]).toContain(
        `stop-agent.sh /workspace/ipc/runs/${runId} 424242`,
      );
      expect(execCalls[1]?.[2]).toBe(
        `stop-agent.sh /workspace/ipc/runs/${runId}`,
      );
    } finally {
      fs.rmSync(ipcRoot, { recursive: true, force: true });
    }
  });
});

describe('runContainerAgent — scheduled DirectLLM transcripts', () => {
  test('keeps a successful direct run completed when prompt acceptance persistence fails', async () => {
    const taskId = `direct-prompt-receipt-failure-${process.pid}`;
    const sessionAgentKey =
      'main-persona-session:main-persona%3Av1%3Atest:llm:test-model';
    const result = await runContainerAgent(
      group,
      baseInput({
        task_id: taskId,
        agent_cmd: 'llm:test-model',
        transcript_agent_name: 'ai-main:test-persona',
        session_agent_key: sessionAgentKey,
        runtimeConfig: {
          id: 'llm:test-model',
          model: 'test-model',
          baseUrl: 'http://direct.invalid/v1',
        },
        onPromptRunAccepted: async () => {
          throw new Error('injected direct receipt persistence failure');
        },
      }) as ContainerInput,
      undefined,
      { resolveEffectiveSandbox, runDirectLlm: runDirectLlm as any },
    );

    expect(result).toMatchObject({
      status: 'success',
      result: 'direct result',
    });
    expect(await getActiveRunById(result.activeRunId!)).toMatchObject({
      status: 'completed',
      agent_name: 'llm:test-model',
      session_agent_key: sessionAgentKey,
    });
  });

  test('writes scheduled artifacts while the DirectLLM run is still active', async () => {
    const folder = `scheduled-direct-restart-${process.pid}`;
    const directGroup = { ...group, folder };
    let releaseDirectLlm!: () => void;
    directLlmWait = new Promise<void>((resolve) => {
      releaseDirectLlm = resolve;
    });
    (fs as any).mkdirSync = realMkdirSync;
    const started = new Promise<void>((resolve) => {
      directLlmStarted = resolve;
    });
    try {
      const pending = runContainerAgent(
        directGroup,
        baseInput({
          group_folder: folder,
          agent_cmd: 'llm:test-model',
          runtimeConfig: {
            id: 'llm:test-model',
            model: 'test-model',
            baseUrl: 'http://direct.invalid/v1',
          },
          ephemeral: true,
          isScheduledTask: true,
          scheduled_task_id: 'scheduled-direct-restart-task',
        }),
        undefined,
        { resolveEffectiveSandbox, runDirectLlm: runDirectLlm as any },
      );
      const { getActiveRunsByStatus } = await import('../db.js');
      await started;
      const activeRun = (await getActiveRunsByStatus('running')).find(
        (run) => run.group_folder === folder,
      );
      expect(activeRun).toBeDefined();
      expect(activeRun).toMatchObject({
        triggeredByUserId: null,
        triggerSource: 'system',
      });
      const runDir = resolveHostRunDir(activeRun!);
      expect(runDir).toBeString();
      expect(fs.readFileSync(path.join(runDir!, 'prompt.txt'), 'utf8')).toBe(
        'Hello, agent!',
      );
      const durableOutput = fs.readFileSync(
        path.join(runDir!, 'output.v1.jsonl'),
        'utf8',
      );
      expect(fs.existsSync(path.join(runDir!, 'output.jsonl'))).toBe(false);
      expect(durableOutput).toContain('Hello, agent!');
      expect(durableOutput).toContain('durable partial direct output');

      releaseDirectLlm();
      await expect(pending).resolves.toMatchObject({ status: 'success' });
    } finally {
      releaseDirectLlm?.();
      directLlmWait = null;
      directLlmStarted = undefined;
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  });

  test.each(['success', 'error'] as const)(
    'preserves the %s transcript and removes its IPC directory',
    async (outcome) => {
      const folder = `scheduled-direct-${outcome}-${process.pid}`;
      const directGroup = { ...group, folder };
      if (outcome === 'error') directLlmError = new Error('direct failed');
      (fs as any).mkdirSync = realMkdirSync;
      try {
        const result = await runContainerAgent(
          directGroup,
          baseInput({
            group_folder: folder,
            agent_cmd: 'llm:test-model',
            runtimeConfig: {
              id: 'llm:test-model',
              model: 'test-model',
              baseUrl: 'http://direct.invalid/v1',
            },
            ephemeral: true,
            isScheduledTask: true,
            scheduled_task_id: `scheduled-direct-task-${outcome}`,
          }),
          undefined,
          { resolveEffectiveSandbox, runDirectLlm: runDirectLlm as any },
        );
        expect(result.status).toBe(outcome === 'success' ? 'success' : 'error');
        expect(result.activeRunId).toBeString();
        if (outcome === 'success') {
          const { getActiveRunById } = await import('../db.js');
          expect(await getActiveRunById(result.activeRunId!)).toMatchObject({
            model_name: 'test-model',
            tok_total: 12,
            tok_input: 7,
            tok_output: 5,
          });
        }
        const transcriptDir = path.join(
          GROUPS_DIR,
          folder,
          'session-transcripts',
        );
        expect(
          fs.readFileSync(
            path.join(transcriptDir, `${result.activeRunId}.prompt.txt`),
            'utf8',
          ),
        ).toBe('Hello, agent!');
        expect(
          fs.existsSync(
            path.join(transcriptDir, `${result.activeRunId}.jsonl`),
          ),
        ).toBe(false);
        const document = readCarapaRunV1Pair(
          archivedCarapaRunV1Paths(transcriptDir, result.activeRunId!),
          { requireTerminal: true },
        );
        expect(document?.manifest).toMatchObject({
          harness: 'llm:test-model',
          requestedModel: 'test-model',
        });
        expect(document?.events).toMatchObject([
          { type: 'run', status: 'started' },
          { type: 'message', role: 'user', content: 'Hello, agent!' },
          { type: 'thought', content: 'direct thought' },
          { type: 'tool_call', id: 'direct-tool-1', status: 'started' },
          {
            type: 'tool_call',
            id: 'direct-tool-1',
            status: 'completed',
            name: 'lookup',
            input: { q: 1 },
            output: 'found',
          },
          ...(outcome === 'success'
            ? [
                {
                  type: 'message',
                  role: 'assistant',
                  content: 'direct result',
                },
                { type: 'run', status: 'completed' },
              ]
            : [
                { type: 'error', message: 'direct failed', fatal: true },
                {
                  type: 'run',
                  status: 'failed',
                  error: { message: 'direct failed' },
                },
              ]),
        ]);
        expect(
          fs.existsSync(
            path.join(
              DATA_DIR,
              'ipc',
              'carapa-bot-default',
              'runs',
              result.activeRunId!,
            ),
          ),
        ).toBe(false);
      } finally {
        (fs as any).mkdirSync = () => undefined;
        fs.rmSync(path.join(GROUPS_DIR, folder), {
          recursive: true,
          force: true,
        });
      }
    },
  );
});

describe('Codex run control responses', () => {
  test('keeps a partially written response pending', () => {
    expect(parseCodexRunControlResponse('{"ok":')).toBeUndefined();
    expect(parseCodexRunControlResponse('{}')).toBeUndefined();
    expect(parseCodexRunControlResponse('{"ok":true}')).toBe(true);
    expect(parseCodexRunControlResponse('{"ok":false}')).toBe(false);
  });

  test('generic harness interrupt waits for the durable runner handshake', async () => {
    const runId = `graceful-interrupt-${process.pid}`;
    const instance = `graceful-${process.pid}`;
    const runDir = path.join(
      DATA_DIR,
      'ipc',
      `carapa-bot-${instance}`,
      'runs',
      runId,
    );
    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(runDir, 'control-requests'), { recursive: true });
      fs.mkdirSync(path.join(runDir, 'control-responses'), { recursive: true });
      fs.writeFileSync(
        path.join(runDir, 'agent-control.json'),
        JSON.stringify({ version: 1, harness: 'hermes-acp' }),
      );

      const requestsDir = path.join(runDir, 'control-requests');
      const requestReady = waitForFileState(requestsDir, () =>
        fs.readdirSync(requestsDir).find((entry) => entry.endsWith('.json')),
      );
      const pending = gracefullyInterruptRun(
        {
          id: runId,
          group_folder: 'unused-with-explicit-instance',
          sandbox_stack: 'carapa-bot',
          sandbox_instance: instance,
        } as any,
        2_000,
      );

      const requestName = await requestReady;
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(runDir, 'control-requests', requestName!),
            'utf8',
          ),
        ).action,
      ).toBe('interrupt');

      fs.writeFileSync(
        path.join(runDir, 'control-responses', requestName!),
        JSON.stringify({ ok: true, result: {} }),
      );
      fs.writeFileSync(path.join(runDir, 'exit_code'), '130');
      fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok');
      expect(await pending).toBe(true);
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${instance}`), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe('runContainerAgent launch acknowledgement', () => {
  test('does not acknowledge a run when launch fails', async () => {
    sandboxExecResult = { stdout: 'launch failed', isError: true };
    let launched = false;
    const result = await runContainerAgent(
      group,
      baseInput({
        onRunLaunched: () => {
          launched = true;
        },
      }) as ContainerInput,
    );
    expect(result.status).toBe('error');
    expect(launched).toBe(false);
  });

  test('assigns the prompt at production launch and consumes it only after terminal success', async () => {
    const folder = `launch-ack-boundary-${process.pid}`;
    const taskId = `task-launch-boundary-${process.pid}`;
    const runsDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`, 'runs');
    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const steeringPrompt = await appendTaskMessageAsync(folder, {
        task_id: taskId,
        role: 'user',
        content: 'durable continuation prompt',
        steering: true,
        created_at: new Date().toISOString(),
      });
      let acknowledgeAssignment!: (runId: string) => void;
      const assigned = new Promise<string>((resolve) => {
        acknowledgeAssignment = resolve;
      });
      let allowLaunch!: () => void;
      const assignmentPersisted = new Promise<void>((resolve) => {
        allowLaunch = resolve;
      });
      let settled = false;
      const pending = runContainerAgent(
        { ...group, folder },
        baseInput({
          group_folder: folder,
          task_id: taskId,
          stage_id: 'testing:format-repair-1',
          activeRunStageId: 'testing',
          ephemeral: true,
          onPromptRunAssigned: async (runId: string) => {
            await appendTaskMessageAsync(folder, {
              task_id: taskId,
              role: 'system',
              entry_type: 'steering_assignment',
              prompt_id: steeringPrompt.id,
              run_id: runId,
              content: '',
              created_at: new Date().toISOString(),
            });
            acknowledgeAssignment(runId);
            await assignmentPersisted;
          },
          onPromptRunAccepted: async (runId: string) => {
            await appendTaskMessageAsync(folder, {
              task_id: taskId,
              role: 'system',
              entry_type: 'steering_delivery',
              prompt_id: steeringPrompt.id,
              run_id: runId,
              content: '',
              created_at: new Date().toISOString(),
            });
          },
        }) as ContainerInput,
      ).finally(() => {
        settled = true;
      });

      const runId = await assigned;
      const runDir = path.join(runsDir, runId);
      expect(settled).toBe(false);
      expect(await getActiveRunById(runId)).toMatchObject({
        status: 'running',
        stage: 'testing',
      });
      expect(fs.existsSync(path.join(runDir, 'prompt.txt'))).toBe(false);
      allowLaunch();
      expect(fs.existsSync(path.join(runDir, 'exit_code'))).toBe(false);
      expect(
        readTaskMessages(folder, taskId).filter(
          (message) =>
            message.entry_type === 'steering_assignment' &&
            message.prompt_id === steeringPrompt.id &&
            message.run_id === runId,
        ),
      ).toHaveLength(1);
      expect(
        readTaskMessages(folder, taskId).filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === steeringPrompt.id,
        ),
      ).toHaveLength(0);

      fs.writeFileSync(
        path.join(runDir, 'output.jsonl'),
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
      );
      writeRunV1Result(runDir, { result: 'done' });
      fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok');
      fs.writeFileSync(path.join(runDir, 'exit_code'), '0');
      expect((await pending).status).toBe('success');
      expect(
        readTaskMessages(folder, taskId).filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === steeringPrompt.id &&
            message.run_id === runId,
        ),
      ).toHaveLength(1);
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  });

  test('retains successful-run evidence when receipt persistence fails after terminal output', async () => {
    const folder = `receipt-failure-boundary-${process.pid}`;
    const taskId = `task-receipt-failure-${process.pid}`;
    const runsDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`, 'runs');
    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const steeringPrompt = await appendTaskMessageAsync(folder, {
        task_id: taskId,
        role: 'user',
        content: 'consume this successful continuation once',
        steering: true,
        created_at: new Date().toISOString(),
      });
      let acknowledgeAssignment!: (runId: string) => void;
      const assigned = new Promise<string>((resolve) => {
        acknowledgeAssignment = resolve;
      });
      let receiptAttempts = 0;
      const pending = runContainerAgent(
        { ...group, folder },
        baseInput({
          group_folder: folder,
          task_id: taskId,
          stage_id: 'testing',
          ephemeral: true,
          onPromptRunAssigned: async (runId: string) => {
            await appendTaskMessageAsync(folder, {
              task_id: taskId,
              role: 'system',
              entry_type: 'steering_assignment',
              prompt_id: steeringPrompt.id,
              run_id: runId,
              content: '',
              created_at: new Date().toISOString(),
            });
            acknowledgeAssignment(runId);
          },
          onPromptRunAccepted: async () => {
            receiptAttempts++;
            throw new Error('injected receipt persistence failure');
          },
        }) as ContainerInput,
      );

      const runId = await assigned;
      const runDir = path.join(runsDir, runId);
      fs.writeFileSync(
        path.join(runDir, 'output.jsonl'),
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
      );
      writeRunV1Result(runDir, { result: 'done' });
      fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok');
      fs.writeFileSync(path.join(runDir, 'exit_code'), '0');

      await expect(pending).resolves.toMatchObject({
        status: 'success',
        result: 'done',
      });
      expect(receiptAttempts).toBe(1);
      expect(await getActiveRunById(runId)).toMatchObject({
        status: 'completed',
        stage: 'testing',
      });
      expect(
        readTaskMessages(folder, taskId).filter(
          (message) => message.entry_type === 'steering_delivery',
        ),
      ).toHaveLength(0);

      const { reconcileTaskSteeringReceipts } =
        await import('../modules/kanban/task/pipeline.js');
      const task = { id: taskId, project_id: folder } as any;
      await reconcileTaskSteeringReceipts(task);
      await reconcileTaskSteeringReceipts(task);

      const reloaded = readTaskMessages(folder, taskId);
      expect(
        reloaded.filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === steeringPrompt.id &&
            message.run_id === runId,
        ),
      ).toHaveLength(1);
      expect(
        reloaded.find((message) => message.id === steeringPrompt.id),
      ).toMatchObject({ steeringDelivery: 'steered' });
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  });

  test('keeps an assigned prompt pending after a non-session provider failure', async () => {
    const folder = `prompt-provider-failure-${process.pid}`;
    const taskId = `task-prompt-provider-failure-${process.pid}`;
    const runsDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`, 'runs');
    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const steeringPrompt = await appendTaskMessageAsync(folder, {
        task_id: taskId,
        role: 'user',
        content: 'retry this prompt after the provider recovers',
        steering: true,
        created_at: new Date().toISOString(),
      });
      let acknowledgeAssignment!: (runId: string) => void;
      const assigned = new Promise<string>((resolve) => {
        acknowledgeAssignment = resolve;
      });
      const pending = runContainerAgent(
        { ...group, folder },
        baseInput({
          group_folder: folder,
          task_id: taskId,
          ephemeral: true,
          onPromptRunAssigned: async (runId: string) => {
            await appendTaskMessageAsync(folder, {
              task_id: taskId,
              role: 'system',
              entry_type: 'steering_assignment',
              prompt_id: steeringPrompt.id,
              run_id: runId,
              content: '',
              created_at: new Date().toISOString(),
            });
            acknowledgeAssignment(runId);
          },
          onPromptRunAccepted: async (runId: string) => {
            await appendTaskMessageAsync(folder, {
              task_id: taskId,
              role: 'system',
              entry_type: 'steering_delivery',
              prompt_id: steeringPrompt.id,
              run_id: runId,
              content: '',
              created_at: new Date().toISOString(),
            });
          },
        }) as ContainerInput,
      );

      const runId = await assigned;
      const runDir = path.join(runsDir, runId);
      expect(await getActiveRunById(runId)).toMatchObject({
        status: 'running',
      });
      expect(
        readTaskMessages(folder, taskId).filter(
          (message) =>
            message.entry_type === 'steering_assignment' &&
            message.prompt_id === steeringPrompt.id &&
            message.run_id === runId,
        ),
      ).toHaveLength(1);

      fs.writeFileSync(
        path.join(runDir, 'output.jsonl'),
        `${JSON.stringify({ type: 'error', text: 'provider overloaded' })}\n`,
      );
      fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok');
      fs.writeFileSync(path.join(runDir, 'exit_code'), '1');

      expect((await pending).status).toBe('error');
      expect(
        readTaskMessages(folder, taskId).filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === steeringPrompt.id,
        ),
      ).toHaveLength(0);
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  });

  test('fails and cleans a launched harness when durable launch acknowledgement fails', async () => {
    const folder = `launch-ack-failure-${process.pid}`;
    const taskId = `task-launch-ack-failure-${process.pid}`;
    const runsDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`, 'runs');
    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      let launchedRunId = '';
      const pending = runContainerAgent(
        { ...group, folder },
        baseInput({
          group_folder: folder,
          task_id: taskId,
          ephemeral: true,
          onRunLaunched: async (runId: string) => {
            launchedRunId = runId;
            throw new Error('receipt persistence failed');
          },
        }) as ContainerInput,
      );

      const result = await pending;
      expect(launchedRunId).toBeString();
      const runDir = path.join(runsDir, launchedRunId);

      expect(result.status).toBe('error');
      expect(result.error).toContain('receipt persistence failed');
      expect(fs.existsSync(runDir)).toBe(false);
      expect(await getActiveRunById(launchedRunId)).toMatchObject({
        status: 'error',
      });
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  });
});

// ─── Pre-aborted signal ───────────────────────────────────────────────────────

describe('runContainerAgent — pre-aborted signal', () => {
  test('returns {status:error, error:Aborted} immediately without starting the sandbox', async () => {
    const result = await runContainerAgent(
      group,
      baseInput({ signal: AbortSignal.abort() }),
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/aborted/i);
    // sandboxStart must never be called — the abort guard fires before it.
    expect(mockClient.sandboxStart.mock.calls.length).toBe(0);
  });
});

describe('direct task reasoning resolution', () => {
  test('prefers materialized task reasoning and preserves explicit suppression', () => {
    expect(
      resolveDirectReasoningEffort(
        { reasoning_effort: 'xhigh' },
        { reasoning_effort: 'medium' },
      ),
    ).toBe('xhigh');
    expect(
      resolveDirectReasoningEffort(
        { reasoning_effort: null },
        { reasoning_effort: 'medium' },
      ),
    ).toBeUndefined();
    expect(resolveDirectReasoningEffort({}, { reasoning_effort: 'high' })).toBe(
      'high',
    );
  });
});

// ─── Empty / whitespace-only prompt ──────────────────────────────────────────

describe('runContainerAgent — sandbox start failure', () => {
  test('returns {status:error} with a descriptive message when sandboxStart reports an error', async () => {
    sandboxStatusResult = { stdout: 'not running', isError: false };
    sandboxStartResult = { isError: true, stdout: 'container failed to start' };

    const result = await runContainerAgent(group, baseInput());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/failed to start sandbox/i);
    expect(result.error).toContain('container failed to start');
  });
});

describe('sandbox launch error classification', () => {
  test('recognizes a stopped service inside an otherwise running stack', () => {
    expect(isStoppedSandboxServiceError('service "php84" is not running')).toBe(
      true,
    );
    expect(
      isStoppedSandboxServiceError('service nginx failed its health check'),
    ).toBe(false);
  });

  test('falls back to a full stack restart when starting the stopped service does not recover it', async () => {
    const recoveryGroup = {
      ...group,
      folder: recoveryGroupFolder,
      settings: { defaultSandboxService: 'php84' },
    } as any;
    sandboxExecResults = [
      { stdout: 'service "php84" is not running', isError: true },
      { stdout: 'service "php84" is not running', isError: true },
      { stdout: 'launch failed after restart', isError: true },
    ];

    // This path reaches launchBackground and therefore needs its isolated IPC
    // directory; the rest of this suite intentionally keeps mkdirSync mocked.
    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(recoveryGroupDir, { recursive: true });
      const result = await runContainerAgent(
        recoveryGroup,
        baseInput({ group_folder: recoveryGroup.folder }),
      );

      expect(result.status).toBe('error');
      expect(result.error).toContain('launch failed after restart');
      expect(mockClient.sandboxStart.mock.calls.length).toBe(2);
      expect(mockClient.sandboxStop.mock.calls.length).toBe(1);
      expect(mockClient.sandboxExec.mock.calls.length).toBe(3);
    } finally {
      (fs as any).mkdirSync = () => undefined;
    }
  });
});

describe('runContainerAgent — inherited lifecycle ownership', () => {
  const owner = {
    ...group,
    name: 'Shared owner',
    folder: 'sandbox-shared-owner',
    settings: {
      isParent: true,
      sandboxOwnership: 'shared',
      defaultSandbox: 'shared-stack',
      defaultSandboxInstance: 'shared-instance',
    },
  } as any;
  const child = {
    ...group,
    name: 'Shared child',
    folder: 'sandbox-shared-child',
    parentId: owner.folder,
    settings: { workspacePath: 'child-repo' },
  } as any;

  for (const [label, status] of [
    ['stopped', { stdout: 'not running', isError: false }],
    ['missing', { stdout: 'not found', isError: false }],
    ['status error', { stdout: 'temporary MCP failure', isError: true }],
  ] as const) {
    test(`does not start the parent sandbox when child sees ${label}`, async () => {
      sandboxStatusResult = status;
      const result = await runContainerAgent(
        child,
        baseInput({ group_folder: child.folder }),
        undefined,
        {
          resolveEffectiveSandbox: (candidate) =>
            resolveEffectiveSandbox(candidate, (folder) =>
              folder === owner.folder ? owner : undefined,
            ),
        },
      );
      expect(result.status).toBe('error');
      expect(result.error).toContain('Parent-owned sandbox is unavailable');
      expect(mockClient.sandboxStart.mock.calls.length).toBe(0);
    });
  }
});

describe('runContainerAgent — task slot configuration', () => {
  test('uses the project worktree limit when the caller omits the input override', () => {
    const configuredGroup = {
      ...group,
      settings: { taskCheckoutMode: 'worktree', maxParallelWorktrees: 3 },
    } as any;

    expect(getTaskSlotLimit(configuredGroup)).toBe(3);
  });

  test('keeps shared-checkout projects serialized regardless of configured limit', () => {
    const sharedCheckoutGroup = {
      ...group,
      settings: { maxParallelWorktrees: 3 },
    } as any;

    expect(getTaskSlotLimit(sharedCheckoutGroup)).toBe(1);
  });
});

// Completion must precede release of the competing checkout, regardless of
// machine speed. Teardown also releases it if the runner detects a hang.
async function finishBeforeCheckoutRelease<T>(
  operation: Promise<T>,
  lease: Awaited<ReturnType<typeof acquireSharedCheckoutLease>>,
): Promise<T> {
  onTestFinished(async () => {
    await lease.release();
    await operation.catch(() => {});
  });
  try {
    return await operation;
  } finally {
    await lease.release();
  }
}

describe('runContainerAgent — preflight failure', () => {
  test('shared chat neither waits for nor inspects a task-owned checkout', async () => {
    const sharedGroup = {
      ...group,
      folder: `sandbox-shared-dirty-${process.pid}-${Date.now()}`,
      settings: {
        taskCheckoutMode: 'shared',
        defaultBranch: 'develop',
        repositoryLocation: '/host/project',
      },
    } satisfies RegisteredGroup;
    sandboxGitStatus = ' M src/example.ts\n';
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    const taskLease = await acquireSharedCheckoutLease(sharedGroup.folder, {
      type: 'task',
      id: 'task-holding-shared-checkout',
    });

    const runPromise = runContainerAgent(
      sharedGroup,
      baseInput({ group_folder: sharedGroup.folder }),
    );
    const result = await finishBeforeCheckoutRelease(runPromise, taskLease);
    expect(result.status).toBe('error');
    expect(result.error).not.toContain('Shared checkout drift');
    expect(mockClient.sandboxGit).not.toHaveBeenCalled();
  });

  test('branch-mode chat starts while a task branch owns the checkout', async () => {
    const folder = `sandbox-branch-chat-${process.pid}-${Date.now()}`;
    const branchGroup = {
      ...group,
      folder,
      settings: {
        taskCheckoutMode: 'branch',
        defaultBranch: 'develop',
        repositoryLocation: '/host/project',
      },
    } satisfies RegisteredGroup;
    sandboxDefaultBranch = 'task/current-work';
    sandboxGitStatus = ' M src/in-progress.ts\n';
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    const taskLease = await acquireSharedCheckoutLease(folder, {
      type: 'task',
      id: 'task-owning-current-branch',
    });

    const runPromise = runContainerAgent(
      branchGroup,
      baseInput({
        group_folder: folder,
        conversation_id: `conv-branch-chat-${process.pid}`,
      }),
    );
    const result = await finishBeforeCheckoutRelease(runPromise, taskLease);
    expect(result.status).toBe('error');
    expect(result.error).not.toContain('Shared checkout drift');
    expect(mockClient.sandboxGit).not.toHaveBeenCalled();
  });

  test('releases a manual overflow slot when setup fails before execution', async () => {
    const preflightGroup = {
      ...group,
      folder: 'sandbox-preflight-failure',
      settings: { taskCheckoutMode: 'worktree', maxParallelWorktrees: 1 },
    } satisfies RegisteredGroup;
    const automatic = await acquireGroupSlot(preflightGroup.folder, 1);
    sandboxClientError = new Error('sandbox client unavailable');

    const result = await runContainerAgent(
      preflightGroup,
      baseInput({
        group_folder: preflightGroup.folder,
        task_id: 'task-preflight-failure',
        manualParallelismOverride: true,
      }),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('sandbox client unavailable');

    sandboxClientError = null;
    const reusedOverflow = await acquireGroupSlot(preflightGroup.folder, 1, {
      bypassLimit: true,
    });
    expect(reusedOverflow.slotIndex).toBe(1);
    reusedOverflow.release();
    automatic.release();
  });
});

// ─── Mandatory worktree setup failure ───────────────────────────────────────

describe('runContainerAgent — worktree setup failure', () => {
  const worktreeGroup = {
    ...group,
    settings: { taskCheckoutMode: 'worktree' },
  } as any;

  const worktreeInput = () =>
    baseInput({
      task_id: 'task-worktree-failure',
      branch_name: 'task/test-worktree-failure',
      localRepo: '/host/project',
    });

  test('new worktree chat uses HEAD without waiting for or inspecting a dirty shared checkout', async () => {
    const folder = `sandbox-dirty-worktree-${process.pid}-${Date.now()}`;
    const dirtyWorktreeGroup = {
      ...worktreeGroup,
      folder,
    } satisfies RegisteredGroup;
    sandboxGitStatus = ' M src/unrelated.ts\n';
    sandboxWorktreeResult = {
      stdout:
        '/host/project/.worktrees/task/test-worktree-failure\n' +
        'worktree_path=/host/project/.worktrees/task/test-worktree-failure\n',
      isError: false,
    };
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    const unrelatedLease = await acquireSharedCheckoutLease(folder, {
      type: 'task',
      id: 'unrelated-task',
    });

    const runPromise = runContainerAgent(
      dirtyWorktreeGroup,
      baseInput({
        group_folder: folder,
        conversation_id: `conv-dirty-worktree-${process.pid}`,
        branch_name: 'chat/dirty-worktree',
        localRepo: '/host/project',
        worktreeRequested: true,
      }),
    );
    const result = await finishBeforeCheckoutRelease(
      runPromise,
      unrelatedLease,
    );
    expect(result.status).toBe('error');
    expect(result.error).not.toContain('Shared checkout drift');
    expect(mockClient.sandboxGit).not.toHaveBeenCalled();
    expect(
      mockClient.sandboxWorktree.mock.calls.map((call) => call[1]),
    ).toEqual(['list', 'add']);
    const addCalls = mockClient.sandboxWorktree.mock.calls.filter(
      (call) => call[1] === 'add',
    ) as unknown as Array<[string, string, { base?: string }]>;
    expect(addCalls.every((call) => call[2]?.base === undefined)).toBe(true);
  });

  test('worktree task uses its configured base without inspecting a dirty default checkout', async () => {
    const folder = `sandbox-dirty-task-worktree-${process.pid}-${Date.now()}`;
    const dirtyTaskGroup = {
      ...worktreeGroup,
      folder,
      settings: {
        taskCheckoutMode: 'worktree',
        defaultBranch: 'develop',
      },
    } satisfies RegisteredGroup;
    sandboxGitStatus = ' M src/unrelated.ts\n';
    sandboxWorktreeResult = {
      stdout: 'worktree_path=/host/project/.worktrees/task/dirty-default\n',
      isError: false,
    };
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };

    const result = await runContainerAgent(
      dirtyTaskGroup,
      baseInput({
        group_folder: folder,
        task_id: `task-dirty-default-${process.pid}`,
        branch_name: 'task/dirty-default',
        branchBaseCommit: '1'.repeat(40),
        localRepo: '/host/project',
      }),
    );

    expect(result.status).toBe('error');
    expect(result.error).not.toContain('Shared checkout drift');
    expect(mockClient.sandboxGit).not.toHaveBeenCalled();
    const addCall = mockClient.sandboxWorktree.mock.calls.find(
      (call) => call[1] === 'add',
    ) as unknown as [string, string, { base?: string }];
    expect(addCall[2]?.base).toBe('1'.repeat(40));
  });

  test('delegated chat initializes and persists its parent checkout without owning its transcript', async () => {
    const conversation = await createConversation(group.folder, {
      use_worktree: true,
    });
    const worktreePath = `/host/project/.worktrees/chat-${conversation.id}`;
    sandboxWorktreeResult = {
      stdout: `worktree_path=${worktreePath}\n`,
      isError: false,
    };
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    const input: ContainerInput = baseInput({
      branch_name: `chat-${conversation.id}`,
      localRepo: '/host/project',
      worktreeRequested: true,
      checkoutConversationId: conversation.id,
    });
    await runContainerAgent(group, input);
    expect(input.worktree_path).toBe(worktreePath);
    expect((await getConversation(conversation.id))?.worktree_path).toBe(
      worktreePath,
    );
    expect(input.conversation_id).toBeUndefined();
    expect((await getConversation(conversation.id))?.session_id).toBeNull();
  });

  test('explicit chat isolation never falls back to the main checkout when setup fails', async () => {
    for (const failure of ['error', 'throw', 'missing-path']) {
      sandboxWorktreeError = null;
      sandboxWorktreeResult = { stdout: '', isError: false };
      if (failure === 'error')
        sandboxWorktreeResult = { stdout: 'setup failed', isError: true };
      if (failure === 'throw')
        sandboxWorktreeError = new Error('connection failed');
      mockClient.sandboxExec.mockClear();
      mockClient.sandboxGit.mockClear();
      const result = await runContainerAgent(
        group,
        baseInput({
          branch_name: 'chat-parent',
          localRepo: '/host/project',
          worktreeRequested: true,
        }),
      );
      expect(result.status).toBe('error');
      expect(mockClient.sandboxExec).not.toHaveBeenCalled();
      expect(mockClient.sandboxGit).not.toHaveBeenCalled();
    }
  });

  test('finalizes the active run when sandboxWorktree reports an error', async () => {
    sandboxWorktreeResult = { stdout: 'worktree mount failed', isError: true };

    const result = await runContainerAgent(worktreeGroup, worktreeInput());

    expect(result.status).toBe('error');
    expect(result.error).toContain('Worktree creation failed');
    expect(await getActiveRunForTask('task-worktree-failure')).toBeUndefined();
  });

  test('finalizes the active run when sandboxWorktree throws', async () => {
    sandboxWorktreeError = new Error('sandbox connection died');

    const result = await runContainerAgent(worktreeGroup, worktreeInput());

    expect(result.status).toBe('error');
    expect(result.error).toContain('sandbox connection died');
    expect(await getActiveRunForTask('task-worktree-failure')).toBeUndefined();
  });

  test('runs checkout-ready preflight after sandbox startup and worktree recovery but before launch', async () => {
    sandboxStatusResult = { stdout: 'not running', isError: false };
    sandboxWorktreeResult = {
      stdout:
        'worktree_path=/host/project/.worktrees/task/test-worktree-failure\n',
      isError: false,
    };
    let preflightRan = false;
    const input = {
      ...worktreeInput(),
      onCheckoutReady: async (readyInput, readyTarget) => {
        preflightRan = true;
        expect(mockClient.sandboxStart).toHaveBeenCalledTimes(1);
        expect(mockClient.sandboxWorktree.mock.calls.length).toBeGreaterThan(0);
        expect(readyTarget).toEqual({
          stack: 'carapa-bot',
          service: 'agent',
          instance: 'test-sandbox-proj',
        });
        expect(readyInput.worktree_path).toBe(
          '/host/project/.worktrees/task/test-worktree-failure',
        );
        expect(
          await getActiveRunForTask('task-worktree-failure'),
        ).toBeUndefined();
        throw new Error('synthetic checkout preflight failure');
      },
    } satisfies ContainerInput;

    const result = await runContainerAgent(worktreeGroup, input);

    expect(preflightRan).toBe(true);
    expect(result.status).toBe('error');
    expect(result.error).toContain('synthetic checkout preflight failure');
    expect(mockClient.sandboxExec).not.toHaveBeenCalled();
    expect(await getActiveRunForTask('task-worktree-failure')).toBeUndefined();
  });

  test('scopes inherited worktree creation to the child repository', async () => {
    const owner = {
      ...worktreeGroup,
      folder: 'shared-worktree-owner',
      settings: {
        isParent: true,
        sandboxOwnership: 'shared',
        sharedWorkspaceContainerRoot: '/var/www/shop',
      },
    } as any;
    const child = {
      ...worktreeGroup,
      folder: 'shared-worktree-child',
      parentId: owner.folder,
      settings: {
        taskCheckoutMode: 'worktree',
        workspacePath: 'backend',
      },
    } as any;
    sandboxWorktreeResult = { stdout: 'worktree mount failed', isError: true };

    await runContainerAgent(
      child,
      baseInput({
        ...worktreeInput(),
        group_folder: child.folder,
      }),
      undefined,
      {
        resolveEffectiveSandbox: (candidate) =>
          resolveEffectiveSandbox(candidate, (folder) =>
            folder === owner.folder ? owner : undefined,
          ),
      },
    );

    const worktreeCalls = mockClient.sandboxWorktree.mock
      .calls as unknown as Array<[string, string, Record<string, unknown>]>;
    expect(worktreeCalls.find((call) => call[1] === 'add')?.[2]).toMatchObject({
      localRepo: '/host/project',
      repoPath: '/var/www/shop/backend',
    });
  });

  test('recovers a persisted branch worktree when its database path was cleared', async () => {
    sandboxGitStatus = ' M src/unrelated.ts\n';
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    sandboxWorktreeListResult = {
      stdout:
        'worktree /workspace/test-sandbox-proj/.worktrees/task/test-worktree-failure\n' +
        'HEAD 1234567890abcdef\n' +
        'branch refs/heads/task/test-worktree-failure\n\n',
      isError: false,
    };
    const input = worktreeInput() as ContainerInput;

    const result = await runContainerAgent(worktreeGroup, input);

    expect(result.status).toBe('error');
    expect(result.error).not.toContain('Shared checkout drift');
    expect(input.worktree_path).toBe(
      '/host/project/.worktrees/task/test-worktree-failure',
    );
    expect(input.skipBaseBranchSync).toBe(true);
    expect(mockClient.sandboxGit).not.toHaveBeenCalled();
    expect(
      mockClient.sandboxWorktree.mock.calls.map((call) => call[1]),
    ).toEqual(['list', 'reuse']);
  });

  test('does not acquire the shared checkout for an existing chat worktree', async () => {
    const folder = `sandbox-recovered-chat-worktree-${process.pid}-${Date.now()}`;
    const recoveredGroup = {
      ...group,
      folder,
      settings: {
        taskCheckoutMode: 'worktree',
        repositoryLocation: '/host/project',
      },
    } satisfies RegisteredGroup;
    const conversationId = `conv-recovered-worktree-${process.pid}`;
    const branch = 'task/recovered-chat-worktree';
    sandboxWorktreeListResult = {
      stdout:
        `worktree /workspace/${folder}/.worktrees/${branch}\n` +
        'HEAD 1234567890abcdef\n' +
        `branch refs/heads/${branch}\n\n`,
      isError: false,
    };
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    const unrelatedLease = await acquireSharedCheckoutLease(folder, {
      type: 'task',
      id: 'unrelated-task',
    });
    const runPromise = runContainerAgent(
      recoveredGroup,
      baseInput({
        group_folder: folder,
        conversation_id: conversationId,
        branch_name: branch,
        localRepo: '/host/project',
        worktreeRequested: true,
      }),
    );
    const result = await finishBeforeCheckoutRelease(
      runPromise,
      unrelatedLease,
    );
    expect(result.status).toBe('error');
  });

  test('recreates a prunable branch worktree instead of restoring its missing path', async () => {
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    sandboxWorktreeListResult = {
      stdout:
        'worktree /workspace/test-sandbox-proj/.worktrees/task/test-worktree-failure\n' +
        'HEAD 1234567890abcdef\n' +
        'branch refs/heads/task/test-worktree-failure\n' +
        'prunable gitdir file points to non-existent location\n\n',
      isError: false,
    };
    sandboxWorktreeResult = {
      stdout:
        'worktree_path=/host/project/.worktrees/task/test-worktree-failure\n' +
        'Worktree created',
      isError: false,
    };
    const input = worktreeInput() as ContainerInput;

    const result = await runContainerAgent(worktreeGroup, input);

    expect(result.status).toBe('error');
    expect(input.worktree_path).toBe(
      '/host/project/.worktrees/task/test-worktree-failure',
    );
    expect(input.skipBaseBranchSync).not.toBe(true);
    expect(
      mockClient.sandboxWorktree.mock.calls.map((call) => call[1]),
    ).toEqual(['list', 'add']);
  });

  test('can reuse a conflict-resolution worktree without syncing the default branch', async () => {
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    const existingWorktreeInput = {
      ...worktreeInput(),
      worktree_path: '/host/project/.worktrees/task/test-worktree-failure',
    };

    const result = await runContainerAgent(
      worktreeGroup,
      existingWorktreeInput,
    );
    expect(result.status).toBe('error');
    expect(mockClient.sandboxGit.mock.calls.length).toBe(0);
    expect(mockClient.sandboxWorktree.mock.calls.length).toBe(1);
    expect(mockClient.sandboxWorktree.mock.calls[0]?.[1]).toBe('reuse');
  });

  test('provisions a persisted worktree only after positive absence', async () => {
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    sandboxWorktreeReuseResult = {
      stdout: 'worktree_missing=1',
      isError: false,
    };
    sandboxWorktreeResult = {
      stdout:
        'worktree_path=/host/project/.worktrees/task/test-worktree-failure\n',
      isError: false,
    };
    await runContainerAgent(worktreeGroup, {
      ...worktreeInput(),
      worktree_path: '/host/project/.worktrees/task/test-worktree-failure',
    });
    expect(
      mockClient.sandboxWorktree.mock.calls.map((call) => call[1]),
    ).toEqual(['reuse', 'add']);
  });

  test('refuses to provision or launch on reuse failure', async () => {
    sandboxWorktreeReuseResult = { stdout: 'wrong checkout', isError: true };
    const result = await runContainerAgent(worktreeGroup, {
      ...worktreeInput(),
      worktree_path: '/host/project/.worktrees/task/test-worktree-failure',
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('wrong checkout');
    expect(
      mockClient.sandboxWorktree.mock.calls.map((call) => call[1]),
    ).toEqual(['reuse']);
    expect(mockClient.sandboxExec).not.toHaveBeenCalled();
  });

  test('passes the existing preview URL through consecutive stage launches without provisioning', async () => {
    const folder = `worktree-stage-preview-${process.pid}`;
    const ipcRoot = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const prompts: string[] = [];
    (fs as any).mkdirSync = realMkdirSync;
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    sandboxExecObserver = (_stack, _service, command) => {
      if (!command.startsWith('run-agent.sh ')) return;
      const runId = command.trim().split('/').at(-1)!;
      prompts.push(
        fs.readFileSync(
          path.join(ipcRoot, 'runs', runId, 'prompt.txt'),
          'utf8',
        ),
      );
    };
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      for (const stage of ['in_progress', 'testing', 'review']) {
        await runContainerAgent(
          { ...worktreeGroup, folder },
          baseInput({
            group_folder: folder,
            task_id: `task-stage-preview-${process.pid}`,
            stage_id: stage,
            branch_name: 'preview-task',
            localRepo: '/host/project',
            worktree_path: '/host/project/.worktrees/preview-task',
          }),
        );
      }
      expect(
        mockClient.sandboxWorktree.mock.calls.map((call) => call[1]),
      ).toEqual(['reuse', 'reuse', 'reuse']);
      expect(prompts).toHaveLength(3);
      for (const prompt of prompts)
        expect(prompt).toContain('http://nginx:8083/');
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipcRoot, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  });

  test('writes user-command.txt beside prompt.txt only when the input carries a user command', async () => {
    const folder = `user-command-file-${process.pid}`;
    const ipc = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const captured: Array<{ command: string | null; prompt: string }> = [];
    (fs as any).mkdirSync = realMkdirSync;
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    sandboxExecObserver = (_stack, _service, command) => {
      if (!command.startsWith('run-agent.sh ')) return;
      const runDir = path.join(ipc, 'runs', command.trim().split('/').at(-1)!);
      const file = path.join(runDir, 'user-command.txt');
      captured.push({
        command: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
        prompt: fs.readFileSync(path.join(runDir, 'prompt.txt'), 'utf8'),
      });
    };
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      await runContainerAgent(
        { ...group, folder },
        baseInput({
          group_folder: folder,
          prompt: '/goal tests pass',
          userCommand: '/goal tests pass',
        }),
      );
      await runContainerAgent(
        { ...group, folder },
        baseInput({ group_folder: folder, prompt: 'plain text' }),
      );
      expect(captured.map((run) => run.command)).toEqual([
        '/goal tests pass',
        null,
      ]);
      expect(captured[0]!.prompt).toContain('/goal tests pass');
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipc, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  });

  test('puts the conversation id in the AGENT_CONTEXT of a chat run only', async () => {
    const folder = `agent-context-conversation-${process.pid}`;
    const ipc = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const prompts: string[] = [];
    (fs as any).mkdirSync = realMkdirSync;
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    sandboxExecObserver = (_stack, _service, command) => {
      if (!command.startsWith('run-agent.sh ')) return;
      const runDir = path.join(ipc, 'runs', command.trim().split('/').at(-1)!);
      prompts.push(fs.readFileSync(path.join(runDir, 'prompt.txt'), 'utf8'));
    };
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      await runContainerAgent(
        { ...group, folder },
        baseInput({ group_folder: folder, conversation_id: 'conv-ctx-1' }),
      );
      await runContainerAgent(
        { ...group, folder },
        baseInput({ group_folder: folder }),
      );
      expect(prompts[0]).toContain('conversation_id=conv-ctx-1');
      expect(prompts[1]).toContain('[AGENT_CONTEXT:');
      expect(prompts[1]).not.toContain('conversation_id=');
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipc, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  });

  test('writes system-prompt.txt beside prompt.txt only when args carry a system prompt', async () => {
    const folder = `system-prompt-file-${process.pid}`;
    const ipc = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const captured: Array<{ file: string | null; args: string }> = [];
    (fs as any).mkdirSync = realMkdirSync;
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    sandboxExecObserver = (_stack, _service, command) => {
      if (!command.startsWith('run-agent.sh ')) return;
      const runDir = path.join(ipc, 'runs', command.trim().split('/').at(-1)!);
      const file = path.join(runDir, 'system-prompt.txt');
      captured.push({
        file: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
        args: JSON.parse(
          fs.readFileSync(path.join(runDir, 'args.json'), 'utf8'),
        ).systemPrompt,
      });
    };
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      await runContainerAgent(
        { ...group, folder },
        baseInput({ group_folder: folder, systemPrompt: 'Exact rules.\n' }),
      );
      await runContainerAgent(
        { ...group, folder },
        baseInput({
          group_folder: folder,
          systemPrompt: 'Exact rules.\n',
          injectAgentContext: false,
        }),
      );
      expect(captured).toEqual([
        { file: 'Exact rules.\n', args: 'Exact rules.\n' },
        { file: null, args: '' },
      ]);
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipc, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  });

  test('direct agents also reuse an existing worktree without touching the shared checkout', async () => {
    const input = {
      ...worktreeInput(),
      worktree_path: '/host/project/.worktrees/task/test-worktree-failure',
      skipSharedCheckoutLease: true,
    };
    sandboxGitStatus = ' M src/unrelated.ts\n';

    await prepareDirectTaskCheckout(
      worktreeGroup,
      input,
      mockClient as any,
      resolveEffectiveSandbox(worktreeGroup),
      'carapa-bot',
      'agent',
      'test-instance',
    );

    expect(mockClient.sandboxGit).not.toHaveBeenCalled();
    expect(mockClient.sandboxWorktree).not.toHaveBeenCalled();
  });

  test('direct agents create a worktree without waiting for the dirty shared checkout', async () => {
    const folder = `direct-dirty-worktree-${process.pid}-${Date.now()}`;
    const directWorktreeGroup = {
      ...worktreeGroup,
      folder,
    } satisfies RegisteredGroup;
    sandboxGitStatus = ' M src/unrelated.ts\n';
    sandboxWorktreeResult = {
      stdout: 'worktree_path=/host/project/.worktrees/task/direct-worktree\n',
      isError: false,
    };
    const unrelatedLease = await acquireSharedCheckoutLease(folder, {
      type: 'task',
      id: 'unrelated-task',
    });
    const input = baseInput({
      group_folder: folder,
      branch_name: 'task/direct-worktree',
      localRepo: '/host/project',
      worktreeRequested: true,
    });

    const preparation = prepareDirectTaskCheckout(
      directWorktreeGroup,
      input,
      mockClient as any,
      resolveEffectiveSandbox(directWorktreeGroup),
      'carapa-bot',
      'agent',
      'test-instance',
    );
    await finishBeforeCheckoutRelease(preparation, unrelatedLease);
    expect(mockClient.sandboxGit).not.toHaveBeenCalled();
    expect(mockClient.sandboxWorktree).toHaveBeenCalledTimes(2);
    const addCall = mockClient.sandboxWorktree.mock.calls.find(
      (call) => call[1] === 'add',
    ) as unknown as [string, string, { base?: string }];
    expect(addCall[2]?.base).toBeUndefined();
  });

  test('Direct-LLM run creates its worktree from the prepared fork commit', async () => {
    const forkCommit = 'f'.repeat(40);
    sandboxWorktreeResult = {
      stdout:
        'worktree_path=/host/project/.worktrees/task/test-worktree-failure\n',
      isError: false,
    };

    await runContainerAgent(
      worktreeGroup,
      baseInput({
        ...worktreeInput(),
        agent_cmd: 'llm:test-model',
        runtimeConfig: {
          id: 'llm:test-model',
          model: 'test-model',
          baseUrl: 'http://direct.invalid/v1',
        },
        prepareCheckout: async () => ({ branchBaseCommit: forkCommit }),
      }) as ContainerInput,
      undefined,
      { resolveEffectiveSandbox, runDirectLlm: runDirectLlm as any },
    );

    const addCall = mockClient.sandboxWorktree.mock.calls.find(
      (call) => call[1] === 'add',
    ) as unknown as [string, string, { base?: string }];
    expect(addCall[2]?.base).toBe(forkCommit);
  });

  test('failed direct worktree creation does not switch the main checkout', async () => {
    sandboxWorktreeResult = { stdout: 'worktree add failed', isError: true };

    await expect(
      prepareDirectTaskCheckout(
        worktreeGroup,
        worktreeInput(),
        mockClient as any,
        resolveEffectiveSandbox(worktreeGroup),
        'carapa-bot',
        'agent',
        'test-instance',
      ),
    ).rejects.toThrow('Worktree creation failed');

    expect(
      mockClient.sandboxWorktree.mock.calls.map((call) => call[1]),
    ).toEqual(['list', 'add']);
    expect(mockClient.sandboxGit).not.toHaveBeenCalled();
  });
});

describe('prepareDirectTaskCheckout — owned branch failure cleanup', () => {
  test('preflight rejection leaves an unexpected or dirty checkout untouched and releases its lease', async () => {
    for (const [name, currentBranch, status] of [
      ['unexpected', 'task/unrelated', ''],
      ['dirty', 'paged_kv', ' M src/unrelated.ts\n'],
    ] as const) {
      const folder = `direct-${name}-preflight-${process.pid}-${Date.now()}`;
      const branchGroup = {
        ...group,
        folder,
        settings: { taskCheckoutMode: 'branch', defaultBranch: 'paged_kv' },
      } satisfies RegisteredGroup;
      sandboxDefaultBranch = currentBranch;
      sandboxGitStatus = status;
      mockClient.sandboxGit.mockClear();

      await expect(
        prepareDirectTaskCheckout(
          branchGroup,
          baseInput({
            group_folder: folder,
            task_id: `task-${name}-preflight`,
            branch_name: 'task/retry-branch',
          }),
          mockClient as any,
          resolveEffectiveSandbox(branchGroup),
          'carapa-bot',
          'agent',
          'test-instance',
        ),
      ).rejects.toThrow('Shared checkout drift');

      expect(
        mockClient.sandboxGit.mock.calls.map((call) => String(call[1])),
      ).toEqual(['status --porcelain=v1', 'branch --show-current']);
      const nextLease = await acquireSharedCheckoutLease(folder, {
        type: 'task',
        id: `task-after-${name}-preflight`,
      });
      await nextLease.release();
    }
  });

  test('restores an owned checkout after branch setup changed it and dependency validation fails', async () => {
    const folder = `direct-owned-cleanup-${process.pid}-${Date.now()}`;
    const branchGroup = {
      ...group,
      folder,
      settings: { taskCheckoutMode: 'branch', defaultBranch: 'paged_kv' },
    } satisfies RegisteredGroup;
    sandboxDefaultBranch = 'paged_kv';
    sandboxMissingDependency = true;

    await expect(
      prepareDirectTaskCheckout(
        branchGroup,
        baseInput({
          group_folder: folder,
          task_id: 'task-owned-cleanup',
          branch_name: 'task/retry-branch',
          requiredDependencyCommits: ['1'.repeat(40)],
          dependencyByCommit: {
            ['1'.repeat(40)]: { id: 'task-dep-1', title: 'Add paged KV' },
          },
        }),
        mockClient as any,
        resolveEffectiveSandbox(branchGroup),
        'carapa-bot',
        'agent',
        'test-instance',
      ),
    ).rejects.toThrow(
      `Dependency task-dep-1 ("Add paged KV") commit ${'1'.repeat(40)} is not present in the direct task checkout: the task branch predates this dependency. Use Start over, or merge paged_kv into the task branch.`,
    );

    const gitArgs = mockClient.sandboxGit.mock.calls.map((call) =>
      String(call[1]),
    );
    expect(gitArgs.filter((args) => args === 'checkout paged_kv')).toHaveLength(
      2,
    );
    expect(gitArgs.slice(-3)).toEqual([
      'status --porcelain=v1',
      'branch --show-current',
      'checkout paged_kv',
    ]);
    const nextLease = await acquireSharedCheckoutLease(folder, {
      type: 'task',
      id: 'task-after-owned-cleanup',
    });
    await nextLease.release();
  });

  test('restores a checkout changed under a caller-owned lease without releasing that lease', async () => {
    const folder = `direct-caller-owned-cleanup-${process.pid}-${Date.now()}`;
    const taskId = 'task-caller-owned-cleanup';
    const branchGroup = {
      ...group,
      folder,
      settings: { taskCheckoutMode: 'branch', defaultBranch: 'paged_kv' },
    } satisfies RegisteredGroup;
    sandboxDefaultBranch = 'paged_kv';
    sandboxMissingDependency = true;
    const callerLease = await acquireSharedCheckoutLease(folder, {
      type: 'task',
      id: taskId,
    });

    try {
      await expect(
        prepareDirectTaskCheckout(
          branchGroup,
          baseInput({
            group_folder: folder,
            task_id: taskId,
            branch_name: 'task/retry-branch',
            branchBaseName: 'task/dependency-base',
            requiredDependencyCommits: ['1'.repeat(40)],
            skipSharedCheckoutLease: true,
          }),
          mockClient as any,
          resolveEffectiveSandbox(branchGroup),
          'carapa-bot',
          'agent',
          'test-instance',
        ),
      ).rejects.toThrow(
        `Dependency commit ${'1'.repeat(40)} is not present in the direct task checkout: the task branch predates this dependency. Use Start over, or merge paged_kv into the task branch.`,
      );

      const gitArgs = mockClient.sandboxGit.mock.calls.map((call) =>
        String(call[1]),
      );
      expect(gitArgs).toContain('checkout task/dependency-base');
      expect(gitArgs.slice(-3)).toEqual([
        'status --porcelain=v1',
        'branch --show-current',
        'checkout paged_kv',
      ]);
      expect(await callerLease.heartbeat()).toBe(true);
    } finally {
      await callerLease.release();
    }

    const nextLease = await acquireSharedCheckoutLease(folder, {
      type: 'task',
      id: 'task-after-caller-owned-cleanup',
    });
    await nextLease.release();
  });
});

test('cold branch mode starts the service and uses the local base without remote synchronization', async () => {
  // The Compose project may still have running sidecars while its configured
  // agent service is stopped. A service-filtered status reports no container.
  sandboxStatusResult = { stdout: '[]', isError: false };
  sandboxDefaultBranch = 'paged_kv';
  sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
  mockClient.sandboxGit.mockClear();
  mockClient.sandboxWorktree.mockClear();
  const branchTaskId = `task-branch-sync-${process.pid}-${Date.now()}`;
  const branchGroup = {
    ...group,
    folder: `branch-sync-${process.pid}-${Date.now()}`,
    settings: { taskCheckoutMode: 'branch', defaultBranch: 'paged_kv' },
  } satisfies RegisteredGroup;
  let checkoutPrepared = false;
  const result = await runContainerAgent(
    branchGroup,
    baseInput({
      group_folder: branchGroup.folder,
      task_id: branchTaskId,
      branch_name: 'task/paged-kv-work',
      localRepo: '/host/project',
      skipSharedCheckoutLease: true,
      prepareCheckout: async () => {
        checkoutPrepared = true;
        return { branchBaseCommit: '1'.repeat(40) };
      },
    }),
  );
  expect(result.status).toBe('error');
  expect(mockClient.sandboxStatus).toHaveBeenCalledWith(
    'carapa-bot',
    branchGroup.folder,
    'agent',
  );
  expect(mockClient.sandboxStart.mock.calls.length).toBe(1);
  expect(checkoutPrepared).toBe(true);
  const gitArgs = mockClient.sandboxGit.mock.calls.map((call) =>
    String(call[1]),
  );
  expect(gitArgs.some((args) => args.includes('fetch origin'))).toBe(false);
  expect(gitArgs.some((args) => args.includes('pull origin'))).toBe(false);
  expect(mockClient.sandboxWorktree.mock.calls.length).toBe(0);
});

test('branch mode reuses a clean existing task branch for a later stage', async () => {
  sandboxDefaultBranch = 'paged_kv';
  branchCreated = true;
  sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
  mockClient.sandboxGit.mockClear();
  const branchGroup = {
    ...group,
    folder: `branch-reuse-${process.pid}-${Date.now()}`,
    settings: { taskCheckoutMode: 'branch', defaultBranch: 'paged_kv' },
  } satisfies RegisteredGroup;
  let checkoutPrepared = false;

  const result = await runContainerAgent(
    branchGroup,
    baseInput({
      group_folder: branchGroup.folder,
      task_id: `task-branch-reuse-${process.pid}`,
      branch_name: 'task/retry-branch',
      localRepo: '/host/project',
      skipSharedCheckoutLease: true,
      prepareCheckout: async () => {
        checkoutPrepared = true;
        return { branchBaseName: 'paged_kv' };
      },
    }),
  );

  expect(result.status).toBe('error');
  expect(result.error).not.toContain('Shared checkout drift');
  expect(checkoutPrepared).toBe(true);
  const gitArgs = mockClient.sandboxGit.mock.calls.map((call) =>
    String(call[1]),
  );
  expect(gitArgs).not.toContain('checkout paged_kv');
  expect(gitArgs).not.toContain('checkout task/retry-branch');
  expect(gitArgs.some((args) => args.includes('checkout -b'))).toBe(false);
});

test('branch mode names the dependency when the reused task branch lacks its commit', async () => {
  sandboxDefaultBranch = 'paged_kv';
  branchCreated = true;
  sandboxMissingDependency = true;
  mockClient.sandboxGit.mockClear();
  const branchGroup = {
    ...group,
    folder: `branch-missing-dependency-${process.pid}-${Date.now()}`,
    settings: { taskCheckoutMode: 'branch', defaultBranch: 'paged_kv' },
  } satisfies RegisteredGroup;
  const commit = '2'.repeat(40);

  const result = await runContainerAgent(
    branchGroup,
    baseInput({
      group_folder: branchGroup.folder,
      task_id: `task-branch-missing-dependency-${process.pid}`,
      branch_name: 'task/retry-branch',
      localRepo: '/host/project',
      skipSharedCheckoutLease: true,
      prepareCheckout: async () => ({
        branchBaseName: 'paged_kv',
        requiredDependencyCommits: [commit],
        dependencyByCommit: { [commit]: { id: 'task-dep-2', title: 'Base' } },
      }),
    }),
  );

  expect(result.status).toBe('error');
  expect(result.error).toContain(
    `Dependency task-dep-2 ("Base") commit ${commit} is not present in the task checkout: the task branch predates this dependency. Use Start over, or merge paged_kv into the task branch.`,
  );
});

test('branch mode resumes a dirty existing task branch without resetting it', async () => {
  sandboxDefaultBranch = 'paged_kv';
  branchCreated = true;
  sandboxGitStatus = ' M src/unfinished.cpp\n';
  sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
  mockClient.sandboxGit.mockClear();
  const branchGroup = {
    ...group,
    folder: `branch-dirty-resume-${process.pid}-${Date.now()}`,
    settings: { taskCheckoutMode: 'branch', defaultBranch: 'paged_kv' },
  } satisfies RegisteredGroup;

  const result = await runContainerAgent(
    branchGroup,
    baseInput({
      group_folder: branchGroup.folder,
      task_id: `task-branch-dirty-resume-${process.pid}`,
      branch_name: 'task/retry-branch',
      localRepo: '/host/project',
      skipSharedCheckoutLease: true,
    }),
  );

  expect(result.status).toBe('error');
  expect(result.error).not.toContain('Shared checkout drift');
  const gitArgs = mockClient.sandboxGit.mock.calls.map((call) =>
    String(call[1]),
  );
  expect(gitArgs).not.toContain('checkout paged_kv');
  expect(gitArgs).not.toContain('checkout task/retry-branch');
  expect(gitArgs.some((args) => args.includes('checkout -b'))).toBe(false);
});

test('branch checkout state accepts dirty task state but not a dirty default checkout', () => {
  const dirty = { stdout: ' M src/unfinished.cpp\n', isError: false };
  expect(
    branchCheckoutStateIsSafe(
      dirty,
      { stdout: 'task/retry-branch\n', isError: false },
      'paged_kv',
      'task/retry-branch',
    ),
  ).toBe(true);
  expect(
    branchCheckoutStateIsSafe(
      dirty,
      { stdout: 'paged_kv\n', isError: false },
      'paged_kv',
      'task/retry-branch',
    ),
  ).toBe(false);
});

test('direct branch checkout also uses only local Git operations', async () => {
  sandboxDefaultBranch = 'paged_kv';
  branchCreated = false;
  mockClient.sandboxGit.mockClear();
  const branchGroup = {
    ...group,
    settings: { taskCheckoutMode: 'branch', defaultBranch: 'paged_kv' },
  } satisfies RegisteredGroup;

  await prepareDirectTaskCheckout(
    branchGroup,
    baseInput({ branch_name: 'task/retry-branch' }),
    mockClient as any,
    resolveEffectiveSandbox(branchGroup),
    'carapa-bot',
    'agent',
    'test-instance',
  );

  const gitArgs = mockClient.sandboxGit.mock.calls.map((call) =>
    String(call[1]),
  );
  expect(gitArgs).toContain('checkout paged_kv');
  expect(gitArgs).toContain('checkout -b task/retry-branch');
  expect(gitArgs.some((args) => args.includes('fetch origin'))).toBe(false);
  expect(gitArgs.some((args) => args.includes('pull origin'))).toBe(false);
});

// ─── Session-retry deadline parity ───────────────────────────────────────────

test.each([
  // An explicit Workspace Path pins the worktree beneath it; without one it is
  // beneath the service's working dir (/workspace/<folder> need not exist there).
  ['an explicit Workspace Path', true],
  ['no Workspace Path', false],
])(
  'conversation worktree launches and browser descriptors use sandbox paths on creation and reuse with %s',
  async (_label, explicitWorkspace) => {
    const folder = `chat-worktree-path-${explicitWorkspace ? 'ws' : 'svc'}-${process.pid}`;
    const ipc = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const branch = 'chat/nested';
    const hostPath = `/var/www/project/.worktrees/${branch}`;
    const containerPath = explicitWorkspace
      ? `/workspace/${folder}/.worktrees/${branch}`
      : `/srv/service/.worktrees/${branch}`;
    const chatGroup = {
      ...group,
      folder,
      settings: explicitWorkspace
        ? { workspacePath: `/workspace/${folder}` }
        : {},
    };
    const launched: Record<string, any>[] = [];
    (fs as any).mkdirSync = realMkdirSync;
    sandboxWorktreeResult = {
      stdout: `worktree_path=${hostPath}\n`,
      isError: false,
    };
    sandboxWorktreeReuseResult = sandboxWorktreeResult;
    sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
    sandboxExecObserver = (_stack, _service, command) => {
      if (!command.startsWith('run-agent.sh ')) return;
      const runId = command.trim().split('/').at(-1)!;
      launched.push(
        JSON.parse(
          fs.readFileSync(path.join(ipc, 'runs', runId, 'args.json'), 'utf8'),
        ),
      );
    };
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      for (const reused of [false, true]) {
        const result = await runContainerAgent(
          chatGroup,
          baseInput({
            group_folder: folder,
            conversation_id: 'chat-worktree-path',
            branch_name: branch,
            localRepo: '/var/www/project',
            worktreeRequested: true,
            worktree_path: reused ? hostPath : undefined,
            injectAgentContext: false,
          }),
        );
        expect(result.error).toContain('agent launch stopped');
      }
      expect(launched).toHaveLength(2);
      for (const args of launched) {
        expect(args.workDir).toBe(containerPath);
        expect(args.env.CARAPA_BROWSER_WORK_DIR).toBe(containerPath);
        const descriptor = JSON.parse(
          fs.readFileSync(
            path.join(
              ipc,
              'browser-sessions',
              `${args.env.CARAPA_BROWSER_SESSION_ID}.json`,
            ),
            'utf8',
          ),
        );
        expect(descriptor.workDir).toBe(containerPath);
        expect(descriptor.worktree).toBe(hostPath);
      }
      expect(launched[1].env.CARAPA_BROWSER_SESSION_ID).toBe(
        launched[0].env.CARAPA_BROWSER_SESSION_ID,
      );
      expect(
        mockClient.sandboxWorktree.mock.calls.map((call) => call[1]),
      ).toEqual(['list', 'add', 'reuse']);
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipc, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  },
);

test('Board launches ACP with stable chat ownership and never retries missing history as a fresh session', async () => {
  const folder = `acp-chat-ownership-${process.pid}`;
  const ipc = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
  const runs = path.join(ipc, 'runs');
  const launched: Record<string, any>[] = [];
  (fs as any).mkdirSync = realMkdirSync;
  const outside = path.join(os.tmpdir(), `mcp-outside-${process.pid}.json`);
  try {
    fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
    // Security: a planted .mcp.json link is replaced by the launch sync, not written through.
    fs.writeFileSync(outside, 'OUTSIDE');
    fs.symlinkSync(outside, path.join(GROUPS_DIR, folder, '.mcp.json'));
    for (const resumed of [false, true]) {
      const launches = launchedRuns(runs);
      const pending = runContainerAgent(
        { ...group, folder },
        baseInput({
          onRunLaunched: launches.onRunLaunched,
          group_folder: folder,
          agent_cmd: 'antigravity-acp',
          conversation_id: 'acp-chat',
          session_id: resumed ? 'native-acp' : undefined,
          model: 'gemini-3.5-flash-low',
          injectAgentContext: false,
        }),
      );
      const run = await launches.next();
      launched.push(
        JSON.parse(fs.readFileSync(path.join(run!, 'args.json'), 'utf8')),
      );
      fs.writeFileSync(
        path.join(run!, 'output.jsonl'),
        JSON.stringify(
          resumed
            ? {
                type: 'turn.failed',
                error: {
                  message: 'Session not found in the current GEMINI_HOME',
                },
              }
            : {
                type: 'result',
                subtype: 'success',
                result: 'hello',
                session_id: 'native-acp',
              },
        ) + '\n',
      );
      writeRunV1Result(
        run!,
        resumed
          ? {
              result: 'Session not found in the current GEMINI_HOME',
              failed: true,
            }
          : { result: 'hello', sessionId: 'native-acp' },
      );
      fs.writeFileSync(path.join(run!, 'metrics_complete'), 'ok');
      fs.writeFileSync(path.join(run!, 'exit_code'), resumed ? '1' : '0');
      const result = await pending;
      expect(result.status).toBe(resumed ? 'error' : 'success');
    }
    expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE');
    expect(
      fs.lstatSync(path.join(GROUPS_DIR, folder, '.mcp.json')).isFile(),
    ).toBe(true);
    expect(launched[0]).toMatchObject({
      persistent: PERSISTENT_CLAUDE ? '1' : '',
      conversationId: 'acp-chat',
      agentCmd: 'antigravity-acp',
    });
    if (PERSISTENT_CLAUDE)
      expect(launched[0].conversationKey).toMatch(/^acp-chat-[0-9a-f]{8}$/);
    expect(launched[1].conversationKey).toBe(launched[0].conversationKey);
    expect(launched[1].sessionId).toBe('native-acp');
    const commands = mockClient.sandboxExec.mock.calls.map((call) => call[2]);
    expect(
      commands.filter((command) => command.startsWith('run-agent.sh ')),
    ).toHaveLength(2);
    expect(
      commands.filter((command) => command.startsWith('browser-close ')),
    ).toHaveLength(0);
    expect(launched[0].env.CARAPA_RECORD).toBe('0');
    expect(launched[0].env.CARAPA_BROWSER_RUN_ID).toBeTruthy();
    expect(launched[1].env.CARAPA_BROWSER_RUN_ID).not.toBe(
      launched[0].env.CARAPA_BROWSER_RUN_ID,
    );
    expect(launched[0].env.CARAPA_BROWSER_SESSION_ID).toBeTruthy();
    // Custom stacks own their cwd; browser setup must not invent a repository mount.
    for (const args of launched) {
      expect(args.workDir).toBe('');
      expect(args.env.CARAPA_BROWSER_WORK_DIR).toBe('');
    }
    expect(launched[1].env.CARAPA_BROWSER_SESSION_ID).toBe(
      launched[0].env.CARAPA_BROWSER_SESSION_ID,
    );
    expect(launched[1].env.PLAYWRIGHT_DAEMON_SESSION_DIR).toBe(
      launched[0].env.PLAYWRIGHT_DAEMON_SESSION_DIR,
    );
  } finally {
    (fs as any).mkdirSync = () => undefined;
    fs.rmSync(outside, { force: true });
    fs.rmSync(ipc, { recursive: true, force: true });
    fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
  }
}, 30_000);

describe('runContainerAgent — session-retry deadline parity', () => {
  test('keeps chat session retries exempt from the hard wall-clock deadline', async () => {
    const folder = `chat-retry-deadline-${process.pid}`;
    const retryGroup = { ...group, folder };
    const runsDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`, 'runs');

    // This path reaches launchBackground + waitForRun, so it needs a real IPC
    // run directory; the rest of the suite keeps mkdirSync mocked.
    (fs as any).mkdirSync = realMkdirSync;
    let deadlineClock: ReturnType<typeof spyOn> | undefined;
    let watchRegistration: ReturnType<typeof spyOn> | undefined;
    try {
      // launchBackground syncs .mcp.json into the group dir, which must exist.
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const acknowledgedRunIds: string[] = [];
      const createdRunIds: string[] = [];
      const assignedRunIds: string[] = [];
      const promptOwnerRunIds: string[] = [];
      const launches = launchedRuns(runsDir);
      const pending = runContainerAgent(
        retryGroup,
        baseInput({
          group_folder: folder,
          session_id: 'sess-1',
          fallbackPrompt:
            '[CONTEXT_SUMMARY: Assistant: unfinished benchmark]\n\ncontinue',
          // This test isolates retry deadline behavior. A retry without the
          // provider session is otherwise a fresh turn and correctly gains
          // AGENT_CONTEXT, which is covered separately.
          injectAgentContext: false,
          // Task runs get a 1s hard deadline. Chat runs must ignore it on
          // both the initial run and the session-retry run.
          timeout: 1,
          onActiveRunCreated: (runId: string) => {
            createdRunIds.push(runId);
          },
          onRunLaunched: (runId: string) => {
            launches.onRunLaunched(runId);
            acknowledgedRunIds.push(runId);
          },
          onPromptRunAssigned: (runId: string) => {
            assignedRunIds.push(runId);
          },
          onPromptRunAccepted: (runId: string) => {
            promptOwnerRunIds.push(runId);
          },
        }),
      );

      // Wait for the first run directory to appear.
      const firstDir = await launches.next();
      let markRetryWatching!: () => void;
      const retryWatching = new Promise<void>((resolve) => {
        markRetryWatching = resolve;
      });
      const realWatch = fs.watch;
      watchRegistration = spyOn(fs, 'watch').mockImplementation(((
        ...args: Parameters<typeof fs.watch>
      ) => {
        // Mark the attempt: when the host is out of inotify instances the
        // watch throws and the run is observed by the fallback poll instead.
        if (String(args[0]).startsWith(runsDir) && String(args[0]) !== firstDir)
          markRetryWatching();
        return realWatch(...args);
      }) as typeof fs.watch);

      // Fail the first run with an unresumable session error so the board
      // retries without --resume (session_id present, not aborted). The
      // wrapper exits zero, so only the V1 error text triggers the retry.
      writeRunV1Result(firstDir!, {
        result: 'No such session found',
        failed: true,
      });
      fs.writeFileSync(path.join(firstDir!, 'metrics_complete'), 'ok');
      fs.writeFileSync(path.join(firstDir!, 'exit_code'), '0');

      // Wait for the retry run directory (a different run id).
      const retryDir = await launches.next();
      expect(fs.readFileSync(path.join(retryDir!, 'prompt.txt'), 'utf8')).toBe(
        '[CONTEXT_SUMMARY: Assistant: unfinished benchmark]\n\ncontinue',
      );

      // Move the clock past the 1s task deadline before completing the retry.
      // A chat retry must survive this (the hard deadline is disabled for
      // chat); a retry that inherits the task deadline fails here instead.
      await retryWatching;
      watchRegistration.mockRestore();
      deadlineClock = spyOn(Date, 'now').mockReturnValue(Date.now() + 1_500);

      fs.writeFileSync(
        path.join(retryDir!, 'output.jsonl'),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'retry ok',
        }) + '\n',
      );
      writeRunV1Result(retryDir!, { result: 'retry ok' });
      fs.writeFileSync(path.join(retryDir!, 'metrics_complete'), 'ok');
      fs.writeFileSync(path.join(retryDir!, 'exit_code'), '0');

      const result = await pending;
      expect(result.status).toBe('success');
      expect(result.result).toBe('retry ok');
      // The returned run must be the retry, not the failed original.
      expect(result.activeRunId).toBeString();
      expect(acknowledgedRunIds).toEqual([
        path.basename(firstDir!),
        result.activeRunId!,
      ]);
      expect(createdRunIds).toEqual([
        path.basename(firstDir!),
        result.activeRunId!,
      ]);
      expect(assignedRunIds).toEqual([
        path.basename(firstDir!),
        result.activeRunId!,
      ]);
      expect(promptOwnerRunIds).toEqual([result.activeRunId!]);
      expect(result.activeRunId).not.toBe(path.basename(firstDir!));
    } finally {
      deadlineClock?.mockRestore();
      watchRegistration?.mockRestore();
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  }, 30000);

  test('leaves a continuation prompt pending when the fresh-session retry does not launch', async () => {
    const folder = `task-retry-launch-failure-${process.pid}`;
    const taskId = `task-retry-launch-failure-${process.pid}`;
    const runsDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`, 'runs');
    (fs as any).mkdirSync = realMkdirSync;
    sandboxExecResults = [
      { stdout: '', isError: false },
      { stdout: 'fresh launch failed', isError: true },
    ];
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const steeringPrompt = await appendTaskMessageAsync(folder, {
        task_id: taskId,
        role: 'user',
        content: 'keep this pending until a real continuation launches',
        steering: true,
        created_at: new Date().toISOString(),
      });
      const launchedRunIds: string[] = [];
      const launches = launchedRuns(runsDir);
      const pending = runContainerAgent(
        { ...group, folder },
        baseInput({
          group_folder: folder,
          task_id: taskId,
          session_id: 'missing-session',
          fallbackPrompt: 'full history and pending continuation',
          injectAgentContext: false,
          onRunLaunched: (runId: string) => {
            launches.onRunLaunched(runId);
            launchedRunIds.push(runId);
          },
          onPromptRunAssigned: async (runId: string) => {
            await appendTaskMessageAsync(folder, {
              task_id: taskId,
              role: 'system',
              entry_type: 'steering_assignment',
              prompt_id: steeringPrompt.id,
              run_id: runId,
              content: '',
              created_at: new Date().toISOString(),
            });
          },
          onPromptRunAccepted: async (runId: string) => {
            await appendTaskMessageAsync(folder, {
              task_id: taskId,
              role: 'system',
              entry_type: 'steering_delivery',
              prompt_id: steeringPrompt.id,
              run_id: runId,
              content: '',
              created_at: new Date().toISOString(),
            });
          },
        }) as ContainerInput,
      );

      const initialRunDir = await launches.next();
      writeRunV1Result(initialRunDir!, {
        result: 'No such session found',
        failed: true,
      });
      fs.writeFileSync(path.join(initialRunDir!, 'metrics_complete'), 'ok');
      fs.writeFileSync(path.join(initialRunDir!, 'exit_code'), '1');

      expect((await pending).status).toBe('error');
      expect(launchedRunIds).toEqual([path.basename(initialRunDir!)]);
      const assignments = readTaskMessages(folder, taskId).filter(
        (message) =>
          message.entry_type === 'steering_assignment' &&
          message.prompt_id === steeringPrompt.id,
      );
      expect(assignments).toHaveLength(2);
      expect(assignments[0]?.run_id).toBe(path.basename(initialRunDir!));
      expect(assignments[1]?.run_id).not.toBe(path.basename(initialRunDir!));
      expect(
        readTaskMessages(folder, taskId).filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === steeringPrompt.id,
        ),
      ).toHaveLength(0);
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  }, 30000);
});
test('retries transient branch creation failures before launching the agent', async () => {
  branchCreateFailures = 2;
  sandboxExecResult = { stdout: 'agent launch stopped', isError: true };
  const branchGroup = {
    ...group,
    folder: `branch-retry-${process.pid}-${Date.now()}`,
    settings: { taskCheckoutMode: 'branch', defaultBranch: 'develop' },
  } satisfies RegisteredGroup;
  const result = await runContainerAgent(
    branchGroup,
    baseInput({
      group_folder: branchGroup.folder,
      task_id: `task-branch-retry-${process.pid}`,
      branch_name: 'task/retry-branch',
      localRepo: '/host/project',
      skipSharedCheckoutLease: true,
    }),
  );
  expect(result.status).toBe('error');
  const createCalls = mockClient.sandboxGit.mock.calls.filter((call) =>
    String(call[1]).includes('checkout -b task/retry-branch'),
  );
  expect(createCalls).toHaveLength(3);
});

// ─── Session-retry run ownership ─────────────────────────────────────────────

describe('runContainerAgent — session-retry run ownership', () => {
  test('keeps concurrent detached workers with distinct chat identities running', async () => {
    const folder = `detached-worker-concurrency-${process.pid}`;
    const detachedGroup = { ...group, folder } satisfies RegisteredGroup;
    const ipcDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const launches = launchedRuns(path.join(ipcDir, 'runs'));

    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const pendingFirst = runContainerAgent(
        detachedGroup,
        baseInput({
          group_folder: folder,
          chat_jid: 'web-view-agent:concurrent-first',
          ephemeral: true,
          onRunLaunched: launches.onRunLaunched,
        }),
      );
      const firstDir = await launches.next();

      const pendingSecond = runContainerAgent(
        detachedGroup,
        baseInput({
          group_folder: folder,
          chat_jid: 'web-view-agent:concurrent-second',
          ephemeral: true,
          onRunLaunched: launches.onRunLaunched,
        }),
      );
      const secondDir = await launches.next();

      for (const [runDir, result] of [
        [firstDir, 'first invocation output'],
        [secondDir, 'second invocation output'],
      ] as const) {
        fs.writeFileSync(
          path.join(runDir, 'output.jsonl'),
          `${JSON.stringify({
            type: 'result',
            subtype: 'success',
            result,
          })}\n`,
        );
        writeRunV1Result(runDir, { result });
        fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok\n');
        fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
      }

      const [first, second] = await Promise.all([pendingFirst, pendingSecond]);
      expect(first).toMatchObject({
        status: 'success',
        result: 'first invocation output',
      });
      expect(second).toMatchObject({
        status: 'success',
        result: 'second invocation output',
      });
      expect(first.activeRunId).not.toBe(second.activeRunId);
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipcDir, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  }, 30_000);

  test('does not adopt an orphaned detached worker with a different chat identity', async () => {
    const folder = `detached-worker-adoption-${process.pid}`;
    const detachedGroup = { ...group, folder } satisfies RegisteredGroup;
    const ipcDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const staleRunId = 'unrelated-detached-worker';
    const staleRunDir = path.join(ipcDir, 'runs', staleRunId);

    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      await insertActiveRun(
        runFixture({
          id: staleRunId,
          group_folder: folder,
          chat_jid: 'web-view-agent:previous-invocation',
          sandbox_instance: folder,
          agent_name: 'claude',
          session_agent_key: 'claude',
          runtime_variant: persistentVariantTag('claude'),
        }),
      );
      fs.mkdirSync(staleRunDir, { recursive: true });
      fs.writeFileSync(
        path.join(staleRunDir, 'output.jsonl'),
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'unrelated orphan output',
        })}\n`,
      );
      fs.writeFileSync(path.join(staleRunDir, 'metrics_complete'), 'ok\n');
      fs.writeFileSync(path.join(staleRunDir, 'exit_code'), '0\n');

      let launchedRunId: string | undefined;
      const result = await runContainerAgent(
        detachedGroup,
        baseInput({
          group_folder: folder,
          chat_jid: 'web-view-agent:current-invocation',
          agent_cmd: 'claude',
          session_agent_key: 'claude',
          ephemeral: true,
          onRunLaunched: (runId: string) => {
            launchedRunId = runId;
            const runDir = path.join(ipcDir, 'runs', runId);
            fs.writeFileSync(
              path.join(runDir, 'output.jsonl'),
              `${JSON.stringify({
                type: 'result',
                subtype: 'success',
                result: 'current invocation output',
              })}\n`,
            );
            writeRunV1Result(runDir, { result: 'current invocation output' });
            fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok\n');
            fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
          },
        }),
      );

      expect(launchedRunId).toBeString();
      expect(launchedRunId).not.toBe(staleRunId);
      expect(result.result).toBe('current invocation output');
      expect(await getActiveRunById(staleRunId)).toMatchObject({
        status: 'running',
      });
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipcDir, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  }, 30_000);

  test('does not adopt an orphan from a different runtime variant', async () => {
    const folder = `task-restart-variant-${process.pid}`;
    const restartGroup = {
      ...group,
      folder,
      settings: {
        taskCheckoutMode: 'worktree',
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
        ],
      },
    } satisfies RegisteredGroup;
    const ipcDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const staleRunId = 'restart-variant-stale-run';
    const staleRunDir = path.join(ipcDir, 'runs', staleRunId);

    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const task = await createTask(
        taskFixture({ project_id: folder, status: 'implementation' }),
      );
      await insertActiveRun(
        runFixture({
          id: staleRunId,
          group_folder: folder,
          task_id: task.id,
          chat_jid: `task-${task.id}@kanban`,
          sandbox_instance: folder,
          stage: 'implementation',
          session_id: 'owned-session',
          agent_name: 'claude',
          session_agent_key: 'claude',
          runtime_variant: persistentVariantTag('claude', undefined, {
            OLD_RUNTIME: '1',
          }),
        }),
      );
      fs.mkdirSync(staleRunDir, { recursive: true });
      fs.writeFileSync(
        path.join(staleRunDir, 'output.jsonl'),
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'stale runtime result',
        })}\n`,
      );
      fs.writeFileSync(path.join(staleRunDir, 'exit_code'), '0\n');

      let launchedRunId: string | undefined;
      const result = await runContainerAgent(
        restartGroup,
        baseInput({
          group_folder: folder,
          task_id: task.id,
          stage_id: 'implementation',
          session_id: 'owned-session',
          session_agent_key: 'claude',
          restartRecoveryRunId: 'interrupted-owned-run',
          onRunLaunched: (runId: string) => {
            launchedRunId = runId;
            const runDir = path.join(ipcDir, 'runs', runId);
            fs.writeFileSync(
              path.join(runDir, 'output.jsonl'),
              `${JSON.stringify({
                type: 'result',
                subtype: 'success',
                result: 'current runtime result',
                session_id: 'owned-session',
              })}\n`,
            );
            writeRunV1Result(runDir, {
              result: 'current runtime result',
              sessionId: 'owned-session',
            });
            fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok\n');
            fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
          },
        }),
      );

      expect(launchedRunId).toBeString();
      expect(launchedRunId).not.toBe(staleRunId);
      expect(result.result).toBe('current runtime result');
      expect(await getActiveRunById(staleRunId)).toMatchObject({
        status: 'running',
      });
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipcDir, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  }, 30_000);

  test('does not adopt another task stage, session, or runtime on a shared instance', async () => {
    const folder = `task-restart-isolation-${process.pid}`;
    const restartGroup = {
      ...group,
      folder,
      settings: {
        taskCheckoutMode: 'worktree',
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
          {
            id: 'other-stage',
            title: 'Other stage',
            type: 'active',
            color: '#f83',
          },
        ],
      },
    } satisfies RegisteredGroup;
    const ipcDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const foreignRunId = 'restart-isolation-foreign-run';
    const foreignRunDir = path.join(ipcDir, 'runs', foreignRunId);

    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const intendedTask = await createTask(
        taskFixture({ project_id: folder, status: 'implementation' }),
      );
      const foreignTask = await createTask(
        taskFixture({ project_id: folder, status: 'other-stage' }),
      );
      await insertActiveRun(
        runFixture({
          id: foreignRunId,
          group_folder: folder,
          task_id: foreignTask.id,
          chat_jid: `task-${foreignTask.id}@kanban`,
          sandbox_instance: folder,
          stage: 'other-stage',
          session_id: 'foreign-session',
          agent_name: 'cursor-acp',
          session_agent_key: 'cursor-acp',
          model: 'foreign-model',
        }),
      );
      fs.mkdirSync(foreignRunDir, { recursive: true });
      fs.writeFileSync(
        path.join(foreignRunDir, 'output.jsonl'),
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'foreign task result',
        })}\n`,
      );
      fs.writeFileSync(path.join(foreignRunDir, 'exit_code'), '0\n');

      let launchedRunId: string | undefined;
      const result = await runContainerAgent(
        restartGroup,
        baseInput({
          group_folder: folder,
          task_id: intendedTask.id,
          stage_id: 'implementation',
          session_id: 'intended-session',
          session_agent_key: 'claude',
          model: 'intended-model',
          restartRecoveryRunId: 'interrupted-owned-run',
          onRunLaunched: (runId: string) => {
            launchedRunId = runId;
            const runDir = path.join(ipcDir, 'runs', runId);
            fs.writeFileSync(
              path.join(runDir, 'output.jsonl'),
              `${JSON.stringify({
                type: 'result',
                subtype: 'success',
                result: 'isolated continuation result',
                session_id: 'intended-session',
              })}\n`,
            );
            writeRunV1Result(runDir, {
              result: 'isolated continuation result',
              sessionId: 'intended-session',
            });
            fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok\n');
            fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
          },
        }),
      );

      expect(launchedRunId).toBeString();
      expect(launchedRunId).not.toBe(foreignRunId);
      expect(result.result).toBe('isolated continuation result');
      expect(await getActiveRunById(foreignRunId)).toMatchObject({
        status: 'running',
        task_id: foreignTask.id,
      });
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipcDir, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  }, 30_000);

  test('does not adopt the interrupted row that restart recovery is replacing', async () => {
    const folder = `task-restart-adoption-${process.pid}`;
    const restartGroup = {
      ...group,
      folder,
      settings: {
        taskCheckoutMode: 'worktree',
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
        ],
      },
    } satisfies RegisteredGroup;
    const ipcDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const staleRunId = 'restart-adoption-interrupted';
    const staleRunDir = path.join(ipcDir, 'runs', staleRunId);

    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const task = await createTask(
        taskFixture({ project_id: folder, status: 'implementation' }),
      );
      await insertActiveRun(
        runFixture({
          id: staleRunId,
          group_folder: folder,
          task_id: task.id,
          chat_jid: `task-${task.id}@kanban`,
          sandbox_instance: folder,
          stage: 'implementation',
          session_id: 'owned-session',
          agent_name: 'claude',
          session_agent_key: 'claude',
        }),
      );
      fs.mkdirSync(staleRunDir, { recursive: true });
      fs.writeFileSync(
        path.join(staleRunDir, 'output.jsonl'),
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'stale interrupted result',
        })}\n`,
      );
      fs.writeFileSync(path.join(staleRunDir, 'exit_code'), '0\n');
      // Boot recovery reserves this predecessor in the current-process set
      // while the replacement row is being prepared. That reservation must
      // prevent adoption without making the runner retire it prematurely.
      markCurrentProcessRun(staleRunId);

      let launchedRunId: string | undefined;
      const result = await runContainerAgent(
        restartGroup,
        baseInput({
          group_folder: folder,
          task_id: task.id,
          stage_id: 'implementation',
          session_id: 'owned-session',
          restartRecoveryRunId: staleRunId,
          onRunLaunched: (runId: string) => {
            launchedRunId = runId;
            const runDir = path.join(ipcDir, 'runs', runId);
            fs.writeFileSync(
              path.join(runDir, 'output.jsonl'),
              `${JSON.stringify({
                type: 'result',
                subtype: 'success',
                result: 'new continuation result',
                session_id: 'owned-session',
              })}\n`,
            );
            writeRunV1Result(runDir, {
              result: 'new continuation result',
              sessionId: 'owned-session',
            });
            fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok\n');
            fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
          },
        }),
      );

      expect(launchedRunId).toBeString();
      expect(launchedRunId).not.toBe(staleRunId);
      expect(result.result).toBe('new continuation result');
      expect(await getActiveRunById(staleRunId)).toMatchObject({
        status: 'running',
      });
    } finally {
      unmarkCurrentProcessRun(staleRunId);
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipcDir, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  }, 30_000);

  test('launches with the durable restart continuation row instead of inserting another run', async () => {
    const folder = `task-durable-restart-${process.pid}`;
    const restartGroup = {
      ...group,
      folder,
      settings: {
        taskCheckoutMode: 'worktree',
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
        ],
      },
    } satisfies RegisteredGroup;
    const ipcDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const interruptedRunId = 'durable-restart-interrupted';
    const continuationRunId = 'durable-restart-continuation';

    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const task = await createTask(
        taskFixture({ project_id: folder, status: 'implementation' }),
      );
      await insertActiveRun(
        runFixture({
          id: continuationRunId,
          group_folder: folder,
          task_id: task.id,
          chat_jid: `task-${task.id}@kanban`,
          sandbox_instance: folder,
          stage: 'implementation',
          session_id: 'durable-session',
          agent_name: 'claude',
          session_agent_key: 'claude',
          runtime_variant: persistentVariantTag('claude'),
          restart_recovery_of_run_id: interruptedRunId,
        }),
      );

      let createdRunId: string | undefined;
      let launchedRunId: string | undefined;
      const result = await runContainerAgent(
        restartGroup,
        baseInput({
          group_folder: folder,
          task_id: task.id,
          stage_id: 'implementation',
          agent_cmd: 'claude',
          session_id: 'durable-session',
          session_agent_key: 'claude',
          restartRecoveryRunId: interruptedRunId,
          precreatedActiveRunId: continuationRunId,
          onActiveRunCreated: (runId: string) => {
            createdRunId = runId;
          },
          onRunLaunched: (runId: string) => {
            launchedRunId = runId;
            const runDir = path.join(ipcDir, 'runs', runId);
            fs.writeFileSync(
              path.join(runDir, 'output.jsonl'),
              `${JSON.stringify({
                type: 'result',
                subtype: 'success',
                result: 'durable continuation result',
                session_id: 'durable-session',
              })}\n`,
            );
            writeRunV1Result(runDir, {
              result: 'durable continuation result',
              sessionId: 'durable-session',
            });
            fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok\n');
            fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
          },
        }),
      );

      expect(result).toMatchObject({ status: 'success' });
      expect(createdRunId).toBe(continuationRunId);
      expect(launchedRunId).toBe(continuationRunId);
      const execCalls = mockClient.sandboxExec.mock.calls as unknown as Array<
        [string, string, string]
      >;
      expect(
        execCalls.some((call) =>
          String(call[2]).includes(
            `run-agent.sh /workspace/ipc/runs/${continuationRunId} && : > /workspace/ipc/runs/${continuationRunId}/.restart-recovery-dispatched`,
          ),
        ),
      ).toBe(true);
      expect(result.result).toBe('durable continuation result');
      expect(await getActiveRunById(continuationRunId)).toMatchObject({
        status: 'completed',
        restart_recovery_of_run_id: interruptedRunId,
      });
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipcDir, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  }, 30_000);

  test('does not create a fresh retry run when a restart recovery session is unresumable', async () => {
    const folder = `task-unresumable-restart-${process.pid}`;
    const restartGroup = {
      ...group,
      folder,
      settings: {
        taskCheckoutMode: 'worktree',
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
        ],
      },
    } satisfies RegisteredGroup;
    const ipcDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`);
    const continuationRunId = 'unresumable-restart-continuation';
    const interruptedRunId = 'unresumable-restart-interrupted';

    (fs as any).mkdirSync = realMkdirSync;
    try {
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const task = await createTask(
        taskFixture({ project_id: folder, status: 'implementation' }),
      );
      await insertActiveRun(
        runFixture({
          id: continuationRunId,
          group_folder: folder,
          task_id: task.id,
          chat_jid: `task-${task.id}@kanban`,
          sandbox_instance: folder,
          stage: 'implementation',
          session_id: 'expired-restart-session',
          agent_name: 'cursor-acp',
          session_agent_key: 'cursor-acp',
          runtime_variant: persistentVariantTag('cursor-acp'),
          restart_recovery_of_run_id: interruptedRunId,
        }),
      );
      let launches = 0;

      const result = await runContainerAgent(
        restartGroup,
        baseInput({
          group_folder: folder,
          task_id: task.id,
          stage_id: 'implementation',
          agent_cmd: 'cursor-acp',
          session_id: 'expired-restart-session',
          session_agent_key: 'cursor-acp',
          restartRecoveryRunId: interruptedRunId,
          precreatedActiveRunId: continuationRunId,
          onRunLaunched: (runId: string) => {
            launches++;
            const runDir = path.join(ipcDir, 'runs', runId);
            fs.writeFileSync(
              path.join(runDir, 'output.jsonl'),
              `${JSON.stringify({ type: 'error', text: 'No such session found' })}\n`,
            );
            fs.writeFileSync(path.join(runDir, 'metrics_complete'), 'ok\n');
            fs.writeFileSync(path.join(runDir, 'exit_code'), '1\n');
          },
        }),
      );

      expect(result).toMatchObject({
        status: 'error',
        activeRunId: continuationRunId,
      });
      expect(launches).toBe(1);
      expect(await getActiveRunsByStatus('running')).toEqual([]);
      expect(await getActiveRunById(continuationRunId)).toMatchObject({
        status: 'error',
        restart_recovery_of_run_id: interruptedRunId,
      });
      expect(
        readTaskMessages(folder, task.id).some((message) =>
          message.content.includes('Session expired'),
        ),
      ).toBe(false);
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(ipcDir, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  }, 30_000);

  test('marks the retry run as current-process-owned so a concurrent chat run on the same instance does not adopt it', async () => {
    const folder = `chat-retry-ownership-${process.pid}`;
    const retryGroup = {
      ...group,
      folder,
      settings: { taskCheckoutMode: 'worktree' },
    };
    const runsDir = path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`, 'runs');

    // This path reaches launchBackground + waitForRun, so it needs a real IPC
    // run directory; the rest of the suite keeps mkdirSync mocked.
    (fs as any).mkdirSync = realMkdirSync;
    try {
      // launchBackground syncs .mcp.json into the group dir, which must exist.
      fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
      const launches = launchedRuns(runsDir);
      const pendingA = runContainerAgent(
        retryGroup,
        baseInput({
          onRunLaunched: launches.onRunLaunched,
          group_folder: folder,
          conversation_id: 'conv-A',
          session_id: 'sess-A',
          branch_name: 'chat-conv-A',
          worktree_path: '/host/project/.worktrees/chat-conv-A',
        }),
      );

      // Wait for the first run directory to appear.
      const firstDir = await launches.next();

      // Fail the first run with an unresumable session error so the board
      // retries without --resume (session_id present, not aborted). The
      // wrapper exits zero, so only the V1 terminal failure triggers the retry.
      fs.writeFileSync(
        path.join(firstDir!, 'output.jsonl'),
        JSON.stringify({ type: 'error', text: 'No such session found' }) + '\n',
      );
      writeRunV1Result(firstDir!, {
        result: 'No such session found',
        failed: true,
      });
      fs.writeFileSync(path.join(firstDir!, 'metrics_complete'), 'ok');
      fs.writeFileSync(path.join(firstDir!, 'exit_code'), '0');

      // Wait for the retry run directory (a different run id).
      const retryDir = await launches.next();
      const retryRunId = path.basename(retryDir!);

      // The in-flight retry run is owned by this process. Without the mark,
      // the crash-recovery adoption guard below treats it as an orphan from a
      // crashed process and a concurrent run steals its output stream.
      expect(isCurrentProcessRun(retryRunId)).toBe(true);

      // A second chat conversation on the same group shares slot 0 (the same
      // sandbox instance). It must launch its own run, not adopt the retry.
      const pendingB = runContainerAgent(
        retryGroup,
        baseInput({
          onRunLaunched: launches.onRunLaunched,
          group_folder: folder,
          conversation_id: 'conv-B',
          chat_jid: 'conv-B@kanban',
          branch_name: 'chat-conv-B',
          worktree_path: '/host/project/.worktrees/chat-conv-B',
        }),
      );

      // B's own run directory appears once its launchBackground runs.
      const runBDir = await launches.next();

      // Complete B's run first, then the retry.
      fs.writeFileSync(
        path.join(runBDir!, 'output.jsonl'),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'B answer',
        }) + '\n',
      );
      writeRunV1Result(runBDir!, { result: 'B answer' });
      fs.writeFileSync(path.join(runBDir!, 'metrics_complete'), 'ok');
      fs.writeFileSync(path.join(runBDir!, 'exit_code'), '0');

      fs.writeFileSync(
        path.join(retryDir!, 'output.jsonl'),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'retry ok',
        }) + '\n',
      );
      writeRunV1Result(retryDir!, { result: 'retry ok' });
      fs.writeFileSync(path.join(retryDir!, 'metrics_complete'), 'ok');
      fs.writeFileSync(path.join(retryDir!, 'exit_code'), '0');

      const [resA, resB] = await Promise.all([pendingA, pendingB]);

      // A returns its retry's output under the retry run id.
      expect(resA.status).toBe('success');
      expect(resA.result).toBe('retry ok');
      expect(resA.activeRunId).toBe(retryRunId);

      // B returned ITS OWN run's output — not the retry's. Before the fix,
      // B adopted the unmarked retry run: resB.result was 'retry ok' and
      // resB.activeRunId === retryRunId, and B's prompt never executed.
      expect(resB.status).toBe('success');
      expect(resB.result).toBe('B answer');
      expect(resB.activeRunId).toBeString();
      expect(resB.activeRunId).not.toBe(retryRunId);

      // Ownership is released once the retry run is fully done.
      expect(isCurrentProcessRun(retryRunId)).toBe(false);
    } finally {
      (fs as any).mkdirSync = () => undefined;
      fs.rmSync(path.join(DATA_DIR, 'ipc', `carapa-bot-${folder}`), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(GROUPS_DIR, folder), {
        recursive: true,
        force: true,
      });
    }
  }, 30000);
});
