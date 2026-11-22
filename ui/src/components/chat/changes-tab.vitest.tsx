import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationDiff } from '@/types';
import { ChangesTab } from './changes-tab';

const api = vi.hoisted(() => ({
  getConversationDiff: vi.fn(),
  commitConversationChanges: vi.fn(),
  suggestConversationCommitMessage: vi.fn(),
  mergeConversationWorktree: vi.fn(),
  discardConversationWorktree: vi.fn(),
  updateConversationGitIndex: vi.fn(),
}));

vi.mock('@/lib/api', () => api);

const conversation: Conversation = {
  id: 'conv-worktree',
  group_folder: 'project-one',
  preview: null,
  created_at: '2026-08-27T00:00:00.000Z',
  use_worktree: true,
  branch_name: null,
};

function renderChangesTab(diff: ConversationDiff) {
  api.getConversationDiff.mockResolvedValue(diff);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(['conversations', 'project-one'], {
    pages: [[conversation]],
    pageParams: [undefined],
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChangesTab project_id="project-one" conversation_id={conversation.id} />
    </QueryClientProvider>,
  );
}

describe('ChangesTab conversation worktree actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stages and unstages individual files and commits the staged selection', async () => {
    api.updateConversationGitIndex.mockResolvedValue({ ok: true });
    api.commitConversationChanges.mockResolvedValue({ ok: true });
    renderChangesTab({
      available: true,
      scope: 'worktree',
      base: 'develop',
      branch: `chat-${conversation.id}`,
      files: [
        { path: 'staged.txt', additions: 1, deletions: 0 },
        { path: 'unstaged.txt', additions: 1, deletions: 0 },
      ],
      patch:
        'diff --git a/staged.txt b/staged.txt\ndiff --git a/unstaged.txt b/unstaged.txt',
      uncommitted: true,
      changeSections: [
        { kind: 'committed', files: [], patch: '' },
        {
          kind: 'staged',
          files: [{ path: 'staged.txt', additions: 1, deletions: 0 }],
          patch: 'diff --git a/staged.txt b/staged.txt',
        },
        {
          kind: 'unstaged',
          files: [{ path: 'unstaged.txt', additions: 1, deletions: 0 }],
          patch: 'diff --git a/unstaged.txt b/unstaged.txt',
        },
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Unstage' }));
    await waitFor(() =>
      expect(api.updateConversationGitIndex).toHaveBeenCalledWith(
        'project-one',
        conversation.id,
        'staged.txt',
        'unstage',
        undefined,
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /^Stage$/ })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Stage$/ }));
    await waitFor(() =>
      expect(api.updateConversationGitIndex).toHaveBeenCalledWith(
        'project-one',
        conversation.id,
        'unstaged.txt',
        'stage',
        undefined,
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Stage all' })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stage all' }));
    await waitFor(() =>
      expect(api.updateConversationGitIndex).toHaveBeenCalledWith(
        'project-one',
        conversation.id,
        undefined,
        'stageAll',
        undefined,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Commit$/ }));
    fireEvent.change(screen.getByPlaceholderText('Commit message'), {
      target: { value: 'Save selected file' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }));
    await waitFor(() =>
      expect(api.commitConversationChanges).toHaveBeenCalledWith(
        'project-one',
        conversation.id,
        'Save selected file',
        true,
      ),
    );
  });

  it('offers merge when the owned worktree has changes', async () => {
    api.mergeConversationWorktree.mockResolvedValue({
      ok: true,
      branch: `chat-${conversation.id}`,
      base: 'main',
      worktreeRemoved: false,
    });
    renderChangesTab({
      available: true,
      scope: 'worktree',
      base: 'main',
      branch: `chat-${conversation.id}`,
      files: [{ path: 'src/example.ts', additions: 2, deletions: 0 }],
      patch: 'diff --git a/src/example.ts b/src/example.ts',
      uncommitted: true,
    });

    const merge = await screen.findByRole('button', { name: 'Merge' });
    const discard = screen.getByRole('button', { name: 'Discard' });

    fireEvent.click(merge);
    expect(screen.getByText('Merge into main')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen
        .getByRole('checkbox', { name: 'Remove worktree after merge' })
        .getAttribute('data-state'),
    ).toBe('unchecked');
    fireEvent.change(screen.getByPlaceholderText('Commit message'), {
      target: { value: 'fix: merge the conversation changes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Merge changes' }));

    await waitFor(() =>
      expect(api.mergeConversationWorktree).toHaveBeenCalledWith(
        'project-one',
        conversation.id,
        false,
        'fix: merge the conversation changes',
      ),
    );
  });

  it('commits uncommitted changes on an owned worktree without merging', async () => {
    api.commitConversationChanges.mockResolvedValue({ ok: true });
    renderChangesTab({
      available: true,
      scope: 'worktree',
      base: 'develop',
      branch: `chat-${conversation.id}`,
      files: [{ path: 'src/example.ts', additions: 2, deletions: 0 }],
      patch: 'diff --git a/src/example.ts b/src/example.ts',
      uncommitted: true,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Commit' }));
    expect(screen.getByText('Commit conversation changes')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Commit message'), {
      target: { value: 'fix: checkpoint the conversation changes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }));

    await waitFor(() =>
      expect(api.commitConversationChanges).toHaveBeenCalledWith(
        'project-one',
        conversation.id,
        'fix: checkpoint the conversation changes',
      ),
    );
    expect(api.mergeConversationWorktree).not.toHaveBeenCalled();
  });

  it('merges already-committed changes without requesting a commit message', async () => {
    api.mergeConversationWorktree.mockResolvedValue({
      ok: true,
      branch: `chat-${conversation.id}`,
      base: 'develop',
      worktreeRemoved: true,
    });
    renderChangesTab({
      available: true,
      scope: 'worktree',
      base: 'develop',
      branch: `chat-${conversation.id}`,
      files: [{ path: 'src/example.ts', additions: 1, deletions: 0 }],
      patch: 'diff --git a/src/example.ts b/src/example.ts',
      uncommitted: false,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    expect(screen.queryByPlaceholderText('Commit message')).toBeNull();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Remove worktree after merge' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Merge changes' }));

    await waitFor(() =>
      expect(api.mergeConversationWorktree).toHaveBeenCalledWith(
        'project-one',
        conversation.id,
        true,
        undefined,
      ),
    );
  });

  it('ignores a merge result from a previously selected conversation', async () => {
    const convB: Conversation = { ...conversation, id: 'conv-b' };
    const diffFor = (id: string): ConversationDiff => ({
      available: true,
      scope: 'worktree',
      base: 'develop',
      branch: `chat-${id}`,
      files: [{ path: `src/${id}.ts`, additions: 1, deletions: 0 }],
      patch: `diff --git a/src/${id}.ts b/src/${id}.ts`,
      uncommitted: true,
    });
    api.getConversationDiff.mockImplementation(
      async (_project: string, id: string) => diffFor(id),
    );
    let resolveMerge!: (value: unknown) => void;
    api.mergeConversationWorktree.mockReturnValue(
      new Promise((resolve) => {
        resolveMerge = resolve;
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['conversations', 'project-one'], {
      pages: [[conversation, convB]],
      pageParams: [undefined],
    });
    // Mirrors how ConversationExplorer keys the tab per conversation.
    function Harness() {
      const [id, setId] = useState(conversation.id);
      return (
        <>
          <button type="button" onClick={() => setId(convB.id)}>
            Select B
          </button>
          <ChangesTab
            key={`project-one:${id}`}
            project_id="project-one"
            conversation_id={id}
          />
        </>
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.change(screen.getByPlaceholderText('Commit message'), {
      target: { value: 'merge A' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Merge changes' }));
    await waitFor(() => expect(queryClient.isMutating()).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'Select B' }));
    await screen.findByText('src/conv-b.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    fireEvent.change(screen.getByPlaceholderText('Commit message'), {
      target: { value: 'draft for B' },
    });

    resolveMerge({
      ok: true,
      branch: 'chat-conv-worktree',
      base: 'develop',
      worktreeRemoved: true,
    });
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));

    expect(screen.getByRole('button', { name: 'Merge' })).toBeTruthy();
    expect(
      (screen.getByPlaceholderText('Commit message') as HTMLTextAreaElement)
        .value,
    ).toBe('draft for B');
  });
});

describe('ChangesTab first commit', () => {
  it('reviews initial files and commits only after submitting the form', async () => {
    api.getConversationDiff.mockResolvedValue({
      available: true,
      scope: 'working-tree',
      repositoryState: 'unborn',
      branch: 'develop',
      files: [{ path: 'app.txt', additions: 1, deletions: 0 }],
      patch:
        'diff --git a/app.txt b/app.txt\nnew file mode 100644\n--- /dev/null\n+++ b/app.txt\n@@ -0,0 +1 @@\n+hello\n',
    });
    api.commitConversationChanges.mockClear();
    api.commitConversationChanges.mockResolvedValue({ ok: true });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ChangesTab project_id="initial-project" conversation_id={null} />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create first commit' }),
    );
    expect(screen.getByText('Create first commit on develop')).toBeTruthy();
    expect(screen.getByPlaceholderText('Commit message')).toHaveProperty(
      'value',
      'Initial commit',
    );
    expect(api.commitConversationChanges).not.toHaveBeenCalled();
    api.getConversationDiff.mockResolvedValue({
      available: true,
      scope: 'working-tree',
      files: [],
      patch: '',
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Create first commit' }).at(-1)!,
    );
    await waitFor(() =>
      expect(api.commitConversationChanges).toHaveBeenCalledWith(
        'initial-project',
        null,
        'Initial commit',
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Create first commit' }),
      ).toBeNull(),
    );
  });
});
