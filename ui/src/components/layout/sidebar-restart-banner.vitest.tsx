import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { fetchStatus, restart } = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  restart: vi.fn(),
}));

vi.mock('@capacitor/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@capacitor/core')>()),
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
  },
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchServerWebBuildStatus: fetchStatus,
  restartBoard: restart,
}));

import { RestartBanner } from './sidebar';
import { useStore } from '@/store';

afterEach(() => {
  cleanup();
  fetchStatus.mockReset();
  restart.mockReset();
  useStore.getState().setServerRestarted(false);
});

function renderBanner(reloadPage?: () => void) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RestartBanner reloadPage={reloadPage} />
    </QueryClientProvider>,
  );
}

describe('RestartBanner', () => {
  test('renders the restart action for a recoverable ready status', async () => {
    fetchStatus.mockResolvedValue({ status: 'ready' });
    const view = renderBanner();

    await waitFor(() =>
      expect(
        view.container.querySelector('[data-ui="board-restart-banner"]'),
      ).not.toBeNull(),
    );
    const restartButton = screen.getByRole('button', {
      name: 'Restart',
    }) as HTMLButtonElement;
    expect(restartButton.disabled).toBe(false);
  });

  test('does not offer an enabled restart action for a failed build', async () => {
    fetchStatus.mockResolvedValue({
      status: 'failed',
      error: 'build failed',
    });
    renderBanner();

    await waitFor(() => expect(fetchStatus).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  test('shows a waiting banner without an enabled restart while building', async () => {
    fetchStatus.mockResolvedValue({ status: 'building' });
    const view = renderBanner();

    await waitFor(() =>
      expect(
        view.container.querySelector('[data-ui="board-restart-banner"]'),
      ).not.toBeNull(),
    );
    const waitingButton = screen.getByRole('button', {
      name: 'Please wait',
    }) as HTMLButtonElement;
    expect(waitingButton.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  test('reloads after a user-requested restart reaches the new server', async () => {
    fetchStatus.mockResolvedValue({ status: 'ready' });
    restart.mockResolvedValue(undefined);
    const reloadPage = vi.fn();
    useStore.getState().setServerRestarted(true);
    renderBanner(reloadPage);

    const restartButton = await screen.findByRole('button', {
      name: 'Restart',
    });
    fireEvent.click(restartButton);

    expect(useStore.getState().serverRestarted).toBe(false);
    expect(reloadPage).not.toHaveBeenCalled();

    useStore.getState().setServerRestarted(true);

    await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
  });

  test('does not reload for an unrelated server restart', async () => {
    fetchStatus.mockResolvedValue({ status: 'ready' });
    const reloadPage = vi.fn();
    renderBanner(reloadPage);

    await screen.findByRole('button', { name: 'Restart' });
    useStore.getState().setServerRestarted(true);

    await waitFor(() => expect(fetchStatus).toHaveBeenCalled());
    expect(reloadPage).not.toHaveBeenCalled();
  });
});
