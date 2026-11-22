import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/** Install foreground/network recovery signals around the single root socket. */
export function installWebSocketRecoveryListeners(
  recover: () => void,
  canRecover: () => boolean = () => true,
) {
  let visible = document.visibilityState === 'visible';
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRecoveryAt = 0;
  let disposed = false;
  const requestRecovery = () => {
    if (recoveryTimer || Date.now() - lastRecoveryAt < 1_000) return;
    // Native appStateChange may precede AuthGate's visibility lock handler.
    // Yield a task so lock state commits before credentials/socket mutation.
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (disposed) return;
      if (!canRecover()) return;
      lastRecoveryAt = Date.now();
      recover();
    }, 0);
  };
  const onVisibility = () => {
    const nextVisible = document.visibilityState === 'visible';
    if (nextVisible && !visible) requestRecovery();
    visible = nextVisible;
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) requestRecovery();
  };
  const onOnline = () => requestRecovery();

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onOnline);

  let removeNativeListener: (() => Promise<void>) | undefined;
  if (Capacitor.isNativePlatform()) {
    void App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) requestRecovery();
    }).then((handle) => {
      if (disposed) void handle.remove();
      else removeNativeListener = () => handle.remove();
    });
  }

  return () => {
    disposed = true;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('online', onOnline);
    void removeNativeListener?.();
  };
}
