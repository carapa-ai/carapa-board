import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classifyMergeRisk } from '../../src/modules/kanban/task/merge-risk-gate.js';
import {
  boxStubToolResponse,
  fixtureMetadataCommand,
} from './box-stub-response.js';
import {
  runFixtureGit,
  seedCleanAbRepository,
  seedGitRepository,
} from './git-fixture.js';

describe('UI sandbox A/B checkout fixtures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-ab-fixture-'));
  const cleanRepo = path.join(root, 'repositories', 'ui-ab');
  const dirtyRepo = path.join(root, 'repositories', 'ui-running');
  const savedEnv = {
    UI_SANDBOX_AB_GIT_REPO: process.env.UI_SANDBOX_AB_GIT_REPO,
    UI_SANDBOX_GIT_REPO: process.env.UI_SANDBOX_GIT_REPO,
  };

  beforeAll(() => {
    seedCleanAbRepository(cleanRepo);
    seedGitRepository(dirtyRepo);
    process.env.UI_SANDBOX_AB_GIT_REPO = cleanRepo;
    process.env.UI_SANDBOX_GIT_REPO = dirtyRepo;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('ui-ab seeds a clean default checkout; the shared fixture stays dirty', () => {
    const status = (repo: string) =>
      runFixtureGit(repo, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]);
    expect(status(cleanRepo)).toBe('');
    expect(status(dirtyRepo)).toContain('checkout blocker.txt');
    for (const repo of [cleanRepo, dirtyRepo]) {
      expect(
        runFixtureGit(repo, ['branch', '--list', 'ui-ab-variant-*']),
      ).toMatch(/ui-ab-variant-a[\s\S]*ui-ab-variant-b/);
    }
  });

  test('"Merge this variant" merges on ui-ab and is rejected on ui-ab-dirty', async () => {
    const merge = async (instance: string) =>
      (
        await boxStubToolResponse('sandbox_branch', {
          action: 'merge',
          instance,
          branch: 'ui-ab-variant-a',
        })
      ).json();
    expect(await merge('ui-ab')).toEqual({
      result: JSON.stringify({ merged: true }),
      isError: false,
    });
    expect(await merge('ui-ab-dirty')).toEqual({
      result: '[env] default checkout is dirty',
      isError: true,
    });
  });

  test('the merge risk gate finds no rules on ui-ab and does not gate variant B', async () => {
    const commands: string[] = [];
    const gate = await classifyMergeRisk(
      {
        id: 'ui-ab-child-b',
        project_id: 'ui-ab',
        title: 'Variant B',
        branch_name: 'ui-ab-variant-b',
      } as never,
      {
        name: 'UI A/B',
        folder: 'ui-ab',
        trigger: '!ui-ab',
        added_at: new Date().toISOString(),
        settings: { taskCheckoutMode: 'worktree', defaultBranch: 'develop' },
      },
      {
        isMergeApproved: async () => false,
        runGit: async (_group, command, instance) => {
          commands.push(command);
          const response = await boxStubToolResponse('sandbox_git', {
            instance: instance ?? 'ui-ab',
            command,
          });
          const body = (await response.json()) as {
            result: string;
            isError: boolean;
          };
          return { ok: !body.isError, output: body.result };
        },
      },
    );
    expect(gate).toEqual({ gated: false });
    expect(commands).toEqual([
      "ls-tree --name-only 'develop' -- '.agent/merge-risk.json'",
    ]);
  });

  test('variant worktree Changes-tab commands are allowed for the seeded files', async () => {
    const run = async (command: string) =>
      (await (
        await boxStubToolResponse('sandbox_git', {
          instance: 'ui-ab',
          command,
        })
      ).json()) as { result: string; isError: boolean };
    for (const branch of ['ui-ab-variant-a', 'ui-ab-variant-b']) {
      const prefix = `-C .worktrees/${branch} `;
      const base = (
        await run(`${prefix}merge-base develop ${branch}`)
      ).result.trim();
      const stat = await run(`${prefix}diff --no-color --numstat ${base}`);
      expect(stat.isError).toBe(false);
      const files = stat.result
        .trim()
        .split('\n')
        .map((line) => line.split('\t')[2]);
      const metadata = await run(fixtureMetadataCommand(prefix, files));
      expect(metadata.result).not.toContain('not allowed');
      expect(metadata.isError).toBe(false);
    }
    const merged = await run(
      `diff --no-color --numstat ${'a'.repeat(40)} ${'b'.repeat(40)}`,
    );
    expect(merged.result).not.toContain('not allowed');
  });
});
