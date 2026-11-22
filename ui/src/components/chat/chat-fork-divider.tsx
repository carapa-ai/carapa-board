import { memo } from 'react';
import { formatRelativeTime } from '@/lib/utils';

interface ChatForkDividerProps {
  forkedAt: string;
  /** Title or preview of the source conversation; null when it is unreadable. */
  sourceLabel: string | null;
  onOpenSource?: () => void;
}

/**
 * Separator between the history a forked conversation inherited and the
 * messages added after the fork. Mirrors the task chat's RunDivider pill.
 */
export const ChatForkDivider = memo(function ChatForkDivider({
  forkedAt,
  sourceLabel,
  onOpenSource,
}: ChatForkDividerProps) {
  return (
    <div data-ui="chat-fork-divider" className="flex items-center gap-2 my-1">
      <div className="h-px flex-1 bg-border" />
      <div className="flex min-w-0 max-w-full flex-col items-center gap-y-0.5 px-2 py-0.5 rounded-xl sm:flex-row sm:gap-x-1.5 sm:rounded-full border border-border bg-muted/40 text-[10px] text-muted-foreground sm:whitespace-nowrap">
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1.5 sm:flex-nowrap">
          <span className="font-semibold text-foreground">Forked</span>
          <span>{formatRelativeTime(forkedAt)}</span>
        </div>
        {sourceLabel && onOpenSource && (
          <div className="flex min-w-0 max-w-full items-center justify-center gap-1.5">
            <span>from</span>
            <button
              type="button"
              data-ui="chat-fork-divider-source"
              title={sourceLabel}
              onClick={onOpenSource}
              className="min-w-0 max-w-[16rem] truncate text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
            >
              {sourceLabel}
            </button>
          </div>
        )}
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
});
