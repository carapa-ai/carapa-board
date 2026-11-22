import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Capacitor } from '@capacitor/core';
import { canLeaveActivePreview, useStore } from '@/store';

const OPEN_KEY = 'artifactsPanelOpenByProject';
const WIDTH_KEY = 'artifactsPanelWidth';
const MIN_WIDTH = 280;
/** The chat column between the conversation list and this pane never gets narrower. */
export const CHAT_MIN_WIDTH = 300;

interface PaneLayout {
  containerWidth: number;
  /** In-flow conversation list width; 0 when collapsed or a mobile overlay. */
  conversationListWidth: number;
  /** In-flow project sidebar width; 0 when collapsed or a mobile overlay. */
  projectSidebarWidth: number;
}

function inFlowWidth(element: Element | null) {
  // A fixed sidebar is a mobile overlay and takes no room from the chat.
  return element && getComputedStyle(element).position !== 'fixed'
    ? element.getBoundingClientRect().width
    : 0;
}

function measureLayout(container: HTMLElement): PaneLayout {
  return {
    containerWidth: container.getBoundingClientRect().width,
    conversationListWidth: inFlowWidth(
      container.querySelector('[data-ui="conversation-sidebar"]'),
    ),
    projectSidebarWidth: inFlowWidth(
      document.querySelector('[data-ui="global-sidebar"]'),
    ),
  };
}

/**
 * Widest the pane may be without squeezing the chat below CHAT_MIN_WIDTH.
 * `collapsed` counts the sidebars already hidden to make room, in the order
 * RECLAIM_ORDER hides them: the conversation list, then the project sidebar
 * (which also widens the container).
 */
function maxPaneWidth(layout: PaneLayout, collapsed = 0) {
  const containerWidth =
    layout.containerWidth + (collapsed >= 2 ? layout.projectSidebarWidth : 0);
  const listWidth = collapsed >= 1 ? 0 : layout.conversationListWidth;
  return Math.max(
    MIN_WIDTH,
    Math.min(
      containerWidth * 0.75,
      containerWidth - listWidth - CHAT_MIN_WIDTH,
    ),
  );
}

/** Hide the sidebars a drag past the chat minimum needs room from, in order. */
const RECLAIM_ORDER = [
  () => useStore.getState().setDesktopChatSidebarCollapsed(true),
  () => useStore.getState().setDesktopSidebarCollapsed(true),
];

function readOpen(
  stateKey: string,
  restorationDisabled: boolean,
  defaultOpen: boolean,
) {
  if (typeof window === 'undefined' || restorationDisabled) return false;
  try {
    const value = window.localStorage.getItem(OPEN_KEY);
    const stored = (value ? JSON.parse(value) : {})[stateKey];
    return stored === undefined ? defaultOpen : stored === true;
  } catch {
    return false;
  }
}

function persistOpen(stateKey: string, open: boolean) {
  try {
    const value = window.localStorage.getItem(OPEN_KEY);
    const map = value ? JSON.parse(value) : {};
    map[stateKey] = open;
    window.localStorage.setItem(OPEN_KEY, JSON.stringify(map));
  } catch {
    /* best effort */
  }
}

function persistWidth(width: number) {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    /* best effort */
  }
}

function readWidth() {
  if (typeof window === 'undefined') return 420;
  const width = Number(window.localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(width) && width >= MIN_WIDTH
    ? Math.min(width, window.innerWidth * 0.75)
    : 420;
}

export function useProjectWorkspacePane(
  projectId: string,
  options: {
    restoreOpen?: boolean;
    persistOpen?: boolean;
    openStateKey?: string;
    defaultOpen?: boolean;
  } = {},
) {
  const restoreOpen = options.restoreOpen ?? true;
  const shouldPersistOpen = options.persistOpen ?? true;
  const openStateKey = options.openStateKey ?? projectId;
  const defaultOpen = options.defaultOpen ?? false;
  const isAndroid =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  const [open, setOpenState] = useState(() =>
    readOpen(openStateKey, isAndroid || !restoreOpen, defaultOpen),
  );
  // Latest committed value, so functional updaters can resolve before the
  // (possibly asynchronous) leave guard decides whether to apply them.
  const openRef = useRef(open);
  openRef.current = open;
  // A close waits for the leave guard; any newer request supersedes it so a
  // late decision cannot overwrite the pane state the newer request set.
  const requestSequenceRef = useRef(0);
  const [width, setWidth] = useState(readWidth);
  const layoutRef = useRef<HTMLDivElement>(null);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);

  const setOpenValue = useCallback(
    (
      next: boolean | ((current: boolean) => boolean),
      persist = shouldPersistOpen,
      skipLeaveGuard = false,
    ) => {
      const request = ++requestSequenceRef.current;
      const resolved =
        typeof next === 'function' ? next(openRef.current) : next;
      const commit = () => {
        openRef.current = resolved;
        setOpenState(resolved);
        // Android deliberately keeps this session-only state in memory. It
        // starts closed and skips restoration, but the existing full-surface
        // pane can still be opened by the user (or by an artifact preview).
        if (!isAndroid && persist) persistOpen(openStateKey, resolved);
      };
      if (resolved || skipLeaveGuard) {
        commit();
        return;
      }
      void canLeaveActivePreview(projectId).then((allowed) => {
        if (allowed && request === requestSequenceRef.current) commit();
      });
    },
    [isAndroid, openStateKey, projectId, shouldPersistOpen],
  );

  const setOpen = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => setOpenValue(next),
    [setOpenValue],
  );
  const setOpenAfterLeaveCheck = useCallback(
    (next: boolean | ((current: boolean) => boolean)) =>
      setOpenValue(next, shouldPersistOpen, true),
    [setOpenValue, shouldPersistOpen],
  );

  useEffect(() => {
    setOpenValue(
      readOpen(openStateKey, isAndroid || !restoreOpen, defaultOpen),
      false,
    );
  }, [defaultOpen, isAndroid, openStateKey, restoreOpen, setOpenValue]);

  useLayoutEffect(() => {
    const container = layoutRef.current;
    if (!container) return;
    const clamp = () =>
      setWidth((current) => {
        // A drag manages the width (and the sidebars) itself.
        if (activeResizeCleanupRef.current) return current;
        const next = Math.min(maxPaneWidth(measureLayout(container)), current);
        if (next !== current) persistWidth(next);
        return next;
      });
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(container);
    // Showing the conversation list again takes room from the chat too.
    const sidebar = container.querySelector('[data-ui="conversation-sidebar"]');
    if (sidebar) observer.observe(sidebar);
    return () => observer.disconnect();
  }, []);

  const cancelResize = useCallback(() => {
    activeResizeCleanupRef.current?.();
  }, []);

  useEffect(() => cancelResize, [cancelResize]);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      activeResizeCleanupRef.current?.();
      const startX = event.clientX;
      const startWidth = width;
      let latestWidth = startWidth;
      const resizeHandle = event.currentTarget;
      const pointerId = event.pointerId;
      const container = event.currentTarget.parentElement?.parentElement;
      const layout = container ? measureLayout(container) : null;
      let collapsed = 0;
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const desired = startWidth + startX - moveEvent.clientX;
        // Dragging past what the chat minimum allows hides the sidebars one
        // by one (they stay hidden when the drag comes back).
        while (
          layout &&
          collapsed < RECLAIM_ORDER.length &&
          desired > maxPaneWidth(layout, collapsed)
        ) {
          const hiddenWidth =
            collapsed === 0
              ? layout.conversationListWidth
              : layout.projectSidebarWidth;
          // A sidebar that takes no room already (hidden, or a mobile
          // overlay) keeps the user's preference.
          if (hiddenWidth > 0) RECLAIM_ORDER[collapsed]();
          collapsed++;
        }
        const maxWidth = layout
          ? maxPaneWidth(layout, collapsed)
          : window.innerWidth * 0.75;
        latestWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, desired));
        setWidth(latestWidth);
      };
      let cleanedUp = false;
      const previousUserSelect = document.body.style.userSelect;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('blur', onBlur);
        if (resizeHandle.hasPointerCapture(pointerId)) {
          resizeHandle.releasePointerCapture(pointerId);
        }
        document.body.style.userSelect = previousUserSelect;
        if (activeResizeCleanupRef.current === cleanup) {
          activeResizeCleanupRef.current = null;
        }
      };
      const onUp = (upEvent: PointerEvent) => {
        if (cleanedUp || upEvent.pointerId !== pointerId) return;
        cleanup();
        persistWidth(latestWidth);
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return;
        cleanup();
      };
      const onBlur = () => cleanup();
      activeResizeCleanupRef.current = cleanup;
      resizeHandle.setPointerCapture(pointerId);
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('blur', onBlur);
    },
    [width],
  );

  return {
    open,
    setOpen,
    setOpenAfterLeaveCheck,
    width,
    layoutRef,
    startResize,
    cancelResize,
  };
}
