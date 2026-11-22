import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { router } from '@/lib/router';
import { installActivityTracker } from '@/lib/activity-tracker';
import { initTheme } from '@/lib/theme';
import './global.css';
import { isOldAndroid } from '@/lib/platform';
import { getServerConfig } from '@/lib/api-config';
import { syncServerPins } from '@/lib/push-bridge';
import { androidOtaRestartPending } from '@/lib/android-ota';
import { Button } from '@/components/ui/button';
import { reconcileInterruptedServerChange } from '@/lib/server-config';

installActivityTracker();
// Re-apply the stored appearance (the inline script in index.html already did
// before the bundle loaded) and start following OS changes in system mode.
initTheme();

// Old Android only: blur the focused input on tap-outside so the keyboard-
// height estimate clears even if the IME is dismissed via back button or swipe.
// Newer Androids handle this automatically through adjustResize.
if (isOldAndroid) {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return;
      const tag = active.tagName;
      const editable =
        tag === 'TEXTAREA' || tag === 'INPUT' || active.isContentEditable;
      if (!editable) return;
      const target = e.target as Element | null;
      if (!target) return;
      if (active.contains(target)) return;
      if (target.closest('button, a, [role="button"], [role="link"], label')) {
        return;
      }
      active.blur();
    },
    { capture: true },
  );
}

// Native only: finish an interrupted server change, then hand the
// stored certificate pins to native code before the first request, so an
// upgrade from a build without native pins keeps working. A failure leaves the
// previously stored native pins in place. If the change cannot be finished,
// the previous server's bundle may still be the one running against the new
// config, so the app shows a blocking Retry screen and renders nothing else
// until the reconcile succeeds. The same holds while the updater is already
// restarting into the built-in bundle.
const root = createRoot(document.getElementById('root')!);

function startApp(): Promise<void> {
  if (androidOtaRestartPending()) return Promise.resolve();
  return syncServerPins(getServerConfig())
    .catch((error) => console.warn('[pins] native pin sync failed', error))
    .then(() => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <RouterProvider router={router} />
            </TooltipProvider>
          </QueryClientProvider>
        </StrictMode>,
      );
    });
}

function boot(): void {
  reconcileInterruptedServerChange().then(startApp, (error) => {
    console.error('[server-config] reconcile failed', error);
    root.render(
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p>The server change could not be finished.</p>
        <Button onClick={boot}>Retry</Button>
      </div>,
    );
  });
}

boot();
