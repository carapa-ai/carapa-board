// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './sidebar';
import { PageHeader } from './page-header';
import { Header } from './header';
import { useStore } from '@/store';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useParams: () => ({ projectId: 'project-1' }),
  useRouterState: ({ select }: any = {}) =>
    select
      ? select({ location: { pathname: '/projects' } })
      : { location: { pathname: '/projects' } },
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({ data: EMPTY_PROJECTS }),
  useUpdateProjectsOrder: () => ({ mutate: vi.fn() }),
  useProjectsStatusSummary: () => ({ data: EMPTY_STATUS }),
  useStopProject: () => ({ mutate: vi.fn() }),
  usePauseProject: () => ({ mutate: vi.fn() }),
  useStartProject: () => ({ mutate: vi.fn() }),
  useSetParallelism: () => vi.fn(),
  useUpdateProjectMode: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/hooks/use-whatsapp', () => ({
  useWhatsAppStatus: () => ({ data: null }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: (selector: any) => selector({ user: null }),
}));
vi.mock('@/lib/api', () => ({
  fetchConfig: vi.fn(async () => ({ enableWhatsApp: false })),
  logoutWhatsApp: vi.fn(),
  rebuildBoard: vi.fn(),
  restartBoard: vi.fn(),
  fetchAttention: vi.fn(async () => ({ items: [], objectives: [] })),
  fetchUnreadNotifications: vi.fn(async () => ({ items: [], count: 0 })),
}));
vi.mock('@/hooks/use-sandbox', () => ({
  useSandboxStatus: () => ({ data: null }),
  usePublishedApp: () => ({ data: null }),
  useStartSandbox: () => ({ mutate: vi.fn(), isPending: false }),
  useRestartSandbox: () => ({ mutate: vi.fn(), isPending: false }),
  useRestartSandboxWhenIdle: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelPendingRestart: () => ({ mutate: vi.fn(), isPending: false }),
  useSandboxPendingRestart: () => ({ data: null }),
  useSandboxPs: () => ({ data: null }),
  useSandboxInstancePs: () => ({ data: null }),
}));
vi.mock('@/components/layout/sandbox-info-dialog', () => ({
  SandboxInfoDialog: () => null,
  computeAggregatedVersionStatus: () => null,
}));
vi.mock('./add-project-dialog', () => ({ AddProjectDialog: () => null }));
vi.mock('./add-whatsapp-group-dialog', () => ({
  AddWhatsAppGroupDialog: () => null,
}));
vi.mock('./link-project-to-whatsapp-dialog', () => ({
  LinkProjectToWhatsAppDialog: () => null,
}));
vi.mock('@/components/layout/header-utilities', () => ({
  HeaderUtilities: () => null,
}));
vi.mock('@/components/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));

const EMPTY_PROJECTS: any[] = [];
const EMPTY_STATUS = {
  projects: {},
  running: [] as string[],
  completed: [] as string[],
};

beforeEach(() => {
  useStore.setState({
    sidebarOpen: false,
    desktopSidebarCollapsed: false,
  });
});
afterEach(cleanup);
describe('mounted sidebar collapse controls', () => {
  function renderSidebar(children: ReactNode = <Sidebar />) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>,
    );
  }

  it('keeps the global sidebar mounted when collapsed', async () => {
    const user = userEvent.setup();
    renderSidebar();

    expect(screen.getByRole('complementary')).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Hide project sidebar' }),
    );

    expect(useStore.getState().desktopSidebarCollapsed).toBe(true);
    expect(screen.getByRole('complementary')).toBeTruthy();
  });

  it('exposes labelled global expand controls in both production headers', async () => {
    useStore.setState({ desktopSidebarCollapsed: true });
    renderSidebar(
      <>
        <PageHeader title="Projects" />
        <Header project_id="project-1" />
      </>,
    );

    const expanders = await waitFor(() =>
      screen.getAllByRole('button', { name: 'Show project sidebar' }),
    );
    expect(expanders).toHaveLength(2);
    for (const expander of expanders) {
      expect(expander.getAttribute('aria-controls')).toBe('global-sidebar');
    }
  });
});
