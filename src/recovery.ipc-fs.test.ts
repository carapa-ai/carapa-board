/**
 * recovery.ts reads and writes agent-writable IPC paths (sessions/<key>/,
 * runs/<runId>/) through the pinned-descriptor adapter: a planted link must
 * neither redirect a board write nor leak a file, and a FIFO must not block
 * the startup sweep.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';

const deadPids = new Set<string>();
const sandboxClientModule = await import('./lib/mcp-client.js');
mock.module('./lib/mcp-client.js', () => ({
  ...sandboxClientModule,
  getSandboxClient: () => ({
    sandboxExec: async (_stack: string, _service: string, command: string) => {
      const pid = command.match(/^agent-status\.sh (\d+)$/)?.[1];
      if (pid) {
        const dead = deadPids.has(pid);
        return { stdout: `kill0_exit=${dead ? 1 : 0}\n`, isError: dead };
      }
      return {
        stdout: JSON.stringify({ status: 'already_dead' }),
        isError: false,
      };
    },
  }),
}));

const suffix = `${process.pid}-${Date.now()}`;
const stackDir = path.join(DATA_DIR, 'ipc', 'carapa-bot-default');
const outside = path.join(DATA_DIR, `recovery-ipcfs-outside-${suffix}`);
const outsideFile = path.join(outside, 'file');
const SECRET = 'outside-secret';
let n = 0;

const run = (extra: Record<string, unknown> = {}) => {
  const now = new Date();
  return {
    id: `run-ipcfs-${suffix}-${n++}`,
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
    ...extra,
  };
};
const mkfifo = (p: string) => execFileSync('mkfifo', [p]);
const link = (p: string) => fs.symlinkSync(outsideFile, p);
const regular = (p: string) => fs.lstatSync(p).isFile();

beforeAll(async () => {
  const { initDatabase } = await import('./db.js');
  await initDatabase(':memory:');
  fs.mkdirSync(outside, { recursive: true });
});

beforeEach(async () => {
  const { truncateTestDb } = await import('./test-helpers.js');
  await truncateTestDb();
  deadPids.clear();
  fs.writeFileSync(outsideFile, SECRET);
});

afterEach(() => {
  fs.rmSync(path.join(stackDir, 'sessions'), { recursive: true, force: true });
  fs.rmSync(path.join(stackDir, 'runs'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('sweepDeadAgentRuns IPC reads', () => {
  const reapedWith = async (setup: (runDir: string) => void) => {
    const { getActiveRunById, insertActiveRun } = await import('./db.js');
    const { sweepDeadAgentRuns } = await import('./recovery.js');
    const r = run();
    const runDir = path.join(stackDir, 'runs', r.id);
    fs.mkdirSync(runDir, { recursive: true });
    setup(runDir);
    await insertActiveRun(r);
    deadPids.add('4242');
    await sweepDeadAgentRuns();
    return (await getActiveRunById(r.id))?.status === 'error';
  };

  test('a FIFO or linked pid file is skipped without blocking', async () => {
    expect(await reapedWith((d) => mkfifo(path.join(d, 'pid')))).toBe(false);
    expect(await reapedWith((d) => link(path.join(d, 'pid')))).toBe(false);
  });

  test('only /workspace/ipc/sessions/<key> of the same project names a session dir', async () => {
    const withSession = (value: string, daemonPid: boolean) => (d: string) => {
      fs.writeFileSync(path.join(d, 'pid'), '4242');
      fs.writeFileSync(path.join(d, 'session_dir'), `${value}\n`);
      const session = path.join(stackDir, 'sessions', 'key');
      fs.mkdirSync(session, { recursive: true });
      if (daemonPid) fs.writeFileSync(path.join(session, 'daemon.pid'), '1');
    };
    // The daemon is gone: the wrapper may still resolve the run itself.
    expect(
      await reapedWith(withSession('/workspace/ipc/sessions/key', false)),
    ).toBe(false);
    expect(
      await reapedWith(withSession('/workspace/ipc/sessions/key', true)),
    ).toBe(true);
    // Anything else is "no session dir", never a path to probe.
    for (const value of ['/etc', '../x', '/workspace/ipc/sessions/a/b']) {
      expect(await reapedWith(withSession(value, false))).toBe(true);
    }
    expect(
      await reapedWith((d) => {
        fs.writeFileSync(path.join(d, 'pid'), '4242');
        mkfifo(path.join(d, 'session_dir'));
      }),
    ).toBe(true);
  });
});

describe('task warm turn mirroring', () => {
  // An unfinished warm turn whose wrapper lock is alive: recovery mirrors it
  // into runs/<id> and keeps watching.
  const mirror = async (
    prepare: (paths: { sessionDir: string; runDir: string }) => void,
  ) => {
    const { createTask, insertActiveRun } = await import('./db.js');
    const { taskFixture } = await import('./test-helpers.js');
    const { TASK_PERSISTENT_RUNTIME_CONTRACT } =
      await import('./sandbox/process.js');
    const { recoverStalledRuns } = await import('./recovery.js');
    const task = await createTask(
      taskFixture({
        project_id: 'test-proj',
        status: 'in_progress',
        session_id: 'warm-session',
        last_agent_name: 'cursor-acp',
      }),
    );
    const r = run({
      task_id: task.id,
      chat_jid: `task-${task.id}@kanban`,
      stage: 'in_progress',
      session_id: 'warm-session',
      agent_name: 'cursor-acp',
      session_agent_key: 'cursor-acp',
      runtime_variant: 'deadbeef',
    });
    const sessionDir = path.join(
      stackDir,
      'sessions',
      `task-${task.id}-in_progress-deadbeef`,
    );
    const runDir = path.join(stackDir, 'runs', r.id);
    fs.mkdirSync(path.join(sessionDir, 'lock'), { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'session_id'), 'warm-session');
    fs.writeFileSync(
      path.join(sessionDir, TASK_PERSISTENT_RUNTIME_CONTRACT[0].warmOutputFile),
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'warm-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'working' },
          },
        },
      })}\n`,
    );
    fs.writeFileSync(path.join(sessionDir, 'lock', 'pid'), '4243');
    prepare({ sessionDir, runDir });
    await insertActiveRun(r);
    await recoverStalledRuns({ executeTask: async () => {} });
    return runDir;
  };

  test('a linked daemon.pid is not copied into the run dir', async () => {
    fs.writeFileSync(outsideFile, '777');
    const runDir = await mirror(({ sessionDir }) =>
      link(path.join(sessionDir, 'daemon.pid')),
    );
    expect(fs.existsSync(path.join(runDir, 'pid'))).toBe(false);
    expect(regular(path.join(runDir, 'output.v1.jsonl'))).toBe(true);
  });

  test('a FIFO daemon.pid is skipped without blocking', async () => {
    const runDir = await mirror(({ sessionDir }) =>
      mkfifo(path.join(sessionDir, 'daemon.pid')),
    );
    expect(fs.existsSync(path.join(runDir, 'pid'))).toBe(false);
    expect(regular(path.join(runDir, 'output.v1.jsonl'))).toBe(true);
  });

  test('planted output.v1.meta.json and pid links are replaced, not written through', async () => {
    const runDir = await mirror(({ sessionDir, runDir: dir }) => {
      fs.writeFileSync(path.join(sessionDir, 'daemon.pid'), '4244');
      link(path.join(dir, 'output.v1.meta.json'));
      link(path.join(dir, 'pid'));
    });
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe(SECRET);
    expect(fs.readFileSync(path.join(runDir, 'pid'), 'utf8')).toBe('4244');
    expect(regular(path.join(runDir, 'output.v1.meta.json'))).toBe(true);
    expect(
      fs.readFileSync(path.join(runDir, 'output.v1.jsonl'), 'utf8'),
    ).toContain('working');
  });

  test('a run dir that is itself a link receives no writes', async () => {
    const runDir = await mirror(({ runDir: dir }) => {
      fs.rmSync(dir, { recursive: true });
      fs.symlinkSync(outside, dir);
    });
    expect(fs.readdirSync(outside)).toEqual(['file']);
    fs.rmSync(runDir);
  });
});
