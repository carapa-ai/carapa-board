import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import type { ProjectSettings } from './types.js';

import {
  registeredGroups,
  loadState,
  registerGroup,
  unregisterGroup,
  getGroupByFolder,
  ensureAgentSymlinks,
  normalizeTaskCheckoutSettings,
  serializeSettingsForDb,
} from './state-manager.js';

let symlinkTestDir: string;

describe('State Manager without module mocking (optimized)', () => {
  beforeAll(() => {
    // Ensure DATA_DIR exists for loadState() (reads router_state.json). Project
    // settings live in the DB now; registered_groups.json is retired, so there
    // is no file to back up or seed here.
    fs.mkdirSync(DATA_DIR, { recursive: true });
    symlinkTestDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-agent-links-'),
    );

    // Force hydrate once
    loadState();
  });

  afterAll(() => {
    // Clean up test groups from memory
    const testJids = ['test-unreg-jid@g.us'];
    for (const jid of testJids) {
      delete registeredGroups[jid];
    }
    fs.rmSync(symlinkTestDir, { recursive: true, force: true });
  });

  test('preserves cross-agent prompt and rules compatibility symlinks', () => {
    fs.writeFileSync(
      path.join(symlinkTestDir, 'AGENTS.md'),
      '# Instructions\n',
    );
    fs.mkdirSync(path.join(symlinkTestDir, '.agent', 'rules'), {
      recursive: true,
    });

    ensureAgentSymlinks(symlinkTestDir, {
      name: 'Symlink Test',
      folder: 'symlink-test',
      trigger: 'ai',
      added_at: new Date().toISOString(),
      settings: {},
    });

    for (const name of ['CLAUDE.md', 'GEMINI.md']) {
      const link = path.join(symlinkTestDir, name);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe('AGENTS.md');
    }
    for (const agentDir of ['.claude', '.gemini']) {
      const link = path.join(symlinkTestDir, agentDir, 'rules');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(path.join('..', '.agent', 'rules'));
    }
  });

  describe('rules symlink maintenance with agent-controlled dirs', () => {
    const group = {
      name: 'Rules Test',
      folder: 'rules-test',
      trigger: 'ai',
      added_at: new Date().toISOString(),
      settings: {},
    };
    const fresh = (): { root: string; attacker: string; victim: string } => {
      const root = fs.mkdtempSync(path.join(symlinkTestDir, 'case-'));
      const attacker = path.join(root, 'attacker');
      const victim = path.join(root, 'victim');
      fs.mkdirSync(attacker);
      fs.mkdirSync(path.join(victim, '.agent', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(victim, '.agent', 'rules', 'r.md'), 'secret');
      return { root, attacker, victim };
    };

    test('migrates a real .claude/rules dir to .agent/rules', () => {
      const { attacker } = fresh();
      fs.mkdirSync(path.join(attacker, '.claude', 'rules'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(attacker, '.claude', 'rules', 'a.md'), 'x');

      ensureAgentSymlinks(attacker, group);

      expect(
        fs.readFileSync(path.join(attacker, '.agent', 'rules', 'a.md'), 'utf8'),
      ).toBe('x');
      for (const dir of ['.claude', '.gemini']) {
        expect(
          fs.lstatSync(path.join(attacker, dir, 'rules')).isSymbolicLink(),
        ).toBe(true);
      }
    });

    test('keeps rules in place when .agent is a symlink to another group', () => {
      const { attacker, victim } = fresh();
      // The victim has an .agent dir without rules: the old migration moved the
      // attacker's rules into it.
      fs.rmSync(path.join(victim, '.agent', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(victim, '.agent', 'keep.md'), 'keep');
      fs.mkdirSync(path.join(attacker, '.claude', 'rules'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(attacker, '.claude', 'rules', 'a.md'), 'x');
      fs.symlinkSync(
        path.join(victim, '.agent'),
        path.join(attacker, '.agent'),
      );

      expect(() => ensureAgentSymlinks(attacker, group)).not.toThrow();

      expect(
        fs.readFileSync(
          path.join(attacker, '.claude', 'rules', 'a.md'),
          'utf8',
        ),
      ).toBe('x');
      expect(fs.readdirSync(path.join(victim, '.agent'))).toEqual(['keep.md']);
    });

    test.each(['.claude', '.gemini'])(
      'refuses a symlinked %s pointing at another group',
      (dir) => {
        const { attacker, victim } = fresh();
        fs.mkdirSync(path.join(attacker, '.claude'));
        fs.mkdirSync(path.join(attacker, '.gemini'));
        fs.rmSync(path.join(attacker, dir), { recursive: true });
        fs.symlinkSync(path.join(victim, '.agent'), path.join(attacker, dir));
        // Give the symlinked dir a rules entry only when it is the migration source.
        if (dir === '.gemini') {
          fs.mkdirSync(path.join(attacker, '.claude', 'rules'));
        }

        expect(() => ensureAgentSymlinks(attacker, group)).not.toThrow();

        expect(fs.lstatSync(path.join(attacker, dir)).isSymbolicLink()).toBe(
          true,
        );
        expect(
          fs.readFileSync(path.join(victim, '.agent', 'rules', 'r.md'), 'utf8'),
        ).toBe('secret');
        expect(fs.readdirSync(path.join(victim, '.agent'))).toEqual(['rules']);
      },
    );
  });

  test('unregisterGroup cleans up group references', () => {
    const jid = 'test-unreg-jid@g.us';
    registerGroup(jid, {
      jid,
      name: 'Unregister Group',
      folder: 'state-unreg-folder',
      trigger: 'ai',
      added_at: new Date().toISOString(),
      settings: {},
    });

    unregisterGroup(jid);
    expect(registeredGroups[jid]).toBeUndefined();
    expect(getGroupByFolder('state-unreg-folder')).toBeUndefined();
  });

  test('normalizes checkout settings to the taskCheckoutMode enum and strips the retired createBranchPerTask key', () => {
    const normalized = normalizeTaskCheckoutSettings({
      createBranchPerTask: true,
      taskCheckoutMode: 'branch',
      maxParallelWorktrees: 4,
    } as unknown as ProjectSettings) as Record<string, unknown>;
    expect(normalized.taskCheckoutMode).toBe('branch');
    expect(normalized.maxParallelWorktrees).toBe(4);
    expect(normalized.createBranchPerTask).toBeUndefined();
    expect(
      normalizeTaskCheckoutSettings({} as ProjectSettings).taskCheckoutMode,
    ).toBe('shared');
  });

  test('serializeSettingsForDb keeps _checkoutAdmissions from its input', () => {
    const admissions = { 'task-1': { runId: 'run-1' } };
    const persisted = JSON.parse(
      serializeSettingsForDb({
        taskCheckoutMode: 'worktree',
        _checkoutAdmissions: admissions,
      } as unknown as ProjectSettings)!,
    ) as Record<string, unknown>;
    expect(persisted._checkoutAdmissions).toEqual(admissions);
  });

  test('serializeSettingsForDb output equals a persisted row with admissions (loadState does not rewrite it)', () => {
    const row = JSON.stringify({
      taskCheckoutMode: 'worktree',
      _checkoutAdmissions: { 'task-1': { runId: 'run-1' } },
    });
    // loadState rewrites a row whenever re-serializing it differs from the
    // stored text, so a stable round trip is what keeps admissions in place.
    expect(
      JSON.stringify(
        JSON.parse(serializeSettingsForDb(JSON.parse(row) as ProjectSettings)!),
      ),
    ).toBe(row);
  });
});
