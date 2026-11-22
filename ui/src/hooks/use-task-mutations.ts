import { useSyncExternalStore } from 'react';
import {
  hashKey,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import * as api from '@/lib/api';
import { getEffectiveProjectStages } from '@/lib/stages';
import type {
  Project,
  Task,
  TaskSummary,
  TaskStatus,
  RuntimeSelection,
} from '@/types';
import { toast } from 'sonner';
import {
  approvalOfError,
  promptMergeApproval,
} from '@/lib/merge-approval-prompt';

type TaskListSnapshot = [readonly unknown[], TaskSummary[] | undefined];
type TaskListUpdate = (task: TaskSummary) => TaskSummary;
type OptimisticTaskListOperation = {
  snapshots: TaskListSnapshot[];
  queryKeys: ReadonlyArray<readonly unknown[]>;
  update: TaskListUpdate;
  settled: boolean;
};

const optimisticOperations = new WeakMap<
  QueryClient,
  Map<string, OptimisticTaskListOperation[]>
>();

function taskListQueryFilter(project_id: string) {
  return {
    queryKey: queryKeys.tasks.all(project_id),
    predicate: (query: { queryKey: readonly unknown[] }) =>
      query.queryKey.length === queryKeys.tasks.list(project_id).length,
  };
}

/** Patch every cached (filtered) task list of a project; skips unloaded lists. */
export function patchTaskLists(
  qc: QueryClient,
  project_id: string,
  updater: (tasks: TaskSummary[]) => TaskSummary[],
) {
  qc.setQueriesData<TaskSummary[]>(taskListQueryFilter(project_id), (old) =>
    Array.isArray(old) ? updater(old) : old,
  );
}

export function snapshotTaskLists(
  qc: QueryClient,
  project_id: string,
): TaskListSnapshot[] {
  return qc.getQueriesData<TaskSummary[]>(taskListQueryFilter(project_id));
}

export function restoreTaskListSnapshots(
  qc: QueryClient,
  snapshots: TaskListSnapshot[],
) {
  for (const [queryKey, data] of snapshots) {
    qc.setQueryData(queryKey, data);
  }
}

function taskListQueryKeys(
  qc: ReturnType<typeof useQueryClient>,
  project_id: string,
) {
  return qc
    .getQueryCache()
    .findAll(taskListQueryFilter(project_id))
    .map((query) => query.queryKey);
}

function getTaskListOperations(qc: QueryClient, project_id: string) {
  let operations = optimisticOperations.get(qc);
  if (!operations) {
    operations = new Map();
    optimisticOperations.set(qc, operations);
  }
  let projectOperations = operations.get(project_id);
  if (!projectOperations) {
    projectOperations = [];
    operations.set(project_id, projectOperations);
  }
  return projectOperations;
}

function updateTaskLists(
  qc: QueryClient,
  queryKeysToUpdate: ReadonlyArray<readonly unknown[]>,
  update: TaskListUpdate,
) {
  for (const queryKey of queryKeysToUpdate) {
    qc.setQueryData<TaskSummary[]>(queryKey, (old) => old?.map(update));
  }
}

function beginOptimisticTaskListOperation(
  qc: QueryClient,
  project_id: string,
  update: TaskListUpdate,
) {
  const queryKeysToUpdate = taskListQueryKeys(qc, project_id);
  const operation: OptimisticTaskListOperation = {
    snapshots: queryKeysToUpdate.map(
      (queryKey) =>
        [
          queryKey,
          qc.getQueryData<TaskSummary[]>(queryKey),
        ] as TaskListSnapshot,
    ),
    queryKeys: queryKeysToUpdate,
    update,
    settled: false,
  };
  getTaskListOperations(qc, project_id).push(operation);
  updateTaskLists(qc, queryKeysToUpdate, update);
  return operation;
}

function pruneSettledOperations(qc: QueryClient, project_id: string) {
  const operations = getTaskListOperations(qc, project_id);
  while (operations[0]?.settled) operations.shift();
  if (operations.length === 0) {
    optimisticOperations.get(qc)?.delete(project_id);
  }
}

function settleOptimisticTaskListOperation(
  qc: QueryClient,
  project_id: string,
  operation: OptimisticTaskListOperation,
) {
  operation.settled = true;
  pruneSettledOperations(qc, project_id);
}

function rollbackOptimisticTaskListOperation(
  qc: QueryClient,
  project_id: string,
  operation: OptimisticTaskListOperation,
) {
  const operations = getTaskListOperations(qc, project_id);
  const index = operations.indexOf(operation);
  if (index === -1) return;

  restoreTaskListSnapshots(qc, operation.snapshots);
  operations.splice(index, 1);
  for (const later of operations.slice(index)) {
    // The later operation's own snapshot still holds the effect of the one
    // that just rolled back; re-capture it from the state rebuilt so far, so
    // a later rollback of it cannot bring that effect back.
    later.snapshots = later.queryKeys.map(
      (queryKey): TaskListSnapshot => [
        queryKey,
        qc.getQueryData<TaskSummary[]>(queryKey),
      ],
    );
    updateTaskLists(qc, later.queryKeys, later.update);
  }
  pruneSettledOperations(qc, project_id);
}

/**
 * Apply a correction to the snapshots of the pending optimistic operations that
 * started after `after`, so a later rollback restores the corrected state, not
 * one that predates it. Older operations are left alone: their snapshots
 * predate `after` and its effects, and replaying `after` on their rollback
 * already honors the correction.
 */
function rebaseOperationSnapshots(
  qc: QueryClient,
  project_id: string,
  after: OptimisticTaskListOperation,
  correct: TaskListUpdate,
) {
  const operations = getTaskListOperations(qc, project_id);
  // `after` is gone once it settled at the head of the list; everything left
  // is then newer.
  for (const operation of operations.slice(operations.indexOf(after) + 1)) {
    operation.snapshots = operation.snapshots.map(
      ([queryKey, tasks]): TaskListSnapshot => [queryKey, tasks?.map(correct)],
    );
  }
}

/**
 * Re-apply the optimistic operations still waiting for their server response
 * to a freshly fetched list. A bulk archive/move is applied by the server one
 * card at a time, so a refetch triggered by the first card's broadcast would
 * otherwise bring the remaining cards back until their own turn.
 */
export function applyPendingTaskListOperations(
  qc: QueryClient,
  project_id: string,
  tasks: TaskSummary[],
): TaskSummary[] {
  return getTaskListOperations(qc, project_id).reduce(
    (current, operation) => current.map(operation.update),
    tasks,
  );
}

function hasOptimisticTaskListOperations(qc: QueryClient, project_id: string) {
  return (optimisticOperations.get(qc)?.get(project_id)?.length ?? 0) > 0;
}

/**
 * A manual move to a done stage merges the task branch on the server before it
 * saves the new status, so refetches keep returning the old status meanwhile.
 * Merging moves are therefore tracked outside the query cache and overlaid on
 * the task lists at render time, so a refetch cannot move the card back.
 */
type MergingEntry = {
  /** Identifies one move so a stale settle cannot clear a newer move. */
  token: object;
  status: string;
  completedAt: string;
  /** False once the merge succeeded; the entry then only pins the card. */
  merging: boolean;
  /** Set when the merge succeeded: the store sequence number from then on. */
  settledSeq?: number;
  /**
   * The card moved between done stages, so the server keeps its old
   * `completed_at`. The entry keeps the card at the top of its new stage
   * until fresh server state reports another one.
   */
  keepPlacement: boolean;
  /** A settled pin this move displaced; it returns if this move fails. */
  replaces?: MergingEntry;
};
type MergingTasks = ReadonlyMap<string, MergingEntry>;
type MergingStore = {
  byProject: Map<string, MergingTasks>;
  /** Orders successful merges against the list fetches around them. */
  seq: number;
  /** Per task-list query: start order of its latest completed fetch. */
  freshSeq: Map<string, number>;
  listeners: Set<() => void>;
  subscribe: (listener: () => void) => () => void;
};

const EMPTY_MERGING: MergingTasks = new Map();
const mergingStores = new WeakMap<QueryClient, MergingStore>();

function getMergingStore(qc: QueryClient): MergingStore {
  let store = mergingStores.get(qc);
  if (!store) {
    const listeners = new Set<() => void>();
    const created: MergingStore = {
      byProject: new Map(),
      seq: 0,
      freshSeq: new Map(),
      listeners,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    store = created;
    mergingStores.set(qc, created);
    watchTaskListDeliveries(qc);
  }
  return store;
}

function updateMergingTasks(
  qc: QueryClient,
  project_id: string,
  mutate: (next: Map<string, MergingEntry>) => void,
) {
  const store = getMergingStore(qc);
  const next = new Map(store.byProject.get(project_id));
  mutate(next);
  if (next.size > 0) store.byProject.set(project_id, next);
  else store.byProject.delete(project_id);
  for (const listener of store.listeners) listener();
}

/** Drop a failed move's entry; a settled pin it displaced takes its place. */
function dropMergingEntry(
  next: Map<string, MergingEntry>,
  id: string,
  entry: MergingEntry,
) {
  if (entry.replaces) next.set(id, entry.replaces);
  else next.delete(id);
}

/** Drop the entries of one failed move, leaving any newer move's intact. */
function clearMergingEntries(
  qc: QueryClient,
  project_id: string,
  token: object,
) {
  updateMergingTasks(qc, project_id, (next) => {
    for (const [id, entry] of next) {
      if (entry.token === token) dropMergingEntry(next, id, entry);
    }
  });
}

/** Mark a move's surviving cards as merged; they stay pinned until delivery. */
function markMergingSettled(
  qc: QueryClient,
  project_id: string,
  token: object,
  failedIds: ReadonlySet<string>,
) {
  const store = getMergingStore(qc);
  updateMergingTasks(qc, project_id, (next) => {
    for (const [id, entry] of next) {
      if (entry.token !== token) continue;
      if (failedIds.has(id)) dropMergingEntry(next, id, entry);
      else next.set(id, { ...entry, merging: false, settledSeq: ++store.seq });
    }
  });
}

/**
 * Task-list fetches are stamped so a delivery can be judged against a move:
 * only a list whose request started after the merge settled reflects the
 * server's state for it. `useTasks` wraps its query function with these.
 */
export function beginTaskListFetch(qc: QueryClient) {
  return ++getMergingStore(qc).seq;
}

export function finishTaskListFetch(
  qc: QueryClient,
  queryKey: readonly unknown[],
  startSeq: number,
) {
  const { freshSeq } = getMergingStore(qc);
  const key = hashKey(queryKey);
  freshSeq.set(key, Math.max(freshSeq.get(key) ?? 0, startSeq));
}

/**
 * Release settled moves once the server's state is known: when no optimistic
 * operation is pending (a rollback could still restore a stale snapshot) and
 * every active list has completed a fetch that started after the merge
 * settled. Whatever those lists report is then authoritative. A card that
 * moved between done stages stays pinned while the server still reports its
 * target stage, because the server keeps its old `completed_at`.
 */
function releaseDeliveredMoves(qc: QueryClient, project_id: string) {
  const store = getMergingStore(qc);
  const entries = store.byProject.get(project_id);
  if (!entries || hasOptimisticTaskListOperations(qc, project_id)) return;
  const lists = qc
    .getQueryCache()
    .findAll({ ...taskListQueryFilter(project_id), type: 'active' });
  if (
    lists.length === 0 ||
    lists.some((list) => list.state.fetchStatus !== 'idle')
  ) {
    return;
  }
  const released: string[] = [];
  for (const [id, entry] of entries) {
    if (
      entry.settledSeq === undefined ||
      lists.some(
        (list) =>
          (store.freshSeq.get(list.queryHash) ?? 0) <= entry.settledSeq!,
      )
    ) {
      continue;
    }
    const movedOn = lists.some((list) => {
      const task = (list.state.data as TaskSummary[] | undefined)?.find(
        (candidate) => candidate.id === id,
      );
      return task !== undefined && task.status !== entry.status;
    });
    if (!entry.keepPlacement || movedOn) released.push(id);
  }
  if (released.length === 0) return;
  updateMergingTasks(qc, project_id, (next) => {
    for (const id of released) next.delete(id);
  });
}

/**
 * Task lists also refresh outside the mutations (poll, reconnect, websocket).
 * Check every list fetch against the settled moves, so a refetch that failed
 * right after a merge cannot leave its pin masking the server.
 */
function watchTaskListDeliveries(qc: QueryClient) {
  qc.getQueryCache().subscribe((event) => {
    // `manual` successes are cache writes (optimistic updates, rollbacks),
    // not data delivered by the server.
    if (
      event.type !== 'updated' ||
      event.action.type !== 'success' ||
      event.action.manual
    ) {
      return;
    }
    const [scope, project_id] = event.query.queryKey;
    if (
      scope === 'tasks' &&
      typeof project_id === 'string' &&
      event.query.queryKey.length === queryKeys.tasks.list(project_id).length
    ) {
      releaseDeliveredMoves(qc, project_id);
    }
  });
}

/**
 * Refetch the project's task lists once no optimistic operation is pending.
 * Moves are released as the fresh lists arrive; a skipped or failed refetch
 * releases nothing here, and a later fetch of any origin completes the job
 * (see `watchTaskListDeliveries`).
 */
async function reconcileTaskLists(qc: QueryClient, project_id: string) {
  if (hasOptimisticTaskListOperations(qc, project_id)) return;
  await qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
  releaseDeliveredMoves(qc, project_id);
}

export function useMergingTasks(project_id: string): MergingTasks {
  const qc = useQueryClient();
  const store = getMergingStore(qc);
  return useSyncExternalStore(
    store.subscribe,
    () => store.byProject.get(project_id) ?? EMPTY_MERGING,
  );
}

/** Show merging cards in their target stage, first in the Done sort order. */
export function applyMergingTasks(
  tasks: TaskSummary[],
  merging: MergingTasks,
): TaskSummary[] {
  if (merging.size === 0) return tasks;
  return tasks.map((task) => {
    const entry = merging.get(task.id);
    return entry
      ? {
          ...task,
          status: entry.status,
          completed_at: entry.completedAt,
          merging: entry.merging,
        }
      : task;
  });
}

/** An ISO timestamp that sorts after every completion in the cached lists. */
function nextCompletedAt(snapshots: TaskListSnapshot[]) {
  let latest = Date.now();
  for (const [, tasks] of snapshots) {
    for (const task of tasks ?? []) {
      const completed = task.completed_at ? Date.parse(task.completed_at) : NaN;
      if (completed >= latest) latest = completed + 1;
    }
  }
  return new Date(latest).toISOString();
}

export function useCreateTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title: string;
      description?: string;
      runtimeSelection?: RuntimeSelection | null;
      runtimeSelectionStage?: string | null;
      priority?: number;
      depends_on_ids?: string[];
      author?: string;
      objective_id?: string | null;
      abVariants?: string[] | null;
      stageVariant?: string | null;
    }) => api.createTask(project_id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
      toast.success('Task created');
    },
    onError: (err) => toast.error(`Failed to create: ${err.message}`),
  });
}

export function useUpdateTask(project_id: string) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({
      task_id,
      data,
    }: {
      task_id: string;
      data: Partial<
        Pick<
          Task,
          | 'title'
          | 'description'
          | 'status'
          | 'priority'
          | 'archived'
          | 'depends_on_ids'
          | 'objective_id'
          | 'abVariants'
          | 'stageVariant'
          | 'coStages'
        >
      > & {
        runtimeSelection?: RuntimeSelection | null;
        runtimeSelectionStage?: string | null;
      };
    }) => api.updateTask(project_id, task_id, data),
    onMutate: async ({ task_id, data }) => {
      await qc.cancelQueries({ queryKey: queryKeys.tasks.all(project_id) });
      const operation = beginOptimisticTaskListOperation(qc, project_id, (f) =>
        f.id === task_id ? { ...f, ...data } : f,
      );
      return { operation };
    },
    onError: (err, vars, context) => {
      if (context?.operation) {
        rollbackOptimisticTaskListOperation(qc, project_id, context.operation);
      }
      const approval = approvalOfError(err);
      if (approval) {
        promptMergeApproval({
          projectId: project_id,
          items: [
            {
              taskId: vars.task_id,
              title:
                cachedTaskTitles(qc, project_id).get(vars.task_id) ??
                vars.task_id,
              approval,
            },
          ],
          retry: () => mutation.mutate(vars),
        });
        return;
      }
      toast.error(
        err instanceof Error && err.message
          ? `Failed to update task: ${err.message}`
          : 'Failed to update task',
      );
    },
    onSuccess: (_result, _vars, context) => {
      if (context?.operation) {
        settleOptimisticTaskListOperation(qc, project_id, context.operation);
      }
    },
    onSettled: (_result, _error, vars) => {
      void reconcileTaskLists(qc, project_id);
      qc.invalidateQueries({
        queryKey: queryKeys.taskDiff.all(project_id, vars.task_id),
      });
    },
  });
  return mutation;
}

/** Pick an A/B experiment's winning variant; surfaces the server's rejection. */
export function usePickAbWinner(project_id: string) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({
      parent_task_id,
      winner_task_id,
    }: {
      parent_task_id: string;
      winner_task_id: string;
    }) => api.pickAbWinner(project_id, parent_task_id, winner_task_id),
    onSuccess: () => toast.success('Variant merged'),
    onError: (err, vars) => {
      const approval = approvalOfError(err);
      if (!approval) return;
      promptMergeApproval({
        projectId: project_id,
        items: [
          {
            taskId: vars.winner_task_id,
            title:
              cachedTaskTitles(qc, project_id).get(vars.winner_task_id) ??
              vars.winner_task_id,
            approval,
          },
        ],
        retry: () => mutation.mutate(vars),
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
    },
  });
  return mutation;
}

type RemovedTask = { queryKey: QueryKey; task: TaskSummary; index: number };

/**
 * Optimistically drop the given cards from every cached list. Remembers only
 * those cards and their place in each list: restoring whole-list snapshots on
 * failure would also revert unrelated cards, e.g. a move to Done that
 * succeeded in the meantime.
 */
async function removeTasksFromLists(
  qc: QueryClient,
  project_id: string,
  task_ids: string[],
): Promise<RemovedTask[]> {
  await qc.cancelQueries({ queryKey: queryKeys.tasks.all(project_id) });
  const ids = new Set(task_ids);
  const removed = snapshotTaskLists(qc, project_id).flatMap(
    ([queryKey, tasks]) =>
      (tasks ?? []).flatMap((task, index) =>
        ids.has(task.id) ? [{ queryKey, task, index }] : [],
      ),
  );
  patchTaskLists(qc, project_id, (tasks) =>
    tasks.filter((f) => !ids.has(f.id)),
  );
  return removed;
}

/** Put removed cards back at their former index; later cards keep their order. */
function restoreRemovedTasks(qc: QueryClient, removed: RemovedTask[]) {
  for (const { queryKey, task, index } of removed) {
    qc.setQueryData<TaskSummary[]>(queryKey, (old) =>
      old && !old.some((f) => f.id === task.id)
        ? [...old.slice(0, index), task, ...old.slice(index)]
        : old,
    );
  }
}

export function useDeleteTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (task_id: string) => api.deleteTask(project_id, task_id),
    onMutate: async (task_id) => ({
      removed: await removeTasksFromLists(qc, project_id, [task_id]),
    }),
    onError: (err, _taskId, context) => {
      restoreRemovedTasks(qc, context?.removed ?? []);
      toast.error(
        err instanceof Error && err.message
          ? `Failed to delete task: ${err.message}`
          : 'Failed to delete task',
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
    },
    onSuccess: () => toast.success('Task deleted'),
  });
}

function deleteFailureReason(reason: unknown) {
  return reason instanceof Error && reason.message
    ? reason.message
    : 'Unknown error';
}

/**
 * Delete several cards with one summary toast. Failed cards are restored at
 * their former position; cards that were deleted stay removed.
 */
export function useBulkDeleteTasks(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (task_ids: string[]) => {
      const results = await Promise.allSettled(
        task_ids.map((task_id) => api.deleteTask(project_id, task_id)),
      );
      return task_ids.map((task_id, i) => ({ task_id, result: results[i] }));
    },
    onMutate: async (task_ids) => ({
      removed: await removeTasksFromLists(qc, project_id, task_ids),
    }),
    onSuccess: (outcomes, _task_ids, context) => {
      const failed = outcomes.flatMap(({ task_id, result }) =>
        result.status === 'rejected'
          ? [{ task_id, reason: deleteFailureReason(result.reason) }]
          : [],
      );
      const failedIds = new Set(failed.map((f) => f.task_id));
      restoreRemovedTasks(
        qc,
        (context?.removed ?? []).filter(({ task }) => failedIds.has(task.id)),
      );
      const total = outcomes.length;
      if (failed.length === 0) {
        toast.success(total === 1 ? 'Task deleted' : `Deleted ${total} tasks`);
        return;
      }
      const [first, ...others] = [...new Set(failed.map((f) => f.reason))];
      const more =
        others.length > 0
          ? ` (+${others.length} more reason${others.length === 1 ? '' : 's'})`
          : '';
      toast.error(
        `Deleted ${total - failed.length} of ${total} tasks; ${failed.length} failed: ${first}${more}`,
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
    },
  });
}

export function useForkTask(
  project_id: string,
  onForkSuccess: (newTask: Task) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      task_id,
      messageId,
      prompt,
    }: {
      task_id: string;
      messageId: string;
      prompt: string;
    }) => api.forkTask(project_id, task_id, { messageId, prompt }),
    onSuccess: (newTask) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
      onForkSuccess(newTask);
      toast.success('Task forked');
    },
    onError: (err) => toast.error(`Fork failed: ${err.message}`),
  });
}

export function useExecuteTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input:
        | string
        | {
            task_id: string;
            prompt?: string;
            reset?: boolean;
            stage?: string;
            freshSession?: boolean;
          },
    ) => {
      if (typeof input === 'string') {
        return api.executeTask(project_id, input);
      }
      return api.executeTask(
        project_id,
        input.task_id,
        input.prompt,
        input.reset,
        input.stage,
        input.freshSession,
      );
    },
    onSuccess: (data, input) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
      if (typeof input !== 'string' && input.reset) {
        toast.success(
          data.unmet_dependency_ids?.length
            ? 'Reset; waiting for dependencies'
            : 'Reset; queued',
        );
      } else if (data.unmet_dependency_ids?.length) {
        toast.success('Queued; waiting for dependencies');
      } else {
        toast.success('Execution started');
      }
    },
    onError: (err) => toast.error(`Execute failed: ${err.message}`),
  });
}

export function useStopTask(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (task_id: string) => api.stopTask(project_id, task_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
      toast.success('Execution stopped');
    },
    onError: (err) => toast.error(`Stop failed: ${err.message}`),
  });
}

// Mirrors ARCHIVE_RUNNING_ERROR in src/routes/tasks.ts; the server reports it
// in `mergeFailures` when a running task is archived.
const ARCHIVE_RUNNING_ERROR = 'Task is running; stop it before archiving';
// Mirrors the manual-done-transition denial in src/routes/tasks.ts.
const MOVE_RUNNING_ERROR =
  'Task is still running; stop it before completing and merging';
const TOAST_REASON_MAX_LENGTH = 120;
const TOAST_MAX_TITLES = 3;

function truncateReason(reason: string) {
  return reason.length > TOAST_REASON_MAX_LENGTH
    ? `${reason.slice(0, TOAST_REASON_MAX_LENGTH - 1)}…`
    : reason;
}

function cachedTaskTitles(
  qc: ReturnType<typeof useQueryClient>,
  project_id: string,
) {
  const titles = new Map<string, string>();
  for (const [, tasks] of snapshotTaskLists(qc, project_id)) {
    for (const task of tasks ?? []) {
      if (task.title && !titles.has(task.id)) titles.set(task.id, task.title);
    }
  }
  return titles;
}

/**
 * Builds a titles label for several groups of failed cards that together show
 * at most TOAST_MAX_TITLES titles; hidden cards are counted as "+N more".
 */
function labelTaskGroups(
  qc: ReturnType<typeof useQueryClient>,
  project_id: string,
  groups: string[][],
) {
  const titles = cachedTaskTitles(qc, project_id);
  let budget = TOAST_MAX_TITLES;
  return groups.map((task_ids) => {
    const shown = task_ids
      .slice(0, budget)
      .map((id) => `"${titles.get(id) ?? id}"`);
    budget -= shown.length;
    const more = task_ids.length - shown.length;
    if (more === 0) return shown.join(', ');
    return shown.length > 0
      ? `${shown.join(', ')}, +${more} more`
      : `+${more} more`;
  });
}

export function useBulkUpdateTasks(project_id: string) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (data: {
      ids: string[];
      status?: TaskStatus;
      archived?: boolean;
    }) =>
      api.bulkUpdateTasks(project_id, data.ids, {
        status: data.status,
        archived: data.archived,
      }),
    onMutate: async ({ ids, status, archived }) => {
      await qc.cancelQueries({ queryKey: queryKeys.tasks.all(project_id) });
      const snapshots = snapshotTaskLists(qc, project_id);
      const project = qc
        .getQueryData<Project[]>(queryKeys.projects.all)
        ?.find((p) => p.id === project_id);
      const stages = getEffectiveProjectStages(project);
      const movesToDone =
        status !== undefined &&
        stages.some((stage) => stage.id === status && stage.type === 'done');

      // Cards a manual move to a done stage will merge, with the place they
      // return to if the merge fails.
      const token = {};
      const completedAt = nextCompletedAt(snapshots);
      const origins = new Map<
        string,
        Pick<TaskSummary, 'status' | 'completed_at'>
      >();
      if (movesToDone) {
        for (const [, tasks] of snapshots) {
          for (const task of tasks ?? []) {
            if (
              ids.includes(task.id) &&
              task.status !== status &&
              !origins.has(task.id)
            ) {
              origins.set(task.id, {
                status: task.status,
                completed_at: task.completed_at,
              });
            }
          }
        }
        updateMergingTasks(qc, project_id, (next) => {
          for (const id of origins.keys()) {
            const displaced = next.get(id);
            next.set(id, {
              token,
              replaces: displaced?.merging === false ? displaced : undefined,
              status,
              completedAt,
              merging: true,
              // The server keeps `completed_at` on done-to-done moves.
              keepPlacement:
                stages.find((stage) => stage.id === origins.get(id)?.status)
                  ?.type === 'done',
            });
          }
        });
      }

      // Filled once the server reports failed merges, so a later replay of
      // this operation (after an older one rolls back) leaves those cards in
      // their original stage.
      const failedIds = new Set<string>();
      const operation = beginOptimisticTaskListOperation(
        qc,
        project_id,
        (f) => {
          if (!ids.includes(f.id) || failedIds.has(f.id)) return f;
          const next = { ...f };
          if (status !== undefined) next.status = status;
          if (origins.has(f.id)) next.completed_at = completedAt;
          if (archived !== undefined) next.archived = archived;
          return next;
        },
      );
      return { operation, token, origins, failedIds };
    },
    onError: (err, _vars, context) => {
      if (context?.operation) {
        rollbackOptimisticTaskListOperation(qc, project_id, context.operation);
      }
      if (context?.token) clearMergingEntries(qc, project_id, context.token);
      toast.error(`Failed to update tasks: ${err.message}`);
    },
    onSuccess: (result, vars, context) => {
      for (const failure of result.mergeFailures ?? []) {
        context?.failedIds.add(failure.task_id);
      }
      if (context?.operation) {
        settleOptimisticTaskListOperation(qc, project_id, context.operation);
      }
      if (context) {
        const { failedIds } = context;
        // Failed merges leave the server status unchanged: send those cards
        // back now; the rest stay pinned in Done until the refetch lands.
        if (failedIds.size > 0) {
          const sendBack: TaskListUpdate = (task) => {
            const origin = failedIds.has(task.id)
              ? context.origins.get(task.id)
              : undefined;
            return origin ? { ...task, ...origin } : task;
          };
          patchTaskLists(qc, project_id, (tasks) => tasks.map(sendBack));
          rebaseOperationSnapshots(qc, project_id, context.operation, sendBack);
        }
        markMergingSettled(qc, project_id, context.token, failedIds);
      }
      const failures = result.mergeFailures ?? [];
      const runningDenials = failures.filter(
        (failure) => failure.error === ARCHIVE_RUNNING_ERROR,
      );
      if (runningDenials.length > 0) toast.error(ARCHIVE_RUNNING_ERROR);
      const stillRunning = failures.filter(
        (failure) => failure.error === MOVE_RUNNING_ERROR,
      );
      // Held by the merge risk gate: the dialog replaces the error toast.
      const held = failures.flatMap((failure) =>
        failure.approval ? [{ ...failure, approval: failure.approval }] : [],
      );
      if (held.length > 0) {
        const titles = cachedTaskTitles(qc, project_id);
        promptMergeApproval({
          projectId: project_id,
          items: held.map((failure) => ({
            taskId: failure.task_id,
            title: titles.get(failure.task_id) ?? failure.task_id,
            approval: failure.approval,
          })),
          retry: (ids) => mutation.mutate({ ids, status: vars.status }),
        });
      }
      const mergeFailures = failures.filter(
        (failure) =>
          !failure.approval &&
          failure.error !== ARCHIVE_RUNNING_ERROR &&
          failure.error !== MOVE_RUNNING_ERROR,
      );
      const [mergeLabel, runningLabel] = labelTaskGroups(qc, project_id, [
        mergeFailures.map((failure) => failure.task_id),
        stillRunning.map((failure) => failure.task_id),
      ]);
      const parts: string[] = [];
      if (mergeFailures.length > 0) {
        const reason = truncateReason(mergeFailures[0].error?.trim() ?? '');
        parts.push(
          `${mergeFailures.length} task branch${mergeFailures.length === 1 ? '' : 'es'} could not be merged (${mergeLabel})${reason ? `: ${reason}` : ''}`,
        );
      }
      if (stillRunning.length > 0) {
        parts.push(
          `${stillRunning.length} task${stillRunning.length === 1 ? ' is' : 's are'} still running (${runningLabel}); stop ${stillRunning.length === 1 ? 'it' : 'them'} before completing`,
        );
      }
      if (parts.length > 0) toast.error(parts.join('. '));
    },
    onSettled: (_result, _error, vars) => {
      // Keep a moved card pinned until a refetch delivers the server state,
      // or a merged card could flash back into its old column.
      void reconcileTaskLists(qc, project_id);
      for (const taskId of vars.ids) {
        qc.invalidateQueries({
          queryKey: queryKeys.taskDiff.all(project_id, taskId),
        });
      }
    },
  });
  return mutation;
}

export function useBulkExecuteTasks(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.bulkExecuteTasks(project_id, ids),
    onSuccess: (res, ids) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
      if (res.startedCount >= ids.length) {
        toast.success(`Started execution for ${res.startedCount} task(s)`);
      } else {
        toast.warning(
          `Started ${res.startedCount} of ${ids.length} task(s); ${ids.length - res.startedCount} skipped (already running, done, blocked by dependencies or at capacity)`,
        );
      }
    },
    onError: (err) => toast.error(`Bulk execute failed: ${err.message}`),
  });
}

export function useBulkStopTasks(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.bulkStopTasks(project_id, ids),
    onSuccess: (res, ids) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
      if (res.stoppedCount >= ids.length) {
        toast.success(`Stopped ${res.stoppedCount} task(s)`);
      } else {
        toast.warning(
          `Stopped ${res.stoppedCount} of ${ids.length} task(s); ${ids.length - res.stoppedCount} were not running`,
        );
      }
    },
    onError: (err) => toast.error(`Bulk stop failed: ${err.message}`),
  });
}

export function useBulkStartOverTasks(project_id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids }: { ids: string[]; titles: Record<string, string> }) =>
      api.bulkStartOverTasks(project_id, ids),
    onSettled: () =>
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) }),
    onSuccess: (res, { titles }) => {
      const parts = [`${res.reset.length} reset`];
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} skipped`);
      if (res.failed.length > 0) parts.push(`${res.failed.length} failed`);
      let message = `Start over: ${parts.join(', ')}`;
      if (res.failed.length > 0) {
        const shown = res.failed
          .slice(0, 3)
          .map((f) => `${titles[f.task_id] ?? f.task_id}: ${f.error}`);
        const more = res.failed.length - shown.length;
        message += `. ${shown.join('; ')}${more > 0 ? ` and ${more} more` : ''}`;
      }
      if (res.skipped.length > 0 || res.failed.length > 0) {
        toast.warning(message);
      } else {
        toast.success(message);
      }
    },
    onError: (err) => toast.error(`Bulk start over failed: ${err.message}`),
  });
}

export function useMoveTask(project_id: string) {
  const qc = useQueryClient();
  const bulkUpdateMutation = useBulkUpdateTasks(project_id);

  // A card whose merge is still running cannot be moved again.
  const movable = (ids: string[]) => {
    const pending = getMergingStore(qc).byProject.get(project_id);
    return ids.filter((id) => !pending?.get(id)?.merging);
  };

  return {
    moveTask: (task_id: string, newStatus: TaskStatus) => {
      const ids = movable([task_id]);
      if (ids.length === 0) return;
      bulkUpdateMutation.mutate({ ids, status: newStatus });
    },
    bulkMoveTasks: (ids: string[], newStatus: TaskStatus) => {
      const movableIds = movable(ids);
      if (movableIds.length === 0) return;
      bulkUpdateMutation.mutate({ ids: movableIds, status: newStatus });
    },
  };
}

/**
 * Move a task from its current project to another project. Reference-only:
 * the on-disk transcript stays in the source project; the target sees an
 * empty chat with the task description preserved.
 */
export function useMoveTaskToProject(
  project_id: string,
  onSuccess?: (moved: Task) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      task_id,
      target_project_id,
    }: {
      task_id: string;
      target_project_id: string;
    }) => api.moveTaskToProject(project_id, task_id, target_project_id),
    onSuccess: (moved) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(project_id) });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all(moved.project_id) });
      toast.success('Task moved');
      onSuccess?.(moved);
    },
    onError: (err) => toast.error(`Move failed: ${err.message}`),
  });
}
