import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/confirm-dialog';
import { AdminAiUsersPage } from './admin.ai-users';

const api = vi.hoisted(() => ({
  fetchAiUsers: vi.fn(),
  fetchAiUserTeams: vi.fn(),
  fetchRuntimeCatalog: vi.fn(),
  fetchConfig: vi.fn(),
  fetchTtsVoiceCatalog: vi.fn(),
  fetchAiUserAvatarGeneration: vi.fn(),
  fetchAiUserEmoteGeneration: vi.fn(),
  createAiUser: vi.fn(),
  updateAiUser: vi.fn(),
  deleteAiUser: vi.fn(),
  createAiUserTeam: vi.fn(),
  updateAiUserTeam: vi.fn(),
  deleteAiUserTeam: vi.fn(),
  deleteAiUserEmote: vi.fn(),
  chooseAiUserAvatar: vi.fn(),
  draftAiUserAvatarPrompt: vi.fn(),
  draftAiUserPersona: vi.fn(),
  generateAiUserAvatar: vi.fn(),
  generateAiUserEmote: vi.fn(),
  importAiUserVoiceStyle: vi.fn(),
  uploadAiUserAvatar: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: unknown) => unknown) =>
    select({ user: { role: 'admin' } }),
}));
vi.mock('@/lib/use-tts', () => ({
  useTts: () => ({
    activeId: null,
    loading: false,
    toggle: vi.fn(),
    stop: vi.fn(),
  }),
}));
vi.mock('@/lib/device-tts', () => ({ deviceTtsAvailable: () => false }));
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

const persona = {
  id: 'persona-1',
  name: 'Morgan',
  identity: 'Guide',
  presetId: 'preset-1',
  prompt: '---\nidentity: "Guide"\n---\n\nInstructions.',
  enabled: true,
  turn: 'after',
  tools: [],
  voiceId: null,
  voiceLang: null,
  avatarUrl: null,
  emotes: [],
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AdminAiUsersPage />
      <ConfirmDialogHost />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

async function openPersona() {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByText('Morgan'));
  const del = await screen.findByRole('button', { name: 'Delete' });
  return { user, del };
}

beforeEach(() => {
  api.fetchAiUsers.mockResolvedValue([persona]);
  api.fetchAiUserTeams.mockResolvedValue([]);
  api.fetchRuntimeCatalog.mockResolvedValue({
    presets: [{ id: 'preset-1', label: 'Preset one', selection: {} }],
  });
  api.fetchConfig.mockResolvedValue({ ttsEnabled: false });
  api.fetchTtsVoiceCatalog.mockResolvedValue({ defaults: {} });
  api.fetchAiUserAvatarGeneration.mockResolvedValue({ status: 'idle' });
  api.deleteAiUser.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe('AI user delete confirmation', () => {
  it('asks before deleting and keeps the persona when the dialog is cancelled', async () => {
    const { user, del } = await openPersona();

    await user.click(del);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete AI user “Morgan”?');
    expect(api.deleteAiUser).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.deleteAiUser).not.toHaveBeenCalled();

    await user.click(del);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.deleteAiUser).not.toHaveBeenCalled();
  });

  it('deletes the persona once the dialog is confirmed', async () => {
    const { user, del } = await openPersona();

    await user.click(del);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Delete AI user' }));

    await waitFor(() => expect(api.deleteAiUser).toHaveBeenCalledTimes(1));
    expect(api.deleteAiUser).toHaveBeenCalledWith('persona-1');
  });
});

describe('AI user list load failures', () => {
  it('shows the users error with Retry and hides the empty-list hints', async () => {
    api.fetchAiUsers.mockRejectedValue(new Error('users exploded'));
    const user = userEvent.setup();
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('users exploded');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText(/Select an AI user or team/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Team' }));
    expect(screen.queryByText(/Create an AI user before adding/)).toBeNull();
  });

  it('shows the teams error and clears it when Retry succeeds', async () => {
    api.fetchAiUserTeams.mockRejectedValueOnce(new Error('teams exploded'));
    const user = userEvent.setup();
    renderPage();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'teams exploded',
    );
    api.fetchAiUserTeams.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await screen.findByText('Morgan')).toBeTruthy();
  });
});

describe('AI user editor background refetch', () => {
  const other = {
    ...persona,
    id: 'persona-2',
    name: 'Riley',
    prompt: 'Other.',
  };

  it('keeps unsaved prompt edits when the selected row is refetched', async () => {
    api.fetchAiUsers.mockResolvedValue([persona, other]);
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await user.click(await screen.findByText('Morgan'));
    const promptEditor = () =>
      screen.getByRole('textbox', {
        name: 'Prompt Markdown',
      }) as HTMLTextAreaElement;
    const editor = await screen.findByRole('textbox', {
      name: 'Prompt Markdown',
    });
    await waitFor(() => expect(promptEditor().value).toBe(persona.prompt));

    await user.type(editor, ' typed');
    const typed = `${persona.prompt} typed`;
    expect(promptEditor().value).toBe(typed);

    // The renamed list entry marks the moment the refetched row has rendered.
    act(() => {
      queryClient.setQueryData(
        ['admin', 'ai-users'],
        [
          { ...persona, name: 'Morgan v2', avatarCandidateUrl: '/x?v=1' },
          other,
        ],
      );
    });
    await screen.findByText('Morgan v2');
    expect(promptEditor().value).toBe(typed);

    // Selecting a different persona still loads its saved values.
    await user.click(screen.getByText('Riley'));
    await waitFor(() => expect(promptEditor().value).toBe('Other.'));
  });

  it('keeps unsaved team description edits when teams are refetched', async () => {
    const team = {
      id: 'team-1',
      name: 'Crew',
      description: 'Saved description',
      memberIds: [],
    };
    api.fetchAiUserTeams.mockResolvedValue([team]);
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await user.click(await screen.findByText('Saved description'));
    const description = (await screen.findByDisplayValue(
      'Saved description',
    )) as HTMLTextAreaElement;

    await user.type(description, ' typed');
    act(() => {
      queryClient.setQueryData(
        ['admin', 'ai-user-teams'],
        [{ ...team, name: 'Crew renamed' }],
      );
    });
    await screen.findByText('Crew renamed');
    expect(description.value).toBe('Saved description typed');
  });
});
