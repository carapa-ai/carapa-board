import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreferencesCard } from '@/components/account/preferences-card';
import {
  fetchAccountPreferences,
  fetchAccountAvatarGeneration,
  generateAccountAvatar,
  updateAccountPreferences,
  chooseAccountAvatar,
} from '@/lib/api';

const { refreshAuthUser } = vi.hoisted(() => ({
  refreshAuthUser: vi.fn(async () => null),
}));
vi.mock('@/lib/auth', () => ({
  refreshAuthUser,
  useAuth: (
    selector: (state: { user: { id: string; username: string } }) => unknown,
  ) => selector({ user: { id: 'user-1', username: 'login-name' } }),
}));

vi.mock('@/lib/api', () => ({
  fetchAccountPreferences: vi.fn(async () => ({
    content: null,
    dictationLanguage: 'ro',
    displayName: null,
    avatarUrl: null,
    avatarCandidateUrl: null,
  })),
  fetchConfig: vi.fn(async () => ({
    meetingLanguages: [{ code: 'ro', label: 'Romanian', script: 'latin' }],
  })),
  updateAccountPreferences: vi.fn(
    async (
      content: string | null,
      dictationLanguage?: string | null,
      displayName?: string | null,
    ) => ({
      content,
      dictationLanguage: dictationLanguage ?? null,
      displayName: displayName ?? null,
      avatarUrl: null,
      avatarCandidateUrl: null,
    }),
  ),
  fetchAccountAvatarGeneration: vi.fn(async () => ({
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    error: null,
  })),
  generateAccountAvatar: vi.fn(),
  chooseAccountAvatar: vi.fn(),
  uploadAccountAvatar: vi.fn(),
}));

describe('account dictation preferences', () => {
  it('does not turn an unset preference into explicit Auto when saving prompt text', async () => {
    vi.mocked(fetchAccountPreferences).mockResolvedValueOnce({
      content: null,
      dictationLanguage: null,
      displayName: null,
      avatarUrl: null,
      avatarCandidateUrl: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesCard />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="account-preferences-input"]'),
      ).toBeTruthy(),
    );
    const textarea = document.querySelector(
      '[data-ui="account-preferences-input"]',
    )!;
    fireEvent.change(textarea, { target: { value: 'New prompt notes' } });
    const saveButton = screen
      .getAllByRole('button', { name: 'Save' })
      .find((button) => !(button as HTMLButtonElement).disabled);
    fireEvent.click(saveButton!);
    await waitFor(() => expect(updateAccountPreferences).toHaveBeenCalled());
    expect(updateAccountPreferences).toHaveBeenCalledWith(
      'New prompt notes',
      undefined,
      undefined,
    );
  });

  it('edits the display name through the mounted profile form and refreshes auth state', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesCard />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="account-display-name-input"]'),
      ).toBeTruthy(),
    );
    const displayName = document.querySelector(
      '[data-ui="account-display-name-input"]',
    )!;
    fireEvent.change(displayName, { target: { value: 'Human Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateAccountPreferences).toHaveBeenCalledWith(
        undefined,
        undefined,
        'Human Name',
      ),
    );
    await waitFor(() => expect(refreshAuthUser).toHaveBeenCalled());
  });

  it('renders current/candidate comparison and starts avatar generation', async () => {
    vi.mocked(fetchAccountPreferences).mockResolvedValueOnce({
      content: null,
      dictationLanguage: null,
      displayName: 'Human Name',
      avatarUrl: '/api/users/user-1/avatar?v=current',
      avatarCandidateUrl: '/api/account/avatar/candidate?v=new',
    });
    vi.mocked(generateAccountAvatar).mockResolvedValueOnce({
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
      error: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesCard />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="account-avatar-comparison"]'),
      ).toBeTruthy(),
    );
    expect(
      document.querySelector('[data-ui="account-avatar-current"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-ui="account-avatar-candidate"]'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Generate new' }));
    await waitFor(() =>
      expect(generateAccountAvatar).toHaveBeenCalledWith('', 'generate'),
    );
    expect(
      document.querySelector('[data-ui="account-avatar-generation-status"]'),
    ).toBeTruthy();
  });

  it('keeps the current avatar through the mounted comparison control', async () => {
    vi.mocked(fetchAccountPreferences).mockResolvedValueOnce({
      content: null,
      dictationLanguage: null,
      displayName: 'Human Name',
      avatarUrl: '/api/users/user-1/avatar?v=current',
      avatarCandidateUrl: '/api/account/avatar/candidate?v=new',
    });
    vi.mocked(chooseAccountAvatar).mockResolvedValueOnce({
      displayName: 'Human Name',
      avatarUrl: '/api/users/user-1/avatar?v=current',
      avatarCandidateUrl: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesCard />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="account-avatar-comparison"]'),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep current' }));
    await waitFor(() =>
      expect(chooseAccountAvatar).toHaveBeenCalledWith('current'),
    );
  });

  it('shows generation failure without replacing the current avatar', async () => {
    vi.mocked(fetchAccountPreferences).mockResolvedValueOnce({
      content: null,
      dictationLanguage: null,
      displayName: 'Human Name',
      avatarUrl: '/api/users/user-1/avatar?v=current',
      avatarCandidateUrl: null,
    });
    vi.mocked(fetchAccountAvatarGeneration).mockResolvedValueOnce({
      status: 'error',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      error: 'provider unavailable',
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesCard />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('provider unavailable')).toBeTruthy();
    expect(
      document.querySelector('[data-ui="account-avatar-current-preview"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-ui="account-avatar-comparison"]'),
    ).toBeNull();
  });
});
