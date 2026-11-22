import { useEffect, useState } from 'react';
import {
  keepPreviousData,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  GitCommit,
  GitMerge,
  GitPullRequestArrow,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/query-keys';
import {
  commitConversationChanges,
  discardConversationWorktree,
  getConversationDiff,
  mergeConversationWorktree,
  suggestConversationCommitMessage,
  updateConversationGitIndex,
  updateConversationWorktreeFromDefault,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { useStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { Conversation } from '@/types';
import { ChangesView } from './changes-view';
import { DefaultBranchSync } from './default-branch-sync';
import {
  ToolbarActionsRow,
  ToolbarIconButton,
  WorkspaceToolbar,
} from './workspace-toolbar';

/**
 * Repository diff: project main checkout by default, or the active
 * conversation's isolated worktree when it has one.
 * The parent supplies scrolling/overflow.
 */
export function ChangesTab({
  project_id,
  conversation_id,
  active = true,
  onProjectSetup,
}: {
  project_id: string;
  conversation_id: string | null;
  active?: boolean;
  onProjectSetup?: () => void;
}) {
  const queryClient = useQueryClient();
  // Deep-linked chats outside the first list page are loaded by chat-page into
  // this cache instead of the list caches. Subscribe (never fetch) so the tab
  // updates when it arrives.
  const { data: detailConversation } = useQuery<Conversation>({
    queryKey: ['conversation-detail', project_id, conversation_id],
    queryFn: skipToken,
  });
  let useWorktree: boolean | undefined;
  let worktreeOwnedByConversation = false;
  let conversationWorking = false;
  const applyConversation = (found: Conversation) => {
    useWorktree = !!found.use_worktree;
    worktreeOwnedByConversation =
      !found.branch_name || found.branch_name === `chat-${found.id}`;
    conversationWorking = found.status === 'working';
  };
  if (conversation_id) {
    const lists = [
      ...queryClient.getQueriesData<InfiniteData<Conversation[]>>({
        queryKey: ['conversations'],
      }),
      ...queryClient.getQueriesData<InfiniteData<Conversation[]>>({
        queryKey: ['objectiveConversations'],
      }),
    ];
    for (const [, data] of lists) {
      const found = data?.pages
        .flat()
        .find((conversation) => conversation.id === conversation_id);
      if (found) {
        applyConversation(found);
        break;
      }
    }
    if (useWorktree === undefined && detailConversation?.id === conversation_id)
      applyConversation(detailConversation);
  }
  // Either signal means a run is (or may be) active: the live chat flag from
  // websocket events, or the persisted conversation status after a refresh.
  const chatRunning = useStore((s) =>
    conversation_id ? !!s.chatRunningByConv[conversation_id] : false,
  );
  const conversationRunning = chatRunning || conversationWorking;
  // Unknown existing conversations keep using the conversation endpoint so
  // the backend can resolve their checkout safely. Blank/new conversations
  // and confirmed non-worktree conversations use the shared main checkout.
  const diffConversationId =
    conversation_id && useWorktree !== false ? conversation_id : null;
  const diffQueryKey = diffConversationId
    ? queryKeys.conversationDiff.all(project_id, diffConversationId)
    : queryKeys.conversationDiff.shared(project_id);
  // Bumped on each manual refresh so react-query always issues a new fetch
  // (refetch() alone can appear to no-op when cached data is still "fresh").
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [changeForm, setChangeForm] = useState<'commit' | 'merge' | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [commitMessageError, setCommitMessageError] = useState<string | null>(
    null,
  );
  const [discardOpen, setDiscardOpen] = useState(false);
  const [removeWorktreeAfterMerge, setRemoveWorktreeAfterMerge] =
    useState(false);
  const [lifecycleCompleted, setLifecycleCompleted] = useState(false);
  /** Bumped when the user requests an LLM suggestion (optional). */
  const [suggestNonce, setSuggestNonce] = useState(0);

  const discardMutation = useMutation({
    mutationFn: () => discardConversationWorktree(project_id, conversation_id!),
    onSuccess: () => {
      refreshAfterWorktreeAction(true);
      toast.success('Worktree changes discarded');
    },
  });
  const resetDiscard = discardMutation.reset;
  const closeDiscard = () => {
    setDiscardOpen(false);
    resetDiscard();
  };

  useEffect(() => {
    setRefreshSeq(0);
    setChangeForm(null);
    setCommitMessage('');
    setCommitMessageError(null);
    setDiscardOpen(false);
    setRemoveWorktreeAfterMerge(false);
    setLifecycleCompleted(false);
    setSuggestNonce(0);
    resetDiscard();
  }, [project_id, conversation_id, resetDiscard]);

  const diffQuery = useQuery({
    queryKey: [...diffQueryKey, refreshSeq],
    queryFn: () => getConversationDiff(project_id, diffConversationId),
    enabled: active,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });

  const diff = diffQuery.data;
  const isFirstCommit = diff?.repositoryState === 'unborn';
  const hasChanges =
    !!diff?.available &&
    ((diff.files?.length ?? 0) > 0 ||
      !!(diff.patch && diff.patch.trim()) ||
      !!diff.changeSections?.some((section) => section.files.length > 0));
  const canManageWorktree =
    !!conversation_id &&
    !lifecycleCompleted &&
    worktreeOwnedByConversation &&
    (useWorktree === true || diff?.scope === 'worktree');
  const canCommit =
    hasChanges &&
    (!diff?.changeSections ||
      !!diff.changeSections.find(
        (section) => section.kind === 'staged' && section.files.length > 0,
      )) &&
    (diff?.scope === 'working-tree' ||
      (diff?.scope === 'worktree' &&
        diff.uncommitted === true &&
        canManageWorktree));

  const suggestQuery = useQuery({
    queryKey: [
      'commitMessage',
      project_id,
      conversation_id ?? 'main',
      suggestNonce,
    ],
    queryFn: () =>
      suggestConversationCommitMessage(
        project_id,
        conversation_id,
        changeForm === 'commit' && !!diff?.changeSections,
      ),
    enabled:
      (changeForm === 'commit'
        ? canCommit
        : changeForm === 'merge' && canManageWorktree && hasChanges) &&
      suggestNonce > 0,
    staleTime: 0,
    gcTime: 0,
  });

  // Apply suggestion only when a new fetch completes — not when the user clears the field.
  useEffect(() => {
    if (suggestQuery.isSuccess && suggestQuery.data?.message) {
      setCommitMessage(suggestQuery.data.message);
    }
  }, [suggestQuery.isSuccess, suggestQuery.data?.message, suggestNonce]);

  const commitMutation = useMutation({
    mutationFn: (message: string) =>
      diff?.changeSections
        ? commitConversationChanges(project_id, conversation_id, message, true)
        : commitConversationChanges(project_id, conversation_id, message),
    onSuccess: () => {
      setChangeForm(null);
      setCommitMessage('');
      setCommitMessageError(null);
      setSuggestNonce(0);
      setRefreshSeq((n) => n + 1);
      queryClient.invalidateQueries({
        queryKey: diffQueryKey,
      });
      queryClient.invalidateQueries({
        queryKey: diffConversationId
          ? queryKeys.repoFiles.all(project_id, diffConversationId)
          : queryKeys.repoFiles.shared(project_id),
      });
    },
    onError: (err: Error) => {
      setCommitMessageError(err.message || 'Commit failed');
    },
  });

  const refreshAfterWorktreeAction = (worktreeRemoved: boolean) => {
    setChangeForm(null);
    setDiscardOpen(false);
    setCommitMessage('');
    setCommitMessageError(null);
    setSuggestNonce(0);
    setRemoveWorktreeAfterMerge(false);
    if (worktreeRemoved) setLifecycleCompleted(true);
    setRefreshSeq((n) => n + 1);
    queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.all(project_id),
    });
    queryClient.invalidateQueries({ queryKey: diffQueryKey });
    queryClient.invalidateQueries({
      queryKey: queryKeys.repoFiles.shared(project_id),
    });
    if (conversation_id) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.repoFiles.all(project_id, conversation_id),
      });
    }
  };

  const mergeMutation = useMutation({
    mutationFn: () =>
      mergeConversationWorktree(
        project_id,
        conversation_id!,
        removeWorktreeAfterMerge,
        diff?.uncommitted ? commitMessage.trim() : undefined,
      ),
    onSuccess: (result) => {
      refreshAfterWorktreeAction(result.worktreeRemoved);
      toast.success(
        result.worktreeRemoved
          ? `Merged into ${result.base} and removed worktree`
          : `Merged into ${result.base}`,
      );
    },
    onError: (err: Error) => {
      setCommitMessageError(err.message || 'Merge failed');
    },
  });

  const updateFromDefaultMutation = useMutation({
    mutationFn: () =>
      updateConversationWorktreeFromDefault(project_id, conversation_id!),
    onSuccess: (result) => {
      refreshAfterWorktreeAction(false);
      toast.success(
        result.updated
          ? `Updated from ${result.base}`
          : `Already up to date with ${result.base}`,
      );
    },
    onError: (err: Error) => toast.error(err.message || 'Update failed'),
  });

  const indexMutation = useMutation({
    mutationFn: ({
      path,
      action,
      previousPath,
    }: {
      path?: string;
      action: 'stage' | 'unstage' | 'stageAll';
      previousPath?: string;
    }) =>
      updateConversationGitIndex(
        project_id,
        // A working-tree diff is project-scoped; the conversation index
        // endpoint rejects non-worktree conversations.
        diff?.scope === 'working-tree' ? null : diffConversationId,
        path,
        action,
        previousPath,
      ),
    onSuccess: () => {
      setRefreshSeq((n) => n + 1);
      queryClient.invalidateQueries({ queryKey: diffQueryKey });
    },
    onError: (error: Error) =>
      toast.error(error.message || 'Could not update Git index'),
  });

  const requestCommitSuggestion = () => {
    setCommitMessageError(null);
    setSuggestNonce((n) => n + 1);
  };

  const workflowActions = (
    <>
      {canCommit && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => {
            setChangeForm((form) => (form === 'commit' ? null : 'commit'));
            setCommitMessage(isFirstCommit ? 'Initial commit' : '');
            setCommitMessageError(null);
            setSuggestNonce(0);
          }}
          data-ui="commit-conversation-changes"
        >
          <GitCommit className="size-3.5" />
          {isFirstCommit ? 'Create first commit' : 'Commit'}
        </Button>
      )}
      {canManageWorktree && hasChanges && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => {
            setChangeForm((form) => (form === 'merge' ? null : 'merge'));
            setCommitMessage('');
            setCommitMessageError(null);
            setRemoveWorktreeAfterMerge(false);
            setSuggestNonce(0);
          }}
          data-ui="merge-conversation-worktree"
        >
          <GitMerge className="size-3.5" />
          Merge
        </Button>
      )}
      {canManageWorktree && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => {
            resetDiscard();
            setDiscardOpen(true);
          }}
          className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
          data-ui="discard-conversation-worktree"
        >
          <Trash2 className="size-3.5" />
          Discard
        </Button>
      )}
    </>
  );
  const refreshButton = (
    <ToolbarIconButton
      label="Refresh changes"
      onClick={() => setRefreshSeq((n) => n + 1)}
    >
      <RefreshCw
        className={cn('size-3.5', diffQuery.isFetching && 'animate-spin')}
      />
    </ToolbarIconButton>
  );
  const hasWorkflowActions = canCommit || canManageWorktree;

  return (
    <div data-ui="changes-tab" className="flex flex-col min-h-0">
      {!diff?.available && (
        <div className="sticky top-0 z-10 bg-background">
          <WorkspaceToolbar data-ui="changes-toolbar">
            <ToolbarActionsRow
              actions={hasWorkflowActions ? workflowActions : null}
              trailing={refreshButton}
            />
          </WorkspaceToolbar>
        </div>
      )}

      {diff?.available && (
        <div
          className="sticky top-0 z-10 bg-background"
          data-ui="changes-sync-actions"
        >
          <DefaultBranchSync
            project_id={project_id}
            scope={diff.scope}
            active={active}
            refreshKey={refreshSeq}
            actions={hasWorkflowActions ? workflowActions : null}
            trailing={refreshButton}
            onPulled={() => {
              setRefreshSeq((n) => n + 1);
              queryClient.invalidateQueries({ queryKey: diffQueryKey });
              queryClient.invalidateQueries({
                queryKey: queryKeys.repoFiles.shared(project_id),
              });
            }}
          />
        </div>
      )}

      {diff?.available &&
        diff.scope === 'worktree' &&
        (diff.defaultBranchAhead ?? 0) > 0 && (
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1 text-xs text-muted-foreground"
            data-ui="worktree-default-branch-ahead"
            data-ahead={diff.defaultBranchAhead}
          >
            <span className="min-w-0 max-w-full">
              {diff.base || 'Default branch'} is {diff.defaultBranchAhead}{' '}
              {diff.defaultBranchAhead === 1 ? 'commit' : 'commits'} ahead
            </span>
            <span
              className="ml-auto"
              title={
                !canManageWorktree
                  ? 'Only the conversation that owns this worktree can update it'
                  : conversationRunning
                    ? 'Wait for the active conversation run to finish first'
                    : diff.uncommitted
                      ? 'Commit or discard changes first'
                      : undefined
              }
            >
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={
                  updateFromDefaultMutation.isPending ||
                  !canManageWorktree ||
                  conversationRunning ||
                  diff.uncommitted !== false
                }
                onClick={() => updateFromDefaultMutation.mutate()}
                data-ui="update-worktree-from-default"
              >
                {updateFromDefaultMutation.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <GitPullRequestArrow className="size-3.5" />
                )}
                Update from {diff.base || 'default'}
              </Button>
            </span>
          </div>
        )}

      {changeForm &&
        ((changeForm === 'commit' && canCommit) ||
          (changeForm === 'merge' && canManageWorktree && hasChanges)) && (
          <div
            className="mb-3 rounded-lg border border-border p-3 space-y-2 bg-muted/30"
            data-ui={`${changeForm}-conversation-changes-form`}
          >
            <p className="text-xs font-medium">
              {changeForm === 'merge'
                ? `Merge into ${diff?.base || 'the default branch'}`
                : isFirstCommit
                  ? `Create first commit on ${diff?.branch}`
                  : diff?.scope === 'worktree'
                    ? 'Commit conversation changes'
                    : 'Commit working-tree changes'}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {changeForm === 'merge'
                ? diff?.uncommitted
                  ? 'Commit the uncommitted changes with this message, then merge the conversation branch.'
                  : 'Merge the committed conversation changes into the default branch.'
                : diff?.scope === 'worktree'
                  ? diff?.changeSections
                    ? 'Commits staged changes on this conversation branch without merging them.'
                    : 'Commits all uncommitted changes on this conversation branch without merging them.'
                  : diff?.changeSections
                    ? 'Commits staged changes in the shared repo checkout (not isolated to this chat).'
                    : 'Commits all uncommitted changes in the shared repo checkout (not isolated to this chat).'}
            </p>
            {(changeForm === 'commit' || diff?.uncommitted) && (
              <Textarea
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                rows={4}
                className="resize-y min-h-[72px]"
                placeholder="Commit message"
                disabled={commitMutation.isPending || mergeMutation.isPending}
              />
            )}
            {changeForm === 'merge' && (
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox
                  checked={removeWorktreeAfterMerge}
                  onCheckedChange={(checked) =>
                    setRemoveWorktreeAfterMerge(checked === true)
                  }
                  disabled={mergeMutation.isPending}
                />
                Remove worktree after merge
              </label>
            )}
            {suggestQuery.isError && (
              <p className="text-[11px] text-amber-700 dark:text-amber-600">
                Could not generate a message — write one manually.
              </p>
            )}
            {commitMessageError && (
              <p
                role="alert"
                className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[11px] text-destructive"
              >
                {commitMessageError}
              </p>
            )}
            <div className="flex justify-between items-center gap-2">
              {changeForm === 'commit' || diff?.uncommitted ? (
                <button
                  type="button"
                  onClick={requestCommitSuggestion}
                  disabled={
                    commitMutation.isPending ||
                    mergeMutation.isPending ||
                    suggestQuery.isFetching
                  }
                  className={cn(
                    'p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground',
                    'disabled:opacity-50 disabled:pointer-events-none',
                  )}
                  title="Generate commit message with AI"
                >
                  {suggestQuery.isFetching ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setChangeForm(null);
                    setCommitMessage('');
                    setCommitMessageError(null);
                    setRemoveWorktreeAfterMerge(false);
                    setSuggestNonce(0);
                  }}
                  disabled={commitMutation.isPending || mergeMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    changeForm === 'merge'
                      ? mergeMutation.mutate()
                      : commitMutation.mutate(commitMessage.trim())
                  }
                  disabled={
                    commitMutation.isPending ||
                    mergeMutation.isPending ||
                    ((changeForm === 'commit' || diff?.uncommitted) &&
                      !commitMessage.trim())
                  }
                >
                  {commitMutation.isPending || mergeMutation.isPending ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      {changeForm === 'merge' ? 'Merging…' : 'Committing…'}
                    </>
                  ) : changeForm === 'merge' ? (
                    'Merge changes'
                  ) : isFirstCommit ? (
                    'Create first commit'
                  ) : (
                    'Commit changes'
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

      <ChangesView
        diff={diffQuery.data}
        isLoading={diffQuery.isLoading && !diffQuery.data}
        isRefreshing={diffQuery.isFetching && !!diffQuery.data}
        enableFileDrag
        onIndexAction={
          diff?.changeSections &&
          (diff.scope === 'working-tree' || canManageWorktree)
            ? (path, action, previousPath) =>
                indexMutation.mutate({ path, action, previousPath })
            : undefined
        }
        onStageAll={
          diff?.changeSections &&
          (diff.scope === 'working-tree' || canManageWorktree)
            ? () => indexMutation.mutate({ action: 'stageAll' })
            : undefined
        }
        pendingIndexPath={
          indexMutation.isPending ? indexMutation.variables?.path : undefined
        }
        indexBusy={indexMutation.isPending || diffQuery.isFetching}
        onProjectSetup={onProjectSetup}
      />
      {diff?.changeSections &&
        hasChanges &&
        !canCommit &&
        (diff.scope === 'working-tree' || canManageWorktree) && (
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-ui="stage-before-commit"
          >
            Stage files to include them in a commit.
          </p>
        )}

      <Dialog
        open={discardOpen}
        onOpenChange={(open) => {
          if (!open && !discardMutation.isPending) closeDiscard();
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          data-ui="conversation-worktree-action-dialog"
        >
          <DialogHeader>
            <DialogTitle>Discard this worktree?</DialogTitle>
            <DialogDescription>
              All committed and uncommitted changes on this conversation branch
              will be permanently discarded, and the worktree will be removed.
              The conversation itself will remain.
            </DialogDescription>
          </DialogHeader>
          {discardMutation.isError && (
            <p className="text-sm text-destructive">
              {discardMutation.error instanceof Error
                ? discardMutation.error.message
                : 'The worktree action failed'}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDiscard}
              disabled={discardMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => discardMutation.mutate()}
              disabled={discardMutation.isPending}
            >
              {discardMutation.isPending && (
                <Loader2 className="size-4 animate-spin" />
              )}
              Discard worktree
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
