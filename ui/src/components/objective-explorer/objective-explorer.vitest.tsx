import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth';
import { useStore } from '@/store';
import { ObjectiveExplorer } from './objective-explorer';

const api = vi.hoisted(() => ({
  fetchObjectiveDashboardTicket: vi.fn(),
}));
const projectState = vi.hoisted(() => ({
  data: undefined as { accessLevel: string | null } | undefined,
}));

vi.mock('@/lib/api', () => api);
vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({ data: projectState.data }),
}));
vi.mock('./runs-tab', () => ({ RunsTab: () => null }));
vi.mock('./events-tab', () => ({ EventsTab: () => null }));
vi.mock('@/components/chat/bash-tab', () => ({ BashTab: () => null }));
vi.mock('@/components/chat/changes-tab', () => ({ ChangesTab: () => null }));
vi.mock('@/components/chat/files-tab', () => ({ FilesTab: () => null }));

function renderExplorer(
  projectId: string,
  conversationId: string | null = null,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ObjectiveExplorer
        project_id={projectId}
        objective_id="objective-one"
        conversation_id={conversationId}
      />
    </QueryClientProvider>,
  );
}

describe('ObjectiveExplorer tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useStore.setState({
      pendingPreviewActivationByProject: {},
      previewTabsByProject: {},
    });
  });

  it('keeps Dashboard and every objective tool reachable beside an open preview', async () => {
    const user = userEvent.setup();
    const onTabValueChange = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ObjectiveExplorer
          project_id="project-one"
          objective_id="objective-one"
          conversation_id={null}
          tabValue="preview"
          onTabValueChange={onTabValueChange}
          previewStrip={<div data-ui="test-preview-strip">Open file</div>}
          previewBody={<div data-ui="test-preview-body">Preview body</div>}
        />
      </QueryClientProvider>,
    );

    for (const name of [
      'Dashboard',
      'Runs',
      'Events',
      'Files',
      'Browser',
      'Bash',
      'Changes',
    ]) {
      expect(screen.getByRole('tab', { name })).toBeTruthy();
    }
    expect(
      document.querySelector('[data-ui="test-preview-strip"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-ui="test-preview-body"]'),
    ).toBeTruthy();

    expect(screen.queryByRole('tab', { name: 'Artifacts' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Reports' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Objective Files' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Dashboard' }));
    expect(onTabValueChange).toHaveBeenCalledWith('dashboard');
    await user.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(onTabValueChange).toHaveBeenCalledWith('changes');
  });

  it.each([
    [null, false],
    ['viewer', false],
    ['editor', true],
  ])(
    'shows the Bash tab for a non-admin user only with explicit access (accessLevel %s)',
    (accessLevel, visible) => {
      projectState.data = { accessLevel };
      useAuth.setState({ user: { role: 'user' } as never });
      try {
        renderExplorer('project-one');
        expect(!!screen.queryByRole('tab', { name: 'Bash' })).toBe(visible);
      } finally {
        projectState.data = undefined;
        useAuth.setState({ user: null });
      }
    },
  );
});
