// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/query-keys';
import type { TaskSummary } from '@/types';
import * as api from '@/lib/api';
import { toast } from 'sonner';
import {
  useBulkDeleteTasks,
  useBulkExecuteTasks,
  useBulkStopTasks,
  useBulkUpdateTasks,
  useMoveTask,
  useDeleteTask,
  useUpdateTask,
} from './use-task-mutations';

vi.mock('@/lib/api', async () => {
  return {
    bulkUpdateTasks: vi.fn(),
    bulkExecuteTasks: vi.fn(),
    bulkStopTasks: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
  };
});
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const MOVE_RUNNING =
  'Task is still running; stop it before completing and merging';

function task(status: string): TaskSummary {
  return { id: 'task-1', status } as TaskSummary;
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const filteredKey = queryKeys.tasks.list('project-1', {
    ownerUserId: 'owner-1',
    triggeredByUserId: 'trigger-1',
  });
  const diffKey = queryKeys.taskDiff.all('project-1', 'task-1');
  queryClient.setQueryData(filteredKey, [task('queue')]);
  queryClient.setQueryData(queryKeys.tasks.list('project-1'), [task('queue')]);
  queryClient.setQueryData(queryKeys.tasks.detail('project-1', 'task-1'), {
    id: 'task-1',
    status: 'queue',
  });
  queryClient.setQueryData(queryKeys.tasks.list('project-2'), [task('queue')]);
  queryClient.setQueryData(diffKey, {
    available: true,
    files: [],
    blockers: [],
  });

  const hook = renderHook(() => useBulkUpdateTasks('project-1'), { wrapper });
  return { hook, queryClient, filteredKey, diffKey };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useBulkUpdateTasks optimistic task-list updates', () => {
  it('updates the filter-qualified list while the request is pending', async () => {
    let resolve!: (
      value: Awaited<ReturnType<typeof api.bulkUpdateTasks>>,
    ) => void;
    vi.mocked(api.bulkUpdateTasks).mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }),
    );
    const { hook, queryClient, filteredKey } = setup();

    act(() => {
      hook.result.current.mutate({ ids: ['task-1'], status: 'active' });
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<TaskSummary[]>(filteredKey)?.[0].status,
      ).toBe('active');
    });
    expect(
      queryClient.getQueryData<TaskSummary[]>(
        queryKeys.tasks.list('project-2'),
      )?.[0].status,
    ).toBe('queue');
    expect(
      queryClient.getQueryData(queryKeys.tasks.detail('project-1', 'task-1')),
    ).toEqual({ id: 'task-1', status: 'queue' });

    resolve({ ok: true });
  });

  it('restores every affected list variant when the request fails', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(api.bulkUpdateTasks).mockReturnValue(
      new Promise((_resolve, rej) => {
        reject = rej;
      }),
    );
    const { hook, queryClient, filteredKey } = setup();

    act(() => {
      hook.result.current.mutate({ ids: ['task-1'], status: 'active' });
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<TaskSummary[]>(filteredKey)?.[0].status,
      ).toBe('active');
    });

    act(() => reject(new Error('request failed')));
    await waitFor(() => {
      expect(
        queryClient.getQueryData<TaskSummary[]>(filteredKey)?.[0].status,
      ).toBe('queue');
    });
    expect(
      queryClient.getQueryData<TaskSummary[]>(
        queryKeys.tasks.list('project-1'),
      )?.[0].status,
    ).toBe('queue');
  });

  it('keeps a newer optimistic move when an earlier overlapping move fails', async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (
      value: Awaited<ReturnType<typeof api.bulkUpdateTasks>>,
    ) => void;
    vi.mocked(api.bulkUpdateTasks)
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );
    const { hook, queryClient, filteredKey } = setup();

    act(() => {
      hook.result.current.mutate({ ids: ['task-1'], status: 'active' });
      hook.result.current.mutate({ ids: ['task-1'], status: 'testing' });
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<TaskSummary[]>(filteredKey)?.[0].status,
      ).toBe('testing');
    });

    act(() => rejectFirst(new Error('first request failed')));
    await waitFor(() => {
      expect(
        queryClient.getQueryData<TaskSummary[]>(filteredKey)?.[0].status,
      ).toBe('testing');
    });

    act(() => resolveSecond({ ok: true }));
    await waitFor(() => {
      expect(
        queryClient.getQueryData<TaskSummary[]>(filteredKey)?.[0].status,
      ).toBe('testing');
    });
  });

  it('invalidates every affected task diff after a bulk completion attempt', async () => {
    vi.mocked(api.bulkUpdateTasks).mockResolvedValue({
      ok: true,
      mergeFailures: [
        {
          task_id: 'task-1',
          error: '[env] default checkout is dirty',
        },
      ],
    });
    const { hook, queryClient, diffKey } = setup();

    act(() => {
      hook.result.current.mutate({ ids: ['task-1'], status: 'completed' });
    });

    await waitFor(() => {
      expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(true);
    });
  });
});

describe('useBulkUpdateTasks failure toasts', () => {
  it('reports a running-task archive denial with the server text, not as a merge failure', async () => {
    vi.mocked(api.bulkUpdateTasks).mockResolvedValue({
      ok: true,
      mergeFailures: [
        {
          task_id: 'task-1',
          error: 'Task is running; stop it before archiving',
        },
      ],
    });
    const { hook } = setup();

    act(() => {
      hook.result.current.mutate({ ids: ['task-1'], archived: true });
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Task is running; stop it before archiving',
      ),
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining('could not be merged'),
    );
  });

  it('still reports genuine merge failures as unmerged branches', async () => {
    vi.mocked(api.bulkUpdateTasks).mockResolvedValue({
      ok: true,
      mergeFailures: [
        { task_id: 'task-1', error: '[env] default checkout is dirty' },
      ],
    });
    const { hook } = setup();

    act(() => {
      hook.result.current.mutate({ ids: ['task-1'], status: 'completed' });
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        '1 task branch could not be merged ("task-1"): [env] default checkout is dirty',
      ),
    );
  });

  it('reports a running card and a conflict in one toast with titles and the reason', async () => {
    vi.mocked(api.bulkUpdateTasks).mockResolvedValue({
      ok: true,
      mergeFailures: [
        {
          task_id: 'task-1',
          error: MOVE_RUNNING,
        },
        { task_id: 'task-2', error: 'CONFLICT in a.ts' },
      ],
    });
    const { hook, queryClient } = setup();
    queryClient.setQueryData(queryKeys.tasks.list('project-1'), [
      { ...task('queue'), title: 'Running card' },
      { id: 'task-2', status: 'queue', title: 'Conflict card' } as TaskSummary,
    ]);

    act(() => {
      hook.result.current.mutate({
        ids: ['task-1', 'task-2'],
        status: 'completed',
      });
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const message = vi.mocked(toast.error).mock.calls[0][0] as string;
    expect(message).toContain('"Conflict card"');
    expect(message).toContain('CONFLICT in a.ts');
    expect(message).toContain('"Running card"');
    expect(message).toContain('still running');
    expect(message).toContain('stop it before completing');
    expect(message).not.toContain('2 task branches');
  });

  it('shares the three-title limit across merge failures and running cards', async () => {
    vi.mocked(api.bulkUpdateTasks).mockResolvedValue({
      ok: true,
      mergeFailures: [
        { task_id: 'c1', error: 'CONFLICT' },
        { task_id: 'c2', error: 'CONFLICT' },
        { task_id: 'r1', error: MOVE_RUNNING },
        { task_id: 'r2', error: MOVE_RUNNING },
      ],
    });
    const { hook, queryClient } = setup();
    queryClient.setQueryData(
      queryKeys.tasks.list('project-1'),
      ['c1', 'c2', 'r1', 'r2'].map(
        (id) => ({ id, status: 'queue', title: `T-${id}` }) as TaskSummary,
      ),
    );

    act(() => {
      hook.result.current.mutate({
        ids: ['c1', 'c2', 'r1', 'r2'],
        status: 'completed',
      });
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const message = vi.mocked(toast.error).mock.calls[0][0] as string;
    expect(message.match(/"T-/g)).toHaveLength(3);
    expect(message).toContain('+1 more');
  });

  it('single-card moves through useMoveTask get the same one-shot toast', async () => {
    vi.mocked(api.bulkUpdateTasks).mockResolvedValue({
      ok: true,
      mergeFailures: [{ task_id: 'task-1', error: 'CONFLICT in b.ts' }],
    });
    const { queryClient } = setup();
    queryClient.setQueryData(queryKeys.tasks.list('project-1'), [
      { ...task('queue'), title: 'Solo card' },
    ]);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const move = renderHook(() => useMoveTask('project-1'), { wrapper });

    act(() => move.result.current.moveTask('task-1', 'completed'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      '1 task branch could not be merged ("Solo card"): CONFLICT in b.ts',
    );
  });
});

describe('bulk execute and stop toasts', () => {
  function bulkSetup<T>(useHook: (project_id: string) => T) {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(() => useHook('project-1'), { wrapper });
  }

  it('warns instead of succeeding when no selected card was started', async () => {
    vi.mocked(api.bulkExecuteTasks).mockResolvedValue({ startedCount: 0 });
    const hook = bulkSetup(useBulkExecuteTasks);
    act(() => hook.result.current.mutate(['a', 'b']));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('Started 0 of 2 task(s); 2 skipped'),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps the success toast when every card was started', async () => {
    vi.mocked(api.bulkExecuteTasks).mockResolvedValue({ startedCount: 2 });
    const hook = bulkSetup(useBulkExecuteTasks);
    act(() => hook.result.current.mutate(['a', 'b']));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Started execution for 2 task(s)',
      ),
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('warns when only some selected cards were stopped', async () => {
    vi.mocked(api.bulkStopTasks).mockResolvedValue({ stoppedCount: 1 });
    const hook = bulkSetup(useBulkStopTasks);
    act(() => hook.result.current.mutate(['a', 'b', 'c']));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Stopped 1 of 3 task(s); 2 were not running',
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('useUpdateTask error toast', () => {
  it('includes the server reason when the update is rejected', async () => {
    vi.mocked(api.updateTask).mockRejectedValue(
      new Error('Circular dependency detected'),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const { result } = renderHook(() => useUpdateTask('project-1'), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });
    act(() => {
      result.current.mutate({
        task_id: 'task-1',
        data: { depends_on_ids: ['task-2'] },
      });
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to update task: Circular dependency detected',
      ),
    );
  });
});

describe('task delete toasts', () => {
  const ids = ['task-1', 'task-2', 'task-3'];

  function setupDelete<T>(useHook: (project_id: string) => T) {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const key = queryKeys.tasks.list('project-1');
    queryClient.setQueryData(
      key,
      ids.map((id) => ({ id, status: 'queue' }) as TaskSummary),
    );
    const { result } = renderHook(() => useHook('project-1'), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });
    const cachedIds = () =>
      queryClient.getQueryData<TaskSummary[]>(key)?.map((t) => t.id);
    return { result, cachedIds };
  }

  it('single delete failure includes the server reason', async () => {
    vi.mocked(api.deleteTask).mockRejectedValue(new Error('boom'));
    const { result } = setupDelete(useDeleteTask);
    act(() => result.current.mutate('task-1'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to delete task: boom'),
    );
  });

  it('bulk delete with every request rejected shows one toast and restores all cards', async () => {
    vi.mocked(api.deleteTask).mockRejectedValue(new Error('boom'));
    const { result, cachedIds } = setupDelete(useBulkDeleteTasks);
    act(() => result.current.mutate(ids));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      'Deleted 0 of 3 tasks; 3 failed: boom',
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(cachedIds()).toEqual(ids);
  });

  it('bulk delete with one rejection restores only the failed card', async () => {
    vi.mocked(api.deleteTask).mockImplementation((_project, id) =>
      id === 'task-2'
        ? Promise.reject(new Error('worktree in use'))
        : Promise.resolve(undefined as never),
    );
    const { result, cachedIds } = setupDelete(useBulkDeleteTasks);
    act(() => result.current.mutate(ids));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      'Deleted 2 of 3 tasks; 1 failed: worktree in use',
    );
    expect(cachedIds()).toEqual(['task-2']);
  });

  it('bulk delete success shows one summary toast', async () => {
    vi.mocked(api.deleteTask).mockResolvedValue(undefined as never);
    const { result, cachedIds } = setupDelete(useBulkDeleteTasks);
    act(() => result.current.mutate(ids));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('Deleted 3 tasks');
    expect(toast.error).not.toHaveBeenCalled();
    expect(cachedIds()).toEqual([]);
  });
});
