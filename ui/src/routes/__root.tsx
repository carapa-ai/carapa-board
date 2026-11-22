import { createRootRoute, Outlet } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { AppToaster } from '@/components/app-toaster';
import { ConfirmDialogHost } from '@/components/confirm-dialog';
import { MergeApprovalDialogHost } from '@/components/merge-approval-dialog';
import { BuildLogHost } from '@/components/build-log-dialog';
import { AuthGate } from '@/components/auth-gate';
import { AndroidOtaController } from '@/components/android-ota-controller';
import { ServerLinkHandler } from '@/components/server-link-handler';
import { ShareActionDialog } from '@/components/chat/share-action-dialog';
import { BrowserTabPersistenceProvider } from '@/components/chat/browser-tab';
import { GlobalActionMenus } from '@/components/knowledge/global-action-menus';
import { AdminOverlayHost } from '@/components/layout/admin-overlay-host';
import { WorkspacePanePersistenceProvider } from '@/components/project-workspace-pane';
import { ProjectDialogsHost } from '@/components/layout/project-dialogs-host';
import { Sidebar } from '@/components/layout/sidebar';
import { ShareIntentHandler } from '@/components/share-intent-handler';
import { NotificationOverlayHost } from '@/components/notif/NotificationOverlayHost';
import { useApplicationWebSocketOwner } from '@/hooks/use-application-websocket-owner';
import { useViewportHeight } from '@/hooks/use-keyboard-height';
import { useNetworkDetection } from '@/hooks/use-network-detection';
import { isOldAndroid } from '@/lib/platform';
import { useAuth } from '@/lib/auth';
import { useStore } from '@/store';

function ShellContents() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  return (
    <BrowserTabPersistenceProvider>
      <WorkspacePanePersistenceProvider>
        <ShareIntentHandler />
        <ShareActionDialog />
        <GlobalActionMenus />
        <Sidebar />
        {/* Backdrop for mobile (bg-black/50 scrim, dark in both themes) */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <main className="flex-1 flex flex-col overflow-hidden w-full">
          {/* Top-level routes must render <PageHeader> (or the project Header) so the mobile sidebar trigger is reachable. */}
          <Outlet />
        </main>
        <AdminOverlayHost />
        <ProjectDialogsHost />
        <BuildLogHost />
        <NotificationOverlayHost />
      </WorkspacePanePersistenceProvider>
    </BrowserTabPersistenceProvider>
  );
}

// Old Android (≤10) workaround: pin the shell with position:fixed and an
// explicit pixel height driven by JS, since `100vh` and the WebView's layout
// viewport misbehave when the keyboard opens on those platforms.
function OldAndroidShell({ children }: { children: ReactNode }) {
  const viewportHeight = useViewportHeight();
  return (
    <div
      className="flex overflow-hidden bg-background text-foreground"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: viewportHeight ? `${viewportHeight}px` : '100vh',
      }}
    >
      {children}
    </div>
  );
}

function AppShell() {
  if (isOldAndroid) {
    return (
      <OldAndroidShell>
        <ShellContents />
      </OldAndroidShell>
    );
  }

  return (
    <div className="h-screen flex overflow-hidden bg-background text-foreground">
      <ShellContents />
    </div>
  );
}

// The OAuth consent page is a focused, login-gated flow: no sidebar or other
// chrome that could navigate away before the user decides.
function isOAuthConsentPath(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/oauth/consent')
  );
}

function FocusedShell() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Outlet />
    </div>
  );
}

function AuthenticatedRootLayout() {
  // Start network detection immediately so AuthGate can use the correct URL.
  useNetworkDetection();
  // This owner stays mounted while AuthGate shows the lock screen, so the
  // locked -> unlocked transition deterministically reconnects once.
  useApplicationWebSocketOwner();
  const duressMode = useAuth((s) => s.duressMode);

  return (
    <>
      <AndroidOtaController />
      <AuthGate>
        {isOAuthConsentPath() ? <FocusedShell /> : <AppShell />}
      </AuthGate>
      {/* Mounted above AuthGate so toasts emitted while the gate swaps the app
          for the login screen (e.g. logout failure) are still shown: sonner
          drops toasts raised before a Toaster mounts. Duress mode keeps its
          bare "connection failed" screen. */}
      {!duressMode && <AppToaster />}
      {!duressMode && <ConfirmDialogHost />}
      {!duressMode && <ServerLinkHandler />}
      {!duressMode && <MergeApprovalDialogHost />}
    </>
  );
}

function RootLayout() {
  const isPublicShare =
    typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/share/');
  if (isPublicShare) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Outlet />
        <AppToaster />
      </div>
    );
  }
  return <AuthenticatedRootLayout />;
}

export const Route = createRootRoute({
  component: RootLayout,
});
