import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createConversation,
  getConversation,
  getConversations,
  initDatabase,
  insertActiveRun,
} from '../../db.js';
import { getGroupDir, readChatTranscript } from '../../group-dir.js';
import {
  applyGroupUpdateInMemory,
  registeredGroups,
} from '../../state-manager.js';
import { runFixture, truncateTestDb } from '../../test-helpers.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { resolveGroupSandbox } from '../fs/sandbox-fs.js';
import { refreshAgentView } from './executor.js';
import { removeNoFollow } from './safe-fs.js';
import { resolveTarget, withContainer } from './targets.js';
import type { McpServerDeps } from '../../mcp/auth.js';
import { ProposalValidationError, validateAction } from './actions.js';
import {
  claimProposal,
  getProposal,
  hasAppliedMergeApproval,
} from './db-proposals.js';
import { requestMergeApproval } from './merge-approval.js';
import type { MergeDecisionDependencies } from './merge-approval-decision.js';
import {
  attemptParkedMerge,
  type MergeRetryDependencies,
} from '../kanban/task/merge-retry.js';
import type { RegisteredGroup } from '../../types.js';
import type { Task, TaskMessage } from '../kanban/types.js';
import { findMergePending } from '../kanban/tools.js';
import {
  decideProposal,
  presentProposal,
  ProposalAlreadyDecidedError,
  reconcileInterruptedProposals,
} from './service.js';
import { proposeChangesTool } from './tools.js';

const FOLDER = 'proposals-test-project';
const RULE = `---\ndescription: Original\n---\nOriginal body\n`;
const NEW_RULE = `---\ndescription: Updated\n---\nUpdated body\n`;

const rulesDir = () => path.join(getGroupDir(FOLDER), '.agent', 'rules');

const proposeKind = (kind: 'skill' | 'rule', name: string, approve: unknown) =>
  propose(name, approve, undefined, kind);

async function propose(
  name: string,
  approve: unknown,
  deny?: unknown,
  kind: 'skill' | 'rule' = 'rule',
): Promise<{ conversation_id: string; id: string }> {
  const result = await proposeChangesTool.handler(
    {
      title: 'Tidy rules',
      proposals: [
        {
          rationale: 'Because',
          kind,
          name,
          target_layer: 'project',
          approve_action: approve,
          deny_action: deny,
        },
      ],
    },
    {} as McpServerDeps,
    { group_folder: FOLDER, run_id: 'run-1' },
  );
  return {
    conversation_id: result.conversation_id,
    id: result.proposal_ids[0],
  };
}

const writeRule = (name: string, content: string) => ({
  type: 'write_item',
  files: [{ path: `${name}.md`, content }],
});

beforeAll(async () => {
  await initDatabase(':memory:');
  await truncateTestDb();
  registeredGroups['ui-proposals'] = {
    name: FOLDER,
    folder: FOLDER,
    trigger: '@bot',
    added_at: new Date().toISOString(),
  };
  applyGroupUpdateInMemory('ui-proposals', {});
  fs.mkdirSync(rulesDir(), { recursive: true });
});

afterAll(() => {
  fs.rmSync(getGroupDir(FOLDER), { recursive: true, force: true });
});

describe('propose_changes', () => {
  test('creates a pending conversation with one fence per proposal', async () => {
    fs.writeFileSync(path.join(rulesDir(), 'created.md'), RULE);
    const { conversation_id, id } = await propose(
      'created',
      writeRule('created', NEW_RULE),
    );

    const conversation = await getConversation(conversation_id);
    expect(conversation?.group_folder).toBe(FOLDER);
    expect(conversation?.lastAssistantOutcome).toBe('pending');
    const content = readChatTranscript(FOLDER, conversation_id)
      .filter((e: any) => e.type === 'message')
      .map((e: any) => e.content)
      .join('');
    expect(content).toContain('```carapaproposal\n{"id":"' + id + '"}\n```');
    expect((await getProposal(id))?.created_by_run).toBe('run-1');
  });

  test('rejects unsafe paths and a platform proposal that is not a write_item', async () => {
    const item = { kind: 'skill', name: 'demo' } as const;
    expect(() =>
      validateAction(
        {
          type: 'write_item',
          files: [
            { path: 'SKILL.md', content: '---\n---\n' },
            { path: 'scripts/__init__.py', content: '' },
            { path: '_private/x.md', content: 'x' },
          ],
        },
        item,
      ),
    ).not.toThrow();
    for (const bad of [
      '../x.md',
      '/etc/passwd',
      'a/../../b',
      '.hidden/x',
      'scripts/.hidden',
      'a//b',
    ]) {
      expect(() =>
        validateAction(
          {
            type: 'write_item',
            files: [
              { path: 'SKILL.md', content: '---\n---\n' },
              { path: bad, content: 'x' },
            ],
          },
          item,
        ),
      ).toThrow(ProposalValidationError);
    }
    await expect(
      proposeChangesTool.handler(
        {
          title: 'x',
          proposals: [
            {
              rationale: 'r',
              kind: 'rule',
              name: 'a',
              target_layer: 'platform',
              approve_action: { type: 'none' },
            },
          ],
        },
        {} as McpServerDeps,
        { group_folder: FOLDER },
      ),
    ).rejects.toThrow('must approve with write_item');
  });
});

describe('propose_changes placement', () => {
  const cardsFor = (conversationId: string) =>
    readChatTranscript(FOLDER, conversationId)
      .filter((e: any) => e.type === 'message')
      .map((e: any) => e.content)
      .join('');

  async function proposeFrom(
    context: {
      conversation_id?: string;
      task_id?: string;
      run_id?: string;
      trigger_source?: 'user' | 'schedule';
    },
    name: string,
  ) {
    const result = await proposeChangesTool.handler(
      {
        title: 'Placement',
        proposals: [
          {
            rationale: 'Because',
            kind: 'rule',
            name,
            target_layer: 'project',
            approve_action: writeRule(name, NEW_RULE),
          },
        ],
      },
      {} as McpServerDeps,
      { group_folder: FOLDER, ...context },
    );
    return result as { conversation_id: string; proposal_ids: string[] };
  }

  test('a user-started chat turn gets the cards in its own conversation', async () => {
    fs.writeFileSync(path.join(rulesDir(), 'inline.md'), RULE);
    const chat = await createConversation(FOLDER, { triggerSource: 'user' });
    const before = (await getConversations(FOLDER, 1000)).length;
    await insertActiveRun(
      runFixture({
        id: 'run-interactive',
        group_folder: FOLDER,
        conversation_id: chat.id,
        triggerSource: 'user',
      }),
    );

    const result = await proposeFrom(
      { conversation_id: chat.id, run_id: 'run-interactive' },
      'inline',
    );

    expect(result.conversation_id).toBe(chat.id);
    expect((await getConversations(FOLDER, 1000)).length).toBe(before);
    expect(cardsFor(chat.id)).toContain(result.proposal_ids[0]);
    expect((await getProposal(result.proposal_ids[0]))?.conversation_id).toBe(
      chat.id,
    );
    expect((await getConversation(chat.id))?.lastAssistantOutcome).not.toBe(
      'pending',
    );
  });

  test('a DirectLLM turn without a run record is placed by its trigger source', async () => {
    fs.writeFileSync(path.join(rulesDir(), 'direct.md'), RULE);
    const chat = await createConversation(FOLDER, { triggerSource: 'user' });

    const inline = await proposeFrom(
      { conversation_id: chat.id, trigger_source: 'user' },
      'direct',
    );
    const scheduled = await proposeFrom(
      { conversation_id: chat.id, trigger_source: 'schedule' },
      'direct',
    );

    expect(inline.conversation_id).toBe(chat.id);
    expect(scheduled.conversation_id).not.toBe(chat.id);
  });

  test('background and foreign-conversation runs get a new pending conversation', async () => {
    fs.writeFileSync(path.join(rulesDir(), 'background.md'), RULE);
    const chat = await createConversation(FOLDER, { triggerSource: 'user' });
    await insertActiveRun(
      runFixture({
        id: 'run-schedule',
        group_folder: FOLDER,
        conversation_id: chat.id,
        triggerSource: 'schedule',
      }),
    );
    await insertActiveRun(
      runFixture({
        id: 'run-foreign',
        group_folder: FOLDER,
        conversation_id: chat.id,
        triggerSource: 'user',
      }),
    );
    const other = await createConversation(FOLDER, { triggerSource: 'user' });

    const scheduled = await proposeFrom(
      { conversation_id: chat.id, run_id: 'run-schedule' },
      'background',
    );
    // The run belongs to `chat`, so a different conversation_id never matches.
    const foreign = await proposeFrom(
      { conversation_id: other.id, run_id: 'run-foreign' },
      'background',
    );

    for (const result of [scheduled, foreign]) {
      expect([chat.id, other.id]).not.toContain(result.conversation_id);
      expect(
        (await getConversation(result.conversation_id))?.lastAssistantOutcome,
      ).toBe('pending');
    }
    expect(cardsFor(chat.id)).not.toContain(scheduled.proposal_ids[0]);
  });
});

describe('deciding a proposal', () => {
  test('two concurrent approvals apply exactly once', async () => {
    fs.writeFileSync(path.join(rulesDir(), 'race.md'), RULE);
    const { id } = await propose('race', writeRule('race', NEW_RULE));
    const row = (await getProposal(id))!;

    const outcomes = await Promise.allSettled([
      decideProposal(row, 'approve', 'alice'),
      decideProposal(row, 'approve', 'bob'),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    expect(rejected?.reason).toBeInstanceOf(ProposalAlreadyDecidedError);
    expect(fs.readFileSync(path.join(rulesDir(), 'race.md'), 'utf8')).toBe(
      NEW_RULE,
    );
    const after = (await getProposal(id))!;
    expect(after.status).toBe('applied');
    expect(['alice', 'bob']).toContain(after.decided_by!);
  });

  test('a changed target marks the proposal stale and writes nothing', async () => {
    const file = path.join(rulesDir(), 'stale.md');
    fs.writeFileSync(file, RULE);
    const { id, conversation_id } = await propose(
      'stale',
      writeRule('stale', NEW_RULE),
    );
    fs.writeFileSync(file, `${RULE}Edited meanwhile\n`);

    const decided = await decideProposal(
      (await getProposal(id))!,
      'approve',
      'alice',
    );

    expect(decided.status).toBe('stale');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${RULE}Edited meanwhile\n`);
    // The only proposal is decided, so the conversation leaves "Needs you".
    expect((await getConversation(conversation_id))?.lastAssistantOutcome).toBe(
      'success',
    );
  });

  test('a symlinked entry is replaced, never written through', async () => {
    const shared = path.join(getGroupDir(FOLDER), 'shared-template.md');
    fs.writeFileSync(shared, RULE);
    const link = path.join(rulesDir(), 'linked.md');
    fs.symlinkSync(shared, link);
    const { id } = await propose('linked', writeRule('linked', NEW_RULE));

    const decided = await decideProposal(
      (await getProposal(id))!,
      'approve',
      'alice',
    );

    expect(decided.status).toBe('applied');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, 'utf8')).toBe(NEW_RULE);
    expect(fs.readFileSync(shared, 'utf8')).toBe(RULE);
  });

  test('a link leaving the project is never read into a preview', async () => {
    const secret = path.join(os.tmpdir(), `proposal-secret-${process.pid}`);
    fs.writeFileSync(secret, 'TOP-SECRET');
    const entry = path.join(rulesDir(), 'leak.md');
    try {
      fs.writeFileSync(entry, RULE);
      const { id } = await propose('leak', writeRule('leak', NEW_RULE));
      // The agent turns the entry into a link out of the project afterwards.
      fs.rmSync(entry);
      fs.symlinkSync(secret, entry);

      const view = await presentProposal((await getProposal(id))!);
      expect(JSON.stringify(view)).not.toContain('TOP-SECRET');
      expect(view.approve.contentHidden).toBe(true);
      expect(view.approve.problem).toContain('cannot be applied here');
      // An unverifiable entry is blocked, not treated as empty.
      const decided = await decideProposal(
        (await getProposal(id))!,
        'approve',
        'alice',
      );
      expect(['failed', 'stale']).toContain(decided.status);
      expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  test('a target too large to snapshot in full is refused, not hashed partially', async () => {
    const skill = path.join(getGroupDir(FOLDER), '.agent', 'skills', 'big');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: big\n---\n');
    fs.writeFileSync(path.join(skill, 'asset.bin'), Buffer.alloc(300 * 1024));

    await expect(
      proposeKind('skill', 'big', { type: 'delete_item' }),
    ).rejects.toThrow('too large or complex');
    expect(fs.existsSync(path.join(skill, 'asset.bin'))).toBe(true);
  });

  test('a skill with nested files is written through verified directories', async () => {
    const { id } = await proposeKind('skill', 'nested', {
      type: 'write_item',
      files: [
        { path: 'SKILL.md', content: '---\nname: nested\n---\n' },
        { path: 'scripts/deep/example.sh', content: 'echo hi\n' },
      ],
    });
    // A new item triggers an agent-view refresh; no sandbox runs in this test.
    const client = getSandboxClient();
    const ps = spyOn(client, 'sandboxPs').mockResolvedValue({
      isError: true,
      stdout: '',
    });
    const status = spyOn(client, 'sandboxStatus').mockResolvedValue({
      isError: false,
      stdout: 'not running',
    });
    let decided;
    try {
      decided = await decideProposal(
        (await getProposal(id))!,
        'approve',
        'alice',
      );
    } finally {
      ps.mockRestore();
      status.mockRestore();
    }
    expect(decided.status).toBe('applied');
    expect(
      fs.readFileSync(
        path.join(
          getGroupDir(FOLDER),
          '.agent/skills/nested/scripts/deep/example.sh',
        ),
        'utf8',
      ),
    ).toBe('echo hi\n');
  });

  test('a link into a trusted template root is diffed and goes stale when the template changes', async () => {
    const templates = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-tpl-'));
    process.env.PROPOSAL_TEMPLATE_ROOTS = templates;
    try {
      const template = path.join(templates, 'shared.md');
      fs.writeFileSync(template, RULE);
      fs.symlinkSync(template, path.join(rulesDir(), 'shared.md'));
      const { id } = await propose('shared', writeRule('shared', NEW_RULE));

      const view = await presentProposal((await getProposal(id))!);
      expect(view.approve.problem).toBeNull();
      expect(view.approve.files[0].diff).toContain('-Original body');
      expect(view.approve.files[0].diff).toContain('+Updated body');

      fs.writeFileSync(template, `${RULE}Changed upstream\n`);
      const decided = await decideProposal(
        (await getProposal(id))!,
        'approve',
        'alice',
      );
      expect(decided.status).toBe('stale');
      expect(
        fs.lstatSync(path.join(rulesDir(), 'shared.md')).isSymbolicLink(),
      ).toBe(true);
    } finally {
      delete process.env.PROPOSAL_TEMPLATE_ROOTS;
      fs.rmSync(templates, { recursive: true, force: true });
    }
  });

  test('a second proposal for the same item becomes stale after the first applies', async () => {
    fs.writeFileSync(path.join(rulesDir(), 'same.md'), RULE);
    const first = await propose('same', writeRule('same', NEW_RULE));
    const second = await propose(
      'same',
      writeRule('same', NEW_RULE.replace('Updated', 'Other')),
    );

    const decided = await Promise.all([
      decideProposal((await getProposal(first.id))!, 'approve', 'alice'),
      decideProposal((await getProposal(second.id))!, 'approve', 'alice'),
    ]);

    expect(decided.map((d) => d.status).sort()).toEqual(['applied', 'stale']);
  });

  test('a proposal interrupted while applying is closed without replay', async () => {
    const file = path.join(rulesDir(), 'crash.md');
    fs.writeFileSync(file, RULE);
    const { id } = await propose('crash', writeRule('crash', NEW_RULE));
    await claimProposal(id, 'alice');

    expect(await reconcileInterruptedProposals()).toBeGreaterThanOrEqual(1);

    const after = (await getProposal(id))!;
    expect(after.status).toBe('failed');
    expect(after.result).toContain('not replayed');
    expect(fs.readFileSync(file, 'utf8')).toBe(RULE);
  });

  test('a directory swapped for a link after creation is not read', async () => {
    const foreign = path.join(os.tmpdir(), `proposal-foreign-${process.pid}`);
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'swap.md'), 'FOREIGN-CONTENT');
    fs.writeFileSync(path.join(rulesDir(), 'swap.md'), RULE);
    const { id } = await propose('swap', writeRule('swap', NEW_RULE));
    const real = `${rulesDir()}-real`;
    fs.renameSync(rulesDir(), real);
    fs.symlinkSync(foreign, rulesDir());
    try {
      const view = await presentProposal((await getProposal(id))!);
      expect(JSON.stringify(view)).not.toContain('FOREIGN-CONTENT');
      expect(view.approve.problem).toContain('not a plain directory');
      const decided = await decideProposal(
        (await getProposal(id))!,
        'approve',
        'alice',
      );
      expect(decided.status).toBe('failed');
      expect(fs.readFileSync(path.join(foreign, 'swap.md'), 'utf8')).toBe(
        'FOREIGN-CONTENT',
      );
    } finally {
      fs.rmSync(rulesDir());
      fs.renameSync(real, rulesDir());
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });

  test('a symlinked rules directory is refused', async () => {
    const outside = path.join(getGroupDir(FOLDER), 'outside-rules');
    const real = `${rulesDir()}-real`;
    fs.mkdirSync(outside, { recursive: true });
    fs.renameSync(rulesDir(), real);
    fs.symlinkSync(outside, rulesDir());
    try {
      await expect(
        propose('evil', writeRule('evil', NEW_RULE)),
      ).rejects.toThrow('not a plain directory');
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(rulesDir());
      fs.renameSync(real, rulesDir());
    }
  });
});

describe('descriptor-anchored access', () => {
  test('an operation keeps using the verified directory after it is swapped for a link', async () => {
    const foreign = path.join(os.tmpdir(), `proposal-race-${process.pid}`);
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'victim.md'), 'FOREIGN');
    fs.writeFileSync(path.join(rulesDir(), 'victim.md'), RULE);
    const target = resolveTarget({
      project_id: FOLDER,
      objective_id: null,
      kind: 'rule',
      name: 'victim',
      target_layer: 'project',
    });
    const aside = `${rulesDir()}-aside`;
    try {
      await withContainer(target, false, async (dir) => {
        // The agent swaps .agent/rules for a link after the directory was checked.
        fs.renameSync(rulesDir(), aside);
        fs.symlinkSync(foreign, rulesDir());
        await removeNoFollow(dir!, 'victim.md');
      });
      expect(fs.readFileSync(path.join(foreign, 'victim.md'), 'utf8')).toBe(
        'FOREIGN',
      );
      expect(fs.existsSync(path.join(aside, 'victim.md'))).toBe(false);
    } finally {
      fs.rmSync(rulesDir(), { force: true });
      if (fs.existsSync(aside)) fs.renameSync(aside, rulesDir());
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });
});

describe('agent view refresh', () => {
  test('refreshes a stack running the instance under an override', async () => {
    const { instance, service } = resolveGroupSandbox(FOLDER);
    const client = getSandboxClient();
    const ps = spyOn(client, 'sandboxPs').mockResolvedValue({
      isError: false,
      stdout: JSON.stringify([
        {
          name: 'override-stack',
          instance,
          services: [{ service, hostname: 'h', status: 'running', ports: [] }],
        },
      ]),
    });
    const status = spyOn(client, 'sandboxStatus').mockResolvedValue({
      isError: false,
      stdout: 'not running',
    });
    const exec = spyOn(client, 'sandboxExec').mockResolvedValue({
      isError: false,
      stdout: '',
    });
    try {
      const message = await refreshAgentView(FOLDER);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0].slice(0, 3)).toEqual([
        'override-stack',
        service,
        'carapa-agent-view refresh',
      ]);
      expect(message).toContain('override-stack: refreshed');
    } finally {
      ps.mockRestore();
      status.mockRestore();
      exec.mockRestore();
    }
  });
});

describe('merge approvals', () => {
  const HEAD = 'a'.repeat(40);
  const MOVED = 'b'.repeat(40);
  const findings = [
    { ruleId: 'db-migration', file: 'drizzle/1.sql', reason: 'Schema' },
  ];
  const mergeTask = (id: string): Task =>
    ({
      id,
      title: `Task ${id}`,
      project_id: FOLDER,
      objective_id: null,
      branch_name: `branch-${id}`,
      status: 'backlog',
      merge_commit: null,
      archived: false,
    }) as Task;

  function mergeDeps(
    task: Task | undefined,
    branchHead: string | null,
    mergeResult: Record<string, unknown> = { mergeOk: true, output: '' },
  ) {
    const notices: string[] = [];
    const merged: Array<{ approved: boolean }> = [];
    const retry = {
      getRuns: async () => [],
      stillParked: async () => true,
      appendNotice: (_task: Task, content: string) => notices.push(content),
      mergeTaskBranchWithResolution: mock(async (t: Task) => {
        merged.push({ approved: await hasAppliedMergeApproval(t.id, HEAD) });
        return mergeResult;
      }),
      completeApprovedMerge: mock(async () => true),
      logger: { debug() {}, info() {}, warn() {} },
    } as unknown as MergeRetryDependencies;
    const deps: MergeDecisionDependencies = {
      getTask: async () => task,
      getGroup: () => ({ folder: FOLDER }) as RegisteredGroup,
      readBranchHead: async () => branchHead,
      classifyMergeRisk: async () => ({
        gated: true,
        headSha: MOVED,
        findings,
      }),
      retry: async () => ({ deps: retry, attemptParkedMerge }),
    };
    return { deps, retry, notices, merged };
  }

  test('creates one pending approval per head sha, reused on every re-park', async () => {
    const task = mergeTask('t-once');
    const first = await requestMergeApproval(task, HEAD, findings, {
      resume: true,
    });
    const again = await requestMergeApproval(task, HEAD, findings, {
      resume: true,
    });
    const other = await requestMergeApproval(task, MOVED, findings, {
      resume: true,
    });

    expect(first.created).toBe(true);
    expect(again).toMatchObject({
      created: false,
      proposalId: first.proposalId,
      conversationId: first.conversationId,
    });
    expect(other.proposalId).not.toBe(first.proposalId);
    const row = (await getProposal(first.proposalId))!;
    expect(row).toMatchObject({
      kind: 'merge',
      name: 't-once',
      base_hash: HEAD,
      status: 'pending',
    });
    expect(row.rationale).toContain('drizzle/1.sql');
    expect(
      (await getConversation(first.conversationId))?.lastAssistantOutcome,
    ).toBe('pending');
    expect((await presentProposal(row)).merge).toMatchObject({
      taskId: 't-once',
      headSha: HEAD,
      findings,
    });
  });

  test('approving merges a review-parked card only after the approval is recorded', async () => {
    const task = mergeTask('t-approve');
    const { proposalId } = await requestMergeApproval(task, HEAD, findings, {
      resume: true,
    });
    const { deps, retry, merged } = mergeDeps(task, HEAD);

    const decided = await decideProposal(
      (await getProposal(proposalId))!,
      'approve',
      'alice',
      deps,
    );

    expect(decided.status).toBe('applied');
    expect(decided.decided_by).toBe('alice');
    expect(merged).toEqual([{ approved: true }]);
    expect(retry.completeApprovedMerge).toHaveBeenCalledTimes(1);
    expect(decided.result).toBe('Approved and merged.');
  });

  test('a moved branch goes stale, merges nothing and requests a new approval', async () => {
    const task = mergeTask('t-stale');
    const { proposalId } = await requestMergeApproval(task, HEAD, findings, {
      resume: true,
    });
    const { deps, retry, notices } = mergeDeps(task, MOVED);

    const decided = await decideProposal(
      (await getProposal(proposalId))!,
      'approve',
      'alice',
      deps,
    );

    expect(decided.status).toBe('stale');
    expect(decided.result).toBe(
      'The branch changed after this was requested. A new approval was requested.',
    );
    expect(await hasAppliedMergeApproval(task.id, HEAD)).toBe(false);
    expect(retry.mergeTaskBranchWithResolution).not.toHaveBeenCalled();
    const fresh = await requestMergeApproval(task, MOVED, findings, {
      resume: true,
    });
    expect(fresh.created).toBe(false);
    expect(notices.join('\n')).toContain('conversationId=');
  });

  test('a completion-parked approval is recorded without merging', async () => {
    const task = mergeTask('t-record');
    const { proposalId } = await requestMergeApproval(task, HEAD, findings, {
      resume: false,
    });
    const { deps, retry } = mergeDeps(task, HEAD);

    const decided = await decideProposal(
      (await getProposal(proposalId))!,
      'approve',
      'alice',
      deps,
    );

    expect(decided.status).toBe('applied');
    expect(await hasAppliedMergeApproval(task.id, HEAD)).toBe(true);
    expect(retry.mergeTaskBranchWithResolution).not.toHaveBeenCalled();
  });

  test('deny keeps the card parked and a missing task fails the row', async () => {
    const task = mergeTask('t-deny');
    const { proposalId } = await requestMergeApproval(task, HEAD, findings, {
      resume: true,
    });
    const denied = mergeDeps(task, HEAD);
    const decided = await decideProposal(
      (await getProposal(proposalId))!,
      'deny',
      'bob',
      denied.deps,
    );
    expect(decided).toMatchObject({ status: 'denied', decided_by: 'bob' });
    expect(denied.notices[0]).toContain('**Merge denied by bob**');
    expect(await hasAppliedMergeApproval(task.id, HEAD)).toBe(false);
    expect(denied.retry.mergeTaskBranchWithResolution).not.toHaveBeenCalled();

    const gone = mergeTask('t-gone');
    const request = await requestMergeApproval(gone, HEAD, findings, {
      resume: true,
    });
    const failed = await decideProposal(
      (await getProposal(request.proposalId))!,
      'approve',
      'alice',
      mergeDeps(undefined, HEAD).deps,
    );
    expect(failed).toMatchObject({
      status: 'failed',
      result: 'Task no longer exists',
    });

    // Denying is no different: a deleted or archived task is not "denied".
    for (const missing of [undefined, { ...gone, archived: true } as Task]) {
      const again = await requestMergeApproval(
        { ...gone, id: `t-gone-${missing ? 'archived' : 'deleted'}` },
        HEAD,
        findings,
        { resume: true },
      );
      const gonedeps = mergeDeps(missing, HEAD);
      const denial = await decideProposal(
        (await getProposal(again.proposalId))!,
        'deny',
        'bob',
        gonedeps.deps,
      );
      expect(denial).toMatchObject({
        status: 'failed',
        result: 'Task no longer exists',
      });
      expect(gonedeps.notices).toEqual([]);
    }
  });

  test('an environment failure after approval restores the retryable merge-pending state', async () => {
    const task = mergeTask('t-env');
    const { proposalId } = await requestMergeApproval(task, HEAD, findings, {
      resume: true,
    });
    // The card was parked by the approval-required notice.
    const messages = [
      {
        entry_type: 'system_notice',
        content: '**Review approved, human approval required** — held',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ] as TaskMessage[];
    const { deps, notices } = mergeDeps(task, HEAD, {
      mergeOk: false,
      failureKind: 'environment',
      output: '[env] dirty checkout',
    });
    expect(findMergePending(task, messages, [])).toBeNull();

    const decided = await decideProposal(
      (await getProposal(proposalId))!,
      'approve',
      'alice',
      deps,
    );

    expect(decided.status).toBe('applied');
    expect(await hasAppliedMergeApproval(task.id, HEAD)).toBe(true);
    messages.push(
      ...notices.map(
        (content, index) =>
          ({
            entry_type: 'system_notice',
            content,
            created_at: `2026-01-01T00:00:0${index + 1}.000Z`,
          }) as TaskMessage,
      ),
    );
    expect(
      findMergePending(task, messages, [])?.reason.startsWith(
        '**Review approved, merge pending**',
      ),
    ).toBe(true);
  });

  test('a restart leaves an applying merge approval failed, never merged', async () => {
    const task = mergeTask('t-restart');
    const { proposalId } = await requestMergeApproval(task, HEAD, findings, {
      resume: true,
    });
    await claimProposal(proposalId, 'alice');

    await reconcileInterruptedProposals();

    const row = (await getProposal(proposalId))!;
    expect(row.status).toBe('failed');
    expect(row.result).toContain('not resumed');
  });

  test('agents cannot create a merge approval through propose_changes', async () => {
    await expect(
      proposeChangesTool.handler(
        {
          title: 'x',
          proposals: [
            {
              rationale: 'r',
              kind: 'merge',
              name: 't-agent',
              target_layer: 'project',
              approve_action: { type: 'merge_task' },
            },
          ],
        },
        {} as McpServerDeps,
        { group_folder: FOLDER },
      ),
    ).rejects.toThrow('cannot be proposed');
    expect(() =>
      validateAction({ type: 'merge_task' }, { kind: 'rule', name: 'a' }),
    ).toThrow(ProposalValidationError);
    expect(() =>
      validateAction(
        { type: 'delete_item' },
        { kind: 'merge', name: 't-agent' },
      ),
    ).toThrow(ProposalValidationError);
  });
});
