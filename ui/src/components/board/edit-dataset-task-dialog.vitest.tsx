import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import { EditDatasetTaskDialog } from './edit-dataset-task-dialog';

const mocks = vi.hoisted(() => ({
  datasetTasks: [] as unknown[],
  mutateAsync: vi.fn(),
  isPending: false,
}));

function datasetTask(title: string) {
  return {
    id: 'dt-1',
    title,
    description: 'Describe {{name}}',
    dataset: [{ name: 'a' }],
    runtimeSelection: null,
  };
}

vi.mock('@/hooks/use-dataset-tasks', async () => {
  const { useState } = await import('react');
  return {
    useDatasetTasks: () => ({ data: mocks.datasetTasks }),
    // Pending state follows the real call: set while mutateAsync is unsettled.
    useUpdateDatasetTask: () => {
      const [pending, setPending] = useState(false);
      return {
        isPending: pending || mocks.isPending,
        mutateAsync: async (variables: unknown) => {
          setPending(true);
          try {
            return await mocks.mutateAsync(variables);
          } finally {
            setPending(false);
          }
        },
      };
    },
  };
});
vi.mock('@/lib/api', () => ({ fetchRuntimeCatalog: vi.fn(async () => null) }));
vi.mock('@/hooks/use-projects', () => ({ useProjects: () => ({}) }));
vi.mock('@/components/chat/runtime-picker', () => ({
  RuntimePicker: () => null,
}));

afterEach(() => {
  cleanup();
  useStore.setState({ editDatasetTaskId: null });
  mocks.isPending = false;
});

function renderOpenDialog(pending = false) {
  mocks.datasetTasks = [datasetTask('Server title')];
  mocks.mutateAsync.mockReset();
  mocks.isPending = pending;
  const client = new QueryClient();
  const tree = () => (
    <QueryClientProvider client={client}>
      <EditDatasetTaskDialog project_id="dataset-project" />
    </QueryClientProvider>
  );
  const view = render(tree());
  act(() => useStore.getState().setEditDatasetTaskId('dt-1'));
  return {
    rerender: () => view.rerender(tree()),
    dataset: () => screen.getAllByRole('textbox')[2],
    save: () =>
      screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement,
  };
}

describe('EditDatasetTaskDialog', () => {
  it('blocks Save for invalid dataset text and sends a valid edit', () => {
    const { dataset, save } = renderOpenDialog();
    expect(save().disabled).toBe(false);

    for (const bad of ['{not json', '[1,2]']) {
      fireEvent.change(dataset(), { target: { value: bad } });
      expect(save().disabled).toBe(true);
    }

    fireEvent.change(dataset(), { target: { value: '[{"name":"b"}]' } });
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(mocks.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        dataset_task_id: 'dt-1',
        data: expect.objectContaining({ dataset: [{ name: 'b' }] }),
      }),
    );
  });

  it('shows derived dataset errors, never drops a changed dataset, and omits an unchanged one', () => {
    const { dataset, save } = renderOpenDialog();

    fireEvent.change(dataset(), { target: { value: '   ' } });
    expect(
      screen.getByText('Dataset must be a non-empty JSON array'),
    ).toBeTruthy();
    expect(save().disabled).toBe(true);

    fireEvent.change(dataset(), { target: { value: '{bad' } });
    expect(screen.getByText('Invalid JSON')).toBeTruthy();
    expect(save().disabled).toBe(true);

    fireEvent.change(dataset(), { target: { value: '[{"name":"b"}]' } });
    expect(screen.queryByText('Invalid JSON')).toBeNull();
    expect(save().disabled).toBe(false);

    fireEvent.change(dataset(), {
      target: { value: JSON.stringify([{ name: 'a' }], null, 2) },
    });
    fireEvent.click(save());
    expect(mocks.mutateAsync.mock.calls[0][0].data).not.toHaveProperty(
      'dataset',
    );
  });

  it('names placeholders without a matching dataset column', () => {
    const { dataset } = renderOpenDialog();
    expect(screen.queryByText(/No dataset column named/)).toBeNull();

    fireEvent.change(dataset(), { target: { value: '[{"other":"x"}]' } });
    expect(screen.getByText('No dataset column named name')).toBeTruthy();
    expect(
      screen.getAllByRole('textbox')[1].getAttribute('aria-describedby'),
    ).toBe('dataset-unmatched-placeholders');
    expect(
      (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('keeps typed edits across a refetch and re-syncs when reopened', () => {
    mocks.datasetTasks = [datasetTask('Server title')];
    const client = new QueryClient();
    const tree = () => (
      <QueryClientProvider client={client}>
        <EditDatasetTaskDialog project_id="dataset-project" />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());

    act(() => useStore.getState().setEditDatasetTaskId('dt-1'));
    fireEvent.change(screen.getByDisplayValue('Server title'), {
      target: { value: 'Typed title' },
    });

    // A completed dataset row triggers a list refetch with a new object.
    mocks.datasetTasks = [datasetTask('Server title (refetched)')];
    rerender(tree());
    expect(screen.getByDisplayValue('Typed title')).toBeTruthy();

    act(() => useStore.getState().setEditDatasetTaskId(null));
    act(() => useStore.getState().setEditDatasetTaskId('dt-1'));
    expect(screen.getByDisplayValue('Server title (refetched)')).toBeTruthy();
  });

  it('closes after a successful save', async () => {
    const { save } = renderOpenDialog();
    mocks.mutateAsync.mockResolvedValue({});
    await act(async () => {
      fireEvent.click(save());
    });
    expect(useStore.getState().editDatasetTaskId).toBeNull();
  });

  it('keeps the dialog open without an unhandled rejection when the save fails', async () => {
    const { save } = renderOpenDialog();
    mocks.mutateAsync.mockRejectedValue(new Error('boom'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await act(async () => {
        fireEvent.click(save());
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(useStore.getState().editDatasetTaskId).toBe('dt-1');
    expect(screen.getByDisplayValue('Server title')).toBeTruthy();
  });

  it('disables Cancel and every field during a pending save, then re-enables them with values kept after a rejection', async () => {
    const { save, dataset } = renderOpenDialog();
    let rejectSave!: (error: Error) => void;
    mocks.mutateAsync.mockReturnValue(
      new Promise((_, reject) => {
        rejectSave = reject;
      }),
    );
    fireEvent.change(screen.getByDisplayValue('Server title'), {
      target: { value: 'Typed title' },
    });
    fireEvent.change(screen.getByDisplayValue('Describe {{name}}'), {
      target: { value: 'Typed description {{name}}' },
    });
    fireEvent.change(dataset(), { target: { value: '[{"name":"typed"}]' } });
    const fields = () => [
      ...(screen.getAllByRole('textbox') as HTMLTextAreaElement[]),
      screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement,
      screen.getByRole('button', { name: /Upload/ }) as HTMLButtonElement,
    ];

    fireEvent.click(save());
    expect(fields().map((f) => f.disabled)).toEqual(fields().map(() => true));
    expect(
      document.querySelector<HTMLFieldSetElement>(
        '[data-ui="dataset-runtime-picker"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => rejectSave(new Error('boom')));
    expect(fields().map((f) => f.disabled)).toEqual(fields().map(() => false));
    expect(screen.getByDisplayValue('Typed title')).toBeTruthy();
    expect(screen.getByDisplayValue('Typed description {{name}}')).toBeTruthy();
    expect((dataset() as HTMLTextAreaElement).value).toBe('[{"name":"typed"}]');
    expect(useStore.getState().editDatasetTaskId).toBe('dt-1');
  });

  it('ignores a stale save that resolves after the dialog was closed and reopened', async () => {
    const { save } = renderOpenDialog();
    let resolveSave!: (value: unknown) => void;
    mocks.mutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    act(() => {
      fireEvent.click(save());
    });

    act(() => useStore.getState().setEditDatasetTaskId(null));
    act(() => useStore.getState().setEditDatasetTaskId('dt-1'));
    fireEvent.change(screen.getByDisplayValue('Server title'), {
      target: { value: 'Typed after reopen' },
    });

    await act(async () => {
      resolveSave({});
    });
    expect(useStore.getState().editDatasetTaskId).toBe('dt-1');
    expect(screen.getByDisplayValue('Typed after reopen')).toBeTruthy();
  });
});
