import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { chooseOption, selectedLabel } from '@/test-utils/select';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthConsentPage } from './oauth.consent';
import type { OAuthConsentRequest } from '@/lib/api';

const api = vi.hoisted(() => ({
  fetchOAuthConsentRequest: vi.fn(),
  submitOAuthDecision: vi.fn(),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  }
  return { ApiError, ...api };
});

const request: OAuthConsentRequest = {
  id: 'req-1',
  client: { id: 'client-1', name: 'Acme Agent' },
  redirectHost: 'agent.example.com',
  resource: 'https://board.example.com/mcp/carapa-board',
  expiresAt: '2026-10-18T12:00:00.000Z',
  choices: {
    targets: [
      {
        kind: 'main',
        folder: 'main-alice',
        name: 'Alice',
        isParent: false,
        canWrite: true,
      },
      {
        kind: 'project',
        folder: 'proj-a',
        name: 'Project A',
        isParent: false,
        canWrite: true,
      },
    ],
    access: ['read', 'write'],
    days: [7, 1, 30],
  },
};

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <OAuthConsentPage requestId="req-1" />
    </QueryClientProvider>,
  );
}

function stubLocation() {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  return assign;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  api.fetchOAuthConsentRequest.mockReset();
  api.submitOAuthDecision.mockReset();
});

describe('OAuth consent page', () => {
  it('renders the request with safe defaults', async () => {
    api.fetchOAuthConsentRequest.mockResolvedValue(request);
    renderPage();

    expect(await screen.findByText('Acme Agent')).toBeTruthy();
    expect(screen.getByText('(self-declared name)')).toBeTruthy();
    expect(screen.getByText('agent.example.com')).toBeTruthy();
    expect(screen.getByText('/mcp/carapa-board')).toBeTruthy();
    expect(selectedLabel(screen.getByLabelText('Access for Project A'))).toBe(
      'Read-only',
    );
    expect(
      screen
        .getByRole('checkbox', { name: 'Main workspace (Alice)' })
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.queryByLabelText('Access for Main workspace (Alice)'),
    ).toBeNull();
    expect(selectedLabel(screen.getByLabelText('Duration'))).toBe('1 day');
  });

  it('ticking a parent also ticks its direct children, read-only', async () => {
    api.fetchOAuthConsentRequest.mockResolvedValue({
      ...request,
      choices: {
        ...request.choices,
        targets: [
          {
            kind: 'project',
            folder: 'parent',
            name: 'Parent',
            isParent: true,
            canWrite: true,
          },
          {
            kind: 'project',
            folder: 'c1',
            name: 'carapa-board',
            parentId: 'parent',
            isParent: false,
            canWrite: true,
          },
          {
            kind: 'project',
            folder: 'c2',
            name: 'carapa-box',
            parentId: 'parent',
            isParent: false,
            canWrite: false,
          },
        ],
      },
    } satisfies OAuthConsentRequest);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Acme Agent');
    // Default: the first project only, no children.
    expect(screen.getByLabelText('Access for Parent')).toBeTruthy();
    expect(screen.queryByLabelText('Access for carapa-board')).toBeNull();

    const parentItem = screen.getByRole('checkbox', { name: 'Parent' });
    await user.click(parentItem); // untick: the stored list stays exact
    expect(screen.queryByLabelText('Access for Parent')).toBeNull();
    await user.click(parentItem); // tick: children come along, read-only
    for (const name of ['Parent', 'carapa-board', 'carapa-box']) {
      expect(selectedLabel(screen.getByLabelText(`Access for ${name}`))).toBe(
        'Read-only',
      );
    }
    const viewerOnly = screen.getByLabelText('Access for carapa-box');
    fireEvent.keyDown(viewerOnly, { key: 'Enter' });
    const writeOption = await screen.findByRole('option', {
      name: 'Read & write',
    });
    expect(writeOption.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(writeOption, { key: 'Escape' });
  });

  it('explains that the main workspace reaches every project', async () => {
    api.fetchOAuthConsentRequest.mockResolvedValue(request);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Acme Agent');
    expect(screen.queryByRole('note')).toBeNull();
    await user.click(
      screen.getByRole('checkbox', { name: 'Main workspace (Alice)' }),
    );
    expect(screen.getByRole('note').textContent).toContain(
      'every project you can reach',
    );
  });

  it('approves with the chosen grant and navigates to the returned redirect', async () => {
    const assign = stubLocation();
    api.fetchOAuthConsentRequest.mockResolvedValue(request);
    api.submitOAuthDecision.mockResolvedValue({
      redirectUrl: 'https://agent.example.com/cb?code=abc',
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Acme Agent');
    await chooseOption(
      screen.getByLabelText('Access for Project A'),
      'Read & write',
    );
    await chooseOption(screen.getByLabelText('Duration'), '30 days');
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        'https://agent.example.com/cb?code=abc',
      ),
    );
    expect(api.submitOAuthDecision).toHaveBeenCalledTimes(1);
    expect(api.submitOAuthDecision).toHaveBeenCalledWith('req-1', {
      decision: 'approve',
      targets: [{ kind: 'project', folder: 'proj-a', access: 'write' }],
      days: 30,
    });
    expect(
      (screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('denies without choosing a grant and navigates to the redirect', async () => {
    const assign = stubLocation();
    api.fetchOAuthConsentRequest.mockResolvedValue(request);
    api.submitOAuthDecision.mockResolvedValue({
      redirectUrl: 'https://agent.example.com/cb?error=access_denied',
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Acme Agent');
    await user.click(screen.getByRole('button', { name: 'Deny' }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        'https://agent.example.com/cb?error=access_denied',
      ),
    );
    expect(api.submitOAuthDecision).toHaveBeenCalledWith('req-1', {
      decision: 'deny',
    });
  });

  it('shows an error without buttons when the request is expired', async () => {
    const { ApiError } = await import('@/lib/api');
    api.fetchOAuthConsentRequest.mockRejectedValue(
      new ApiError('Authorization request expired or not found', 404),
    );
    renderPage();

    expect(
      await screen.findByText('This request expired or does not exist.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });
});
