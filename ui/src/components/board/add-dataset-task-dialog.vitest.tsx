import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import { fetchRuntimeCatalog } from '@/lib/api';
import { AddDatasetTaskDialog } from './add-dataset-task-dialog';

const { createDatasetTask } = vi.hoisted(() => ({
  createDatasetTask: vi.fn(),
}));
vi.mock('@/hooks/use-dataset-tasks', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    useCreateDatasetTask: () =>
      useMutation({ mutationFn: (data: unknown) => createDatasetTask(data) }),
  };
});
vi.mock('@/lib/api', () => ({ fetchRuntimeCatalog: vi.fn(async () => null) }));
vi.mock('@/hooks/use-projects', () => ({ useProjects: () => ({}) }));
vi.mock('@/components/chat/runtime-picker', () => ({
  RuntimePicker: () => null,
}));

afterEach(() => {
  cleanup();
  createDatasetTask.mockReset();
  useStore.setState({ addDatasetTaskDialogOpen: false });
});

describe('AddDatasetTaskDialog', () => {
  it('clears the parse error when the Dataset field is emptied', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AddDatasetTaskDialog project_id="dataset-project" />
      </QueryClientProvider>,
    );
    act(() => useStore.getState().setAddDatasetTaskDialogOpen(true));
    const create = () =>
      screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    const dataset = screen.getByLabelText('Dataset (JSON array)');

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Job' },
    });
    fireEvent.change(dataset, { target: { value: '{oops' } });
    expect(screen.getByText('Invalid JSON')).toBeTruthy();
    expect(create().disabled).toBe(true);

    fireEvent.change(dataset, { target: { value: '' } });
    expect(screen.queryByText('Invalid JSON')).toBeNull();
    expect(create().disabled).toBe(true);

    fireEvent.change(dataset, { target: { value: '[{"a":1}]' } });
    expect(create().disabled).toBe(false);
  });

  it('shows an alert with Retry when the runtime catalog fails to load', async () => {
    vi.mocked(fetchRuntimeCatalog).mockRejectedValueOnce(new Error('500'));
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <AddDatasetTaskDialog project_id="dataset-project" />
      </QueryClientProvider>,
    );
    act(() => useStore.getState().setAddDatasetTaskDialogOpen(true));

    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't load runtimes.",
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  describe('while creating', () => {
    function renderAndSubmit() {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <AddDatasetTaskDialog project_id="dataset-project" />
        </QueryClientProvider>,
      );
      act(() => useStore.getState().setAddDatasetTaskDialogOpen(true));
      fireEvent.change(screen.getByLabelText('Title'), {
        target: { value: 'Job' },
      });
      fireEvent.change(screen.getByLabelText('Dataset (JSON array)'), {
        target: { value: '[{"a":1}]' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    }
    const cancel = () =>
      screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

    it('keeps Cancel and Escape inert, then resets and closes on success', async () => {
      let resolve!: () => void;
      createDatasetTask.mockReturnValue(
        new Promise<void>((r) => (resolve = r)),
      );
      renderAndSubmit();

      await waitFor(() => expect(cancel().disabled).toBe(true));
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(useStore.getState().addDatasetTaskDialogOpen).toBe(true);

      resolve();
      await waitFor(() =>
        expect(useStore.getState().addDatasetTaskDialogOpen).toBe(false),
      );
      expect(createDatasetTask).toHaveBeenCalledTimes(1);

      act(() => useStore.getState().setAddDatasetTaskDialogOpen(true));
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
        '',
      );
    });

    it('stays open with the draft and re-enables buttons when creation fails', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        let reject!: (err: Error) => void;
        createDatasetTask.mockReturnValue(
          new Promise<void>((_, rej) => (reject = rej)),
        );
        renderAndSubmit();

        await waitFor(() => expect(cancel().disabled).toBe(true));
        reject(new Error('boom'));
        await waitFor(() => expect(cancel().disabled).toBe(false));
        expect(useStore.getState().addDatasetTaskDialogOpen).toBe(true);
        expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
          'Job',
        );
        expect(
          (screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement)
            .disabled,
        ).toBe(false);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });
});
