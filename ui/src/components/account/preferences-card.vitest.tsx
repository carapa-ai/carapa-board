import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAccountPreferences, updateAccountPreferences } from '@/lib/api';
import { PreferencesCard } from './preferences-card';

vi.mock('@/lib/auth', () => ({
  refreshAuthUser: vi.fn(async () => null),
  useAuth: (
    selector: (state: { user: { id: string; username: string } }) => unknown,
  ) => selector({ user: { id: 'user-1', username: 'login-name' } }),
}));

const profile = vi.hoisted(() => ({
  content: 'server notes',
  dictationLanguage: 'ro',
  displayName: 'Server Name',
  avatarUrl: null,
  avatarCandidateUrl: null,
}));

vi.mock('@/lib/api', () => ({
  fetchAccountPreferences: vi.fn(async () => profile),
  fetchConfig: vi.fn(async () => ({
    meetingLanguages: [{ code: 'ro', label: 'Romanian', script: 'latin' }],
  })),
  updateAccountPreferences: vi.fn(),
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

afterEach(cleanup);

function renderCard() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PreferencesCard />
    </QueryClientProvider>,
  );
}

describe('PreferencesCard', () => {
  it('keeps edited fields but follows the server for untouched ones when data is replaced', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreferencesCard />
      </QueryClientProvider>,
    );

    const textarea = (await screen.findByDisplayValue(
      'server notes',
    )) as HTMLTextAreaElement;
    const displayName = screen.getByDisplayValue(
      'Server Name',
    ) as HTMLInputElement;

    fireEvent.change(textarea, { target: { value: 'typed notes' } });

    act(() => {
      queryClient.setQueryData(['preferences', 'account'], {
        ...profile,
        content: 'newer server notes',
        displayName: 'Renamed Elsewhere',
      });
    });

    await waitFor(() => expect(displayName.value).toBe('Renamed Elsewhere'));
    expect(textarea.value).toBe('typed notes');
  });

  it('shows a retryable error instead of an editable form when loading fails', async () => {
    vi.mocked(fetchAccountPreferences).mockRejectedValueOnce(new Error('boom'));
    renderCard();

    expect(await screen.findByText('Could not load preferences')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByDisplayValue('server notes')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByDisplayValue('server notes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('omits content when only the display name changed, and sends null when notes are cleared', async () => {
    vi.mocked(updateAccountPreferences).mockResolvedValue({ ...profile });
    renderCard();

    const name = await screen.findByDisplayValue('Server Name');
    fireEvent.change(name, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateAccountPreferences).toHaveBeenLastCalledWith(
        undefined,
        undefined,
        'New Name',
      ),
    );

    fireEvent.change(screen.getByDisplayValue('server notes'), {
      target: { value: '' },
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateAccountPreferences).toHaveBeenLastCalledWith(
        null,
        undefined,
        undefined,
      ),
    );
  });

  it('is not dirty after saving whitespace-only notes', async () => {
    vi.mocked(updateAccountPreferences).mockResolvedValue({
      ...profile,
      content: '',
    });
    renderCard();

    const textarea = (await screen.findByDisplayValue(
      'server notes',
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '   ' } });
    const save = screen.getByRole('button', {
      name: 'Save',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(textarea.value).toBe(''));
    await waitFor(() => expect(save.disabled).toBe(true));
  });
});
