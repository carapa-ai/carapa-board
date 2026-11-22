import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Check, KanbanSquare, MessageSquare, Target } from 'lucide-react';
import { toast } from 'sonner';
import { useAttention, useAttentionPartition } from '@/hooks/use-attention';
import { useProjects } from '@/hooks/use-projects';
import { useWallClockRefresh } from '@/hooks/use-wall-clock-refresh';
import {
  ApiError,
  acknowledgeUnreadNotifications,
  dismissAttentionGroup,
  dismissAttentionItems,
  markConversationRead,
  type AttentionResponse,
  type UnreadNotification,
} from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import {
  groupForState,
  NOW_GROUP_IDS,
  NOW_GROUP_LABELS,
  type NowGroupId,
  type NowGroups,
  type NowRowModel,
} from '@/lib/attention';
import { openNotification } from '@/lib/notification-overlay';
import { useStore } from '@/store';
import { Tooltip, isTextClipped } from '@/components/ui/tooltip';
import { cn, formatExactTime, formatRelativeTime } from '@/lib/utils';
import { rovingKeyDown, rovingRowOf } from './roving-list';

const MAX_VISIBLE_ROWS = 5;
const DISMISS_COOLDOWN_MS = 300;

type UnreadNotificationsData = { items: UnreadNotification[]; count: number };
type DismissableNowGroupId = Exclude<NowGroupId, 'running'>;

/** Rows the user must act on or that are in flight; unread items stay quiet. */
export function countNowBadge(groups: NowGroups): number {
  return groups.running.length + groups['needs-you'].length;
}

/** Every item in the panel, including replies; shown on the collapsed mobile header. */
export function countNowItems(groups: NowGroups): number {
  return NOW_GROUP_IDS.reduce((sum, id) => sum + groups[id].length, 0);
}

export function useNowGroups(): NowGroups {
  return useAttentionPartition().groups;
}

/** The conversation open in the chat or objective view, if any. */
function useCurrentConversationId(): string | null {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const routeConversationId = useRouterState({
    select: (s) => {
      const id = (s.location.search as Record<string, unknown> | undefined)
        ?.conversationId;
      return typeof id === 'string' && id !== '' ? id : null;
    },
  });
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  // Chat keeps its selection per project, objectives per objective.
  const folderKey =
    segments[0] === 'chat'
      ? segments[1]
      : segments[0] === 'objective'
        ? segments[2]
        : undefined;
  const rememberedConversationId = useStore((s): string | null | undefined =>
    folderKey ? s.activeConvByProject[folderKey] : undefined,
  );
  if (!folderKey) return null;
  // The chat/objective page keeps its effective selection in the store and
  // treats the URL id as a one-shot deep-link override, so once the page has
  // recorded a selection for this view (null = blank new-chat composer) the
  // store wins; the route id only covers the first render before that sync.
  return rememberedConversationId !== undefined
    ? rememberedConversationId
    : routeConversationId;
}

function StateMarker({ row }: { row: NowRowModel }) {
  // A viewed reply keeps its row but loses the "new" dot.
  const viewed = row.state === 'unread' && row.unread === false;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'mt-[7px] size-1.5 shrink-0 rounded-full',
        row.state === 'running' && 'animate-pulse bg-blue-600 dark:bg-blue-500',
        (row.state === 'pending' || row.state === 'question') &&
          'bg-amber-600 dark:bg-amber-500',
        row.state === 'failed' && 'bg-red-600 dark:bg-red-500',
        row.state === 'unread' &&
          !viewed &&
          'bg-emerald-600 dark:bg-emerald-500',
        viewed && 'bg-muted-foreground/30',
        row.state === 'completed' && 'bg-green-600 dark:bg-green-500',
      )}
    />
  );
}

function NowRow({
  row,
  projectName,
  current,
  onOpen,
  onOpenNotification,
  onDismiss,
  rovingTabStop,
}: {
  row: NowRowModel;
  projectName?: string;
  /** False removes the open button from the Tab order (roving tabindex). */
  rovingTabStop: boolean;
  /** The row is the conversation open in the main view. */
  current: boolean;
  onOpen: (row: NowRowModel) => void;
  onOpenNotification: (id: string) => void;
  onDismiss: (row: NowRowModel) => void;
}) {
  const KindIcon =
    row.kind === 'task'
      ? KanbanSquare
      : row.objectiveId
        ? Target
        : MessageSquare;
  const viewed = row.state === 'unread' && row.unread === false;
  const formNotificationId = row.formNotificationId;
  const canDismiss = row.state !== 'running' && !formNotificationId;
  const titleRef = useRef<HTMLSpanElement>(null);
  const projectRef = useRef<HTMLSpanElement>(null);
  // The row repeats its title and project name in full on screen, so the
  // tooltip only completes what is cut off.
  const clippedText = () => {
    const title = isTextClipped(titleRef.current);
    const project = projectName && isTextClipped(projectRef.current);
    if (!title && !project) return null;
    return (
      <>
        {title && <span className="block">{row.title}</span>}
        {project && (
          <span
            className={cn('block', title && 'mt-0.5 text-muted-foreground')}
          >
            {projectName}
          </span>
        )}
      </>
    );
  };
  return (
    <Tooltip content={clippedText} side="right">
      <div
        role="listitem"
        data-roving-row={row.key}
        data-ui="sidebar-now-item"
        data-kind={row.kind}
        data-state={row.state}
        data-entity-id={row.id}
        data-current={current || undefined}
        className={cn(
          'group flex items-center rounded-md',
          current ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
        )}
      >
        <button
          type="button"
          data-roving-item
          data-roving-primary
          tabIndex={rovingTabStop ? 0 : -1}
          aria-current={current ? 'page' : undefined}
          onClick={() => onOpen(row)}
          className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-2 py-1 max-md:min-h-11 [@media(hover:none)]:mr-1.5 [@media(hover:none)]:min-h-11 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <StateMarker row={row} />
          <KindIcon
            aria-hidden="true"
            className="mt-[3px] size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1">
            <span
              ref={titleRef}
              className={cn(
                'line-clamp-2 break-words text-sm',
                current
                  ? 'text-accent-foreground'
                  : viewed
                    ? 'text-muted-foreground'
                    : 'text-sidebar-foreground',
              )}
            >
              {row.title}
            </span>
            <span className="flex min-w-0 items-baseline gap-2 text-[10px] md:text-[11px] text-muted-foreground">
              {projectName && (
                <span ref={projectRef} className="min-w-0 truncate">
                  {projectName}
                </span>
              )}
              <Tooltip
                content={formatExactTime(row.at)}
                side="right"
                redundant={false}
              >
                <time
                  dateTime={row.at}
                  className="ml-auto shrink-0 tabular-nums"
                >
                  {formatRelativeTime(row.at, { justNow: true })}
                </time>
              </Tooltip>
            </span>
          </span>
        </button>
        {formNotificationId && (
          <Tooltip content="Open notification" side="right">
            <button
              type="button"
              data-ui="sidebar-now-item-notification"
              data-roving-item
              tabIndex={-1}
              aria-label={`Open notification: ${row.title}`}
              onClick={() => onOpenNotification(formNotificationId)}
              className="mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-amber-700 hover:text-amber-600 dark:text-amber-500 dark:hover:text-amber-400 max-md:size-11 [@media(hover:none)]:size-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Bell aria-hidden="true" className="size-3" />
            </button>
          </Tooltip>
        )}
        {canDismiss && (
          <Tooltip content="Dismiss" side="right">
            <button
              type="button"
              data-ui="sidebar-now-item-dismiss"
              data-roving-item
              tabIndex={-1}
              aria-label={`Dismiss ${row.title}`}
              onClick={() => onDismiss(row)}
              className="mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground max-md:size-11 [@media(hover:none)]:size-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Check aria-hidden="true" className="size-3.5" />
            </button>
          </Tooltip>
        )}
      </div>
    </Tooltip>
  );
}

function NowGroup({
  id,
  rows,
  projectNames,
  currentConversationId,
  onOpen,
  onOpenNotification,
  onDismiss,
  hiddenCount,
  onDismissAll,
  rovingKey,
}: {
  id: NowGroupId;
  rows: NowRowModel[];
  projectNames: Map<string, string>;
  currentConversationId: string | null;
  onOpen: (row: NowRowModel) => void;
  onOpenNotification: (id: string) => void;
  onDismiss: (row: NowRowModel) => void;
  /** Rows of this group the server did not return. */
  hiddenCount: number;
  onDismissAll?: () => void;
  /** Key of the row that is the list's single Tab stop. */
  rovingKey: string | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, MAX_VISIBLE_ROWS);
  const hidden = rows.length - visible.length + hiddenCount;
  const total = rows.length + hiddenCount;
  return (
    <div data-ui="sidebar-now-group" data-group={id}>
      <div className="flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="min-w-0 truncate">{NOW_GROUP_LABELS[id]}</span>
        <span data-ui="sidebar-now-group-count" className="tabular-nums">
          {total}
        </span>
        {onDismissAll && (
          <Tooltip
            content={`Check off all ${total}`}
            side="right"
            redundant={false}
          >
            <button
              type="button"
              data-ui="sidebar-now-group-dismiss-all"
              data-group={id}
              aria-label={`Check off all ${NOW_GROUP_LABELS[id]}`}
              onClick={onDismissAll}
              className="-my-1 ml-auto flex min-h-6 shrink-0 items-center gap-0.5 rounded-sm px-1 max-md:my-0 max-md:min-h-11 [@media(hover:none)]:my-0 [@media(hover:none)]:min-h-11 normal-case tracking-normal hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Check aria-hidden="true" className="size-3" />
              Check all
            </button>
          </Tooltip>
        )}
      </div>
      <div role="list" aria-label={NOW_GROUP_LABELS[id]}>
        {visible.map((row) => (
          <NowRow
            key={row.key}
            row={row}
            rovingTabStop={row.key === rovingKey}
            projectName={
              row.projectId
                ? (projectNames.get(row.projectId) ?? row.projectId)
                : undefined
            }
            current={
              row.kind === 'conversation' && row.id === currentConversationId
            }
            onOpen={onOpen}
            onOpenNotification={onOpenNotification}
            onDismiss={onDismiss}
          />
        ))}
      </div>
      {total > MAX_VISIBLE_ROWS && (
        <button
          type="button"
          data-ui="sidebar-now-group-more"
          onClick={() => setShowAll(!showAll)}
          className="w-full px-2 py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {showAll
            ? hiddenCount > 0
              ? `Show less · ${hiddenCount} older not listed`
              : 'Show less'
            : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}

export function NowPanel({ groups }: { groups: NowGroups }) {
  // Row times are relative to now; re-render once a minute to keep them current.
  useWallClockRefresh();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: attention } = useAttention();
  const { data: projects } = useProjects();
  const currentConversationId = useCurrentConversationId();
  const projectNames = useMemo(
    () =>
      new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects],
  );

  const [rovingKey, setRovingKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // A focused row can unmount (dismissed, "Show less"); fall back to the first.
  useEffect(() => {
    if (
      rovingKey &&
      !listRef.current?.querySelector(
        `[data-roving-row="${CSS.escape(rovingKey)}"]`,
      )
    ) {
      setRovingKey(null);
    }
  });
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  // Opening a row may change only the search params or open an overlay, so
  // the sidebar's pathname-driven drawer close cannot be relied on.
  const closeMobileDrawer = () => {
    if (window.innerWidth < 768) setSidebarOpen(false);
  };
  const openNotificationRow = (id: string) => {
    closeMobileDrawer();
    openNotification(id);
  };

  // Reload the conversation lists of the projects whose replies were read,
  // so their green dots go away. Each project and objective is reloaded once.
  const invalidateReadConversations = (rows: readonly NowRowModel[]) => {
    const projectIds = new Set<string>();
    const objectiveIds = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.projectId) continue;
      projectIds.add(row.projectId);
      if (!row.objectiveId) continue;
      const ids = objectiveIds.get(row.projectId) ?? new Set<string>();
      ids.add(row.objectiveId);
      objectiveIds.set(row.projectId, ids);
    }
    for (const projectId of projectIds)
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all(projectId),
      });
    for (const [projectId, ids] of objectiveIds)
      for (const objectiveId of ids)
        void queryClient.invalidateQueries({
          queryKey: queryKeys.objectiveConversations.all(
            projectId,
            objectiveId,
          ),
        });
  };

  // Hide the checked rows (and the text notifications about them) at once,
  // restoring both lists if the server rejects the change.
  const checkOff = async ({
    keepItem,
    hiddenGroup,
    ackIds,
    request,
    failureMessage,
  }: {
    keepItem: (item: AttentionResponse['items'][number]) => boolean;
    hiddenGroup?: DismissableNowGroupId;
    ackIds: ReadonlySet<string>;
    request: () => Promise<unknown>;
    failureMessage: string;
  }) => {
    // An in-flight refetch would otherwise overwrite the optimistic write below.
    await queryClient.cancelQueries({ queryKey: queryKeys.attention.all });
    if (ackIds.size > 0)
      await queryClient.cancelQueries({
        queryKey: queryKeys.unreadNotifications,
      });
    const previousAttention = queryClient.getQueryData<AttentionResponse>(
      queryKeys.attention.all,
    );
    const previousUnread = queryClient.getQueryData<UnreadNotificationsData>(
      queryKeys.unreadNotifications,
    );
    queryClient.setQueryData<AttentionResponse>(
      queryKeys.attention.all,
      (old) =>
        old && {
          ...old,
          items: old.items.filter(keepItem),
          ...(hiddenGroup
            ? { hiddenCounts: { ...old.hiddenCounts, [hiddenGroup]: 0 } }
            : {}),
        },
    );
    if (ackIds.size > 0)
      queryClient.setQueryData<UnreadNotificationsData>(
        queryKeys.unreadNotifications,
        (old) =>
          old && {
            items: old.items.filter((item) => !ackIds.has(item.id)),
            count: Math.max(0, old.count - ackIds.size),
          },
      );
    try {
      await request();
      if (ackIds.size > 0) await acknowledgeUnreadNotifications([...ackIds]);
    } catch (error) {
      queryClient.setQueryData(queryKeys.attention.all, previousAttention);
      queryClient.setQueryData(queryKeys.unreadNotifications, previousUnread);
      toast.error(
        `${failureMessage}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.unreadNotifications,
      });
    }
  };

  // A mouse that double-clicks by fault would otherwise dismiss the row that
  // slides under the cursor after the first dismiss. One cooldown for the whole panel.
  const lastDismissAt = useRef(0);
  const dismissCoolingDown = () => {
    const now = Date.now();
    if (now - lastDismissAt.current < DISMISS_COOLDOWN_MS) return true;
    lastDismissAt.current = now;
    return false;
  };

  const dismiss = (row: NowRowModel) => {
    if (dismissCoolingDown()) return;
    return checkOff({
      keepItem: (item) => `${item.kind}:${item.id}` !== row.key,
      ackIds: new Set(row.notificationIds),
      request: async () => {
        // Dismissing an unread reply also reads it, so its green dot leaves the chat list too.
        if (
          row.kind === 'conversation' &&
          row.state === 'unread' &&
          row.projectId
        ) {
          try {
            await markConversationRead(row.projectId, row.id);
          } catch (error) {
            // A deleted conversation can still have an unread notification
            // row; there is nothing to read, so finish the dismissal.
            if (!(error instanceof ApiError && error.status === 404))
              throw error;
          }
          invalidateReadConversations([row]);
        }
        await dismissAttentionItems([{ kind: row.kind, id: row.id }]);
      },
      failureMessage: 'Failed to dismiss',
    });
  };

  // Check off a whole group, including rows beyond the returned cap. Rows
  // with an unanswered form stay, as does activity newer than this list.
  const dismissGroup = (id: DismissableNowGroupId) => {
    const asOf = attention?.generatedAt;
    if (!asOf || dismissCoolingDown()) return;
    const asOfMs = Date.parse(asOf);
    const protectedRows = NOW_GROUP_IDS.flatMap(
      (groupId) => groups[groupId],
    ).filter((row) => row.formNotificationId);
    const protectedKeys = new Set(protectedRows.map((row) => row.key));
    // Checking off the replies also reads them on the server, so the chat
    // lists must reload to drop their green dots. Only the rows the server
    // reads are those that are neither protected nor newer than this list.
    const readRows =
      id === 'unread'
        ? groups[id].filter(
            (row) =>
              row.kind === 'conversation' &&
              row.projectId &&
              !protectedKeys.has(row.key) &&
              Date.parse(row.at) <= asOfMs,
          )
        : [];
    return checkOff({
      keepItem: (item) =>
        groupForState(item.state) !== id ||
        Date.parse(item.at) > asOfMs ||
        protectedKeys.has(`${item.kind}:${item.id}`),
      hiddenGroup: id,
      ackIds: new Set(
        groups[id]
          .filter(
            (row) => !row.formNotificationId && Date.parse(row.at) <= asOfMs,
          )
          .flatMap((row) => row.notificationIds),
      ),
      request: async () => {
        await dismissAttentionGroup(
          id,
          asOf,
          protectedRows.map((row) => ({ kind: row.kind, id: row.id })),
        );
        invalidateReadConversations(readRows);
      },
      failureMessage: `Failed to check off ${NOW_GROUP_LABELS[id]}`,
    });
  };

  const open = (row: NowRowModel) => {
    closeMobileDrawer();
    const projectId = row.projectId;
    if (!projectId) return;
    if (row.kind === 'conversation') {
      // The chat/objective page's effective selection lives in the store (the
      // URL id is only a deep-link override there), so select the row there
      // too: clicking it must reopen the conversation even when the URL
      // already carries its id or a local selection moved away from it.
      const folderKey = row.objectiveId ?? projectId;
      const store = useStore.getState();
      store.setComposingNewConversationForProject(folderKey, false);
      store.setActiveConvForProject(folderKey, row.id);
    }
    if (row.kind === 'task') {
      void navigate({
        to: '/board/$projectId',
        params: { projectId },
        search: { taskId: row.id },
      });
    } else if (row.objectiveId) {
      void navigate({
        to: '/objective/$projectId/$objectiveId',
        params: { projectId, objectiveId: row.objectiveId },
        search: { conversationId: row.id },
      });
    } else {
      void navigate({
        to: '/chat/$projectId',
        params: { projectId },
        search: { conversationId: row.id },
      });
    }
  };

  const visibleGroups = NOW_GROUP_IDS.filter((id) => groups[id].length > 0);
  // The whole list is one Tab stop: the row that last had focus, else the first.
  const firstKey = visibleGroups[0]
    ? groups[visibleGroups[0]][0]?.key
    : undefined;
  const knownKeys = new Set(
    visibleGroups.flatMap((id) => groups[id].map((row) => row.key)),
  );
  const rovingStop =
    rovingKey && knownKeys.has(rovingKey) ? rovingKey : firstKey;
  if (visibleGroups.length === 0) {
    return (
      <p
        data-ui="sidebar-now-empty"
        className="px-3 py-2 text-xs text-muted-foreground"
      >
        All caught up
      </p>
    );
  }
  return (
    <div
      ref={listRef}
      data-roving-root
      className="space-y-0.5 pb-1"
      onKeyDown={(event) => rovingKeyDown(event)}
      onFocus={(event) => {
        const key = rovingRowOf(event.target);
        if (key) setRovingKey(key);
      }}
    >
      {visibleGroups.map((id) => (
        <NowGroup
          key={id}
          id={id}
          rows={groups[id]}
          projectNames={projectNames}
          currentConversationId={currentConversationId}
          onOpen={open}
          onOpenNotification={openNotificationRow}
          onDismiss={dismiss}
          rovingKey={rovingStop}
          hiddenCount={
            id === 'unread' || id === 'completed'
              ? (attention?.hiddenCounts?.[id] ?? 0)
              : 0
          }
          onDismissAll={
            id !== 'running' &&
            attention?.generatedAt &&
            groups[id].some((row) => !row.formNotificationId)
              ? () => void dismissGroup(id)
              : undefined
          }
        />
      ))}
    </div>
  );
}
