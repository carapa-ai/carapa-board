import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Objective } from '@/types';
import { ApiError } from '@/lib/api';
import {
  EditObjectiveDialog,
  ObjectiveDetail,
  Route,
} from './objective.$projectId.$objectiveId';

const updateObjective = vi.hoisted(() => vi.fn());
const fetchObjective = vi.hoisted(() => vi.fn());
const deleteObjective = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({
  projectId: 'project-1',
  objectiveId: 'obj-1',
}));
const chatPageProps = vi.hoisted(() => ({
  current: null as null | {
    workspacePane?: {
      openRequest?: string;
      render?: (props: unknown) => unknown;
    };
  },
}));
const explorerProps = vi.hoisted(() => ({
  current: null as null | {
    initial_report?: string;
    onInitialReportOpened?: (report: string) => void;
  },
}));
const previewPaneProps = vi.hoisted(() => ({
  current: null as null | { localDefaultView?: string },
  mounts: 0,
}));
const canLeaveActivePreview = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store')>();
  return { ...actual, canLeaveActivePreview };
});

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => routeParams,
    useSearch: () => ({}),
  }),
  Link: ({
    children,
    to,
    'aria-label': ariaLabel,
  }: {
    children?: React.ReactNode;
    to: string;
    'aria-label'?: string;
  }) => (
    <a href={to} aria-label={ariaLabel}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status?: number,
    ) {
      super(message);
    }
  },
  fetchObjective,
  updateObjective,
  deleteObjective,
  fetchConfig: vi.fn(),
  fetchRuntimeCatalog: vi.fn(async () => null),
}));
vi.mock('@/components/layout/header', () => ({ Header: () => null }));
vi.mock('@/components/layout/project-dialogs', () => ({
  ProjectDialogs: () => null,
}));
vi.mock('@/components/chat/chat-page', async () => {
  const { useContext } = await import('react');
  const { MarkdownAppLinkContext } =
    await import('@/components/markdown-content');
  return {
    ChatPage: (props: {
      workspacePane?: {
        openRequest?: string;
        render?: (paneProps: {
          conversationId: string | null;
          onClose: () => void;
          onFileOpen: () => void;
        }) => React.ReactNode;
      };
    }) => {
      chatPageProps.current = props as unknown as typeof chatPageProps.current;
      const onAppLink = useContext(MarkdownAppLinkContext);
      return (
        <>
          <button
            type="button"
            onClick={() =>
              onAppLink?.('/objective/project-1/obj-1?report=brief.md')
            }
          >
            activate report link
          </button>
          {props.workspacePane?.render?.({
            conversationId: null,
            onClose: () => undefined,
            onFileOpen: () => undefined,
          })}
        </>
      );
    },
  };
});
vi.mock('@/components/chat/preview-pane', async () => {
  const { useEffect } = await import('react');
  return {
    PreviewPane: (props: {
      renderWorkspaceExplorer?: (props: unknown) => unknown;
      localDefaultView?: string;
    }) => {
      previewPaneProps.current = props;
      useEffect(() => {
        previewPaneProps.mounts += 1;
      }, []);
      return props.renderWorkspaceExplorer?.({});
    },
  };
});
vi.mock('@/components/chat/runtime-picker', () => ({
  RuntimePicker: () => null,
}));
vi.mock('@/components/objective-explorer/objective-explorer', () => ({
  ObjectiveExplorer: (props: unknown) => {
    explorerProps.current = props as unknown as typeof explorerProps.current;
    return null;
  },
}));

function objective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 'obj-1',
    title: 'Server title',
    description: 'Server description',
    status: 'active',
    progress: 10,
    deadline: null,
    cost_limit_usd: null,
    ...overrides,
  } as Objective;
}

function setup(initial: Objective) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const tree = (obj: Objective, open = true) => (
    <QueryClientProvider client={client}>
      <EditObjectiveDialog
        objective={obj}
        project_id="project-1"
        open={open}
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>
  );
  const view = render(tree(initial));
  return { ...view, tree, onOpenChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  canLeaveActivePreview.mockResolvedValue(true);
});

describe('EditObjectiveDialog', () => {
  it('keeps typed edits across a refetch and saves only the changed fields', async () => {
    updateObjective.mockImplementation(async () => objective());
    const { rerender, tree } = setup(objective());

    fireEvent.change(screen.getByDisplayValue('Server title'), {
      target: { value: 'Typed title' },
    });

    // The brain advanced progress/status; the objective object is replaced.
    rerender(tree(objective({ progress: 60, status: 'paused' })));
    expect(screen.getByDisplayValue('Typed title')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateObjective).toHaveBeenCalledTimes(1));
    expect(updateObjective).toHaveBeenCalledWith('project-1', 'obj-1', {
      title: 'Typed title',
    });
  });

  it('closes without a request when nothing was edited', () => {
    const { onOpenChange } = setup(objective());

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateObjective).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the latest values after close and reopen', () => {
    const { rerender, tree } = setup(objective());
    fireEvent.change(screen.getByDisplayValue('Server title'), {
      target: { value: 'Typed title' },
    });

    rerender(tree(objective({ title: 'Newest title', progress: 60 }), false));
    rerender(tree(objective({ title: 'Newest title', progress: 60 }), true));

    expect(screen.getByDisplayValue('Newest title')).toBeTruthy();
    expect(screen.getByDisplayValue('60')).toBeTruthy();
  });

  it('shows a failed delete as an alert, keeps the dialog open, and clears it on No', async () => {
    deleteObjective.mockRejectedValue(new Error('boom'));
    const { onOpenChange } = setup(objective());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('boom');
    expect(alert.getAttribute('data-ui')).toBe('objective-delete-error');
    expect(onOpenChange).not.toHaveBeenCalled();
    // Confirm stays usable for a retry.
    expect(
      screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled'),
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('drops a delete error and disarms delete confirmation when Save closes the dialog', async () => {
    deleteObjective.mockRejectedValue(new Error('boom'));
    updateObjective.mockImplementation(async () => objective());
    const { rerender, tree } = setup(objective());

    fireEvent.change(screen.getByDisplayValue('Server title'), {
      target: { value: 'Typed title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateObjective).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

    rerender(tree(objective(), false));
    rerender(tree(objective(), true));
    expect(screen.queryByRole('alert')).toBeNull();
    // The delete confirmation is disarmed on reopen too.
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('shows no delete error and closes when the delete succeeds', async () => {
    deleteObjective.mockResolvedValue(undefined);
    const { onOpenChange } = setup(objective());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Edit Objective dialog labels', () => {
  it('exposes every field through its label', () => {
    setup(objective());

    for (const name of [
      'Title',
      'Description',
      'Status',
      'Progress (%)',
      'Deadline',
      'Cost limit (USD)',
    ]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });
});

describe('ObjectiveDetail inline progress', () => {
  async function openProgressEditor() {
    fetchObjective.mockResolvedValue(objective());
    updateObjective.mockImplementation(async () => objective());
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ObjectiveDetail project_id="project-1" objective_id="obj-1" />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByTitle('Click to update progress'));
    return screen.getByLabelText('Progress (%)');
  }

  it('keeps the editor open with an error and sends nothing for out-of-range input', async () => {
    const input = await openProgressEditor();

    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByRole('alert').textContent).toBe(
      'Enter a number from 0 to 100',
    );
    expect(screen.getByLabelText('Progress (%)')).toBeTruthy();
    expect(updateObjective).not.toHaveBeenCalled();
  });

  it('saves a valid value and closes the editor', async () => {
    const input = await openProgressEditor();

    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save progress' }));

    await waitFor(() =>
      expect(updateObjective).toHaveBeenCalledWith('project-1', 'obj-1', {
        progress: 80,
      }),
    );
    expect(screen.queryByLabelText('Progress (%)')).toBeNull();
  });
});

describe('ObjectiveDetail load failures', () => {
  function renderDetail() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ObjectiveDetail project_id="project-1" objective_id="obj-1" />
      </QueryClientProvider>,
    );
    return client;
  }

  it('offers Retry after an initial server error and renders the objective once it succeeds', async () => {
    fetchObjective.mockRejectedValueOnce(new ApiError('boom', 500));
    renderDetail();

    await screen.findByText('Failed to load objective');
    expect(
      screen.getByRole('link', { name: 'Back to objectives' }),
    ).toBeTruthy();
    fetchObjective.mockResolvedValue(objective());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Server title')).toBeTruthy();
    expect(screen.queryByText('Failed to load objective')).toBeNull();
  });

  it('tells a missing objective apart: no Retry, but a way back', async () => {
    fetchObjective.mockRejectedValue(new ApiError('Not found', 404));
    renderDetail();

    await screen.findByText('Objective not found');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Back to objectives' }),
    ).toBeTruthy();
  });

  it('keeps the loaded objective when a background refetch fails', async () => {
    fetchObjective.mockResolvedValue(objective());
    const client = renderDetail();
    await screen.findByText('Server title');

    fetchObjective.mockRejectedValue(new ApiError('boom', 500));
    await act(() => client.invalidateQueries());

    await waitFor(() => expect(fetchObjective).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Server title')).toBeTruthy();
    expect(
      document.querySelector(
        '[data-ui="objective-status-action"][aria-pressed="true"]',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Failed to load objective')).toBeNull();
  });
});

describe('ObjectiveDetail route navigation between objectives', () => {
  it('closes the inline progress editor when another objective opens', async () => {
    fetchObjective.mockImplementation(async (_p: string, id: string) =>
      objective({ id, title: `Title ${id}` }),
    );
    const Page = (Route as unknown as { component: React.ComponentType })
      .component;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = () => (
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    fireEvent.click(await screen.findByTitle('Click to update progress'));
    fireEvent.change(screen.getByLabelText('Progress (%)'), {
      target: { value: '80' },
    });

    routeParams.objectiveId = 'obj-2';
    rerender(tree());

    await screen.findByTitle('Click to update progress');
    expect(screen.queryByLabelText('Progress (%)')).toBeNull();
    routeParams.objectiveId = 'obj-1';
  });
});

describe('ObjectiveDetail report deep link', () => {
  function renderObjective(report?: string) {
    fetchObjective.mockResolvedValue(objective());
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (current?: string) => (
      <QueryClientProvider client={client}>
        <ObjectiveDetail
          project_id="project-1"
          objective_id="obj-1"
          report={current}
        />
      </QueryClientProvider>
    );
    return { ...render(tree(report)), tree };
  }

  it('reveals the report again when its chat link is activated again', async () => {
    renderObjective('brief.md');
    await screen.findByTitle('Click to update progress');

    const pane = () => chatPageProps.current?.workspacePane;
    const explorer = () => explorerProps.current;
    expect(pane()?.openRequest).toBe('brief.md#0');
    expect(explorer()?.initial_report).toBe('brief.md');

    // The report was opened once; the workspace pane is closed afterwards.
    act(() => explorer()?.onInitialReportOpened?.('brief.md'));
    expect(explorer()?.initial_report).toBeUndefined();

    const mounts = previewPaneProps.mounts;
    fireEvent.click(
      screen.getByRole('button', { name: 'activate report link' }),
    );

    // The URL does not change, so the pane has to be re-opened explicitly.
    // The activation waits for the leave guard, so the new request lands
    // asynchronously.
    await waitFor(() => expect(pane()?.openRequest).toBe('brief.md#1'));
    expect(explorer()?.initial_report).toBe('brief.md');
    // The workspace is re-created for the new request and shows the view
    // that opens the report.
    expect(previewPaneProps.mounts).toBe(mounts + 1);
    expect(previewPaneProps.current?.localDefaultView).toBe('files');
  });

  it('opens the report when its chat link is activated while the page has no report', async () => {
    renderObjective(undefined);
    await screen.findByTitle('Click to update progress');

    const explorer = () => explorerProps.current;
    expect(explorer()?.initial_report).toBeUndefined();

    fireEvent.click(
      screen.getByRole('button', { name: 'activate report link' }),
    );

    await waitFor(() => expect(explorer()?.initial_report).toBe('brief.md'));
  });

  it('keeps the report request untouched when the editor may not be left', async () => {
    // The editor holds an unsaved draft: leaving it has to be confirmed
    // first, and a cancelled confirmation must change nothing.
    canLeaveActivePreview.mockResolvedValue(false);
    renderObjective('brief.md');
    await screen.findByTitle('Click to update progress');

    const pane = () => chatPageProps.current?.workspacePane;
    const mounts = previewPaneProps.mounts;

    fireEvent.click(
      screen.getByRole('button', { name: 'activate report link' }),
    );

    await waitFor(() =>
      expect(canLeaveActivePreview).toHaveBeenCalledWith('project-1'),
    );
    await act(async () => {});

    // The request is untouched, so the workspace (and the editor with its
    // draft) is not rebuilt.
    expect(pane()?.openRequest).toBe('brief.md#0');
    expect(previewPaneProps.mounts).toBe(mounts);
  });

  it('opens the report again when the deep link points at it once more', async () => {
    const { rerender, tree } = renderObjective('brief.md');
    await screen.findByTitle('Click to update progress');

    const explorer = () => explorerProps.current;
    expect(explorer()?.initial_report).toBe('brief.md');
    act(() => explorer()?.onInitialReportOpened?.('brief.md'));
    expect(explorer()?.initial_report).toBeUndefined();

    // Leaving the report and coming back to the same one is a new request:
    // the report of the previous request must not suppress it.
    rerender(tree(undefined));
    expect(explorer()?.initial_report).toBeUndefined();

    rerender(tree('brief.md'));
    expect(explorer()?.initial_report).toBe('brief.md');
  });
});
