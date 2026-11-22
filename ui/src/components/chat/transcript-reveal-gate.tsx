import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

/** A transcript is revealed at the latest this long after its gate started. */
const TRANSCRIPT_REVEAL_MAX_MS = 800;
/**
 * The cap timer fires this much early so the reveal is committed and painted
 * within TRANSCRIPT_REVEAL_MAX_MS (timer jitter + React commit + next frame).
 */
const REVEAL_COMMIT_MARGIN_MS = 50;
/**
 * The layout counts as settled once neither the scroll height/offset nor the
 * size of the container's content changed for this long. Two quiet frames are
 * not enough: async content (mermaid, images, deferred Markdown) lands later.
 */
const QUIET_MS = 120;
/**
 * Content that is still loading and will change height when it lands: deferred
 * Markdown not yet mounted, a mermaid diagram not yet rendered, an image not yet
 * loaded. Mermaid sets `data-processed` and inserts a first SVG well before its
 * final layout, so neither marks a diagram as done: MermaidBlock reports that
 * in `data-mermaid-status` once `mermaid.run()` has resolved.
 */
const PENDING_CONTENT_SELECTOR =
  '[data-ui="chat-deferred-markdown"], pre.mermaid[data-mermaid-status="pending"], img';

// Pending content in a message row that crosses the visible part of the
// container. Growth anywhere inside such a row moves it (the transcript follows
// its bottom edge), while rows entirely outside cannot move what the reader
// sees. Deferred Markdown only mounts once it intersects the container (the
// observer's rootMargin does not widen a scroll container's clip), so rows
// further away stay as they are.
function hasPendingContentInViewport(container: HTMLElement): boolean {
  const viewport = container.getBoundingClientRect();
  for (const el of container.querySelectorAll(PENDING_CONTENT_SELECTOR)) {
    if (el instanceof HTMLImageElement && el.complete) continue;
    const rect = (
      el.closest('[data-message-id]') ?? el
    ).getBoundingClientRect();
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) return true;
  }
  return false;
}

export interface PreviousTranscript {
  node: HTMLElement;
  /** Scroll offsets of the clone and its scrollable descendants (e.g. capped bubble bodies). */
  scrollOffsets: Array<[HTMLElement, number, number]>;
  top: number;
  left: number;
  width: number;
  height: number;
}

// Static, inert copy of the transcript that is about to be replaced. Listeners
// are not cloned; ids and `data-ui` hooks are dropped so the copy never answers
// queries meant for the live transcript.
function capturePreviousTranscript(
  source: HTMLElement | null,
): PreviousTranscript | null {
  if (!source) return null;
  const node = source.cloneNode(true) as HTMLElement;
  for (const el of [node, ...node.querySelectorAll<HTMLElement>('*')]) {
    el.removeAttribute('id');
    el.removeAttribute('data-ui');
    el.removeAttribute('data-testid');
  }
  node.removeAttribute('data-transcript-revealed');
  node.removeAttribute('aria-busy');
  node.querySelectorAll('[autoplay]').forEach((el) => {
    el.removeAttribute('autoplay');
  });
  node.style.width = '100%';
  node.style.height = '100%';
  // cloneNode drops scroll offsets; the clone's element order matches the source.
  const sourceEls = [source, ...source.querySelectorAll<HTMLElement>('*')];
  const cloneEls = [node, ...node.querySelectorAll<HTMLElement>('*')];
  const scrollOffsets: PreviousTranscript['scrollOffsets'] = [];
  sourceEls.forEach((el, index) => {
    if (el.scrollTop || el.scrollLeft)
      scrollOffsets.push([cloneEls[index], el.scrollTop, el.scrollLeft]);
  });
  return {
    node,
    scrollOffsets,
    top: source.offsetTop,
    left: source.offsetLeft,
    width: source.offsetWidth,
    height: source.offsetHeight,
  };
}

interface TranscriptRevealGateOptions {
  /** Identity of the displayed transcript (task or conversation id). */
  transcriptKey: string | null;
  /** The gate only applies while true (e.g. the Chat tab is active). */
  enabled: boolean;
  /** The transcript's data queries have settled (success, empty or error). */
  ready: boolean;
  /** The live scroll container exists and can be measured. */
  mounted: boolean;
  /** The live scroll container whose layout must settle before the reveal. */
  scrollRef: RefObject<HTMLElement | null>;
  /**
   * A transcript that appears from having no key (the dialog opening, or a
   * conversation picked from a blank composer) is gated, except this one: a
   * conversation the page has just created and seeded itself.
   */
  exemptKey?: string | null;
}

/**
 * Keeps an incoming transcript hidden until it reached its final layout (data
 * settled and height + scroll position unchanged for a few frames), capped at
 * TRANSCRIPT_REVEAL_MAX_MS. On a switch the previous transcript is returned as a
 * static copy for the caller to show dimmed meanwhile; on a first load nothing
 * is shown. The incoming transcript keeps rendering (opacity, not display) so
 * scroll settling and IntersectionObserver-driven content behave as usual.
 */
export function useTranscriptRevealGate({
  transcriptKey,
  enabled,
  ready,
  mounted,
  scrollRef,
  exemptKey = null,
}: TranscriptRevealGateOptions) {
  const [trackedKey, setTrackedKey] = useState(transcriptKey);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [previous, setPrevious] = useState<PreviousTranscript | null>(null);

  // Adjusted during render (before the new transcript commits) because the old
  // DOM is gone by the time any effect runs.
  if (trackedKey !== transcriptKey) {
    // Every switch or opening is its own visit: a key revealed earlier (A→B→A,
    // or the dialog closed and reopened) must settle again.
    const leavingRevealed = trackedKey !== null && revealedKey === trackedKey;
    setTrackedKey(transcriptKey);
    setRevealedKey(
      trackedKey === null &&
        transcriptKey !== null &&
        transcriptKey === exemptKey
        ? transcriptKey
        : null,
    );
    if (transcriptKey === null) {
      setPrevious(null);
    } else if (enabled && leavingRevealed) {
      // Rapid A→B→C keeps A's copy: B was never revealed.
      setPrevious(capturePreviousTranscript(scrollRef.current));
    }
  }
  if (!enabled && transcriptKey !== null && revealedKey !== transcriptKey) {
    setRevealedKey(transcriptKey);
  }
  if (!enabled && previous) setPrevious(null);

  const gated =
    enabled && transcriptKey !== null && revealedKey !== transcriptKey;

  // Hard cap and user input. Restarts on every switch, so the cap counts from
  // the latest one.
  useLayoutEffect(() => {
    if (!gated || !mounted) return;
    const reveal = () => {
      setRevealedKey(transcriptKey);
      setPrevious(null);
    };
    const el = scrollRef.current;
    const timer = setTimeout(
      reveal,
      TRANSCRIPT_REVEAL_MAX_MS - REVEAL_COMMIT_MARGIN_MS,
    );
    el?.addEventListener('wheel', reveal, { passive: true });
    el?.addEventListener('touchstart', reveal, { passive: true });
    el?.addEventListener('pointerdown', reveal, { passive: true });
    return () => {
      clearTimeout(timer);
      el?.removeEventListener('wheel', reveal);
      el?.removeEventListener('touchstart', reveal);
      el?.removeEventListener('pointerdown', reveal);
    };
  }, [gated, mounted, transcriptKey, scrollRef]);

  // Early reveal once the data settled, the layout stopped moving for a quiet
  // period and nothing in the viewport is still loading.
  useEffect(() => {
    if (!gated || !mounted || !ready) return;
    const container = scrollRef.current;
    if (!container) return;
    let frame = 0;
    let lastLayout = '';
    let lastChangeAt = performance.now();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            lastChangeAt = performance.now();
          });
    const observed = new WeakSet<Element>();
    const tick = () => {
      const now = performance.now();
      for (const child of container.children) {
        if (observed.has(child)) continue;
        observed.add(child);
        observer?.observe(child);
      }
      const layout = `${container.scrollHeight}:${container.scrollTop}`;
      if (layout !== lastLayout) {
        lastLayout = layout;
        lastChangeAt = now;
      }
      if (
        now - lastChangeAt >= QUIET_MS &&
        !hasPendingContentInViewport(container)
      ) {
        setRevealedKey(transcriptKey);
        setPrevious(null);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [gated, mounted, ready, transcriptKey, scrollRef]);

  return { gated, previous: gated ? previous : null };
}

/**
 * Dimmed, inert stand-in for the previous transcript, laid over the live scroll
 * container (its sibling) at that container's box and last scroll offset.
 */
export function PreviousTranscriptLayer({
  previous,
  dataUi,
}: {
  previous: PreviousTranscript;
  dataUi: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(previous.node);
    for (const [el, top, left] of previous.scrollOffsets) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }, [previous]);
  return (
    <div
      ref={hostRef}
      data-ui={dataUi}
      aria-hidden="true"
      inert
      className="pointer-events-none absolute z-10 overflow-hidden bg-background opacity-50"
      style={{
        top: previous.top,
        left: previous.left,
        width: previous.width,
        height: previous.height,
      }}
    />
  );
}
