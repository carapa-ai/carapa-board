import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import type { TaskSummary } from '@/types';
import {
  useAcknowledgeVisibleKanbanCompletions,
  useUpdateProjectsOrder,
} from './use-projects';

const { updateProjectsOrder } = vi.hoisted(() => ({
  updateProjectsOrder: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  updateProjectsOrder,
}));

function completedTask(id: string, completionEventId: number): TaskSummary {
  return {
    id,
    project_id: 'project-1',
    title: id,
    description: '',
    status: 'completed',
    priority: 0,
    archived: false,
    completionEventId,
    created_at: '2026-08-26T09:00:00.000Z',
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe('visible Kanban completion acknowledgement', () => {
  it('retries a failed request with the original visible event snapshot', async () => {
    const { promise: firstRequest, reject: rejectFirst } =
      Promise.withResolvers<{ acknowledgedEventId: number | null }>();
    const acknowledge = vi
      .fn()
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValue({ acknowledgedEventId: 11 });
    const initialTasks = [completedTask('visible', 11)];

    const hook = renderHook(
      ({ tasks }) =>
        useAcknowledgeVisibleKanbanCompletions(
          'project-1',
          true,
          tasks,
          acknowledge,
        ),
      { initialProps: { tasks: initialTasks }, wrapper: createWrapper() },
    );
    await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));

    hook.rerender({
      tasks: [...initialTasks, completedTask('completed-later', 12)],
    });
    act(() => rejectFirst(new Error('temporary network failure')));

    await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
    expect(acknowledge.mock.calls).toEqual([
      ['project-1', [11]],
      ['project-1', [11]],
    ]);

    hook.rerender({
      tasks: [...initialTasks, completedTask('completed-later', 12)],
    });
    await act(async () => undefined);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  it('allows a later task refresh to retry after the mutation exhausts retries', async () => {
    const acknowledge = vi
      .fn()
      .mockRejectedValueOnce(new Error('first request failed'))
      .mockRejectedValueOnce(new Error('retry failed'))
      .mockResolvedValue({ acknowledgedEventId: 21 });
    const tasks = [completedTask('visible', 21)];

    const hook = renderHook(
      ({ visibleTasks }) =>
        useAcknowledgeVisibleKanbanCompletions(
          'project-1',
          true,
          visibleTasks,
          acknowledge,
        ),
      { initialProps: { visibleTasks: tasks }, wrapper: createWrapper() },
    );
    await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));

    hook.rerender({ visibleTasks: [...tasks] });

    await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(3));
    expect(acknowledge.mock.calls[2]).toEqual(['project-1', [21]]);
  });
});

describe('project cache reconciliation', () => {
  it('restores device data and downloads only changed, authorized projects', async () => {
    const { fetchProjects, cachedProjects } = await import('@/lib/api');
    const { useAuth } = await import('@/lib/auth');
    const { clearProjectCache } = await import('@/lib/project-cache');
    const { REMOTE_URL } = await import('@/lib/api-config');
    const { queryClient } = await import('@/lib/query-client');
    const user = {
      id: 'cache-owner',
      username: 'cache-owner',
      role: 'user' as const,
    };
    const project = (id: string, revision: string) => ({
      id,
      name: id,
      folder: id,
      revision,
    });
    const scope = JSON.stringify([REMOTE_URL, user.id]);
    clearProjectCache();
    useAuth.getState().setAuth(true, true, user);
    localStorage.setItem(
      `carapa-projects-v1:${scope}`,
      JSON.stringify([
        project('unchanged', '1'),
        project('changed', '1'),
        project('revoked', '1'),
      ]),
    );
    const requests: URL[] = [];
    let manifest = [
      { id: 'unchanged', revision: '1' },
      { id: 'changed', revision: '2' },
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = new URL(String(input), 'http://localhost');
        requests.push(url);
        return Response.json(
          url.searchParams.get('view') === 'manifest'
            ? manifest
            : [project('changed', '2')],
        );
      });
    try {
      expect(cachedProjects()?.map(({ id }) => id)).toEqual([
        'unchanged',
        'changed',
        'revoked',
      ]);
      expect(await fetchProjects()).toEqual([
        project('unchanged', '1'),
        project('changed', '2'),
      ]);
      expect(requests).toHaveLength(2);
      expect(JSON.parse(requests[1].searchParams.get('ids')!)).toEqual([
        'changed',
      ]);
      requests.length = 0;
      await fetchProjects();
      expect(requests).toHaveLength(1);
      expect(requests[0].searchParams.get('view')).toBe('manifest');
      expect(
        JSON.parse(localStorage.getItem(`carapa-projects-v1:${scope}`)!),
      ).toEqual(cachedProjects());
      useAuth
        .getState()
        .setAuth(true, true, { ...user, id: 'another-account' });
      expect(cachedProjects()).toBeUndefined();
      useAuth.getState().setAuth(true, true, user);
      manifest = [];
      expect(await fetchProjects()).toEqual([]);
      expect(cachedProjects()).toEqual([]);
      clearProjectCache();
      expect(localStorage.getItem(`carapa-projects-v1:${scope}`)).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      clearProjectCache();
      queryClient.clear();
      useAuth.getState().setAuth(true, false, null);
    }
  });
});

describe('project order mutation', () => {
  it.each([
    { response: { ok: true, skipped: 2 }, toasts: 1 },
    { response: { ok: true, skipped: 0 }, toasts: 0 },
    { response: { ok: true }, toasts: 0 },
  ])(
    'shows the not-reordered toast $toasts time(s) for $response',
    async ({ response, toasts }) => {
      const info = vi.spyOn(toast, 'info').mockImplementation(() => 1);
      try {
        updateProjectsOrder.mockResolvedValueOnce(response);
        const hook = renderHook(() => useUpdateProjectsOrder(), {
          wrapper: createWrapper(),
        });
        await act(() => hook.result.current.mutateAsync({ a: 0, b: 1 }));
        expect(info).toHaveBeenCalledTimes(toasts);
      } finally {
        info.mockRestore();
      }
    },
  );
});
