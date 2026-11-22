/**
 * Tests for the recovery fixes and the new sweepDeadAgentRuns reaper.
 *
 * Covers:
 *   - Part A: the waitForRun call inside recoverOrphanedRuns passes a
 *     non-infinite remaining duration and stall options with a sandbox PID
 *     liveness probe.
 *   - Part B: sweepDeadAgentRuns reaps runs whose `pid` is dead
 *     (agent-status.sh reports isError) and skips runs whose `pid` is alive.
 *
 * Mocking strategy: only `./lib/mcp-client.js` is mocked, to control
 * what `agent-status.sh` returns. The real `./sandbox/process.js` is used so
 * `killRun` and `resolveHostRunDir` work normally — mocking process.ts
 * or its barrel `./mcp/mcp-runner.js` would leak into other test files
 * that run in the same Bun process (e.g. waitForRun,
 * runContainerAgent tests).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  onTestFinished,
  mock,
  spyOn,
} from 'bun:test';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { waitForFileState } from './test-file-events.js';
import {
  carapaRunV1Paths,
  readCarapaRunV1Pair,
} from './modules/transcripts/carapa-run-v1.js';

/**
 * Writes the Run V1 pair the box leaves in a run dir, and names its harness in
 * args.json (merged into an existing one). `status: null` leaves the run
 * without a terminal event, as a run killed mid-turn does.
 */
function writeV1Run(
  runDir: string,
  opts: {
    result?: string;
    sessionId?: string;
    status?: 'completed' | 'failed' | null;
    harness?: string;
    extraEvents?: Record<string, unknown>[];
  } = {},
): void {
  const harness = opts.harness ?? 'claude';
  fs.mkdirSync(runDir, { recursive: true });
  const argsPath = path.join(runDir, 'args.json');
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(fs.readFileSync(argsPath, 'utf8'));
  } catch {
    // no args.json yet
  }
  fs.writeFileSync(argsPath, JSON.stringify({ ...args, agentCmd: harness }));
  fs.writeFileSync(
    path.join(runDir, 'output.v1.meta.json'),
    `${JSON.stringify({ format: 'carapa-run', version: 1, harness, requestedModel: null })}\n`,
  );
  const status = opts.status === undefined ? 'completed' : opts.status;
  const events: Record<string, unknown>[] = [
    { type: 'run', status: 'started' },
    ...(opts.sessionId
      ? [{ type: 'session', id: opts.sessionId, status: 'started' }]
      : []),
    ...(opts.extraEvents ?? []),
    ...(opts.result === undefined
      ? []
      : status === null
        ? [
            {
              type: 'message_delta',
              id: 'm1',
              role: 'assistant',
              delta: opts.result,
            },
          ]
        : [
            {
              type: 'message',
              id: 'm1',
              role: 'assistant',
              content: opts.result,
              status: 'completed',
            },
          ]),
    ...(status ? [{ type: 'run', status }] : []),
  ];
  fs.writeFileSync(
    path.join(runDir, 'output.v1.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
}

// ─── Sandbox client mock ──────────────────────────────────────────────────────
// Only the sandbox client is mocked. We intercept `sandboxExec` calls and
// route them by command shape: "agent-status.sh <pid>" probes return what the test
// wants; everything else (e.g. killRun's stop-agent.sh call) returns a
// harmless already_dead stub so the real killRun() proceeds normally.

const _sandboxExecCalls: {
  command: string;
  options?: { instance?: string; timeout?: number };
}[] = [];

// Per-test: which PID probes to consider "dead" (true means reaped).
// PIDs not in this set are treated as alive (skip reap).
const _deadPids = new Set<string>();

// Per-test: PIDs whose sandboxExec probe should simulate a docker/MCP
// failure — isError=true, no kill0_exit marker. Production code MUST
// distinguish this from a real "process dead" and NOT reap.
const _sandboxFailurePids = new Set<string>();

// Per-test: PIDs whose probe fails with Docker's deterministic stopped-container
// error (no marker). The optional callback runs during the probe so a test can
// simulate the wrapper writing exit_code while the probe is in flight.
const _stoppedContainerPids = new Map<string, (() => void) | undefined>();

// Per-test: Git tool calls of a repository-backed project. Unset, the calls
// fail as they did before the client mock had these methods.
type MockGitResult = { stdout: string; isError: boolean };
const _gitCalls: { tool: 'sandboxBranch' | 'sandboxGit'; args: unknown[] }[] =
  [];
let _gitHandler:
  | ((tool: 'sandboxBranch' | 'sandboxGit', args: unknown[]) => MockGitResult)
  | undefined;
const gitTool =
  (tool: 'sandboxBranch' | 'sandboxGit') =>
  async (...args: unknown[]): Promise<MockGitResult> => {
    if (!_gitHandler) throw new TypeError(`${tool} is not mocked`);
    _gitCalls.push({ tool, args });
    return _gitHandler(tool, args);
  };

const sandboxClientModule = await import('./lib/mcp-client.js');

mock.module('./lib/mcp-client.js', () => ({
  ...sandboxClientModule,
  getSandboxClient: () => ({
    sandboxBranch: gitTool('sandboxBranch'),
    sandboxGit: gitTool('sandboxGit'),
    sandboxExec: async (
      _stack: string,
      _service: string,
      command: string,
      options?: { instance?: string; timeout?: number },
    ) => {
      _sandboxExecCalls.push({ command, options });
      // Route agent-status.sh probes by PID membership in the dead set. The
      // wrapper emits a marker so production can distinguish "process dead"
      // from "docker compose exec itself failed". Mirror that here.
      const m = command.match(/^agent-status\.sh (\d+)$/);
      if (m) {
        const pid = m[1];
        if (_stoppedContainerPids.has(pid)) {
          _stoppedContainerPids.get(pid)?.();
          return {
            stdout:
              'OCI runtime exec failed: executing processes for container: cannot execute in container "abc123" in state stopped',
            stderr: '',
            isError: true,
          };
        }
        if (_sandboxFailurePids.has(pid)) {
          // Simulate: docker compose exec itself failed (no marker, isError).
          return {
            stdout: '',
            stderr: 'Error response from daemon: ...',
            isError: true,
          };
        }
        const isError = _deadPids.has(pid);
        const exit = isError ? 1 : 0;
        return { stdout: `kill0_exit=${exit}\n`, isError };
      }
      // Browser targets for worktrees in projects without a Workspace Path are
      // rooted at the sandbox service's cwd.
      if (command === 'pwd') {
        return { stdout: '/workspace/test-proj\n', isError: false };
      }
      // Real killRun() invokes stop-agent.sh — pretend the agent is gone.
      return {
        stdout: JSON.stringify({ status: 'already_dead' }),
        isError: false,
      };
    },
  }),
}));

// ─── Fixtures + helpers ───────────────────────────────────────────────────────

let ipcBase: string;
let runCounter = 0;

function makeRun() {
  runCounter += 1;
  const id = `run-test-${Date.now()}-${runCounter}`;
  const now = new Date();
  return {
    id,
    group_folder: 'test-proj',
    chat_jid: 'task@kanban',
    session_id: null,
    conversation_id: null,
    isMain: 0,
    isScheduledTask: 0,
    scheduled_task_id: null,
    task_id: null,
    sandbox_stack: 'carapa-bot',
    sandbox_service: 'agent',
    sandbox_instance: 'default',
    started_at: now.toISOString(),
    timeout_at: new Date(now.getTime() + 600_000).toISOString(),
    status: 'running' as const,
    model: null,
    agent_name: null,
    tok_total: null,
    tok_output: null,
    tok_input: null,
    tok_cache_write: null,
    tok_cache_read: null,
    tok_context_last: null,
    model_name: null,
    tool_usage_count: null,
    stage: null,
  };
}

let _init = false;
async function ensureInitDb() {
  if (_init) return;
  const { initDatabase } = await import('./db.js');
  await initDatabase(':memory:');
  _init = true;
}

async function truncateDb() {
  const { truncateTestDb } = await import('./test-helpers.js');
  await truncateTestDb();
}

beforeAll(async () => {
  // Database setup runs the full migration chain and can legitimately take
  // longer than an individual test hook on a cold PGlite/WASM start. Keep it
  // file-scoped; beforeEach only resets already-initialized state.
  await ensureInitDb();
  // Use the same DATA_DIR that test-preload.ts set up. config.ts reads
  // process.env.CARAPA_DATA_DIR at module load time and caches it as
  // DATA_DIR; overriding the env var here would have no effect because
  // config.js is already loaded. So we just import DATA_DIR and use the
  // resolved path. The test-preload's afterAll cleans up the temp dir.
  const { DATA_DIR } = await import('./config.js');
  ipcBase = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(path.join(ipcBase, 'carapa-bot-default', 'runs'), {
    recursive: true,
  });
});

afterAll(() => {
  // No cleanup needed — the test-preload's afterAll handles temp dir
  // deletion. The run dirs we create are under its managed tmpRoot.
});

beforeEach(async () => {
  await truncateDb();
  _sandboxExecCalls.length = 0;
  _deadPids.clear();
  _sandboxFailurePids.clear();
  _stoppedContainerPids.clear();
  _gitCalls.length = 0;
  _gitHandler = undefined;
  // Wipe any leftover run dirs from the previous test.
  const runsDir = path.join(ipcBase, 'carapa-bot-default', 'runs');
  try {
    for (const runId of fs.readdirSync(runsDir)) {
      if (!runId.startsWith('run-')) continue;
      fs.rmSync(path.join(runsDir, runId), { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
  fs.rmSync(path.join(ipcBase, 'carapa-bot-default', 'sessions'), {
    recursive: true,
    force: true,
  });
});

// ─── Part A — recovery waitForRun args ────────────────────────────────────────

describe('Part A: recovery waitForRun args', () => {
  test('startup adopts a live run without waiting for its exit and can dispatch an empty-project cron', async () => {
    const {
      createTask,
      createCronjob,
      updateTask,
      getActiveRunById,
      getTasksByProject,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { reattachOrphanedRuns } = await import('./recovery.js');
    const { isCurrentProcessRun } = await import('./mcp/mcp-runner.js');
    const { isTaskRunning } = await import('./modules/kanban/task-executor.js');
    const { createSchedulerPoll } =
      await import('./modules/chat/scheduling/task-scheduler.js');
    const projectId = `boot-reattach-${Date.now()}`;
    const task = await createTask(
      taskFixture({
        project_id: projectId,
        status: 'in_progress',
      }),
    );
    await updateTask(task.id, {
      worktree_path: `/workspace/.worktrees/${projectId}`,
    });
    const run = {
      ...makeRun(),
      group_folder: projectId,
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      stage: 'in_progress',
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'output.jsonl'), '');
    await insertActiveRun(run);

    const adoption = reattachOrphanedRuns({
      drainProjectQueue: async () => {},
    });
    let finishing: Promise<void> | undefined;
    const finishRecovery = () =>
      (finishing ??= (async () => {
        fs.writeFileSync(path.join(runDir, 'exit_code'), '1\n');
        await (
          await adoption
        ).settled;
      })());
    onTestFinished(finishRecovery);
    try {
      // Adoption must return while exit_code is absent. The test runner's
      // timeout catches a hang; machine speed is not part of this contract.
      const recovery = await adoption;
      let settled = false;
      void recovery.settled.then(() => {
        settled = true;
      });
      expect(isCurrentProcessRun(run.id)).toBe(true);
      expect(await isTaskRunning(task.id, new Set())).toBe(true);
      expect((await getActiveRunById(run.id))?.status).toBe('running');

      // A second adoption scan must not create another watcher for this run.
      await (
        await reattachOrphanedRuns()
      ).settled;
      const cronProject = `${projectId}-cron`;
      const cronjob = await createCronjob({
        project_id: cronProject,
        title: 'Independent cron',
        description: '',
        cron_expression: '* * * * *',
        queue_mode: 'if_empty',
        status: 'active',
        next_run: new Date(Date.now() - 60_000).toISOString(),
      });
      // Keep the real queue drain from launching a sandbox. There is still
      // no active-stage card in this project, so if_empty must create one.
      await insertActiveRun({
        ...makeRun(),
        group_folder: cronProject,
        task_id: 'capacity-reservation',
      });
      await createSchedulerPoll({
        registeredGroups: () => ({
          [cronProject]: { folder: cronProject, settings: {} } as any,
        }),
        sendMessage: async () => {},
        getSessions: () => ({}),
      })();
      expect(
        (await getTasksByProject(cronProject)).map((card) => card.cronjob_id),
      ).toEqual([cronjob.id]);
      expect(settled).toBe(false);
      expect((await getActiveRunById(run.id))?.status).toBe('running');
    } finally {
      // Drain the watcher before any subsequent database fixture is reset.
      await finishRecovery();
    }
    expect(await isTaskRunning(task.id, new Set())).toBe(false);
    expect(isCurrentProcessRun(run.id)).toBe(false);
    expect((await getActiveRunById(run.id))?.status).toBe('error');
  });

  test('re-broadcasts replayed subagent lists for a re-attached chat run only', async () => {
    const { createConversation, createTask, insertActiveRun, updateTask } =
      await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const wsEvents = await import('./modules/objectives/ws-events.js');
    const { reattachOrphanedRuns } = await import('./recovery.js');

    const events: Array<{ type: string; payload: any }> = [];
    const waiters: Array<() => void> = [];
    const broadcastSpy = spyOn(wsEvents, 'broadcast').mockImplementation(
      (event) => {
        events.push(event as { type: string; payload: any });
        for (const wake of waiters.splice(0)) wake();
      },
    );
    onTestFinished(() => broadcastSpy.mockRestore());
    const until = async (done: () => boolean) => {
      while (!done()) await new Promise<void>((r) => waiters.push(r));
    };

    const writeV1Run = (
      runId: string,
      extra: Record<string, unknown>[],
    ): string => {
      const dir = path.join(ipcBase, 'carapa-bot-default', 'runs', runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'args.json'),
        JSON.stringify({ agentCmd: 'omp-acp', model: 'recovery-model' }),
      );
      fs.writeFileSync(path.join(dir, 'output.jsonl'), 'legacy\n');
      fs.writeFileSync(
        path.join(dir, 'output.v1.meta.json'),
        `${JSON.stringify({ format: 'carapa-run', version: 1, harness: 'omp-acp', requestedModel: 'recovery-model' })}\n`,
      );
      fs.writeFileSync(
        path.join(dir, 'output.v1.jsonl'),
        [
          { type: 'session', id: `session-${runId}`, status: 'started' },
          { type: 'run', status: 'started', model: 'recovery-model' },
          ...extra,
          {
            type: 'message_delta',
            id: `message-${runId}`,
            role: 'assistant',
            delta: 'still working',
          },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n') + '\n',
      );
      return dir;
    };
    const lists = [
      [{ id: 'agent-1', description: 'First subagent' }],
      [
        { id: 'agent-1', description: 'First subagent' },
        { id: 'agent-2', description: 'Second subagent' },
      ],
      [],
    ];
    const backgroundEvents = lists.map((tasks) => ({
      type: 'background_tasks',
      tasks,
    }));

    const conversation = await createConversation('test-proj');
    const chatRun = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      conversation_id: conversation.id,
    };
    const chatDir = writeV1Run(chatRun.id, backgroundEvents);
    await insertActiveRun(chatRun);

    const taskProject = `bg-task-${Date.now()}`;
    const task = await createTask(
      taskFixture({ project_id: taskProject, status: 'in_progress' }),
    );
    await updateTask(task.id, {
      worktree_path: `/workspace/.worktrees/${taskProject}`,
    });
    const taskRun = {
      ...makeRun(),
      group_folder: taskProject,
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      stage: 'in_progress',
    };
    const taskDir = writeV1Run(taskRun.id, backgroundEvents);
    await insertActiveRun(taskRun);

    const adoption = reattachOrphanedRuns({
      drainProjectQueue: async () => {},
    });
    let finishing: Promise<void> | undefined;
    const finish = () =>
      (finishing ??= (async () => {
        fs.writeFileSync(path.join(chatDir, 'exit_code'), '1\n');
        fs.writeFileSync(path.join(taskDir, 'exit_code'), '1\n');
        await (
          await adoption
        ).settled;
      })());
    onTestFinished(finish);
    try {
      await adoption;
      await until(
        () =>
          events.some((e) => e.type === 'chat_output') &&
          events.some((e) => e.type === 'task_output'),
      );
      const started = events.find((e) => e.type === 'chat_started')!;
      const background = events.filter(
        (e) => e.type === 'chat_background_tasks',
      );
      expect(background.map((e) => e.payload.tasks)).toEqual(lists);
      for (const event of background) {
        expect(event.payload).toMatchObject({
          folder: 'test-proj',
          conversation_id: conversation.id,
          streamKey: started.payload.streamKey,
        });
      }
    } finally {
      await finish();
    }
  });

  test('retains idle conversation worktrees and browser discovery across the startup sweep', async () => {
    const {
      createConversation,
      getConversation,
      updateConversationWorktreePath,
      createUser,
    } = await import('./db.js');
    const { sweepOrphanedWorktrees } = await import('./recovery.js');

    const { loadState } = await import('./state-manager.js');
    const { listBrowserSessions, authorizeBrowser } =
      await import('./lib/browser-session-access.js');
    const owner = await createUser('browser-recovery-owner', 'test', 'admin');
    const { drizzleDbRef } = await import('./db/drizzle-client.js');
    const { projects } = await import('./db/schema.js');
    const projectId = 'browser-recovery-project';
    await drizzleDbRef.current.insert(projects).values({
      id: projectId,
      jid: `${projectId}@web`,
      folder: projectId,
      name: projectId,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: owner.id,
      settings: JSON.stringify({
        defaultSandbox: 'carapa-bot',
        defaultSandboxService: 'agent',
        defaultSandboxInstance: 'default',
      }),
    });
    await loadState();
    const conversation = await createConversation(projectId, {
      use_worktree: true,
      ownerUserId: owner.id,
    });
    await updateConversationWorktreePath(
      conversation.id,
      '/workspace/test-proj/.worktrees/persistent',
    );
    const before = (await listBrowserSessions(
      owner.id,
      projectId,
      conversation.id,
    ))!;
    const browser = before.find(
      (session) => session.conversationId === conversation.id,
    )!;
    expect(browser).toBeDefined();

    await sweepOrphanedWorktrees();

    expect((await getConversation(conversation.id))?.worktree_path).toBe(
      '/workspace/test-proj/.worktrees/persistent',
    );
    expect(
      (await listBrowserSessions(owner.id, projectId, conversation.id))!.map(
        (session) => session.sessionId,
      ),
    ).toContain(browser.sessionId);
    expect(
      await authorizeBrowser(owner.id, projectId, browser.sessionId),
    ).not.toBeNull();
  });

  test('startup sweep keeps queue-stage task bindings and clears done-stage ones', async () => {
    const { createTask, getTask, createUser } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { sweepOrphanedWorktrees } = await import('./recovery.js');
    const { loadState } = await import('./state-manager.js');
    const { drizzleDbRef } = await import('./db/drizzle-client.js');
    const { projects } = await import('./db/schema.js');
    const owner = await createUser('sweep-owner', 'test', 'admin');
    const projectId = 'sweep-queue-project';
    await drizzleDbRef.current.insert(projects).values({
      id: projectId,
      jid: `${projectId}@web`,
      folder: projectId,
      name: projectId,
      trigger: '!',
      added_at: new Date().toISOString(),
      user_id: owner.id,
      settings: JSON.stringify({ defaultSandbox: 'carapa-bot' }),
    });
    await loadState();
    const bound = (status: string) =>
      createTask(
        taskFixture({
          project_id: projectId,
          status,
          branch_name: `${status}-branch`,
          worktree_path: `.worktrees/${status}-branch`,
        }),
      );
    const parked = await bound('question');
    const done = await bound('completed');

    await sweepOrphanedWorktrees();

    expect((await getTask(parked.id))?.worktree_path).toBe(
      '.worktrees/question-branch',
    );
    expect((await getTask(done.id))?.worktree_path).toBeNull();
  });

  test('persists a recovered native session under its persona-generation routing key', async () => {
    const {
      createConversation,
      getConversationSessionId,
      getConversationMainPersonaSourceObservation,
      insertActiveRun,
      resolveConversationMainPersonaGeneration,
      setConversationMainAiUser,
    } = await import('./db.js');
    const { mainPersonaSessionKey } =
      await import('./modules/ai-users/session-revision.js');
    const { recoverOrphanedRuns } = await import('./recovery.js');

    const conversation = await createConversation('test-proj');
    const source = await getConversationMainPersonaSourceObservation(
      conversation.id,
    );
    const oldGeneration = await resolveConversationMainPersonaGeneration(
      conversation.id,
      'main-persona:v1:old',
      source,
    );
    await setConversationMainAiUser(conversation.id, { mode: 'none' });
    const currentSource = await getConversationMainPersonaSourceObservation(
      conversation.id,
    );
    const currentGeneration = await resolveConversationMainPersonaGeneration(
      conversation.id,
      'main-persona:v1:current',
      currentSource,
    );
    if (oldGeneration === null || currentGeneration === null)
      throw new Error('Unexpected stale persona observation');
    const sessionAgentKey = mainPersonaSessionKey('codex@relay', oldGeneration);
    const currentSessionAgentKey = mainPersonaSessionKey(
      'codex@relay',
      currentGeneration,
    );
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      conversation_id: conversation.id,
      agent_name: 'codex',
      session_agent_key: sessionAgentKey,
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, {
      result: 'Recovered persona reply',
      sessionId: 'recovered-native-session',
    });
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    await insertActiveRun(run);

    await recoverOrphanedRuns();

    expect(
      await getConversationSessionId(conversation.id, sessionAgentKey),
    ).toBe('recovered-native-session');
    expect(
      await getConversationSessionId(conversation.id, currentSessionAgentKey),
    ).toBeNull();
    expect(await getConversationSessionId(conversation.id, 'codex')).toBeNull();
  });

  test('advances a recurring scheduled task recovered after its due time', async () => {
    const { GROUPS_DIR } = await import('./config.js');
    const { createScheduledTask, getDueTasks, getTaskById, insertActiveRun } =
      await import('./db.js');

    const scheduledTaskId = `scheduled-recovery-${Date.now()}`;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Run a recurring check',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });

    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      isScheduledTask: 1,
      scheduled_task_id: scheduledTaskId,
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, {
      result: 'Scheduled check complete',
    });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'Run a recurring check');
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    await insertActiveRun(run);

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns();

    const recovered = await getTaskById(scheduledTaskId);
    expect(recovered?.next_run).not.toBe(dueAt);
    expect(new Date(recovered!.next_run!).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect((await getDueTasks()).map((task) => task.id)).not.toContain(
      scheduledTaskId,
    );
    const preservedDir = path.join(
      GROUPS_DIR,
      'test-proj',
      'session-transcripts',
    );
    expect(
      fs.readFileSync(path.join(preservedDir, `${run.id}.v1.jsonl`), 'utf8'),
    ).toContain('Scheduled check complete');
    expect(
      fs.readFileSync(path.join(preservedDir, `${run.id}.prompt.txt`), 'utf8'),
    ).toBe('Run a recurring check');
    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('retries an occurrence claimed before capacity acquisition after restart', async () => {
    const {
      claimScheduledTaskOccurrence,
      createScheduledTask,
      getDueTasks,
      getTaskById,
      updateScheduledTaskIfIdle,
    } = await import('./db.js');
    const { recoverOrphanedScheduledTaskClaims } =
      await import('./recovery.js');
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const task = {
      id: `scheduled-capacity-restart-${Date.now()}`,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Retry after the capacity wait was interrupted',
      schedule_type: 'interval' as const,
      schedule_value: '60000',
      context_mode: 'isolated' as const,
      next_run: dueAt,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date(Date.now() - 120_000).toISOString(),
    };
    await createScheduledTask(task);
    expect(await claimScheduledTaskOccurrence(task)).toBe(true);
    expect((await getTaskById(task.id))?.next_run).toBeNull();
    expect(await updateScheduledTaskIfIdle(task.id, { status: 'paused' })).toBe(
      false,
    );

    await recoverOrphanedScheduledTaskClaims();

    expect((await getTaskById(task.id))?.next_run).not.toBeNull();
    expect((await getDueTasks()).map(({ id }) => id)).toContain(task.id);
    expect(await updateScheduledTaskIfIdle(task.id, { status: 'paused' })).toBe(
      true,
    );
  });

  test('does not misclassify a scheduled web run with a missing directory as chat', async () => {
    const {
      createConversation,
      createScheduledTask,
      getActiveRunById,
      getChatMessages,
      getTaskById,
      getTaskRunLogs,
      insertActiveRun,
    } = await import('./db.js');

    const conversation = await createConversation('test-proj');
    const scheduledTaskId = `scheduled-missing-dir-${Date.now()}`;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Run a recurring check',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      isScheduledTask: 1,
      scheduled_task_id: scheduledTaskId,
    };
    await insertActiveRun(run);

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns();

    expect((await getActiveRunById(run.id))?.status).toBe('error');
    const recoveredTask = await getTaskById(scheduledTaskId);
    expect(recoveredTask?.next_run).not.toBe(dueAt);
    expect(recoveredTask?.last_result).toBe(
      'Error: Interrupted: server restarted during execution',
    );
    expect(await getTaskRunLogs(scheduledTaskId)).toMatchObject([
      {
        status: 'error',
        result: null,
        error: 'Interrupted: server restarted during execution',
      },
    ]);
    expect(await getChatMessages('test-proj', 10, conversation.id)).toEqual([]);
  });

  test('routes a timed-out scheduled run with a task id through scheduled recovery', async () => {
    const { GROUPS_DIR } = await import('./config.js');
    const {
      createConversation,
      createScheduledTask,
      createTask,
      getActiveRunById,
      getChatMessages,
      getTaskRunLogs,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const conversation = await createConversation('test-proj');
    const kanbanTask = await createTask(
      taskFixture({ project_id: 'test-proj' }),
    );
    const scheduledTaskId = `scheduled-timeout-${Date.now()}`;
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Preserve this timed-out scheduled prompt',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      conversation_id: conversation.id,
      task_id: kanbanTask.id,
      isScheduledTask: 1,
      scheduled_task_id: scheduledTaskId,
      timeout_at: new Date(Date.now() - 1_000).toISOString(),
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'prompt.txt'),
      'scheduled timeout prompt',
    );
    writeV1Run(runDir, {
      result: 'partial scheduled output',
      status: null,
    });
    await insertActiveRun(run);

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns();

    expect((await getActiveRunById(run.id))?.status).toBe('timeout');
    expect(await getChatMessages('test-proj', 10, conversation.id)).toEqual([]);
    expect(await getTaskRunLogs(scheduledTaskId)).toMatchObject([
      {
        run_id: run.id,
        status: 'error',
        error: 'Timed out: agent did not finish before deadline',
      },
    ]);
    const transcriptDir = path.join(
      GROUPS_DIR,
      'test-proj',
      'session-transcripts',
    );
    expect(
      fs.readFileSync(path.join(transcriptDir, `${run.id}.prompt.txt`), 'utf8'),
    ).toBe('scheduled timeout prompt');
    expect(
      fs.readFileSync(path.join(transcriptDir, `${run.id}.v1.jsonl`), 'utf8'),
    ).toContain('partial scheduled output');
    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('finalizes a scheduled occurrence when asynchronous orphan recovery throws', async () => {
    const { GROUPS_DIR } = await import('./config.js');
    const {
      createConversation,
      createScheduledTask,
      getActiveRunById,
      getChatMessages,
      getDueTasks,
      getTaskById,
      getTaskRunLogs,
      insertActiveRun,
    } = await import('./db.js');

    const conversation = await createConversation('test-proj');
    const scheduledTaskId = `scheduled-thrown-recovery-${Date.now()}`;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Recover a thrown scheduled run',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      conversation_id: conversation.id,
      isScheduledTask: 1,
      scheduled_task_id: scheduledTaskId,
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    // Overflowing active_runs' integer telemetry makes updateRunStats reject
    // after waitForRun has returned, exercising the outer recovery catch.
    writeV1Run(runDir, {
      extraEvents: [
        {
          type: 'usage',
          scope: 'incremental',
          inputTokens: 9_999_999_999_999,
          outputTokens: 1,
        },
      ],
    });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'prompt');
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    await insertActiveRun(run);

    const { recoverOrphanedRuns } = await import('./recovery.js');
    await expect(recoverOrphanedRuns()).resolves.toBeUndefined();

    expect((await getActiveRunById(run.id))?.status).toBe('error');
    expect(await getTaskRunLogs(scheduledTaskId)).toMatchObject([
      {
        run_id: run.id,
        status: 'error',
        error: 'Failed to recover run after restart',
      },
    ]);
    const recovered = await getTaskById(scheduledTaskId);
    expect(recovered?.next_run).not.toBe(dueAt);
    expect(recovered?.last_result).toBe(
      'Error: Failed to recover run after restart',
    );
    expect((await getDueTasks()).map((task) => task.id)).not.toContain(
      scheduledTaskId,
    );
    expect(await getChatMessages('test-proj', 10, conversation.id)).toEqual([]);
    const transcriptDir = path.join(
      GROUPS_DIR,
      'test-proj',
      'session-transcripts',
    );
    expect(
      fs.readFileSync(path.join(transcriptDir, `${run.id}.v1.jsonl`), 'utf8'),
    ).toContain('"type":"usage"');
    expect(
      fs.readFileSync(path.join(transcriptDir, `${run.id}.prompt.txt`), 'utf8'),
    ).toBe('prompt');
    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('finalizes a stalled scheduled orphan with history and preserved IPC transcript', async () => {
    const { GROUPS_DIR } = await import('./config.js');
    const {
      createScheduledTask,
      getActiveRunById,
      getDueTasks,
      getTaskRunLogs,
      insertActiveRun,
    } = await import('./db.js');
    const taskId = `scheduled-stalled-recovery-${Date.now()}`;
    await createScheduledTask({
      id: taskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'stalled prompt',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    // Idle far beyond STALL_TIMEOUT_MS while the hard deadline has not yet
    // passed — the stall safety net must still finalize the occurrence.
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      isScheduledTask: 1,
      scheduled_task_id: taskId,
      last_event_at: '1970-01-01T00:00:00.000Z',
      timeout_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'stalled prompt');
    writeV1Run(runDir, { result: 'stalled' });
    await insertActiveRun(run);

    const { recoverOrphanedRuns } = await import('./recovery.js');
    await recoverOrphanedRuns();

    expect((await getActiveRunById(run.id))?.status).toBe('stalled');
    expect(await getTaskRunLogs(taskId)).toMatchObject([
      { run_id: run.id, status: 'error' },
    ]);
    expect((await getDueTasks()).map((task) => task.id)).not.toContain(taskId);
    const transcriptDir = path.join(
      GROUPS_DIR,
      'test-proj',
      'session-transcripts',
    );
    expect(fs.existsSync(path.join(transcriptDir, `${run.id}.v1.jsonl`))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(transcriptDir, `${run.id}.prompt.txt`)),
    ).toBe(true);
    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('re-adopts a completed scheduled orphan past its stored timeout_at', async () => {
    // Scheduled Direct runs have no task_id, so the live path never applies
    // the hard wall-clock deadline to them (see chatTimeoutMs in
    // runContainerAgent). Recovery must honor the same intent: an agent that
    // finished while the board was down (exit_code present) is re-adopted
    // and completed even when the stored timeout_at already passed. Before
    // the fix, the run was discarded as 'timeout' and the finished output
    // was lost.
    const { GROUPS_DIR } = await import('./config.js');
    const {
      createScheduledTask,
      getActiveRunById,
      getDueTasks,
      getTaskRunLogs,
      insertActiveRun,
    } = await import('./db.js');
    const taskId = `scheduled-reattach-recovery-${Date.now()}`;
    await createScheduledTask({
      id: taskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'long scheduled prompt',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      isScheduledTask: 1,
      scheduled_task_id: taskId,
      last_event_at: null,
      timeout_at: '1970-01-01T00:00:01.000Z',
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'long scheduled prompt');
    writeV1Run(runDir, {
      result: 'Scheduled result recovered after a long turn',
    });
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    await insertActiveRun(run);

    const { recoverOrphanedRuns } = await import('./recovery.js');
    await expect(recoverOrphanedRuns()).resolves.toBeUndefined();

    expect((await getActiveRunById(run.id))?.status).toBe('completed');
    expect(await getTaskRunLogs(taskId)).toMatchObject([
      { run_id: run.id, status: 'success' },
    ]);
    expect((await getDueTasks()).map((task) => task.id)).not.toContain(taskId);
    const transcriptDir = path.join(
      GROUPS_DIR,
      'test-proj',
      'session-transcripts',
    );
    expect(fs.existsSync(path.join(transcriptDir, `${run.id}.v1.jsonl`))).toBe(
      true,
    );
    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('recovered web chat archives one canonical replay before completion', async () => {
    const { createConversation, insertActiveRun } = await import('./db.js');
    const { chatTranscriptPath } = await import('./group-dir.js');
    const { formatTranscriptEntries } =
      await import('./modules/transcripts/transcript-store.js');

    const conversation = await createConversation('test-proj');
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      conversation_id: conversation.id,
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, {
      result: 'Recovered reply',
      harness: 'codex',
      extraEvents: [
        {
          type: 'usage',
          scope: 'incremental',
          inputTokens: 2,
          outputTokens: 2,
        },
      ],
    });
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    await insertActiveRun(run);

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns();

    const transcriptPath = chatTranscriptPath(
      'test-proj',
      undefined,
      conversation.id,
    );
    const raw = fs
      .readFileSync(transcriptPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const replay = formatTranscriptEntries(raw) as Array<{
      type?: string;
      role?: string;
      content?: string;
    }>;
    expect(
      replay.filter(
        (entry) => entry.type === 'message' && entry.role === 'assistant',
      ),
    ).toHaveLength(1);
    expect(replay.find((entry) => entry.role === 'assistant')?.content).toBe(
      'Recovered reply',
    );
  });

  test('recovery settles only the ask owned by the recovered chat run', async () => {
    const { createConversation, insertActiveRun } = await import('./db.js');
    const { insertAgentAsk, getAgentAsk } =
      await import('./modules/agent-asks/db-agent-asks.js');
    const { recoverStalledRuns } = await import('./recovery.js');
    const conversation = await createConversation('test-proj');
    const ask = await insertAgentAsk({
      callerProjectId: 'test-proj',
      callerName: 'Caller',
      targetProjectId: 'test-proj',
      targetConversationId: conversation.id,
      askMessageId: 'ask-message',
      status: 'pending',
    });
    const recover = async (agentAskId?: string, failed = false) => {
      const run = {
        ...makeRun(),
        chat_jid: 'test-proj@web',
        conversation_id: conversation.id,
        agent_ask_id: agentAskId,
      };
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      fs.mkdirSync(runDir, { recursive: true });
      if (failed) fs.writeFileSync(path.join(runDir, 'output.jsonl'), '');
      else writeV1Run(runDir, { result: 'Recovered answer' });
      fs.writeFileSync(path.join(runDir, 'exit_code'), failed ? '1\n' : '0\n');
      await insertActiveRun(run);
      await recoverStalledRuns();
    };

    await recover();
    expect((await getAgentAsk(ask.id))?.status).toBe('pending');
    await recover(ask.id);
    expect((await getAgentAsk(ask.id))?.status).toBe('answered');

    const failedAsk = await insertAgentAsk({
      callerProjectId: 'test-proj',
      callerName: 'Caller',
      targetProjectId: 'test-proj',
      targetConversationId: conversation.id,
      askMessageId: 'second-ask-message',
      status: 'pending',
    });
    await recover(failedAsk.id, true);
    expect((await getAgentAsk(failedAsk.id))?.status).toBe('failed');
  });

  test('adopted web chat keeps its final reply after the tool calls, once', async () => {
    const { createConversation, insertActiveRun } = await import('./db.js');
    const { chatTranscriptPath } = await import('./group-dir.js');
    const { formatTranscriptEntries } =
      await import('./modules/transcripts/transcript-store.js');
    const { recoverOrphanedRuns } = await import('./recovery.js');

    const conversation = await createConversation('test-proj');
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      conversation_id: conversation.id,
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, {
      result: 'Final reply',
      extraEvents: [
        {
          type: 'tool_call',
          id: 'toolu_1',
          status: 'completed',
          name: 'Bash',
          input: { command: 'ls' },
          output: 'a',
        },
      ],
    });
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    await insertActiveRun(run);

    await recoverOrphanedRuns();

    const raw = fs
      .readFileSync(
        chatTranscriptPath('test-proj', undefined, conversation.id),
        'utf8',
      )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    // Replay merges adjacent assistant entries, so check the text order.
    const replay = (
      formatTranscriptEntries(raw) as Array<{
        type?: string;
        role?: string;
        content?: string;
      }>
    )
      .filter((entry) => entry.type === 'message' && entry.role === 'assistant')
      .map((entry) => entry.content ?? '')
      .join('\n');
    expect(replay.split('Final reply')).toHaveLength(2);
    expect(replay.indexOf('**Bash**')).toBeLessThan(
      replay.indexOf('Final reply'),
    );
  });

  test('adopted web chat hands off a follow-up queued during recovery and leaves no running row', async () => {
    const { createConversation, getActiveRunById, insertActiveRun } =
      await import('./db.js');
    const { getActiveRunForConversation } = await import('./db/active-runs.js');
    const { appendChatTranscriptEntryAsync } = await import('./group-dir.js');
    const { directFollowupRunId } =
      await import('./modules/chat/direct-followups.js');
    const { recoverOrphanedRuns } = await import('./recovery.js');

    const conversation = await createConversation('test-proj');
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      conversation_id: conversation.id,
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, { result: 'Recovered reply' });
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    await insertActiveRun(run);

    // A form answer admitted while the run was being recovered.
    const messageId = 'queued-during-recovery';
    const createdAt = new Date().toISOString();
    await appendChatTranscriptEntryAsync('test-proj', conversation.id, {
      type: 'queued_user_message',
      id: messageId,
      role: 'user',
      content: 'Form answer',
      source: 'web',
      created_at: createdAt,
      directOwned: true,
      queuedExecutionContent: 'Form answer',
      queuedAgentCmd: 'claude',
      conversation_id: conversation.id,
    });
    await appendChatTranscriptEntryAsync('test-proj', conversation.id, {
      type: 'direct_user_pending',
      messageId,
      conversation_id: conversation.id,
      agentCmd: 'claude',
      executionContent: 'Form answer',
      created_at: createdAt,
    });

    await recoverOrphanedRuns();

    const followupId = directFollowupRunId(
      'test-proj',
      conversation.id,
      messageId,
    );
    // The handoff claimed the follow-up; its turn then settles to a terminal row.
    expect(await getActiveRunById(followupId)).toBeDefined();
    for (let i = 0; i < 100; i++) {
      if (!(await getActiveRunForConversation(conversation.id))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await getActiveRunById(run.id))?.status).not.toBe('running');
    expect((await getActiveRunById(followupId))?.status).not.toBe('running');
    expect(await getActiveRunForConversation(conversation.id)).toBeUndefined();
  });

  test('advances a recovered schedule even when its run log cannot be persisted', async () => {
    const { createScheduledTask, getDueTasks, getTaskById, insertActiveRun } =
      await import('./db.js');

    const scheduledTaskId = `scheduled-log-failure-${Date.now()}`;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Run despite a broken history write',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });

    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      isScheduledTask: 1,
      scheduled_task_id: scheduledTaskId,
      // task_run_logs.duration_ms is a 32-bit integer. This old timestamp
      // deterministically makes that best-effort insert fail with overflow.
      started_at: '1970-01-01T00:00:00.000Z',
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, { result: 'Recovered result' });
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    await insertActiveRun(run);

    const { recoverStalledRuns } = await import('./recovery.js');
    await expect(recoverStalledRuns()).resolves.toBeUndefined();

    const recovered = await getTaskById(scheduledTaskId);
    expect(recovered?.next_run).not.toBe(dueAt);
    expect((await getDueTasks()).map((task) => task.id)).not.toContain(
      scheduledTaskId,
    );
  });

  test('advances an asynchronously recovered schedule when its run log cannot be persisted', async () => {
    const {
      createScheduledTask,
      getActiveRunById,
      getDueTasks,
      getTaskById,
      insertActiveRun,
    } = await import('./db.js');

    const scheduledTaskId = `scheduled-async-log-failure-${Date.now()}`;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Reconnect despite a broken history write',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });

    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      isScheduledTask: 1,
      scheduled_task_id: scheduledTaskId,
      // Force task_run_logs.duration_ms beyond its 32-bit integer range.
      started_at: '1970-01-01T00:00:00.000Z',
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, { result: 'Reconnected result' });
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    await insertActiveRun(run);

    const { recoverOrphanedRuns } = await import('./recovery.js');
    await expect(recoverOrphanedRuns()).resolves.toBeUndefined();

    expect((await getActiveRunById(run.id))?.status).toBe('completed');
    const recovered = await getTaskById(scheduledTaskId);
    expect(recovered?.next_run).not.toBe(dueAt);
    expect((await getDueTasks()).map((task) => task.id)).not.toContain(
      scheduledTaskId,
    );
    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('advances a scheduled task whose run completed before restart finalization', async () => {
    const { GROUPS_DIR } = await import('./config.js');
    const {
      completeActiveRun,
      createScheduledTask,
      getDueTasks,
      getScheduledTaskRuns,
      getTaskById,
      getTaskRunLogs,
      insertActiveRun,
    } = await import('./db.js');
    const { deleteScheduledTaskWithTranscripts } =
      await import('./modules/chat/scheduling/delete-task.js');
    const { recoverUnfinalizedScheduledRuns } = await import('./recovery.js');

    const scheduledTaskId = `scheduled-terminal-recovery-${Date.now()}`;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Run a recurring check',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      isScheduledTask: 1,
      scheduled_task_id: scheduledTaskId,
    };
    await insertActiveRun(run);
    await completeActiveRun(run.id, 'completed');
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, { result: 'Recovered result' });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'Run a recurring check');
    const transcriptDir = path.join(
      GROUPS_DIR,
      'test-proj',
      'session-transcripts',
    );
    const transcriptPath = path.join(transcriptDir, `${run.id}.v1.jsonl`);
    const promptPath = path.join(transcriptDir, `${run.id}.prompt.txt`);
    expect(fs.existsSync(transcriptPath)).toBe(false);

    // Simulate boot after the scheduler process died before updating next_run.
    await recoverUnfinalizedScheduledRuns();
    const recovered = await getTaskById(scheduledTaskId);
    const recoveredNextRun = recovered?.next_run;
    expect(recoveredNextRun).not.toBe(dueAt);
    expect(new Date(recoveredNextRun!).getTime()).toBeGreaterThan(Date.now());
    expect(recovered?.last_result).toBe(
      'Completed (finalized during restart recovery)',
    );
    expect((await getDueTasks()).map((task) => task.id)).not.toContain(
      scheduledTaskId,
    );
    expect(await getTaskRunLogs(scheduledTaskId)).toMatchObject([
      {
        run_id: run.id,
        status: 'success',
        result: 'Completed (finalized during restart recovery)',
      },
    ]);
    const recoveredHistory = await getScheduledTaskRuns(scheduledTaskId);
    expect(recoveredHistory.logs).toHaveLength(1);
    expect(recoveredHistory.logs[0]?.log.run_id).toBe(run.id);
    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(fs.existsSync(promptPath)).toBe(true);
    expect(fs.existsSync(runDir)).toBe(false);

    // Re-running startup recovery must not advance the same occurrence twice.
    await recoverUnfinalizedScheduledRuns();
    expect((await getTaskById(scheduledTaskId))?.next_run).toBe(
      recoveredNextRun,
    );
    expect(await getTaskRunLogs(scheduledTaskId)).toHaveLength(1);

    await deleteScheduledTaskWithTranscripts(scheduledTaskId, 'test-proj');
    expect(fs.existsSync(transcriptPath)).toBe(false);
    expect(fs.existsSync(promptPath)).toBe(false);
    expect(await getTaskRunLogs(scheduledTaskId)).toEqual([]);
  });

  test('does not duplicate history when the run log persisted before the schedule advance', async () => {
    const {
      completeActiveRun,
      createScheduledTask,
      getTaskById,
      getTaskRunLogs,
      insertActiveRun,
      logTaskRun,
    } = await import('./db.js');
    const { recoverUnfinalizedScheduledRuns } = await import('./recovery.js');
    const scheduledTaskId = `scheduled-partial-finalize-${Date.now()}`;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Recover exactly once',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      isScheduledTask: 1,
      scheduled_task_id: scheduledTaskId,
    };
    await insertActiveRun(run);
    await completeActiveRun(run.id, 'completed');
    await logTaskRun({
      task_id: scheduledTaskId,
      run_id: run.id,
      run_at: run.started_at,
      duration_ms: 10,
      status: 'success',
      result: 'Persisted before crash',
      error: null,
    });

    await recoverUnfinalizedScheduledRuns();

    expect(await getTaskRunLogs(scheduledTaskId)).toMatchObject([
      { run_id: run.id, result: 'Persisted before crash' },
    ]);
    expect(await getTaskRunLogs(scheduledTaskId)).toHaveLength(1);
    expect((await getTaskById(scheduledTaskId))?.next_run).not.toBe(dueAt);
  });

  test('retains terminal scheduled IPC when restart transcript preservation fails', async () => {
    const { GROUPS_DIR } = await import('./config.js');
    const {
      completeActiveRun,
      createScheduledTask,
      getTaskRunLogs,
      insertActiveRun,
    } = await import('./db.js');
    const { recoverUnfinalizedScheduledRuns } = await import('./recovery.js');
    const taskId = `scheduled-recovery-copy-failure-${Date.now()}`;
    await createScheduledTask({
      id: taskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Keep source evidence',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      isScheduledTask: 1,
      scheduled_task_id: taskId,
    };
    await insertActiveRun(run);
    await completeActiveRun(run.id, 'completed');
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'Keep source evidence');
    fs.writeFileSync(path.join(runDir, 'output.jsonl'), '{}\n');
    const groupDir = path.join(GROUPS_DIR, 'test-proj');
    const transcriptTarget = path.join(groupDir, 'session-transcripts');
    fs.rmSync(transcriptTarget, { recursive: true, force: true });
    fs.writeFileSync(transcriptTarget, 'blocked');

    try {
      await recoverUnfinalizedScheduledRuns();
      expect(await getTaskRunLogs(taskId)).toMatchObject([
        { run_id: run.id, status: 'success' },
      ]);
      expect(fs.existsSync(runDir)).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'prompt.txt'))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'output.jsonl'))).toBe(true);
    } finally {
      fs.rmSync(transcriptTarget, { recursive: true, force: true });
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('guarded recovery finalization preserves an edit accepted after history insertion', async () => {
    const {
      completeActiveRun,
      createScheduledTask,
      getTaskById,
      insertActiveRun,
      logTaskRun,
      updateScheduledTaskAfterRun,
      updateScheduledTaskIfIdle,
    } = await import('./db.js');
    const scheduledTaskId = `scheduled-recovery-edit-race-${Date.now()}`;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: 'test-proj',
      chat_jid: 'test-proj@web',
      prompt: 'Original recovered occurrence',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const run = {
      ...makeRun(),
      chat_jid: 'test-proj@web',
      isScheduledTask: 1,
      scheduled_task_id: scheduledTaskId,
    };
    await insertActiveRun(run);
    await completeActiveRun(run.id, 'completed');
    const occurrence = (await getTaskById(scheduledTaskId))!;

    await logTaskRun({
      task_id: scheduledTaskId,
      run_id: run.id,
      run_at: run.started_at,
      duration_ms: 10,
      status: 'success',
      result: 'Recovered result',
      error: null,
    });
    const editedNextRun = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      await updateScheduledTaskIfIdle(scheduledTaskId, {
        schedule_value: '120000',
        next_run: editedNextRun,
        status: 'paused',
      }),
    ).toBe(true);

    expect(
      await updateScheduledTaskAfterRun(
        scheduledTaskId,
        new Date(Date.now() + 60_000).toISOString(),
        'Stale recovery result',
        occurrence,
      ),
    ).toBe(false);
    expect(await getTaskById(scheduledTaskId)).toMatchObject({
      schedule_value: '120000',
      next_run: editedNextRun,
      status: 'paused',
      last_run: null,
      last_result: null,
    });
  });

  test('a successful agent result survives a non-zero wrapper exit during recovery', async () => {
    const {
      createTask,
      createUser,
      getTask,
      getUnreadPayloads,
      insertActiveRun,
      upsertProjectMember,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');

    const owner = await createUser('recovery-success-owner', 'pw', 'user');
    const triggerer = await createUser(
      'recovery-success-triggerer',
      'pw',
      'user',
    );
    await upsertProjectMember(owner.id, 'test-proj', 'editor');
    await upsertProjectMember(triggerer.id, 'test-proj', 'editor');

    const task = await createTask(
      taskFixture({
        project_id: 'test-proj',
        status: 'in_progress',
        ownerUserId: owner.id,
        lastTriggeredByUserId: triggerer.id,
        lastTriggerSource: 'user',
      }),
    );
    const run = {
      ...makeRun(),
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      triggeredByUserId: triggerer.id,
      triggerSource: 'user' as const,
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, {
      result: 'Completed work despite wrapper exit',
    });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'recovery prompt');
    fs.writeFileSync(path.join(runDir, 'exit_code'), '1\n');
    await insertActiveRun(run);

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns();

    const recovered = await getTask(task.id);
    expect(recovered?.status).toBe('completed');
    expect(recovered?.error).toBeFalsy();
    expect(recovered?.output).toBe('Completed work despite wrapper exit');
    expect(await getUnreadPayloads(owner.id)).toEqual([
      expect.objectContaining({ summary: `Task completed: ${task.title}` }),
    ]);
    expect(await getUnreadPayloads(triggerer.id)).toEqual([
      expect.objectContaining({ summary: `Task completed: ${task.title}` }),
    ]);
    const { GROUPS_DIR } = await import('./config.js');
    const runTranscriptDir = path.join(
      GROUPS_DIR,
      'test-proj',
      'session-transcripts',
    );
    expect(
      fs.readFileSync(
        path.join(runTranscriptDir, `${run.id}.v1.jsonl`),
        'utf8',
      ),
    ).toContain('Completed work despite wrapper exit');
    expect(
      fs.readFileSync(
        path.join(runTranscriptDir, `${run.id}.prompt.txt`),
        'utf8',
      ),
    ).toBe('recovery prompt');
    expect(fs.existsSync(runDir)).toBe(false);

    await recoverStalledRuns();
    expect(
      readTaskMessages(task.project_id, task.id).filter(
        (message) =>
          message.entry_type === 'run_result' && message.run_id === run.id,
      ),
    ).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: 'Completed work despite wrapper exit',
      }),
    ]);
  });

  test('finalizes raw ACP output for a task-persistent runtime instead of launching a continuation', async () => {
    const { TASK_PERSISTENT_RUNTIME_CONTRACT } =
      await import('./sandbox/process.js');

    for (const {
      agentCmd: agentName,
      warmOutputFile: outputFile,
    } of TASK_PERSISTENT_RUNTIME_CONTRACT.slice(0, 1)) {
      const { createTask, getActiveRunById, getTask, insertActiveRun } =
        await import('./db.js');
      const { taskFixture } = await import('./test-helpers.js');
      const task = await createTask(
        taskFixture({
          project_id: 'test-proj',
          status: 'in_progress',
          session_id: 'warm-owned-session',
          last_agent_name: agentName,
        }),
      );
      const run = {
        ...makeRun(),
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
        session_id: 'warm-owned-session',
        agent_name: agentName,
        session_agent_key: agentName,
        runtime_variant: 'deadbeef',
      };
      const sessionDir = path.join(
        ipcBase,
        'carapa-bot-default',
        'sessions',
        `task-${task.id}-in_progress-deadbeef`,
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, 'session_id'),
        'warm-owned-session',
      );
      fs.writeFileSync(
        path.join(sessionDir, outputFile),
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'warm-owned-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Warm turn completed while Board was down',
              },
            },
          },
        })}\n${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { stopReason: 'end_turn' },
        })}\n`,
      );
      const survivingRunDir = path.join(
        ipcBase,
        'carapa-bot-default',
        'runs',
        run.id,
      );
      fs.mkdirSync(survivingRunDir, { recursive: true });
      // The worker's own V1 survives the restart with harness usage the
      // generic journal translation lacks; recovery must not replace it.
      writeV1Run(survivingRunDir, {
        result: 'Warm turn completed while Board was down',
        sessionId: 'warm-owned-session',
        harness: agentName,
        extraEvents: [
          {
            type: 'usage',
            scope: 'cumulative',
            inputTokens: 1234,
            outputTokens: 56,
          },
        ],
      });
      fs.writeFileSync(path.join(survivingRunDir, 'exit_code'), '1\n');
      fs.writeFileSync(path.join(survivingRunDir, 'metrics_contract'), '1\n');
      await insertActiveRun(run);
      let continuationLaunches = 0;

      const { recoverStalledRuns } = await import('./recovery.js');
      await recoverStalledRuns({
        executeTask: async () => {
          continuationLaunches++;
        },
      });

      expect(continuationLaunches).toBe(0);
      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'completed',
        session_id: 'warm-owned-session',
        result: 'Warm turn completed while Board was down',
        tok_total: 1290,
      });
      expect(await getTask(task.id)).toMatchObject({
        status: 'completed',
        session_id: 'warm-owned-session',
        output: 'Warm turn completed while Board was down',
      });
    }
  });

  test('recovers warm output only from the interrupted run runtime variant', async () => {
    const { createTask, getActiveRunById, getTask, insertActiveRun } =
      await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const task = await createTask(
      taskFixture({
        project_id: 'test-proj',
        status: 'in_progress',
        session_id: 'shared-native-session',
        last_agent_name: 'cursor-acp',
      }),
    );
    const run = {
      ...makeRun(),
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      stage: 'in_progress',
      session_id: 'shared-native-session',
      agent_name: 'cursor-acp',
      session_agent_key: 'cursor-acp',
      runtime_variant: 'bbbbbbbb',
    };
    const warmResult = (result: string) =>
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'shared-native-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: result },
          },
        },
      })}\n${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { stopReason: 'end_turn' },
      })}\n`;
    for (const [variant, result] of [
      ['aaaaaaaa', 'Stale runtime result'],
      ['bbbbbbbb', 'Owned runtime result'],
    ] as const) {
      const sessionDir = path.join(
        ipcBase,
        'carapa-bot-default',
        'sessions',
        `task-${task.id}-in_progress-${variant}`,
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, 'session_id'),
        'shared-native-session',
      );
      fs.writeFileSync(
        path.join(sessionDir, 'cursor-acp.out'),
        warmResult(result),
      );
    }
    writeV1Run(path.join(ipcBase, 'carapa-bot-default', 'runs', run.id), {
      result: 'Owned runtime result',
      sessionId: 'shared-native-session',
      harness: 'cursor-acp',
    });
    await insertActiveRun(run);

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns();

    expect(await getActiveRunById(run.id)).toMatchObject({
      status: 'completed',
      result: 'Owned runtime result',
      runtime_variant: 'bbbbbbbb',
    });
    expect(await getTask(task.id)).toMatchObject({
      status: 'completed',
      output: 'Owned runtime result',
      session_id: 'shared-native-session',
    });
  });

  test('reattaches an incomplete live task-owned warm turn without continuing it', async () => {
    const { createTask, getActiveRunById, insertActiveRun } =
      await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const task = await createTask(
      taskFixture({
        project_id: 'test-proj',
        status: 'in_progress',
        session_id: 'live-warm-session',
        last_agent_name: 'hermes-acp',
      }),
    );
    const run = {
      ...makeRun(),
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      stage: 'in_progress',
      session_id: 'live-warm-session',
      agent_name: 'hermes-acp',
      session_agent_key: 'hermes-acp',
      runtime_variant: 'deadbeef',
    };
    const sessionDir = path.join(
      ipcBase,
      'carapa-bot-default',
      'sessions',
      `task-${task.id}-in_progress-deadbeef`,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'daemon.pid'), '4242\n');
    fs.writeFileSync(path.join(sessionDir, 'session_id'), 'live-warm-session');
    fs.writeFileSync(
      path.join(sessionDir, 'hermes-acp.out'),
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'live-warm-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Already archived' },
          },
        },
      })}\n${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { stopReason: 'end_turn' },
      })}\n${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'live-warm-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Still working' },
          },
        },
      })}\n`,
    );
    await insertActiveRun(run);
    let continuationLaunches = 0;

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns({
      executeTask: async () => {
        continuationLaunches++;
      },
    });

    const reconstructedDir = path.join(
      ipcBase,
      'carapa-bot-default',
      'runs',
      run.id,
    );
    expect(continuationLaunches).toBe(0);
    expect(await getActiveRunById(run.id)).toMatchObject({ status: 'running' });
    expect(fs.existsSync(path.join(reconstructedDir, 'exit_code'))).toBe(false);
    const reconstructed = fs.readFileSync(
      path.join(reconstructedDir, 'output.v1.jsonl'),
      'utf8',
    );
    expect(reconstructed).toContain('Still working');
    expect(reconstructed).not.toContain('Already archived');
    expect(fs.existsSync(path.join(reconstructedDir, 'output.jsonl'))).toBe(
      false,
    );
    expect(
      readCarapaRunV1Pair(carapaRunV1Paths(reconstructedDir), {
        expectedHarness: 'hermes-acp',
        requireTerminal: false,
      }),
    ).not.toBeNull();
  });

  test('continues a partially-streamed warm turn when its per-turn owner later dies', async () => {
    const {
      createTask,
      getActiveRunById,
      getActiveRunsByStatus,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    await loadState();
    const projectId = `warm-turn-death-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(jid, {
      name: 'Warm turn death',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active',
            color: '#38f',
          },
          { id: 'completed', title: 'Completed', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    });
    try {
      const task = await createTask(
        taskFixture({
          project_id: projectId,
          status: 'in_progress',
          session_id: 'partially-streamed-session',
          last_agent_name: 'cursor-acp',
        }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
        session_id: 'partially-streamed-session',
        agent_name: 'cursor-acp',
        session_agent_key: 'cursor-acp',
        runtime_variant: 'deadbeef',
      };
      const sessionDir = path.join(
        ipcBase,
        'carapa-bot-default',
        'sessions',
        `task-${task.id}-in_progress-deadbeef`,
      );
      fs.mkdirSync(path.join(sessionDir, 'lock'), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'daemon.pid'), '7171\n');
      fs.writeFileSync(path.join(sessionDir, 'lock', 'pid'), '7272\n');
      fs.writeFileSync(
        path.join(sessionDir, 'session_id'),
        'partially-streamed-session\n',
      );
      const outputPath = path.join(sessionDir, 'cursor-acp.out');
      fs.writeFileSync(
        outputPath,
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'partially-streamed-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Unfinished output' },
            },
          },
        })}\n`,
      );
      const staleMtime = new Date(new Date(run.started_at).getTime() - 5_000);
      fs.utimesSync(outputPath, staleMtime, staleMtime);
      await insertActiveRun(run);
      let launches = 0;

      const { recoverOrphanedRuns, recoverStalledRuns } =
        await import('./recovery.js');
      await recoverStalledRuns({
        executeTask: async () => {
          launches++;
        },
      });
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      const orphanRecovery = recoverOrphanedRuns({
        executeTask: async () => {
          launches++;
        },
      });

      _deadPids.add('7272');
      await waitForFileState(runDir, () =>
        fs.existsSync(path.join(runDir, '.restart-warm-interrupted'))
          ? true
          : undefined,
      );
      await orphanRecovery;

      expect(launches).toBe(1);
      expect(await getActiveRunById(run.id)).toMatchObject({ status: 'error' });
      expect(await getActiveRunsByStatus('running')).toEqual([
        expect.objectContaining({
          restart_recovery_of_run_id: run.id,
          session_id: 'partially-streamed-session',
        }),
      ]);
    } finally {
      await unregisterGroup(jid);
    }
  }, 15_000);

  test('refreshes recovered warm output activity before orphan stall reaping', async () => {
    const { createTask, getActiveRunById, getTask, insertActiveRun } =
      await import('./db.js');
    const { STALL_TIMEOUT_MS } = await import('./config.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    await loadState();
    const projectId = `warm-activity-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(jid, {
      name: 'Warm activity recovery',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active',
            color: '#38f',
          },
          { id: 'completed', title: 'Completed', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    });
    try {
      const task = await createTask(
        taskFixture({
          project_id: projectId,
          status: 'in_progress',
          session_id: 'recent-warm-session',
          last_agent_name: 'cursor-acp',
        }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
        session_id: 'recent-warm-session',
        agent_name: 'cursor-acp',
        session_agent_key: 'cursor-acp',
        runtime_variant: 'deadbeef',
        last_event_at: new Date(
          Date.now() - STALL_TIMEOUT_MS - 60_000,
        ).toISOString(),
      };
      const sessionDir = path.join(
        ipcBase,
        'carapa-bot-default',
        'sessions',
        `task-${task.id}-in_progress-deadbeef`,
      );
      fs.mkdirSync(path.join(sessionDir, 'lock'), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'daemon.pid'), '7373\n');
      fs.writeFileSync(path.join(sessionDir, 'lock', 'pid'), '7474\n');
      fs.writeFileSync(path.join(sessionDir, 'session_id'), run.session_id);
      const outputPath = path.join(sessionDir, 'cursor-acp.out');
      const update = JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: run.session_id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Recent recovered activity' },
          },
        },
      });
      fs.writeFileSync(outputPath, `${update}\n`);
      await insertActiveRun(run);

      const { recoverOrphanedRuns, recoverStalledRuns } =
        await import('./recovery.js');
      await recoverStalledRuns();
      const refreshed = await getActiveRunById(run.id);
      expect(new Date(refreshed!.last_event_at!).getTime()).toBeGreaterThan(
        Date.now() - STALL_TIMEOUT_MS,
      );

      fs.appendFileSync(
        outputPath,
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { stopReason: 'cancelled' },
        })}\n`,
      );
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      await waitForFileState(runDir, () =>
        fs.existsSync(path.join(runDir, 'exit_code')) ? true : undefined,
      );
      // The box's V1 spool carries the result the recovered cold run reads.
      writeV1Run(runDir, {
        result: 'Recent recovered activity',
        harness: 'cursor-acp',
        status: 'failed',
      });
      await recoverOrphanedRuns();

      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'error',
        result: 'Recent recovered activity',
      });
      expect(await getTask(task.id)).toMatchObject({
        status: 'failed',
        output: 'Recent recovered activity',
      });
      expect(
        _sandboxExecCalls.some((call) =>
          call.command.startsWith('stop-agent.sh'),
        ),
      ).toBe(false);
    } finally {
      await unregisterGroup(jid);
    }
  }, 15_000);

  test('uses the per-turn lock instead of the persistent FIFO holder to classify an outputless warm turn', async () => {
    const {
      createTask,
      getActiveRunById,
      getActiveRunsByStatus,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    await loadState();
    const projectId = `idle-warm-recovery-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(jid, {
      name: 'Idle warm recovery',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active',
            color: '#38f',
          },
          { id: 'completed', title: 'Completed', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    });
    try {
      const task = await createTask(
        taskFixture({
          project_id: projectId,
          status: 'in_progress',
          session_id: 'empty-live-warm-session',
          last_agent_name: 'cursor-acp',
        }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
        session_id: 'empty-live-warm-session',
        agent_name: 'cursor-acp',
        session_agent_key: 'cursor-acp',
        runtime_variant: 'deadbeef',
      };
      const sessionDir = path.join(
        ipcBase,
        'carapa-bot-default',
        'sessions',
        `task-${task.id}-in_progress-deadbeef`,
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'daemon.pid'), '4243\n');
      fs.writeFileSync(path.join(sessionDir, 'holder.pid'), '5252\n');
      fs.mkdirSync(path.join(sessionDir, 'lock'));
      fs.writeFileSync(path.join(sessionDir, 'lock', 'pid'), '5353\n');
      fs.writeFileSync(
        path.join(sessionDir, 'session_id'),
        'empty-live-warm-session\n',
      );
      const outputPath = path.join(sessionDir, 'cursor-acp.out');
      fs.writeFileSync(
        outputPath,
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'empty-live-warm-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Older completed turn' },
            },
          },
        })}\n${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { stopReason: 'end_turn' },
        })}\n`,
      );
      const staleMtime = new Date(new Date(run.started_at).getTime() - 5_000);
      fs.utimesSync(outputPath, staleMtime, staleMtime);
      await insertActiveRun(run);
      let continuationLaunches = 0;
      let releaseContinuation!: () => void;
      const continuationPending = new Promise<void>((resolve) => {
        releaseContinuation = resolve;
      });
      let continuationFinished!: () => void;
      const continuationSettled = new Promise<void>((resolve) => {
        continuationFinished = resolve;
      });

      const { recoverStalledRuns } = await import('./recovery.js');
      await recoverStalledRuns({
        executeTask: async () => {
          continuationLaunches++;
        },
      });

      const reconstructedDir = path.join(
        ipcBase,
        'carapa-bot-default',
        'runs',
        run.id,
      );
      expect(continuationLaunches).toBe(0);
      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'running',
      });
      expect(fs.existsSync(reconstructedDir)).toBe(true);
      expect(fs.existsSync(path.join(reconstructedDir, 'exit_code'))).toBe(
        false,
      );

      // The production FIFO holder survives for the daemon lifetime. Only the
      // per-turn wrapper lock becomes stale when the interrupted turn is gone.
      _deadPids.add('5353');
      await recoverStalledRuns({
        executeTask: async () => {
          continuationLaunches++;
          await continuationPending;
          continuationFinished();
        },
      });
      await recoverStalledRuns({
        executeTask: async () => {
          continuationLaunches++;
        },
      });

      expect(continuationLaunches).toBe(1);
      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'error',
      });
      expect(await getActiveRunsByStatus('running')).toEqual([
        expect.objectContaining({
          restart_recovery_of_run_id: run.id,
          session_id: 'empty-live-warm-session',
        }),
      ]);
      expect(fs.existsSync(reconstructedDir)).toBe(false);
      expect(
        _sandboxExecCalls.some(
          (call) => call.command === 'agent-status.sh 4243',
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, 'holder.pid'))).toBe(true);
      releaseContinuation();
      await continuationSettled;
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('keeps an outputless warm turn attached while daemon liveness is unknown', async () => {
    const { createTask, getActiveRunById, insertActiveRun } =
      await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const task = await createTask(
      taskFixture({
        project_id: 'test-proj',
        status: 'in_progress',
        session_id: 'unknown-warm-session',
        last_agent_name: 'cursor-acp',
      }),
    );
    const run = {
      ...makeRun(),
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      stage: 'in_progress',
      session_id: 'unknown-warm-session',
      agent_name: 'cursor-acp',
      session_agent_key: 'cursor-acp',
      runtime_variant: 'deadbeef',
    };
    const sessionDir = path.join(
      ipcBase,
      'carapa-bot-default',
      'sessions',
      `task-${task.id}-in_progress-deadbeef`,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'daemon.pid'), '6262\n');
    fs.writeFileSync(path.join(sessionDir, 'session_id'), run.session_id);
    fs.writeFileSync(path.join(sessionDir, 'cursor-acp.out'), '');
    _sandboxFailurePids.add('6262');
    await insertActiveRun(run);
    let continuationLaunches = 0;

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns({
      executeTask: async () => {
        continuationLaunches++;
      },
    });

    const reconstructedDir = path.join(
      ipcBase,
      'carapa-bot-default',
      'runs',
      run.id,
    );
    expect(continuationLaunches).toBe(0);
    expect(await getActiveRunById(run.id)).toMatchObject({ status: 'running' });
    expect(fs.existsSync(reconstructedDir)).toBe(true);
    expect(fs.existsSync(path.join(reconstructedDir, 'exit_code'))).toBe(false);
  });

  test('continues a dead warm turn despite a terminal cold-run spool', async () => {
    const {
      createTask,
      getActiveRunById,
      getActiveRunsByStatus,
      getTask,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    await loadState();
    const projectId = `dead-cold-recovery-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(jid, {
      name: 'Dead cold recovery',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active',
            color: '#38f',
          },
          { id: 'completed', title: 'Completed', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    });
    try {
      const task = await createTask(
        taskFixture({
          project_id: projectId,
          status: 'in_progress',
          session_id: 'dead-cold-session',
          last_agent_name: 'cursor-acp',
        }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
        session_id: 'dead-cold-session',
        agent_name: 'cursor-acp',
        session_agent_key: 'cursor-acp',
        runtime_variant: 'deadbeef',
      };
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      const sessionDir = path.join(
        ipcBase,
        'carapa-bot-default',
        'sessions',
        `task-${task.id}-in_progress-deadbeef`,
      );
      fs.mkdirSync(runDir, { recursive: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'pid'), '31337\n');
      fs.writeFileSync(
        path.join(runDir, 'output.jsonl'),
        `${JSON.stringify({ type: 'error', error: 'wrapper interrupted' })}\n`,
      );
      fs.writeFileSync(path.join(runDir, 'exit_code'), '1\n');
      fs.writeFileSync(path.join(sessionDir, 'daemon.pid'), '4244\n');
      fs.writeFileSync(
        path.join(sessionDir, 'session_id'),
        'dead-cold-session',
      );
      fs.writeFileSync(
        path.join(sessionDir, 'cursor-acp.out'),
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'dead-cold-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'unfinished warm output' },
            },
          },
        })}\n`,
      );
      const staleWarmMtime = new Date(
        new Date(run.started_at).getTime() - 5_000,
      );
      fs.utimesSync(
        path.join(sessionDir, 'cursor-acp.out'),
        staleWarmMtime,
        staleWarmMtime,
      );
      _deadPids.add('31337');
      _deadPids.add('4244');
      await insertActiveRun(run);
      let continuationLaunches = 0;

      const { recoverStalledRuns } = await import('./recovery.js');
      await recoverStalledRuns({
        executeTask: async () => {
          continuationLaunches++;
        },
      });

      expect(continuationLaunches).toBe(1);
      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'error',
        session_id: 'dead-cold-session',
      });
      expect(await getActiveRunsByStatus('running')).toEqual([
        expect.objectContaining({
          restart_recovery_of_run_id: run.id,
          session_id: 'dead-cold-session',
        }),
      ]);
      expect(await getTask(task.id)).toMatchObject({
        status: 'in_progress',
        error: null,
      });
      expect(fs.existsSync(runDir)).toBe(false);
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('redispatches the same undispatched restart reservation on the next boot', async () => {
    const {
      createTask,
      getActiveRunById,
      getActiveRunsByStatus,
      getTask,
      insertActiveRun,
      markRestartRecoveryRunDispatched,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    await loadState();
    const projectId = `durable-restart-claim-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(jid, {
      name: 'Durable restart claim',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active',
            color: '#38f',
          },
          { id: 'completed', title: 'Completed', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    });
    let releaseRedispatch = () => {};
    try {
      const task = await createTask(
        taskFixture({
          project_id: projectId,
          status: 'in_progress',
          session_id: 'durable-restart-session',
          last_agent_name: 'codex',
        }),
      );
      const interrupted = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
        session_id: 'durable-restart-session',
        agent_name: 'codex',
        session_agent_key: 'codex',
        runtime_variant: 'deadbeef',
      };
      await insertActiveRun(interrupted);
      let schedules = 0;
      let scheduledRunId: string | undefined;
      const { recoverOrphanedRuns, recoverStalledRuns } =
        await import('./recovery.js');
      const firstBootDependencies = {
        executeTask: async (
          _task: unknown,
          _group: unknown,
          options: {
            restartRecovery?: { continuationRunId: string };
          },
        ) => {
          schedules++;
          scheduledRunId = options.restartRecovery?.continuationRunId;
          expect(await getActiveRunById(interrupted.id)).toMatchObject({
            status: 'error',
          });
          expect(await getActiveRunById(scheduledRunId!)).toMatchObject({
            status: 'running',
            restart_recovery_of_run_id: interrupted.id,
            restart_recovery_dispatched_at: null,
          });
        },
      };

      await recoverStalledRuns(firstBootDependencies as any);
      const reservedRunId = scheduledRunId!;

      const redispatchMayFinish = new Promise<void>((resolve) => {
        releaseRedispatch = resolve;
      });
      let announceRedispatch!: () => void;
      const redispatchStarted = new Promise<void>((resolve) => {
        announceRedispatch = resolve;
      });
      let announceRedispatchFinished!: () => void;
      const redispatchFinished = new Promise<void>((resolve) => {
        announceRedispatchFinished = resolve;
      });
      const secondBootDependencies = {
        executeTask: async (
          _task: unknown,
          _group: unknown,
          options: {
            restartRecovery?: {
              interruptedRunId: string;
              continuationRunId: string;
            };
          },
        ) => {
          schedules++;
          expect(options.restartRecovery).toMatchObject({
            interruptedRunId: interrupted.id,
            continuationRunId: reservedRunId,
          });
          announceRedispatch();
          await redispatchMayFinish;
          announceRedispatchFinished();
        },
      };

      // Simulate a second Board process: the first asynchronous dispatcher has
      // returned without creating a run directory or stamping dispatch. The
      // stalled sweep must relaunch the existing outbox row, and the following
      // orphan sweep must leave that in-process redispatch alone.
      await recoverStalledRuns(secondBootDependencies as any);
      await redispatchStarted;
      await recoverOrphanedRuns(secondBootDependencies as any);

      expect(schedules).toBe(2);
      expect(await getActiveRunsByStatus('running')).toEqual([
        expect.objectContaining({
          id: reservedRunId,
          restart_recovery_of_run_id: interrupted.id,
          restart_recovery_dispatched_at: null,
        }),
      ]);
      expect(await getTask(task.id)).toMatchObject({
        status: 'in_progress',
        error: null,
      });

      expect(
        await markRestartRecoveryRunDispatched(reservedRunId, interrupted.id),
      ).toBe(true);
      releaseRedispatch();
      await redispatchFinished;

      // Once the harness boundary is durable, a later boot must treat this row
      // as the in-flight turn rather than consuming the session a second time.
      await recoverStalledRuns(secondBootDependencies as any);
      expect(schedules).toBe(2);
    } finally {
      releaseRedispatch();
      await unregisterGroup(jid);
    }
  });

  test('does not redispatch a restart continuation accepted before its database acknowledgement', async () => {
    const { createTask, getActiveRunById, insertActiveRun } =
      await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { RESTART_RECOVERY_DISPATCH_RECEIPT } =
      await import('./sandbox/process.js');
    const { loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    await loadState();
    const projectId = `accepted-restart-claim-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(jid, {
      name: 'Accepted restart claim',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active',
            color: '#38f',
          },
          { id: 'completed', title: 'Completed', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    });
    try {
      const task = await createTask(
        taskFixture({
          project_id: projectId,
          status: 'in_progress',
          session_id: 'accepted-restart-session',
          last_agent_name: 'cursor-acp',
        }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
        session_id: 'accepted-restart-session',
        agent_name: 'cursor-acp',
        session_agent_key: 'cursor-acp',
        runtime_variant: 'deadbeef',
        restart_recovery_of_run_id: 'original-interrupted-run',
        restart_recovery_dispatched_at: null,
      };
      await insertActiveRun(run);
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'pid'), '8181\n');
      fs.writeFileSync(
        path.join(runDir, RESTART_RECOVERY_DISPATCH_RECEIPT),
        '',
      );
      _deadPids.add('8181');
      let launches = 0;

      const { recoverStalledRuns } = await import('./recovery.js');
      await recoverStalledRuns({
        executeTask: async () => {
          launches++;
        },
      });

      expect(launches).toBe(0);
      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'running',
        restart_recovery_dispatched_at: expect.any(String),
      });
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('requires every original owner to be dead and the task deadline to remain open', async () => {
    const { completeActiveRun, createTask, getActiveRunById, insertActiveRun } =
      await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    await loadState();
    const projectId = `restart-owner-proof-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(jid, {
      name: 'Restart owner proof',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active',
            color: '#38f',
          },
          { id: 'completed', title: 'Completed', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    });
    try {
      const task = await createTask(
        taskFixture({
          project_id: projectId,
          status: 'in_progress',
          session_id: 'owner-proof-session',
          last_agent_name: 'codex',
        }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
        session_id: 'owner-proof-session',
        agent_name: 'codex',
        session_agent_key: 'codex',
        runtime_variant: 'deadbeef',
      };
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      const sessionDir = path.join(
        ipcBase,
        'carapa-bot-default',
        'sessions',
        `task-${task.id}-in_progress-deadbeef`,
      );
      fs.mkdirSync(runDir, { recursive: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'pid'), '5151\n');
      fs.writeFileSync(path.join(runDir, 'output.jsonl'), '');
      fs.writeFileSync(path.join(sessionDir, 'daemon.pid'), '6161\n');
      fs.writeFileSync(
        path.join(sessionDir, 'session_id'),
        'owner-proof-session\n',
      );
      fs.writeFileSync(
        path.join(sessionDir, 'cursor-acp.out'),
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'owner-proof-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Partial warm output' },
            },
          },
        })}\n`,
      );
      _deadPids.add('6161');
      await insertActiveRun(run);
      let continuationLaunches = 0;

      const { recoverOrphanedRuns, recoverStalledRuns } =
        await import('./recovery.js');
      const dependencies = {
        executeTask: async () => {
          continuationLaunches++;
        },
      };
      await recoverStalledRuns(dependencies);

      expect(continuationLaunches).toBe(0);
      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'running',
      });
      expect(fs.existsSync(path.join(runDir, 'exit_code'))).toBe(false);

      await completeActiveRun(run.id, 'error');
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });

      const expiredTask = await createTask(
        taskFixture({
          project_id: projectId,
          status: 'in_progress',
          session_id: 'expired-restart-session',
          last_agent_name: 'codex',
        }),
      );
      const expiredRun = {
        ...makeRun(),
        group_folder: projectId,
        task_id: expiredTask.id,
        chat_jid: `task-${expiredTask.id}@kanban`,
        stage: 'in_progress',
        session_id: 'expired-restart-session',
        agent_name: 'codex',
        session_agent_key: 'codex',
        timeout_at: '1970-01-01T00:00:01.000Z',
      };
      const expiredRunDir = path.join(
        ipcBase,
        'carapa-bot-default',
        'runs',
        expiredRun.id,
      );
      fs.mkdirSync(expiredRunDir, { recursive: true });
      fs.writeFileSync(path.join(expiredRunDir, 'output.jsonl'), '');
      fs.writeFileSync(path.join(expiredRunDir, 'exit_code'), '1\n');
      fs.writeFileSync(
        path.join(expiredRunDir, '.restart-warm-interrupted'),
        '',
      );
      await insertActiveRun(expiredRun);

      await recoverOrphanedRuns(dependencies);

      expect(continuationLaunches).toBe(0);
      expect(await getActiveRunById(expiredRun.id)).toMatchObject({
        status: 'timeout',
      });
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('claims one restart continuation across recovery, drain, and manual races', async () => {
    const {
      createTask,
      getActiveRunById,
      getActiveRunsByStatus,
      getTask,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture, runFixture } = await import('./test-helpers.js');
    const { readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const {
      claimTaskExecution,
      drainProjectQueue,
      executeTask,
      setGroupResolver,
    } = await import('./modules/kanban/task-executor.js');
    const { RESTART_RECOVERY_PROMPT } =
      await import('./modules/kanban/task/pipeline.js');
    const { persistentVariantTag } = await import('./sandbox/process.js');
    const { resolveKanbanRuntimeSelection, runtimeSessionKey } =
      await import('./lib/chat-agents.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');

    await loadState();
    const projectId = `restart-continuation-race-${Date.now()}`;
    const jid = `${projectId}@web`;
    const runtime = resolveKanbanRuntimeSelection([], 'implementation').agent;
    const runtimeAgentCmd = runtime.agentCmd || runtime.id;
    const runtimeSessionAgentKey = runtimeSessionKey(runtime);
    const runtimeVariant = persistentVariantTag(
      runtimeAgentCmd,
      runtime.model,
      runtime.env,
    );
    const group = {
      name: 'Restart continuation race',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        taskCheckoutMode: 'worktree' as const,
        stages: [
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done' as const,
            color: '#2c5',
          },
          {
            id: 'failed',
            title: 'Failed',
            type: 'queue' as const,
            color: '#f33',
          },
        ],
      },
    };
    await registerGroup(jid, group, { requirePersistence: true });
    setGroupResolver(getGroupByFolder);
    let releaseRun!: () => void;
    const runMayStart = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let announceBoundary!: () => void;
    const atBoundary = new Promise<void>((resolve) => {
      announceBoundary = resolve;
    });
    let announceSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      announceSettled = resolve;
    });
    try {
      const task = await createTask(
        taskFixture({
          project_id: projectId,
          status: 'implementation',
          description: 'Do not replay this description',
          session_id: 'restart-owned-session',
          last_agent_name: runtimeSessionAgentKey,
        }),
      );
      const interrupted = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        sandbox_instance: projectId,
        stage: 'implementation',
        session_id: 'restart-owned-session',
        agent_name: runtimeSessionAgentKey,
        session_agent_key: runtimeSessionAgentKey,
        model: runtime.model ?? null,
        runtime_variant: runtimeVariant,
      };
      await insertActiveRun(interrupted);
      // Model a manual Continue that passed its idle read immediately before
      // boot reconciliation, but has not crossed the agent launch boundary.
      const staleManualClaim = claimTaskExecution(task.id, task.project_id);
      expect(staleManualClaim).not.toBeNull();
      const inputs: import('./sandbox/process.js').ContainerInput[] = [];
      const recoveryExecutor: typeof executeTask = (
        recoveryTask,
        recoveryGroup,
        options,
      ) =>
        executeTask(recoveryTask, recoveryGroup, {
          ...options,
          testDependencies: {
            runContainerAgent: async (_group, input) => {
              inputs.push(input);
              announceBoundary();
              await runMayStart;
              const replacementId = input.precreatedActiveRunId!;
              const replacementDir = path.join(
                ipcBase,
                'carapa-bot-default',
                'runs',
                replacementId,
              );
              fs.mkdirSync(replacementDir, { recursive: true });
              fs.writeFileSync(path.join(replacementDir, 'output.jsonl'), '');
              await input.onActiveRunCreated?.(replacementId);
              await input.onSlotAcquired?.(replacementId);
              return {
                status: 'success' as const,
                result: 'Restart continuation finished',
                newSessionId: 'restart-owned-session',
              };
            },
            runPostExecutionGitOps: async () => {},
            mergeBranchForDeploy: async () => true,
            drainProjectQueue: async () => {
              announceSettled();
            },
          },
        });

      const { recoverOrphanedRuns, recoverStalledRuns } =
        await import('./recovery.js');
      await recoverStalledRuns({ executeTask: recoveryExecutor });
      expect(staleManualClaim!.signal.aborted).toBe(true);
      await atBoundary;

      await Promise.all([
        recoverStalledRuns({ executeTask: recoveryExecutor }),
        recoverOrphanedRuns({ executeTask: recoveryExecutor }),
        drainProjectQueue(projectId, group, {
          testDependencies: {
            executeTask: async () => {
              throw new Error('ordinary drain launched a duplicate');
            },
          },
        }),
        executeTask(task, group, {
          testDependencies: {
            runContainerAgent: async () => {
              throw new Error('manual Continue launched a duplicate');
            },
          },
        }),
      ]);

      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        prompt: RESTART_RECOVERY_PROMPT,
        session_id: 'restart-owned-session',
        stage_id: 'implementation',
        session_agent_key: runtimeSessionAgentKey,
      });
      const replacementId = inputs[0].precreatedActiveRunId!;
      releaseRun();
      await settled;

      expect(await getActiveRunById(interrupted.id)).toMatchObject({
        status: 'error',
        stage: 'implementation',
      });
      expect(await getActiveRunById(replacementId)).toMatchObject({
        status: 'completed',
        stage: 'implementation',
        restart_recovery_of_run_id: interrupted.id,
      });
      expect(await getActiveRunsByStatus('running')).toHaveLength(0);
      expect(await getTask(task.id)).toMatchObject({
        status: 'completed',
      });
      const messages = readTaskMessages(projectId, task.id);
      expect(
        messages.some(
          (message) =>
            message.role === 'user' &&
            message.content.includes(RESTART_RECOVERY_PROMPT),
        ),
      ).toBe(false);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            content: 'Restart continuation finished',
          }),
        ]),
      );
    } finally {
      releaseRun();
      await unregisterGroup(jid);
    }
  });

  test('terminal boot recovery holds durable steering in active_runs.stage and launches one ordered continuation', async () => {
    const {
      completeActiveRun,
      createTask,
      getActiveRunById,
      getActiveRunsByStatus,
      getTask,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { appendTaskMessage, readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const {
      drainProjectQueue,
      executeTask,
      getRunningTaskIds,
      setGroupResolver,
    } = await import('./modules/kanban/task-executor.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');

    await loadState();
    const projectId = `recovery-steering-terminal-${Date.now()}`;
    const jid = `${projectId}@web`;
    const group = {
      name: 'Recovery steering terminal',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        taskCheckoutMode: 'shared' as const,
        repositoryUrl: 'https://example.test/recovery-steering.git',
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done' as const,
            color: '#2c5',
          },
        ],
      },
    };
    await registerGroup(jid, group, { requirePersistence: true });
    setGroupResolver(getGroupByFolder);
    let releaseContinuation: (() => void) | undefined;
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'completed' }),
      );
      const firstPrompt = appendTaskMessage(projectId, {
        task_id: task.id,
        role: 'user',
        content: 'first recovered steering prompt',
        steering: true,
        created_at: '2026-09-07T10:00:00.000Z',
      });
      const secondPrompt = appendTaskMessage(projectId, {
        task_id: task.id,
        role: 'user',
        content: 'second recovered steering prompt',
        steering: true,
        created_at: '2026-09-07T10:00:01.000Z',
      });
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
        agent_name: 'direct',
        session_agent_key: 'direct',
      };
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      fs.mkdirSync(runDir, { recursive: true });
      writeV1Run(runDir, {
        result: 'Recovered implementation result',
        sessionId: 'recovered-session',
      });
      fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
      await insertActiveRun(run);

      const { recoverStalledRuns } = await import('./recovery.js');
      const continuationRunId = 'recovered-continuation-run';
      let launches = 0;
      let recoveredCheckpointCalls = 0;
      let continuationPrompt = '';
      let announceContinuation!: () => void;
      const continuationStarted = new Promise<void>((resolve) => {
        announceContinuation = resolve;
      });
      const continuationMayFinish = new Promise<void>((resolve) => {
        releaseContinuation = resolve;
      });
      let announceSettled!: () => void;
      const continuationSettled = new Promise<void>((resolve) => {
        announceSettled = resolve;
      });
      const recoveryQueueDrain = (
        projectId: string,
        recoveryGroup: Parameters<typeof drainProjectQueue>[1],
      ) =>
        drainProjectQueue(projectId, recoveryGroup, {
          testDependencies: {
            executeTask: async (
              continuationTask,
              continuationGroup,
              executionClaim,
            ) => {
              try {
                await executeTask(continuationTask, continuationGroup, {
                  executionClaim,
                  testDependencies: {
                    runContainerAgent: async (_group, input) => {
                      launches += 1;
                      continuationPrompt = input.prompt;
                      await insertActiveRun({
                        ...makeRun(),
                        id: continuationRunId,
                        group_folder: projectId,
                        task_id: continuationTask.id,
                        chat_jid: `task-${continuationTask.id}@kanban`,
                        stage: 'in_progress',
                      });
                      await input.onSlotAcquired?.(continuationRunId);
                      await input.onPromptRunAssigned?.(continuationRunId);
                      announceContinuation();
                      await continuationMayFinish;
                      await input.onPromptRunAccepted?.(continuationRunId);
                      await completeActiveRun(continuationRunId, 'completed');
                      return {
                        status: 'success',
                        result: 'Continuation completed',
                        newSessionId: 'continued-session',
                      };
                    },
                    runPostExecutionGitOps: async () => {},
                    mergeBranchForDeploy: async () => true,
                    drainProjectQueue: async () => {},
                  },
                });
              } finally {
                announceSettled();
              }
            },
          },
        });

      const recovery = recoverStalledRuns({
        drainProjectQueue: recoveryQueueDrain,
        runPostExecutionGitOps: async () => {
          recoveredCheckpointCalls++;
        },
      });
      await continuationStarted;

      expect(await getTask(task.id)).toMatchObject({
        status: 'in_progress',
        completed_at: null,
        session_id: 'recovered-session',
      });
      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'completed',
        stage: 'in_progress',
      });
      expect(await getActiveRunById(continuationRunId)).toMatchObject({
        status: 'running',
        stage: 'in_progress',
      });
      expect(await getActiveRunsByStatus('running')).toHaveLength(1);
      expect(launches).toBe(1);
      expect(recoveredCheckpointCalls).toBe(1);
      let messages = readTaskMessages(projectId, task.id);
      const inFlightAssignments = messages.filter(
        (message) => message.entry_type === 'steering_assignment',
      );
      expect(inFlightAssignments.map((request) => request.prompt_id)).toEqual([
        firstPrompt.id,
        secondPrompt.id,
      ]);
      expect(
        inFlightAssignments.every(
          (request) => request.run_id === continuationRunId,
        ),
      ).toBe(true);
      expect(
        messages.filter(
          (message) => message.entry_type === 'steering_delivery',
        ),
      ).toHaveLength(0);
      expect(
        messages.filter(
          (message) =>
            message.entry_type === 'run_result' && message.run_id === run.id,
        ),
      ).toHaveLength(1);

      releaseContinuation!();
      await continuationSettled;
      await recovery;

      // A reload/repeated boot sweep cannot receipt or redeliver prompts that
      // the automatically drained continuation already owns.
      await recoverStalledRuns({ drainProjectQueue: recoveryQueueDrain });
      messages = readTaskMessages(projectId, task.id);

      expect(launches).toBe(1);
      expect(continuationPrompt.indexOf(firstPrompt.content)).toBeLessThan(
        continuationPrompt.indexOf(secondPrompt.content),
      );
      const receipts = readTaskMessages(projectId, task.id).filter(
        (message) => message.entry_type === 'steering_delivery',
      );
      expect(receipts.map((receipt) => receipt.prompt_id)).toEqual([
        firstPrompt.id,
        secondPrompt.id,
      ]);
      expect(
        receipts.every((receipt) => receipt.run_id === continuationRunId),
      ).toBe(true);
      expect((await getTask(task.id))?.status).toBe('completed');
      expect(await getActiveRunById(continuationRunId)).toMatchObject({
        status: 'completed',
        stage: 'in_progress',
      });
      expect(await getActiveRunsByStatus('completed')).toHaveLength(2);
      expect(getRunningTaskIds()).not.toContain(task.id);
    } finally {
      releaseContinuation?.();
      await unregisterGroup(jid);
    }
  });

  test('recovered checkpoint failure parks the task in the initial stage with the checkpoint error', async () => {
    const { createTask, getActiveRunById, getTask, insertActiveRun } =
      await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const { setGroupResolver } =
      await import('./modules/kanban/task-executor.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');

    await loadState();
    const projectId = `recovery-checkpoint-parked-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(
      jid,
      {
        name: 'Recovery checkpoint parked',
        folder: projectId,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'running' as const,
          taskCheckoutMode: 'shared' as const,
          repositoryUrl: 'https://example.test/recovery-checkpoint.git',
          stages: [
            {
              id: 'backlog',
              title: 'Backlog',
              type: 'queue' as const,
              color: '#999',
            },
            {
              id: 'in_progress',
              title: 'In Progress',
              type: 'active' as const,
              color: '#38f',
            },
            {
              id: 'failed',
              title: 'Failed',
              type: 'queue' as const,
              color: '#e33',
            },
            {
              id: 'completed',
              title: 'Completed',
              type: 'done' as const,
              color: '#2c5',
            },
          ],
        },
      },
      { requirePersistence: true },
    );
    setGroupResolver(getGroupByFolder);
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'in_progress' }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
      };
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      fs.mkdirSync(runDir, { recursive: true });
      writeV1Run(runDir, {
        result: 'Recovered implementation result',
        sessionId: 'recovered-session',
      });
      fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
      await insertActiveRun(run);

      const { recoverStalledRuns } = await import('./recovery.js');
      await recoverStalledRuns({
        runPostExecutionGitOps: async () => {
          throw new Error('git broke');
        },
      });

      const parked = await getTask(task.id);
      expect(parked).toMatchObject({
        status: 'backlog',
        completed_at: null,
      });
      expect(parked?.error).toContain('Recovery checkpoint failed');
      expect(parked?.error).toContain('git broke');
      expect(await getActiveRunById(run.id)).toMatchObject({ status: 'error' });
      expect(
        readTaskMessages(projectId, task.id).some(
          (message) =>
            message.entry_type === 'system_notice' &&
            message.content.includes('Task checkpoint failed'),
        ),
      ).toBe(true);
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('terminal-file Testing format-repair recovery keeps its configured stage ahead of verdict effects', async () => {
    const {
      completeActiveRun,
      createTask,
      getActiveRunById,
      getActiveRunsByStatus,
      getTask,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { appendTaskMessage, readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const { drainProjectQueue, executeTask, isTaskRunning, setGroupResolver } =
      await import('./modules/kanban/task-executor.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');

    await loadState();
    const projectId = `recovery-steering-testing-${Date.now()}`;
    const jid = `${projectId}@web`;
    const group = {
      name: 'Recovery steering testing',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'testing' as const,
            color: '#a3f',
          },
          {
            id: 'review',
            title: 'Review',
            type: 'review' as const,
            color: '#f80',
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done' as const,
            color: '#2c5',
          },
        ],
      },
    };
    await registerGroup(jid, group, { requirePersistence: true });
    setGroupResolver(getGroupByFolder);
    let releaseContinuation: (() => void) | undefined;
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'review' }),
      );
      const prompt = appendTaskMessage(projectId, {
        task_id: task.id,
        role: 'user',
        content: 'inspect one more testing concern',
        steering: true,
        created_at: new Date().toISOString(),
      });
      const verdict = JSON.stringify({
        decision: 'pass',
        issues: [],
        summary: 'All focused checks passed.',
      });
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'testing',
      };
      // Format-repair attempts use a decorated harness label, but the durable
      // active-run stage remains the configured Testing stage.
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      fs.mkdirSync(runDir, { recursive: true });
      writeV1Run(runDir, {
        result: verdict,
        sessionId: 'recovered-testing-session',
      });
      fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
      await insertActiveRun(run);
      expect(await getActiveRunById(run.id)).toMatchObject({
        stage: 'testing',
      });

      const { recoverOrphanedRuns } = await import('./recovery.js');
      const continuationRunId = 'recovered-testing-continuation-run';
      const identity = '1111111111111111111111111111111111111111';
      let launches = 0;
      let recoveredCheckpointCalls = 0;
      let announceContinuation!: () => void;
      const continuationStarted = new Promise<void>((resolve) => {
        announceContinuation = resolve;
      });
      const continuationMayFinish = new Promise<void>((resolve) => {
        releaseContinuation = resolve;
      });
      let announceSettled!: () => void;
      const continuationSettled = new Promise<void>((resolve) => {
        announceSettled = resolve;
      });
      const recoveryQueueDrain = (
        projectId: string,
        recoveryGroup: Parameters<typeof drainProjectQueue>[1],
      ) =>
        drainProjectQueue(projectId, recoveryGroup, {
          testDependencies: {
            executeTask: async (
              continuationTask,
              continuationGroup,
              executionClaim,
            ) => {
              try {
                await executeTask(continuationTask, continuationGroup, {
                  executionClaim,
                  testDependencies: {
                    runContainerAgent: async (_group, input) => {
                      launches += 1;
                      await insertActiveRun({
                        ...makeRun(),
                        id: continuationRunId,
                        group_folder: projectId,
                        task_id: continuationTask.id,
                        chat_jid: `task-${continuationTask.id}@kanban`,
                        stage: 'testing',
                      });
                      await input.onSlotAcquired?.(continuationRunId);
                      await input.onPromptRunAssigned?.(continuationRunId);
                      announceContinuation();
                      await continuationMayFinish;
                      await input.onPromptRunAccepted?.(continuationRunId);
                      await completeActiveRun(continuationRunId, 'completed');
                      return {
                        status: 'success',
                        result: JSON.stringify({
                          decision: 'pass',
                          issues: [],
                          summary: 'Continuation checks passed.',
                        }),
                        newSessionId: 'continued-testing-session',
                      };
                    },
                    prepareTaskBranchForReview: async () => {},
                    readTaskGitContentIdentity: async () => ({
                      headSha: identity,
                      treeSha: identity,
                    }),
                    runGitInRepo: async () => ({
                      ok: true,
                      output: identity,
                    }),
                    inspectTaskLinkedRepositories: async () => ({
                      repositories: [],
                    }),
                    runPostExecutionGitOps: async () => {},
                    drainProjectQueue: async () => {},
                  },
                });
              } finally {
                announceSettled();
              }
            },
          },
        });

      const recovery = recoverOrphanedRuns({
        drainProjectQueue: recoveryQueueDrain,
        runPostExecutionGitOps: async () => {
          recoveredCheckpointCalls++;
        },
      });
      await continuationStarted;

      expect(await getTask(task.id)).toMatchObject({
        status: 'testing',
        completed_at: null,
        session_id: 'recovered-testing-session',
      });
      expect((await getTask(task.id))?.custom_values).not.toHaveProperty(
        'testing_failure_count',
      );
      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'completed',
        stage: 'testing',
      });
      expect(await getActiveRunById(continuationRunId)).toMatchObject({
        status: 'running',
        stage: 'testing',
      });
      expect(await getActiveRunsByStatus('running')).toHaveLength(1);
      expect(launches).toBe(1);
      expect(recoveredCheckpointCalls).toBe(1);
      let messages = readTaskMessages(projectId, task.id);
      expect(
        messages.some((message) => message.content.includes('Testing passed')),
      ).toBe(false);
      expect(
        messages.some(
          (message) =>
            message.entry_type === 'steering_assignment' &&
            message.prompt_id === prompt.id &&
            message.run_id === continuationRunId,
        ),
      ).toBe(true);
      expect(
        messages.some(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === prompt.id,
        ),
      ).toBe(false);

      releaseContinuation!();
      await continuationSettled;
      await recovery;

      await recoverOrphanedRuns({ drainProjectQueue: recoveryQueueDrain });
      expect(launches).toBe(1);
      expect(await getTask(task.id)).toMatchObject({
        status: 'review',
        completed_at: null,
        session_id: 'continued-testing-session',
      });
      expect(await getActiveRunById(continuationRunId)).toMatchObject({
        status: 'completed',
        stage: 'testing',
      });
      expect(await getActiveRunsByStatus('completed')).toHaveLength(2);
      messages = readTaskMessages(projectId, task.id);
      expect(
        messages.filter(
          (message) =>
            message.entry_type === 'system_notice' &&
            message.content.includes('Testing passed'),
        ),
      ).toHaveLength(1);
      expect(
        messages.filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === prompt.id &&
            message.run_id === continuationRunId,
        ),
      ).toHaveLength(1);
      expect(await isTaskRunning(task.id)).toBe(false);
    } finally {
      releaseContinuation?.();
      await unregisterGroup(jid);
    }
  });

  test('adopted-watcher Testing format-repair recovery uses its configured stage', async () => {
    const { createTask, getActiveRunById, getTask, insertActiveRun } =
      await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');

    await loadState();
    const projectId = `recovery-format-repair-watcher-${Date.now()}`;
    const jid = `${projectId}@web`;
    const group = {
      name: 'Recovery format repair watcher',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'paused' as const,
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'testing' as const,
            color: '#a3f',
          },
          {
            id: 'review',
            title: 'Review',
            type: 'review' as const,
            color: '#f80',
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done' as const,
            color: '#2c5',
          },
        ],
      },
    };
    await registerGroup(jid, group, { requirePersistence: true });
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'review' }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'testing',
      };
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      const exitCodePath = path.join(runDir, 'exit_code');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'output.jsonl'), '');
      await insertActiveRun(run);

      // Release the process result only after recovery has classified this as
      // a still-running orphan: the adopted watcher registers its fs.watch on
      // the run dir after its first (empty) completion check. This
      // deterministically exercises the adopted watcher rather than the
      // terminal-file branch.
      const realWatch = fs.watch;
      let released = false;
      (fs as any).watch = (...args: Parameters<typeof fs.watch>) => {
        if (!released && String(args[0]) === runDir) {
          released = true;
          queueMicrotask(() => {
            writeV1Run(runDir, {
              result: 'invalid repaired verdict envelope',
              sessionId: 'format-repair-session',
            });
            fs.writeFileSync(exitCodePath, '0\n');
          });
        }
        return realWatch(...args);
      };
      try {
        const { recoverOrphanedRuns } = await import('./recovery.js');
        await recoverOrphanedRuns();
      } finally {
        (fs as any).watch = realWatch;
      }

      expect(released).toBe(true);
      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'completed',
        stage: 'testing',
      });
      expect(await getTask(task.id)).toMatchObject({
        status: 'testing',
        session_id: 'format-repair-session',
      });
      const repairPrompt = readTaskMessages(projectId, task.id).find(
        (message) => message.entry_type === 'stage_prompt',
      );
      expect(repairPrompt).toMatchObject({ target_stage: 'testing' });
      expect(repairPrompt?.content).toContain(
        'invalid repaired verdict envelope',
      );
      expect(getGroupByFolder(projectId)).toBeTruthy();
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('a missing recovered task run notifies its owner and immutable triggerer', async () => {
    const {
      createTask,
      createUser,
      getUnreadPayloads,
      insertActiveRun,
      upsertProjectMember,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const owner = await createUser('recovery-missing-owner', 'pw', 'user');
    const triggerer = await createUser(
      'recovery-missing-triggerer',
      'pw',
      'user',
    );
    await upsertProjectMember(owner.id, 'test-proj', 'editor');
    await upsertProjectMember(triggerer.id, 'test-proj', 'editor');
    const task = await createTask(
      taskFixture({
        project_id: 'test-proj',
        status: 'in_progress',
        ownerUserId: owner.id,
        lastTriggeredByUserId: triggerer.id,
        lastTriggerSource: 'user',
      }),
    );
    const run = {
      ...makeRun(),
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      sandbox_instance: 'missing-recovery-instance',
      triggeredByUserId: triggerer.id,
      triggerSource: 'user' as const,
    };
    await insertActiveRun(run);

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns();

    expect(await getUnreadPayloads(owner.id)).toEqual([
      expect.objectContaining({ summary: `Task failed: ${task.title}` }),
    ]);
    expect(await getUnreadPayloads(triggerer.id)).toEqual([
      expect.objectContaining({ summary: `Task failed: ${task.title}` }),
    ]);
  });

  test('fails a missing active-stage run without fabricating a continuation from the task session', async () => {
    const {
      createTask,
      getActiveRunById,
      getActiveRunsByStatus,
      getTask,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const { loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    await loadState();
    const projectId = `missing-session-recovery-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(jid, {
      name: 'Missing session recovery',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running',
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active',
            color: '#38f',
          },
          { id: 'completed', title: 'Completed', type: 'done', color: '#2c5' },
          { id: 'failed', title: 'Failed', type: 'queue', color: '#f33' },
        ],
      },
    });
    try {
      const task = await createTask(
        taskFixture({
          project_id: projectId,
          status: 'in_progress',
          // A task-level session is deliberately present: restart recovery
          // must only trust the exact interrupted active_runs owner.
          session_id: 'stale-task-session',
          last_agent_name: 'codex',
        }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        sandbox_instance: 'missing-session-instance',
        stage: 'in_progress',
        session_id: null,
        agent_name: 'codex',
        session_agent_key: 'codex',
        runtime_variant: 'deadbeef',
      };
      await insertActiveRun(run);
      let continuationLaunches = 0;

      const { recoverStalledRuns } = await import('./recovery.js');
      const dependencies = {
        executeTask: async () => {
          continuationLaunches += 1;
        },
      };
      await recoverStalledRuns(dependencies);
      await recoverStalledRuns(dependencies);

      expect(continuationLaunches).toBe(0);
      expect(await getActiveRunById(run.id)).toMatchObject({
        status: 'error',
        stage: 'in_progress',
        session_id: null,
      });
      expect(await getActiveRunsByStatus('running')).toHaveLength(0);
      expect(await getTask(task.id)).toMatchObject({
        status: 'failed',
        error: 'Interrupted: server restarted during execution',
        session_id: 'stale-task-session',
      });
      expect(
        readTaskMessages(projectId, task.id).filter(
          (message) =>
            message.role === 'assistant' &&
            message.content ===
              'Error: Interrupted — server restarted during execution.',
        ),
      ).toHaveLength(1);
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('an explicit agent error stays failed when recovery has usable output', async () => {
    const { createTask, getTask, insertActiveRun } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');

    const task = await createTask(
      taskFixture({ project_id: 'test-proj', status: 'in_progress' }),
    );
    const run = {
      ...makeRun(),
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, {
      result: 'Partial work before failure',
      status: 'failed',
    });
    fs.writeFileSync(path.join(runDir, 'exit_code'), '1\n');
    await insertActiveRun(run);

    const { recoverOrphanedRuns } = await import('./recovery.js');
    await recoverOrphanedRuns();

    const recovered = await getTask(task.id);
    expect(recovered?.status).toBe('failed');
    expect(recovered?.error).toBe(
      'Agent exited with error after restart recovery',
    );
    expect(recovered?.output).toBe('Partial work before failure');
  });

  test('classifies a recovery deadline accurately and preserves partial run history', async () => {
    const { createTask, getTask, insertActiveRun } = await import('./db.js');
    const { GROUPS_DIR } = await import('./config.js');
    const { outputTranscriptPath } = await import('./group-dir.js');
    const { taskFixture } = await import('./test-helpers.js');

    const task = await createTask(
      taskFixture({ project_id: 'test-proj', status: 'in_progress' }),
    );
    const run = {
      ...makeRun(),
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      timeout_at: new Date(Date.now() + 1_000).toISOString(),
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'deadline prompt');
    writeV1Run(runDir, {
      result: 'Useful work before the restart deadline',
      status: null,
    });
    await insertActiveRun(run);

    const { recoverOrphanedRuns } = await import('./recovery.js');
    await recoverOrphanedRuns();

    expect(await getTask(task.id)).toMatchObject({
      status: 'failed',
      error: 'Timed out during restart recovery',
    });
    const runTranscriptDir = path.join(
      GROUPS_DIR,
      'test-proj',
      'session-transcripts',
    );
    expect(
      fs.readFileSync(
        path.join(runTranscriptDir, `${run.id}.v1.jsonl`),
        'utf8',
      ),
    ).toContain('Useful work before the restart deadline');
    expect(
      fs.readFileSync(outputTranscriptPath('test-proj', task.id), 'utf8'),
    ).toContain('Useful work before the restart deadline');
    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('a capacity error recovered after restart remains in its active stage', async () => {
    const { createTask, getTask, insertActiveRun } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');

    const task = await createTask(
      taskFixture({ project_id: 'test-proj', status: 'in_progress' }),
    );
    const run = {
      ...makeRun(),
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, {
      result: 'Selected model is at capacity. Please try a different model.',
      status: 'failed',
    });
    fs.writeFileSync(path.join(runDir, 'exit_code'), '1\n');
    await insertActiveRun(run);

    const { recoverOrphanedRuns } = await import('./recovery.js');
    await recoverOrphanedRuns();

    const recovered = await getTask(task.id);
    expect(recovered?.status).toBe('in_progress');
    expect(recovered?.error).toBe(
      'Retry scheduled: Selected model is at capacity. Please try a different model.',
    );
    expect(recovered?.output).toBe('');
  });
});

describe('recovered task merge eligibility', () => {
  test('does not merge when implementation advances to testing or review', async () => {
    const { recoveryReachedDoneStage } = await import('./recovery.js');
    const stages = [
      {
        id: 'in_progress',
        title: 'In progress',
        type: 'active' as const,
        color: '#00f',
      },
      {
        id: 'testing',
        title: 'Testing',
        type: 'testing' as const,
        color: '#ff0',
      },
      { id: 'review', title: 'Review', type: 'review' as const, color: '#f0f' },
      {
        id: 'completed',
        title: 'Completed',
        type: 'done' as const,
        color: '#0f0',
      },
    ];

    expect(recoveryReachedDoneStage(stages, 'testing')).toBe(false);
    expect(recoveryReachedDoneStage(stages, 'review')).toBe(false);
    expect(recoveryReachedDoneStage(stages, 'completed')).toBe(true);
  });
});

describe('review run recovery', () => {
  test('does not parse an implementation run as review after its task advanced', async () => {
    const { createTask, getTask } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const { recoverReviewRun } = await import('./recovery.js');
    const stages = [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
      {
        id: 'in_progress',
        title: 'In Progress',
        type: 'active',
        color: '#888',
      },
      { id: 'review', title: 'Review', type: 'review', color: '#888' },
      { id: 'completed', title: 'Completed', type: 'done', color: '#888' },
    ] as any;
    const task = await createTask(
      taskFixture({ project_id: 'recovery-stage-handoff', status: 'review' }),
    );

    expect(
      await recoverReviewRun(
        task,
        {
          name: 'Recovery stage handoff',
          folder: 'recovery-stage-handoff',
          trigger: '!test',
          added_at: new Date().toISOString(),
          settings: { stages },
        },
        stages,
        'Implementation completed successfully.',
        'implementation-session',
        'sandbox',
        'implementer',
        'test-model',
        'in_progress',
      ),
    ).toBe(false);

    expect((await getTask(task.id))?.status).toBe('review');
    expect(readTaskMessages(task.project_id, task.id)).toEqual([]);
  });

  test('routes a recovered rejection back to active without exposing verdict JSON', async () => {
    const { createTask, getTask } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const { recoverReviewRun } = await import('./recovery.js');
    const stages = [
      { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
      {
        id: 'in_progress',
        title: 'In Progress',
        type: 'active',
        color: '#888',
      },
      { id: 'review', title: 'Review', type: 'review', color: '#888' },
      { id: 'completed', title: 'Completed', type: 'done', color: '#888' },
    ] as any;
    const task = await createTask(
      taskFixture({ project_id: 'recovery-review', status: 'review' }),
    );
    const verdict = JSON.stringify({
      decision: 'reject',
      score: 3,
      issues: ['Fix the regression'],
      summary: 'Needs another pass',
    });

    expect(
      await recoverReviewRun(
        task,
        {
          name: 'Recovery review',
          folder: 'recovery-review',
          trigger: '!test',
          added_at: new Date().toISOString(),
          settings: { stages },
        },
        stages,
        verdict,
        'review-session',
        'sandbox',
        'reviewer',
        'test-model',
      ),
    ).toBe(true);

    const recovered = await getTask(task.id);
    expect(recovered?.status).toBe('in_progress');
    expect(recovered?.custom_values?.rejection_count).toBe(1);
    expect(recovered?.custom_values?.no_progress_count).toBe(0);
    const messages = readTaskMessages(task.project_id, task.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('**Review rejected**');
    expect(messages[0].content).not.toContain('"decision"');
  });
});

describe('review chain run recovery (co_stages)', () => {
  const stages = [
    { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
    { id: 'in_progress', title: 'In Progress', type: 'active', color: '#888' },
    { id: 'review', title: 'Review', type: 'review', color: '#888' },
    { id: 'review.o', title: 'Review O', type: 'review', color: '#888' },
    { id: 'completed', title: 'Completed', type: 'done', color: '#888' },
  ] as any;
  const group = (folder: string) => ({
    name: folder,
    folder,
    trigger: '!test',
    added_at: new Date().toISOString(),
    settings: { stages },
  });
  const verdictJson = (decision: 'approve' | 'reject', issue?: string) =>
    JSON.stringify({
      decision,
      score: decision === 'approve' ? 9 : 3,
      issues: issue ? [{ title: issue, description: 'detail' }] : [],
      summary: `${decision} summary`,
    });
  const marker = (role: 'primary' | 'extra', runId: string) =>
    JSON.stringify({
      run_id: runId,
      role,
      stage_id: role === 'primary' ? 'review' : 'review.o',
      stages: ['review.o'],
      head: 'a'.repeat(40),
      started_at: '2026-01-01T00:00:00.000Z',
      manual: false,
    });
  const chainWithPrimary = (decision: 'approve' | 'reject', issue?: string) =>
    JSON.stringify({
      head: 'a'.repeat(40),
      started_at: '2026-01-01T00:00:00.000Z',
      manual: false,
      stages: ['review.o'],
      verdicts: [
        {
          stage_id: 'review',
          reviewer: 'primary-model',
          decision,
          score: decision === 'approve' ? 9 : 3,
          issues: issue ? [{ title: issue, description: 'detail' }] : [],
          summary: `${decision} summary`,
        },
      ],
    });

  async function recover(
    folder: string,
    customValues: Record<string, string>,
    output: string,
    runId = 'chain-run',
  ) {
    const { createTask, getTask } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { recoverReviewRun } = await import('./recovery.js');
    const task = await createTask({
      ...taskFixture({ project_id: folder, status: 'review' }),
      coStages: ['review.o'],
      custom_values: customValues,
    });
    await recoverReviewRun(
      task,
      group(folder),
      stages,
      output,
      'session',
      'sandbox',
      'reviewer',
      'test-model',
      'review',
      runId,
    );
    return (await getTask(task.id))!;
  }

  test('a recovered primary approval waits for the extra reviewer', async () => {
    const task = await recover(
      'recovery-chain-primary',
      { review_chain_run: marker('primary', 'chain-run') },
      verdictJson('approve'),
    );
    expect(task.status).toBe('review');
    const chain = JSON.parse(String(task.custom_values?.review_chain));
    expect(chain.verdicts).toHaveLength(1);
    expect(chain.verdicts[0].decision).toBe('approve');
  });

  test('a recovered extra approval cannot override the primary rejection', async () => {
    const task = await recover(
      'recovery-chain-extra',
      {
        review_chain: chainWithPrimary('reject', 'Missing guard'),
        review_chain_run: marker('extra', 'chain-run'),
      },
      verdictJson('approve'),
    );
    expect(task.status).toBe('in_progress');
    const history = JSON.parse(String(task.custom_values?.review_history));
    expect(history).toHaveLength(1);
    expect(history[0].issues[0].text).toContain('Missing guard');
    expect(history[0].reviewers.map((r: any) => r.decision)).toEqual([
      'reject',
      'approve',
    ]);
  });

  test('a recovered terminal error of an extra reviewer still applies the recorded rejection once', async () => {
    const { createTask, getTask } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { recoverFailedReviewChainRun } = await import('./recovery.js');
    const task = await createTask({
      ...taskFixture({ project_id: 'recovery-chain-failed', status: 'review' }),
      coStages: ['review.o'],
      custom_values: {
        review_chain: chainWithPrimary('reject', 'Missing guard'),
        review_chain_run: marker('extra', 'chain-run'),
      },
    });
    expect(
      await recoverFailedReviewChainRun(
        task,
        group('recovery-chain-failed'),
        stages,
        'Agent exited with error',
        'session',
        'sandbox',
        'reviewer',
        'test-model',
        'review',
        'chain-run',
      ),
    ).toBe(true);
    const recovered = (await getTask(task.id))!;
    expect(recovered.status).toBe('in_progress');
    const history = JSON.parse(String(recovered.custom_values?.review_history));
    expect(history).toHaveLength(1);
    expect(history[0].reviewers.map((r: any) => r.decision)).toEqual([
      'reject',
      null,
    ]);
  });

  test('a recovered verdict that cannot be matched to its chain is parked, not applied', async () => {
    const task = await recover(
      'recovery-chain-unmatched',
      {},
      verdictJson('approve'),
      'some-other-run',
    );
    expect(task.status).toBe('backlog');
  });
});

describe('testing run recovery', () => {
  const stages = [
    { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
    { id: 'question', title: 'Question', type: 'queue', color: '#fa0' },
    { id: 'in_progress', title: 'In Progress', type: 'active', color: '#33f' },
    { id: 'testing', title: 'Testing', type: 'testing', color: '#a3f' },
    { id: 'review', title: 'Review', type: 'review', color: '#f80' },
    { id: 'completed', title: 'Completed', type: 'done', color: '#3f3' },
  ] as any;
  const group = {
    name: 'Recovery testing',
    folder: 'recovery-testing',
    trigger: '!test',
    added_at: new Date().toISOString(),
    settings: { stages },
  };

  const headSha = 'a'.repeat(40);
  const inspectedTree = 'b'.repeat(40);
  // Clean checkout whose HEAD tree is `tree`.
  const cleanGit =
    (tree: string) => async (_group: unknown, command: string) => ({
      ok: true,
      output: command.startsWith('rev-parse') ? `${headSha}\n${tree}` : '',
    });

  test.each([
    ['pass', [], inspectedTree, 'review'],
    // Content changed between slot acquisition and recovery.
    ['pass', [], 'c'.repeat(40), 'testing'],
    // Restart lost the run-bound identity (e.g. a run started before upgrade).
    ['pass', [], undefined, 'testing'],
    ['fail', ['bun test failed'], inspectedTree, 'in_progress'],
    ['blocked', ['credentials missing'], inspectedTree, 'question'],
  ] as const)(
    'routes recovered %s verdict programmatically (final tree %s)',
    async (decision, issues, finalTree, expected) => {
      const { createTask, getTask } = await import('./db.js');
      const { taskFixture } = await import('./test-helpers.js');
      const { recoverTestingRun } = await import('./recovery.js');
      const {
        TESTING_INSPECTED_HEAD_SHA_KEY,
        TESTING_INSPECTED_RUN_ID_KEY,
        TESTING_INSPECTED_TREE_SHA_KEY,
        TESTING_TREE_SHA_KEY,
      } = await import('./modules/kanban/task/testing.js');
      const runId = 'recovered-testing-run';
      const task = await createTask(
        taskFixture({
          project_id: group.folder,
          status: 'testing',
          session_id: 'implementation-session',
          custom_values: finalTree
            ? {
                [TESTING_INSPECTED_RUN_ID_KEY]: runId,
                [TESTING_INSPECTED_HEAD_SHA_KEY]: headSha,
                [TESTING_INSPECTED_TREE_SHA_KEY]: inspectedTree,
              }
            : {},
        }),
      );
      const verdict = JSON.stringify({
        decision,
        issues,
        summary: `${decision} summary`,
      });
      expect(
        await recoverTestingRun(
          task,
          group as any,
          stages,
          verdict,
          'testing-session',
          'tester',
          'model',
          false,
          undefined,
          runId,
          undefined,
          cleanGit(finalTree ?? inspectedTree) as any,
        ),
      ).toBe(true);
      const recovered = await getTask(task.id);
      expect(recovered?.status).toBe(expected);
      // Only a confirmed pass leaves evidence Review will accept.
      expect(recovered?.custom_values?.[TESTING_TREE_SHA_KEY]).toBe(
        expected === 'review' ? inspectedTree : undefined,
      );
    },
  );

  test('recovers a chained pass without a following Review and keeps the same-content check', async () => {
    const { createTask, getTask } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { recoverTestingRun } = await import('./recovery.js');
    const noReviewStages = [
      ...stages.filter((stage: any) => stage.id !== 'review'),
      { id: 'testing.u', title: 'Testing U', type: 'testing', color: '#a3f' },
    ] as any;
    const chainGroup = {
      ...group,
      folder: 'recovery-testing-chain',
      settings: { stages: noReviewStages },
    };
    const task = await createTask(
      taskFixture({
        project_id: chainGroup.folder,
        status: 'testing',
        coStages: ['testing.u'],
      }),
    );
    const pass = JSON.stringify({
      decision: 'pass',
      issues: [],
      summary: 'ok',
    });
    const recoverWith = async (tree: string, runId: string) =>
      recoverTestingRun(
        (await getTask(task.id))!,
        chainGroup as any,
        noReviewStages.filter((stage: any) => stage.id !== 'testing.u'),
        pass,
        'testing-session',
        'tester',
        'model',
        false,
        undefined,
        runId,
        undefined,
        cleanGit(tree) as any,
      );

    // The primary's pass is recorded, not blocked, and the extra tester is next.
    await recoverWith(inspectedTree, 'primary-run');
    const afterPrimary = await getTask(task.id);
    expect(afterPrimary?.status).toBe('testing');
    expect(
      JSON.parse(String(afterPrimary?.custom_values?.testing_chain)),
    ).toMatchObject({
      head: headSha,
      tree: inspectedTree,
    });

    // Replaying the primary's run after a crash does not credit it to the extra.
    await recoverWith(inspectedTree, 'primary-run');
    const replayed = await getTask(task.id);
    expect(replayed?.status).toBe('testing');
    expect(
      JSON.parse(String(replayed?.custom_values?.testing_chain)).verdicts,
    ).toHaveLength(1);

    // The extra tester's pass on different content is a failure, never a pass.
    await recoverWith('c'.repeat(40), 'extra-run');
    expect((await getTask(task.id))?.status).toBe('in_progress');
  });

  test.each([
    ['malformed output', false, 'testing'],
    ['{"decision":"pass","issues":[],"summary":"ignored"}', true, 'question'],
  ] as const)(
    'routes %s recovery to %s',
    async (output, runFailed, expectedStatus) => {
      const { createTask, getTask } = await import('./db.js');
      const { taskFixture } = await import('./test-helpers.js');
      const { recoverTestingRun } = await import('./recovery.js');
      const task = await createTask(
        taskFixture({ project_id: group.folder, status: 'testing' }),
      );
      await recoverTestingRun(
        task,
        group as any,
        stages,
        output,
        undefined,
        'tester',
        'model',
        runFailed,
      );
      expect((await getTask(task.id))?.status).toBe(expectedStatus);

      if (!runFailed) {
        const { readTaskMessages } =
          await import('./modules/transcripts/transcript-store.js');
        const messages = readTaskMessages(task.project_id, task.id);
        const repairPrompt = messages.find(
          (message) => message.entry_type === 'stage_prompt',
        );
        expect(repairPrompt?.target_stage).toBe('testing');
      }
    },
  );
});

describe('orphaned IPC output recovery', () => {
  // The sweep trusts a run dir's identity only for registered groups that own
  // its IPC directory (`carapa-bot-<folder>`).
  const sweepGroupFolders = ['test-proj', 'forge-victim', 'forge-attacker'];
  let registeredGroupsRef: Record<string, unknown>;

  // Re-registered per test: other tests in this file reload the registry.
  beforeEach(async () => {
    ({ registeredGroups: registeredGroupsRef } =
      await import('./state-manager.js'));
    for (const folder of sweepGroupFolders) {
      registeredGroupsRef[`${folder}@sweep-test`] = {
        name: folder,
        folder,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
      };
    }
  });

  afterAll(() => {
    for (const folder of sweepGroupFolders) {
      delete registeredGroupsRef[`${folder}@sweep-test`];
    }
  });

  test('ignores a forged args.json naming another project and writes nothing there', async () => {
    // The agent of registered project `forge-attacker` plants a run dir in its
    // own IPC dir whose args.json claims the victim project and a task.
    const taskId = `task-${Date.now()}-forged`;
    const runId = `run-forged-${Date.now()}`;
    const runDir = path.join(
      ipcBase,
      'carapa-bot-forge-attacker',
      'runs',
      runId,
    );
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({ groupFolder: 'forge-victim', taskId }),
    );
    writeV1Run(runDir, { result: 'forged line' });

    const { sweepOrphanedIpcDirs } = await import('./recovery.js');
    const { outputTranscriptPath } = await import('./group-dir.js');
    const { GROUPS_DIR } = await import('./config.js');
    await sweepOrphanedIpcDirs();

    // Nothing lands under the victim project...
    const victimDir = path.join(GROUPS_DIR, 'forge-victim');
    expect(fs.existsSync(path.join(victimDir, 'transcripts'))).toBe(false);
    expect(fs.existsSync(path.join(victimDir, 'session-transcripts'))).toBe(
      false,
    );
    // ...and the forged task identity is dropped for the attacker's own
    // group too: the output is not routed to the claimed task transcript.
    expect(fs.existsSync(outputTranscriptPath('forge-attacker', taskId))).toBe(
      false,
    );
    expect(fs.existsSync(outputTranscriptPath('forge-victim', taskId))).toBe(
      false,
    );
  });

  test('preserves a completed run acknowledgement until steering reconciliation receipts it', async () => {
    const { completeActiveRun, createTask, insertActiveRun } =
      await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { appendTaskMessage, readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const { recoverStalledRuns, sweepOrphanedIpcDirs } =
      await import('./recovery.js');
    const projectId = 'test-proj';
    const task = await createTask(
      taskFixture({ project_id: projectId, status: 'in_progress' }),
    );
    const prompt = appendTaskMessage(projectId, {
      task_id: task.id,
      role: 'user',
      content: 'accepted immediately before restart',
      steering: true,
      target_stage: 'in_progress',
      created_at: new Date().toISOString(),
    });
    const run = {
      ...makeRun(),
      task_id: task.id,
      stage: 'in_progress',
    };
    appendTaskMessage(projectId, {
      task_id: task.id,
      role: 'system',
      entry_type: 'steering_request',
      prompt_id: prompt.id,
      run_id: run.id,
      content: '',
      created_at: new Date().toISOString(),
    });
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(path.join(runDir, 'control-responses'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'control-responses', `${prompt.id}.json`),
      JSON.stringify({ ok: true }),
    );
    await insertActiveRun(run);
    await completeActiveRun(run.id, 'completed');

    // Production startup reconciliation must receipt the retained positive
    // acknowledgement before stale admissions or queue draining can resume.
    await recoverStalledRuns();
    expect(
      readTaskMessages(projectId, task.id).filter(
        (message) =>
          message.entry_type === 'steering_delivery' &&
          message.prompt_id === prompt.id &&
          message.run_id === run.id,
      ),
    ).toHaveLength(1);
    await sweepOrphanedIpcDirs();
    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('parks a completed admitted run whose Git finalization throws instead of aborting recovery', async () => {
    const {
      bindTaskAdmissionRun,
      claimNormalTaskAdmission,
      completeActiveRun,
      createTask,
      getCompletedTaskRunsForStaleAdmissions,
      getTask,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { setGroupResolver } =
      await import('./modules/kanban/task-executor.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    const { recoverStalledRuns } = await import('./recovery.js');
    await loadState();
    const projectId = `recovery-git-finalization-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(
      jid,
      {
        name: 'Recovery git finalization',
        folder: projectId,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'running' as const,
          stages: [
            { id: 'backlog', title: 'Backlog', type: 'queue' as const },
            {
              id: 'in_progress',
              title: 'In Progress',
              type: 'active' as const,
            },
            { id: 'completed', title: 'Completed', type: 'done' as const },
          ].map((stage) => ({ ...stage, color: '#38f' })),
        },
      },
      { requirePersistence: true },
    );
    setGroupResolver(getGroupByFolder);
    try {
      const task = await createTask({
        ...taskFixture({ project_id: projectId, status: 'in_progress' }),
        branch_name: 'task/git-finalization',
      });
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
      };
      const admission = await claimNormalTaskAdmission(
        projectId,
        () => ({ claimed: true }),
        false,
        task.id,
      );
      expect(admission.claim).not.toBeNull();
      await insertActiveRun(run);
      await bindTaskAdmissionRun(
        projectId,
        task.id,
        run.id,
        admission.ownerToken,
      );
      await completeActiveRun(run.id, 'completed', { result: 'done' }, 's1');

      await recoverStalledRuns({
        runPostExecutionGitOps: async () => {
          throw new Error('git broke');
        },
        drainProjectQueue: async () => {},
      });

      expect(await getTask(task.id)).toMatchObject({
        status: 'backlog',
        completed_at: null,
        error: expect.stringContaining('git broke'),
      });
      // The admission was released, so the next restart does not retry it.
      expect(await getCompletedTaskRunsForStaleAdmissions()).toHaveLength(0);
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('retries a completed admitted run whose finalization did not settle on the next boot', async () => {
    const {
      bindTaskAdmissionRun,
      claimNormalTaskAdmission,
      completeActiveRun,
      createTask,
      deleteTask,
      getTask,
      insertActiveRun,
      snapshotTaskAdmissionOwners,
      updateTask,
    } = await import('./db.js');
    const { drizzleDbRef } = await import('./db/drizzle-client.js');
    const { projects } = await import('./db/schema.js');
    const { eq } = await import('drizzle-orm');
    const { taskFixture } = await import('./test-helpers.js');
    const { readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const { setGroupResolver } =
      await import('./modules/kanban/task-executor.js');
    const stateManager = await import('./state-manager.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      stateManager;
    const wsEvents = await import('./modules/objectives/ws-events.js');
    const { recoverStalledRuns, reattachOrphanedRuns } =
      await import('./recovery.js');
    await loadState();
    const projectId = `recovery-finalization-marker-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(
      jid,
      {
        name: 'Recovery finalization marker',
        folder: projectId,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'running' as const,
          stages: [
            { id: 'backlog', title: 'Backlog', type: 'queue' as const },
            {
              id: 'in_progress',
              title: 'In Progress',
              type: 'active' as const,
            },
            { id: 'completed', title: 'Completed', type: 'done' as const },
          ].map((stage) => ({ ...stage, color: '#38f' })),
        },
      },
      { requirePersistence: true },
    );
    setGroupResolver(getGroupByFolder);
    const pendingMarkers = async (): Promise<Record<string, unknown>> => {
      const [row] = await drizzleDbRef.current
        .select({ settings: projects.settings })
        .from(projects)
        .where(eq(projects.id, projectId));
      const persisted = JSON.parse(row?.settings ?? '{}') as {
        _pendingFinalizationRuns?: Record<string, unknown>;
      };
      return persisted._pendingFinalizationRuns ?? {};
    };
    const admitted = async (taskId: string) =>
      (await snapshotTaskAdmissionOwners()).get(projectId)?.has(taskId);
    // A task whose run completed while its admission was still owned.
    const seedCompletedRun = async (
      existing?: Awaited<ReturnType<typeof createTask>>,
    ) => {
      const task =
        existing ??
        (await createTask(
          taskFixture({ project_id: projectId, status: 'in_progress' }),
        ));
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
      };
      const admission = await claimNormalTaskAdmission(
        projectId,
        () => ({ claimed: true }),
        false,
        task.id,
      );
      expect(admission.claim).not.toBeNull();
      await insertActiveRun(run);
      await bindTaskAdmissionRun(
        projectId,
        task.id,
        run.id,
        admission.ownerToken,
      );
      await completeActiveRun(run.id, 'completed', { result: 'done' }, 's1');
      return { task, run };
    };
    const boot = async (
      options: { before?: () => void | Promise<void> } = {},
    ) => {
      // Startup shares one snapshot across all recovery sweeps.
      const dependencies = {
        admissionSnapshot: await snapshotTaskAdmissionOwners(),
        drainProjectQueue: async () => {},
      };
      await options.before?.();
      await recoverStalledRuns(dependencies);
      await (
        await reattachOrphanedRuns(dependencies)
      ).settled;
    };
    try {
      // 1. A non-Git failure inside the steering boundary: the admission is
      // swept as usual, the marker keeps the run findable, and the retry in
      // the same process returns (no lock hang) and settles the run.
      const failing = await seedCompletedRun();
      const broadcastSpy = spyOn(wsEvents, 'broadcast').mockImplementation(
        (event) => {
          if ((event as { type: string }).type === 'task_message') {
            throw new Error('notify broke');
          }
        },
      );
      onTestFinished(() => broadcastSpy.mockRestore());
      await boot();
      expect(broadcastSpy).toHaveBeenCalled();
      expect(await admitted(failing.task.id)).toBeFalsy();
      expect(await pendingMarkers()).toMatchObject({
        [failing.task.id]: { runId: failing.run.id },
      });
      broadcastSpy.mockRestore();
      await boot();
      expect(await pendingMarkers()).toEqual({});
      expect((await getTask(failing.task.id))?.status).toBe('completed');

      // 2. A project that is not loaded keeps the marker; once the card has
      // moved on, the run no longer applies and the marker is dropped.
      const unloaded = await seedCompletedRun();
      const lookupSpy = spyOn(stateManager, 'getGroupByFolder').mockReturnValue(
        undefined,
      );
      onTestFinished(() => lookupSpy.mockRestore());
      await boot();
      lookupSpy.mockRestore();
      expect(await admitted(unloaded.task.id)).toBeFalsy();
      expect(await pendingMarkers()).toHaveProperty(unloaded.task.id);
      // The user moves the card to its normal next stage without a newer run.
      await updateTask(unloaded.task.id, { status: 'completed' });
      await boot();
      expect(await pendingMarkers()).toEqual({});
      expect((await getTask(unloaded.task.id))?.status).toBe('completed');
      expect(
        readTaskMessages(projectId, unloaded.task.id).filter(
          (message) => message.run_id === unloaded.run.id,
        ),
      ).toHaveLength(0);

      // 3. A deleted card drops its marker with its run.
      const deleted = await seedCompletedRun();
      const lookupSpy2 = spyOn(
        stateManager,
        'getGroupByFolder',
      ).mockReturnValue(undefined);
      onTestFinished(() => lookupSpy2.mockRestore());
      await boot();
      lookupSpy2.mockRestore();
      expect(await pendingMarkers()).toHaveProperty(deleted.task.id);
      await deleteTask(deleted.task.id);
      await boot();
      expect(await pendingMarkers()).toEqual({});

      // An archived card drops its marker without the result being applied.
      const archived = await seedCompletedRun();
      const lookupSpy3 = spyOn(
        stateManager,
        'getGroupByFolder',
      ).mockReturnValue(undefined);
      onTestFinished(() => lookupSpy3.mockRestore());
      await boot();
      lookupSpy3.mockRestore();
      await updateTask(archived.task.id, { archived: true });
      await boot();
      expect(await pendingMarkers()).toEqual({});
      expect((await getTask(archived.task.id))?.status).toBe('in_progress');

      // 4. A failure after the finalizer moved the card: the next boot is a
      // repair of that attempt (completion notice again), not a drop.
      const moved = await seedCompletedRun();
      const pushTools = await import('./modules/tools/push-tools.js');
      const notifySpy = spyOn(
        pushTools,
        'notifyEntityLifecycle',
      ).mockRejectedValue(new Error('notify broke'));
      onTestFinished(() => notifySpy.mockRestore());
      await boot();
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect((await getTask(moved.task.id))?.status).toBe('completed');
      expect(await pendingMarkers()).toHaveProperty(moved.task.id);
      notifySpy.mockReset().mockResolvedValue(undefined);
      await boot();
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(await pendingMarkers()).toEqual({});

      // 5. A newer run of the same card owns the single marker and its own
      // admission; the superseded run is never replayed over it.
      const first = await seedCompletedRun();
      const failNotice = spyOn(wsEvents, 'broadcast').mockImplementation(
        (event) => {
          if ((event as { type: string }).type === 'task_message') {
            throw new Error('notify broke');
          }
        },
      );
      onTestFinished(() => failNotice.mockRestore());
      await boot();
      expect(await pendingMarkers()).toMatchObject({
        [first.task.id]: { runId: first.run.id },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await seedCompletedRun(first.task);
      await boot();
      expect(await pendingMarkers()).toMatchObject({
        [first.task.id]: { runId: second.run.id },
      });
      failNotice.mockRestore();
      await boot();
      expect(await pendingMarkers()).toEqual({});
      expect((await getTask(first.task.id))?.status).toBe('completed');
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('does not re-apply a stalled run that a boot already finalized from its terminal spool', async () => {
    const {
      bindTaskAdmissionRun,
      claimNormalTaskAdmission,
      createTask,
      getTask,
      insertActiveRun,
      snapshotTaskAdmissionOwners,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { setGroupResolver } =
      await import('./modules/kanban/task-executor.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    const { recoverStalledRuns, reattachOrphanedRuns } =
      await import('./recovery.js');
    await loadState();
    const projectId = `recovery-spool-testing-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(
      jid,
      {
        name: 'Recovery spool testing',
        folder: projectId,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'running' as const,
          stages: [
            { id: 'backlog', title: 'Backlog', type: 'queue' as const },
            { id: 'testing', title: 'Testing', type: 'testing' as const },
            { id: 'completed', title: 'Completed', type: 'done' as const },
          ].map((stage) => ({ ...stage, color: '#38f' })),
        },
      },
      { requirePersistence: true },
    );
    setGroupResolver(getGroupByFolder);
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'testing' }),
      );
      // Running at boot, finished while the board was down: its terminal
      // spool is harvested and its Testing fail verdict applied by boot 1.
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'testing',
      };
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      fs.mkdirSync(runDir, { recursive: true });
      writeV1Run(runDir, {
        result: JSON.stringify({
          decision: 'fail',
          issues: ['bun test failed'],
          summary: 'fail summary',
        }),
        sessionId: 'spool-testing-session',
      });
      fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
      const admission = await claimNormalTaskAdmission(
        projectId,
        () => ({ claimed: true }),
        false,
        task.id,
      );
      await insertActiveRun(run);
      await bindTaskAdmissionRun(
        projectId,
        task.id,
        run.id,
        admission.ownerToken,
      );
      const boot = async () => {
        const dependencies = {
          admissionSnapshot: await snapshotTaskAdmissionOwners(),
          drainProjectQueue: async () => {},
        };
        await recoverStalledRuns(dependencies);
        await (
          await reattachOrphanedRuns(dependencies)
        ).settled;
      };
      await boot();
      expect(
        (await getTask(task.id))?.custom_values?.testing_failure_count,
      ).toBe(1);
      // An already applied verdict leaves no retry key behind.
      await boot();
      expect(
        (await getTask(task.id))?.custom_values?.testing_failure_count,
      ).toBe(1);
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('releases the admission of a run reattach reaps as stalled, timed out or missing its run dir', async () => {
    const {
      bindTaskAdmissionRun,
      claimNormalTaskAdmission,
      createTask,
      getActiveRunById,
      insertActiveRun,
      snapshotTaskAdmissionOwners,
    } = await import('./db.js');
    const { STALL_TIMEOUT_MS } = await import('./config.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { setGroupResolver } =
      await import('./modules/kanban/task-executor.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    const { reattachOrphanedRuns } = await import('./recovery.js');
    await loadState();
    const projectId = `recovery-early-reap-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(
      jid,
      {
        name: 'Recovery early reap',
        folder: projectId,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'running' as const,
          stages: [
            { id: 'in_progress', title: 'In Progress', type: 'active' },
            { id: 'completed', title: 'Completed', type: 'done' },
            { id: 'failed', title: 'Failed', type: 'queue' },
          ].map((stage) => ({ ...stage, color: '#38f' })) as never,
        },
      },
      { requirePersistence: true },
    );
    setGroupResolver(getGroupByFolder);
    try {
      const reaps: {
        status: 'stalled' | 'timeout' | 'error';
        patch: Record<string, string>;
      }[] = [
        {
          status: 'stalled',
          patch: {
            last_event_at: new Date(
              Date.now() - STALL_TIMEOUT_MS - 60_000,
            ).toISOString(),
          },
        },
        {
          status: 'timeout',
          patch: { timeout_at: new Date(Date.now() - 60_000).toISOString() },
        },
        // Neither stalled nor timed out, and no run dir exists for it.
        { status: 'error', patch: {} },
      ];
      for (const reap of reaps) {
        const task = await createTask(
          taskFixture({ project_id: projectId, status: 'in_progress' }),
        );
        const run = {
          ...makeRun(),
          group_folder: projectId,
          task_id: task.id,
          chat_jid: `task-${task.id}@kanban`,
          stage: 'in_progress',
          ...reap.patch,
        };
        const admission = await claimNormalTaskAdmission(
          projectId,
          () => ({ claimed: true }),
          false,
          task.id,
        );
        await insertActiveRun(run);
        await bindTaskAdmissionRun(
          projectId,
          task.id,
          run.id,
          admission.ownerToken,
        );
        expect(
          (await snapshotTaskAdmissionOwners()).get(projectId)?.has(task.id),
        ).toBe(true);
        await (
          await reattachOrphanedRuns({
            admissionSnapshot: await snapshotTaskAdmissionOwners(),
            drainProjectQueue: async () => {},
          })
        ).settled;
        expect((await getActiveRunById(run.id))?.status).toBe(reap.status);
        expect(
          (await snapshotTaskAdmissionOwners()).get(projectId)?.has(task.id) ??
            false,
        ).toBe(false);
      }
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('finalizes a completed testing run across boots: deferred by a held checkout, retried after a notice failure', async () => {
    const {
      bindTaskAdmissionRun,
      claimNormalTaskAdmission,
      completeActiveRun,
      createTask,
      getTask,
      insertActiveRun,
    } = await import('./db.js');
    const { drizzleDbRef } = await import('./db/drizzle-client.js');
    const { projects } = await import('./db/schema.js');
    const { eq } = await import('drizzle-orm');
    const { taskFixture } = await import('./test-helpers.js');
    const { acquireSharedCheckoutLease } =
      await import('./concurrency/shared-checkout-lease.js');
    const { setGroupResolver } =
      await import('./modules/kanban/task-executor.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    const { recoverStalledRuns } = await import('./recovery.js');
    await loadState();
    const projectId = `recovery-testing-lease-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(
      jid,
      {
        name: 'Recovery testing lease',
        folder: projectId,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'running' as const,
          stages: [
            { id: 'backlog', title: 'Backlog', type: 'queue' as const },
            { id: 'testing', title: 'Testing', type: 'testing' as const },
            { id: 'completed', title: 'Completed', type: 'done' as const },
          ].map((stage) => ({ ...stage, color: '#38f' })),
        },
      },
      { requirePersistence: true },
    );
    setGroupResolver(getGroupByFolder);
    const otherLease = await acquireSharedCheckoutLease(projectId, {
      type: 'task',
      id: 'task-other-owner',
    });
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'testing' }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'testing',
      };
      const admission = await claimNormalTaskAdmission(
        projectId,
        () => ({ claimed: true }),
        false,
        task.id,
      );
      await insertActiveRun(run);
      await bindTaskAdmissionRun(
        projectId,
        task.id,
        run.id,
        admission.ownerToken,
      );
      // A pass into a done stage merges, so it needs the checkout.
      await completeActiveRun(
        run.id,
        'completed',
        {
          result: JSON.stringify({
            decision: 'pass',
            issues: [],
            summary: 'pass summary',
          }),
        },
        's1',
      );

      // Returns (a wait would exceed the test timeout) instead of queueing
      // behind the other owner's lease.
      await recoverStalledRuns({ drainProjectQueue: async () => {} });

      expect((await getTask(task.id))?.status).toBe('testing');
      const [row] = await drizzleDbRef.current
        .select({ settings: projects.settings })
        .from(projects)
        .where(eq(projects.id, projectId));
      expect(
        JSON.parse(row?.settings ?? '{}')._pendingFinalizationRuns,
      ).toMatchObject({ [task.id]: { runId: run.id } });

      // Once the checkout is free, the next boot applies the deferred verdict.
      // Its completion notice fails after the Testing move: the marker stays.
      await otherLease.release();
      const pushTools = await import('./modules/tools/push-tools.js');
      const notifySpy = spyOn(
        pushTools,
        'notifyEntityLifecycle',
      ).mockRejectedValue(new Error('notify broke'));
      onTestFinished(() => notifySpy.mockRestore());
      // Recovery also finalizes other projects' leftover runs from earlier
      // tests in this process; count only this card's notices.
      const ownNotices = () =>
        notifySpy.mock.calls.filter(([notice]) => notice.task_id === task.id);
      await recoverStalledRuns({ drainProjectQueue: async () => {} });
      expect((await getTask(task.id))?.status).toBe('completed');
      expect(ownNotices()).toHaveLength(1);
      const markers = async () => {
        const [current] = await drizzleDbRef.current
          .select({ settings: projects.settings })
          .from(projects)
          .where(eq(projects.id, projectId));
        return JSON.parse(current?.settings ?? '{}')._pendingFinalizationRuns;
      };
      expect(await markers()).toMatchObject({ [task.id]: { runId: run.id } });

      // The Testing move recorded itself, so the retry sends the owed notice
      // and settles instead of dropping the run as moved by someone else.
      notifySpy.mockReset().mockResolvedValue(undefined);
      await recoverStalledRuns({ drainProjectQueue: async () => {} });
      expect(ownNotices()).toHaveLength(1);
      expect(await markers()).toBeUndefined();
    } finally {
      await otherLease.release();
      await unregisterGroup(jid);
    }
  });

  test('receipts launch-owned prompts from already-completed admitted runs before startup drain', async () => {
    const {
      bindTaskAdmissionRun,
      claimNormalTaskAdmission,
      completeActiveRun,
      createTask,
      getTask,
      getRunsForTask,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { appendTaskMessage, readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const { drainProjectQueue, setGroupResolver } =
      await import('./modules/kanban/task-executor.js');
    const { persistPerRunTranscript } = await import('./sandbox/process.js');
    const { getGroupDir } = await import('./group-dir.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    const { recoverStalledRuns } = await import('./recovery.js');
    await loadState();
    const projectId = `recovery-launch-assignment-${Date.now()}`;
    const jid = `${projectId}@web`;
    const group = {
      name: 'Recovery launch assignment',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        stages: [
          {
            id: 'in_progress',
            title: 'In Progress',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done' as const,
            color: '#2c5',
          },
        ],
      },
    };
    await registerGroup(jid, group, { requirePersistence: true });
    setGroupResolver(getGroupByFolder);
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'in_progress' }),
      );
      const prompt = appendTaskMessage(projectId, {
        task_id: task.id,
        role: 'user',
        content: 'already included in the launched continuation',
        steering: true,
        target_stage: 'in_progress',
        created_at: new Date().toISOString(),
      });
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
      };
      appendTaskMessage(projectId, {
        task_id: task.id,
        role: 'system',
        entry_type: 'steering_assignment',
        prompt_id: prompt.id,
        run_id: run.id,
        content: '',
        created_at: new Date().toISOString(),
      });
      const admission = await claimNormalTaskAdmission(
        projectId,
        () => ({ claimed: true }),
        false,
        task.id,
      );
      expect(admission.blockedByEntry).toBe(false);
      expect(admission.claim).not.toBeNull();
      await insertActiveRun(run);
      await bindTaskAdmissionRun(
        projectId,
        task.id,
        run.id,
        admission.ownerToken,
      );
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      fs.mkdirSync(runDir, { recursive: true });
      writeV1Run(runDir, {
        result: 'Continuation finished before the board restarted.',
        sessionId: 'launch-assignment-session',
      });
      expect(persistPerRunTranscript(projectId, run.id, runDir)).toBe(true);
      fs.rmSync(runDir, { recursive: true, force: true });
      await completeActiveRun(
        run.id,
        'completed',
        { result: 'Continuation finished before the board restarted.' },
        'launch-assignment-session',
      );
      expect(
        fs.existsSync(path.join(ipcBase, 'carapa-bot-default', 'runs', run.id)),
      ).toBe(false);

      await recoverStalledRuns({
        drainProjectQueue: async () => {},
      });

      expect(
        readTaskMessages(projectId, task.id).filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === prompt.id &&
            message.run_id === run.id,
        ),
      ).toHaveLength(1);
      expect(await getRunsForTask(task.id)).toEqual([
        expect.objectContaining({
          id: run.id,
          status: 'completed',
          result: 'Continuation finished before the board restarted.',
        }),
      ]);
      expect(
        fs.existsSync(
          path.join(
            getGroupDir(projectId),
            'session-transcripts',
            `${run.id}.v1.jsonl`,
          ),
        ),
      ).toBe(true);
      expect(await getTask(task.id)).toMatchObject({
        status: 'completed',
        output: 'Continuation finished before the board restarted.',
        session_id: 'launch-assignment-session',
      });

      let launches = 0;
      await drainProjectQueue(projectId, group, {
        testDependencies: {
          executeTask: async () => {
            launches += 1;
          },
        },
      });
      expect(launches).toBe(0);

      // Recovery is idempotent after the stale admission has been released.
      await recoverStalledRuns({ drainProjectQueue: async () => {} });
      expect(
        readTaskMessages(projectId, task.id).filter(
          (message) =>
            message.entry_type === 'steering_delivery' &&
            message.prompt_id === prompt.id &&
            message.run_id === run.id,
        ),
      ).toHaveLength(1);
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('applies a durable agent handoff when restart recovery finalizes its run', async () => {
    const { createTask, getTask, insertActiveRun } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const {
      claimTaskExecution,
      releaseTaskExecutionClaim,
      requestDurableTaskStageHandoff,
      setGroupResolver,
    } = await import('./modules/kanban/task-executor.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    const { recoverStalledRuns } = await import('./recovery.js');
    await loadState();
    const projectId = `recovery-durable-handoff-${Date.now()}`;
    const jid = `${projectId}@web`;
    const group = {
      name: 'Recovery durable handoff',
      folder: projectId,
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        status: 'running' as const,
        stages: [
          {
            id: 'in_progress',
            title: 'In progress',
            type: 'active' as const,
            color: '#38f',
          },
          {
            id: 'question',
            title: 'Question',
            type: 'queue' as const,
            color: '#f80',
          },
          {
            id: 'completed',
            title: 'Completed',
            type: 'done' as const,
            color: '#2c5',
          },
        ],
      },
    };
    await registerGroup(jid, group, { requirePersistence: true });
    setGroupResolver(getGroupByFolder);
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'in_progress' }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'in_progress',
      };
      const claim = claimTaskExecution(task.id, projectId);
      expect(claim).not.toBeNull();
      expect(
        await requestDurableTaskStageHandoff(
          task,
          'in_progress',
          'question',
          run.id,
          {
            steerAgentProcess: async () => false,
            interruptAgentTurn: async () => false,
            killAgentProcess: async () => false,
            schedule: (() => 0) as any,
          },
        ),
      ).toBe(true);
      releaseTaskExecutionClaim(task.id, claim!);

      const request = readTaskMessages(projectId, task.id).find(
        (message) => message.entry_type === 'stage_handoff_request',
      );
      expect(request).toMatchObject({
        source_stage: 'in_progress',
        target_stage: 'question',
        run_id: run.id,
      });

      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      fs.mkdirSync(runDir, { recursive: true });
      writeV1Run(runDir, {
        result: 'Need one product decision.',
        sessionId: 'handoff-recovery-session',
      });
      fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
      await insertActiveRun(run);

      await recoverStalledRuns({ drainProjectQueue: async () => {} });

      expect(await getTask(task.id)).toMatchObject({
        status: 'question',
        session_id: 'handoff-recovery-session',
      });
      expect(
        readTaskMessages(projectId, task.id).filter(
          (message) =>
            message.entry_type === 'stage_handoff_delivery' &&
            message.prompt_id === request?.id &&
            message.run_id === run.id,
        ),
      ).toHaveLength(1);
    } finally {
      await unregisterGroup(jid);
    }
  });

  test.each([
    [
      'skips a Question handoff when the card already left the run stage',
      'question',
      true,
    ],
    [
      'skips a Failed handoff when the card already left the run stage',
      'failed',
      true,
    ],
    [
      'applies a Question handoff while the card is still in the run stage',
      'question',
      false,
    ],
  ] as const)(
    'the orphaned run watcher %s',
    async (_label, destination, movedFirst) => {
      const { createTask, getTask, insertActiveRun, updateTask } =
        await import('./db.js');
      const { taskFixture } = await import('./test-helpers.js');
      const { readTaskMessages } =
        await import('./modules/transcripts/transcript-store.js');
      const {
        claimTaskExecution,
        releaseTaskExecutionClaim,
        requestDurableTaskStageHandoff,
        setGroupResolver,
      } = await import('./modules/kanban/task-executor.js');
      const brainClient = await import('./modules/objectives/brain-client.js');
      const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
        await import('./state-manager.js');
      const { reattachOrphanedRuns } = await import('./recovery.js');
      await loadState();
      const published: Array<{ type: string; source: unknown }> = [];
      const publishSpy = spyOn(
        brainClient,
        'publishEventWithResult',
      ).mockImplementation(async (_url: string | null, event: any) => {
        published.push({ type: event.type, source: event.data?.source });
        return { outcome: 'skipped' as const };
      });
      onTestFinished(() => publishSpy.mockRestore());
      const projectId = `recovery-handoff-moved-${destination}-${movedFirst}-${Date.now()}`;
      const jid = `${projectId}@web`;
      await registerGroup(
        jid,
        {
          name: 'Recovery handoff moved card',
          folder: projectId,
          trigger: '@Capa',
          added_at: new Date().toISOString(),
          settings: {
            status: 'running' as const,
            stages: [
              { id: 'in_progress', title: 'In progress', type: 'active' },
              { id: 'question', title: 'Question', type: 'queue' },
              { id: 'failed', title: 'Failed', type: 'queue' },
              { id: 'completed', title: 'Completed', type: 'done' },
            ].map((stage) => ({ ...stage, color: '#38f' }) as any),
          },
        },
        { requirePersistence: true },
      );
      setGroupResolver(getGroupByFolder);
      try {
        const task = await createTask(
          taskFixture({
            project_id: projectId,
            status: 'in_progress',
            objective_id: 'objective-moved-card',
          }),
        );
        const run = {
          ...makeRun(),
          group_folder: projectId,
          task_id: task.id,
          chat_jid: `task-${task.id}@kanban`,
          stage: 'in_progress',
        };
        const claim = claimTaskExecution(task.id, projectId);
        expect(claim).not.toBeNull();
        expect(
          await requestDurableTaskStageHandoff(
            task,
            'in_progress',
            destination,
            run.id,
            {
              steerAgentProcess: async () => false,
              interruptAgentTurn: async () => false,
              killAgentProcess: async () => false,
              schedule: (() => 0) as any,
            },
          ),
        ).toBe(true);
        releaseTaskExecutionClaim(task.id, claim!);
        const request = readTaskMessages(projectId, task.id).find(
          (message) => message.entry_type === 'stage_handoff_request',
        );
        expect(request).toBeDefined();

        const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'output.jsonl'), '');
        await insertActiveRun(run);
        // A human moved the card to the destination before the run result
        // was delivered.
        if (movedFirst) await updateTask(task.id, { status: destination });

        const recovery = await reattachOrphanedRuns({
          drainProjectQueue: async () => {},
        });
        writeV1Run(runDir, {
          result: 'Handing off.',
          sessionId: 'moved-handoff-session',
        });
        fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
        const settled = await Promise.race([
          recovery.settled.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 3000),
          ),
        ]);
        expect(settled).toBe(true);

        expect((await getTask(task.id))?.status).toBe(destination);
        expect(
          readTaskMessages(projectId, task.id).filter(
            (message) =>
              message.entry_type === 'stage_handoff_delivery' &&
              message.prompt_id === request?.id,
          ),
        ).toHaveLength(1);
        expect(
          published.filter((event) => event.source === 'agent_update'),
        ).toHaveLength(movedFirst ? 0 : 1);
      } finally {
        await unregisterGroup(jid);
      }
    },
  );

  test('applies an entry run handoff over entry success when restart recovery finalizes it', async () => {
    const {
      bindTaskAdmissionRun,
      claimNormalTaskAdmission,
      claimNextStageEntryEvent,
      completeActiveRun,
      createTask,
      getStageEntryEventByRunId,
      getTask,
      insertActiveRun,
      markStageEntryEventRunning,
      snapshotTaskAdmissionOwners,
      updateTask,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { readTaskMessages } =
      await import('./modules/transcripts/transcript-store.js');
    const {
      claimTaskExecution,
      releaseTaskExecutionClaim,
      requestDurableTaskStageHandoff,
      setGroupResolver,
    } = await import('./modules/kanban/task-executor.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    const { recoverStalledRuns } = await import('./recovery.js');
    await loadState();
    const projectId = `recovery-entry-handoff-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(
      jid,
      {
        name: 'Recovery entry handoff',
        folder: projectId,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'running' as const,
          stages: [
            { id: 'backlog', title: 'Backlog', type: 'queue' as const },
            {
              id: 'auto',
              title: 'Auto',
              type: 'active' as const,
              runOnEntry: true,
            },
            { id: 'second', title: 'Second', type: 'queue' as const },
            { id: 'completed', title: 'Completed', type: 'done' as const },
          ].map((stage) => ({ ...stage, color: '#38f' })),
        },
      },
      { requirePersistence: true },
    );
    setGroupResolver(getGroupByFolder);
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'backlog' }),
      );
      await updateTask(task.id, { status: 'auto' });
      const event = await claimNextStageEntryEvent(
        projectId,
        '1970-01-01T00:00:00.000Z',
      );
      expect(event?.taskId).toBe(task.id);
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'auto',
      };
      const admission = await claimNormalTaskAdmission(
        projectId,
        () => ({ claimed: true }),
        true,
        task.id,
      );
      expect(admission.claim).not.toBeNull();
      await insertActiveRun(run);
      await bindTaskAdmissionRun(
        projectId,
        task.id,
        run.id,
        admission.ownerToken,
      );
      await markStageEntryEventRunning(event!.id, run.id);
      const claim = claimTaskExecution(task.id, projectId);
      expect(claim).not.toBeNull();
      expect(
        await requestDurableTaskStageHandoff(task, 'auto', 'second', run.id, {
          steerAgentProcess: async () => false,
          interruptAgentTurn: async () => false,
          killAgentProcess: async () => false,
          schedule: (() => 0) as any,
        }),
      ).toBe(true);
      releaseTaskExecutionClaim(task.id, claim!);
      await completeActiveRun(run.id, 'completed', { result: 'done' }, 's1');

      await recoverStalledRuns({
        admissionSnapshot: await snapshotTaskAdmissionOwners(),
        drainProjectQueue: async () => {},
      });

      const request = readTaskMessages(projectId, task.id).find(
        (message) => message.entry_type === 'stage_handoff_request',
      );
      const recovered = await getTask(task.id);
      expect(recovered?.status).toBe('second');
      expect(recovered?.custom_values?.recovery_transition).toBeUndefined();
      expect(
        readTaskMessages(projectId, task.id).filter(
          (message) =>
            message.entry_type === 'stage_handoff_delivery' &&
            message.prompt_id === request?.id,
        ),
      ).toHaveLength(1);
      expect((await getStageEntryEventByRunId(run.id))?.state).not.toBe(
        'succeeded',
      );
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('retries retained scheduled transcript preservation before sweeping', async () => {
    const { GROUPS_DIR } = await import('./config.js');
    const { completeActiveRun, createScheduledTask, insertActiveRun } =
      await import('./db.js');
    const folder = `scheduled-sweep-${Date.now()}`;
    const scheduledTaskId = `scheduled-sweep-task-${Date.now()}`;
    await createScheduledTask({
      id: scheduledTaskId,
      group_folder: folder,
      chat_jid: `${folder}@web`,
      prompt: 'Retry preserved scheduled evidence',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });
    const run = {
      ...makeRun(),
      group_folder: folder,
      chat_jid: `${folder}@web`,
      isScheduledTask: 1,
      scheduled_task_id: scheduledTaskId,
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'retry prompt');
    writeV1Run(runDir, { result: 'retry output' });
    await insertActiveRun(run);
    await completeActiveRun(run.id, 'error');

    const groupDir = path.join(GROUPS_DIR, folder);
    const transcriptDir = path.join(groupDir, 'session-transcripts');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(transcriptDir, 'block transcript directory creation');
    const { sweepOrphanedIpcDirs } = await import('./recovery.js');
    await sweepOrphanedIpcDirs();
    expect(fs.existsSync(runDir)).toBe(true);

    fs.rmSync(transcriptDir, { force: true });
    await sweepOrphanedIpcDirs();
    expect(fs.existsSync(runDir)).toBe(false);
    expect(
      fs.readFileSync(path.join(transcriptDir, `${run.id}.prompt.txt`), 'utf8'),
    ).toBe('retry prompt');
    expect(
      fs.readFileSync(path.join(transcriptDir, `${run.id}.v1.jsonl`), 'utf8'),
    ).toContain('retry output');
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  test('routes a task run without a DB row to its task transcript', async () => {
    const taskId = `task-${Date.now()}-orphan`;
    const runId = `run-orphan-${Date.now()}`;
    const runDir = path.join(ipcBase, 'carapa-bot-test-proj', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({ groupFolder: 'test-proj', taskId }),
    );
    writeV1Run(runDir, { result: 'orphaned task output' });

    const { sweepOrphanedIpcDirs } = await import('./recovery.js');
    const { outputTranscriptPath } = await import('./group-dir.js');
    await sweepOrphanedIpcDirs();

    const transcript = outputTranscriptPath('test-proj', taskId);
    expect(fs.readFileSync(transcript, 'utf-8')).toContain(
      'orphaned task output',
    );
    const { GROUPS_DIR } = await import('./config.js');
    expect(
      fs.readFileSync(
        path.join(
          GROUPS_DIR,
          'test-proj',
          'session-transcripts',
          `${runId}.v1.jsonl`,
        ),
        'utf8',
      ),
    ).toContain('orphaned task output');
    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('deletes an orphaned run that never produced output', async () => {
    // The run died before the agent wrote anything: there is no output to
    // archive (warm session output is recovered from sessions/ separately),
    // so the dir must not be preserved forever.
    const runId = `run-orphan-no-output-${Date.now()}`;
    const runDir = path.join(ipcBase, 'carapa-bot-test-proj', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({
        groupFolder: 'test-proj',
        taskId: `task-${Date.now()}-missing-output`,
      }),
    );
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'lost run prompt');

    const { sweepOrphanedIpcDirs } = await import('./recovery.js');
    await sweepOrphanedIpcDirs();

    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('deletes an orphaned run whose output.jsonl is empty (no archivable content)', async () => {
    // The run died after the output file was created but before the agent
    // wrote anything. Archiving an empty file is a successful no-op — NOT an
    // archive failure — so the sweep must delete the dir instead of
    // preserving it forever and re-warning on every boot.
    const runId = `run-orphan-empty-output-${Date.now()}`;
    const runDir = path.join(ipcBase, 'carapa-bot-test-proj', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({
        groupFolder: 'test-proj',
        conversationId: `conv-orphan-empty-${Date.now()}`,
      }),
    );
    fs.writeFileSync(path.join(runDir, 'output.jsonl'), '');

    const { sweepOrphanedIpcDirs } = await import('./recovery.js');
    await sweepOrphanedIpcDirs();

    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('archives and deletes a run dir holding a terminal V1 pair', async () => {
    // A crash before the final rm leaves a pair that may already be archived;
    // the checkpointed append makes the sweep safe to repeat on every boot.
    const runId = `run-orphan-already-archived-${Date.now()}`;
    const runDir = path.join(ipcBase, 'carapa-bot-test-proj', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({
        groupFolder: 'test-proj',
        conversationId: `conv-orphan-archived-${Date.now()}`,
      }),
    );
    writeV1Run(runDir, { result: 'already in transcript' });

    const { sweepOrphanedIpcDirs } = await import('./recovery.js');
    await sweepOrphanedIpcDirs();

    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('preserves an orphaned run when archiving its output fails', async () => {
    const runId = `run-orphan-archive-failure-${Date.now()}`;
    const runDir = path.join(ipcBase, 'carapa-bot-test-proj', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    // A directory at the V1 event path makes the archival read fail. The sweep
    // must preserve the run instead of deleting the only remaining evidence.
    fs.writeFileSync(
      path.join(runDir, 'args.json'),
      JSON.stringify({ groupFolder: 'test-proj', agentCmd: 'claude' }),
    );
    fs.writeFileSync(
      path.join(runDir, 'output.v1.meta.json'),
      JSON.stringify({
        format: 'carapa-run',
        version: 1,
        harness: 'claude',
        requestedModel: null,
      }),
    );
    fs.mkdirSync(path.join(runDir, 'output.v1.jsonl'));

    const { sweepOrphanedIpcDirs } = await import('./recovery.js');
    await sweepOrphanedIpcDirs();

    expect(fs.existsSync(runDir)).toBe(true);
  });
});

// ─── Part B — sweepDeadAgentRuns reaper ───────────────────────────────────────

describe('Part B: sweepDeadAgentRuns reaper', () => {
  test('skips runs whose pid file is missing (does not probe)', async () => {
    await ensureInitDb();
    const run = makeRun();
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    // No pid file written.
    const { insertActiveRun } = await import('./db.js');
    await insertActiveRun(run);

    const { sweepDeadAgentRuns } = await import('./recovery.js');
    await sweepDeadAgentRuns();

    const killProbes = _sandboxExecCalls.filter((c) =>
      c.command.includes('agent-status.sh'),
    );
    expect(killProbes).toHaveLength(0);
  });

  test('reaps a run when agent-status reports the pid is dead (isError=true)', async () => {
    await ensureInitDb();
    const run = makeRun();
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'pid'), '12345');
    const { insertActiveRun } = await import('./db.js');
    await insertActiveRun(run);

    _deadPids.add('12345');
    const { sweepDeadAgentRuns } = await import('./recovery.js');
    await sweepDeadAgentRuns();

    const killProbes = _sandboxExecCalls.filter((c) =>
      c.command.includes('agent-status.sh'),
    );
    expect(killProbes).toHaveLength(1);
    expect(killProbes[0]?.command).toBe('agent-status.sh 12345');
    // killRun invoked (via the real killRun → sandboxExec stop-agent.sh
    // stub) — proves the reaper decided the PID was dead.
    const stopCalls = _sandboxExecCalls.filter((c) =>
      c.command.includes('stop-agent.sh'),
    );
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    // DB was finalized: completeActiveRun was called via the real killRun.
    const { getActiveRunById } = await import('./db.js');
    const dbRun = await getActiveRunById(run.id);
    expect(dbRun?.status).toBe('error');
  });

  test('does NOT reap a run when agent-status reports the pid is alive (isError=false)', async () => {
    await ensureInitDb();
    const run = makeRun();
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'pid'), '54321');
    const { insertActiveRun } = await import('./db.js');
    await insertActiveRun(run);

    // PID 54321 is NOT in the dead set → probe returns isError=false.
    const { sweepDeadAgentRuns } = await import('./recovery.js');
    await sweepDeadAgentRuns();

    const killProbes = _sandboxExecCalls.filter((c) =>
      c.command.includes('agent-status.sh'),
    );
    expect(killProbes).toHaveLength(1);
    expect(killProbes[0]?.command).toBe('agent-status.sh 54321');
    // No killRun → no stop-agent.sh call.
    const stopCalls = _sandboxExecCalls.filter((c) =>
      c.command.includes('stop-agent.sh'),
    );
    expect(stopCalls).toHaveLength(0);
    // DB row still 'running'.
    const { getActiveRunById } = await import('./db.js');
    const dbRun = await getActiveRunById(run.id);
    expect(dbRun?.status).toBe('running');
  });

  test('passes a 5s timeout to the PID probe so it never hangs the sweep', async () => {
    await ensureInitDb();
    const run = makeRun();
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'pid'), '99999');
    const { insertActiveRun } = await import('./db.js');
    await insertActiveRun(run);

    _deadPids.add('99999');
    const { sweepDeadAgentRuns } = await import('./recovery.js');
    await sweepDeadAgentRuns();

    const killProbes = _sandboxExecCalls.filter((c) =>
      c.command.includes('agent-status.sh'),
    );
    expect(killProbes[0]?.options?.timeout).toBe(5);
  });

  // Race-fix regression: the wrapper subshell writes the pid first, then
  // may exit cleanly before the agent overwrites it with the daemon pid.
  // If the sweep happens to probe AFTER the wrapper exited but BEFORE the
  // run-agent.sh subshell overwrites pid, agent-status reports dead. Without
  // the re-check, killRun would write exit_code=137 over a legitimate
  // exit_code the wrapper already wrote (usually 0). Verify: when the probe
  // says dead AND exit_code exists, sweep MUST NOT call killRun / stop-agent.
  test('does NOT reap when the PID probe says dead BUT exit_code already exists (race)', async () => {
    await ensureInitDb();
    const run = makeRun();
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'pid'), '77777');
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0');
    const { insertActiveRun } = await import('./db.js');
    await insertActiveRun(run);

    _deadPids.add('77777');
    const { sweepDeadAgentRuns } = await import('./recovery.js');
    await sweepDeadAgentRuns();

    // Exit_code short-circuits BEFORE the PID probe (cheaper, and we
    // already trust exit_code more than a transient kill -0 result). This
    // means the sweep never even asks the sandbox.
    const killProbes = _sandboxExecCalls.filter((c) =>
      c.command.includes('agent-status.sh'),
    );
    expect(killProbes).toHaveLength(0);
    const stopCalls = _sandboxExecCalls.filter((c) =>
      c.command.includes('stop-agent.sh'),
    );
    expect(stopCalls).toHaveLength(0);
    // DB row is still 'running' — caller will finalize from the real exit_code.
    const { getActiveRunById } = await import('./db.js');
    const dbRun = await getActiveRunById(run.id);
    expect(dbRun?.status).toBe('running');
  });

  // Regression for the kanban-task killer: the docker compose exec probe
  // itself can fail (container hiccup, MCP server restart, transient
  // network blip) and return isError=true with NO `kill0_exit=N` marker
  // in stdout. Old code treated any isError as "process dead" → reap →
  // SIGTERM a live opencode/claude in the middle of its work. New code
  // requires the marker before declaring the process dead.
  test('does NOT reap when sandboxExec fails (no kill0_exit marker) — agent is alive', async () => {
    await ensureInitDb();
    const run = makeRun();
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'pid'), '88888');
    const { insertActiveRun } = await import('./db.js');
    await insertActiveRun(run);

    // Simulate docker compose exec failure (isError=true, no marker).
    _sandboxFailurePids.add('88888');
    const { sweepDeadAgentRuns } = await import('./recovery.js');
    await sweepDeadAgentRuns();

    // Probe ran (we want to see it attempted), but no killRun.
    const killProbes = _sandboxExecCalls.filter((c) =>
      c.command.includes('agent-status.sh'),
    );
    expect(killProbes).toHaveLength(1);
    const stopCalls = _sandboxExecCalls.filter((c) =>
      c.command.includes('stop-agent.sh'),
    );
    expect(stopCalls).toHaveLength(0);
    // DB row stays 'running' — the agent is still alive in the sandbox.
    const { getActiveRunById } = await import('./db.js');
    const dbRun = await getActiveRunById(run.id);
    expect(dbRun?.status).toBe('running');
  });

  // A stopped container has no live processes: the agent is certainly dead, so
  // waiting out the idle timeout only stalls the lane.
  test('reaps when the probe fails with "in state stopped" (container stopped)', async () => {
    await ensureInitDb();
    const run = makeRun();
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'pid'), '66666');
    const { insertActiveRun } = await import('./db.js');
    await insertActiveRun(run);

    _stoppedContainerPids.set('66666', undefined);
    const { sweepDeadAgentRuns } = await import('./recovery.js');
    await sweepDeadAgentRuns();

    const stopCalls = _sandboxExecCalls.filter((c) =>
      c.command.includes('stop-agent.sh'),
    );
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    const { getActiveRunById } = await import('./db.js');
    const dbRun = await getActiveRunById(run.id);
    expect(dbRun?.status).toBe('error');
  });

  test('does NOT reap a stopped-container probe when exit_code appeared meanwhile (race)', async () => {
    await ensureInitDb();
    const run = makeRun();
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'pid'), '66667');
    const { insertActiveRun } = await import('./db.js');
    await insertActiveRun(run);

    // The wrapper writes exit_code while the probe is in flight.
    _stoppedContainerPids.set('66667', () =>
      fs.writeFileSync(path.join(runDir, 'exit_code'), '0'),
    );
    const { sweepDeadAgentRuns } = await import('./recovery.js');
    await sweepDeadAgentRuns();

    const killProbes = _sandboxExecCalls.filter((c) =>
      c.command.includes('agent-status.sh'),
    );
    expect(killProbes).toHaveLength(1);
    const stopCalls = _sandboxExecCalls.filter((c) =>
      c.command.includes('stop-agent.sh'),
    );
    expect(stopCalls).toHaveLength(0);
    const { getActiveRunById } = await import('./db.js');
    const dbRun = await getActiveRunById(run.id);
    expect(dbRun?.status).toBe('running');
  });
});

// ─── Recovery deadline parity ────────────────────────────────────────────────
// The live path intentionally exempts chat and scheduled-direct runs (no
// task_id) from the hard wall-clock deadline (see chatTimeoutMs in
// runContainerAgent): they are bounded by the idle stall watchdog and the
// dead-agent reaper instead. Every run stores a finite timeout_at, so restart
// recovery must not apply it as a kill deadline to non-task runs.

describe('recovery deadline parity for non-task runs', () => {
  test('boot recovery defers a chat run past its stored timeout_at instead of killing it', async () => {
    const { getActiveRunById, insertActiveRun } = await import('./db.js');

    // Chat run (no task_id) whose finite timeout_at already passed while the
    // board was down. The agent may legitimately still be running: the live
    // path would never have killed it for crossing MCP_AGENT_TIMEOUT.
    const run = {
      ...makeRun(),
      timeout_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'a long chat turn');
    await insertActiveRun(run);

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns();

    // Deferred to async recovery (still 'running'), directory untouched.
    expect((await getActiveRunById(run.id))?.status).toBe('running');
    expect(fs.existsSync(runDir)).toBe(true);
  });

  test('boot recovery still kills a task run past its stored timeout_at', async () => {
    const { createTask, getActiveRunById, insertActiveRun } =
      await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');

    const task = await createTask(
      taskFixture({ project_id: 'test-proj', status: 'in_progress' }),
    );
    const run = {
      ...makeRun(),
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      timeout_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'task prompt');
    await insertActiveRun(run);

    const { recoverStalledRuns } = await import('./recovery.js');
    await recoverStalledRuns();

    // Task runs keep the hard deadline — the exemption must not leak here.
    expect((await getActiveRunById(run.id))?.status).toBe('error');
    expect(fs.existsSync(runDir)).toBe(false);
    const { GROUPS_DIR } = await import('./config.js');
    expect(
      fs.readFileSync(
        path.join(
          GROUPS_DIR,
          'test-proj',
          'session-transcripts',
          `${run.id}.prompt.txt`,
        ),
        'utf8',
      ),
    ).toBe('task prompt');
  });

  test('orphan recovery re-adopts a completed chat run past its stored timeout_at', async () => {
    const { getActiveRunById, insertActiveRun } = await import('./db.js');

    // The agent finished during the board downtime (exit_code present), but
    // the stored timeout_at already passed. Recovery must re-adopt and
    // complete the run instead of discarding the finished output as
    // 'timeout' (the old re-adopt timeout collapsed to a 1s hard floor).
    const run = {
      ...makeRun(),
      timeout_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, { result: 'Recovered after a long chat turn' });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'a long chat turn');
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    await insertActiveRun(run);

    const { recoverOrphanedRuns } = await import('./recovery.js');
    await expect(recoverOrphanedRuns()).resolves.toBeUndefined();

    expect((await getActiveRunById(run.id))?.status).toBe('completed');
    expect(fs.existsSync(runDir)).toBe(false);
  });
});

describe('web_view browser worker restart ownership', () => {
  test('terminal boot recovery retires the worker without persisting its agent session', async () => {
    const { getActiveRunById, insertActiveRun } = await import('./db.js');
    const { sessions } = await import('./state-manager.js');
    const run = {
      ...makeRun(),
      chat_jid: 'web-view-agent:web-view-recovered-terminal',
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    writeV1Run(runDir, {
      result: 'Browser worker narration that must not be delivered',
      sessionId: 'browser-agent-harness-session',
    });
    fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
    sessions[run.group_folder] = 'durable-chat-session';
    await insertActiveRun(run);

    try {
      const { recoverStalledRuns } = await import('./recovery.js');
      await recoverStalledRuns();

      expect(await getActiveRunById(run.id)).toMatchObject({ status: 'error' });
      expect(sessions[run.group_folder]).toBe('durable-chat-session');
      expect(fs.existsSync(runDir)).toBe(false);
      expect(_sandboxExecCalls.map((call) => call.command)).toContain(
        "playwright-cli -s='web-view-recovered-terminal' close",
      );
    } finally {
      delete sessions[run.group_folder];
    }
  });

  test('an adopted Review run that approves on a shared checkout merges under the watcher lease and releases its claim', async () => {
    const {
      bindTaskAdmissionRun,
      claimNormalTaskAdmission,
      createTask,
      getActiveRunById,
      getTask,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { setGroupResolver, isTaskRunning } =
      await import('./modules/kanban/task-executor.js');
    const { acquireSharedCheckoutLease } =
      await import('./concurrency/shared-checkout-lease.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    const { reattachOrphanedRuns } = await import('./recovery.js');
    await loadState();
    const projectId = `recovery-adopted-review-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(
      jid,
      {
        name: 'Recovery adopted review',
        folder: projectId,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'running' as const,
          taskCheckoutMode: 'shared' as const,
          repositoryLocation: '/host/repos/adopted-review',
          defaultBranch: 'develop',
          stages: [
            { id: 'backlog', title: 'Backlog', type: 'queue' as const },
            { id: 'review', title: 'Review', type: 'review' as const },
            { id: 'completed', title: 'Completed', type: 'done' as const },
          ].map((stage) => ({ ...stage, color: '#38f' })),
        },
      },
      { requirePersistence: true },
    );
    setGroupResolver(getGroupByFolder);
    const mergedSha = 'a'.repeat(40);
    _gitHandler = (tool, args) => {
      if (tool === 'sandboxBranch')
        return { stdout: 'committed', isError: false };
      const command = String(args[1]);
      const stdout = command.startsWith('rev-parse')
        ? `${mergedSha}\n`
        : command.startsWith('branch --show-current')
          ? 'develop\n'
          : '';
      return { stdout, isError: false };
    };
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'review' }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'review',
      };
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'output.jsonl'), '');
      const admission = await claimNormalTaskAdmission(
        projectId,
        () => ({ claimed: true }),
        false,
        task.id,
      );
      await insertActiveRun(run);
      await bindTaskAdmissionRun(
        projectId,
        task.id,
        run.id,
        admission.ownerToken,
      );

      const recovery = await reattachOrphanedRuns({
        drainProjectQueue: async () => {},
      });
      // The run finishes after adoption, with an approving verdict.
      writeV1Run(runDir, {
        result: JSON.stringify({
          decision: 'approve',
          score: 9,
          issues: [],
          summary: 'looks good',
        }),
        sessionId: 'adopted-review-session',
      });
      fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
      const settled = await Promise.race([
        recovery.settled.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 3000),
        ),
      ]);
      expect(settled).toBe(true);
      const merged = await getTask(task.id);
      expect(merged?.status).toBe('completed');
      // The approval integrated the shared checkout into the default branch.
      expect(merged?.merge_commit).toBe(mergedSha);
      // The watcher's checkpoint and the verdict's merge each committed.
      expect(
        _gitCalls.filter(
          (call) => call.tool === 'sandboxBranch' && call.args[1] === 'commit',
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect((await getActiveRunById(run.id))?.status).not.toBe('running');
      expect(await isTaskRunning(task.id, new Set())).toBe(false);
      // The watcher released the checkout lease: another owner can take it.
      const lease = await acquireSharedCheckoutLease(
        projectId,
        { type: 'task', id: 'task-other-owner' },
        { deferToOtherOwner: true },
      );
      await lease.release();
    } finally {
      await unregisterGroup(jid);
    }
  });

  test('an adopted implementation run that finishes into a done stage on a shared checkout merges under the watcher lease and releases its claim', async () => {
    const {
      bindTaskAdmissionRun,
      claimNormalTaskAdmission,
      createTask,
      getTask,
      insertActiveRun,
    } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { setGroupResolver, isTaskRunning } =
      await import('./modules/kanban/task-executor.js');
    const { acquireSharedCheckoutLease } =
      await import('./concurrency/shared-checkout-lease.js');
    const { getGroupByFolder, loadState, registerGroup, unregisterGroup } =
      await import('./state-manager.js');
    const { reattachOrphanedRuns } = await import('./recovery.js');
    await loadState();
    const projectId = `recovery-adopted-coding-${Date.now()}`;
    const jid = `${projectId}@web`;
    await registerGroup(
      jid,
      {
        name: 'Recovery adopted coding',
        folder: projectId,
        trigger: '@Capa',
        added_at: new Date().toISOString(),
        settings: {
          status: 'running' as const,
          taskCheckoutMode: 'shared' as const,
          repositoryLocation: '/host/repos/adopted-coding',
          defaultBranch: 'develop',
          stages: [
            { id: 'backlog', title: 'Backlog', type: 'queue' as const },
            { id: 'coding', title: 'Coding', type: 'active' as const },
            { id: 'completed', title: 'Completed', type: 'done' as const },
          ].map((stage) => ({ ...stage, color: '#38f' })),
        },
      },
      { requirePersistence: true },
    );
    setGroupResolver(getGroupByFolder);
    _gitHandler = (tool, args) => {
      if (tool === 'sandboxBranch')
        return { stdout: 'committed', isError: false };
      const command = String(args[1]);
      const stdout = command.startsWith('rev-parse')
        ? `${'a'.repeat(40)}\n`
        : command.startsWith('branch --show-current')
          ? 'develop\n'
          : '';
      return { stdout, isError: false };
    };
    let recoverySettled: Promise<void> | undefined;
    try {
      const task = await createTask(
        taskFixture({ project_id: projectId, status: 'coding' }),
      );
      const run = {
        ...makeRun(),
        group_folder: projectId,
        task_id: task.id,
        chat_jid: `task-${task.id}@kanban`,
        stage: 'coding',
      };
      const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'output.jsonl'), '');
      const admission = await claimNormalTaskAdmission(
        projectId,
        () => ({ claimed: true }),
        false,
        task.id,
      );
      await insertActiveRun(run);
      await bindTaskAdmissionRun(
        projectId,
        task.id,
        run.id,
        admission.ownerToken,
      );

      const recovery = await reattachOrphanedRuns({
        drainProjectQueue: async () => {},
      });
      recoverySettled = recovery.settled;
      // The run finishes successfully after adoption.
      writeV1Run(runDir, {
        result: 'implemented',
        sessionId: 'adopted-coding-session',
      });
      fs.writeFileSync(path.join(runDir, 'exit_code'), '0\n');
      const settled = await Promise.race([
        recovery.settled.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 3000),
        ),
      ]);
      expect(settled).toBe(true);
      expect((await getTask(task.id))?.status).toBe('completed');
      // The watcher's checkpoint and the generic done merge each committed;
      // the checkpoint alone would leave a single commit.
      expect(
        _gitCalls.filter(
          (call) => call.tool === 'sandboxBranch' && call.args[1] === 'commit',
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect(await isTaskRunning(task.id, new Set())).toBe(false);
      // The watcher released the checkout lease: another owner can take it.
      const lease = await acquireSharedCheckoutLease(
        projectId,
        { type: 'task', id: 'task-other-owner' },
        { deferToOtherOwner: true },
      );
      await lease.release();
    } finally {
      // A watcher still blocked on its own lease would keep retrying and
      // heartbeating into the next test. Drop the lease file so the blocked
      // merge proceeds, then wait for the watcher to finish its cleanup.
      const { DATA_DIR } = await import('./config.js');
      fs.rmSync(
        path.join(DATA_DIR, 'shared-checkout-leases', `${projectId}.json`),
        { force: true },
      );
      await recoverySettled;
      await unregisterGroup(jid);
    }
  });

  test('orphan adoption kills the detached worker and closes only its encoded browser session', async () => {
    const { getActiveRunById, insertActiveRun } = await import('./db.js');
    const run = {
      ...makeRun(),
      chat_jid: 'web-view-agent:web-view-recovered-live',
    };
    const runDir = path.join(ipcBase, 'carapa-bot-default', 'runs', run.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'output.jsonl'), '');
    fs.writeFileSync(path.join(runDir, 'pid'), '424242\n');
    await insertActiveRun(run);

    const { reattachOrphanedRuns } = await import('./recovery.js');
    const recovery = await reattachOrphanedRuns();
    await recovery.settled;

    expect(await getActiveRunById(run.id)).toMatchObject({ status: 'error' });
    expect(fs.existsSync(runDir)).toBe(false);
    const commands = _sandboxExecCalls.map((call) => call.command);
    expect(commands.at(-1)).toBe(
      "playwright-cli -s='web-view-recovered-live' close",
    );
    expect(commands.slice(0, -1)).not.toHaveLength(0);
    expect(
      commands
        .slice(0, -1)
        .every((command) => command.startsWith('stop-agent.sh ')),
    ).toBe(true);
  });
});
