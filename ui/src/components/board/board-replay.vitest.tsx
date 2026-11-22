import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardReplayPlayer } from './board-replay';

vi.mock('@/lib/api', () => ({
  fetchBoardReplay: vi.fn(async () => ({
    initialTasks: [],
    events: [],
    runs: [],
    reviewMilestones: [],
    exactHistoryAvailableFrom: null,
    runHistoryAvailableFrom: null,
  })),
}));

afterEach(cleanup);

describe('BoardReplayPlayer icon-only controls', () => {
  it('names play/pause by state and the reset button', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BoardReplayPlayer
          projectId="p1"
          range={{
            from: '2026-10-24T00:00:00.000Z',
            to: '2026-10-25T00:00:00.000Z',
          }}
          onRangeChange={vi.fn()}
          onExit={vi.fn()}
          onFrame={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: /reset replay/i })).toBeTruthy();
    const play = await screen.findByRole('button', { name: /play replay/i });
    await waitFor(() =>
      expect((play as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(play);
    expect(screen.getByRole('button', { name: /pause replay/i })).toBeTruthy();
  });
});
