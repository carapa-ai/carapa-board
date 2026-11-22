import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createImportedIssueTask,
  deleteTask,
  getTasksByProject,
  initDatabase,
} from '../../db.js';
import { taskFixture, truncateTestDb } from '../../test-helpers.js';
import { issueRepositoryFromUrl } from './issue-import.js';

beforeAll(async () => {
  await initDatabase(':memory:');
});

beforeEach(async () => {
  await truncateTestDb();
});

describe('issue import', () => {
  test('derives a stable repository identity from the issue URL', () => {
    expect(
      issueRepositoryFromUrl(
        'gitlab',
        'https://gitlab.example.com/group/subgroup/project/-/issues/42',
      ),
    ).toBe('https://gitlab.example.com/group/subgroup/project');
    expect(
      issueRepositoryFromUrl(
        'gitlab',
        'https://gitlab.example.com/group/subgroup/project/-/work_items/42',
      ),
    ).toBe('https://gitlab.example.com/group/subgroup/project');
    expect(
      issueRepositoryFromUrl('github', 'https://github.com/org/repo/issues/7'),
    ).toBe('https://github.com/org/repo');
    // A pull request URL is not an issue identity.
    expect(() =>
      issueRepositoryFromUrl('github', 'https://github.com/org/repo/pull/7'),
    ).toThrow('Unexpected GitHub issue URL');
  });

  test('imports each issue only once, even after its task is deleted', async () => {
    const identity = {
      provider: 'gitlab' as const,
      repository: 'https://gitlab.example.com/group/project',
      issueNumber: 42,
      issueUrl: 'https://gitlab.example.com/group/project/-/issues/42',
    };
    const first = await createImportedIssueTask(taskFixture(), identity);
    expect(first).not.toBeNull();

    expect(
      await createImportedIssueTask(
        taskFixture({ title: 'Duplicate should not appear' }),
        identity,
      ),
    ).toBeNull();
    expect(await getTasksByProject('test-project')).toHaveLength(1);

    await deleteTask(first!.id);
    expect(await createImportedIssueTask(taskFixture(), identity)).toBeNull();
    expect(await getTasksByProject('test-project')).toHaveLength(0);
  });
});
