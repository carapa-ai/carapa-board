import { useEffect, useRef } from 'react';
import { Toaster, toast, useSonner } from 'sonner';
import { useTheme } from '@/lib/theme';

// Sonner pauses every auto-dismiss timer while its list is hovered/"interacting".
// A pointerdown whose pointerup/cancel lands outside the list (touch scroll,
// drag off-screen) leaves that flag set, so toasts then never disappear.
// This hard deadline guarantees non-loading toasts are eventually dismissed.
const TOAST_HARD_DEADLINE_MS = 12_000;

function ToastWatchdog() {
  const { toasts } = useSonner();
  const timers = useRef(
    new Map<string | number, ReturnType<typeof setTimeout>>(),
  );

  useEffect(() => {
    const live = new Set<string | number>();
    for (const t of toasts) {
      if (t.type === 'loading') continue;
      live.add(t.id);
      if (timers.current.has(t.id)) continue;
      timers.current.set(
        t.id,
        setTimeout(() => {
          timers.current.delete(t.id);
          toast.dismiss(t.id);
        }, TOAST_HARD_DEADLINE_MS),
      );
    }
    for (const [id, timer] of timers.current) {
      if (live.has(id)) continue;
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, [toasts]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return null;
}

export function AppToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <>
      <Toaster position="bottom-right" theme={resolvedTheme} richColors />
      <ToastWatchdog />
    </>
  );
}
