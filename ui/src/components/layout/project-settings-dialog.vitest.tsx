import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactRouterModule from '@tanstack/react-router';
import type * as ApiModule from '@/lib/api';
import type * as ProjectHooksModule from '@/hooks/use-projects';
import type { Project, ProjectSettings } from '@/types';

const harness = vi.hoisted(() => ({
  summaries: [] as Array<{ id: string; revision: string }>,
  details: new Map<string, unknown>(),
  discover: (_id: string): Promise<unknown> => Promise.resolve(null),
  save: async (_input: unknown): Promise<unknown> => ({ id: 'p' }),
  savePrefs: async (
    _id: string,
    _content: string | null,
  ): Promise<unknown> => ({
    content: '',
  }),
  savePush: async (
    _id: string,
    _enabled: boolean | null,
  ): Promise<unknown> => ({
    enabled: true,
    effective: true,
  }),
  availableAiUsers: async (): Promise<unknown[]> => [],
  availableAiUserTeams: async (): Promise<unknown[]> => [],
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: harness.toastSuccess, error: harness.toastError },
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouterModule>()),
  useNavigate: () => vi.fn(),
}));

// Plain functions (not vi.fn) so `restoreMocks` cannot reset the implementations.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  fetchProjectDetails: async (id: string) => {
    return structuredClone(harness.details.get(id));
  },
  fetchConfig: async () => ({}),
  fetchRuntimeCatalog: async () => ({ version: 2, harnesses: [], models: [] }),
  fetchProjectPreferences: async () => ({ content: '' }),
  fetchProjectPushPref: async () => ({ enabled: null, effective: false }),
  fetchProjectAvailableAiUsers: () => harness.availableAiUsers(),
  fetchProjectAvailableAiUserTeams: () => harness.availableAiUserTeams(),
  fetchProjectStageOccupancy: async () => [],
  discoverProjectRepositories: (id: string) => harness.discover(id),
  updateProjectPreferences: (id: string, content: string | null) =>
    harness.savePrefs(id, content),
  updateProjectPushPref: (id: string, enabled: boolean | null) =>
    harness.savePush(id, enabled),
}));

vi.mock('@/hooks/use-projects', async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectHooksModule>()),
  useProjects: () => ({ data: harness.summaries }),
  useUpdateProjectSettings: () => ({
    isPending: false,
    mutateAsync: harness.save,
  }),
}));

import { useStore } from '@/store';
import { useAuth } from '@/lib/auth';
import { ProjectSettingsDialog } from './project-settings-dialog';

function serve(revision: string, settings: ProjectSettings, boxOnline = true) {
  harness.summaries = [{ id: 'p', revision }];
  harness.details.set('p', {
    id: 'p',
    name: 'Alpha',
    folder: 'alpha',
    revision,
    settings,
    effectiveSandbox: { boxOnline },
  } as unknown as Project);
}

function serveProject(
  id: string,
  settings: ProjectSettings = {},
  revision = 'r1',
) {
  harness.summaries = [
    ...harness.summaries.filter((p) => p.id !== id),
    { id, revision },
  ];
  harness.details.set(id, {
    id,
    name: id,
    folder: id,
    revision,
    userId: 'u1',
    settings,
    effectiveSandbox: { boxOnline: true },
  } as unknown as Project);
}

function renderDialog() {
  const client = new QueryClient({
    // Production default staleTime, so cached lists must be refreshed explicitly.
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <ProjectSettingsDialog />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

async function openPrompts() {
  await userEvent.click(await screen.findByRole('tab', { name: 'Prompts' }));
  return {
    system: (await screen.findByLabelText(
      'System Prompt',
    )) as HTMLTextAreaElement,
    worker: (await screen.findByLabelText(
      'Worker Prompt',
    )) as HTMLTextAreaElement,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  harness.details.clear();
  harness.summaries = [];
  useAuth.setState({
    user: { id: 'u1', username: 'u', role: 'admin' } as never,
  });
  useStore.getState().setSettingsProjectId('p');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useStore.getState().setSettingsProjectId(null);
});

describe('ProjectSettingsDialog revision changes', () => {
  it('keeps an edited field while an unedited prompt takes the server value', async () => {
    serve('r1', { systemPrompt: 'sys', workerPrompt: 'work' });
    const { rerender } = renderDialog();
    const { system, worker } = await openPrompts();
    await waitFor(() => expect(system.value).toBe('sys'));
    await userEvent.clear(system);
    await userEvent.type(system, 'mine');

    serve('r2', { systemPrompt: 'sys', workerPrompt: 'work from agent' });
    rerender();

    await waitFor(() => expect(worker.value).toBe('work from agent'));
    expect(system.value).toBe('mine');
  });

  it('keeps the draft and Save enabled when runtime fields change', async () => {
    serve('r1', { systemPrompt: 'sys', workerPrompt: 'work' });
    const { rerender } = renderDialog();
    const { system, worker } = await openPrompts();
    await waitFor(() => expect(system.value).toBe('sys'));
    await userEvent.type(system, ' edited');

    // Runtime fields flip (box offline, brain token rejected). The unedited
    // worker prompt changes too, which proves r2 reached the draft before the
    // assertions below.
    serve(
      'r2',
      {
        systemPrompt: 'sys',
        workerPrompt: 'work r2',
        brainAuthRejected: { status: 401, at: '2026-10-18T09:30:00Z' },
      },
      false,
    );
    rerender();

    const save = screen.getByRole('button', {
      name: 'Save',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await waitFor(() => expect(worker.value).toBe('work r2'));
    expect(system.value).toBe('sys edited');
    expect(save.disabled).toBe(false);
  });
});

describe('ProjectSettingsDialog repository validation', () => {
  it('blocks Save with an inline error while Default Branch is invalid and clears when fixed', async () => {
    serve('r1', { defaultBranch: 'develop' });
    renderDialog();
    await userEvent.click(
      await screen.findByRole('tab', { name: 'Repository' }),
    );
    const branch = (await screen.findByLabelText(
      'Default Branch',
    )) as HTMLInputElement;
    await waitFor(() => expect(branch.value).toBe('develop'));
    const save = screen.getByRole('button', {
      name: 'Save',
    }) as HTMLButtonElement;

    await userEvent.clear(branch);
    await userEvent.type(branch, 'bad branch name..');
    expect(
      document.querySelector(
        '[data-ui="project-settings-default-branch-error"]',
      ),
    ).not.toBeNull();
    expect(save.disabled).toBe(true);
    expect(
      document.querySelector('[data-ui="project-settings-save-blocked"]')
        ?.textContent,
    ).toContain('default branch');

    await userEvent.clear(branch);
    await userEvent.type(branch, 'release-1.2');
    expect(
      document.querySelector(
        '[data-ui="project-settings-default-branch-error"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-ui="project-settings-save-blocked"]'),
    ).toBeNull();
    expect(save.disabled).toBe(false);
  });
});

describe('ProjectSettingsDialog dismissal with unsaved edits', () => {
  async function editWorker() {
    serve('r1', { systemPrompt: 'sys', workerPrompt: 'work' });
    renderDialog();
    const { worker } = await openPrompts();
    await waitFor(() => expect(worker.value).toBe('work'));
    return worker;
  }

  it('asks before Escape discards edits; keep editing preserves them, discard closes', async () => {
    const worker = await editWorker();
    await userEvent.type(worker, ' edited');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await userEvent.keyboard('{Escape}');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useStore.getState().settingsProjectId).toBe('p');
    expect(worker.value).toBe('work edited');

    confirm.mockReturnValue(true);
    await userEvent.keyboard('{Escape}');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(useStore.getState().settingsProjectId).toBeNull();
    confirm.mockRestore();
  });

  it('stays pristine when a server revision adds a property out of order', async () => {
    serve('r1', { systemPrompt: 'sys', chatModes: [] });
    const { rerender } = renderDialog();
    const { worker } = await openPrompts();
    await waitFor(() => expect(worker.value).toBe(''));

    // The new property precedes existing ones in the server payload but is
    // appended after them in the merged draft.
    serve('r2', {
      workerPrompt: 'from agent',
      systemPrompt: 'sys',
      chatModes: [],
    });
    rerender();
    await waitFor(() => expect(worker.value).toBe('from agent'));

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.keyboard('{Escape}');
    expect(confirm).not.toHaveBeenCalled();
    expect(useStore.getState().settingsProjectId).toBeNull();
    confirm.mockRestore();
  });

  it('asks before discarding a typed but uncommitted stage suffix', async () => {
    serve('r1', {
      stages: [
        { id: 'coding', title: 'Coding', type: 'active', color: 'blue' },
        { id: 'coding.b', title: 'Coding B', type: 'active', color: 'blue' },
      ],
    } as ProjectSettings);
    renderDialog();
    await userEvent.click(await screen.findByRole('tab', { name: 'Board' }));
    await userEvent.click(await screen.findByText('coding.b'));
    const suffix = await screen.findByLabelText('Variant suffix');
    await userEvent.clear(suffix);
    await userEvent.type(suffix, 'fast');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.keyboard('{Escape}');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useStore.getState().settingsProjectId).toBe('p');
    confirm.mockRestore();
  });

  it('closes a pristine dialog without prompting', async () => {
    await editWorker();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await userEvent.keyboard('{Escape}');
    expect(confirm).not.toHaveBeenCalled();
    expect(useStore.getState().settingsProjectId).toBeNull();
    confirm.mockRestore();
  });

  it('closes after Save without prompting', async () => {
    const worker = await editWorker();
    await userEvent.type(worker, ' edited');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(useStore.getState().settingsProjectId).toBeNull(),
    );
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe('ProjectSettingsDialog save feedback', () => {
  beforeEach(() => {
    serve('r1', {});
    harness.toastSuccess.mockClear();
    harness.toastError.mockClear();
  });
  afterEach(() => {
    harness.save = async () => ({ id: 'p' });
    harness.savePrefs = async () => ({ content: '' });
    harness.savePush = async () => ({ enabled: true, effective: true });
  });

  async function editPreferences(kind: 'prefs' | 'push') {
    renderDialog();
    await userEvent.click(
      await screen.findByRole('tab', { name: 'My preferences' }),
    );
    if (kind === 'prefs') {
      await userEvent.type(
        await screen.findByLabelText('Your Preferences for This Project'),
        'be brief',
      );
    } else {
      await userEvent.click(
        await screen.findByLabelText(
          'Receive push notifications from this project',
        ),
      );
    }
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('shows one success toast and closes when all saves succeed', async () => {
    await editPreferences('prefs');
    await waitFor(() =>
      expect(useStore.getState().settingsProjectId).toBeNull(),
    );
    expect(harness.toastSuccess).toHaveBeenCalledTimes(1);
    expect(harness.toastSuccess).toHaveBeenCalledWith('Settings saved');
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  it.each([
    ['prefs', 'Failed to save preferences: boom'],
    ['push', 'Failed to save push preference: boom'],
  ] as const)(
    'shows only the error toast and stays open when %s save fails',
    async (kind, message) => {
      const reject = async () => {
        throw new Error('boom');
      };
      if (kind === 'prefs') harness.savePrefs = reject;
      else harness.savePush = reject;

      await editPreferences(kind);
      await waitFor(() =>
        expect(harness.toastError).toHaveBeenCalledWith(message),
      );
      expect(harness.toastSuccess).not.toHaveBeenCalled();
      expect(useStore.getState().settingsProjectId).toBe('p');
    },
  );
});

describe('ProjectSettingsDialog project switches', () => {
  it('ignores a discovery report that resolves after switching projects', async () => {
    const shared: ProjectSettings = {
      isParent: true,
      sandboxOwnership: 'shared',
      sharedWorkspaceHostLocation: '/host',
      sharedWorkspaceContainerRoot: '/workspace',
    };
    serveProject('p', shared);
    serveProject('q', shared);
    let resolveDiscovery: (report: unknown) => void = () => {};
    harness.discover = () =>
      new Promise((resolve) => {
        resolveDiscovery = resolve;
      });
    renderDialog();
    await userEvent.click(await screen.findByRole('tab', { name: 'Sandbox' }));
    const discover = (await screen.findByRole('button', {
      name: /Discover now/,
    })) as HTMLButtonElement;
    await userEvent.click(discover);
    await waitFor(() => expect(discover.disabled).toBe(true));

    act(() => useStore.getState().setSettingsProjectId('q'));
    const sandboxTab = await screen.findByRole('tab', { name: 'Sandbox' });
    if (sandboxTab.getAttribute('aria-selected') !== 'true') {
      await userEvent.click(sandboxTab);
    }
    const next = (await screen.findByRole('button', {
      name: /Discover now/,
    })) as HTMLButtonElement;
    // Project q is loaded and p's pending request must not keep it disabled.
    expect(next.disabled).toBe(false);

    await act(async () => {
      resolveDiscovery({
        created: [{ path: 'repo-from-p' }],
        existing: [],
        ignored: [],
        ambiguous: [],
        missing: [],
      });
    });
    expect(screen.queryByText(/1 created/)).toBeNull();
    expect(next.disabled).toBe(false);
  });
});

describe('ProjectSettingsDialog stale persona defaults', () => {
  afterEach(() => {
    harness.save = async () => ({ id: 'p' });
    harness.availableAiUsers = async () => [];
    harness.availableAiUserTeams = async () => [];
  });

  it('waits for pending availability and saves without the stale ids', async () => {
    serve('r1', {
      defaultMainAiUserId: 'disabled',
      defaultInvitedAiUserIds: ['disabled', 'mara'],
      defaultInvitedAiUserTeamIds: ['deleted-team'],
    });
    harness.availableAiUsers = async () => [{ id: 'mara' }];
    let releaseTeams: () => void = () => {};
    const teamsGate = new Promise<void>((resolve) => {
      releaseTeams = resolve;
    });
    harness.availableAiUserTeams = async () => {
      await teamsGate;
      return [];
    };
    const saved: Array<{ settings: ProjectSettings }> = [];
    harness.save = async (input) => {
      saved.push(input as { settings: ProjectSettings });
      return { id: 'p' };
    };

    renderDialog();
    const name = await screen.findByLabelText('Project Name');
    await userEvent.type(name, ' renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saved).toHaveLength(0);

    releaseTeams();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].settings.defaultMainAiUserId).toBeNull();
    expect(saved[0].settings.defaultInvitedAiUserIds).toEqual(['mara']);
    expect(saved[0].settings.defaultInvitedAiUserTeamIds).toEqual([]);
  });

  it('prunes personas disabled after the cached availability was fetched', async () => {
    serve('r1', { defaultInvitedAiUserIds: ['mara', 'gone'] });
    harness.availableAiUsers = async () => [{ id: 'mara' }, { id: 'gone' }];
    const saved: Array<{ settings: ProjectSettings }> = [];
    harness.save = async (input) => {
      saved.push(input as { settings: ProjectSettings });
      return { id: 'p' };
    };

    renderDialog();
    const name = await screen.findByLabelText('Project Name');
    // The first lists are now cached and fresh; 'gone' is disabled afterwards.
    harness.availableAiUsers = async () => [{ id: 'mara' }];
    await userEvent.type(name, ' renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].settings.defaultInvitedAiUserIds).toEqual(['mara']);
  });

  it('does not send a pending save to a project opened while availability loaded', async () => {
    serve('r1', { defaultInvitedAiUserIds: ['gone'] });
    serveProject('q');
    let releaseUsers: () => void = () => {};
    const usersGate = new Promise<void>((resolve) => {
      releaseUsers = resolve;
    });
    harness.availableAiUsers = async () => {
      await usersGate;
      return [];
    };
    const saved: unknown[] = [];
    harness.save = async (input) => {
      saved.push(input);
      return { id: 'p' };
    };

    renderDialog();
    await userEvent.type(await screen.findByLabelText('Project Name'), ' x');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeTruthy();

    act(() => useStore.getState().setSettingsProjectId('q'));
    releaseUsers();
    await screen.findByRole('button', { name: 'Save' });
    expect(saved).toHaveLength(0);
  });
});

describe('ProjectSettingsDialog repository connection by role', () => {
  const connection = {
    repositoryLocation: '/host/repo',
    repositoryUrl: 'https://example.com/org/repo',
    repositoryRelativePath: 'sub',
    sharedWorkspaceHostLocation: '/host',
  };
  const fields = Object.keys(connection);
  let saved: Array<{ settings: Record<string, unknown> }>;
  let prefsSaved: Array<string | null>;

  beforeEach(() => {
    saved = [];
    prefsSaved = [];
    harness.save = async (input) => {
      saved.push(input as (typeof saved)[number]);
      return { id: 'p' };
    };
    harness.savePrefs = async (_id, content) => {
      prefsSaved.push(content);
      return { content: content ?? '' };
    };
  });
  afterEach(() => {
    harness.save = async () => ({ id: 'p' });
    harness.savePrefs = async () => ({ content: '' });
  });

  function serveAs(
    role: 'admin' | 'user',
    accessLevel: 'owner' | 'editor' | null,
    // An admin keeps full rights only on a project without another user as owner.
    userId: string | null = 'someone-else',
  ) {
    serve('r1', connection);
    harness.details.set('p', {
      ...(harness.details.get('p') as object),
      userId,
      accessLevel,
    });
    useAuth.setState({ user: { id: 'u1', username: 'u', role } as never });
  }

  async function saveWithPreferences() {
    renderDialog();
    await userEvent.click(
      await screen.findByRole('tab', { name: 'My preferences' }),
    );
    await userEvent.type(
      await screen.findByLabelText('Your Preferences for This Project'),
      'be brief',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
  }

  it.each([
    ['an editor', 'user'],
    ["an admin on another user's project", 'admin'],
  ] as const)(
    'omits the repository connection fields for %s and still saves preferences',
    async (_label, role) => {
      serveAs(role, 'editor');
      await saveWithPreferences();
      for (const field of fields)
        expect(saved[0].settings).not.toHaveProperty(field);
      await waitFor(() => expect(prefsSaved).toEqual(['be brief']));
    },
  );

  it.each([
    ['owner', 'user', 'owner', 'someone-else'],
    ['admin on a project without an owner', 'admin', 'editor', null],
  ] as const)(
    'keeps the repository connection fields for an %s',
    async (_label, role, level, userId) => {
      serveAs(role, level, userId);
      await saveWithPreferences();
      expect(saved[0].settings).toMatchObject(connection);
    },
  );
});
