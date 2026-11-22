import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import { Route } from './objectives.$projectId';

const fetchObjectives = vi.hoisted(() => vi.fn());
const fetchProjects = vi.hoisted(() => vi.fn());
const createObjective = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ projectId: 'project-1' }),
  }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  Navigate: () => null,
  useBlocker: () => undefined,
  useNavigate: () => navigate,
}));
vi.mock('@/lib/api', () => ({
  fetchObjectives,
  createObjective,
  fetchConfig: vi.fn(async () => ({ enableObjectives: true })),
  fetchProjects,
  cachedProjects: () => undefined,
}));
vi.mock('@/components/layout/header', () => ({ Header: () => null }));
vi.mock('@/components/layout/project-settings-dialog', () => ({
  ProjectSettingsDialog: () => null,
}));
vi.mock('@/components/project-workspace-pane', () => ({
  ProjectWorkspacePane: () => null,
}));
vi.mock('@/components/ObjectiveCard', () => ({ ObjectiveCard: () => null }));
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
vi.mock('@/store', () => ({ canLeaveActivePreview: () => true }));

const ObjectivesPage = (Route as unknown as { component: ComponentType })
  .component;

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ObjectivesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchProjects.mockResolvedValue([
    { id: 'project-1', settings: { enabledModes: ['objectives'] } },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('objectives page query errors', () => {
  it('shows the fetch error with Retry instead of the empty state, and Retry refetches', async () => {
    fetchObjectives.mockRejectedValueOnce(new Error('objectives boom'));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ObjectivesPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('objectives boom')).toBeTruthy();
    expect(screen.queryByText('No objectives yet')).toBeNull();
    fetchObjectives.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No objectives yet')).toBeTruthy();
    expect(fetchObjectives).toHaveBeenCalledTimes(2);
  });
});

describe('objectives page create failure', () => {
  it('toasts the server reason, stays put, and re-enables New Objective', async () => {
    fetchObjectives.mockResolvedValue([]);
    createObjective.mockRejectedValueOnce(new Error('create boom'));
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'New Objective' }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0][0]).toContain('create boom');
    expect(navigate).not.toHaveBeenCalled();
    const button = await screen.findByRole('button', { name: 'New Objective' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('objectives route for an unknown project', () => {
  it('shows Project not found with a home link once projects loaded', async () => {
    fetchProjects.mockResolvedValue([{ id: 'other', settings: {} }]);
    fetchObjectives.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Project not found')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Back to projects' })
        .getAttribute('href'),
    ).toBe('/');
    expect(screen.queryByText('No objectives yet')).toBeNull();
  });

  it('does not flash not-found while projects are loading', () => {
    fetchProjects.mockReturnValue(new Promise(() => undefined));
    fetchObjectives.mockResolvedValue([]);
    renderPage();
    expect(screen.queryByText('Project not found')).toBeNull();
  });
});
