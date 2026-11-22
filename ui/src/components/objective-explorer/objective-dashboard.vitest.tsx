// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import { ObjectiveDashboard } from './objective-dashboard';

const platform = vi.hoisted(() => ({ native: false }));
const api = vi.hoisted(() => ({
  fetchObjectiveDashboardTicket: vi.fn(async () => 'signed.path-token'),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
  },
}));
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/api-config', () => ({ API_BASE_URL: 'https://native.test' }));

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ObjectiveDashboard
        project_id="project-one"
        objective_id="objective-one"
        objective_title="Ship dashboard"
      />
    </QueryClientProvider>,
  );
}

describe('ObjectiveDashboard', () => {
  beforeEach(() => {
    platform.native = false;
    api.fetchObjectiveDashboardTicket.mockClear();
    useStore.setState({ dashboardRefresh: {} });
  });

  afterEach(() => {
    useStore.setState({ dashboardRefresh: {} });
  });

  it('loads the token path in a cookie-free sandbox and supports manual or pushed refresh', async () => {
    renderDashboard();
    const frame = (await screen.findByTitle(
      'Ship dashboard Dashboard',
    )) as HTMLIFrameElement;
    await waitFor(() =>
      expect(frame.getAttribute('src')).toBe(
        '/api/projects/project-one/objectives/objective-one/dashboard/t/signed.path-token/index.html',
      ),
    );
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms allow-popups',
    );

    const srcSetter = vi.spyOn(frame, 'src', 'set');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh dashboard' }));
    expect(srcSetter).toHaveBeenCalledOnce();

    useStore.setState({ dashboardRefresh: { 'objective-one': 1 } });
    await waitFor(() => expect(srcSetter).toHaveBeenCalledTimes(2));
  });

  it('delivers pushed refreshes as a message after the frame opts in', async () => {
    renderDashboard();
    const frame = (await screen.findByTitle(
      'Ship dashboard Dashboard',
    )) as HTMLIFrameElement;
    await waitFor(() => expect(frame.getAttribute('src')).toBeTruthy());
    const srcSetter = vi.spyOn(frame, 'src', 'set');
    const optIn = (source: MessageEventSource | null) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'carapa-dashboard-handles-refresh' },
            source,
          }),
        );
      });

    optIn(window);
    useStore.setState({ dashboardRefresh: { 'objective-one': 1 } });
    await waitFor(() => expect(srcSetter).toHaveBeenCalledTimes(1));

    // A reload gives the frame a fresh window; opt in from the current one.
    const postMessage = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    optIn(frame.contentWindow);
    useStore.setState({ dashboardRefresh: { 'objective-one': 2 } });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        { type: 'carapa-dashboard-refresh' },
        '*',
      ),
    );
    expect(srcSetter).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh dashboard' }));
    expect(srcSetter).toHaveBeenCalledTimes(2);
    useStore.setState({ dashboardRefresh: { 'objective-one': 3 } });
    await waitFor(() => expect(srcSetter).toHaveBeenCalledTimes(3));
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it('prefixes the native API base onto the token path', async () => {
    platform.native = true;
    renderDashboard();

    await waitFor(() =>
      expect(
        screen.getByTitle('Ship dashboard Dashboard').getAttribute('src'),
      ).toBe(
        'https://native.test/api/projects/project-one/objectives/objective-one/dashboard/t/signed.path-token/index.html',
      ),
    );
    expect(api.fetchObjectiveDashboardTicket).toHaveBeenCalledWith(
      'project-one',
      'objective-one',
    );
  });
});
