// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

const originalWidth = window.innerWidth;

beforeEach(() => {
  window.innerWidth = 400;
  useStore.setState({ sidebarOpen: false, desktopSidebarCollapsed: false });
});
afterEach(() => {
  cleanup();
  window.innerWidth = originalWidth;
});

function renderShell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PageHeader title="Projects" />
      <Header project_id="project-1" />
      <Sidebar />
    </QueryClientProvider>,
  );
}

describe('mobile project drawer accessibility', () => {
  it('hides the closed drawer below md without changing desktop classes', () => {
    renderShell();
    const classes = screen
      .getByRole('complementary', { hidden: true })
      .className.split(/\s+/);

    expect(classes).toContain('max-md:invisible');
    expect(classes).toContain('md:translate-x-0');
    expect(classes).not.toContain('invisible');
    expect(classes.some((c) => /^md:!?(invisible|hidden)$/.test(c))).toBe(
      false,
    );
  });

  it('shows the open drawer, focuses Close menu and exposes trigger state', async () => {
    const user = userEvent.setup();
    renderShell();
    const triggers = screen.getAllByRole('button', { name: 'Open menu' });
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(trigger.getAttribute('aria-controls')).toBe('global-sidebar');
    }

    await user.click(triggers[0]);

    const close = screen.getByRole('button', { name: 'Close menu' });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(screen.getByRole('dialog').className).not.toContain(
      'max-md:invisible',
    );
    for (const trigger of screen.getAllByRole('button', {
      name: 'Open menu',
    })) {
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
    }
  });

  it('closes on Escape and returns focus to the trigger that opened it', async () => {
    const user = userEvent.setup();
    renderShell();
    const trigger = screen.getAllByRole('button', { name: 'Open menu' })[1];
    await user.click(trigger);
    expect(useStore.getState().sidebarOpen).toBe(true);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Close menu' }),
      ),
    );

    await user.keyboard('{Escape}');

    expect(useStore.getState().sidebarOpen).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('traps Tab and Shift+Tab inside the open mobile drawer', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getAllByRole('button', { name: 'Open menu' })[0]);
    const drawer = screen.getByRole('dialog', { name: 'Project menu' });
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    const close = screen.getByRole('button', { name: 'Close menu' });
    await waitFor(() => expect(document.activeElement).toBe(close));

    await user.tab({ shift: true });
    const last = document.activeElement as HTMLElement;
    expect(last).not.toBe(close);
    expect(drawer.contains(last)).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(close);

    for (let i = 0; i < 70; i++) {
      await user.tab();
      expect(drawer.contains(document.activeElement)).toBe(true);
    }
  });

  it('releases the Tab trap when the viewport grows past md while open', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getAllByRole('button', { name: 'Open menu' })[0]);
    await screen.findByRole('dialog', { name: 'Project menu' });

    act(() => {
      window.innerWidth = 1024;
      window.dispatchEvent(new Event('resize'));
    });

    const drawer = await screen.findByRole('complementary');
    expect(drawer.getAttribute('role')).toBeNull();
    expect(drawer.getAttribute('aria-modal')).toBeNull();
    // Desktop Tab must not be intercepted by the drawer trap.
    const prevented: boolean[] = [];
    const record = (e: KeyboardEvent) => prevented.push(e.defaultPrevented);
    document.addEventListener('keydown', record);
    const tabbables = drawer.querySelectorAll<HTMLElement>('button, a[href]');
    tabbables[tabbables.length - 1].focus();
    await user.tab();
    document.removeEventListener('keydown', record);
    expect(prevented).toEqual([false]);
    expect(drawer.contains(document.activeElement)).toBe(false);
  });
});
