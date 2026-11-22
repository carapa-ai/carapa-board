import { describe, expect, test } from 'bun:test';
import { parseLinkedRepositoryInspection } from './git-ops.js';

describe('linked repository inspection parsing', () => {
  test('accepts complete repository diffs and rejects malformed entries', () => {
    expect(
      parseLinkedRepositoryInspection(
        JSON.stringify({
          repositories: [
            {
              name: 'demo-app/ai',
              path: 'vendor/demo-app/ai',
              base: 'develop',
              branch: 'task-branch',
              files: [
                {
                  path: 'vendor/demo-app/ai/src/Ai.php',
                  additions: 2,
                  deletions: 1,
                },
              ],
              patch:
                'diff --git a/vendor/demo-app/ai/src/Ai.php b/vendor/demo-app/ai/src/Ai.php',
            },
            { name: 'incomplete' },
          ],
        }),
      ),
    ).toEqual({
      repositories: [
        {
          name: 'demo-app/ai',
          path: 'vendor/demo-app/ai',
          base: 'develop',
          branch: 'task-branch',
          files: [
            {
              path: 'vendor/demo-app/ai/src/Ai.php',
              additions: 2,
              deletions: 1,
            },
          ],
          patch:
            'diff --git a/vendor/demo-app/ai/src/Ai.php b/vendor/demo-app/ai/src/Ai.php',
        },
      ],
    });
  });

  test('fails closed on non-JSON hook output', () => {
    expect(parseLinkedRepositoryInspection('hook failed')).toEqual({
      repositories: [],
    });
  });
});
