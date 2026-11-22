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
import { toast } from 'sonner';
import { useStore } from '@/store';
import { AddTaskDialog } from './add-task-dialog';
import { chooseOption, selectedLabel } from '@/test-utils/select';

const mutations = vi.hoisted(() => ({
  create: vi.fn(async (data: Record<string, unknown>) => ({
    id: 'created-task',
    ...data,
  })),
  update: vi.fn(),
  upload: vi.fn(),
  tasks: [
    { id: 'dep-a', title: 'Awaiting review', status: 'review', priority: 2 },
    { id: 'dep-b', title: 'Ready for testing', status: 'testing', priority: 1 },
  ] as Array<Record<string, unknown>>,
}));

// Queue of one-off catalog loads; an empty queue serves the fixture catalog.
const catalogLoads = vi.hoisted(() => ({
  next: [] as Array<() => Promise<unknown>>,
  calls: 0,
  ok: async () => ({
    version: 2,
    harnesses: [
      { id: 'codex', label: 'Codex', kind: 'cli', sessionFamily: 'codex' },
    ],
    models: [
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        capabilities: [],
        bindings: [
          {
            harnessId: 'codex',
            runtimeId: 'codex:gpt-5.6-sol',
            reasoning: { options: ['medium', 'high'], default: 'medium' },
          },
        ],
      },
    ],
    presets: [],
    defaults: {
      chat: { harnessId: 'codex', modelId: 'gpt-5.6-sol' },
      kanban: {
        fallback: { harnessId: 'codex', modelId: 'gpt-5.6-sol' },
        stages: {},
      },
    },
  }),
}));

vi.mock('@/hooks/use-task-mutations', () => ({
  useCreateTask: () => ({
    mutateAsync: mutations.create,
    isPending: false,
  }),
  useUpdateTask: () => ({ mutate: mutations.update, isPending: false }),
}));

vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({ data: mutations.tasks }),
}));
vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: 'runtime-project',
        settings: {
          stages: [
            { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
            {
              id: 'in_progress',
              title: 'In progress',
              type: 'active',
              color: '#00f',
            },
          ],
        },
      },
    ],
  }),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  uploadAttachment: mutations.upload,
  fetchObjectives: vi.fn(async (projectId: string) =>
    projectId === 'project-a'
      ? [{ id: 'obj-a', title: 'Objective A', status: 'active', progress: 0 }]
      : [],
  ),
  // Plain function (not vi.fn) so `restoreMocks` cannot reset it.
  fetchRuntimeCatalog: () => {
    catalogLoads.calls += 1;
    return (catalogLoads.next.shift() ?? catalogLoads.ok)();
  },
}));

afterEach(() => {
  cleanup();
  useStore.getState().setAddDialogOpen(false);
  mutations.create.mockClear();
  mutations.update.mockClear();
  mutations.upload.mockReset();
  vi.unstubAllGlobals();
});

function renderDialog() {
  useStore.getState().setAddDialogOpen(true);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AddTaskDialog project_id="runtime-project" />
    </QueryClientProvider>,
  );
}

describe('AddTaskDialog double submit', () => {
  it('creates one task for a double click while attachments upload', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => {},
    });
    let finishUpload!: (value: { containerPath: string }) => void;
    mutations.upload.mockReturnValue(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Upload task' },
    });
    fireEvent.paste(screen.getByLabelText('Description'), {
      clipboardData: {
        files: [new File(['x'], 'shot.txt', { type: 'text/plain' })],
      },
    });
    await screen.findByText('shot.txt');

    const create = screen.getByRole('button', { name: 'Create' });
    fireEvent.click(create);
    fireEvent.click(create);
    fireEvent.click(screen.getByRole('button', { name: 'Create & Execute' }));
    await waitFor(() => expect(mutations.upload).toHaveBeenCalledTimes(1));
    expect((create as HTMLButtonElement).disabled).toBe(true);

    finishUpload({ containerPath: '/uploads/shot.txt' });
    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({
      description: expect.stringContaining('/uploads/shot.txt'),
    });
  });

  it('creates one task for a double Enter in the title field', async () => {
    renderDialog();
    const title = await screen.findByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Enter task' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
  });
});

describe('AddTaskDialog while creating', () => {
  async function submit() {
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Pending task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  }
  const cancel = () =>
    screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
  const titleValue = () =>
    (screen.getByLabelText('Title') as HTMLInputElement).value;

  it('keeps Cancel and Escape inert, then resets and closes on success', async () => {
    let resolve!: (task: { id: string }) => void;
    mutations.create.mockImplementationOnce(
      () => new Promise((r) => (resolve = r)) as never,
    );
    await submit();

    await waitFor(() => expect(cancel().disabled).toBe(true));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(useStore.getState().addDialogOpen).toBe(true);
    expect(titleValue()).toBe('Pending task');

    resolve({ id: 'created-task' });
    await waitFor(() => expect(useStore.getState().addDialogOpen).toBe(false));

    act(() => useStore.getState().setAddDialogOpen(true));
    expect(
      (await screen.findByLabelText('Title')) as HTMLInputElement,
    ).toHaveProperty('value', '');
  });

  it('stays open with the draft and re-enables Cancel when creation fails', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let reject!: (err: Error) => void;
      mutations.create.mockImplementationOnce(
        () => new Promise((_, rej) => (reject = rej)) as never,
      );
      await submit();

      await waitFor(() => expect(cancel().disabled).toBe(true));
      reject(new Error('boom'));
      await waitFor(() => expect(cancel().disabled).toBe(false));
      expect(useStore.getState().addDialogOpen).toBe(true);
      expect(titleValue()).toBe('Pending task');

      fireEvent.click(cancel());
      await waitFor(() =>
        expect(useStore.getState().addDialogOpen).toBe(false),
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('AddTaskDialog attachment uploads', () => {
  function pasteFiles(names: string[]) {
    fireEvent.paste(screen.getByLabelText('Description'), {
      clipboardData: {
        files: names.map((n) => new File(['x'], n, { type: 'text/plain' })),
      },
    });
  }

  it('does not create the task when an upload fails and keeps the draft', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => {},
    });
    const toastError = vi.spyOn(toast, 'error').mockImplementation(() => '');
    mutations.upload.mockImplementation(async (_p: string, file: File) => {
      if (file.name === 'bad.txt') throw new Error('500');
      return { containerPath: `/uploads/${file.name}` };
    });
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Upload task' },
    });
    pasteFiles(['good.txt', 'bad.txt']);
    await screen.findByText('bad.txt');

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).toContain('bad.txt');
    expect(toastError.mock.calls[0]?.[0]).not.toContain('good.txt');
    expect(mutations.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Title')).toHaveProperty(
      'value',
      'Upload task',
    );
    expect(screen.getByText('good.txt')).toBeTruthy();
    expect(screen.getByText('bad.txt')).toBeTruthy();

    // Retry succeeds once the upload works.
    mutations.upload.mockImplementation(async (_p: string, file: File) => ({
      containerPath: `/uploads/${file.name}`,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({
      description: expect.stringContaining('- bad.txt: /uploads/bad.txt'),
    });
    toastError.mockRestore();
  });

  it('attaches files chosen with the Attach files button', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => {},
    });
    mutations.upload.mockImplementation(async (_p: string, file: File) => ({
      containerPath: `/uploads/${file.name}`,
    }));
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Picked task' },
    });
    const button = screen.getByRole('button', { name: 'Attach files' });
    expect(button.getAttribute('type')).toBe('button');
    const input = document.querySelector(
      '[data-ui="add-task-file-input"]',
    ) as HTMLInputElement;
    expect(input.multiple).toBe(true);
    const openPicker = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.click(button);
    expect(openPicker).toHaveBeenCalledTimes(1);
    openPicker.mockRestore();
    fireEvent.change(input, {
      target: {
        files: [new File(['x'], 'picked.txt', { type: 'text/plain' })],
      },
    });
    await screen.findByText('picked.txt');

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.upload).toHaveBeenCalledTimes(1);
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({
      description: '[Attached files]\n- picked.txt: /uploads/picked.txt',
    });
  });

  it('appends every uploaded file when all uploads succeed', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => {},
    });
    mutations.upload.mockImplementation(async (_p: string, file: File) => ({
      containerPath: `/uploads/${file.name}`,
    }));
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Upload task' },
    });
    pasteFiles(['a.txt', 'b.txt']);
    await screen.findByText('b.txt');

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({
      description:
        '[Attached files]\n- a.txt: /uploads/a.txt\n- b.txt: /uploads/b.txt',
    });
  });
});

describe('AddTaskDialog runtime configuration', () => {
  it('creates a task with only the structured runtime selector', async () => {
    useStore.getState().setAddDialogOpen(true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AddTaskDialog project_id="runtime-project" />
      </QueryClientProvider>,
    );

    const runtimeHarness = await screen.findByRole('combobox', {
      name: 'Runtime',
    });
    expect(selectedLabel(runtimeHarness)).toBe('Default runtime');

    await chooseOption(runtimeHarness, 'Codex');
    const reasoning = screen.getByRole('combobox', { name: 'Reasoning' });
    expect(selectedLabel(reasoning)).toBe('Inherit reasoning');
    await chooseOption(reasoning, 'high');
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Structured runtime task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({
      title: 'Structured runtime task',
      runtimeSelection: {
        harnessId: 'codex',
        modelId: 'gpt-5.6-sol',
        reasoning: 'high',
      },
    });
    expect('model' in mutations.create.mock.calls[0]![0]).toBe(false);
    expect('agent_name' in mutations.create.mock.calls[0]![0]).toBe(false);
  });
});

describe('AddTaskDialog runtime catalog load failure', () => {
  it('shows an alert with Retry, a loading line while retrying, then the picker', async () => {
    catalogLoads.calls = 0;
    let finishRetry!: () => void;
    catalogLoads.next.push(() => Promise.reject(new Error('500')));
    catalogLoads.next.push(
      () =>
        new Promise((resolve) => {
          finishRetry = () => resolve(catalogLoads.ok());
        }),
    );
    renderDialog();

    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't load runtimes.",
    );
    expect(screen.queryByRole('combobox', { name: 'Runtime' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Loading runtimes…');
    expect(screen.queryByRole('alert')).toBeNull();

    finishRetry();
    await screen.findByRole('combobox', { name: 'Runtime' });
    expect(catalogLoads.calls).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Loading runtimes…')).toBeNull();
  });
});

describe('AddTaskDialog objectives load failure', () => {
  it('shows an alert with Retry in place of the Objective field, then the field after Retry', async () => {
    const { fetchObjectives } = await import('@/lib/api');
    vi.mocked(fetchObjectives)
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce([
        { id: 'obj-a', title: 'Objective A', status: 'active', progress: 0 },
      ] as never);
    renderDialog();

    expect(
      (await screen.findByText("Couldn't load objectives.")).getAttribute(
        'role',
      ),
    ).toBe('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: /Objective A/ });
    expect(screen.queryByText("Couldn't load objectives.")).toBeNull();
  });
});

describe('AddTaskDialog dependencies', () => {
  function pickDependency(title: string) {
    const trigger = screen.getByRole('button', {
      name: /(Select|Add another) dependency/,
    });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    return screen
      .findByRole('menuitem', { name: new RegExp(title) })
      .then((item) => fireEvent.click(item));
  }

  it('posts every picked dependency and lets one be removed by name', async () => {
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Dependent task' },
    });
    await pickDependency('Awaiting review');
    await screen.findByRole('button', {
      name: 'Remove dependency Awaiting review',
    });
    await pickDependency('Ready for testing');
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Remove dependency Awaiting review',
      }),
    );
    expect(
      screen.queryByRole('button', {
        name: 'Remove dependency Awaiting review',
      }),
    ).toBeNull();
    await pickDependency('Awaiting review');
    await screen.findByRole('button', {
      name: 'Remove dependency Awaiting review',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({
      depends_on_ids: ['dep-b', 'dep-a'],
    });
  });

  it('clears picked dependencies when the dialog is cancelled and reopened', async () => {
    renderDialog();
    await pickDependency('Awaiting review');
    await screen.findByRole('button', {
      name: 'Remove dependency Awaiting review',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'Remove dependency Awaiting review',
        }),
      ).toBeNull(),
    );
    act(() => useStore.getState().setAddDialogOpen(true));
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Fresh task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({
      depends_on_ids: [],
    });
  });
});

describe('AddTaskDialog objective selection', () => {
  async function createInProjectBAfterPickingInA(cancelFirst: boolean) {
    useStore.getState().setAddDialogOpen(true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (projectId: string) => (
      <QueryClientProvider client={queryClient}>
        <AddTaskDialog project_id={projectId} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree('project-a'));
    fireEvent.click(await screen.findByRole('button', { name: /Objective A/ }));
    if (cancelFirst) {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    }

    rerender(tree('runtime-project'));
    if (cancelFirst) act(() => useStore.getState().setAddDialogOpen(true));
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Task in B' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({
      objective_id: null,
    });
  }

  it('does not tag a task in another project with a cancelled objective pick', () =>
    createInProjectBAfterPickingInA(true));

  it('drops the objective pick when the project changes while the dialog stays open', () =>
    createInProjectBAfterPickingInA(false));
});

describe('AddTaskDialog project switch while open', () => {
  it('drops a picked dependency that belongs to the previous project', async () => {
    useStore.getState().setAddDialogOpen(true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (projectId: string) => (
      <QueryClientProvider client={queryClient}>
        <AddTaskDialog project_id={projectId} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree('project-a'));
    fireEvent.keyDown(
      await screen.findByRole('button', {
        name: /(Select|Add another) dependency/,
      }),
      { key: 'Enter' },
    );
    fireEvent.click(
      await screen.findByRole('menuitem', { name: /Awaiting review/ }),
    );
    await screen.findByRole('button', {
      name: 'Remove dependency Awaiting review',
    });

    rerender(tree('runtime-project'));
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Task in B' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0]?.[0]).toMatchObject({
      depends_on_ids: [],
    });
  });
});
