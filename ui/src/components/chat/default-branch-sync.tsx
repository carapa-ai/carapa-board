import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Download,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/query-keys';
import {
  fetchDefaultBranch,
  getDefaultBranchSyncStatus,
  pullDefaultBranch,
  pushDefaultBranch,
} from '@/lib/api';
import {
  ToolbarActionsRow,
  ToolbarIconButton,
  WorkspaceToolbar,
  WorkspaceToolbarRow,
} from './workspace-toolbar';
import type { ConversationDiff } from '@/types';

type SyncAction = 'fetch' | 'pull' | 'push';

const ACTIONS: Record<SyncAction, { label: string; done: string }> = {
  fetch: { label: 'Fetch', done: 'Fetched' },
  pull: { label: 'Pull', done: 'Pulled' },
  push: { label: 'Push', done: 'Pushed' },
};

function runSyncAction(
  action: SyncAction,
  project_id: string,
): Promise<{ ok: boolean; output: string; warning?: string }> {
  if (action === 'fetch') return fetchDefaultBranch(project_id);
  if (action === 'pull') return pullDefaultBranch(project_id);
  return pushDefaultBranch(project_id);
}

/**
 * Ahead/behind of the project's default branch vs. its last-fetched remote
 * state, with Fetch / Pull (ff-only) / Push. Reading the status is local
 * git only; the network is touched solely by the buttons.
 */
export function DefaultBranchSync({
  project_id,
  scope,
  active = true,
  refreshKey,
  onPulled,
  actions,
  trailing,
}: {
  project_id: string;
  scope: ConversationDiff['scope'];
  active?: boolean;
  /** Changes when local commits may have moved the branch. */
  refreshKey: number;
  /** Called after a fast-forward changed the shared checkout. */
  onPulled: () => void;
  /** Text actions on a second row (Commit, Merge, ...). */
  actions?: ReactNode;
  /** Icon action at the end of the status row (the refresh button). */
  trailing?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: [...queryKeys.defaultBranchSync.all(project_id), refreshKey],
    queryFn: () => getDefaultBranchSyncStatus(project_id),
    enabled: active,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });

  const syncMutation = useMutation({
    mutationFn: (action: SyncAction) => runSyncAction(action, project_id),
    onSuccess: (result, action) => {
      if (result.warning) {
        toast.warning(result.warning);
      } else
        toast.success(`${ACTIONS[action].done} ${status?.branch ?? ''}`.trim());
      if (action === 'pull') onPulled();
    },
    onError: (err: Error, action) =>
      toast.error(`${ACTIONS[action].label} failed: ${err.message}`),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.defaultBranchSync.all(project_id),
      }),
  });

  const status = statusQuery.data;
  // A failed status read must not look like "in sync": show the git output
  // instead of counts, and keep the last good status out of sight.
  if (statusQuery.isError) {
    return (
      <WorkspaceToolbar>
        <WorkspaceToolbarRow className="flex-nowrap items-start">
          <p
            role="alert"
            className="min-w-0 flex-1 text-xs text-destructive break-words"
            data-ui="default-branch-sync-error"
          >
            Could not read default branch sync status:{' '}
            {statusQuery.error instanceof Error
              ? statusQuery.error.message
              : 'unknown error'}
          </p>
          {trailing}
        </WorkspaceToolbarRow>
        {actions && <ToolbarActionsRow actions={actions} />}
      </WorkspaceToolbar>
    );
  }
  if (!status?.available) {
    return actions || trailing ? (
      <WorkspaceToolbar>
        <ToolbarActionsRow actions={actions} trailing={trailing} />
      </WorkspaceToolbar>
    ) : null;
  }

  const busy = syncMutation.isPending;
  const pendingAction = busy ? syncMutation.variables : undefined;
  const icon = (action: SyncAction, idle: ReactNode) =>
    pendingAction === action ? (
      <Loader2 className="size-3.5 animate-spin" />
    ) : (
      idle
    );

  return (
    <WorkspaceToolbar data-ui="default-branch-sync" data-branch={status.branch}>
      <WorkspaceToolbarRow className="flex-nowrap text-xs text-muted-foreground">
        <p className="min-w-0 flex-1 truncate" title={status.branch}>
          {status.branch}{' '}
          <span
            className={status.fetched ? 'font-mono tabular-nums' : undefined}
            data-ui="default-branch-sync-counts"
          >
            {status.fetched
              ? `↑${status.ahead} ↓${status.behind}`
              : 'not fetched'}
          </span>
        </p>
        <ToolbarIconButton
          label="Fetch"
          tooltip="Fetch the default branch from the remote"
          disabled={busy}
          onClick={() => syncMutation.mutate('fetch')}
          data-ui="default-branch-fetch"
        >
          {icon('fetch', <Download className="size-3.5" />)}
        </ToolbarIconButton>
        {scope === 'working-tree' && (
          <ToolbarIconButton
            label="Pull"
            tooltip={status.canPull ? undefined : status.pullBlockedReason}
            disabled={busy || !status.canPull}
            onClick={() => syncMutation.mutate('pull')}
            data-ui="default-branch-pull"
          >
            {icon('pull', <ArrowDownToLine className="size-3.5" />)}
          </ToolbarIconButton>
        )}
        <ToolbarIconButton
          label="Push"
          tooltip="Push the default branch to the remote"
          disabled={busy}
          onClick={() => syncMutation.mutate('push')}
          data-ui="default-branch-push"
        >
          {icon('push', <ArrowUpFromLine className="size-3.5" />)}
        </ToolbarIconButton>
        {trailing}
      </WorkspaceToolbarRow>
      {actions && <ToolbarActionsRow actions={actions} />}
    </WorkspaceToolbar>
  );
}
