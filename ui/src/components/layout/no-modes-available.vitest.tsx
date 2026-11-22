import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '@/lib/api';
import { useStore } from '@/store';
import { NoModesAvailable } from './no-modes-available';

const harness = vi.hoisted(() => ({ config: {} as Record<string, boolean> }));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  fetchConfig: async () => harness.config,
}));

afterEach(() => {
  cleanup();
  useStore.getState().setSettingsProjectId(null);
});

function renderPage(projectId: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NoModesAvailable projectId={projectId} />
    </QueryClientProvider>,
  );
}

describe('NoModesAvailable', () => {
  it('offers Project settings when the server still enables modes', async () => {
    harness.config = { enableKanban: true, enableChat: true };
    renderPage('p');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open project settings' }),
    );
    expect(useStore.getState().settingsProjectId).toBe('p');
  });

  it('keeps the env-flag copy when the server disabled every mode', async () => {
    harness.config = {
      enableKanban: false,
      enableChat: false,
      enableObjectives: false,
    };
    renderPage('p');
    await waitFor(() =>
      expect(screen.getByText(/disabled at the server/)).toBeTruthy(),
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
