import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '@/types';
import { ScheduledTasksSidebarSection } from './scheduled-tasks-sidebar';

const { confirmAction, deleteMutate } = vi.hoisted(() => ({
  confirmAction: vi.fn(),
  deleteMutate: vi.fn(),
}));

const task: ScheduledTask = {
  id: 'st-1',
  groupFolder: 'proj',
  chatJid: 'jid',
  prompt: 'Daily report',
  scheduleType: 'cron',
  scheduleValue: '0 9 * * *',
  contextMode: 'group',
  nextRun: null,
  lastRun: null,
  lastResult: null,
  status: 'active',
  running: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('@/components/confirm-dialog', () => ({ confirmAction }));
vi.mock('@/hooks/use-scheduled-tasks', () => ({
  useScheduledTasks: () => ({ data: [task] }),
  useUpdateScheduledTask: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteScheduledTask: () => ({ mutate: deleteMutate, isPending: false }),
}));
vi.mock('@/components/scheduled-task-details-dialog', () => ({
  ScheduledTaskDetailsDialog: ({ open }: { open: boolean }) => (
    <div data-ui="details-dialog-stub" data-open={String(open)} />
  ),
}));

function renderSidebar() {
  localStorage.setItem('chat-scheduled-tasks-expanded-proj', 'true');
  const view = render(<ScheduledTasksSidebarSection project_id="proj" />);
  const trash = view.container.querySelector(
    '[data-ui="scheduled-task-sidebar-delete"]',
  )!;
  return { ...view, trash };
}

beforeEach(() => {
  confirmAction.mockReset();
  deleteMutate.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('ScheduledTasksSidebarSection delete', () => {
  it('does not delete when the confirmation is cancelled', async () => {
    confirmAction.mockResolvedValue(false);
    const { trash } = renderSidebar();
    fireEvent.click(trash);
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it('deletes the task once after confirmation', async () => {
    confirmAction.mockResolvedValue(true);
    const { trash } = renderSidebar();
    fireEvent.click(trash);
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledTimes(1));
    expect(deleteMutate).toHaveBeenCalledWith('st-1');
    expect(confirmAction).toHaveBeenCalledWith(
      'This cannot be undone.',
      expect.objectContaining({ destructive: true }),
    );
  });

  it('does not select the row when the trash button is clicked', async () => {
    confirmAction.mockResolvedValue(false);
    const { trash, container } = renderSidebar();
    fireEvent.click(trash);
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(
      container.ownerDocument
        .querySelector('[data-ui="details-dialog-stub"]')
        ?.getAttribute('data-open'),
    ).toBe('false');
  });
});
