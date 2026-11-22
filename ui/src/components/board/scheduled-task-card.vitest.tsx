import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '@/types';
import { ScheduledTaskCard } from './scheduled-task-card';

const mocks = vi.hoisted(() => ({ remove: vi.fn() }));

vi.mock('@/hooks/use-scheduled-tasks', () => ({
  useUpdateScheduledTask: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteScheduledTask: () => ({ mutate: mocks.remove, isPending: false }),
}));
vi.mock('@/components/scheduled-task-details-dialog', () => ({
  ScheduledTaskDetailsDialog: () => null,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.remove.mockReset();
});

describe('ScheduledTaskCard delete', () => {
  it('deletes only after the user confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <ScheduledTaskCard
        project_id="p"
        scheduledTask={
          {
            id: 'st-1',
            prompt: 'Daily report',
            status: 'active',
            scheduleType: 'cron',
            scheduleValue: '0 9 * * *',
          } as unknown as ScheduledTask
        }
      />,
    );
    const button = screen.getByTitle('Delete');

    fireEvent.click(button);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(mocks.remove).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('st-1'));
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});
