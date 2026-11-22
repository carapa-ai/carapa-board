import {
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  type RefObject,
} from 'react';

// How close to the bottom (in px) still counts as "at the bottom". Sub-pixel
// rounding and a programmatic scroll never land exactly on 0, so we allow a
// small slack before considering the user to have scrolled up.
const BOTTOM_THRESHOLD = 80;

/**
 * Smart auto-scroll hook for chat containers.
 *
 * Model (intentionally dead simple): "pinned" is purely a function of scroll
 * position. While the viewport is at (or within BOTTOM_THRESHOLD of) the bottom,
 * the container auto-follows new content. The moment the user scrolls up past
 * the threshold it stops. Scroll back down to the bottom and it follows again.
 *
 * There is no gesture detection and no timing grace window — those were the
 * source of "it randomly stops following" bugs. A programmatic scroll lands at
 * the bottom (distance ~= 0), so it naturally keeps us pinned; a user scroll-up
 * moves us away from the bottom, so it naturally unpins.
 *
 * @param containerRef  ref to the scrollable container element
 * @param deps          reactive values that should trigger auto-scroll (e.g. messages.length, streaming flag)
 * @param listenerKey   reactive value that causes listeners/observers to be re-attached (e.g. task_id,
 *                      activeConvId). Use when the container may be unmounted/remounted (e.g. in a Dialog).
 * @param contentRef    optional ref to the element wrapping the scrollable content. When provided, a
 *                      ResizeObserver follows height growth while pinned — covering content that grows
 *                      AFTER a deps-driven scroll (lazy markdown / async syntax highlighting / images),
 *                      and per-token streaming growth. No-op while the user is scrolled up.
 */
export function useSmartScroll(
  containerRef: RefObject<HTMLElement | null>,
  deps: unknown[],
  listenerKey?: unknown,
  contentRef?: RefObject<HTMLElement | null>,
) {
  const pinnedRef = useRef(true);
  const rafIdRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const suppressCountRef = useRef(0);
  const settlingRef = useRef(false);
  const suspendedRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Imperative jump to the absolute bottom (clamped by the browser). Used by
  // both the deps-driven auto-scroll and the public scroll helpers.
  const jumpToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [containerRef]);

  // rAF-batched scroll that respects the current pin state. Safe to call at high
  // frequency (streaming tokens, ResizeObserver bursts) — multiple calls in one
  // frame coalesce into a single scroll.
  const scheduleScrollIfPinned = useCallback(() => {
    if (suspendedRef.current) return;
    if (!pinnedRef.current && !settlingRef.current) return;
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      if (!pinnedRef.current && !settlingRef.current) return;
      jumpToBottom();
    });
  }, [jumpToBottom]);

  // Pin state is derived from scroll interaction:
  //  - At/near the bottom            → pinned (auto-follow).
  //  - User scrolls UP (scrollTop ↓) → unpinned (stop following).
  //  - Otherwise (content grew, etc.)→ leave pin state unchanged.
  //
  // Crucially we do NOT unpin just because distanceFromBottom grew: when lazy
  // content (markdown / highlight.js / images) expands below the fold, the
  // distance jumps but the user did not scroll. Unpinning on that — the trap the
  // old gesture/grace logic also hit — is exactly what left long responses stuck
  // above the bottom on reload. `overflow-anchor: none` further stops the browser
  // from shifting scrollTop when content grows, so growth never looks like a scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.overflowAnchor = 'none';
    lastScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
    const cancelSettling = () => {
      settlingRef.current = false;
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
    const handleScroll = () => {
      const scrollTop = el.scrollTop;
      const distanceFromBottom = el.scrollHeight - scrollTop - el.clientHeight;
      // When content shrinks (e.g. the "Thinking…" badge is swapped for the
      // first small streaming line), the browser clamps scrollTop down to the
      // new max. That looks like a scroll-up but the user did nothing — so we
      // must not unpin on it, otherwise auto-follow dies right as streaming
      // starts. Only a scrollTop decrease WITHOUT a height shrink is a real
      // user scroll-up.
      const heightShrank = el.scrollHeight < lastScrollHeightRef.current;
      if (distanceFromBottom <= BOTTOM_THRESHOLD) {
        pinnedRef.current = true;
      } else if (
        !settlingRef.current &&
        scrollTop < lastScrollTopRef.current &&
        !heightShrank
      ) {
        pinnedRef.current = false;
      }
      lastScrollTopRef.current = scrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    // Initial-load settling must never fight deliberate user navigation.
    el.addEventListener('wheel', cancelSettling, { passive: true });
    el.addEventListener('touchstart', cancelSettling, { passive: true });
    el.addEventListener('pointerdown', cancelSettling, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      el.removeEventListener('wheel', cancelSettling);
      el.removeEventListener('touchstart', cancelSettling);
      el.removeEventListener('pointerdown', cancelSettling);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenerKey]);

  // Position synchronously before paint when deps change (new message,
  // streaming start/stop). Scheduling this through rAF exposed one frame of
  // an earlier transcript position before snapping back to the latest turn.
  useLayoutEffect(() => {
    if (suspendedRef.current) return;
    // Caller may have already positioned the viewport (e.g. scrollIntoView after
    // send). Skip N cycles so we don't slam to absolute bottom and fight that
    // scroll — and so chat_started (chatRunning dep) doesn't race scrollIntoView
    // during the long "Thinking…" window before the first tool-call chunk.
    if (suppressCountRef.current > 0) {
      suppressCountRef.current--;
      return;
    }
    if (pinnedRef.current || settlingRef.current) jumpToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Follow content growth while pinned. Covers height increases that happen after
  // the deps-driven scroll (lazy markdown, images) and per-token streaming growth.
  useEffect(() => {
    const content = contentRef?.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    // Follow in the same frame, before paint: deferring to rAF paints one frame
    // of the grown content at the old offset (a visible flash of the tail).
    const ro = new ResizeObserver(() => {
      if (suspendedRef.current) return;
      if (pinnedRef.current || settlingRef.current) jumpToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenerKey, jumpToBottom]);

  // Cleanup pending rAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      // Dev StrictMode re-runs the mount effects after this cleanup; a stale id
      // would make scheduleScrollIfPinned bail out forever.
      rafIdRef.current = null;
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    };
  }, []);

  /** Imperatively scroll to bottom and re-pin (e.g. on send or conversation switch). */
  const scrollToBottom = useCallback(() => {
    pinnedRef.current = true;
    jumpToBottom();
  }, [jumpToBottom]);

  /** Scroll to bottom ONLY if currently pinned (does not force a re-pin). */
  const scrollToBottomIfPinned = useCallback(() => {
    scheduleScrollIfPinned();
  }, [scheduleScrollIfPinned]);

  /**
   * Synchronous pinned scroll for a pre-paint layout handoff. Completion can
   * replace a flat throttled snapshot with taller canonical Markdown; waiting
   * for the normal rAF batch exposes one frame at the old outer scroll offset.
   */
  const scrollToBottomIfPinnedNow = useCallback(() => {
    if (pinnedRef.current || settlingRef.current) jumpToBottom();
  }, [jumpToBottom]);

  /**
   * Force-follow asynchronous initial layout for a bounded window. Lazy
   * Markdown, highlighting, and media can all increase height after the first
   * transcript paint. Any user pointer/wheel/touch interaction cancels this
   * immediately, returning control to the normal pin state.
   */
  const settleToBottom = useCallback(
    (durationMs = 1500) => {
      if (suspendedRef.current) return;
      pinnedRef.current = true;
      settlingRef.current = true;
      jumpToBottom();
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        settlingRef.current = false;
        settleTimerRef.current = null;
      }, durationMs);
    },
    [jumpToBottom],
  );

  /**
   * Skip the next N deps-driven auto-scroll cycles (default 1). Use 2+ when
   * sending a message: one for renderedMessages.length, one for chat_started /
   * chatRunning. Also re-pins so token streaming still follows after the
   * gentler scrollIntoView even if the viewport is not within BOTTOM_THRESHOLD.
   */
  const suppressNextAutoScroll = useCallback((cycles = 1) => {
    suppressCountRef.current = Math.max(suppressCountRef.current, cycles);
    pinnedRef.current = true;
  }, []);

  /**
   * Temporarily disable all automatic movement. Used while an explicit anchor
   * (such as a task run divider) is being aligned across lazy layout changes.
   */
  const suspendAutoScroll = useCallback(() => {
    suspendedRef.current = true;
    pinnedRef.current = false;
    settlingRef.current = false;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  /** Resume normal user-driven pin detection without forcing an immediate jump. */
  const resumeAutoScroll = useCallback(() => {
    suspendedRef.current = false;
    pinnedRef.current = false;
  }, []);

  return {
    scrollToBottom,
    scrollToBottomIfPinned,
    scrollToBottomIfPinnedNow,
    settleToBottom,
    suppressNextAutoScroll,
    suspendAutoScroll,
    resumeAutoScroll,
    isAtBottom: pinnedRef,
  };
}
