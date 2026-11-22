import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UsersPage } from './users';

const api = vi.hoisted(() => ({
  fetchUsers: vi.fn(),
  createUserAccount: vi.fn(),
  updateUserAccount: vi.fn(),
  deleteUserAccount: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: unknown) => unknown) =>
    select({ user: { id: 'admin-1', role: 'admin' } }),
}));
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: ({
    title,
    children,
  }: {
    title: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      {children}
    </header>
  ),
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

// Both ids share the `user-179` prefix, so a badge built from the head of the
// id would render the same text twice.
const users = [
  {
    id: 'user-1792930495763-h2cmqo',
    username: 'alice',
    role: 'admin',
    created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'user-1792930495999-k3pl9x',
    username: 'bob',
    role: 'user',
    created_at: '2026-01-02T00:00:00.000Z',
  },
];

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UsersPage />
    </QueryClientProvider>,
  );
}

describe('admin users page', () => {
  it('shows a distinguishing id badge for every user', async () => {
    api.fetchUsers.mockResolvedValue(users);
    renderPage();

    const badges = await screen.findAllByText(/^ID: /);
    expect(badges.map((badge) => badge.textContent)).toEqual([
      'ID: h2cmqo',
      'ID: k3pl9x',
    ]);
    expect(badges[0]!.getAttribute('title')).toBe('user-1792930495763-h2cmqo');
    expect(badges[1]!.getAttribute('title')).toBe('user-1792930495999-k3pl9x');
  });

  it('labels the edit and delete buttons and keeps them reachable without a hover', async () => {
    api.fetchUsers.mockResolvedValue(users);
    renderPage();

    const edit = await screen.findByRole('button', { name: 'Edit user alice' });
    const remove = screen.getByRole('button', { name: 'Delete user alice' });
    screen.getByRole('button', { name: 'Delete user bob' });

    const container = edit.parentElement!;
    expect(remove.parentElement).toBe(container);
    expect(container.className).toContain('group-hover:opacity-100');
    expect(container.className).toContain('focus-within:opacity-100');
    expect(container.className).toContain('[@media(hover:none)]:opacity-100');
  });
});
