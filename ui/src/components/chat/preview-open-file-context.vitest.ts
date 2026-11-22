import { describe, expect, it } from 'vitest';
import {
  previewTabOpenFileContext,
  selectionLineRange,
  sourcePosition,
} from './preview-pane';

describe('preview open-file context mapping', () => {
  it('preserves pinned Repo main and worktree identity and normalizes artifact paths', () => {
    expect(
      previewTabOpenFileContext(
        {
          id: 'main',
          title: 'a.ts',
          kind: 'file',
          source: 'repo',
          path: 'src/a.ts',
          repoContext: 'main',
        },
        'pinned-conv',
      ),
    ).toEqual({ source: 'repo', path: 'src/a.ts', repoContext: 'main' });
    expect(
      previewTabOpenFileContext(
        {
          id: 'wt',
          title: 'a.ts',
          kind: 'file',
          source: 'repo',
          path: 'src/a.ts',
          repoContext: 'conversation',
          conversation_id: 'pinned-conv',
        },
        'pinned-conv',
      ),
    ).toEqual({
      source: 'repo',
      path: 'src/a.ts',
      repoContext: 'conversationWorktree',
      conversationId: 'pinned-conv',
    });
    expect(
      previewTabOpenFileContext(
        {
          id: 'artifact',
          title: 'plan.md',
          kind: 'file',
          source: 'group',
          path: 'artifacts/plans/plan.md',
        },
        null,
      ),
    ).toEqual({ source: 'artifact', path: 'plans/plan.md' });
  });

  it('suppresses a pinned worktree after the active conversation changes', () => {
    const tab = {
      id: 'wt',
      title: 'a.ts',
      kind: 'file',
      source: 'repo',
      path: 'src/a.ts',
      repoContext: 'conversation' as const,
      conversation_id: 'pinned-conv',
    };
    expect(previewTabOpenFileContext(tab, 'other-conv')).toBeNull();
    expect(previewTabOpenFileContext(tab, null)).toBeNull();
    expect(previewTabOpenFileContext(tab, 'pinned-conv')).toMatchObject({
      conversationId: 'pinned-conv',
      repoContext: 'conversationWorktree',
    });
  });

  it('publishes group and artifact context only in its establishing conversation', () => {
    const tab = {
      id: 'artifact',
      title: 'plan.md',
      kind: 'file',
      source: 'group',
      path: 'artifacts/plans/plan.md',
      openFileContextConversationId: 'conversation-a',
    };
    expect(previewTabOpenFileContext(tab, 'conversation-a')).toEqual({
      source: 'artifact',
      path: 'plans/plan.md',
    });
    expect(previewTabOpenFileContext(tab, 'conversation-b')).toBeNull();
    expect(previewTabOpenFileContext(tab, null)).toBeNull();
  });

  it('maps a full source pre caret and selection without copying its text', () => {
    const root = document.createElement('div');
    const pre = document.createElement('pre');
    pre.setAttribute('data-file-lines', '');
    const text = document.createTextNode('first\nsecond line\nthird');
    pre.append(text);
    root.append(pre);
    document.body.append(root);

    expect(sourcePosition(pre, text, 9)).toEqual({ line: 2, column: 4 });
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 18);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selectionLineRange(root, selection)).toEqual({ start: 2, end: 3 });
    expect(root.querySelector('textarea')).toBeNull();
    root.remove();
  });
});
