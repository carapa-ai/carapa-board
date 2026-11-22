import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROMPTS_DIR, GROUPS_DIR } from './config.js';
import { groupFsTestHooks } from './lib/group-fs.js';

import {
  loadSystemPrompt,
  loadStagePrompt,
  loadGroupWorkerPrompt,
  loadAgentRules,
} from './prompt-loader.js';

test('renders inherited rule links for the sandbox without polluting Direct context', () => {
  const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inherited-rules-'));
  const rulesDir = path.join(groupDir, '.agent', 'rules');
  try {
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'deployment.md'),
      '---\ntrigger: model_decision\ndescription: Deployment instructions\n---\nOnly load this body when needed.',
    );
    const directRules = loadAgentRules(groupDir);
    const inherited = loadAgentRules(groupDir, '/workspace/group/child');

    expect(inherited).toContain(
      '/workspace/group/child/.agent/rules/deployment.md',
    );
    expect(inherited).not.toContain('Only load this body when needed.');
    expect(inherited).not.toContain('`peek_files`');
    expect(directRules).toContain('`peek_files`');
    expect(directRules).toContain(
      path.relative(process.cwd(), path.join(rulesDir, 'deployment.md')),
    );
    expect(loadAgentRules(groupDir)).toBe(directRules);
    expect(loadAgentRules(groupDir, '/workspace/group/child')).toBe(inherited);
  } finally {
    fs.rmSync(groupDir, { recursive: true, force: true });
  }
});

describe('Prompt Loader & Parsers without mocking (optimized)', () => {
  const testGroupName = 'test-prompt-group-unmocked';

  beforeAll(() => {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    fs.mkdirSync(path.join(GROUPS_DIR, testGroupName), { recursive: true });
  });

  afterAll(() => {
    // Clean up any test prompts created during the tests
    try {
      fs.unlinkSync(path.join(PROMPTS_DIR, `${testGroupName}.md`));
    } catch {}
    try {
      fs.rmSync(path.join(GROUPS_DIR, testGroupName), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  test('loadSystemPrompt prioritizes the group prompt over PROMPTS_DIR and skips empty ones', () => {
    const name = `${testGroupName}-priority`;
    const bundledPromptPath = path.join(PROMPTS_DIR, `${name}.md`);
    const groupPromptPath = path.join(
      GROUPS_DIR,
      name,
      '.agent',
      'prompts',
      'system.md',
    );
    fs.mkdirSync(path.dirname(groupPromptPath), { recursive: true });
    fs.writeFileSync(bundledPromptPath, 'Bundled priority content');
    try {
      fs.writeFileSync(groupPromptPath, '  \n');
      expect(loadSystemPrompt(name)).toBe('Bundled priority content');

      const other = `${name}-2`;
      const otherBundled = path.join(PROMPTS_DIR, `${other}.md`);
      const otherGroup = path.join(
        GROUPS_DIR,
        other,
        '.agent',
        'prompts',
        'system.md',
      );
      fs.mkdirSync(path.dirname(otherGroup), { recursive: true });
      fs.writeFileSync(otherBundled, 'Bundled content');
      fs.writeFileSync(otherGroup, 'Group content');
      try {
        expect(loadSystemPrompt(other)).toBe('Group content');
      } finally {
        fs.unlinkSync(otherBundled);
        fs.rmSync(path.join(GROUPS_DIR, other), {
          recursive: true,
          force: true,
        });
      }
    } finally {
      fs.unlinkSync(bundledPromptPath);
      fs.rmSync(path.join(GROUPS_DIR, name), { recursive: true, force: true });
    }
  });

  test('loadStagePrompt correctly loads stage prompt', () => {
    const stagePromptsDir = path.join(
      GROUPS_DIR,
      testGroupName,
      '.agent',
      'prompts',
    );
    fs.mkdirSync(stagePromptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagePromptsDir, 'stage-pipeline.md'),
      'Stage pipeline content',
    );

    const prompt = loadStagePrompt(testGroupName, undefined, 'pipeline');
    expect(prompt).toBe('Stage pipeline content');
  });

  test('loadStagePrompt prefers the alternative prompt, falls back to the base, and rejects invalid ids', () => {
    const stagePromptsDir = path.join(
      GROUPS_DIR,
      testGroupName,
      '.agent',
      'prompts',
    );
    fs.mkdirSync(stagePromptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagePromptsDir, 'stage-variant_stage.md'),
      'Base variant stage',
    );
    fs.writeFileSync(
      path.join(stagePromptsDir, 'stage-variant_stage.b.md'),
      'Alternative B',
    );

    expect(
      loadStagePrompt(testGroupName, undefined, 'variant_stage', 'b'),
    ).toBe('Alternative B');
    expect(
      loadStagePrompt(testGroupName, undefined, 'variant_stage', 'c'),
    ).toBe('Base variant stage');
    expect(loadStagePrompt(testGroupName, undefined, 'variant_stage')).toBe(
      'Base variant stage',
    );
    expect(
      loadStagePrompt(testGroupName, undefined, 'variant_stage', '../b'),
    ).toBeUndefined();
    expect(
      loadStagePrompt(testGroupName, undefined, '../variant_stage', 'b'),
    ).toBeUndefined();
  });

  test('loadGroupWorkerPrompt correctly loads group worker prompt', () => {
    const stagePromptsDir = path.join(
      GROUPS_DIR,
      testGroupName,
      '.agent',
      'prompts',
    );
    fs.mkdirSync(stagePromptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagePromptsDir, 'worker.md'),
      'Group worker content',
    );

    const prompt = loadGroupWorkerPrompt(testGroupName, undefined);
    expect(prompt).toBe('Group worker content');
  });
});

/**
 * Run prompt-loader calls in a child process so a regression to a blocking
 * FIFO read times out here instead of hanging the whole suite.
 */
function runInChild(body: string): unknown {
  const loaderPath = path.resolve(import.meta.dir, 'prompt-loader.ts');
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      '-e',
      `const m = await import(${JSON.stringify(loaderPath)});\nconsole.log(JSON.stringify(${body}));`,
    ],
    cwd: path.resolve(import.meta.dir, '..'),
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    timeout: 5000,
  });
  expect(child.exitedDueToTimeout).toBeFalsy();
  expect(child.exitCode).toBe(0);
  return JSON.parse(child.stdout.toString().trim().split('\n').pop() ?? '');
}

describe('prompt loader containment', () => {
  const name = 'test-prompt-containment';
  let home: string;
  let outsideDir: string;

  const promptsDir = () => path.join(home, '.agent', 'prompts');

  beforeAll(() => {
    home = path.join(GROUPS_DIR, name);
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-outside-'));
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(promptsDir(), { recursive: true });
    fs.mkdirSync(path.join(home, '.agent', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'SECRET');
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  test('stage and worker prompts that symlink outside the group are refused', () => {
    fs.symlinkSync(
      path.join(outsideDir, 'secret.md'),
      path.join(promptsDir(), 'stage-x.md'),
    );
    fs.symlinkSync(
      path.join(outsideDir, 'secret.md'),
      path.join(promptsDir(), 'worker.md'),
    );
    expect(loadStagePrompt(name, undefined, 'x')).toBeUndefined();
    expect(loadGroupWorkerPrompt(name, undefined)).toBeUndefined();
  });

  test('a FIFO stage prompt returns undefined instead of blocking', () => {
    execFileSync('mkfifo', [path.join(promptsDir(), 'stage-fifo.md')]);
    expect(
      runInChild(
        `m.loadStagePrompt(${JSON.stringify(name)}, undefined, 'fifo') ?? null`,
      ),
    ).toBeNull();
  });

  test('loadAgentRules skips symlinked-out and FIFO rules but keeps the rest', () => {
    const rules = path.join(home, '.agent', 'rules');
    fs.writeFileSync(
      path.join(rules, 'good.md'),
      '---\ntrigger: always_on\n---\nGOOD RULE',
    );
    fs.symlinkSync(
      path.join(outsideDir, 'secret.md'),
      path.join(rules, 'a.md'),
    );
    execFileSync('mkfifo', [path.join(rules, 'b.md')]);
    const result = runInChild(
      `m.loadAgentRules(${JSON.stringify(home)})`,
    ) as string;
    expect(result).toContain('GOOD RULE');
    expect(result).not.toContain('SECRET');
  });

  test("a .agent/rules directory swapped for another project's rules is not read", () => {
    const swapped = 'test-prompt-containment-rules-swap';
    const other = 'test-prompt-containment-rules-other';
    const swappedHome = path.join(GROUPS_DIR, swapped);
    const otherRules = path.join(GROUPS_DIR, other, '.agent', 'rules');
    try {
      fs.mkdirSync(path.join(swappedHome, '.agent', 'rules'), {
        recursive: true,
      });
      fs.mkdirSync(otherRules, { recursive: true });
      fs.writeFileSync(
        path.join(otherRules, 'b.md'),
        '---\ntrigger: always_on\n---\nOTHER PROJECT RULE',
      );
      let done = false;
      groupFsTestHooks.beforeOpen = (_label, segment) => {
        if (done || segment !== 'rules') return;
        done = true;
        fs.rmSync(path.join(swappedHome, '.agent', 'rules'), {
          recursive: true,
        });
        fs.symlinkSync(otherRules, path.join(swappedHome, '.agent', 'rules'));
      };
      try {
        expect(loadAgentRules(swappedHome)).not.toContain('OTHER PROJECT RULE');
      } finally {
        groupFsTestHooks.beforeOpen = undefined;
      }
      expect(done).toBe(true);
    } finally {
      fs.rmSync(swappedHome, { recursive: true, force: true });
      fs.rmSync(path.join(GROUPS_DIR, other), { recursive: true, force: true });
    }
  });

  test('legacy .agent -> .claude symlink inside the group still loads', () => {
    const legacy = 'test-prompt-containment-legacy';
    const legacyHome = path.join(GROUPS_DIR, legacy);
    try {
      fs.mkdirSync(path.join(legacyHome, '.claude', 'prompts'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(legacyHome, '.claude', 'rules'));
      fs.writeFileSync(
        path.join(legacyHome, '.claude', 'prompts', 'worker.md'),
        'Legacy worker',
      );
      fs.writeFileSync(
        path.join(legacyHome, '.claude', 'rules', 'r.md'),
        '---\ntrigger: always_on\n---\nLEGACY RULE',
      );
      fs.symlinkSync('.claude', path.join(legacyHome, '.agent'));
      expect(loadGroupWorkerPrompt(legacy, undefined)).toBe('Legacy worker');
      expect(loadAgentRules(legacyHome)).toContain('LEGACY RULE');
    } finally {
      fs.rmSync(legacyHome, { recursive: true, force: true });
    }
  });

  test('a group home that is itself a symlink to another directory is refused', () => {
    const swapped = 'test-prompt-containment-swapped';
    const swappedHome = path.join(GROUPS_DIR, swapped);
    try {
      fs.mkdirSync(path.join(outsideDir, '.agent', 'prompts'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(outsideDir, '.agent', 'prompts', 'worker.md'),
        'Other project prompt',
      );
      fs.symlinkSync(outsideDir, swappedHome);
      expect(loadGroupWorkerPrompt(swapped, undefined)).toBeUndefined();
    } finally {
      fs.rmSync(swappedHome, { force: true });
    }
  });
});
