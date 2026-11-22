import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseOption, selectedLabel } from '@/test-utils/select';

const api = vi.hoisted(() => ({
  searchUsers: vi.fn(),
  listProjectMembers: vi.fn(),
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
  listConversationMembers: vi.fn(),
  getConversationPublicShare: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ...api,
  listKbMembers: vi.fn(),
  addKbMember: vi.fn(),
  removeKbMember: vi.fn(),
  addConversationMember: vi.fn(),
  removeConversationMember: vi.fn(),
  enableConversationPublicShare: vi.fn(),
  regenerateConversationPublicShare: vi.fn(),
  revokeConversationPublicShare: vi.fn(),
  setConversationPublicVisitorPrompts: vi.fn(),
  ApiError: class ApiError extends Error {
    status = 0;
  },
}));

import { ShareDialog } from './share-dialog';

interface Member {
  user_id: string;
  username: string;
  access_level: string;
}

const owner: Member = {
  user_id: 'u-owner',
  username: 'alice',
  access_level: 'owner',
};
const bob = { id: 'u-bob', username: 'bob' };

describe('ShareDialog load effects', () => {
  beforeEach(() => {
    api.searchUsers.mockResolvedValue([bob]);
  });

  it('does not refetch members or the public link when re-rendered with an equal inline target', async () => {
    api.listConversationMembers.mockResolvedValue([owner]);
    api.getConversationPublicShare.mockResolvedValue({
      active: false,
      url: null,
      createdAt: null,
      updatedAt: null,
      allowVisitorPrompts: false,
      visitorPromptingAvailable: false,
      visitorPromptingUnavailableReason: null,
    });
    const client = new QueryClient();
    const renderDialog = () => (
      <QueryClientProvider client={client}>
        <ShareDialog
          open
          onOpenChange={() => {}}
          target={{
            kind: 'conversation',
            projectId: 'p1',
            conversationId: 'c1',
          }}
        />
      </QueryClientProvider>
    );
    const view = render(renderDialog());
    await screen.findByText('alice');
    view.rerender(renderDialog());
    view.rerender(renderDialog());
    await act(async () => {});
    expect(api.listConversationMembers).toHaveBeenCalledTimes(1);
    expect(api.getConversationPublicShare).toHaveBeenCalledTimes(1);
  });

  it('keeps the post-add member list and busy state when a slower earlier members fetch resolves', async () => {
    let serverMembers: Member[] = [owner];
    const pendingFetches: Array<{
      snapshot: Member[];
      resolve: () => void;
      settled: boolean;
    }> = [];
    api.listProjectMembers.mockImplementation(
      () =>
        new Promise<Member[]>((resolve) => {
          const snapshot = serverMembers;
          const entry = {
            snapshot,
            settled: false,
            resolve: () => {
              entry.settled = true;
              resolve(snapshot);
            },
          };
          pendingFetches.push(entry);
        }),
    );
    let releaseAdd!: () => void;
    api.addProjectMember.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseAdd = () => {
            serverMembers = [
              owner,
              { user_id: bob.id, username: 'bob', access_level: 'viewer' },
            ];
            resolve();
          };
        }),
    );

    const client = new QueryClient();
    const renderDialog = () => (
      <QueryClientProvider client={client}>
        <ShareDialog
          open
          onOpenChange={() => {}}
          target={{ kind: 'project', projectId: 'p1' }}
        />
      </QueryClientProvider>
    );
    const view = render(renderDialog());
    await waitFor(() => expect(pendingFetches).toHaveLength(1));
    await act(async () => pendingFetches[0].resolve());
    await screen.findByText('alice');

    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.addProjectMember).toHaveBeenCalledTimes(1));

    // A parent re-render passes an equal but new target object while Add is in flight.
    view.rerender(renderDialog());

    await act(async () => releaseAdd());
    // The post-add fetch is always the most recently started one.
    await waitFor(() => {
      expect(pendingFetches.at(-1)!.snapshot).toContain(serverMembers[1]);
    });
    const postAdd = pendingFetches.at(-1)!;

    // Any earlier in-flight fetch resolving late must not overwrite the list or clear busy.
    await act(async () => {
      for (const entry of pendingFetches.slice(1)) {
        if (entry !== postAdd) entry.resolve();
      }
    });
    expect(
      (screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => postAdd.resolve());
    expect(
      await screen.findByRole('button', { name: 'Already shared' }),
    ).toBeTruthy();
    expect(screen.getAllByText('bob').length).toBeGreaterThan(0);
    expect(api.addProjectMember).toHaveBeenCalledTimes(1);
  });
});

describe('ShareDialog failed loads', () => {
  function renderProjectDialog() {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <ShareDialog
          open
          onOpenChange={() => {}}
          target={{ kind: 'project', projectId: 'p1' }}
        />
      </QueryClientProvider>,
    );
  }

  it('distinguishes a failed user search from an empty one and names the inputs', async () => {
    api.listProjectMembers.mockResolvedValue([owner]);
    api.searchUsers.mockRejectedValueOnce(new Error('boom'));
    renderProjectDialog();
    expect(await screen.findByText('Search failed')).toBeTruthy();
    expect(screen.queryByText('No users found')).toBeNull();
    expect(
      screen.getByRole('textbox', { name: 'Find a user by username' }),
    ).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Access level' })).toBeTruthy();

    api.searchUsers.mockResolvedValue([]);
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Find a user by username' }),
      { target: { value: 'zzz' } },
    );
    expect(await screen.findByText('No users found')).toBeTruthy();
    expect(screen.queryByText('Search failed')).toBeNull();
  });

  it('shows the empty failure state when the initial member load fails', async () => {
    api.searchUsers.mockResolvedValue([bob]);
    api.listProjectMembers.mockRejectedValueOnce(new Error('load failed'));
    renderProjectDialog();
    expect(await screen.findByText('Could not load members.')).toBeTruthy();
    expect(screen.queryByText('alice')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('ShareDialog mutation succeeds but member reload fails', () => {
  const viewerBob = {
    user_id: bob.id,
    username: 'bob',
    access_level: 'viewer',
  };

  function renderProjectDialog() {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <ShareDialog
          open
          onOpenChange={() => {}}
          target={{ kind: 'project', projectId: 'p1' }}
        />
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    api.searchUsers.mockResolvedValue([bob]);
    api.addProjectMember.mockReset();
    api.removeProjectMember.mockReset();
    api.listProjectMembers.mockReset();
  });

  it('warns that the add succeeded, keeps the stale list, and recovers on Retry', async () => {
    api.listProjectMembers.mockResolvedValueOnce([owner]);
    api.addProjectMember.mockResolvedValue(undefined);
    renderProjectDialog();
    await screen.findByText('alice');

    api.listProjectMembers.mockRejectedValueOnce(new Error('reload boom'));
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    const alert = await screen.findByText(
      'Added bob, but the member list could not be refreshed.',
    );
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(screen.queryByText(/reload boom/)).toBeNull();
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('List may be out of date')).toBeTruthy();

    api.listProjectMembers.mockResolvedValueOnce([owner, { ...viewerBob }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('button', { name: 'Already shared' }),
    ).toBeTruthy();
    expect(screen.queryByText(/could not be refreshed/)).toBeNull();
    expect(screen.queryByText('List may be out of date')).toBeNull();
    expect(api.addProjectMember).toHaveBeenCalledTimes(1);
  });

  it('warns that the remove succeeded and recovers on Retry', async () => {
    api.listProjectMembers.mockResolvedValueOnce([owner, viewerBob]);
    api.removeProjectMember.mockResolvedValue(undefined);
    renderProjectDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    api.listProjectMembers.mockRejectedValueOnce(new Error('reload boom'));
    expect(
      await screen.findByText(
        'Removed, but the member list could not be refreshed.',
      ),
    ).toBeTruthy();

    api.listProjectMembers.mockResolvedValueOnce([owner]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.queryByText(/could not be refreshed/)).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getByText('alice')).toBeTruthy();
  });

  it('shows the error and leaves the list untouched when the add POST rejects', async () => {
    api.listProjectMembers.mockResolvedValueOnce([owner]);
    api.addProjectMember.mockRejectedValueOnce(new Error('nope'));
    renderProjectDialog();
    await screen.findByText('alice');

    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    expect(await screen.findByText('nope')).toBeTruthy();
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.queryByText(/could not be refreshed/)).toBeNull();
    expect(screen.queryByText('List may be out of date')).toBeNull();
    expect(api.listProjectMembers).toHaveBeenCalledTimes(1);
  });
});

describe('ShareDialog changing an existing member level', () => {
  const viewerBob = {
    user_id: bob.id,
    username: 'bob',
    access_level: 'viewer',
  };

  function renderProjectDialog() {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <ShareDialog
          open
          onOpenChange={() => {}}
          target={{ kind: 'project', projectId: 'p1' }}
        />
      </QueryClientProvider>,
    );
  }

  it('re-adds the member with the new level and shows it after reload; owner has no select', async () => {
    api.searchUsers.mockResolvedValue([]);
    api.listProjectMembers.mockResolvedValueOnce([owner, viewerBob]);
    api.addProjectMember.mockResolvedValue(undefined);
    renderProjectDialog();

    const select = (await screen.findByRole('combobox', {
      name: 'Access level for bob',
    })) as HTMLButtonElement;
    expect(selectedLabel(select)).toBe('Viewer');
    expect(
      screen.queryByRole('combobox', { name: 'Access level for alice' }),
    ).toBeNull();

    api.listProjectMembers.mockResolvedValueOnce([
      owner,
      { ...viewerBob, access_level: 'editor' },
    ]);
    await chooseOption(select, 'Editor');
    await waitFor(() =>
      expect(api.addProjectMember).toHaveBeenCalledWith('p1', bob.id, 'editor'),
    );
    await waitFor(() =>
      expect(
        selectedLabel(
          screen.getByRole('combobox', {
            name: 'Access level for bob',
          }),
        ),
      ).toBe('Editor'),
    );
  });

  it('shows the error and keeps the old level when the API rejects', async () => {
    api.searchUsers.mockResolvedValue([]);
    api.listProjectMembers.mockResolvedValueOnce([owner, viewerBob]);
    api.addProjectMember.mockRejectedValueOnce(new Error('nope'));
    renderProjectDialog();

    const select = (await screen.findByRole('combobox', {
      name: 'Access level for bob',
    })) as HTMLButtonElement;
    await chooseOption(select, 'Editor');
    expect(await screen.findByText('nope')).toBeTruthy();
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(selectedLabel(select)).toBe('Viewer');
  });
});
