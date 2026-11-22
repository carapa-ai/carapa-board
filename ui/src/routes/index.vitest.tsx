import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import { Route } from './index';

const fetchProjects = vi.hoisted(() => vi.fn());
const fetchConfig = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Navigate: () => null,
}));
vi.mock('@/lib/api', () => ({
  fetchProjects,
  fetchConfig,
  cachedProjects: () => undefined,
}));

const IndexPage = (Route as unknown as { component: ComponentType }).component;

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <IndexPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('index page query errors', () => {
  it('shows the config error with Retry instead of the loading spinner', async () => {
    fetchProjects.mockResolvedValue([]);
    fetchConfig.mockRejectedValueOnce(new Error('config boom'));
    renderPage();
    expect(await screen.findByText('config boom')).toBeTruthy();
    expect(screen.queryByText('Loading projects...')).toBeNull();
    fetchConfig.mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No projects found')).toBeTruthy();
    expect(fetchConfig).toHaveBeenCalledTimes(2);
  });

  it('shows the projects error with Retry instead of "No projects found"', async () => {
    fetchConfig.mockResolvedValue({});
    fetchProjects.mockRejectedValueOnce(new Error('projects boom'));
    renderPage();
    expect(await screen.findByText('projects boom')).toBeTruthy();
    expect(screen.queryByText('No projects found')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
