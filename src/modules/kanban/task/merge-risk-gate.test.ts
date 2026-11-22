import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../../../db.js';
import { truncateTestDb } from '../../../test-helpers.js';
import type { RegisteredGroup } from '../../../types.js';
import {
  findOpenMergeApproval,
  insertProposals,
} from '../../proposals/db-proposals.js';
import { mergeTaskBranchWithResolution } from './merge-conflict-resolution.js';
import {
  approvalRequiredNotice,
  ensureBranchAtPinnedHead,
  evaluateMergeRisk,
  classifyMergeRisk,
  type MergeRiskDependencies,
} from './merge-risk-gate.js';

const BRANCH = 'task-risk';
let repo = '';

function git(args: string): string {
  const result = spawnSync('sh', ['-c', `git ${args}`], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: repo,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
  return result.stdout.trim();
}

function write(file: string, content: string): void {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Fresh repo: develop holds `rules` (or no file) plus `baseFiles`; checks out a task branch. */
function resetRepo(
  rules: unknown | undefined,
  baseFiles: Record<string, string> = {},
): void {
  for (const entry of fs.readdirSync(repo)) {
    fs.rmSync(path.join(repo, entry), { recursive: true, force: true });
  }
  git('init -q -b develop');
  write('README.md', 'base\n');
  for (const [file, content] of Object.entries(baseFiles)) write(file, content);
  if (rules !== undefined) {
    write(
      '.agent/merge-risk.json',
      typeof rules === 'string' ? rules : JSON.stringify(rules),
    );
  }
  git('add -A');
  git('commit -q -m base');
  git(`checkout -q -b ${BRANCH}`);
}

function commitOnBranch(files: Record<string, string>): string {
  for (const [file, content] of Object.entries(files)) write(file, content);
  git('add -A');
  git('commit -q -m task');
  return git('rev-parse HEAD');
}

const RULES = {
  rules: [
    {
      id: 'db-migration',
      paths: ['drizzle/**'],
      reason: 'Schema change',
    },
    {
      id: 'env-read',
      paths: ['src/**/*.ts'],
      added_line_pattern: 'process\\.env\\.',
      reason: 'New env var',
    },
  ],
};

const group: RegisteredGroup = {
  name: 'Risk',
  folder: 'risk-gate-test',
  trigger: '!risk',
  added_at: new Date().toISOString(),
  settings: { taskCheckoutMode: 'worktree', defaultBranch: 'develop' },
};

const task: any = {
  id: 'task-risk-1',
  project_id: 'risk-gate-test',
  title: 'Risky',
  branch_name: BRANCH,
};

let approvals = new Set<string>();
const deps: MergeRiskDependencies = {
  // Runs in the temp repo through a shell, like the sandbox git tool does.
  runGit: async (_group, args) => {
    const result = spawnSync('sh', ['-c', `git ${args}`], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: result.status === 0, output: result.stdout };
  },
  isMergeApproved: async (taskId, sha) => approvals.has(`${taskId}:${sha}`),
};

beforeAll(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-risk-'));
  await initDatabase(':memory:');
  // Disables FK checks, so the approval conversation needs no project row.
  await truncateTestDb();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const ruleIds = (c: Awaited<ReturnType<typeof classifyMergeRisk>>) =>
  c.gated ? c.findings.map((f) => f.ruleId) : [];

describe('classifyMergeRisk', () => {
  test('is off when the default branch has no rules file, even if the branch adds one', async () => {
    resetRepo(undefined);
    commitOnBranch({
      'drizzle/0001.sql': 'x',
      '.agent/merge-risk.json': JSON.stringify(RULES),
    });
    expect(await classifyMergeRisk(task, group, deps)).toMatchObject({
      gated: false,
    });
  });

  test('is off for a task without a branch or a shared-mode project', async () => {
    resetRepo(RULES);
    commitOnBranch({ 'drizzle/0001.sql': 'x' });
    expect(
      await classifyMergeRisk({ ...task, branch_name: null }, group, deps),
    ).toMatchObject({ gated: false });
    expect(
      await classifyMergeRisk(
        task,
        { ...group, settings: { taskCheckoutMode: 'shared' } },
        deps,
      ),
    ).toMatchObject({ gated: false });
  });

  test('flags a rule-matching path and passes an unrelated one', async () => {
    resetRepo(RULES);
    const head = commitOnBranch({ 'drizzle/0001.sql': 'x', 'docs/a.md': 'y' });
    const result = await classifyMergeRisk(task, group, deps);
    expect(result).toEqual({
      gated: true,
      headSha: head,
      findings: [
        {
          ruleId: 'db-migration',
          file: 'drizzle/0001.sql',
          reason: 'Schema change',
        },
      ],
    });
    resetRepo(RULES);
    commitOnBranch({ 'docs/a.md': 'y' });
    expect(await classifyMergeRisk(task, group, deps)).toMatchObject({
      gated: false,
    });
  });

  test('added_line_pattern matches added lines only', async () => {
    resetRepo({
      rules: [
        {
          id: 'env-read',
          paths: ['src/**/*.ts'],
          added_line_pattern: 'process\\.env\\.',
          reason: 'New env var',
        },
      ],
    });
    commitOnBranch({ 'src/a.ts': 'export const a = 1;\n' });
    expect(await classifyMergeRisk(task, group, deps)).toMatchObject({
      gated: false,
    });
    // The pattern is only in a removed line, so it must not match.
    resetRepo(RULES, { 'src/b.ts': 'const k = process.env.OLD;\n' });
    commitOnBranch({ 'src/b.ts': 'const k = 1;\n' });
    expect(await classifyMergeRisk(task, group, deps)).toMatchObject({
      gated: false,
    });
    commitOnBranch({ 'src/c.ts': 'const k = process.env.NEW_VAR;\n' });
    expect(ruleIds(await classifyMergeRisk(task, group, deps))).toEqual([
      'env-read',
    ]);
  });

  test('rules come from the default branch: weakening them in the task branch still gates and is itself a finding', async () => {
    resetRepo(RULES);
    commitOnBranch({
      '.agent/merge-risk.json': JSON.stringify({ rules: [] }),
      'drizzle/0001.sql': 'x',
    });
    const result = await classifyMergeRisk(task, group, deps);
    expect(ruleIds(result).sort()).toEqual([
      'db-migration',
      'merge-risk-config',
    ]);
  });

  test('deleting the rules file in the task branch is a finding', async () => {
    resetRepo(RULES);
    git('rm -q .agent/merge-risk.json');
    git('commit -q -m drop');
    expect(ruleIds(await classifyMergeRisk(task, group, deps))).toEqual([
      'merge-risk-config',
    ]);
  });

  test('a rename classifies both the old and the new path', async () => {
    resetRepo(RULES, { 'drizzle/0001.sql': 'x' });
    git('mv drizzle/0001.sql docs.sql');
    git('commit -q -m rename');
    const result = await classifyMergeRisk(task, group, deps);
    // Only the old path is in drizzle/**; the new one proves it was listed too.
    expect(result.gated && result.findings.map((f) => f.file)).toEqual([
      'drizzle/0001.sql',
    ]);
  });

  test.each([
    ['invalid JSON', '{not json'],
    [
      'schema violation',
      { rules: [{ id: 'Bad Id', paths: ['x'], reason: 'r' }] },
    ],
    ['no paths', { rules: [{ id: 'a', paths: [], reason: 'r' }] }],
    [
      'invalid regex',
      {
        rules: [
          { id: 'a', paths: ['x'], added_line_pattern: '(', reason: 'r' },
        ],
      },
    ],
  ])('fails closed on %s', async (_label, rules) => {
    resetRepo(rules);
    commitOnBranch({ 'docs/a.md': 'y' });
    expect(ruleIds(await classifyMergeRisk(task, group, deps))).toEqual([
      'merge-risk-invalid-config',
    ]);
  });

  test('fails closed when a git command fails while the rules file exists', async () => {
    resetRepo(RULES);
    commitOnBranch({ 'docs/a.md': 'y' });
    const failingDiff: MergeRiskDependencies = {
      ...deps,
      runGit: async (g, args, instance) =>
        args.startsWith('diff')
          ? { ok: false, output: 'boom' }
          : deps.runGit(g, args, instance),
    };
    expect(ruleIds(await classifyMergeRisk(task, group, failingDiff))).toEqual([
      'merge-risk-error',
    ]);
    const failingHead: MergeRiskDependencies = {
      ...deps,
      runGit: async (g, args, instance) =>
        args.startsWith('rev-parse')
          ? { ok: false, output: '' }
          : deps.runGit(g, args, instance),
    };
    const result = await classifyMergeRisk(task, group, failingHead);
    expect(ruleIds(result)).toEqual(['merge-risk-error']);
    // An unresolved head can never match an approval.
    expect(result.gated && result.headSha).toBe('');
  });

  test('the size limit applies to files no rule matches', async () => {
    resetRepo(RULES);
    commitOnBranch({ 'docs/large.md': `${'x'.repeat(1024 * 1024 + 10)}\n` });
    const result = await classifyMergeRisk(task, group, deps);
    expect(result.gated && result.findings).toEqual([
      expect.objectContaining({
        ruleId: 'merge-risk-too-large',
        file: 'docs/large.md',
      }),
    ]);
  });

  test('a valid default branch name with special characters is not rejected', async () => {
    const plusGroup: RegisteredGroup = {
      ...group,
      settings: { ...group.settings, defaultBranch: 'release+stable' },
    };
    resetRepo(undefined);
    git('branch release+stable');
    commitOnBranch({ 'docs/a.md': 'y' });
    expect(await classifyMergeRisk(task, plusGroup, deps)).toEqual({
      gated: false,
    });

    resetRepo(RULES);
    git('branch release+stable');
    const head = commitOnBranch({ 'drizzle/0001.sql': 'x' });
    const risky = await classifyMergeRisk(task, plusGroup, deps);
    expect(risky.gated && risky.headSha).toBe(head);
    expect(ruleIds(risky)).toEqual(['db-migration']);
  });

  test('oversize diffs and file counts are gated', async () => {
    resetRepo(RULES);
    commitOnBranch({ 'src/big.ts': `${'x'.repeat(1024 * 1024 + 10)}\n` });
    expect(ruleIds(await classifyMergeRisk(task, group, deps))).toEqual([
      'merge-risk-too-large',
    ]);
    resetRepo(RULES);
    const files: Record<string, string> = {};
    for (let i = 0; i < 2001; i++) files[`docs/f${i}.md`] = String(i);
    commitOnBranch(files);
    expect(ruleIds(await classifyMergeRisk(task, group, deps))).toEqual([
      'merge-risk-too-large',
    ]);
  });
});

describe('merge approval', () => {
  test('only an approval for the exact head sha lets the merge proceed', async () => {
    resetRepo(RULES);
    const head = commitOnBranch({ 'drizzle/0001.sql': 'x' });

    approvals = new Set([`${task.id}:${'0'.repeat(40)}`]);
    const { blocked } = await evaluateMergeRisk(task, group, 'review', deps);
    expect(blocked?.failureKind).toBe('approval_required');
    expect(blocked?.mergeOk).toBe(false);
    expect(blocked?.output).toContain(head);
    expect(blocked?.output).toContain('`db-migration`');

    approvals = new Set([`${task.id}:${head}`]);
    expect(await evaluateMergeRisk(task, group, 'review', deps)).toEqual({
      pinnedHead: head,
    });

    // A commit landing after the approval changes the head and re-blocks.
    commitOnBranch({ 'docs/late.md': 'y' });
    expect(
      (await evaluateMergeRisk(task, group, 'review', deps)).blocked
        ?.failureKind,
    ).toBe('approval_required');
  });

  test('a ++ prefixed added line is still an added line', async () => {
    resetRepo(RULES);
    commitOnBranch({
      'src/a.ts':
        'let attempts = 0;\n++attempts; const token = process.env.API_TOKEN;\n',
    });
    expect(ruleIds(await classifyMergeRisk(task, group, deps))).toEqual([
      'env-read',
    ]);
  });

  test('a -diff attribute cannot hide an added line from a pattern rule', async () => {
    resetRepo(RULES);
    commitOnBranch({
      '.gitattributes': 'src/a.ts -diff\n',
      'src/a.ts': 'export const k = process.env.SECRET;\n',
    });
    // Without the raw-text flags git summarizes this file as binary.
    expect(git('diff -U0 HEAD~1 HEAD -- src/a.ts')).toContain('Binary files');
    expect(ruleIds(await classifyMergeRisk(task, group, deps))).toEqual([
      'env-read',
    ]);
  });

  test('an opaque diff for a pattern rule is gated, not treated as no match', async () => {
    resetRepo(RULES);
    commitOnBranch({ 'src/a.ts': 'export const a = 1;\n' });
    const opaque: MergeRiskDependencies = {
      ...deps,
      runGit: async (g, args, instance) =>
        args.startsWith('diff -U0')
          ? {
              ok: true,
              output: 'Binary files a/src/a.ts and b/src/a.ts differ\n',
            }
          : deps.runGit(g, args, instance),
    };
    expect(ruleIds(await classifyMergeRisk(task, group, opaque))).toEqual([
      'merge-risk-error',
    ]);
  });

  test('the pinned head is enforced at merge execution', async () => {
    resetRepo(RULES);
    const head = commitOnBranch({ 'docs/a.md': 'y' });
    expect(await ensureBranchAtPinnedHead(task, group, head, deps)).toBe(
      undefined,
    );
    // No rules apply (no pin): nothing to enforce.
    expect(await ensureBranchAtPinnedHead(task, group, undefined, deps)).toBe(
      undefined,
    );
    commitOnBranch({ 'drizzle/0002.sql': 'z' });
    const moved = await ensureBranchAtPinnedHead(task, group, head, deps);
    expect(moved?.failureKind).toBe('approval_required');
    expect(moved?.output).toContain(head);

    // The refusal carries no findings, so the park notice classifies the
    // current head and requests its own approval.
    const newHead = git('rev-parse HEAD');
    const notice = await approvalRequiredNotice(
      task,
      group,
      moved!,
      { resume: true },
      deps,
    );
    expect(notice).toContain('conversationId=');
    const request = await findOpenMergeApproval(task.id, newHead);
    expect(request).toMatchObject({ kind: 'merge', status: 'pending' });
    expect(notice).toContain(request!.conversation_id);
  });

  test('mergeTaskBranchWithResolution refuses an unapproved risky branch before merging', async () => {
    resetRepo(RULES);
    const head = commitOnBranch({ 'drizzle/0001.sql': 'x' });
    approvals = new Set();
    let merged = 0;
    // Like the real merge: re-check immediately before the sandbox call.
    // `race` simulates a commit landing on the task branch right before it.
    let race: (() => void) | undefined;
    const merge = (riskGate: MergeRiskDependencies) =>
      mergeTaskBranchWithResolution(task, group, 'review', {
        withProjectGitLock: async (_project, fn) => fn(),
        mergeTaskBranchToDefault: async (_task, _group, options) => {
          race?.();
          const aborted = await options?.beforeMerge?.();
          if (aborted) return aborted;
          merged++;
          return { mergeOk: true, output: 'merged' };
        },
        riskGate,
      });
    const refused = await merge(deps);
    expect(refused.failureKind).toBe('approval_required');
    expect(merged).toBe(0);

    approvals = new Set([`${task.id}:${head}`]);
    expect((await merge(deps)).mergeOk).toBe(true);
    expect(merged).toBe(1);

    // A commit landing after classification, before the merge, is not covered
    // by the approval for the earlier head.
    race = () => {
      commitOnBranch({ 'docs/late.md': 'y' });
    };
    const raced = await merge(deps);
    expect(raced.failureKind).toBe('approval_required');
    expect(merged).toBe(1);

    // The same race against a branch that was not risky when classified.
    resetRepo(RULES);
    commitOnBranch({ 'docs/a.md': 'y' });
    race = () => {
      commitOnBranch({ 'drizzle/0003.sql': 'z' });
    };
    expect((await merge(deps)).failureKind).toBe('approval_required');
    expect(merged).toBe(1);
  });
});

describe('hasAppliedMergeApproval', () => {
  test('requires an applied row with a decider for the exact sha', async () => {
    const { hasAppliedMergeApproval } =
      await import('../../proposals/db-proposals.js');
    await truncateTestDb();
    const row = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      project_id: 'risk-gate-test',
      conversation_id: 'conv',
      title: 'Merge',
      rationale: 'r',
      kind: 'merge' as never,
      name: 'task-risk-1',
      target_layer: 'project' as const,
      approve_action: {},
      base_hash: 'a'.repeat(40),
      status: 'applied' as const,
      decided_by: 'user-1',
      created_at: new Date().toISOString(),
      ...overrides,
    });
    await insertProposals([
      row('p-pending', { status: 'pending', base_hash: 'b'.repeat(40) }),
      row('p-undecided', { decided_by: null, base_hash: 'c'.repeat(40) }),
      row('p-applied'),
    ]);
    expect(await hasAppliedMergeApproval('task-risk-1', 'a'.repeat(40))).toBe(
      true,
    );
    for (const sha of ['b', 'c', 'd']) {
      expect(await hasAppliedMergeApproval('task-risk-1', sha.repeat(40))).toBe(
        false,
      );
    }
    expect(await hasAppliedMergeApproval('other-task', 'a'.repeat(40))).toBe(
      false,
    );
    expect(await hasAppliedMergeApproval('task-risk-1', '')).toBe(false);
  });
});
