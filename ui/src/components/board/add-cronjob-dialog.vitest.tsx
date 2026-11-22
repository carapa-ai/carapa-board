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
import { AddCronjobDialog } from './add-cronjob-dialog';

const { createCronjob } = vi.hoisted(() => ({ createCronjob: vi.fn() }));
vi.mock('@/hooks/use-cronjobs', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    useCreateCronjob: () =>
      useMutation({ mutationFn: (data: unknown) => createCronjob(data) }),
  };
});
vi.mock('@/lib/api', () => ({ fetchRuntimeCatalog: vi.fn(async () => null) }));
vi.mock('@/hooks/use-projects', () => ({ useProjects: () => ({}) }));
vi.mock('@/components/chat/runtime-picker', () => ({
  RuntimePicker: ({ catalog }: { catalog?: unknown }) =>
    catalog ? <div data-ui="mock-runtime-picker" /> : null,
}));

afterEach(() => {
  cleanup();
  createCronjob.mockReset();
  useStore.setState({ addCronjobDialogOpen: false });
});

function renderDialog() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AddCronjobDialog project_id="cron-project" />
    </QueryClientProvider>,
  );
  act(() => useStore.getState().setAddCronjobDialogOpen(true));
}

function fillInvalid() {
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'Discarded' },
  });
  fireEvent.change(screen.getByLabelText('Cron Expression'), {
    target: { value: 'not a cron' },
  });
}

function expectEmptyForm() {
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
  expect(
    (screen.getByLabelText('Cron Expression') as HTMLInputElement).value,
  ).toBe('');
  expect(document.querySelector('p.text-red-600')).toBeNull();
}

describe('AddCronjobDialog', () => {
  it('resets the form after Cancel', () => {
    renderDialog();
    fillInvalid();
    expect(document.querySelector('p.text-red-600')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    act(() => useStore.getState().setAddCronjobDialogOpen(true));

    expectEmptyForm();
  });

  it('resets the form after Escape', () => {
    renderDialog();
    fillInvalid();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    act(() => useStore.getState().setAddCronjobDialogOpen(true));

    expectEmptyForm();
  });

  it('exposes the selected queue mode to assistive tech', () => {
    renderDialog();

    const group = screen.getByRole('radiogroup', { name: 'Queue Mode' });
    expect(group).toBeTruthy();
    const always = screen.getByRole('radio', { name: 'Always' });
    const ifEmpty = screen.getByRole('radio', { name: 'If queue empty' });
    expect(always.getAttribute('aria-checked')).toBe('true');
    expect(ifEmpty.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(ifEmpty);
    expect(always.getAttribute('aria-checked')).toBe('false');
    expect(ifEmpty.getAttribute('aria-checked')).toBe('true');
  });

  it('shows an alert with Retry when the runtime catalog fails, then the runtime fields after Retry', async () => {
    vi.mocked(fetchRuntimeCatalog)
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce({} as never);
    renderDialog();

    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't load runtimes.",
    );
    expect(
      document.querySelector('[data-ui="mock-runtime-picker"]'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="mock-runtime-picker"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('while creating', () => {
    function submit() {
      renderDialog();
      fireEvent.change(screen.getByLabelText('Title'), {
        target: { value: 'Nightly' },
      });
      fireEvent.change(screen.getByLabelText('Cron Expression'), {
        target: { value: '0 9 * * *' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    }
    const cancel = () =>
      screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

    it('keeps Cancel and Escape inert, then resets and closes on success', async () => {
      let resolve!: () => void;
      createCronjob.mockReturnValue(new Promise<void>((r) => (resolve = r)));
      submit();

      await waitFor(() => expect(cancel().disabled).toBe(true));
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(useStore.getState().addCronjobDialogOpen).toBe(true);
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
        'Nightly',
      );

      resolve();
      await waitFor(() =>
        expect(useStore.getState().addCronjobDialogOpen).toBe(false),
      );
      expect(createCronjob).toHaveBeenCalledTimes(1);

      act(() => useStore.getState().setAddCronjobDialogOpen(true));
      expectEmptyForm();
    });

    it('stays open with the draft and re-enables buttons when creation fails', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        let reject!: (err: Error) => void;
        createCronjob.mockReturnValue(
          new Promise<void>((_, rej) => (reject = rej)),
        );
        submit();

        await waitFor(() => expect(cancel().disabled).toBe(true));
        reject(new Error('boom'));
        await waitFor(() => expect(cancel().disabled).toBe(false));
        expect(useStore.getState().addCronjobDialogOpen).toBe(true);
        expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
          'Nightly',
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
