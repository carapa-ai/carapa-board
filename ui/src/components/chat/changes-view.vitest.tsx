import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationDiff } from '@/types';
import { TaskChangesPanel } from '@/components/board/task-detail-dialog';
import { ChangesView } from './changes-view';

afterEach(cleanup);

const diff: ConversationDiff = {
  available: true,
  scope: 'worktree',
  base: 'develop',
  branch: 'task/symlink',
  patch: '',
  files: [
    {
      path: '.agents/skills',
      additions: 1,
      deletions: 0,
      kind: 'symlink',
      linkTarget: '../.agent/skills',
      source: 'task',
    },
    {
      path: 'odd name;still-safe.txt',
      additions: 0,
      deletions: 0,
      renderError: 'Patch unavailable for a path requiring shell quoting.',
    },
  ],
  blockers: [
    {
      path: 'outside-link',
      additions: 0,
      deletions: 0,
      kind: 'symlink',
      linkTarget: '/outside/repository',
      source: 'default-checkout-blocker',
      status: '??',
    },
  ],
};

describe('ChangesView inspectable Git entries', () => {
  it('keeps a committed task symlink identifiable from its tracked patch', () => {
    const committedDiff: ConversationDiff = {
      available: true,
      scope: 'worktree',
      base: 'develop',
      branch: 'task/symlink',
      files: [{ path: '.agents/skills', additions: 1, deletions: 0 }],
      patch: `diff --git a/.agents/skills b/.agents/skills
new file mode 120000
index 0000000..2763f72
--- /dev/null
+++ b/.agents/skills
@@ -0,0 +1 @@
+../.agent/skills
\\ No newline at end of file`,
    };
    const { container, getByText } = render(
      <ChangesView diff={committedDiff} isLoading={false} />,
    );
    const row = container.querySelector(
      '[data-ui="changed-file"][data-file-path=".agents/skills"]',
    );

    expect(row?.getAttribute('data-change-type')).toBe('symlink');
    expect(row?.getAttribute('data-change-source')).toBe('task');
    expect(row?.getAttribute('data-link-target')).toBe('../.agent/skills');
    expect(getByText('→ ../.agent/skills')).toBeTruthy();
  });

  it('keeps metadata-only failures visible and expandable', () => {
    const { container, getByText } = render(
      <ChangesView diff={diff} isLoading={false} />,
    );
    const row = container.querySelector(
      '[data-ui="changed-file"][data-file-path="odd name;still-safe.txt"]',
    ) as HTMLButtonElement;

    expect(row).not.toBeNull();
    fireEvent.click(row);
    expect(
      getByText('Patch unavailable for a path requiring shell quoting.'),
    ).toBeTruthy();
  });

  it('marks default-checkout changes as external and integration-only', () => {
    const { container, getByText } = render(
      <TaskChangesPanel taskId="task-link" diff={diff} isLoading={false} />,
    );
    const panel = container.querySelector(
      '[data-ui="task-changes-tab"][data-task-id="task-link"]',
    );
    const blocker = container.querySelector(
      '[data-ui="changed-file"][data-file-path="outside-link"]',
    );

    expect(panel).not.toBeNull();
    expect(
      container.querySelector('[data-ui="default-checkout-blockers"]'),
    ).not.toBeNull();
    expect(blocker?.getAttribute('data-change-type')).toBe('symlink');
    expect(blocker?.getAttribute('data-change-source')).toBe(
      'default-checkout-blocker',
    );
    expect(blocker?.getAttribute('data-link-target')).toBe(
      '/outside/repository',
    );
    expect(blocker?.getAttribute('data-git-status')).toBe('??');
    expect(getByText('Default checkout')).toBeTruthy();
    expect(container.textContent).not.toContain('Delays integration');
  });
  it('keeps task and blocker statistics separate for the same path', () => {
    const samePathDiff: ConversationDiff = {
      available: true,
      scope: 'worktree',
      base: 'develop',
      branch: 'task/shared-path',
      files: [
        {
          path: 'shared.txt',
          additions: 7,
          deletions: 2,
          source: 'task',
        },
      ],
      blockers: [
        {
          path: 'shared.txt',
          additions: 0,
          deletions: 0,
          source: 'default-checkout-blocker',
          status: ' M',
        },
      ],
      patch: `diff --git a/shared.txt b/shared.txt
--- a/shared.txt
+++ b/shared.txt
@@ -1,2 +1,7 @@
-old
+new`,
    };

    const { container } = render(
      <ChangesView diff={samePathDiff} isLoading={false} />,
    );
    const taskRow = container.querySelector(
      '[data-ui="changed-file"][data-file-path="shared.txt"][data-change-source="task"]',
    );
    const blockerRow = container.querySelector(
      '[data-ui="changed-file"][data-file-path="shared.txt"][data-change-source="default-checkout-blocker"]',
    );

    expect(taskRow?.textContent).toContain('+7');
    expect(taskRow?.textContent).toContain('-2');
    expect(blockerRow?.textContent).toContain('+0');
    expect(blockerRow?.textContent).toContain('-0');
  });
  it('keeps renamed file stats on its destination row', () => {
    const renamedDiff: ConversationDiff = {
      available: true,
      scope: 'worktree',
      base: 'develop',
      branch: 'task/rename',
      files: [
        {
          path: 'new-name.ts',
          additions: 1,
          deletions: 1,
        },
      ],
      patch: `diff --git a/old-name.ts b/new-name.ts
similarity index 80%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1 +1 @@
-old
+new`,
    };

    const { container } = render(
      <ChangesView diff={renamedDiff} isLoading={false} />,
    );

    const rows = container.querySelectorAll('[data-ui="changed-file"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-file-path')).toBe('new-name.ts');
    expect(rows[0].getAttribute('data-change-type')).toBe('renamed');
    expect(rows[0].textContent).toContain('+1');
    expect(rows[0].textContent).toContain('-1');
  });
});
