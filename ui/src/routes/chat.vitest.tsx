import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRouteContent } from './chat.$projectId';

const fetchProjects = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  Navigate: () => null,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { href: string } }) => unknown;
  }) => select({ location: { href: '/chat/gone' } }),
}));
vi.mock('@/lib/api', () => ({
  fetchProjects,
  fetchConfig: vi.fn(async () => ({ enableChat: true })),
  cachedProjects: () => undefined,
}));
vi.mock('@/components/chat/chat-page', () => ({
  ChatPage: () => <div data-testid="chat" />,
}));
vi.mock('@/components/layout/header', () => ({ Header: () => null }));
vi.mock('@/components/layout/project-dialogs', () => ({
  ProjectDialogs: () => null,
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ChatRouteContent projectId="gone" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('chat route for an unknown project', () => {
  it('shows Project not found with a home link once projects loaded', async () => {
    fetchProjects.mockResolvedValue([{ id: 'other', settings: {} }]);
    renderPage();
    expect(await screen.findByText('Project not found')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Back to projects' })
        .getAttribute('href'),
    ).toBe('/');
    expect(screen.queryByTestId('chat')).toBeNull();
  });

  it('does not flash not-found while projects are loading', () => {
    fetchProjects.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.queryByText('Project not found')).toBeNull();
  });

  it('renders the chat for an existing project', async () => {
    fetchProjects.mockResolvedValue([{ id: 'gone', settings: {} }]);
    renderPage();
    expect(await screen.findByTestId('chat')).toBeTruthy();
    expect(screen.queryByText('Project not found')).toBeNull();
  });
});
