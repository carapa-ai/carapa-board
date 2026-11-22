import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cronjob } from '@/types';
import { CronjobCard } from './cronjob-card';

const updateState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));
const deleteMutate = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-cronjobs', () => ({
  useUpdateCronjob: () => updateState,
  useDeleteCronjob: () => ({ mutate: deleteMutate, isPending: false }),
  useRunCronjob: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/agents', () => ({
  useResolveRuntimeSelectionLabel: () => () => 'Codex · GPT',
}));
vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({ data: [] }),
}));

const cronjob = {
  id: 'cron-1',
  title: 'Nightly',
  cron_expression: '0 9 * * *',
  queue_mode: 'always',
  status: 'active',
} as Cronjob;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  deleteMutate.mockClear();
  updateState.mutate.mockClear();
  updateState.isPending = false;
});

describe('CronjobCard', () => {
  it('toggles queue mode through a labelled button, once per click', () => {
    render(<CronjobCard cronjob={cronjob} project_id="p" />);

    const button = screen.getByRole('button', {
      name: 'Queue mode: always. Switch to if empty',
    });
    fireEvent.click(button);

    expect(updateState.mutate).toHaveBeenCalledTimes(1);
    expect(updateState.mutate).toHaveBeenCalledWith({
      cronjob_id: 'cron-1',
      data: { queue_mode: 'if_empty' },
    });
  });

  it('disables the queue mode button while an update is pending', () => {
    updateState.isPending = true;
    render(<CronjobCard cronjob={cronjob} project_id="p" />);

    const button = screen.getByRole('button', { name: /Queue mode/ });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(updateState.mutate).not.toHaveBeenCalled();
  });

  it('shows the Paused text only for paused cronjobs', () => {
    const { rerender } = render(
      <CronjobCard cronjob={cronjob} project_id="p" />,
    );
    expect(screen.queryByText('Paused')).toBeNull();

    rerender(
      <CronjobCard cronjob={{ ...cronjob, status: 'paused' }} project_id="p" />,
    );
    expect(screen.getByText('Paused')).toBeTruthy();
  });
});

describe('CronjobCard delete', () => {
  it('deletes only after the user confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    render(<CronjobCard cronjob={cronjob} project_id="p" />);

    const openMenuAndDelete = async () => {
      await user.click(
        screen.getByRole('button', { name: 'More automation actions' }),
      );
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    };

    await openMenuAndDelete();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(deleteMutate).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await openMenuAndDelete();
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('cron-1'));
    expect(deleteMutate).toHaveBeenCalledTimes(1);
  });
});
