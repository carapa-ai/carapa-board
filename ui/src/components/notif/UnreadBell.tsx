import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CircleHelp,
  ClipboardList,
  KanbanSquare,
  MessageSquare,
  Target,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  invalidateUnreadNotifications,
  useUnreadNotifications,
} from '@/hooks/use-unread-notifications';
import { useAttentionPartition } from '@/hooks/use-attention';
import {
  acknowledgeUnreadNotifications,
  type UnreadNotification,
} from '@/lib/api';
import { openNotification } from '@/lib/notification-overlay';
import { queryKeys } from '@/lib/query-keys';
import { cn, formatRelativeTime } from '@/lib/utils';

type UnreadData = { items: UnreadNotification[]; count: number };

function notificationIcon(it: UnreadNotification) {
  if (it.kind !== 'text') return CircleHelp;
  const url = it.action_url ?? '';
  if (url.startsWith('/objective/')) return Target;
  if (url.startsWith('/board/')) return KanbanSquare;
  if (url.startsWith('/chat/')) return MessageSquare;
  return it.kind === 'text' ? MessageSquare : ClipboardList;
}

// The bell lists only notifications that are not about a conversation or task
// (those live in the Now section). Objective notifications always stay here,
// even when the objective has a conversation row in Now. Opening one never acks it: the badge only
// decrements after the shared notification overlay submits or dismisses, which
// triggers the server-side `notification_acked` WS event and invalidates the
// unread query. "Dismiss all" acks just the notifications listed here.
export function UnreadBell() {
  const qc = useQueryClient();
  const { bellNotifications } = useAttentionPartition();
  const { isPending, isError, refetch } = useUnreadNotifications();
  // Forms wait for an answer, so they come first; each group is newest first.
  const forms = bellNotifications.filter((it) => it.kind !== 'text');
  const updates = bellNotifications.filter((it) => it.kind === 'text');
  const items = [...forms, ...updates];
  const [dismissingAll, setDismissingAll] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) {
        qc.invalidateQueries({ queryKey: queryKeys.unreadNotifications });
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [qc]);

  const count = items.length;
  const badgeText = count > 99 ? '99+' : String(count);

  const dismissAll = async () => {
    if (dismissingAll || count === 0) return;
    const previous = qc.getQueryData<UnreadData>(queryKeys.unreadNotifications);
    const ids = items.map((it) => it.id);
    const idSet = new Set(ids);
    setDismissingAll(true);
    qc.setQueryData<UnreadData>(
      queryKeys.unreadNotifications,
      (old) =>
        old && {
          items: old.items.filter((it) => !idSet.has(it.id)),
          count: Math.max(0, old.count - ids.length),
        },
    );
    try {
      await acknowledgeUnreadNotifications(ids);
      setOpen(false);
    } catch (error) {
      if (previous) qc.setQueryData(queryKeys.unreadNotifications, previous);
      toast.error(
        `Failed to dismiss notifications: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      setDismissingAll(false);
    }
  };

  const openFromBell = (it: UnreadNotification) => {
    invalidateUnreadNotifications(qc);
    openNotification(it.id);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Tooltip
          content={`Notifications${count ? `: ${count} items` : ''}`}
          side="bottom"
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Notifications${count ? `: ${count} items` : ''}`}
            className="relative max-md:size-8 md:h-8 md:w-8"
          >
            <Bell className="size-4" />
            {count > 0 && (
              <Badge
                variant="destructive"
                className={cn(
                  'absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] leading-none',
                )}
              >
                {badgeText}
              </Badge>
            )}
          </Button>
        </Tooltip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 max-w-[calc(100vw-1rem)]"
        data-ui="notification-menu"
      >
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        {(count > 0 || dismissingAll) && (
          <DropdownMenuItem
            disabled={dismissingAll}
            onSelect={(event) => {
              event.preventDefault();
              void dismissAll();
            }}
          >
            {dismissingAll ? 'Dismissing…' : 'Dismiss all'}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {items.length === 0 && isPending ? (
          <div
            role="status"
            className="px-2 py-6 text-center text-xs text-muted-foreground"
          >
            Loading notifications…
          </div>
        ) : items.length === 0 && isError ? (
          <div role="alert" className="px-2 py-4 text-center text-xs">
            <p className="text-destructive">Could not load notifications</p>
            <Button
              variant="outline"
              size="xs"
              className="mt-2"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            No notifications need your attention
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto overscroll-contain">
            <NotificationGroup
              label="Needs you"
              items={forms}
              onOpen={openFromBell}
            />
            <NotificationGroup
              label="Updates"
              items={updates}
              onOpen={openFromBell}
            />
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NotificationGroup({
  label,
  items,
  onOpen,
}: {
  label: string;
  items: UnreadNotification[];
  onOpen: (it: UnreadNotification) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div role="group" aria-label={label}>
      <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label} ({items.length})
      </DropdownMenuLabel>
      {items.map((it) => {
        const Icon = notificationIcon(it);
        const needsAnswer = it.kind !== 'text';
        return (
          <DropdownMenuItem
            key={it.id}
            data-ui="notification-item"
            data-kind={needsAnswer ? 'needs-you' : 'update'}
            className="flex items-start gap-2 py-2"
            onSelect={() => onOpen(it)}
          >
            <Icon
              data-ui="notification-source-icon"
              className={cn(
                'mt-0.5 size-3.5 shrink-0',
                needsAnswer
                  ? 'text-amber-800 dark:text-amber-400'
                  : 'text-muted-foreground',
              )}
            />
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  'break-words text-xs',
                  needsAnswer ? 'font-semibold' : 'font-medium',
                )}
              >
                {it.summary}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {needsAnswer && (
                  <span className="font-medium text-amber-800 dark:text-amber-300">
                    Needs your answer
                  </span>
                )}
                <time dateTime={it.created_at}>
                  {formatRelativeTime(it.created_at)}
                </time>
              </div>
            </div>
          </DropdownMenuItem>
        );
      })}
    </div>
  );
}
