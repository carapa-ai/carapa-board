/**
 * Regression tests for removeWorktreeForTask.
 *
 * removeWorktreeForTask used to fire the async updateTask() without awaiting
 * it, so it resolved before the worktree_path: null write settled. The next
 * reader of that row — e.g. flipArchived's getTask() → task_updated
 * broadcast — could observe the stale worktree_path of an already-deleted
 * worktree.
 *
 * The await contract is verified in a child Bun process (a clean module
 * registry — the same isolation src/lib/mcp-client.test.ts uses for the
 * sandbox client wire contract): updateTask is gated behind a controllable
 * promise, and a correct implementation must still be pending while the gate
 * is held. The in-process cases below use the real in-memory DB and the real
 * updateTask to assert the write lands.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { getSandboxClient } from './mcp-client.js';
import {
  commitTaskBranch,
  mergeTaskBranchToDefault,
  removeWorktreeForTask,
} from './git-ops.js';

import {
  createConversation,
  createTask,
  getConversation,
  getConversationSessionId,
  getTask,
  initDatabase,
  setConversationSessionId,
  updateConversationWorktreePath,
  updateTask,
} from '../db.js';
import type { RegisteredGroup } from '../types.js';
import {
  applyGroupUpdateInMemory,
  registeredGroups,
} from '../state-manager.js';
import { taskFixture, truncateTestDb } from '../test-helpers.js';

const PROJ = 'wt-remove-proj';

const sandboxWorktreeCalls: Array<{
  stack: string;
  action: string;
  args: Record<string, unknown>;
}> = [];
let sandboxWorktreeResult = { stdout: '', isError: false };
const sandboxClient = getSandboxClient() as any;
const originalSandboxWorktree = sandboxClient.sandboxWorktree;
const originalSandboxBranch = sandboxClient.sandboxBranch;
const originalSandboxGit = sandboxClient.sandboxGit;

let _init = false;
beforeAll(async () => {
  if (!_init) {
    await initDatabase(':memory:');
    _init = true;
  }
  sandboxClient.sandboxWorktree = async (
    stack: string,
    action: string,
    args: Record<string, unknown>,
  ) => {
    sandboxWorktreeCalls.push({ stack, action, args });
    return sandboxWorktreeResult;
  };
  sandboxClient.sandboxBranch = async () => ({
    stdout: JSON.stringify({ merged: true }),
    isError: false,
  });
  sandboxClient.sandboxGit = async (_stack: string, command: string) => ({
    stdout: command.startsWith('merge-base') ? 'a'.repeat(40) : 'b'.repeat(40),
    isError: false,
  });
});

afterAll(() => {
  sandboxClient.sandboxWorktree = originalSandboxWorktree;
  sandboxClient.sandboxBranch = originalSandboxBranch;
  sandboxClient.sandboxGit = originalSandboxGit;
});

beforeEach(async () => {
  sandboxWorktreeCalls.length = 0;
  sandboxWorktreeResult = { stdout: '', isError: false };
  await truncateTestDb();
});

describe('removeWorktreeForTask (real DB)', () => {
  test('removes the sandbox worktree and nulls worktree_path in the DB', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, branch_name: 'wt-branch-1' }),
    );
    // worktree_path is persisted by checkoutTaskBranch, not createTask —
    // seed the post-checkout state explicitly.
    await updateTask(task.id, {
      worktree_path: `/workspace/${PROJ}/.worktrees/wt-branch-1`,
    });
    const conversation = await createConversation(PROJ, {
      use_worktree: true,
      branch_name: 'wt-branch-1',
    });
    await updateConversationWorktreePath(
      conversation.id,
      '.worktrees/wt-branch-1',
    );
    await setConversationSessionId(
      conversation.id,
      'codex',
      'task-chat-session',
    );

    await removeWorktreeForTask(task, {
      folder: PROJ,
      settings: {},
    } as RegisteredGroup);

    expect(sandboxWorktreeCalls).toHaveLength(1);
    expect(sandboxWorktreeCalls[0].action).toBe('remove');
    expect(sandboxWorktreeCalls[0].args).toMatchObject({
      branch: 'wt-branch-1',
    });
    expect((await getTask(task.id))?.worktree_path).toBeNull();
    expect(await getConversation(conversation.id)).toMatchObject({
      use_worktree: 0,
      worktree_path: null,
      branch_name: null,
    });
    expect(await getConversationSessionId(conversation.id, 'codex')).toBeNull();
  });

  test('preserves the task and conversation when CarapaBox removal fails', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, branch_name: 'failed-task-branch' }),
    );
    const worktreePath = `/workspace/${PROJ}/.worktrees/failed-task-branch`;
    await updateTask(task.id, { worktree_path: worktreePath });
    const conversation = await createConversation(PROJ, {
      use_worktree: true,
      branch_name: 'failed-task-branch',
    });
    await updateConversationWorktreePath(
      conversation.id,
      '.worktrees/failed-task-branch',
    );
    await setConversationSessionId(conversation.id, 'codex', 'kept-session');
    sandboxWorktreeResult = { stdout: 'remove failed', isError: true };

    await removeWorktreeForTask(
      task,
      { folder: PROJ, settings: {} } as RegisteredGroup,
      { throwOnError: false },
    );

    expect((await getTask(task.id))?.worktree_path).toBe(worktreePath);
    expect(await getConversation(conversation.id)).toMatchObject({
      use_worktree: 1,
      worktree_path: '.worktrees/failed-task-branch',
      branch_name: 'failed-task-branch',
    });
    expect(await getConversationSessionId(conversation.id, 'codex')).toBe(
      'kept-session',
    );
  });

  test('returns early without touching the sandbox or DB when there is no branch', async () => {
    const task = await createTask(taskFixture({ project_id: PROJ }));
    await updateTask(task.id, {
      worktree_path: `/workspace/${PROJ}/.worktrees/kept`,
    });

    const taskWithoutBranch = { ...task, branch_name: undefined };
    await removeWorktreeForTask(taskWithoutBranch, {
      folder: PROJ,
      settings: {},
    } as RegisteredGroup);

    expect(sandboxWorktreeCalls).toHaveLength(0);
    expect((await getTask(task.id))?.worktree_path).toBe(
      `/workspace/${PROJ}/.worktrees/kept`,
    );
  });

  test('resets conversations when a task merge removes its worktree', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, branch_name: 'merge-task-branch' }),
    );
    await updateTask(task.id, {
      worktree_path: `/workspace/${PROJ}/.worktrees/merge-task-branch`,
    });
    const conversation = await createConversation(PROJ, {
      use_worktree: true,
      branch_name: 'merge-task-branch',
    });
    await updateConversationWorktreePath(
      conversation.id,
      '.worktrees/merge-task-branch',
    );
    await setConversationSessionId(conversation.id, 'codex', 'merge-session');

    const result = await mergeTaskBranchToDefault((await getTask(task.id))!, {
      folder: PROJ,
      settings: { taskCheckoutMode: 'worktree' },
    } as RegisteredGroup);

    expect(result.mergeOk).toBe(true);
    expect(await getTask(task.id)).toMatchObject({
      branch_name: null,
      worktree_path: null,
    });
    expect(await getConversation(conversation.id)).toMatchObject({
      use_worktree: 0,
      branch_name: null,
      worktree_path: null,
    });
    expect(await getConversationSessionId(conversation.id, 'codex')).toBeNull();
  });

  test('treats merged:true with isError (worktree cleanup failure) as a successful merge', async () => {
    const task = await createTask(
      taskFixture({ project_id: PROJ, branch_name: 'cleanup-fail-branch' }),
    );
    await updateTask(task.id, {
      worktree_path: `/workspace/${PROJ}/.worktrees/cleanup-fail-branch`,
    });
    const previous = sandboxClient.sandboxBranch;
    sandboxClient.sandboxBranch = async () => ({
      stdout: JSON.stringify({
        merged: true,
        pushed: false,
        output: 'Merged, but task worktree cleanup failed: boom',
      }),
      isError: true,
    });
    try {
      const result = await mergeTaskBranchToDefault((await getTask(task.id))!, {
        folder: PROJ,
        settings: { taskCheckoutMode: 'worktree' },
      } as RegisteredGroup);

      expect(result.mergeOk).toBe(true);
      expect(await getTask(task.id)).toMatchObject({
        branch_name: null,
        merge_commit: 'b'.repeat(40),
      });
    } finally {
      sandboxClient.sandboxBranch = previous;
    }
  });
});

describe('trusted remoteUrl on CarapaBox git calls', () => {
  const OWNER = 'remote-url-owner';
  const CHILD_URL = 'git@gitlab.example:ns/child.git';
  const URL = 'git@gitlab.example:ns/repo.git';
  const group = (
    folder: string,
    settings: RegisteredGroup['settings'],
    parentId?: string,
  ) =>
    ({
      name: folder,
      folder,
      trigger: '@x',
      added_at: new Date().toISOString(),
      ...(parentId ? { parentId } : {}),
      settings: { taskCheckoutMode: 'worktree', ...settings },
    }) as RegisteredGroup;
  const registered: string[] = [];
  const register = (g: RegisteredGroup) => {
    registeredGroups[`${g.folder}@web`] = g;
    registered.push(`${g.folder}@web`);
    applyGroupUpdateInMemory(`${g.folder}@web`, {});
    return g;
  };

  afterAll(() => {
    // Rebuild the folder index (via a still-registered entry) without them.
    const last = registered.pop()!;
    for (const jid of registered) delete registeredGroups[jid];
    applyGroupUpdateInMemory(last, {});
    delete registeredGroups[last];
  });

  test('merge and worktree add pass the repositoryUrl of the repository operated on, or none', async () => {
    register(
      group(OWNER, {
        isParent: true,
        sandboxOwnership: 'shared',
        repositoryUrl: `  ${URL}  `,
      }),
    );
    // [group, expected remoteUrl]
    const cases: Array<[RegisteredGroup, string | undefined]> = [
      [group('remote-url-own', { repositoryUrl: URL }), URL],
      [group('remote-url-none', {}), undefined],
      // Child with its own repository URL: its own, never the owner's.
      [
        register(group('remote-url-c1', { repositoryUrl: CHILD_URL }, OWNER)),
        CHILD_URL,
      ],
      // Child operating on the owner's root repository: the owner's URL.
      [
        register(
          group('remote-url-c2', { workspacePath: '/workspace' }, OWNER),
        ),
        URL,
      ],
      // Child at a distinct sub-repository root without a URL: none.
      [register(group('remote-url-c3', {}, OWNER)), undefined],
    ];
    const groups = cases.map(([g]) => g);
    const expected = cases.map(([, url]) => url);

    const merges: Array<Record<string, unknown>> = [];
    const previousBranch = sandboxClient.sandboxBranch;
    sandboxClient.sandboxBranch = async (
      _stack: string,
      _action: string,
      options: Record<string, unknown>,
    ) => {
      merges.push(options);
      return { stdout: JSON.stringify({ merged: true }), isError: false };
    };
    try {
      for (const g of groups) {
        const task = await createTask(
          taskFixture({ project_id: g.folder, branch_name: `b-${g.folder}` }),
        );
        await mergeTaskBranchToDefault((await getTask(task.id))!, g);
      }
    } finally {
      sandboxClient.sandboxBranch = previousBranch;
    }
    expect(merges.map((m) => m.remoteUrl)).toEqual(expected);

    // The recovery path of a failed checkpoint re-adds the managed worktree.
    const adds: Array<Record<string, unknown>> = [];
    for (const g of groups) {
      let attempts = 0;
      const created = await createTask(
        taskFixture({ project_id: g.folder, branch_name: `c-${g.folder}` }),
      );
      await commitTaskBranch((await getTask(created.id))!, g, {
        sandboxClient: {
          sandboxBranch: async () =>
            ++attempts === 1
              ? { stdout: 'missing worktree', isError: true }
              : { stdout: 'no changes', isError: false },
          sandboxWorktree: async (_stack, _action, options) => {
            adds.push(options ?? {});
            return { stdout: 'worktree_path=/w', isError: false };
          },
        },
        runGit: async () => ({ ok: false, output: '' }),
        persistTask: async () => undefined,
      });
    }
    expect(adds.map((a) => a.remoteUrl)).toEqual(expected);

    const task = await createTask(
      taskFixture({ project_id: groups[0].folder, branch_name: 'b-remove' }),
    );
    await removeWorktreeForTask((await getTask(task.id))!, groups[0]);
    expect(sandboxWorktreeCalls.at(-1)?.args.remoteUrl).toBe(URL);
  });
});

describe('removeWorktreeForTask (await contract, isolated child process)', () => {
  test('does not resolve until the worktree_path write settles', async () => {
    const script = `
      import { mock } from 'bun:test';
      const root = process.cwd();
      const realDb = await import(root + '/src/db.ts');
      let markWriteStarted;
      const writeStarted = new Promise((r) => (markWriteStarted = r));
      let releaseGate;
      const gate = new Promise((r) => (releaseGate = r));
      const sequence = [];
      mock.module(root + '/src/db.ts', () => ({
        ...realDb,
        transitionConversationsFromRemovedWorktree: async (_projectId, _branch, remove) => ({
          result: await remove(),
          affectedConversationIds: [],
        }),
        updateTask: async (id, fields) => {
          sequence.push('updateTask:' + JSON.stringify(fields));
          markWriteStarted();
          await gate;
          return { id };
        },
      }));
      const gitOps = await import(root + '/src/lib/git-ops.ts');
      const { getSandboxClient } = await import(
        root + '/src/lib/mcp-client.ts'
      );
      const client = getSandboxClient();
      client.callToolWithReconnect = async (name, args) => {
        sequence.push('sandbox:' + name + ':' + JSON.stringify(args));
        return { content: [{ type: 'text', text: '{}' }] };
      };
      const task = { id: 'task-discriminator', branch_name: 'disc-branch' };
      const group = { folder: 'disc-proj', settings: {} };
      const pending = gitOps.removeWorktreeForTask(task, group, { leaseAlreadyHeld: true });
      await writeStarted;
      const settled = await Promise.race([
        pending.then(() => 'resolved', () => 'rejected'),
        // Observe pending promise settlement after the current microtask queue.
        new Promise((r) => setImmediate(() => r('pending'))),
      ]);
      releaseGate();
      await pending;
      console.log('RESULT ' + JSON.stringify({ settled, sequence }));
    `;
    const child = Bun.spawn(['bun', '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, LOG_LEVEL: 'silent' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          child.kill();
          reject(new Error('discriminator child timed out'));
        }, 15000),
      ),
    ]);
    expect(exitCode, stderr).toBe(0);
    const line = stdout.trim().split('\n').pop() ?? '';
    const result = JSON.parse(
      line.startsWith('RESULT ') ? line.slice('RESULT '.length) : line,
    ) as { settled: string; sequence: string[] };

    // While the gate is held the function must still be pending: an
    // un-awaited updateTask would let it resolve right after
    // sandboxWorktree returns.
    expect(result.settled).toBe('pending');

    // And the ordering is sandbox first, then the DB write.
    expect(result.sequence).toHaveLength(2);
    const [sandboxEntry, updateEntry] = result.sequence;
    expect(sandboxEntry.startsWith('sandbox:sandbox_worktree:')).toBe(true);
    expect(
      JSON.parse(sandboxEntry.slice('sandbox:sandbox_worktree:'.length)),
    ).toMatchObject({ branch: 'disc-branch' });
    expect(updateEntry).toBe('updateTask:{"worktree_path":null}');
  });
});
