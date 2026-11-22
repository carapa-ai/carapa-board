import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatasetTaskCard } from './dataset-task-card';

const mocks = vi.hoisted(() => ({ restart: vi.fn(), remove: vi.fn() }));

vi.mock('@/hooks/use-dataset-tasks', () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useUpdateDatasetTask: idle,
    useDeleteDatasetTask: () => ({ mutate: mocks.remove, isPending: false }),
    useRunDatasetTask: idle,
    useRestartDatasetTask: () => ({ mutate: mocks.restart, isPending: false }),
  };
});
vi.mock('@/lib/agents', () => ({
  useResolveRuntimeSelectionLabel: () => () => 'Codex · GPT',
}));
vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({ data: [] }),
}));
vi.mock('./objective-marker', () => ({ ObjectiveMarker: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.restart.mockReset();
  mocks.remove.mockReset();
});

describe('DatasetTaskCard restart', () => {
  it('restarts only after the user confirms the progress reset', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <DatasetTaskCard
        project_id="p"
        datasetTask={
          {
            id: 'dt-1',
            title: 'Job',
            description: 'Do {{name}}',
            status: 'active',
            archived: false,
            completed_rows: 1,
            total_rows: 2,
          } as never
        }
      />,
    );
    const button = screen.getByTitle('Restart from beginning');

    fireEvent.click(button);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toMatch(/reset.*2 rows/);
    expect(mocks.restart).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    expect(mocks.restart).toHaveBeenCalledWith('dt-1');
  });
});

describe('DatasetTaskCard paused state', () => {
  it('shows the Paused text only for paused dataset tasks', () => {
    const task = {
      id: 'dt-2',
      title: 'Job',
      description: '',
      archived: false,
      completed_rows: 0,
      total_rows: 2,
    };
    const { rerender } = render(
      <DatasetTaskCard
        project_id="p"
        datasetTask={{ ...task, status: 'active' } as never}
      />,
    );
    expect(screen.queryByText('Paused')).toBeNull();

    rerender(
      <DatasetTaskCard
        project_id="p"
        datasetTask={{ ...task, status: 'paused' } as never}
      />,
    );
    expect(screen.getByText('Paused')).toBeTruthy();
  });
});

describe('DatasetTaskCard delete', () => {
  it('deletes only after the user confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <DatasetTaskCard
        project_id="p"
        datasetTask={
          {
            id: 'dt-3',
            title: 'Job',
            description: '',
            status: 'active',
            archived: false,
            completed_rows: 0,
            total_rows: 2,
          } as never
        }
      />,
    );

    const openMenuAndDelete = async () => {
      await user.click(
        screen.getByRole('button', { name: 'More automation actions' }),
      );
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    };

    await openMenuAndDelete();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(mocks.remove).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await openMenuAndDelete();
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('dt-3'));
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});
