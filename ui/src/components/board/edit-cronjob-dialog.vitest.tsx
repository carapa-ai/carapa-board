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
import { EditCronjobDialog } from './edit-cronjob-dialog';

const cronjobList = vi.hoisted(() => ({
  current: [
    {
      id: 'cron-1',
      title: 'Nightly',
      description: '',
      cron_expression: '0 9 * * *',
      queue_mode: 'always',
      runtimeSelection: null,
    },
    {
      id: 'cron-2',
      title: 'Weekly',
      description: '',
      cron_expression: '0 8 * * 1',
      queue_mode: 'always',
      runtimeSelection: null,
    },
  ],
}));
const updateMutation = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
}));

vi.mock('@/hooks/use-cronjobs', async () => {
  const { useState } = await import('react');
  return {
    useCronjobs: () => ({ data: cronjobList.current }),
    // Pending state follows the real call: set while mutateAsync is unsettled.
    useUpdateCronjob: () => {
      const [pending, setPending] = useState(false);
      return {
        isPending: pending || updateMutation.isPending,
        mutateAsync: async (variables: unknown) => {
          setPending(true);
          try {
            return await updateMutation.mutateAsync(variables);
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
  useStore.setState({ editCronjobId: null });
  updateMutation.mutateAsync.mockReset();
  updateMutation.isPending = false;
});

const renderDialog = () => {
  const client = new QueryClient();
  const tree = () => (
    <QueryClientProvider client={client}>
      <EditCronjobDialog project_id="cron-project" />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
};

describe('EditCronjobDialog', () => {
  it('keeps typed edits when the cronjob list is refetched', () => {
    const client = new QueryClient();
    const tree = () => (
      <QueryClientProvider client={client}>
        <EditCronjobDialog project_id="cron-project" />
      </QueryClientProvider>
    );
    const original = cronjobList.current;
    const { rerender } = render(tree());

    act(() => useStore.getState().setEditCronjobId('cron-1'));
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Typed title' },
    });

    cronjobList.current = [{ ...original[0], title: 'Refetched title' }];
    rerender(tree());
    cronjobList.current = original;

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
      'Typed title',
    );
  });

  it('clears the cron error when the dialog is reopened', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EditCronjobDialog project_id="cron-project" />
      </QueryClientProvider>,
    );

    act(() => useStore.getState().setEditCronjobId('cron-1'));
    fireEvent.change(screen.getByLabelText('Cron Expression'), {
      target: { value: 'not a cron' },
    });
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty(
      'disabled',
      true,
    );

    act(() => useStore.getState().setEditCronjobId(null));
    act(() => useStore.getState().setEditCronjobId('cron-1'));

    expect(
      (screen.getByLabelText('Cron Expression') as HTMLInputElement).value,
    ).toBe('0 9 * * *');
    expect(screen.queryByText(/Must have 5 fields/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('keeps the stored runtime override when the catalog fails to load', async () => {
    const stored = { harnessId: 'claude', modelId: 'opus' };
    const original = cronjobList.current;
    cronjobList.current = [
      { ...original[0], runtimeSelection: stored as never },
    ];
    vi.mocked(fetchRuntimeCatalog).mockRejectedValueOnce(new Error('500'));
    updateMutation.mutateAsync.mockResolvedValue(undefined);
    try {
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <EditCronjobDialog project_id="cron-project" />
        </QueryClientProvider>,
      );
      act(() => useStore.getState().setEditCronjobId('cron-1'));

      expect((await screen.findByRole('alert')).textContent).toBe(
        "Couldn't load runtimes.",
      );
      expect(screen.getByText(/current runtime override is kept/)).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(updateMutation.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
          data: { runtimeSelection: stored },
        }),
      );
    } finally {
      cronjobList.current = original;
    }
  });

  it('disables Cancel and every field during a pending save, then re-enables them with values kept after a rejection', async () => {
    let rejectSave!: (error: Error) => void;
    updateMutation.mutateAsync.mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectSave = reject;
      }),
    );
    renderDialog();
    act(() => useStore.getState().setEditCronjobId('cron-1'));
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Typed title' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Typed description' },
    });
    const fields = () => [
      screen.getByLabelText('Title') as HTMLInputElement,
      screen.getByLabelText('Description') as HTMLTextAreaElement,
      screen.getByLabelText('Cron Expression') as HTMLInputElement,
      screen.getByRole('button', { name: 'Always' }) as HTMLButtonElement,
      screen.getByRole('button', {
        name: 'If queue empty',
      }) as HTMLButtonElement,
      screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement,
    ];

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fields().map((f) => f.disabled)).toEqual(fields().map(() => true));
    expect(
      document.querySelector<HTMLFieldSetElement>(
        '[data-ui="cronjob-runtime-picker"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => rejectSave(new Error('boom')));
    expect(fields().map((f) => f.disabled)).toEqual(fields().map(() => false));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
      'Typed title',
    );
    expect(
      (screen.getByLabelText('Description') as HTMLTextAreaElement).value,
    ).toBe('Typed description');
    expect(useStore.getState().editCronjobId).toBe('cron-1');
  });

  it('does not close a different dialog when a stale save resolves', async () => {
    let resolveSave!: () => void;
    updateMutation.mutateAsync.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    renderDialog();
    act(() => useStore.getState().setEditCronjobId('cron-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    act(() => useStore.getState().setEditCronjobId('cron-2'));
    await act(async () => resolveSave());

    expect(useStore.getState().editCronjobId).toBe('cron-2');
  });

  it('keeps the dialog open without throwing when the save is rejected', async () => {
    updateMutation.mutateAsync.mockRejectedValue(new Error('boom'));
    renderDialog();
    act(() => useStore.getState().setEditCronjobId('cron-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {});

    expect(updateMutation.mutateAsync).toHaveBeenCalledTimes(1);
    expect(useStore.getState().editCronjobId).toBe('cron-1');
  });
});
