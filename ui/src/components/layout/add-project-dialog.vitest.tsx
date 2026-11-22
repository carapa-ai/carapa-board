import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useMutation } from '@tanstack/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import { AddProjectDialog } from './add-project-dialog';

const hoisted = vi.hoisted(() => ({
  createProject: vi.fn(),
  navigate: vi.fn(),
}));

// Real react-query mutation state (isPending, rejection) around a stubbed API.
vi.mock('@/hooks/use-projects', () => ({
  useCreateProject: () => useMutation({ mutationFn: hoisted.createProject }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => hoisted.navigate,
}));

afterEach(() => {
  cleanup();
  useStore.getState().setAddProjectDialogOpen(false);
  hoisted.createProject.mockReset();
  hoisted.navigate.mockReset();
});

describe('AddProjectDialog double submit', () => {
  it('sends one create request for a double Enter and swallows a rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    let rejectCreate!: (error: Error) => void;
    hoisted.createProject.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCreate = reject;
      }),
    );
    useStore.getState().setAddProjectDialogOpen(true);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AddProjectDialog />
      </QueryClientProvider>,
    );

    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'My project' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(hoisted.createProject).toHaveBeenCalledTimes(1));

    rejectCreate(new Error('409'));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(hoisted.navigate).not.toHaveBeenCalled();
  });
});
