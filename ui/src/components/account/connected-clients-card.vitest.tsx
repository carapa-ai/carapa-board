import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseOption } from '@/test-utils/select';
import { ConnectedClientsCard } from './connected-clients-card';

const api = vi.hoisted(() => ({
  fetchOAuthGrants: vi.fn(),
  revokeOAuthGrant: vi.fn(),
  fetchOAuthGrantChoices: vi.fn(),
  updateOAuthGrant: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => api);

const grants = [
  {
    id: 'grant-1',
    clientId: 'client-1',
    clientName: 'Acme Agent',
    resource: 'https://board.example.com/mcp/carapa-board',
    targets: [
      { kind: 'project', folder: 'proj-a', name: 'Project A', access: 'read' },
      { kind: 'project', folder: 'proj-b', name: 'Project B', access: 'write' },
    ],
    createdAt: '2026-10-01T10:00:00.000Z',
    lastUsedAt: null,
    expiresAt: '2026-10-08T10:00:00.000Z',
  },
  {
    id: 'grant-2',
    clientId: 'client-2',
    clientName: 'Other Client',
    resource: 'https://board.example.com/mcp/carapa-board',
    targets: [
      { kind: 'main', folder: 'main-alice', name: 'Alice', access: 'write' },
    ],
    createdAt: '2026-10-02T10:00:00.000Z',
    lastUsedAt: '2026-10-03T10:00:00.000Z',
    expiresAt: '2026-11-01T10:00:00.000Z',
  },
];

afterEach(() => {
  cleanup();
  api.fetchOAuthGrants.mockReset();
  api.revokeOAuthGrant.mockReset();
  api.fetchOAuthGrantChoices.mockReset();
  api.updateOAuthGrant.mockReset();
});

const choices = {
  targets: [
    {
      kind: 'project',
      folder: 'proj-a',
      name: 'Project A',
      isParent: false,
      canWrite: true,
    },
    {
      kind: 'project',
      folder: 'proj-c',
      name: 'Project C',
      isParent: false,
      canWrite: false,
    },
  ],
  days: [1, 7, 30, 90],
};

describe('ConnectedClientsCard', () => {
  it('lists grants and removes a row after a confirmed revoke', async () => {
    api.fetchOAuthGrants.mockResolvedValue(grants);
    api.revokeOAuthGrant.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConnectedClientsCard />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Acme Agent')).toBeTruthy();
    expect(screen.getByText('Other Client')).toBeTruthy();
    expect(
      screen.getByText('2 projects, 1 read & write: Project A, Project B'),
    ).toBeTruthy();
    expect(
      screen.getByText('1 project, read & write: Main workspace (Alice)'),
    ).toBeTruthy();

    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    expect(api.revokeOAuthGrant).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));

    await waitFor(() => expect(screen.queryByText('Acme Agent')).toBeNull());
    expect(api.revokeOAuthGrant).toHaveBeenCalledWith('grant-1');
    expect(screen.getByText('Other Client')).toBeTruthy();
  });

  it('edits projects, per-project access and expiry', async () => {
    api.fetchOAuthGrants.mockResolvedValue(grants);
    api.fetchOAuthGrantChoices.mockResolvedValue(choices);
    api.updateOAuthGrant.mockResolvedValue({
      ok: true,
      expiresAt: '2026-11-30T10:00:00.000Z',
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConnectedClientsCard />
      </QueryClientProvider>,
    );

    await screen.findByText('Acme Agent');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);

    // Project B is no longer grantable: it is dropped and the user is told.
    await screen.findByLabelText('Access for Project A');
    expect(screen.queryByLabelText('Access for Project B')).toBeNull();
    expect(screen.getByText(/1 project is no longer available/)).toBeTruthy();

    await chooseOption(
      screen.getByLabelText('Access for Project A'),
      'Read & write',
    );
    await user.click(screen.getByRole('checkbox', { name: 'Project C' }));
    // Viewer-only project cannot be raised to write.
    fireEvent.keyDown(screen.getByLabelText('Access for Project C'), {
      key: 'Enter',
    });
    const writeOption = await screen.findByRole('option', {
      name: 'Read & write',
    });
    expect(writeOption.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(writeOption, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
    await chooseOption(screen.getByLabelText('Expires'), '30 days from now');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.updateOAuthGrant).toHaveBeenCalledWith('grant-1', {
        targets: [
          { kind: 'project', folder: 'proj-a', access: 'write' },
          { kind: 'project', folder: 'proj-c', access: 'read' },
        ],
        days: 30,
      }),
    );
    // The list is refetched so the new projects show up.
    await waitFor(() =>
      expect(api.fetchOAuthGrants.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it('keeps the dialog open and shows the error when saving fails', async () => {
    api.fetchOAuthGrants.mockResolvedValue(grants);
    api.fetchOAuthGrantChoices.mockResolvedValue(choices);
    api.updateOAuthGrant.mockRejectedValue(
      new Error('Invalid device signature'),
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConnectedClientsCard />
      </QueryClientProvider>,
    );

    await screen.findByText('Acme Agent');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    await screen.findByLabelText('Access for Project A');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Invalid device signature',
    );
    expect(api.updateOAuthGrant).toHaveBeenCalledWith('grant-1', {
      targets: [{ kind: 'project', folder: 'proj-a', access: 'read' }],
    });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  });
});
