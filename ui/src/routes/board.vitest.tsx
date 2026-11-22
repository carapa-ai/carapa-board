import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ComponentType } from 'react';
import { Route } from './board.$projectId';

const fetchProjects = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ projectId: 'gone' }));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => routeParams,
  }),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  Navigate: () => null,
  useBlocker: () => undefined,
  useLocation: () => '',
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  fetchProjects,
  fetchConfig: vi.fn(async () => ({ enableKanban: true })),
  cachedProjects: () => undefined,
}));
vi.mock('@/components/board/kanban-board', () => ({
  KanbanBoard: ({ project_id }: { project_id: string }) => {
    // Stands in for the board's local state (selection, filters).
    const [mountedFor] = useState(project_id);
    return <div data-testid="board" data-mounted-for={mountedFor} />;
  },
}));
vi.mock('@/components/layout/header', () => ({ Header: () => null }));
vi.mock('@/components/layout/project-dialogs', () => ({
  ProjectDialogs: () => null,
}));
vi.mock('@/components/project-workspace-pane', () => ({
  ProjectWorkspacePane: () => null,
}));
vi.mock('@/hooks/use-tasks', () => ({ useTasks: () => ({ data: [] }) }));
vi.mock('@/hooks/use-project-workspace-pane', () => ({
  useProjectWorkspacePane: () => ({
    open: false,
    setOpen: vi.fn(),
    setOpenAfterLeaveCheck: vi.fn(),
    width: 400,
    layoutRef: { current: null },
    startResize: vi.fn(),
    cancelResize: vi.fn(),
  }),
}));
vi.mock('@/hooks/use-workspace-pane-reveal', () => ({
  useWorkspacePaneReveal: () => undefined,
}));
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('@/store', () => ({
  canLeaveActivePreview: () => true,
  useStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({ detailTaskId: null, setDetailTaskId: vi.fn() }),
}));
vi.mock('@/hooks/use-projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-projects')>()),
  useAcknowledgeVisibleKanbanCompletions: () => undefined,
}));

const BoardPage = (Route as unknown as { component: ComponentType }).component;

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <BoardPage />
    </QueryClientProvider>
  );
  return { ...render(tree()), tree };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('board route for an unknown project', () => {
  it('shows Project not found with a home link once projects loaded', async () => {
    fetchProjects.mockResolvedValue([{ id: 'other', settings: {} }]);
    renderPage();
    expect(await screen.findByText('Project not found')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Back to projects' })
        .getAttribute('href'),
    ).toBe('/');
    expect(screen.queryByTestId('board')).toBeNull();
  });

  it('does not flash not-found while projects are loading', async () => {
    fetchProjects.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.queryByText('Project not found')).toBeNull();
  });

  it('renders the board for an existing project', async () => {
    fetchProjects.mockResolvedValue([{ id: 'gone', settings: {} }]);
    renderPage();
    expect(await screen.findByTestId('board')).toBeTruthy();
    expect(screen.queryByText('Project not found')).toBeNull();
  });

  it('remounts the board when the project changes so local state is dropped', async () => {
    fetchProjects.mockResolvedValue([
      { id: 'gone', settings: {} },
      { id: 'next', settings: {} },
    ]);
    const { rerender, tree } = renderPage();
    const board = await screen.findByTestId('board');
    expect(board.getAttribute('data-mounted-for')).toBe('gone');

    routeParams.projectId = 'next';
    rerender(tree());

    expect(
      (await screen.findByTestId('board')).getAttribute('data-mounted-for'),
    ).toBe('next');
    routeParams.projectId = 'gone';
  });
});
