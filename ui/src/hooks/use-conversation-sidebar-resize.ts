import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { CHAT_MIN_WIDTH } from './use-project-workspace-pane';

const CONVERSATION_SIDEBAR_MIN_WIDTH = 200;
const CONVERSATION_SIDEBAR_MAX_WIDTH = 280;

const WIDTH_KEY = 'conversationSidebarWidth';

function readWidth(): number | null {
  try {
    const width = Number(window.localStorage.getItem(WIDTH_KEY));
    return width >= CONVERSATION_SIDEBAR_MIN_WIDTH &&
      width <= CONVERSATION_SIDEBAR_MAX_WIDTH
      ? width
      : null;
  } catch {
    return null;
  }
}

function persistWidth(width: number) {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    /* best effort */
  }
}

/**
 * Resize state for the desktop conversation sidebar.
 *
 * `width` stays `null` until the first drag, so the sidebar keeps its CSS
 * default (`w-52`) untouched. The width chosen by the last drag is stored in
 * localStorage (shared by all projects) and restored on the next load.
 */
export function useConversationSidebarResize() {
  const [width, setWidth] = useState<number | null>(readWidth);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);

  const stopResize = useCallback(() => {
    activeResizeCleanupRef.current?.();
  }, []);

  // Unmount mid-drag still releases the window listeners and the temporary
  // selection lock.
  useEffect(() => stopResize, [stopResize]);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      const sidebar = sidebarRef.current;
      if (!sidebar || activeResizeCleanupRef.current) return;
      const resizeHandle = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = sidebar.getBoundingClientRect().width;
      let latestWidth = startWidth;
      // Growing is limited by the room the chat column has above its minimum.
      const chatWidth =
        sidebar.parentElement
          ?.querySelector<HTMLElement>(
            ':scope > [data-ui="chat-project-surface"]',
          )
          ?.getBoundingClientRect().width ?? Infinity;
      const maxWidth = Math.max(
        CONVERSATION_SIDEBAR_MIN_WIDTH,
        Math.min(
          CONVERSATION_SIDEBAR_MAX_WIDTH,
          startWidth + chatWidth - CHAT_MIN_WIDTH,
        ),
      );
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        latestWidth = Math.min(
          maxWidth,
          Math.max(
            CONVERSATION_SIDEBAR_MIN_WIDTH,
            startWidth + moveEvent.clientX - startX,
          ),
        );
        setWidth(latestWidth);
      };
      const previousUserSelect = document.body.style.userSelect;
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        window.removeEventListener('blur', stopResize);
        resizeHandle.removeEventListener('lostpointercapture', onEnd);
        activeResizeCleanupRef.current = null;
        if (resizeHandle.hasPointerCapture(pointerId)) {
          resizeHandle.releasePointerCapture(pointerId);
        }
        document.body.style.userSelect = previousUserSelect;
        setIsResizing(false);
        if (latestWidth !== startWidth) persistWidth(latestWidth);
      };
      const onEnd = (endEvent: PointerEvent) => {
        if (endEvent.pointerId === pointerId) stopResize();
      };
      resizeHandle.setPointerCapture(pointerId);
      activeResizeCleanupRef.current = cleanup;
      document.body.style.userSelect = 'none';
      setIsResizing(true);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
      window.addEventListener('blur', stopResize);
      resizeHandle.addEventListener('lostpointercapture', onEnd);
    },
    [stopResize],
  );

  return {
    width,
    isResizing,
    sidebarRef,
    startResize,
  };
}
