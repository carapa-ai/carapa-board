import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from './preview-pane';
import { ConfirmDialogHost } from '@/components/confirm-dialog';
import { EditableFileConflictError, saveEditableFile } from '@/lib/api';
import { registerPreviewTabLeaveGuard, useStore } from '@/store';
import {
  snapshotOpenFileContext,
  publishOpenFileContext,
} from '@/lib/open-file-context';

const capacitorState = vi.hoisted(() => ({ native: true }));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.native,
    getPlatform: () => 'android',
  },
}));
vi.mock('@/components/chat/conversation-explorer', () => ({
  ConversationExplorer: ({
    previewStrip,
    previewBody,
    tabValue,
    onClose,
    onTabValueChange,
  }: {
    previewStrip?: React.ReactNode;
    previewBody?: React.ReactNode;
    tabValue?: string;
    onClose?: () => void;
    onTabValueChange?: (value: string) => void;
  }) => (
    <div
      data-ui="test-conversation-explorer"
      data-selected-view={tabValue ?? 'files'}
    >
      {previewStrip}
      {tabValue === 'preview' && previewBody}
      <button
        data-ui="test-files-tab"
        onClick={() => onTabValueChange?.('files')}
      >
        Files
      </button>
      <button data-ui="test-panel-close" onClick={onClose}>
        Close panel
      </button>
    </div>
  ),
}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(
    async (_url: string, init?: RequestInit) =>
      new Response(init?.method === 'HEAD' ? null : 'content', {
        status: 200,
        headers: { 'Content-Length': '7', 'Content-Type': 'text/plain' },
      }),
  ),
  EditableFileConflictError: class extends Error {},
  loadEditableFile: vi.fn(async () => ({
    content: 'saved content',
    revision: 'a'.repeat(64),
    sensitive: false,
  })),
  parseFileContentResponse: vi.fn(async () => 'content'),
  readGroupFileContent: vi.fn(async () => ({ content: 'content' })),
  readRepoFileContent: vi.fn(async () => ({ content: 'content' })),
  saveEditableFile: vi.fn(),
}));
vi.mock('@/hooks/use-secure-media', () => ({
  useSecureMedia: (url: string) => url,
}));
vi.mock('@/components/markdown-content-lazy', () => ({
  MarkdownContent: () => null,
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'owner', role: 'admin', username: 'owner' } }),
}));
vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({
    data: { id: 'project', userId: 'owner', accessLevel: 'owner' },
  }),
}));
vi.mock('@/hooks/use-live-voice', () => ({
  useLiveVoice: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    finish: vi.fn(),
    status: 'idle',
    capturing: false,
  }),
  useDictationFailureToast: () => undefined,
}));

describe('PreviewPane mobile lifecycle', () => {
  beforeEach(() => {
    capacitorState.native = true;
    publishOpenFileContext(null);
    useStore.setState({
      workspaceViewByProject: {},
      pendingPreviewActivationByProject: {},
      previewTabsByProject: {
        project: {
          tabs: [
            {
              id: 'artifact',
              title: 'plan.md',
              kind: 'file',
              source: 'group',
              path: 'artifacts/plans/plan.md',
              openFileContextConversationId: 'conversation-a',
            },
          ],
          activeTabId: 'artifact',
          activationSequence: 1,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    publishOpenFileContext(null);
    useStore.setState({
      previewTabsByProject: {},
      pendingPreviewActivationByProject: {},
      workspaceViewByProject: {},
    });
  });

  it('publishes only for the establishing conversation and keeps the workspace open when the last file closes', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    const onClose = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane
          project_id="project"
          conversation_id="conversation-a"
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(snapshotOpenFileContext('conversation-a')?.path).toBe(
        'plans/plan.md',
      ),
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Close plan.md'));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(useStore.getState().previewTabsByProject.project).toBeUndefined();
    expect(
      document.querySelector('[data-ui="test-conversation-explorer"]'),
    ).not.toBeNull();
  });

  it('does not treat destination-project preview tabs as a new activation', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id="project" conversation_id="conversation-a" />
      </QueryClientProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    });
    useStore.setState({
      previewTabsByProject: {
        ...useStore.getState().previewTabsByProject,
        'other-project': {
          tabs: [
            {
              id: 'other-file',
              title: 'other.md',
              kind: 'file',
              source: 'group',
              path: 'artifacts/other.md',
            },
          ],
          activeTabId: 'other-file',
          activationSequence: 9,
        },
      },
    });
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id="other-project" conversation_id={null} />
      </QueryClientProvider>,
    );

    expect(useStore.getState().workspaceViewByProject.project).toBe('files');
    expect(
      useStore.getState().workspaceViewByProject['other-project'],
    ).toBeUndefined();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id="project" conversation_id="conversation-a" />
      </QueryClientProvider>,
    );
    expect(
      document
        .querySelector('[data-ui="test-conversation-explorer"]')
        ?.getAttribute('data-selected-view'),
    ).toBe('files');
  });

  it('jumps to an explicitly opened file when the pane was closed before opening', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useStore.getState().setWorkspaceViewForProject('project', 'files');

    const first = render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id="project" conversation_id="conversation-a" />
      </QueryClientProvider>,
    );
    expect(
      document
        .querySelector('[data-ui="test-conversation-explorer"]')
        ?.getAttribute('data-selected-view'),
    ).toBe('files');
    first.unmount();

    useStore.getState().openPreviewTab('project', {
      id: 'opened-while-closed',
      title: 'opened.md',
      kind: 'file',
      source: 'group',
      path: 'artifacts/opened.md',
    });

    render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id="project" conversation_id="conversation-a" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-ui="test-conversation-explorer"]')
          ?.getAttribute('data-selected-view'),
      ).toBe('preview'),
    );
    expect(
      useStore.getState().pendingPreviewActivationByProject.project,
    ).toBeUndefined();
  });

  it('consumes mounted activations before a top-level view can survive a remount', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id="project" conversation_id="conversation-a" />
      </QueryClientProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    });
    useStore.getState().openPreviewTab('project', {
      id: 'opened-while-mounted',
      title: 'opened-mounted.md',
      kind: 'file',
      source: 'group',
      path: 'artifacts/opened-mounted.md',
    });
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-ui="test-conversation-explorer"]')
          ?.getAttribute('data-selected-view'),
      ).toBe('preview'),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    });
    expect(
      useStore.getState().pendingPreviewActivationByProject.project,
    ).toBeUndefined();
    expect(
      document
        .querySelector('[data-ui="test-conversation-explorer"]')
        ?.getAttribute('data-selected-view'),
    ).toBe('files');

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id="project" conversation_id={null} />
      </QueryClientProvider>,
    );
    expect(
      document
        .querySelector('[data-ui="test-conversation-explorer"]')
        ?.getAttribute('data-selected-view'),
    ).toBe('files');
  });

  it('keeps Objective mode on its local active preview lifecycle', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useStore.setState({
      workspaceViewByProject: { project: 'files' },
      pendingPreviewActivationByProject: { project: true },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane
          project_id="project"
          conversation_id="conversation-a"
          workspaceViewScope="local"
        />
      </QueryClientProvider>,
    );

    expect(
      document
        .querySelector('[data-ui="test-conversation-explorer"]')!
        .getAttribute('data-selected-view'),
    ).toBe('preview');
    expect(useStore.getState().workspaceViewByProject.project).toBe('files');
    expect(
      useStore.getState().pendingPreviewActivationByProject.project,
    ).toBeUndefined();
  });

  it('composes objective views with previews and blocks a dirty preview tab leave', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const renderObjectiveExplorer = ({
      tabValue,
      onTabValueChange,
      previewBody,
    }: {
      tabValue: string;
      onTabValueChange: (value: string) => void;
      previewBody?: React.ReactNode;
    }) => (
      <div data-ui="test-objective-explorer" data-selected-view={tabValue}>
        <button onClick={() => onTabValueChange('dashboard')}>Dashboard</button>
        <button onClick={() => onTabValueChange('preview')}>Open file</button>
        {tabValue === 'preview' && previewBody}
      </div>
    );

    render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane
          project_id="project"
          conversation_id="conversation-a"
          workspaceViewScope="local"
          localDefaultView="dashboard"
          renderWorkspaceExplorer={renderObjectiveExplorer}
        />
      </QueryClientProvider>,
    );

    const explorer = document.querySelector(
      '[data-ui="test-objective-explorer"]',
    )!;
    expect(explorer.getAttribute('data-selected-view')).toBe('dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(explorer.getAttribute('data-selected-view')).toBe('preview');
    expect(
      document.querySelector('[data-ui="open-file-preview-body"]'),
    ).toBeTruthy();

    const unregister = registerPreviewTabLeaveGuard(
      'project',
      'artifact',
      () => false,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    });
    expect(explorer.getAttribute('data-selected-view')).toBe('preview');
    expect(useStore.getState().previewTabsByProject.project?.tabs).toHaveLength(
      1,
    );

    unregister();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    });
    expect(explorer.getAttribute('data-selected-view')).toBe('dashboard');
    expect(useStore.getState().previewTabsByProject.project?.tabs).toHaveLength(
      1,
    );
    expect(useStore.getState().workspaceViewByProject.project).toBeUndefined();
  });

  it('does not close the Android panel when closing a preview breadcrumb from Files', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    const onClose = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane
          project_id="project"
          conversation_id="conversation-a"
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(snapshotOpenFileContext('conversation-a')?.path).toBe(
        'plans/plan.md',
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Close plan.md'));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(useStore.getState().previewTabsByProject.project).toBeUndefined();
    expect(
      document
        .querySelector('[data-ui="test-conversation-explorer"]')!
        .getAttribute('data-selected-view'),
    ).toBe('files');
  });

  it('evaluates a dirty preview leave guard once per close attempt', async () => {
    capacitorState.native = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    const onClose = vi.fn();
    const guard = vi.fn(() => false);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane
          project_id="project"
          conversation_id="conversation-a"
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Close plan.md')).toBeTruthy(),
    );
    const unregister = registerPreviewTabLeaveGuard(
      'project',
      'artifact',
      guard,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Close plan.md'));
    });
    expect(guard).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(useStore.getState().previewTabsByProject.project).toBeDefined();

    unregister();
    guard.mockReturnValue(true);
    const unregisterAccepted = registerPreviewTabLeaveGuard(
      'project',
      'artifact',
      guard,
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Close plan.md'));
    });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    unregisterAccepted();
  });
  it('resets the editor when the pane moves to another project with the same file', async () => {
    capacitorState.native = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    const projectState = useStore.getState().previewTabsByProject.project!;
    useStore.setState({
      previewTabsByProject: {
        project: projectState,
        other: { ...projectState },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = (projectId: string) => (
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id={projectId} conversation_id={null} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui('project'));

    await userEvent.click(
      await screen.findByRole('button', { name: 'Edit file' }),
    );
    const editor = await screen.findByRole('textbox', { name: 'Edit plan.md' });
    await userEvent.clear(editor);
    await userEvent.type(editor, 'unsaved draft');

    rerender(ui('other'));

    await screen.findByRole('button', { name: 'Edit file' });
    expect(screen.queryByRole('textbox', { name: 'Edit plan.md' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
  it('blocks browser unload after an owner edits a group file', async () => {
    capacitorState.native = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane
          project_id="project"
          conversation_id="conversation-a"
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(
      await screen.findByRole('button', { name: 'Edit file' }),
    );
    const editor = await screen.findByRole('textbox', { name: 'Edit plan.md' });
    await userEvent.clear(editor);
    await userEvent.type(editor, 'unsaved draft');

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('asks in the in-app dialog before discarding a dirty draft', async () => {
    capacitorState.native = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    const nativeConfirm = vi.spyOn(window, 'confirm');
    vi.mocked(saveEditableFile).mockRejectedValueOnce(
      new EditableFileConflictError('f'.repeat(64), 5),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane
          project_id="project"
          conversation_id="conversation-a"
          onClose={vi.fn()}
        />
        <ConfirmDialogHost />
      </QueryClientProvider>,
    );
    const dialogButton = (name: 'cancel' | 'confirm') =>
      screen.findByRole('button', {
        name: name === 'cancel' ? 'Cancel' : 'Discard',
      });

    // A clean editor leaves without a prompt.
    await userEvent.click(
      await screen.findByRole('button', { name: 'Edit file' }),
    );
    await screen.findByRole('textbox', { name: 'Edit plan.md' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', { name: 'Edit plan.md' }),
      ).toBeNull(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    // Cancel on a dirty draft asks first; declining keeps the draft.
    await userEvent.click(
      await screen.findByRole('button', { name: 'Edit file' }),
    );
    const editor = await screen.findByRole('textbox', { name: 'Edit plan.md' });
    await userEvent.clear(editor);
    await userEvent.type(editor, 'unsaved draft');
    const draft = (editor as HTMLTextAreaElement).value;
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await userEvent.click(
      document.querySelector<HTMLElement>('[data-ui="confirm-dialog-cancel"]')!,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((editor as HTMLTextAreaElement).value).toBe(draft);

    // Reload (offered after a save conflict) asks before replacing the draft.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reload latest' }),
    );
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await userEvent.click(
      document.querySelector<HTMLElement>('[data-ui="confirm-dialog-cancel"]')!,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((editor as HTMLTextAreaElement).value).toBe(draft);

    // Confirming Discard on Cancel leaves the editor.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(await dialogButton('confirm'));
    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', { name: 'Edit plan.md' }),
      ).toBeNull(),
    );
    expect(nativeConfirm).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });

  it('establishes context when the destination explicitly reselects a preview tab', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id="project" conversation_id="conversation-b" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(snapshotOpenFileContext('conversation-b')).toBeUndefined(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'plan.md' }));
    await waitFor(() =>
      expect(snapshotOpenFileContext('conversation-b')?.path).toBe(
        'plans/plan.md',
      ),
    );
    expect(
      useStore.getState().previewTabsByProject.project?.tabs[0]
        ?.openFileContextConversationId,
    ).toBe('conversation-b');
  });

  it('promotes New-composer context when its conversation is created', async () => {
    capacitorState.native = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    useStore.setState({
      previewTabsByProject: {
        project: {
          tabs: [
            {
              id: 'new-file',
              title: 'new.md',
              kind: 'file',
              source: 'group',
              path: 'plans/new.md',
              openFileContextConversationId: null,
            },
          ],
          activeTabId: 'new-file',
          activationSequence: 1,
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id="project" conversation_id={null} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(snapshotOpenFileContext(null)?.path).toBe('plans/new.md'),
    );

    useStore
      .getState()
      .promotePreviewTabOpenFileContext('project', null, 'conversation-new');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <PreviewPane project_id="project" conversation_id="conversation-new" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(snapshotOpenFileContext('conversation-new')?.path).toBe(
        'plans/new.md',
      ),
    );
  });
});
