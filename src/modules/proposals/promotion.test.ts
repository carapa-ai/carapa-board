import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { initDatabase } from '../../db.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { effectiveSandboxIpcDir } from '../../sandbox/effective-settings.js';
import {
  applyGroupUpdateInMemory,
  registeredGroups,
} from '../../state-manager.js';
import { truncateTestDb } from '../../test-helpers.js';
import { resolveGroupSandbox } from '../fs/sandbox-fs.js';
import type { McpServerDeps } from '../../mcp/auth.js';
import { getProposal } from './db-proposals.js';
import {
  applyPromotion,
  hashItem,
  parsePayload,
  PromotionRefusedError,
  StalePromotionError,
} from './promotion-apply.js';
import { promotionTarget, type PromotionPayload } from './promotion-targets.js';
import { decideProposal, presentProposal } from './service.js';
import { proposeChangesTool } from './tools.js';

const BRANCH = 'trunk';

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function makeRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', BRANCH);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const RULE = '---\ndescription: Rule\n---\nBody\n';
const SKILL = '---\nname: demo\ndescription: Demo\n---\nBody\n';

describe('promotion script (temporary git repository)', () => {
  let root: string;
  let repo: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-apply-'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const payload = (
    overrides: Partial<PromotionPayload> = {},
  ): PromotionPayload => ({
    proposalId: 'prop-1',
    title: 'Add demo skill',
    layer: 'platform',
    kind: 'skill',
    name: 'demo',
    repoDir: repo,
    branch: BRANCH,
    baseHash: null,
    files: [
      { path: 'SKILL.md', content: SKILL },
      { path: 'scripts/run.sh', content: 'echo hi\n' },
    ],
    ...overrides,
  });
  const withBase = (p: PromotionPayload) => ({
    ...p,
    baseHash: hashItem(
      path.join(p.repoDir, promotionTarget(p.layer, p.kind, p.name).itemPath),
    ),
  });
  const headOf = () => git(repo, 'rev-parse', 'HEAD');

  test('rejects names and paths the proposal rules reject', () => {
    repo = makeRepo(root, 'validate');
    expect(() => parsePayload({ ...payload(), name: '../x' })).toThrow();
    expect(() =>
      parsePayload(
        payload({
          files: [
            { path: 'SKILL.md', content: SKILL },
            { path: '../escape.md', content: 'x' },
          ],
        }),
      ),
    ).toThrow('Invalid file path');
    expect(() => parsePayload({ ...payload(), repoDir: 'relative' })).toThrow();
  });

  test('commits a platform skill under platform/skills', () => {
    repo = makeRepo(root, 'commit');
    const sha = applyPromotion(withBase(payload()));

    expect(sha).toBe(headOf());
    const item = path.join(repo, 'platform/skills/demo');
    expect(fs.readFileSync(path.join(item, 'SKILL.md'), 'utf8')).toBe(SKILL);
    expect(fs.existsSync(path.join(item, 'scripts/run.sh'))).toBe(true);
    const message = git(repo, 'log', '-1', '--format=%B');
    expect(message.startsWith('platform: Add demo skill')).toBe(true);
    expect(message).toContain('prop-1');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('uses the group and objective prefixes and rule paths', () => {
    repo = makeRepo(root, 'layers');
    const group = payload({
      layer: 'group_template',
      kind: 'rule',
      name: 'tidy',
      files: [{ path: 'tidy.md', content: RULE }],
    });
    applyPromotion(withBase(group));
    expect(
      fs.readFileSync(path.join(repo, 'brain/group/rules/tidy.md'), 'utf8'),
    ).toBe(RULE);
    expect(git(repo, 'log', '-1', '--format=%s')).toStartWith('group:');

    const agent = payload({
      layer: 'objective_template',
      proposalId: 'prop-2',
      files: [{ path: 'SKILL.md', content: SKILL }],
    });
    applyPromotion(withBase(agent));
    expect(
      fs.existsSync(path.join(repo, 'brain/objective/skills/demo/SKILL.md')),
    ).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s')).toStartWith('objective:');
  });

  test('refuses a stale base hash and leaves the repository unchanged', () => {
    repo = makeRepo(root, 'stale');
    const proposed = withBase(payload());
    applyPromotion(proposed); // someone else lands the same item first
    const head = headOf();
    expect(() =>
      applyPromotion({
        ...proposed,
        proposalId: 'prop-other',
        files: [{ path: 'SKILL.md', content: `${SKILL}more\n` }],
      }),
    ).toThrow(StalePromotionError);
    expect(headOf()).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('refuses uncommitted changes in the target paths but ignores unrelated ones', () => {
    repo = makeRepo(root, 'dirty');
    const proposed = withBase(payload());
    const item = path.join(repo, 'platform/skills/demo');
    fs.mkdirSync(item, { recursive: true });
    fs.writeFileSync(path.join(item, 'notes.txt'), 'wip\n');
    const head = headOf();
    expect(() => applyPromotion(proposed)).toThrow(PromotionRefusedError);
    expect(headOf()).toBe(head);
    expect(fs.readFileSync(path.join(item, 'notes.txt'), 'utf8')).toBe('wip\n');

    fs.rmSync(item, { recursive: true });
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'wip\n');
    applyPromotion(withBase(payload()));
    expect(fs.existsSync(path.join(repo, 'unrelated.txt'))).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('?? unrelated.txt');
  });

  test('refuses a checkout that is not on the default branch', () => {
    repo = makeRepo(root, 'branch');
    git(repo, 'checkout', '-q', '-b', 'feature');
    expect(() => applyPromotion(withBase(payload()))).toThrow(
      'not the default branch',
    );
  });

  test('keeps the execute bit of files that are rewritten', () => {
    repo = makeRepo(root, 'modes');
    const item = path.join(repo, 'platform/skills/demo');
    const script = path.join(item, 'scripts/run.sh');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(path.join(item, 'SKILL.md'), SKILL);
    fs.writeFileSync(script, 'echo old\n', { mode: 0o755 });
    fs.chmodSync(script, 0o755);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'seed');

    applyPromotion(
      withBase(
        payload({
          proposalId: 'prop-modes',
          files: [
            { path: 'SKILL.md', content: `${SKILL}v2\n` },
            { path: 'scripts/run.sh', content: 'echo new\n' },
            { path: 'scripts/new.sh', content: 'echo new\n' },
          ],
        }),
      ),
    );
    const modes = git(repo, 'ls-tree', '-r', 'HEAD', '--', item)
      .split('\n')
      .map(
        (line) =>
          line.split(/\s/)[0] + ' ' + line.split('\t')[1]?.split('/').pop(),
      );
    expect(modes).toContain('100755 run.sh');
    expect(modes).toContain('100644 new.sh');
    expect(modes).toContain('100644 SKILL.md');
  });

  test('a repeated apply returns the commit it already made', () => {
    repo = makeRepo(root, 'replay');
    const proposed = withBase(payload());
    const sha = applyPromotion(proposed);
    expect(applyPromotion(proposed)).toBe(sha);
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('2');
  });

  test('waits on a live repository lock and takes over a dead owner', () => {
    repo = makeRepo(root, 'lock');
    const lock = path.join(repo, '.git/carapa-promotion.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    const head = headOf();
    expect(() => applyPromotion(withBase(payload()), 0)).toThrow(
      'Another promotion is in progress',
    );
    expect(headOf()).toBe(head);

    const dead = spawnSync('true').pid;
    fs.writeFileSync(path.join(lock, 'pid'), String(dead));
    applyPromotion(withBase(payload()), 0);
    expect(headOf()).not.toBe(head);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test('a failing commit hook restores the previous content', () => {
    repo = makeRepo(root, 'hook');
    applyPromotion(withBase(payload()));
    const head = headOf();
    const hook = path.join(repo, '.git/hooks/pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho rejected >&2\nexit 1\n', {
      mode: 0o755,
    });
    const item = path.join(repo, 'platform/skills/demo');
    const before = hashItem(item);
    expect(() =>
      applyPromotion(
        withBase(
          payload({
            proposalId: 'prop-v2',
            files: [{ path: 'SKILL.md', content: `${SKILL}v2\n` }],
          }),
        ),
      ),
    ).toThrow('rejected');
    expect(headOf()).toBe(head);
    expect(hashItem(item)).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('Board dispatch with a mocked CarapaBox', () => {
  const FOLDER = 'promotion-test-project';
  const commands: string[] = [];
  const payloads: PromotionPayload[] = [];
  let exec: ReturnType<typeof spyOn>;
  let status: ReturnType<typeof spyOn>;
  let reply: { stdout: string; isError: boolean };
  /** What the script would write to base.json in hash mode, if anything. */
  let baseReport: { path: string; content: string }[] | null = null;

  const propose = (name: string, layer = 'group_template') =>
    proposeChangesTool.handler(
      {
        title: 'Promote',
        proposals: [
          {
            rationale: 'Useful everywhere',
            kind: 'rule',
            name,
            target_layer: layer,
            approve_action: {
              type: 'write_item',
              files: [{ path: `${name}.md`, content: RULE }],
            },
          },
        ],
      },
      {} as McpServerDeps,
      { group_folder: FOLDER },
    );

  beforeAll(async () => {
    await initDatabase(':memory:');
    await truncateTestDb();
    registeredGroups['ui-promotion'] = {
      name: FOLDER,
      folder: FOLDER,
      trigger: '@bot',
      added_at: new Date().toISOString(),
    };
    applyGroupUpdateInMemory('ui-promotion', {});
    process.env.PROMOTION_SANDBOX_PROJECT = FOLDER;
    const client = getSandboxClient();
    status = spyOn(client, 'sandboxStatus').mockResolvedValue({
      isError: false,
      stdout: '[{"State":"running"}]',
    });
    exec = spyOn(client, 'sandboxExec').mockImplementation(
      async (_stack: string, _service: string, command: string) => {
        commands.push(command);
        // Board must pass the payload by file, never on the command line.
        const run = /runs\/(promotion-[\w-]+)\/payload\.json/.exec(command)![1];
        const file = path.join(
          effectiveSandboxIpcDir(resolveGroupSandbox(FOLDER).group, DATA_DIR),
          'runs',
          run,
          'payload.json',
        );
        payloads.push(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (baseReport) {
          fs.writeFileSync(
            path.join(path.dirname(file), 'base.json'),
            JSON.stringify({ files: baseReport }),
          );
        }
        return reply;
      },
    );
  });
  afterAll(() => {
    delete process.env.PROMOTION_SANDBOX_PROJECT;
    exec.mockRestore();
    status.mockRestore();
  });

  test('stores the script hash, previews repo, branch and paths, and commits on approve', async () => {
    reply = { isError: false, stdout: `HASH ${'a'.repeat(64)}` };
    const { proposal_ids } = await propose('tidy');
    expect(payloads[0]).toMatchObject({
      layer: 'group_template',
      baseHash: null,
      repoDir: '/workspace/carapa-agent-kit',
    });
    expect(commands[0]).toMatch(
      /^carapa-promotion '\/workspace\/carapa-board' hash /,
    );
    expect(commands[0]).not.toContain('Useful');
    expect(commands[0]).not.toContain(RULE.trim());

    const row = (await getProposal(proposal_ids[0]))!;
    expect(row.base_hash).toBe('a'.repeat(64));
    const presented = await presentProposal(row);
    expect(presented.approve.promotion).toEqual({
      repository: 'carapa-agent-kit',
      branch: 'main',
      paths: ['brain/group/rules/tidy.md'],
      previousContentAvailable: false,
    });

    reply = { isError: false, stdout: `COMMIT ${'b'.repeat(40)}` };
    const decided = await decideProposal(row, 'approve', 'alice');
    expect(commands[1]).toMatch(/ apply /);
    expect(payloads[1].baseHash).toBe('a'.repeat(64));
    expect(decided.status).toBe('applied');
    expect(decided.result).toBe(
      `Committed ${'b'.repeat(40)} to carapa-agent-kit. Agents see it after the next update_skill.sh.`,
    );
  });

  test('previews against the stored base: modified, added and removed files', async () => {
    reply = { isError: false, stdout: `HASH ${'e'.repeat(64)}` };
    baseReport = [{ path: 'tidy2.md', content: `${RULE}Old line\n` }];
    const { proposal_ids } = await propose('tidy2');
    baseReport = null;
    const row = (await getProposal(proposal_ids[0]))!;
    expect(row.base_files).toEqual([
      { path: 'tidy2.md', content: `${RULE}Old line\n` },
    ]);
    const rule = (await presentProposal(row)).approve;
    expect(rule.promotion?.previousContentAvailable).toBe(true);
    expect(rule.files).toEqual([
      expect.objectContaining({
        path: 'brain/group/rules/tidy2.md',
        change: 'modified',
      }),
    ]);
    expect(rule.files[0].diff).toContain('-Old line');

    // A skill that drops a base file and adds none; an absent item is all added.
    const skill = (
      await presentProposal({
        ...row,
        kind: 'skill',
        name: 'demo',
        approve_action: {
          type: 'write_item',
          files: [{ path: 'SKILL.md', content: SKILL }],
        },
        base_files: [
          { path: 'SKILL.md', content: SKILL },
          { path: 'scripts/run.sh', content: 'echo hi\n' },
          {
            path: 'assets/logo.png',
            content: Buffer.from([0x89, 0x50, 0, 0xff]).toString('base64'),
            encoding: 'base64',
          },
          {
            path: 'scripts/helper.sh',
            content: 'run.sh',
            encoding: 'symlink',
          },
        ],
      })
    ).approve;
    expect(skill.files.map((f) => [f.path, f.change])).toEqual([
      ['brain/group/skills/demo/SKILL.md', 'unchanged'],
      ['brain/group/skills/demo/scripts/run.sh', 'removed'],
      ['brain/group/skills/demo/assets/logo.png', 'removed'],
      ['brain/group/skills/demo/scripts/helper.sh', 'removed'],
    ]);
    const fresh = (await presentProposal({ ...row, base_files: [] })).approve;
    expect(fresh.files.map((f) => f.change)).toEqual(['added']);
    const legacy = (await presentProposal({ ...row, base_files: null }))
      .approve;
    expect(legacy.files.map((f) => f.change)).toEqual(['unknown']);
    expect(legacy.promotion?.previousContentAvailable).toBe(false);
  });

  test('a script failure leaves the proposal failed with its output', async () => {
    reply = { isError: false, stdout: `HASH ${'c'.repeat(64)}` };
    const { proposal_ids } = await propose('broken', 'platform');
    reply = { isError: true, stdout: 'ERROR: /workspace/carapa-board is on x' };
    const decided = await decideProposal(
      (await getProposal(proposal_ids[0]))!,
      'approve',
      'alice',
    );
    expect(decided.status).toBe('failed');
    expect(decided.result).toContain('is on x');
  });

  test('a stale script result marks the proposal stale', async () => {
    reply = { isError: false, stdout: `HASH ${'d'.repeat(64)}` };
    const { proposal_ids } = await propose('moved');
    reply = { isError: true, stdout: 'STALE: changed after this was proposed' };
    const decided = await decideProposal(
      (await getProposal(proposal_ids[0]))!,
      'approve',
      'alice',
    );
    expect(decided.status).toBe('stale');
  });

  test('creation fails when the target cannot be checked', async () => {
    reply = { isError: true, stdout: 'ERROR: not a git checkout' };
    await expect(propose('nope')).rejects.toThrow('not a git checkout');
  });
});
