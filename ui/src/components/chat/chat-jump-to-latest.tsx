import { useEffect, useState, type RefObject } from 'react';
import { ArrowDown } from 'lucide-react';

/** The newest content counts as "away" once it is this far below the fold. */
const AWAY_THRESHOLD_PX = 160;

/**
 * "Jump to latest" pill for a scrolling transcript. It owns its visibility
 * state so crossing the threshold re-renders only this button, not the chat
 * page that hosts the transcript. Streaming grows the list, and the composer resizes
 * the container, without any scroll event, so both are observed for resizes.
 */
export function ChatJumpToLatest({
  scrollRef,
  contentRef,
  resetKey,
  onJump,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  /** Re-attach listeners when the scroll container is replaced (conversation switch). */
  resetKey?: unknown;
  onJump: () => void;
}) {
  const [away, setAway] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () =>
      setAway(
        el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_THRESHOLD_PX,
      );
    update();
    el.addEventListener('scroll', update, { passive: true });
    const content = contentRef.current;
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (content) observer?.observe(content);
    // The container itself shrinks/grows with the composer without a scroll event.
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [scrollRef, contentRef, resetKey]);

  if (!away) return null;
  return (
    <div className="pointer-events-none sticky bottom-0 z-10 flex h-0 items-start justify-center">
      <button
        type="button"
        data-ui="chat-jump-to-latest"
        aria-label="Jump to latest message"
        onClick={onJump}
        className="pointer-events-auto inline-flex -translate-y-[calc(100%+0.75rem)] items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowDown className="size-3.5" aria-hidden="true" />
        Jump to latest
      </button>
    </div>
  );
}
