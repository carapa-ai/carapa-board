import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { PageHeaderEmbeddedContext } from '@/components/layout/page-header';
import { useAuth } from '@/lib/auth';
import { useStore, type AdminOverlayId } from '@/store';

// Admin pages are loaded on demand and rendered inside an overlay so the
// underlying conversation or project URL stays in place.
const overlayPages: Record<
  AdminOverlayId,
  { title: string; Page: ComponentType }
> = {
  'provider-accounts': {
    title: 'Provider accounts',
    Page: lazy(() =>
      import('@/routes/admin.provider-accounts').then((m) => ({
        default: m.ProviderAccountsPage,
      })),
    ),
  },
  'mcp-connections': {
    title: 'MCP connections',
    Page: lazy(() =>
      import('@/routes/admin.mcp-connections').then((m) => ({
        default: m.McpConnectionsPage,
      })),
    ),
  },
  boxes: {
    title: 'CarapaBox hosts',
    Page: lazy(() =>
      import('@/components/admin/boxes-page').then((m) => ({
        default: m.BoxesPage,
      })),
    ),
  },
  'ai-users': {
    title: 'AI Users',
    Page: lazy(() =>
      import('@/routes/admin.ai-users').then((m) => ({
        default: m.AdminAiUsersPage,
      })),
    ),
  },
  'memory-review': {
    title: 'Memory Review',
    // Empty search disables the URL-driven approve/delete action in the page.
    Page: lazy(() =>
      import('@/routes/memory-review').then((m) => ({
        default: () => <m.MemoryReviewPage search={{}} />,
      })),
    ),
  },
  costs: {
    title: 'API Cost Report',
    Page: lazy(() =>
      import('@/routes/costs').then((m) => ({ default: m.CostReportPage })),
    ),
  },
  users: {
    title: 'Users & Roles',
    Page: lazy(() =>
      import('@/routes/users').then((m) => ({ default: m.UsersPage })),
    ),
  },
  devices: {
    title: 'Devices',
    Page: lazy(() =>
      import('@/routes/admin.devices').then((m) => ({
        default: m.AdminDevicesPage,
      })),
    ),
  },
};

export function AdminOverlayHost() {
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const adminOverlay = useStore((s) => s.adminOverlay);
  const closeAdminOverlay = useStore((s) => s.closeAdminOverlay);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Navigating to another page (for example, a page action that opens a chat)
  // ends the overlay so it never lingers over unrelated content.
  useEffect(() => {
    closeAdminOverlay();
  }, [pathname, closeAdminOverlay]);

  if (!isAdmin || !adminOverlay) return null;

  const { title, Page } = overlayPages[adminOverlay];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeAdminOverlay();
      }}
    >
      <DialogContent
        data-ui="admin-overlay"
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex flex-col gap-0 p-0 h-[90vh] max-h-[90vh] w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] overflow-hidden sm:max-w-5xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3">
          <DialogTitle className="min-w-0 truncate text-base font-medium">
            {title}
          </DialogTitle>
          <DialogClose className="shrink-0 rounded-xs text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-hidden">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>
        <div className="flex flex-1 min-h-0 flex-col overflow-y-auto">
          <PageHeaderEmbeddedContext.Provider value>
            <Suspense fallback={null}>
              <Page />
            </Suspense>
          </PageHeaderEmbeddedContext.Provider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
