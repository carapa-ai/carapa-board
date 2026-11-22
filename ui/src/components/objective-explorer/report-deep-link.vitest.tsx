import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import { ObjectiveExplorer } from './objective-explorer';

const api = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  listGroupFiles: vi.fn(),
  listRepoFiles: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  ...api,
}));
vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({ data: undefined }),
  useProjects: () => ({ data: [] }),
}));
vi.mock('@/components/chat/knowledge-source', () => ({
  useKnowledgeSource: () => ({
    id: 'knowledge',
    label: 'Knowledge',
    list: async () => ({ entries: [] }),
    open: () => undefined,
  }),
}));
vi.mock('./runs-tab', () => ({ RunsTab: () => null }));
vi.mock('./events-tab', () => ({ EventsTab: () => null }));
vi.mock('./objective-dashboard', () => ({ ObjectiveDashboard: () => null }));
vi.mock('@/components/chat/browser-tab', () => ({ BrowserTab: () => null }));
vi.mock('@/components/chat/bash-tab', () => ({ BashTab: () => null }));
vi.mock('@/components/chat/changes-tab', () => ({ ChangesTab: () => null }));

const ROOT = 'objectives/objective-one';
const REPORT = '2026-10-13-morning-brief.md';

// Mirrors ObjectiveDetail: the parent owns the opened-report state and
// survives the explorer being unmounted when the workspace pane closes.
function Parent({
  tabValue = 'files',
  report,
  mounted = true,
}: {
  tabValue?: string;
  report?: string;
  mounted?: boolean;
}) {
  const [openedReport, setOpenedReport] = useState<string>();
  return mounted ? (
    <ObjectiveExplorer
      project_id="project-one"
      objective_id="objective-one"
      tabValue={tabValue}
      initial_report={report !== openedReport ? report : undefined}
      onInitialReportOpened={setOpenedReport}
    />
  ) : null;
}

function renderExplorer(props: { tabValue?: string; report?: string }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (p: typeof props & { mounted?: boolean }) => (
    <QueryClientProvider client={queryClient}>
      <Parent {...p} />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  return {
    ...view,
    update: (p: typeof props & { mounted?: boolean }) => view.rerender(ui(p)),
  };
}

const headProbes = () =>
  api.apiFetch.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === 'HEAD',
  ).length;

// Promises of the HEAD probes issued from call index `fromCall` onward.
const headProbePromises = (fromCall: number) =>
  api.apiFetch.mock.calls.flatMap(([, init], index) =>
    (init as RequestInit | undefined)?.method === 'HEAD' && index >= fromCall
      ? [api.apiFetch.mock.results[index]!.value as Promise<unknown>]
      : [],
  );

const previewTabs = () =>
  useStore.getState().previewTabsByProject['project-one']?.tabs ?? [];

beforeAll(() => {
  // The explorer defers loading until visible; jsdom has no IntersectionObserver.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
});

describe('objective files section and report deep link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useStore.setState({
      pendingPreviewActivationByProject: {},
      previewTabsByProject: {},
    });
    api.apiFetch.mockImplementation(async (url: string) =>
      url.includes(encodeURIComponent(`${ROOT}/reports/${REPORT}`))
        ? new Response(null, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          })
        : new Response(null, { status: 404 }),
    );
    api.listRepoFiles.mockResolvedValue({ entries: [] });
    api.listGroupFiles.mockImplementation(
      async (_p: string, o: { path?: string; search?: string }) => {
        if (o.search)
          return {
            entries:
              o.path === ROOT
                ? [
                    {
                      kind: 'file',
                      name: REPORT,
                      path: `${ROOT}/reports/${REPORT}`,
                    },
                  ]
                : [],
          };
        return {
          entries:
            o.path === ROOT
              ? [
                  {
                    kind: 'directory',
                    name: 'reports',
                    path: `${ROOT}/reports`,
                  },
                  { kind: 'directory', name: '.agent', path: `${ROOT}/.agent` },
                ]
              : [{ kind: 'directory', name: 'objectives', path: 'objectives' }],
        };
      },
    );
  });

  it('lists the objective folder first, scopes search to it and opens markdown in the preview', async () => {
    const user = userEvent.setup();
    renderExplorer({});

    const folders = await screen.findAllByRole('button', {
      expanded: false,
    });
    const sections = folders
      .filter((el) => el.hasAttribute('data-source-id'))
      .map((el) => el.textContent);
    expect(sections.slice(0, 2)).toEqual(['Objective', 'Repo']);
    expect(sections).toContain('Group folder');
    expect(screen.queryByRole('tab', { name: 'Reports' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Objective Files' })).toBeNull();

    await user.click(screen.getByText('Objective'));
    expect(await screen.findByText('reports')).toBeTruthy();
    expect(screen.getByText('.agent')).toBeTruthy();
    expect(api.listGroupFiles).toHaveBeenCalledWith('project-one', {
      path: ROOT,
      cursor: undefined,
    });

    fireEvent.change(screen.getByLabelText('Search files'), {
      target: { value: 'brief' },
    });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(api.listGroupFiles).toHaveBeenCalledWith('project-one', {
        search: 'brief',
        cursor: undefined,
        path: ROOT,
      }),
    );
    await user.click(await screen.findByText(REPORT));
    expect(previewTabs()[0]).toMatchObject({
      source: 'group',
      path: `${ROOT}/reports/${REPORT}`,
      title: REPORT,
    });
  });

  it('opens the linked report in the preview pane from the Files tab', async () => {
    renderExplorer({ report: REPORT });

    await waitFor(() => expect(previewTabs()).toHaveLength(1));
    expect(previewTabs()[0]).toMatchObject({
      source: 'group',
      path: `${ROOT}/reports/${REPORT}`,
    });
    expect(screen.queryByText(/Report not found/)).toBeNull();
  });

  it('opens the linked report once across Files tab and explorer remounts', async () => {
    const view = renderExplorer({ report: REPORT });
    await waitFor(() => expect(previewTabs()).toHaveLength(1));
    const probesAfterOpen = headProbes();
    const callsBeforeRemounts = api.apiFetch.mock.calls.length;

    useStore.setState({ previewTabsByProject: {} });
    view.update({ report: REPORT, tabValue: 'dashboard' });
    view.update({ report: REPORT, tabValue: 'files' });
    view.update({ report: REPORT, mounted: false });
    view.update({ report: REPORT });

    await screen.findByText('Group folder');
    // Settle every probe the remounts issued. A probe that would reopen the
    // report resolves here and flushes its state before the assertions run.
    await act(async () => {
      await Promise.allSettled(headProbePromises(callsBeforeRemounts));
    });
    expect(headProbes()).toBe(probesAfterOpen);
    expect(previewTabs()).toHaveLength(0);
  });

  it('still opens a different report after the first was opened', async () => {
    const other = '2026-10-14-morning-brief.md';
    api.apiFetch.mockImplementation(async (url: string) =>
      url.includes(encodeURIComponent(`${ROOT}/reports/${REPORT}`)) ||
      url.includes(encodeURIComponent(`${ROOT}/reports/${other}`))
        ? new Response(null, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          })
        : new Response(null, { status: 404 }),
    );
    const view = renderExplorer({ report: REPORT });
    await waitFor(() => expect(previewTabs()).toHaveLength(1));

    view.update({ report: other });
    await waitFor(() => expect(previewTabs()).toHaveLength(2));
    expect(previewTabs()[1]).toMatchObject({
      path: `${ROOT}/reports/${other}`,
    });
  });

  it('shows a not-found line for an unknown report and opens nothing', async () => {
    renderExplorer({ report: 'missing.md' });

    expect(
      await screen.findByText('Report not found: missing.md'),
    ).toBeTruthy();
    expect(previewTabs()).toHaveLength(0);
  });

  it('does not probe for a report when there is no deep link', async () => {
    renderExplorer({});

    await screen.findByText('Group folder');
    expect(api.apiFetch).not.toHaveBeenCalled();
  });
});

describe('objective route report search', () => {
  it('keeps a bare filename and ignores traversal values', async () => {
    const { Route } =
      await import('@/routes/objective.$projectId.$objectiveId');
    const validate = Route.options.validateSearch as (
      search: Record<string, unknown>,
    ) => { report?: string };

    expect(validate({ report: '2026-10-13-morning-brief.md' })).toEqual({
      report: '2026-10-13-morning-brief.md',
    });
    for (const report of ['../x', 'a/b.md', 'a\\b.md', '..', 42, '']) {
      expect(validate({ report })).toEqual({});
    }
    expect(validate({})).toEqual({});
  });
});
