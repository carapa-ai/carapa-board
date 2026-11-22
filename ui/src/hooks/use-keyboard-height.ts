import { useEffect, useState } from 'react';

/**
 * Returns the pixel height the app shell should render at — the viewport
 * minus the on-screen keyboard. Used only on old Android (≤10), where the
 * WebView's layout viewport collapses to ~36 px under adjustResize and
 * reports nothing under adjustNothing. We fall back to a focus-based estimate
 * (~45% of base viewport) and a periodic poll to detect dismissal.
 */
export function useViewportHeight() {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    let baseHeight = window.visualViewport?.height ?? window.innerHeight;
    let kbHeight = 0;
    let focusGuessActive = false;
    let focusGuessTimer: ReturnType<typeof setTimeout> | null = null;
    let pollHandle: ReturnType<typeof setInterval> | null = null;
    let pollBaseline: { vvH: number; innerH: number; availH: number } | null =
      null;

    const apply = () => {
      const vv = window.visualViewport;
      const liveVv = vv ? vv.height : window.innerHeight;

      let chosen: number;
      if (kbHeight > 0) {
        const computed = baseHeight - kbHeight;
        // Trust the live viewport when it's reasonable (not collapsed by the
        // older Chromium adjustResize bug); it accounts for insets exactly.
        if (liveVv > 100 && Math.abs(liveVv - computed) < 100) {
          chosen = liveVv;
        } else if (computed > 100) {
          chosen = computed;
        } else {
          chosen = liveVv;
        }
      } else {
        chosen = liveVv;
        if (chosen > baseHeight) baseHeight = chosen;
      }
      setHeight(chosen);
    };

    const setKb = (h: number) => {
      kbHeight = h;
      apply();
    };

    const stopPoll = () => {
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      pollBaseline = null;
    };

    const startPoll = () => {
      stopPoll();
      pollBaseline = {
        vvH: window.visualViewport?.height ?? 0,
        innerH: window.innerHeight,
        availH: window.screen.availHeight,
      };
      pollHandle = setInterval(() => {
        if (!focusGuessActive) {
          stopPoll();
          return;
        }
        const cur = {
          vvH: window.visualViewport?.height ?? 0,
          innerH: window.innerHeight,
          availH: window.screen.availHeight,
        };
        const grew =
          cur.vvH - (pollBaseline?.vvH ?? 0) > 100 ||
          cur.innerH - (pollBaseline?.innerH ?? 0) > 100 ||
          cur.availH - (pollBaseline?.availH ?? 0) > 100;
        if (grew) {
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
          stopPoll();
        }
      }, 500);
    };

    const onLiveChange = () => apply();
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', onLiveChange);
      vv.addEventListener('scroll', onLiveChange);
    }
    window.addEventListener('resize', onLiveChange);

    const isEditable = (el: EventTarget | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable;
    };

    const onFocusIn = (e: FocusEvent) => {
      if (!isEditable(e.target)) return;
      if (focusGuessTimer) clearTimeout(focusGuessTimer);
      focusGuessTimer = setTimeout(() => {
        if (kbHeight === 0) {
          focusGuessActive = true;
          setKb(Math.round(baseHeight * 0.45));
          startPoll();
        }
      }, 250);
    };

    const onFocusOut = (e: FocusEvent) => {
      if (!isEditable(e.target)) return;
      if (focusGuessTimer) clearTimeout(focusGuessTimer);
      stopPoll();
      if (focusGuessActive) {
        focusGuessActive = false;
        setKb(0);
      }
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    apply();

    return () => {
      if (vv) {
        vv.removeEventListener('resize', onLiveChange);
        vv.removeEventListener('scroll', onLiveChange);
      }
      window.removeEventListener('resize', onLiveChange);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      if (focusGuessTimer) clearTimeout(focusGuessTimer);
      stopPoll();
    };
  }, []);

  return height;
}
