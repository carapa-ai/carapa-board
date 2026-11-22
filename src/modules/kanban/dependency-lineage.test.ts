import { describe, expect, test } from 'bun:test';
import {
  isRetryableTaskError,
  resolveGitCommitWithRetry,
  resolveIntegratedDependencyCommit,
  selectDependencyLineageBase,
  taskSandboxGitRunner,
} from './task/pipeline.js';

const group = {
  name: 'dependency-lineage-test',
  folder: 'dependency-lineage-test',
  trigger: '@test',
  added_at: new Date().toISOString(),
  settings: { taskCheckoutMode: 'branch' as const },
};

const resultFor = (args: string): { ok: boolean; output: string } => ({
  ok: args.includes('dep-commit') && args.includes('lineage-commit'),
  output: '',
});

describe('dependency checkout base selection', () => {
  test('keeps an ordinary ancestor as the required dependency commit', async () => {
    const calls: string[] = [];
    const resolved = await resolveIntegratedDependencyCommit(
      group,
      'recorded-commit',
      'default-commit',
      async (_group, args) => {
        calls.push(args);
        return { ok: true, output: '' };
      },
    );

    expect(resolved).toBe('recorded-commit');
    expect(calls).toEqual([
      'merge-base --is-ancestor recorded-commit default-commit',
    ]);
  });

  test('maps a fully patch-equivalent rebased dependency onto the target commit', async () => {
    const resolved = await resolveIntegratedDependencyCommit(
      group,
      'recorded-commit',
      'rebased-default',
      async (_group, args) =>
        args.startsWith('merge-base ')
          ? { ok: false, output: '' }
          : {
              ok: true,
              output: `- ${'1'.repeat(40)}\n- ${'2'.repeat(40)}\n`,
            },
    );

    expect(resolved).toBe('rebased-default');
  });

  test('rejects a rebased dependency when any recorded patch is missing', async () => {
    const resolved = await resolveIntegratedDependencyCommit(
      group,
      'recorded-commit',
      'incomplete-default',
      async (_group, args) =>
        args.startsWith('merge-base ')
          ? { ok: false, output: '' }
          : {
              ok: true,
              output: `- ${'1'.repeat(40)}\n+ ${'2'.repeat(40)}\n`,
            },
    );

    expect(resolved).toBeUndefined();
  });

  describe('limited own-commit range after a default-branch rebase', () => {
    const base = 'b'.repeat(40);
    const fakeGit =
      (limited: string, baseIsAncestor: boolean, calls: string[]) =>
      async (_group: unknown, args: string) => {
        calls.push(args);
        if (args.startsWith('merge-base --is-ancestor recorded-commit '))
          return { ok: false, output: '' };
        if (args.startsWith(`merge-base --is-ancestor ${base} `))
          return { ok: baseIsAncestor, output: '' };
        if (args === 'cherry rebased-default recorded-commit')
          return {
            ok: true,
            output: `- ${'1'.repeat(40)}\n+ ${'2'.repeat(40)}\n`,
          };
        if (args === `cherry rebased-default recorded-commit ${base}`)
          return { ok: true, output: limited };
        return { ok: false, output: '' };
      };

    test('accepts a dependency whose own commits are all patch-equivalent', async () => {
      const resolved = await resolveIntegratedDependencyCommit(
        group,
        'recorded-commit',
        'rebased-default',
        fakeGit(`- ${'3'.repeat(40)}\n`, true, []),
        base,
      );
      expect(resolved).toBe('rebased-default');
    });

    test('rejects when an own commit has no equivalent patch', async () => {
      const resolved = await resolveIntegratedDependencyCommit(
        group,
        'recorded-commit',
        'rebased-default',
        fakeGit(`+ ${'3'.repeat(40)}\n`, true, []),
        base,
      );
      expect(resolved).toBeUndefined();
    });

    test('rejects without a limited cherry when the base is not an ancestor', async () => {
      const calls: string[] = [];
      const resolved = await resolveIntegratedDependencyCommit(
        group,
        'recorded-commit',
        'rebased-default',
        fakeGit(`- ${'3'.repeat(40)}\n`, false, calls),
        base,
      );
      expect(resolved).toBeUndefined();
      expect(calls).not.toContain(
        `cherry rebased-default recorded-commit ${base}`,
      );
    });
  });

  test('routes dependency Git through the effective project instance', async () => {
    const calls: Array<string | null | undefined> = [];
    const runGit = taskSandboxGitRunner(
      {
        id: 'task-instance-routing',
        project_id: 'dependency-lineage-test',
        title: 'Instance routing',
        description: '',
        status: 'testing',
        priority: 0,
        created_at: '2026-09-01T00:00:00.000Z',
        sandbox_instance: 'dependency-lineage-test',
      },
      async (_group, _args, instance) => {
        calls.push(instance);
        return { ok: true, output: 'a'.repeat(40) };
      },
    );

    await runGit(group, 'rev-parse --verify develop^{commit}');

    expect(calls).toEqual(['dependency-lineage-test']);
  });

  test('treats a stopped sandbox service as retryable infrastructure', () => {
    expect(isRetryableTaskError('service "agent" is not running')).toBe(true);
    expect(isRetryableTaskError('sandbox unavailable')).toBe(true);
  });

  test('never retries the dependency-guard error, whatever the dependency title says', () => {
    expect(
      isRetryableTaskError(
        `Dependency task-1-abc ("Fix rate limit capacity") commit ${'a'.repeat(40)} is not present in the task checkout: the task branch predates this dependency. Use Start over, or merge develop into the task branch.`,
      ),
    ).toBe(false);
  });

  test('retries a transient default-ref inspection failure', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const commit = 'a'.repeat(40);

    await expect(
      resolveGitCommitWithRetry(
        group,
        'develop',
        async () => {
          attempts++;
          return attempts === 1
            ? { ok: false, output: 'temporary sandbox error' }
            : { ok: true, output: `${commit}\n` };
        },
        async (ms) => {
          waits.push(ms);
        },
      ),
    ).resolves.toBe(commit);
    expect(attempts).toBe(2);
    expect(waits).toEqual([100]);
  });

  test('reports the concrete Git failure after bounded retries', async () => {
    let attempts = 0;
    await expect(
      resolveGitCommitWithRetry(
        group,
        'develop',
        async () => {
          attempts++;
          return { ok: false, output: 'sandbox unavailable' };
        },
        async () => {},
      ),
    ).rejects.toThrow(
      'Git ref develop could not be resolved after 3 attempts: sandbox unavailable',
    );
    expect(attempts).toBe(3);
  });

  test('prefers the default branch when all required commits are contained', async () => {
    const result = await selectDependencyLineageBase(
      group,
      'default-commit',
      ['dep-commit'],
      [{ branch: 'dependency-branch', commit: 'lineage-commit' }],
      async (_group, args) => {
        return { ok: args.includes('default-commit'), output: '' };
      },
    );
    expect(result).toEqual({ branchBaseCommit: 'default-commit' });
  });

  test('selects an unmerged lineage when the default lacks required commits', async () => {
    const result = await selectDependencyLineageBase(
      group,
      'default-commit',
      ['dep-commit'],
      [{ branch: 'dependency-branch', commit: 'lineage-commit' }],
      async (_group, args) => resultFor(args),
    );
    expect(result).toEqual({
      branchBaseName: 'dependency-branch',
      branchBaseCommit: 'lineage-commit',
    });
  });

  test('blocks when no candidate contains every required commit', async () => {
    await expect(
      selectDependencyLineageBase(
        group,
        'default-commit',
        ['dep-a', 'dep-b'],
        [{ branch: 'dependency-branch', commit: 'lineage-commit' }],
        async () => ({ ok: false, output: '' }),
      ),
    ).rejects.toThrow('no single verified lineage');
  });

  test('blocks when matching dependency lineages are incomparable', async () => {
    await expect(
      selectDependencyLineageBase(
        group,
        'default-commit',
        ['dep-commit'],
        [
          { branch: 'left-branch', commit: 'lineage-left' },
          { branch: 'right-branch', commit: 'lineage-right' },
        ],
        async (_group, args) => ({
          ok: args.includes('dep-commit') && !args.includes('default-commit'),
          output: '',
        }),
      ),
    ).rejects.toThrow('no single verified lineage');
  });
});
